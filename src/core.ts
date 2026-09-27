// Host-side message handling, independent of the VS Code API so the same code
// drives both the extension and the browser test harness.
import * as crypto from 'crypto';
import { applySourceEdit, sourceText, SourceChange } from './sourceEdit';
import * as fs from 'fs';
import * as path from 'path';
import * as store from './commentStore';
import { applyBlockEdit, readBlock, toggleTask, spliceLines, BlockEditError } from './blockEdit';
import { hasUrlScheme, renderParsed, rendererFor, RenderEnv, ResolveImage } from './render';
import type { WordTargets } from './frontMatter';
import { applyInlineEdit, InlineMapError, BlockKind, RenderedParse } from './inlineEdit';
import { EditHistory, HistoryError } from './editHistory';
import { buildAgentPrompt } from './agentPrompt';
import { buildReviewPrompt, findPreset, listReviewers } from './reviewPresets';
import { insideRealRoots, isNetworkPath, realRoots } from './bibliography';
import * as redlines from './redlines';
import { BaselineHook, memoryBaselines } from './baselineStore';
import { diffSeq } from './wordDiff';
import { SIDECAR_RETRY_MS } from './fileWatch';
import type { AgentKind, AgentSession, Binding } from './agentSessions';

/** When comments reach the agent: on Send (and Ask), or each one as it's saved. */
export type Delivery = 'onSend' | 'live';

/** The agent session a document talks to, as the view shows it. */
export interface AgentState {
  bound: (Binding & { live?: boolean; status?: string }) | null;
  delivery: Delivery;
  /** Filled when the session menu asked for the list. */
  sessions?: AgentSession[];
  /** Open the session menu: a Send is waiting for a session to go to. */
  ask?: boolean;
  /** A session is being started or waited for. */
  starting?: string;
  /** The folder has MD Review's skill and hooks (Connect this folder). */
  connected?: boolean;
}

/**
 * Running agent sessions and which one this document's messages go to. The
 * host keeps the binding (per workspace folder in VS Code) and starts sessions
 * (a terminal in VS Code; in the browser, the command is handed to the user).
 */
export interface AgentHost {
  list(): AgentSession[];
  binding(): Binding | undefined;
  bind(b: Binding | undefined): void;
  /** The bound session's current state, if it can be found. */
  state(b: Binding): AgentSession | undefined;
  /** Start a new session, or resume `resume`. Resolves to its binding, or null when nothing was started (the host said why). */
  start(agent: AgentKind, resume?: string): Promise<Binding | null>;
  delivery(): Delivery;
  setDelivery(d: Delivery): void;
  /** The folder has MD Review's hooks installed. */
  connected?(): boolean;
  /** Install the skill and hooks (after asking, where the host asks). Resolves to a status line, or null if cancelled. */
  connect?(): Promise<string | null>;
}

/** What the Changes view paints: the hunks against the current baseline. `v` names this comparison. */
export interface Changes {
  v: string;
  at: string;
  /** The baseline rendered, sent once per baseline (the view keeps it). */
  baseHtml?: string;
  /** Or: how the baseline the view has moved (after Keep, or your own edit), so it needn't be sent again. */
  baseShift?: { from: string; steps: BaseStep[] };
  baseId: string;
  hunks: redlines.Hunk[];
  /** Where each thread sent with this baseline sits in it, for Show change. */
  spans?: Record<string, [number, number]>;
}

/** Lines [lo, at) of the baseline were replaced, and the lines from `at` on moved by `delta`. */
export interface BaseStep {
  lo: number;
  at: number;
  delta: number;
}

/** Enough about the baseline for the view to offer Show change and Review changes, without loading it. */
export interface BaselineInfo {
  at: string;
  threads: string[];
  /** The file differs from the baseline. */
  changed: boolean;
  /** Once the changes have been compared: the threads with a change in their text. */
  touched?: string[];
}

export type ToWebview =
  | { type: 'render'; source: string; blocks: string[]; fileName: string; targets?: WordTargets; changes?: Changes | null; changesFailed?: boolean }
  | { type: 'sourceSaved'; seq: number; source: string }
  | { type: 'sourceConflict'; seq: number; message: string }
  | { type: 'linkCheck'; missing: string[]; seq?: number }
  | { type: 'changes'; changes: Changes | null; failed?: boolean }
  | { type: 'baseline'; info: BaselineInfo | null }
  | { type: 'comments'; data: store.Sidecar; author: string; showResolved: boolean }
  | { type: 'block'; ls: number; le: number; text: string }
  | { type: 'blockSaved'; ls: number }
  | { type: 'inlineFailed'; ls: number; le: number; text: string; message: string }
  | { type: 'history'; canUndo: boolean; canRedo: boolean }
  | { type: 'toast'; message: string }
  | { type: 'agentPrompt'; prompt: string; count: number; review?: string }
  | { type: 'agent'; agent: AgentState }
  /** Browser mode: a command for the user to run in a terminal (the view copies it). */
  | { type: 'handOver'; command: string }
  | { type: 'reviewers'; presets: { id: string; label: string; path?: string }[] }
  | { type: 'prefs'; prefs: Record<string, unknown> }
  | { type: 'round'; round: Round | null }
  | { type: 'review'; review: ReviewRun | null }
  /** Jump to a thread picked in the review inbox. */
  | { type: 'focusThread'; id: string }
  | { type: 'error'; message: string };

/**
 * The threads handed to the agent by the last Send, and how far it has got. A
 * thread is done once it's resolved, the agent has the last word (a question
 * back to the reviewer), or the reviewer took it back to a draft.
 */
export interface Round {
  total: number;
  done: number;
  resolved: number;
  questions: number;
  /** Threads where the agent proposed an edit for the reviewer to apply. */
  suggestions: number;
  /** The sent threads now waiting on the reviewer (questions and suggested edits). */
  questionIds: string[];
  finished: boolean;
  /** Blocks changed since the baseline, counted when the round finishes. */
  changes?: number;
}

/**
 * A Review with Claude run. It has no list of threads to finish: it ends when
 * Claude runs `review-done` (the sidecar's reviewDoneAt) or reaches the cap,
 * and the view also calls it over once Claude has been quiet for a while.
 */
export interface ReviewRun {
  startedAt: string;
  /** Drafts Claude has left since the start, up to the cap, including ones since kept or dismissed. */
  total: number;
  /** Their ids, for Show them. */
  ids: string[];
  /** Of those, the ones still waiting to be triaged. */
  untriaged: number;
  finished: boolean;
}

export type FromWebview =
  | { type: 'ready' }
  | { type: 'saveSource'; original: string; changes: SourceChange[]; seq: number }
  | { type: 'addComment'; anchor: store.Anchor; body: string; meta?: store.CommentMeta; suggestion?: string }
  /** Apply a suggestion: the block's rendered text before and after, as for saveInline. */
  | { type: 'applySuggestion'; id: string; from?: string; ls: number; le: number; kind: BlockKind; oldText: string; newText: string }
  | { type: 'dismissSuggestion'; id: string; from?: string }
  | { type: 'setMeta'; id: string; meta: store.CommentMeta }
  | { type: 'reply'; id: string; body: string }
  | { type: 'setStatus'; id: string; status: store.Status }
  | { type: 'editBody'; id: string; body: string }
  | { type: 'deleteComment'; id: string }
  | { type: 'submitReview' }
  | { type: 'getBlock'; ls: number; le: number }
  | { type: 'saveBlock'; ls: number; le: number; original: string; newText: string }
  | { type: 'saveInline'; ls: number; le: number; kind: BlockKind; oldText: string; newText: string }
  | { type: 'openLink'; href: string }
  | { type: 'toggleTask'; line: number; checked: boolean; key?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'sendToAgent'; id?: string }
  | { type: 'setPrefs'; prefs: Record<string, unknown> }
  | { type: 'composing'; on: boolean }
  /** Hide the Send to Claude progress ('round') or the Review with Claude one ('review'). */
  | { type: 'dismissRound'; which: 'round' | 'review' }
  | { type: 'listReviewers' }
  /** preset: a reviewer id from listReviewers, or 'custom' with the instruction typed in. */
  | { type: 'startReview'; preset: string; instruction?: string }
  /** An agent's draft: keep it as yours, or keep it and queue it for the agent's next Send. */
  | { type: 'triage'; id: string; action: 'keep' | 'do' }
  | { type: 'reanchor'; id: string; anchor: store.Anchor }
  | { type: 'checkLinks'; hrefs: string[]; seq?: number }
  | { type: 'showChanges'; on: boolean }
  /** Revert or keep hunk `i` of the comparison `v`. */
  | { type: 'revertChange'; v: string; i: number }
  | { type: 'keepChange'; v: string; i: number }
  | { type: 'acceptChanges' }
  /** The session menu opened: list the sessions it can bind to. */
  | { type: 'listSessions' }
  | { type: 'bindSession'; agent: AgentKind; id: string; name?: string }
  | { type: 'unbindSession' }
  | { type: 'startSession'; agent: AgentKind; resume?: string }
  | { type: 'setDelivery'; delivery: Delivery }
  /** Submit drafts and copy the prompt instead of sending it: for any other agent. */
  | { type: 'copyPrompt' }
  /** Install the skill and hooks in the workspace folder. */
  | { type: 'connectFolder' }
  /** Refresh the chip: is the bound session still running, idle or busy? */
  | { type: 'agentState' };

export interface HostContext {
  mdPath: string;
  author(): string;
  showResolved(): boolean;
  post(msg: ToWebview): void;
  resolveImage: ResolveImage;
  /** Current text to render (the editor buffer in VS Code, disk in the harness). */
  getText(): string;
  /** True if the document has unsaved changes in an editor. */
  isDirty(): boolean;
  openLink(href: string): void;
  /** True when Send to Claude should ask for suggestions instead of edits. */
  suggestMode?(): boolean;
  /** Folders the bibliography may be read from; undefined means anywhere. */
  readableRoots?(): string[] | undefined;
  /** Re-render when any of these files (the bibliography) changes. */
  watchFiles?(files: string[]): void;
  /**
   * Hand the prompt to the agent (deliver it into the bound session). Returns
   * a status line for the user ('' when it already told them), or null when
   * nothing was delivered. When absent, the prompt goes back to the webview,
   * which copies it to the clipboard.
   */
  runAgent?(prompt: string): string | null | Promise<string | null>;
  /** Agent sessions and the binding; when absent, Send goes straight to runAgent. */
  agents?: AgentHost;
  /** Working directory for the agent; defaults to the Markdown file's folder. */
  agentCwd?(): string;
  /** Per-user view preferences (reading theme, zoom), shared by every file. */
  getPrefs?(): Record<string, unknown>;
  setPrefs?(prefs: Record<string, unknown>): void;
  /** Absolute path to cli/mdreview.mjs, if available. */
  cliPath?: string;
  /** Tell the user something happened while they may be looking elsewhere (the view isn't focused). */
  notify?(message: string): void;
  /** The most comments Review with Claude asks for (default 12). */
  reviewComments?(): number;
  /** Delays before re-reading a sidecar that didn't parse (tests shorten them). */
  sidecarRetryMs?: number[];
  /** Run fn after ms; defaults to setTimeout. */
  schedule?(fn: () => void, ms: number): void;
  /** Where this file's Changes baseline is kept (a file in the extension's storage in VS Code). In memory when absent. */
  baselines?: BaselineHook;
}

function readText(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
}

/** The CLI that ships with the extension, read once to compare workspace copies against. */
let shippedCli: { path: string; bytes: Buffer } | undefined;

/** Comments saved this close together in live mode go to the agent as one message. */
const LIVE_COALESCE_MS = 400;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 resolved, 1 suggested edit and 1 question for you" */
export function roundSummary(r: Round): string {
  const yours = [r.suggestions && count(r.suggestions, 'suggested edit', 'suggested edits'), r.questions && count(r.questions, 'question', 'questions')].filter(Boolean);
  return `${r.resolved} resolved${yours.length ? `, ${yours.join(' and ')} for you` : ''}`;
}

/**
 * The baseline's bytes and text (BOM dropped, LF line breaks), and once needed
 * its HTML and blocks. `shift`: how its lines moved since the one the view was
 * sent (`from`), and the lines it adds. `pending`: lines [lo, hi) whose blocks
 * are still to be taken from the parse of a text that has them at lo + off.
 */
interface BaseView {
  id: string;
  bytes: Buffer;
  text: string;
  html?: string;
  blocks?: redlines.Block[];
  pending?: { lo: number; hi: number; off: number };
  shift?: { from: string; steps: BaseStep[]; dirty: [number, number][] };
}

const lineCount = (s: string) => {
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
};

/**
 * A suggestion an edit applied, and the thread's state before it: its status,
 * and who it belonged to when it was an agent's untriaged draft (applying keeps it).
 */
interface Applied { id: string; from?: string; status: store.Status; agent?: { author: string; suggestedBy?: string } }

/**
 * The file a link points at, relative to the document's folder, as written
 * (decoded, without `#part` or `?query`); null for URLs, protocol-relative
 * `//host/x` and in-page anchors. A drive (`C:/x.md`, `C:\x.md`) or a
 * `\\host` path is a file. Opening a link and the health panel's check both use it.
 */
export function linkPath(href: string): string | null {
  if (!href || hasUrlScheme(href) || /^(\/\/|#)/.test(href)) return null;
  const p = href.split(/[#?]/)[0];
  if (!p) return null;
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** Kept with an undo entry: the suggestion it applied, or that it was your own edit (see foldIntoBaseline). */
interface EditTag { applied?: Applied; yours?: boolean }
const YOURS: EditTag = { yours: true };

export class ReviewSession {
  private lastSidecarWrite: string | undefined;
  /** Counts sidecar events, so a pending re-read gives way to a newer one. */
  private sidecarEvents = 0;
  /** The sidecar text last shown after a watcher event, so a second report of the same change is skipped. */
  private lastSidecarSeen: string | undefined;
  private disposed = false;
  private lastRendered: string | undefined;
  private watched = '';
  private lastParse: RenderedParse | undefined;
  private history = new EditHistory();
  /** The threads of the last Send to Claude; once finished, the summary stays as it was until dismissed. */
  private round: { ids: string[]; summary?: Round } | null = null;
  /** A Review with Claude run: when it started, its cap, and the drafts seen so far. Independent of the round. */
  private review: { run: string; since: string; max: number; ids: Set<string>; finished: boolean } | null = null;
  private bases: BaselineHook | undefined;
  /** The Changes view is on, so every render carries the hunks. */
  private changesOn = false;
  /** The baseline's bytes and text, once needed, and (once the Changes view needs them) its HTML and blocks. */
  private baseView: BaseView | null = null;
  /** The baseline the view has, and the lines its copy lacks (added by Keep or your edits since it was sent). */
  private sent: { id: string; missing: [number, number][] } = { id: '', missing: [] };
  private hunks: { v: string; baseId: string; list: redlines.Hunk[] } | null = null;
  private lastInfo = '';
  /** Whether the last text checked differs from the baseline, so a render with the view off hashes at most once. */
  private differsMemo: { id: string; text: string; value: boolean } | null = null;
  /** A Keep or Revert is being settled: if nothing is left to show after it, the baseline is reviewed. */
  private settling = false;
  /** The threads with a change in their text, as of the last comparison with baseline `id`. */
  private touched: { id: string; ids: string[] } | null = null;
  /** The blocks of the last render's parse. */
  private curBlocks: { tokens: unknown; blocks: redlines.Block[] } | null = null;

  /** A Send or review waiting for a session to be picked. */
  private waiting: (() => void) | null = null;
  /** 'Starting Claude…' while a session starts. */
  private starting = '';
  /** Threads saved in live mode, sent together after a moment. */
  private live = new Set<string>();
  private liveTimer = false;
  private staleCliTold = false;

  constructor(private ctx: HostContext) {}

  /**
   * Render the current text and send it to the view. One file change reaches
   * the host several ways (the edit itself, the file watcher, VS Code reloading
   * the buffer), so text that was already rendered is skipped unless `force`.
   */
  render(force = false): void {
    const text = this.ctx.getText();
    if (!force && text === this.lastRendered) return this.syncHistory();
    this.lastRendered = text;
    let blocks: string[];
    const env: RenderEnv = { docDir: path.dirname(this.ctx.mdPath), bibRoots: this.ctx.readableRoots?.() };
    this.lastParse = undefined;
    try {
      const r = renderParsed(text, this.ctx.resolveImage, env);
      blocks = r.blocks;
      this.lastParse = { text, ...r.parse };
    } catch (e: any) {
      blocks = [`<pre class="mdr-error">Render failed: ${String(e?.message || e)}</pre>`];
    }
    const bibs = (env.bibFiles || []).join('\n');
    if (bibs !== this.watched) {
      this.watched = bibs;
      this.ctx.watchFiles?.(env.bibFiles || []);
    }
    let changes: Changes | null | undefined;
    let changesFailed: true | undefined;
    try {
      if (this.changesOn) changes = this.changes();
    } catch {
      changes = null; // a text the parser rejects: show no redlines rather than fail the render
      changesFailed = true;
    }
    this.ctx.post({ type: 'render', source: sourceText(text), blocks, fileName: path.basename(this.ctx.mdPath), targets: env.front?.targets, changes, changesFailed });
    this.syncHistory();
    this.postBaseline();
  }

  /** Read through the hook each time, so two views of one file agree. */
  private baselines(): BaselineHook {
    return this.ctx.baselines ?? (this.bases ||= memoryBaselines());
  }

  private setBaseline(b: redlines.Baseline | null, bytes?: Buffer): void {
    this.baselines().set(b, bytes);
    this.postBaseline();
  }

  private postBaseline(): void {
    const cur = this.baselines().get();
    const info: BaselineInfo | null = cur ? { at: cur.at, threads: cur.threads, changed: this.differs(cur) } : null;
    if (info && this.touched?.id === cur!.id) info.touched = this.touched.ids;
    const key = JSON.stringify(info);
    if (key === this.lastInfo) return;
    this.lastInfo = key;
    this.ctx.post({ type: 'baseline', info });
  }

  /** The text differs from the baseline: compared with the loaded copy, or else by hash, and remembered per text. */
  private differs(b: redlines.Baseline, text = this.lastRendered ?? ''): boolean {
    const m = this.differsMemo;
    if (m && m.id === b.id && m.text === text) return m.value;
    const v = this.baseView?.id === b.id ? this.baseView : null;
    const value = v ? v.text !== redlines.normText(text) : redlines.textId(text) !== b.id;
    this.differsMemo = { id: b.id, text, value };
    return value;
  }

  /** The baseline's bytes and text, read when first needed. Null when its copy is gone. */
  private view(b: redlines.Baseline): BaseView | null {
    if (this.baseView?.id !== b.id) {
      const bytes = this.baselines().read();
      if (!bytes) return null;
      this.baseView = { id: b.id, bytes, text: redlines.normText(bytes.toString('utf8')) };
    }
    return this.baseView;
  }

  /** A text's blocks: from the last render's parse when it's that text, else parsed (not rendered, no bibliography read). */
  private blocksFor(text: string): redlines.Block[] {
    const p = this.lastParse;
    if (!p || (p.text !== text && redlines.normText(p.text) !== redlines.normText(text))) {
      return redlines.blocksOfTokens(rendererFor(this.ctx.resolveImage).parse(text, { bibRoots: [] }));
    }
    if (this.curBlocks?.tokens !== p.tokens) this.curBlocks = { tokens: p.tokens, blocks: redlines.blocksOfTokens(p.tokens) };
    return this.curBlocks.blocks;
  }

  /**
   * The baseline's blocks. After Keep or your own edit only the lines that
   * changed need new blocks: they're taken from the parse of the text they
   * came from, when it still has them; otherwise the baseline is parsed again.
   */
  private blocks(v: BaseView): redlines.Block[] {
    const pd = v.pending;
    if (pd && v.blocks) {
      v.pending = undefined;
      const p = this.lastParse;
      const lines = p && redlines.normText(p.text).split('\n');
      const bl = v.text.split('\n');
      const lo = pd.lo + pd.off;
      const hi = pd.hi + pd.off;
      const src = p && lines && lines.slice(lo, hi).join('\n') === bl.slice(pd.lo, pd.hi).join('\n') ? this.blocksFor(p.text) : null;
      if (src && !src.some((k) => (k.ls < lo && k.le > lo) || (k.ls < hi && k.le > hi))) {
        const mid = src.filter((k) => k.ls >= lo && k.le <= hi).map((k) => ({ ...k, ls: k.ls - pd.off, le: k.le - pd.off }));
        v.blocks = [...v.blocks.filter((k) => k.le <= pd.lo), ...mid, ...v.blocks.filter((k) => k.ls >= pd.hi)];
      } else v.blocks = undefined;
    }
    return (v.blocks ||= this.blocksFor(v.text));
  }

  private baseHtml(v: BaseView): string {
    if (v.html === undefined) {
      try {
        // The same reading rules as the document (bibliographies only where render() may read them).
        const r = renderParsed(v.text, this.ctx.resolveImage, { docDir: path.dirname(this.ctx.mdPath), bibRoots: this.ctx.readableRoots?.() });
        v.html = r.blocks.join('');
        if (!v.blocks || v.pending) {
          v.blocks = redlines.blocksOfTokens(r.parse.tokens);
          v.pending = undefined;
        }
      } catch (e: any) {
        v.html = `<pre class="mdr-error">Render failed: ${String(e?.message || e).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`;
      }
    }
    return v.html;
  }

  /** The hunks of the current text against the baseline, remembered so Revert and Keep can name one by index. */
  private changes(): Changes | null {
    const cur = this.baselines().get();
    const v = cur && this.view(cur);
    if (!cur || !v) {
      this.hunks = null;
      if (cur) this.setBaseline(null); // its copy is gone
      return null;
    }
    const text = this.lastRendered ?? '';
    const list = redlines.diffBlocks(v.text, text, this.blocks(v), this.blocksFor(text));
    if (!list.length && (this.differs(cur) || (this.settling && !cur.settled))) {
      // Nothing left to show (what's left, if anything, is blank lines): the review is done.
      this.rebase(cur, text);
      return this.changes();
    }
    const v2 = redlines.sha1(cur.id + '\0' + text);
    this.hunks = { v: v2, baseId: cur.id, list };
    this.touched = { id: cur.id, ids: redlines.touchedThreads(list, cur.spans) };
    const ch: Changes = { v: v2, at: cur.at, baseId: cur.id, hunks: list, spans: cur.spans };
    // The view renumbers the baseline it has, unless a change shows lines its copy lacks.
    const lacks = (missing: [number, number][]) => list.some((h) => h.base && missing.some(([lo, hi]) => h.base!.ls < hi && h.base!.le > lo));
    const sh = v.shift;
    if (this.sent.id === cur.id ? lacks(this.sent.missing) : !sh || sh.from !== this.sent.id || lacks(sh.dirty)) {
      ch.baseHtml = this.baseHtml(v);
      this.sent = { id: cur.id, missing: [] };
    } else if (sh && this.sent.id !== cur.id) {
      ch.baseShift = { from: sh.from, steps: sh.steps };
      this.sent = { id: cur.id, missing: sh.dirty };
    }
    v.shift = undefined;
    return ch;
  }

  private postChanges(): void {
    if (!this.changesOn) return;
    try {
      this.ctx.post({ type: 'changes', changes: this.changes() });
    } catch {
      this.ctx.post({ type: 'changes', changes: null, failed: true });
    }
    this.postBaseline();
  }

  /** Make the baseline the text as it is now, reviewed: the next Send starts afresh. */
  private rebase(cur: redlines.Baseline, text: string): void {
    const bytes = Buffer.from(text, 'utf8');
    const id = redlines.textId(text);
    const old = this.baseView;
    this.baseView = { id, bytes, text: redlines.normText(text), shift: old?.shift && { ...old.shift, dirty: [[0, lineCount(text)]] } };
    this.setBaseline({ ...cur, id, settled: true }, bytes);
  }

  /**
   * Copy lines c of `src` over lines b of the baseline (Keep, or your own
   * edit). The rendered baseline isn't redone: the view is told how its lines
   * moved, and only the blocks of the copied lines are found again.
   */
  private patchBaseline(cur: redlines.Baseline, v: BaseView, b: [number, number], src: Buffer, c: [number, number]): redlines.Baseline {
    const next = spliceLines(v.bytes, b[0], b[1], src, c[0], c[1]);
    const text = redlines.normText(next.toString('utf8'));
    const id = redlines.sha1(text);
    if (id === cur.id) return cur;
    const delta = lineCount(text) - lineCount(v.text);
    const n = b[1] - b[0] + delta; // the lines now in [b0, b1)
    const step = { lo: b[0], at: b[1], delta };
    const prev = v.shift ?? (this.sent.id === cur.id ? { from: cur.id, steps: [], dirty: this.sent.missing } : undefined);
    // Lines the view's copy doesn't have, renumbered for this step.
    const move = ([lo, hi]: [number, number]): [number, number] =>
      lo >= step.at ? [lo + step.delta, hi + step.delta] : hi <= step.lo ? [lo, hi] : [Math.min(lo, step.lo), Math.max(hi >= step.at ? hi + step.delta : 0, step.lo + n)];
    // Blocks: those clear of the change stay (renumbered); the change's own come from `src`'s parse later.
    let blocks: redlines.Block[] | undefined;
    let pending: BaseView['pending'];
    const old = v.pending ? undefined : v.blocks;
    if (old) {
      const hit = old.filter((k) => k.ls < b[1] && k.le > b[0]);
      const lo = Math.min(b[0], ...hit.map((k) => k.ls));
      const hi = Math.max(b[1], ...hit.map((k) => k.le)) + delta;
      blocks = old.filter((k) => !(k.ls < b[1] && k.le > b[0]) && !(b[0] === b[1] && k.ls < b[0] && k.le > b[0])).map((k) => (k.ls >= b[1] ? { ...k, ls: k.ls + delta, le: k.le + delta } : k));
      pending = { lo, hi, off: c[0] - b[0] };
    }
    this.baseView = {
      id,
      bytes: next,
      text,
      blocks,
      pending,
      shift: prev ? { from: prev.from, steps: [...prev.steps, step], dirty: [...prev.dirty.map(move), [b[0], b[0] + n]] } : undefined,
    };
    const b2 = { ...cur, id, spans: redlines.shiftSpans(cur.spans, b[0], b[1], delta) };
    this.setBaseline(b2, next);
    return b2;
  }

  /** Revert copies the baseline's lines over the file's; Keep copies the file's into the baseline. Both halves of a move go together. */
  private settleChange(revert: boolean, v: string, i: number): void {
    const cur = this.baselines().get();
    const view = cur && this.view(cur);
    const h = this.hunks && this.hunks.v === v && cur && this.hunks.baseId === cur.id ? this.hunks.list[i] : undefined;
    if (!cur || !view || !h) {
      this.render();
      throw new Error('The file or its baseline changed since these changes were shown, so nothing was written. The view has been refreshed.');
    }
    const group = h.pair === undefined ? [h] : [h, this.hunks!.list[h.pair]];
    this.settling = true;
    try {
      if (revert) {
        this.assertEditable(); // refuses if the file changed on disk since this render
        // Last lines first, so the other's line numbers still hold.
        group.sort((x, y) => y.c[0] - x.c[0]);
        this.recorded(() => {
          let buf: Buffer = fs.readFileSync(this.ctx.mdPath);
          for (const g of group) buf = spliceLines(buf, g.c[0], g.c[1], view.bytes, g.b[0], g.b[1]);
          fs.writeFileSync(this.ctx.mdPath, buf);
        });
        this.ctx.post({ type: 'toast', message: 'Reverted that change. Undo brings it back.' });
        this.render();
      } else {
        group.sort((x, y) => y.b[0] - x.b[0]);
        const src = Buffer.from(this.lastRendered ?? '', 'utf8');
        let b = cur;
        for (const g of group) b = this.patchBaseline(b, this.baseView!, g.b, src, g.c);
        this.postChanges();
      }
    } finally {
      this.settling = false;
    }
    this.updateRoundChanges();
  }

  /**
   * An edit you made in the view is yours, not Claude's: make it in the
   * baseline too, so it doesn't show as a change. Only where Claude left the
   * text alone (the edited lines and one on each side match the baseline's);
   * an edit touching Claude's change stays part of it. Cheap enough for every
   * edit: a diff of lines, nothing parsed, and none if Claude changed too much.
   */
  private foldIntoBaseline(before: Buffer, after: Buffer): void {
    const cur = this.baselines().get();
    const v = cur && this.view(cur);
    if (!cur || !v) return;
    try {
      const bl = redlines.normText(before.toString('utf8')).split('\n');
      const al = redlines.normText(after.toString('utf8')).split('\n');
      let p = 0;
      while (p < bl.length && p < al.length && bl[p] === al[p]) p++;
      let s = 0;
      while (s < bl.length - p && s < al.length - p && bl[bl.length - 1 - s] === al[al.length - 1 - s]) s++;
      const e = bl.length - s; // lines [p, e) of before became [p, al.length - s) of after
      const ids = new Map<string, number>();
      const id = (l: string) => ids.get(l) ?? ids.set(l, ids.size).get(l)!;
      const script = diffSeq(v.text.split('\n').map(id), bl.map(id), 200);
      if (!script) return;
      // The baseline line each line of before is, or -1 where Claude changed it.
      const at = new Int32Array(bl.length).fill(-1);
      let x = 0;
      let y = 0;
      for (const op of script) {
        if (op === 0) at[y++] = x++;
        else if (op === -1) x++;
        else y++;
      }
      const lo = Math.max(0, p - 1);
      const hi = Math.min(bl.length, e + 1);
      for (let l = lo; l < hi; l++) if (at[l] < 0 || at[l] - at[lo] !== l - lo) return;
      const bp = lo < p ? at[lo] + 1 : at[lo];
      this.patchBaseline(cur, v, [bp, bp + e - p], after, [p, al.length - s]);
    } catch {
      // the baseline stays as it was; the edit shows as a change
    }
  }

  /** The finished round's count follows Keep, Revert and Accept all. */
  private updateRoundChanges(): void {
    const r = this.round?.summary;
    if (!r || r.changes === undefined) return;
    const n = this.hunks && this.baselines().get() ? redlines.changedBlocks(this.hunks.list) : 0;
    if (n === r.changes) return;
    r.changes = n || undefined;
    this.ctx.post({ type: 'round', round: r });
  }

  /** Every render follows a file change, so check undo history still applies. */
  private syncHistory(): void {
    if (!this.history.canUndo && !this.history.canRedo) return;
    let disk: Buffer;
    try {
      disk = fs.readFileSync(this.ctx.mdPath);
    } catch {
      return;
    }
    if (this.history.sync(disk)) this.postHistory();
  }

  sendComments(): void {
    let data: store.Sidecar;
    try {
      data = store.readSidecar(this.ctx.mdPath);
    } catch (e: any) {
      this.postParseError(e);
      return;
    }
    this.postComments(data);
  }

  private postComments(data: store.Sidecar): void {
    this.ctx.post({ type: 'comments', data, author: this.ctx.author(), showResolved: this.ctx.showResolved() });
    this.updateRound(data);
    this.updateReview(data);
  }

  private postParseError(e: any): void {
    this.ctx.post({ type: 'error', message: `Could not parse ${path.basename(store.sidecarPath(this.ctx.mdPath))}: ${e.message}` });
  }

  private updateRound(data: store.Sidecar): void {
    if (!this.round) return;
    if (this.round.summary) return this.ctx.post({ type: 'round', round: this.round.summary });
    const by = new Map(data.comments.map((c) => [c.id, c]));
    const round: Round = { total: 0, done: 0, resolved: 0, questions: 0, suggestions: 0, questionIds: [], finished: false };
    for (const id of this.round.ids) {
      const c = by.get(id);
      if (!c) continue; // deleted: no longer part of the round
      round.total++;
      if (c.status === 'resolved') round.resolved++;
      else if (c.status === 'submitted' && !store.awaitsAgent(c)) {
        round.questionIds.push(c.id);
        if (store.openSuggestion(c)) round.suggestions++;
      }
      else if (c.status === 'submitted') continue;
      round.done++; // a draft again (reviewer took it back) counts as done
    }
    round.questions = round.questionIds.length - round.suggestions;
    round.finished = round.done === round.total;
    if (round.finished && round.total) {
      // The agent's last edit may not have been rendered yet: count against the disk.
      const base = this.baselines().get();
      const v = base && this.view(base);
      const disk = v ? readText(this.ctx.mdPath) : undefined;
      try {
        if (base && v && disk !== undefined && this.differs(base, disk)) {
          const list = redlines.diffBlocks(v.text, disk, this.blocks(v), this.blocksFor(disk));
          round.changes = redlines.changedBlocks(list) || undefined;
          this.touched = { id: base.id, ids: redlines.touchedThreads(list, base.spans) };
          this.postBaseline();
        }
      } catch {
        // no count, rather than no summary
      }
      this.ctx.notify?.(`Claude finished ${path.basename(this.ctx.mdPath)}: ${roundSummary(round)}.`);
      this.round.summary = round;
    }
    this.ctx.post({ type: 'round', round: round.total ? round : null });
  }

  /** The panel closed: pending re-reads do nothing. */
  dispose(): void {
    this.disposed = true;
  }

  /**
   * Count the drafts Claude has left since the review started. It's finished
   * once Claude stamps reviewDoneAt (review-done) or reaches the cap.
   */
  private updateReview(data: store.Sidecar): void {
    const r = this.review;
    if (!r) return;
    const by = new Map(data.comments.map((c) => [c.id, c]));
    // An earlier review still running can finish after this one started; only this run's review-done counts.
    const done = typeof data.reviewDoneAt === 'string' && (data.reviewDoneRun ? data.reviewDoneRun === r.run : data.reviewDoneAt >= r.since);
    // Drafts past the cap, or after the run finished (even in the same write), aren't this run's.
    for (const c of data.comments) {
      if (r.finished || r.ids.size >= r.max) break;
      if (done && c.createdAt > data.reviewDoneAt!) continue;
      if (c.origin === 'agent' && (c.reviewRun ? c.reviewRun === r.run : c.createdAt >= r.since)) r.ids.add(c.id);
    }
    const n = r.ids.size;
    let untriaged = 0;
    for (const id of r.ids) if (by.get(id) && store.isAgentDraft(by.get(id)!)) untriaged++;
    const finished = r.finished || n >= r.max || done;
    if (finished && !r.finished) {
      const file = path.basename(this.ctx.mdPath);
      this.ctx.notify?.(n ? `Claude left ${count(n, 'comment', 'comments')} on ${file}.` : `Claude finished reviewing ${file} with no comments.`);
    }
    r.finished = finished;
    this.ctx.post({ type: 'review', review: { startedAt: r.since, total: n, ids: [...r.ids], untriaged, finished } });
  }

  /**
   * Called by a file watcher when the sidecar changes on disk. The writer may
   * not be done yet (sync tools and Windows fall back to writing in place), so
   * a file that doesn't parse is read again a few times before it's an error.
   */
  onSidecarChanged(): void {
    const gen = ++this.sidecarEvents;
    const delays = this.ctx.sidecarRetryMs ?? SIDECAR_RETRY_MS;
    const schedule = this.ctx.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    const attempt = (i: number) => {
      if (this.disposed || gen !== this.sidecarEvents) return; // closed, or a newer event reads it instead
      let current: string | undefined;
      try {
        current = fs.readFileSync(store.sidecarPath(this.ctx.mdPath), 'utf8');
      } catch {
        current = undefined;
      }
      if (current !== undefined && current === this.lastSidecarWrite) return; // our own write
      if (current !== undefined && current === this.lastSidecarSeen) return; // already shown (event and poll both saw it)
      const retry = i < delays.length;
      // An empty file is usually a writer that has truncated but not written yet.
      if (current === '' && retry) return schedule(() => attempt(i + 1), delays[i]);
      let data: store.Sidecar;
      try {
        data = store.readSidecar(this.ctx.mdPath);
      } catch (e: any) {
        if (retry) schedule(() => attempt(i + 1), delays[i]);
        else this.postParseError(e);
        return;
      }
      this.lastSidecarSeen = current;
      this.postComments(data);
    };
    attempt(0);
  }

  private mutate(fn: (d: store.Sidecar) => void): void {
    const { written } = store.mutate(this.ctx.mdPath, fn);
    this.lastSidecarWrite = written;
    this.sendComments();
  }

  handle(msg: FromWebview): void {
    try {
      this.handleInner(msg);
    } catch (e: any) {
      if (e instanceof BlockEditError) this.render(true);
      this.ctx.post({ type: 'error', message: String(e?.message || e) });
    }
  }

  private handleInner(msg: FromWebview): void {
    const author = this.ctx.author();
    switch (msg.type) {
      case 'ready':
        this.sent = { id: '', missing: [] }; // a new view has no baseline yet
        this.lastInfo = 'null'; // and knows of none
        this.changesOn = false; // and starts with Changes off
        // Document last, so the view paints once with its look and comments.
        if (this.ctx.getPrefs) this.ctx.post({ type: 'prefs', prefs: this.ctx.getPrefs() });
        this.postAgent();
        this.sendComments();
        this.postHistory();
        this.render(true);
        return;
      case 'addComment': {
        let id = '';
        this.mutate((d) => {
          const c = store.addComment(d, author, msg.anchor, msg.body, msg.meta);
          if (typeof msg.suggestion === 'string' && c.scope === undefined) c.suggestion = { text: msg.suggestion };
          id = c.id;
        });
        // Live: praise needs nothing from the agent, so it stays a draft.
        if (this.liveOn() && msg.meta?.kind !== 'praise') this.queueLive(id);
        return;
      }
      case 'applySuggestion': {
        this.assertEditable();
        // Kept with the undo entry, so Undo and Redo move the thread along with the text.
        const applied: Applied = { id: msg.id, from: msg.from, status: 'submitted' };
        // A suggestion you wrote yourself is your edit, not Claude's (see foldIntoBaseline).
        let yours = false;
        try {
          const c = store.find(store.readSidecar(this.ctx.mdPath), msg.id);
          yours = (msg.from ? c.replies.find((r) => r.id === msg.from)?.author : c.origin === 'agent' || c.suggestedBy ? undefined : c.author) === author;
        } catch {}
        try {
          this.recorded(() => applyInlineEdit(this.ctx.mdPath, msg.ls, msg.le, msg.kind, msg.oldText, msg.newText, this.lastParse), { applied, yours });
        } catch (e) {
          if (e instanceof InlineMapError) {
            this.ctx.post({ type: 'inlineFailed', ls: msg.ls, le: msg.le, text: e.source, message: "Couldn't apply that suggestion to the Markdown safely, so nothing was written. Make the change in the source below." });
            return;
          }
          throw e;
        }
        // Applied is done: the thread resolves, like accepting a suggestion in Docs.
        this.mutate((d) => {
          const c = store.find(d, msg.id);
          if (store.isAgentDraft(c)) applied.agent = { author: c.author, suggestedBy: c.suggestedBy };
          store.keepAgentDraft(d, msg.id, author);
          const s = store.suggestionOf(c, msg.from);
          applied.status = c.status;
          if (s) s.appliedAt = store.now();
          if (c.status !== 'resolved') store.setStatus(d, msg.id, 'resolved');
        });
        this.ctx.post({ type: 'blockSaved', ls: msg.ls });
        this.render(true);
        return;
      }
      case 'dismissSuggestion':
        return this.mutate((d) => {
          const s = store.suggestionOf(store.find(d, msg.id), msg.from);
          if (s) s.dismissedAt = store.now();
        });
      case 'setMeta':
        return this.mutate((d) => store.setMeta(d, msg.id, msg.meta));
      case 'reply': {
        let toAgent = false;
        this.mutate((d) => {
          store.addReply(d, msg.id, author, msg.body);
          toAgent = store.find(d, msg.id).status === 'submitted';
        });
        // Live: answering the agent on an open thread goes straight back to it.
        if (toAgent && this.liveOn()) this.queueLive(msg.id);
        return;
      }
      case 'setStatus':
        return this.mutate((d) => store.setStatus(d, msg.id, msg.status));
      case 'editBody':
        return this.mutate((d) => store.editBody(d, msg.id, msg.body));
      case 'deleteComment':
        return this.mutate((d) => store.deleteComment(d, msg.id));
      case 'submitReview':
        return this.mutate((d) => void store.submitDrafts(d));
      case 'getBlock': {
        this.assertEditable();
        const text = readBlock(fs.readFileSync(this.ctx.mdPath), msg.ls, msg.le);
        this.ctx.post({ type: 'block', ls: msg.ls, le: msg.le, text });
        return;
      }
      case 'saveSource': {
        try {
          if (this.ctx.isDirty()) throw new Error('Another editor has unsaved changes. Save those first. Your writing remains here.');
          let source = '';
          this.recorded(() => { source = applySourceEdit(this.ctx.mdPath, msg.original, msg.changes); }, YOURS);
          this.ctx.post({ type: 'sourceSaved', seq: msg.seq, source });
          this.render(true);
        } catch (e: any) {
          this.ctx.post({ type: 'sourceConflict', seq: msg.seq, message: e.message || String(e) });
        }
        return;
      }
      case 'saveBlock':
        this.assertEditable();
        this.recorded(() => applyBlockEdit(this.ctx.mdPath, msg.ls, msg.le, msg.original, msg.newText), YOURS);
        this.ctx.post({ type: 'blockSaved', ls: msg.ls });
        this.render(true); // the view changed the DOM; always repaint it
        return;
      case 'saveInline':
        this.assertEditable();
        try {
          this.recorded(() => applyInlineEdit(this.ctx.mdPath, msg.ls, msg.le, msg.kind, msg.oldText, msg.newText, this.lastParse), YOURS);
        } catch (e) {
          if (e instanceof InlineMapError) {
            this.ctx.post({ type: 'inlineFailed', ls: msg.ls, le: msg.le, text: e.source, message: e.message });
            return;
          }
          throw e;
        }
        this.ctx.post({ type: 'blockSaved', ls: msg.ls });
        this.render(true);
        return;
      case 'openLink':
        this.ctx.openLink(msg.href);
        return;
      case 'toggleTask':
        try {
          this.assertEditable();
          this.recorded(() => toggleTask(this.ctx.mdPath, msg.line, msg.checked, msg.key), YOURS);
        } finally {
          this.render(true); // repaint even if the text is unchanged, so a refused click is undone
        }
        return;
      case 'undo':
      case 'redo':
        return this.undoRedo(msg.type);
      case 'sendToAgent':
        return this.sendToAgent(msg.id ? [msg.id] : undefined);
      case 'copyPrompt':
        return this.sendToAgent(undefined, true);
      case 'listSessions':
        return this.postAgent(true);
      case 'bindSession':
        return this.bindTo({ agent: msg.agent, id: msg.id, name: msg.name });
      case 'unbindSession':
        this.waiting = null;
        return this.bindTo(undefined);
      case 'startSession':
        return this.startSession(msg.agent, msg.resume);
      case 'setDelivery':
        this.ctx.agents?.setDelivery(msg.delivery);
        return this.postAgent();
      case 'agentState':
        return this.postAgent();
      case 'connectFolder': {
        const connect = this.ctx.agents?.connect;
        if (!connect) return;
        connect().then(
          (status) => {
            if (status) this.ctx.post({ type: 'toast', message: status });
            this.postAgent();
          },
          (e) => this.ctx.post({ type: 'error', message: String((e as Error)?.message || e) }),
        );
        return;
      }
      case 'dismissRound':
        if (msg.which === 'review') {
          this.review = null;
          return this.ctx.post({ type: 'review', review: null });
        }
        this.round = null;
        return this.ctx.post({ type: 'round', round: null });
      case 'setPrefs':
        this.ctx.setPrefs?.(msg.prefs);
        return;
      case 'showChanges':
        this.changesOn = msg.on;
        if (!msg.on) this.dropChanges(); // the view drops its copy too
        return this.postChanges();
      case 'revertChange':
      case 'keepChange':
        return this.settleChange(msg.type === 'revertChange', msg.v, msg.i);
      case 'acceptChanges':
        this.setBaseline(null);
        this.dropChanges(true);
        this.updateRoundChanges();
        return this.postChanges();
      case 'composing': // a VS Code context key for Alt+1/2/3; set by the extension
        return;
      case 'listReviewers':
        // Read on demand: the menu is the only thing that needs the workspace reviewers.
        return this.ctx.post({ type: 'reviewers', presets: listReviewers(this.agentCwd()) });
      case 'startReview':
        return this.startReview(msg.preset, msg.instruction);
      case 'triage':
        // Do it queues the thread for Claude rather than starting it: a dozen drafts shouldn't mean a dozen terminals.
        this.mutate((d) => {
          store.keepAgentDraft(d, msg.id, author);
          if (msg.action === 'do' && store.find(d, msg.id).status === 'draft') store.setStatus(d, msg.id, 'submitted');
        });
        if (msg.action === 'do') this.ctx.post({ type: 'toast', message: "Queued for Claude. Send to Claude when you've triaged the rest." });
        return;
      case 'reanchor':
        return this.mutate((d) => store.reanchor(d, msg.id, msg.anchor));
      case 'checkLinks':
        void this.checkLinks(msg.hrefs, msg.seq);
        return;
    }
  }

  /**
   * Which relative links and images point at files that don't exist. Only on
   * request (the health panel). Network paths are never touched, and in
   * Restricted Mode only files the bibliography could read are looked at.
   * `seq` comes back with the answer, so the view can drop one for an older question.
   */
  private async checkLinks(hrefs: string[], seq?: number): Promise<void> {
    const dir = path.dirname(this.ctx.mdPath);
    const readable = this.ctx.readableRoots?.();
    const roots = readable && realRoots(readable);
    const list = [...new Set((Array.isArray(hrefs) ? hrefs : []).filter((h) => typeof h === 'string'))].slice(0, 2000);
    const gone = await Promise.all(
      list.map(async (h) => {
        const p = linkPath(h);
        if (!p) return false;
        const file = path.resolve(dir, p);
        if (isNetworkPath(file) || (roots && !insideRealRoots(file, roots))) return false;
        try {
          await fs.promises.stat(file);
          return false;
        } catch (e: any) {
          return e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
        }
      }),
    );
    this.ctx.post({ type: 'linkCheck', missing: list.filter((_, i) => gone[i]), seq: typeof seq === 'number' ? seq : undefined });
  }

  /** Run a file edit and remember it for undo. */
  private recorded(write: () => unknown, tag?: EditTag): void {
    const before = fs.readFileSync(this.ctx.mdPath);
    write();
    const after = fs.readFileSync(this.ctx.mdPath);
    this.history.record(before, after, tag);
    if (tag?.yours) this.foldIntoBaseline(before, after);
    this.postHistory();
  }

  postHistory(): void {
    this.ctx.post({ type: 'history', canUndo: this.history.canUndo, canRedo: this.history.canRedo });
  }

  private undoRedo(which: 'undo' | 'redo'): void {
    if (which === 'undo' ? !this.history.canUndo : !this.history.canRedo) {
      this.ctx.post({ type: 'toast', message: which === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.' });
      return;
    }
    if (this.ctx.isDirty()) {
      throw new Error('This file has unsaved changes in another editor. Save or revert them before undoing here.');
    }
    const cur = fs.readFileSync(this.ctx.mdPath);
    const tag = this.history.nextTag(which) as EditTag | undefined;
    const applied = tag?.applied;
    let next: Buffer;
    try {
      next = which === 'undo' ? this.history.undo(cur) : this.history.redo(cur);
    } catch (e) {
      if (e instanceof HistoryError) this.postHistory();
      throw e;
    }
    fs.writeFileSync(this.ctx.mdPath, next);
    if (tag?.yours) this.foldIntoBaseline(cur, next);
    this.postHistory();
    // Undoing an applied suggestion puts the thread back the way it was; Redo applies it again.
    if (applied) {
      try {
        this.mutate((d) => {
          const c = store.find(d, applied.id);
          const s = store.suggestionOf(c, applied.from);
          if (which === 'undo') {
            if (s) delete s.appliedAt;
            if (c.status !== applied.status) store.setStatus(d, applied.id, applied.status);
            // It was Claude's untriaged draft: it goes back to waiting for triage.
            if (applied.agent) {
              c.origin = 'agent';
              c.author = applied.agent.author;
              if (applied.agent.suggestedBy === undefined) delete c.suggestedBy;
              else c.suggestedBy = applied.agent.suggestedBy;
            }
          } else {
            if (applied.agent) store.keepAgentDraft(d, applied.id, this.ctx.author());
            if (s) s.appliedAt = store.now();
            if (c.status !== 'resolved') store.setStatus(d, applied.id, 'resolved');
          }
        });
      } catch {
        // the thread is gone; the text is back regardless
      }
    }
    this.ctx.post({ type: 'toast', message: which === 'undo' ? 'Undid the last edit.' : 'Redid the edit.' });
    this.render(true);
  }

  /**
   * Submit what's pending and hand the open threads to the agent. With ids,
   * only those threads are sent (and submitted if they were drafts). `copy`
   * puts the prompt on the clipboard instead of sending it.
   */
  private sendToAgent(ids?: string[], copy = false): void {
    // No session yet: ask for one, and send once it's picked.
    if (!copy && this.needsSession(() => this.sendToAgent(ids))) return;
    const { data, written } = store.mutate(this.ctx.mdPath, (d) => {
      if (ids) {
        for (const id of ids) {
          const c = store.find(d, id);
          store.keepAgentDraft(d, id, this.ctx.author()); // acting on Claude's draft makes it yours
          if (c.status === 'draft') store.setStatus(d, id, 'submitted');
        }
      } else store.submitDrafts(d);
    });
    this.lastSidecarWrite = written;
    this.sendComments();
    const comments = data.comments.filter((c) => (ids ? ids.includes(c.id) : c.status === 'submitted'));
    if (!comments.length) {
      this.ctx.post({ type: 'toast', message: 'No open comments to send. Add a comment first.' });
      return;
    }
    // The copy the Changes view compares against, taken before the agent can start.
    const before = this.ctx.getText();
    const prompt = buildAgentPrompt({
      mdPath: this.ctx.mdPath,
      cwd: this.agentCwd(),
      comments,
      cliPath: this.cliPath(),
      suggest: this.ctx.suggestMode?.(),
      source: before,
    });
    const started = () => {
      // Only threads that are actually waiting on the agent count toward the round.
      const waiting = comments.filter((c) => store.awaitsAgent(c));
      const sent = waiting.map((c) => c.id);
      this.snapshot(waiting, before);
      // Ask on one thread (or a live send) while a round is still running adds to that round.
      if (ids && this.round && !this.round.summary) this.round.ids = [...new Set([...this.round.ids, ...sent])];
      else this.round = sent.length ? { ids: sent } : null;
      if (this.round) this.updateRound(data);
      else this.ctx.post({ type: 'round', round: null });
    };
    if (copy || !this.ctx.runAgent) {
      this.ctx.post({ type: 'agentPrompt', prompt, count: comments.length });
      return started();
    }
    this.hand(prompt, started);
  }

  /**
   * Give the prompt to runAgent, then run `started` if it was delivered. A
   * host that answers at once (tests, the clipboard) is handled at once.
   */
  private hand(prompt: string, started: () => void): void {
    const done = (status: string | null) => {
      // Nothing delivered (the host said why): nothing to follow.
      if (status === null) return;
      if (status) this.ctx.post({ type: 'toast', message: status });
      started();
    };
    let r: string | null | Promise<string | null>;
    try {
      r = this.ctx.runAgent!(prompt);
    } catch (e) {
      this.ctx.post({ type: 'error', message: String((e as Error)?.message || e) });
      return;
    }
    if (r instanceof Promise) {
      r.then(done, (e) => {
        this.ctx.post({ type: 'error', message: String((e as Error)?.message || e) });
        this.postAgent(); // the session may have gone: show it
      });
    } else done(r);
  }

  /**
   * True (and `then` kept for later) when there are sessions to choose from
   * but none is bound: the view opens the session menu.
   */
  private needsSession(then: () => void): boolean {
    const agents = this.ctx.agents;
    if (!agents || agents.binding()) return false;
    // One session started here with MD Review's hook: that's the one.
    let hooked: AgentSession[] = [];
    try {
      hooked = agents.list().filter((s) => s.live && s.connected);
    } catch {}
    if (hooked.length === 1) {
      const s = hooked[0];
      agents.bind({ agent: s.agent, id: s.id, name: s.name });
      this.postAgent();
      return false;
    }
    this.waiting = then;
    this.postAgent(true, true);
    return true;
  }

  /** The agent state for the view: the binding, and the session list when asked for. */
  private postAgent(list = false, ask = false): void {
    const agents = this.ctx.agents;
    if (!agents) return;
    const b = agents.binding();
    let bound: AgentState['bound'] = null;
    if (b) {
      const s = agents.state(b);
      bound = { ...b, name: s?.name ?? b.name, live: s?.live ?? false, status: s?.status };
    }
    let sessions: AgentSession[] | undefined;
    if (list) {
      try {
        sessions = agents.list();
      } catch {
        sessions = [];
      }
    }
    let connected: boolean | undefined;
    try {
      connected = agents.connected?.();
    } catch {}
    this.ctx.post({ type: 'agent', agent: { bound, delivery: agents.delivery(), sessions, ask: ask || undefined, starting: this.starting || undefined, connected } });
  }

  private bindTo(b: Binding | undefined): void {
    this.ctx.agents?.bind(b);
    this.postAgent();
    const then = this.waiting;
    this.waiting = null;
    if (b && then) then();
  }

  private startSession(agent: AgentKind, resume?: string): void {
    const agents = this.ctx.agents;
    if (!agents) return;
    const label = agent === 'codex' ? 'Codex' : 'Claude';
    this.starting = resume ? `Resuming ${label}…` : `Starting ${label}…`;
    this.postAgent();
    const failed = (e: unknown) => {
      this.starting = '';
      this.waiting = null;
      this.postAgent();
      this.ctx.post({ type: 'error', message: String((e as Error)?.message || e) });
    };
    agents
      .start(agent, resume)
      .then((b) => {
        this.starting = '';
        if (!b) {
          // Nothing started (the host said why): a Send waiting for it is dropped, not sent somewhere later.
          this.waiting = null;
          return this.postAgent();
        }
        this.bindTo(b);
      }, failed)
      .catch(failed);
  }

  /** Live delivery: comments saved within a moment of each other go as one message. */
  private queueLive(id: string): void {
    this.live.add(id);
    if (this.liveTimer) return;
    this.liveTimer = true;
    (this.ctx.schedule ?? ((fn, ms) => void setTimeout(fn, ms)))(() => {
      this.liveTimer = false;
      const ids = [...this.live];
      this.live.clear();
      if (ids.length) this.sendToAgent(ids);
    }, LIVE_COALESCE_MS);
  }

  private liveOn(): boolean {
    const a = this.ctx.agents;
    return !!a && !!this.ctx.runAgent && a.delivery() === 'live' && !!a.binding();
  }

  private agentCwd(): string {
    return this.ctx.agentCwd?.() ?? path.dirname(this.ctx.mdPath);
  }

  /**
   * The helper CLI for prompts: the workspace's copy (installed by Connect)
   * when it's the same version as ours, so no prompt is needed to run it. An
   * older copy may not know the commands the prompt asks for (apply), so ours
   * is used then, and the user is told once to connect again.
   */
  private cliPath(): string | undefined {
    const local = path.join(this.agentCwd(), '.claude', 'skills', 'md-review', 'mdreview.mjs');
    let mine: Buffer | undefined;
    try {
      mine = local !== this.ctx.cliPath ? fs.readFileSync(local) : undefined;
    } catch {}
    if (!mine) return this.ctx.cliPath;
    if (!this.ctx.cliPath) return local;
    try {
      shippedCli ??= { path: this.ctx.cliPath, bytes: fs.readFileSync(this.ctx.cliPath) };
      if (shippedCli.path !== this.ctx.cliPath) shippedCli = { path: this.ctx.cliPath, bytes: fs.readFileSync(this.ctx.cliPath) };
    } catch {
      return local;
    }
    if (mine.equals(shippedCli.bytes)) return local;
    if (!this.staleCliTold) {
      this.staleCliTold = true;
      this.ctx.post({ type: 'toast', message: "This folder's MD Review CLI is older than the extension's. Run Connect this folder again to update it." });
    }
    return this.ctx.cliPath;
  }

  /** Start Claude as first reviewer: it reads the file and leaves drafts for you to triage. */
  private startReview(id: string, instruction?: string): void {
    if (this.needsSession(() => this.startReview(id, instruction))) return;
    const cwd = this.agentCwd();
    // A workspace brief is read here, only for the reviewer picked.
    const preset = id === 'custom' ? { label: 'Custom', instructions: (instruction || '').trim().slice(0, 2000) } : findPreset(cwd, id);
    if (!preset || !preset.instructions) {
      this.ctx.post({ type: 'toast', message: id === 'custom' ? 'Type what Claude should look for first.' : "That reviewer's file is empty or no longer there." });
      return;
    }
    let existing = 0;
    try {
      existing = store.readSidecar(this.ctx.mdPath).comments.filter((c) => c.status !== 'resolved').length;
    } catch {} // a broken sidecar is reported by sendComments
    const max = Math.max(1, Math.min(50, Math.round(this.ctx.reviewComments?.() ?? 12)));
    const run = crypto.randomBytes(4).toString('hex');
    const prompt = buildReviewPrompt({ mdPath: this.ctx.mdPath, cwd, preset, max, cliPath: this.cliPath(), existing, run });
    const since = store.now();
    const started = () => {
      // A Send round still running keeps its own banner.
      this.review = { run, since, max, ids: new Set(), finished: false };
      this.sendComments();
    };
    if (!this.ctx.runAgent) {
      this.ctx.post({ type: 'agentPrompt', prompt, count: 0, review: preset.label });
      return started();
    }
    this.hand(prompt, started);
  }

  /**
   * On Send: save the copy the Changes view compares against, the text as
   * you see it (see redlines.sendBaseline).
   */
  private snapshot(comments: store.Comment[], text: string): void {
    if (!comments.length) return;
    const cur = this.baselines().get();
    const next = redlines.sendBaseline(cur, () => {
      const v = this.view(cur!);
      if (!v) return undefined;
      return this.differs(cur!, text) ? redlines.diffBlocks(v.text, text, this.blocks(v), this.blocksFor(text)) : null;
    }, comments, text);
    if (!next) {
      this.ctx.post({ type: 'toast', message: 'This file is over 4 MB, so no copy was saved for the Changes view.' });
      return;
    }
    if (next.bytes) {
      const t = redlines.normText(text);
      // The text was just rendered: its blocks are known.
      const blocks = this.lastParse && redlines.normText(this.lastParse.text) === t ? this.blocksFor(text) : undefined;
      this.baseView = { id: next.baseline.id, bytes: next.bytes, text: t, blocks };
    }
    this.setBaseline(next.baseline, next.bytes);
    this.postChanges();
  }

  /**
   * Claude was sent this file's threads from outside the panel (a folder's
   * reviews, the inbox's Send All): save the copy a Send here would, `text`
   * being the file as it was before Claude started.
   */
  snapshotSent(comments: store.Comment[], text: string): void {
    this.snapshot(comments.filter((c) => store.awaitsAgent(c)), text);
  }

  /** Let go of what the Changes view needed: its rendered baseline (and on Accept all, the baseline itself). */
  private dropChanges(all = false): void {
    if (all) this.baseView = null;
    else if (this.baseView) this.baseView.html = undefined;
    this.hunks = null;
    this.sent = { id: '', missing: [] };
  }

  /** Block editing works on disk bytes, so the view must reflect the disk. */
  private assertEditable(): void {
    if (this.ctx.isDirty()) {
      throw new Error('This file has unsaved changes in another editor. Save or revert them before editing blocks here.');
    }
    const disk = fs.readFileSync(this.ctx.mdPath, 'utf8').replace(/^﻿/, '');
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    if (norm(disk) !== norm(this.lastRendered ?? '')) {
      // handle() repaints from disk when it catches this
      throw new BlockEditError('The file changed on disk; the view was refreshed. Double-click the block again.');
    }
  }
}
