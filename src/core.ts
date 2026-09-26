// Host-side message handling, independent of the VS Code API so the same code
// drives both the extension and the browser test harness.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as store from './commentStore';
import { applyBlockEdit, readBlock, toggleTask, spliceLines, BlockEditError } from './blockEdit';
import { renderParsed, rendererFor, RenderEnv, ResolveImage } from './render';
import { applyInlineEdit, InlineMapError, BlockKind, RenderedParse } from './inlineEdit';
import { EditHistory, HistoryError } from './editHistory';
import { buildAgentPrompt } from './agentPrompt';
import { buildReviewPrompt, findPreset, listReviewers } from './reviewPresets';
import * as redlines from './redlines';

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
}

export type ToWebview =
  | { type: 'render'; html: string; fileName: string; changes?: Changes | null }
  | { type: 'changes'; changes: Changes | null }
  | { type: 'baseline'; info: BaselineInfo | null }
  | { type: 'comments'; data: store.Sidecar; author: string; showResolved: boolean }
  | { type: 'block'; ls: number; le: number; text: string }
  | { type: 'blockSaved'; ls: number }
  | { type: 'inlineFailed'; ls: number; le: number; text: string; message: string }
  | { type: 'history'; canUndo: boolean; canRedo: boolean }
  | { type: 'toast'; message: string }
  | { type: 'agentPrompt'; prompt: string; count: number; review?: string }
  | { type: 'reviewers'; presets: { id: string; label: string; path?: string }[] }
  | { type: 'prefs'; prefs: Record<string, unknown> }
  | { type: 'round'; round: Round | null }
  | { type: 'review'; review: ReviewRun | null }
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
  | { type: 'showChanges'; on: boolean }
  /** Revert or keep hunk `i` of the comparison `v`. */
  | { type: 'revertChange'; v: string; i: number }
  | { type: 'keepChange'; v: string; i: number }
  | { type: 'acceptChanges' };

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
   * Hand the prompt to an agent (e.g. start Claude Code in a terminal). Returns
   * a status line for the user ('' when it already told them), or null when no
   * agent was started. When absent, the prompt goes back to the webview, which
   * copies it to the clipboard.
   */
  runAgent?(prompt: string): string | null;
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
  /** Where Changes baselines are kept (workspace storage in VS Code). In memory when absent. */
  baselines?: { load(): redlines.Baselines | undefined; save(b: redlines.Baselines): void };
}

function readText(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 resolved, 1 suggested edit and 1 question for you" */
export function roundSummary(r: Round): string {
  const yours = [r.suggestions && count(r.suggestions, 'suggested edit', 'suggested edits'), r.questions && count(r.questions, 'question', 'questions')].filter(Boolean);
  return `${r.resolved} resolved${yours.length ? `, ${yours.join(' and ')} for you` : ''}`;
}

/**
 * A suggestion an edit applied, and the thread's state before it: its status,
 * and who it belonged to when it was an agent's untriaged draft (applying keeps it).
 */
/**
 * The baseline's text, and once needed its HTML and blocks. `shift`: how its
 * lines moved since the one the view was sent (`from`), and the lines it adds.
 */
interface BaseView {
  id: string;
  text: string;
  html?: string;
  blocks?: redlines.Block[];
  shift?: { from: string; steps: BaseStep[]; dirty: [number, number][] };
}

interface Applied { id: string; from?: string; status: store.Status; agent?: { author: string; suggestedBy?: string } }

/** Kept with an undo entry: the suggestion it applied, or that it was your own edit (see foldIntoBaseline). */
interface EditTag { applied?: Applied; yours?: boolean }
const YOURS: EditTag = { yours: true };

export class ReviewSession {
  private lastSidecarWrite: string | undefined;
  private lastRendered: string | undefined;
  private watched = '';
  private lastParse: RenderedParse | undefined;
  private history = new EditHistory();
  /** The threads of the last Send to Claude; once finished, the summary stays as it was until dismissed. */
  private round: { ids: string[]; summary?: Round } | null = null;
  /** A Review with Claude run: when it started, its cap, and the drafts seen so far. Independent of the round. */
  private review: { run: string; since: string; max: number; ids: Set<string>; finished: boolean } | null = null;
  private bases: redlines.Baselines | undefined;
  /** The Changes view is on, so every render carries the hunks. */
  private changesOn = false;
  /** The baseline's text, and (once the Changes view needs them) its HTML and blocks. */
  private baseView: BaseView | null = null;
  /** The baseline the view has, and the lines its copy lacks (added by Keep or your edits since it was sent). */
  private sent: { id: string; missing: [number, number][] } = { id: '', missing: [] };
  private hunks: { v: string; baseId: string; list: redlines.Hunk[] } | null = null;
  private lastInfo = '';
  /** The blocks of the last render's parse. */
  private curBlocks: { tokens: unknown; blocks: redlines.Block[] } | null = null;

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
    let html: string;
    const env: RenderEnv = { docDir: path.dirname(this.ctx.mdPath), bibRoots: this.ctx.readableRoots?.() };
    this.lastParse = undefined;
    try {
      const r = renderParsed(text, this.ctx.resolveImage, env);
      html = r.html;
      this.lastParse = { text, ...r.parse };
    } catch (e: any) {
      html = `<pre class="mdr-error">Render failed: ${String(e?.message || e)}</pre>`;
    }
    const bibs = (env.bibFiles || []).join('\n');
    if (bibs !== this.watched) {
      this.watched = bibs;
      this.ctx.watchFiles?.(env.bibFiles || []);
    }
    let changes: Changes | null | undefined;
    try {
      if (this.changesOn) changes = this.changes();
    } catch {
      changes = null; // a text the parser rejects: show no redlines rather than fail the render
    }
    this.ctx.post({ type: 'render', html, fileName: path.basename(this.ctx.mdPath), changes });
    this.syncHistory();
    this.postBaseline();
  }

  /** Read through the hook each time, so two views of one file agree. */
  private baselines(): redlines.Baselines {
    return (this.ctx.baselines ? this.ctx.baselines.load() : this.bases) ?? { current: null, past: [] };
  }

  private setBaselines(b: redlines.Baselines): void {
    if (this.ctx.baselines) this.ctx.baselines.save(b);
    else this.bases = b;
    this.postBaseline();
  }

  private postBaseline(): void {
    const cur = this.baselines().current;
    const info: BaselineInfo | null = cur ? { at: cur.at, threads: cur.threads, changed: this.differs(cur) } : null;
    const key = JSON.stringify(info);
    if (key === this.lastInfo) return;
    this.lastInfo = key;
    this.ctx.post({ type: 'baseline', info });
  }

  private differs(b: redlines.Baseline, text = this.lastRendered ?? ''): boolean {
    return this.view(b).text.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n');
  }

  private view(b: redlines.Baseline): BaseView {
    if (this.baseView?.id !== b.id) this.baseView = { id: b.id, text: redlines.baselineText(b) };
    return this.baseView;
  }

  /** A text's blocks: from the last render's parse when it's that text, else parsed (not rendered) by the session's renderer. */
  private blocksFor(text: string): redlines.Block[] {
    const p = this.lastParse;
    if (p?.text !== text) return redlines.blocksOfTokens(rendererFor(this.ctx.resolveImage).parse(text, {}));
    if (this.curBlocks?.tokens !== p.tokens) this.curBlocks = { tokens: p.tokens, blocks: redlines.blocksOfTokens(p.tokens) };
    return this.curBlocks.blocks;
  }

  private blocks(b: redlines.Baseline): redlines.Block[] {
    const v = this.view(b);
    return (v.blocks ||= this.blocksFor(v.text));
  }

  private baseHtml(b: redlines.Baseline): string {
    const v = this.view(b);
    if (v.html === undefined) {
      try {
        const r = renderParsed(v.text, this.ctx.resolveImage, { docDir: path.dirname(this.ctx.mdPath) });
        v.html = r.html;
        v.blocks ||= redlines.blocksOfTokens(r.parse.tokens);
      } catch (e: any) {
        v.html = `<pre class="mdr-error">Render failed: ${String(e?.message || e).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</pre>`;
      }
    }
    return v.html;
  }

  /** The hunks of the current text against the baseline, remembered so Revert and Keep can name one by index. */
  private changes(): Changes | null {
    const cur = this.baselines().current;
    if (!cur) {
      this.hunks = null;
      return null;
    }
    const text = this.lastRendered ?? '';
    const list = redlines.diffBlocks(this.view(cur).text, text, this.blocks(cur), this.blocksFor(text));
    const v = redlines.sha1(cur.id + '\0' + text);
    this.hunks = { v, baseId: cur.id, list };
    const ch: Changes = { v, at: cur.at, baseId: cur.id, hunks: list };
    // The view renumbers the baseline it has, unless a change shows lines its copy lacks.
    const lacks = (missing: [number, number][]) => list.some((h) => h.base && missing.some(([lo, hi]) => h.base!.ls < hi && h.base!.le > lo));
    const sh = this.view(cur).shift;
    if (this.sent.id === cur.id ? lacks(this.sent.missing) : !sh || sh.from !== this.sent.id || lacks(sh.dirty)) {
      ch.baseHtml = this.baseHtml(cur);
      this.sent = { id: cur.id, missing: [] };
    } else if (sh && this.sent.id !== cur.id) {
      ch.baseShift = { from: sh.from, steps: sh.steps };
      this.sent = { id: cur.id, missing: sh.dirty };
    }
    this.view(cur).shift = undefined;
    return ch;
  }

  private postChanges(): void {
    if (this.changesOn) this.ctx.post({ type: 'changes', changes: this.changes() });
  }

  /**
   * Copy lines c of `src` over lines b of the baseline (Keep, or your own
   * edit). The rendered baseline isn't redone: the view is told how its lines moved.
   */
  private patchBaseline(cur: redlines.Baseline, b: [number, number], src: Buffer, c: [number, number]): void {
    const next = spliceLines(redlines.baselineBytes(cur), b[0], b[1], src, c[0], c[1]);
    const id = redlines.sha1(next);
    if (id === cur.id) return;
    const n = c[1] - c[0];
    const step = { lo: b[0], at: b[1], delta: n - (b[1] - b[0]) };
    const old = this.baseView?.id === cur.id ? this.baseView : null;
    const prev = old && (old.shift ?? (this.sent.id === cur.id ? { from: cur.id, steps: [], dirty: this.sent.missing } : undefined));
    // Lines the view's copy doesn't have, renumbered for this step.
    const move = ([lo, hi]: [number, number]): [number, number] =>
      lo >= step.at ? [lo + step.delta, hi + step.delta] : hi <= step.lo ? [lo, hi] : [Math.min(lo, step.lo), Math.max(hi >= step.at ? hi + step.delta : 0, step.lo + n)];
    const dirty = prev ? prev.dirty.map(move) : [];
    const data = next.toString('base64');
    this.baseView = { id, text: redlines.baselineText({ ...cur, data }), shift: prev ? { from: prev.from, steps: [...prev.steps, step], dirty: [...dirty, [b[0], b[0] + n]] } : undefined };
    this.setBaselines({ ...this.baselines(), current: { ...cur, id, data } });
  }

  /** Revert copies the baseline's lines over the file's; Keep copies the file's into the baseline. */
  private settleChange(revert: boolean, v: string, i: number): void {
    const cur = this.baselines().current;
    const h = this.hunks && this.hunks.v === v && cur && this.hunks.baseId === cur.id ? this.hunks.list[i] : undefined;
    if (!cur || !h) {
      this.render();
      throw new Error('The file or its baseline changed since these changes were shown, so nothing was written. The view has been refreshed.');
    }
    if (revert) {
      this.assertEditable(); // refuses if the file changed on disk since this render
      const base = redlines.baselineBytes(cur);
      this.recorded(() => fs.writeFileSync(this.ctx.mdPath, spliceLines(fs.readFileSync(this.ctx.mdPath), h.c[0], h.c[1], base, h.b[0], h.b[1])));
      this.ctx.post({ type: 'toast', message: 'Reverted that change. Undo brings it back.' });
      this.render();
      return;
    }
    this.patchBaseline(cur, h.b, Buffer.from(this.lastRendered ?? '', 'utf8'), h.c);
    this.postChanges();
  }

  /**
   * An edit you made in the view is yours, not Claude's: make it in the
   * baseline too, so it doesn't show as a change. Only where Claude left the
   * text alone; an edit inside Claude's change stays part of that change.
   */
  private foldIntoBaseline(before: Buffer, after: Buffer): void {
    const cur = this.baselines().current;
    if (!cur) return;
    try {
      const bt = before.toString('utf8').replace(/^﻿/, '');
      const bl = bt.replace(/\r\n/g, '\n').split('\n');
      const al = after.toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
      let p = 0;
      while (p < bl.length && p < al.length && bl[p] === al[p]) p++;
      let s = 0;
      while (s < bl.length - p && s < al.length - p && bl[bl.length - 1 - s] === al[al.length - 1 - s]) s++;
      const e = bl.length - s; // lines [p, e) of before became [p, al.length - s) of after
      const base = this.view(cur).text;
      let shift = 0;
      for (const h of redlines.diffBlocks(base, bt, this.blocks(cur), this.blocksFor(bt))) {
        if (h.c[1] <= p) shift += h.b[1] - h.b[0] - (h.c[1] - h.c[0]);
        else if (h.c[0] < e || (h.c[0] < p && p < h.c[1])) return; // inside Claude's change
      }
      const bp = p + shift;
      const bb = base.replace(/\r\n/g, '\n').split('\n');
      if (bb.slice(bp, bp + e - p).join('\n') !== bl.slice(p, e).join('\n')) return;
      this.patchBaseline(cur, [bp, bp + e - p], after, [p, al.length - s]);
    } catch {
      // the baseline stays as it was; the edit shows as a change
    }
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
      this.ctx.post({ type: 'error', message: `Could not parse ${path.basename(store.sidecarPath(this.ctx.mdPath))}: ${e.message}` });
      return;
    }
    this.ctx.post({ type: 'comments', data, author: this.ctx.author(), showResolved: this.ctx.showResolved() });
    this.updateRound(data);
    this.updateReview(data);
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
      const base = this.baselines().current;
      const disk = base ? readText(this.ctx.mdPath) : undefined;
      if (base && disk !== undefined && this.differs(base, disk)) round.changes = redlines.changedBlocks(redlines.diffBlocks(this.view(base).text, disk, this.blocks(base), this.blocksFor(disk)));
      this.ctx.notify?.(`Claude finished ${path.basename(this.ctx.mdPath)}: ${roundSummary(round)}.`);
      this.round.summary = round;
    }
    this.ctx.post({ type: 'round', round: round.total ? round : null });
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

  /** Called by a file watcher when the sidecar changes on disk. */
  onSidecarChanged(): void {
    let current: string | undefined;
    try {
      current = fs.readFileSync(store.sidecarPath(this.ctx.mdPath), 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== undefined && current === this.lastSidecarWrite) return; // our own write
    this.sendComments();
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
        // Document last, so the view paints once with its look and comments.
        if (this.ctx.getPrefs) this.ctx.post({ type: 'prefs', prefs: this.ctx.getPrefs() });
        this.sendComments();
        this.postHistory();
        this.render(true);
        return;
      case 'addComment':
        return this.mutate((d) => {
          const c = store.addComment(d, author, msg.anchor, msg.body, msg.meta);
          if (typeof msg.suggestion === 'string' && c.scope === undefined) c.suggestion = { text: msg.suggestion };
        });
      case 'applySuggestion': {
        this.assertEditable();
        // Kept with the undo entry, so Undo and Redo move the thread along with the text.
        const applied: Applied = { id: msg.id, from: msg.from, status: 'submitted' };
        try {
          this.recorded(() => applyInlineEdit(this.ctx.mdPath, msg.ls, msg.le, msg.kind, msg.oldText, msg.newText, this.lastParse), { applied });
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
      case 'reply':
        return this.mutate((d) => void store.addReply(d, msg.id, author, msg.body));
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
        return this.sendToAgent(msg.id);
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
        return this.postChanges();
      case 'revertChange':
      case 'keepChange':
        return this.settleChange(msg.type === 'revertChange', msg.v, msg.i);
      case 'acceptChanges':
        this.setBaselines(redlines.accept(this.baselines()));
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
    }
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
   * Submit what's pending and hand the open threads to an agent. With an id,
   * only that thread is sent (and submitted if it was a draft).
   */
  private sendToAgent(id?: string): void {
    const { data, written } = store.mutate(this.ctx.mdPath, (d) => {
      if (id) {
        const c = store.find(d, id);
        store.keepAgentDraft(d, id, this.ctx.author()); // acting on Claude's draft makes it yours
        if (c.status === 'draft') store.setStatus(d, id, 'submitted');
      } else store.submitDrafts(d);
    });
    this.lastSidecarWrite = written;
    this.sendComments();
    const comments = data.comments.filter((c) => (id ? c.id === id : c.status === 'submitted'));
    if (!comments.length) {
      this.ctx.post({ type: 'toast', message: 'No open comments to send. Add a comment first.' });
      return;
    }
    // The copy the Changes view compares against, read before Claude can start.
    let before: Buffer | undefined;
    try {
      before = fs.readFileSync(this.ctx.mdPath);
    } catch {}
    const prompt = buildAgentPrompt({
      mdPath: this.ctx.mdPath,
      cwd: this.ctx.agentCwd?.() ?? path.dirname(this.ctx.mdPath),
      comments,
      cliPath: this.ctx.cliPath,
      suggest: this.ctx.suggestMode?.(),
    });
    if (this.ctx.runAgent) {
      const status = this.ctx.runAgent(prompt);
      // Nothing started (the host said why): no round to follow.
      if (status === null) return;
      if (status) this.ctx.post({ type: 'toast', message: status });
    } else this.ctx.post({ type: 'agentPrompt', prompt, count: comments.length });
    // Only threads that are actually waiting on the agent count toward the round.
    const ids = comments.filter((c) => store.awaitsAgent(c)).map((c) => c.id);
    if (before) this.snapshot(ids, before);
    // Ask Claude on one thread while a round is still running adds to that round.
    if (id && this.round && !this.round.summary) this.round.ids = [...new Set([...this.round.ids, ...ids])];
    else this.round = ids.length ? { ids } : null;
    if (this.round) this.updateRound(data);
    else this.ctx.post({ type: 'round', round: null });
  }

  private agentCwd(): string {
    return this.ctx.agentCwd?.() ?? path.dirname(this.ctx.mdPath);
  }

  /** Start Claude as first reviewer: it reads the file and leaves drafts for you to triage. */
  private startReview(id: string, instruction?: string): void {
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
    const prompt = buildReviewPrompt({ mdPath: this.ctx.mdPath, cwd, preset, max, cliPath: this.ctx.cliPath, existing, run });
    const since = store.now();
    if (this.ctx.runAgent) {
      const status = this.ctx.runAgent(prompt);
      // Nothing started (the host said why): no review to follow.
      if (status === null) return;
      if (status) this.ctx.post({ type: 'toast', message: status });
    } else this.ctx.post({ type: 'agentPrompt', prompt, count: 0, review: preset.label });
    // A Send to Claude round still running keeps its own banner.
    this.review = { run, since, max, ids: new Set(), finished: false };
    this.sendComments();
  }

  /** Save the baseline the Changes view compares against (see redlines.onSend). */
  private snapshot(ids: string[], disk: Buffer): void {
    if (!ids.length || disk.length > redlines.MAX_BASELINE_BYTES) return;
    this.setBaselines(redlines.onSend(this.baselines(), disk, ids));
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
