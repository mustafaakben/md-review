// Host-side message handling, independent of the VS Code API so the same code
// drives both the extension and the browser test harness.
import * as fs from 'fs';
import * as path from 'path';
import * as store from './commentStore';
import { applyBlockEdit, readBlock, toggleTask, spliceLines, BlockEditError } from './blockEdit';
import { renderTokens, RenderEnv, ResolveImage } from './render';
import { applyInlineEdit, InlineMapError, BlockKind } from './inlineEdit';
import { EditHistory, HistoryError } from './editHistory';
import { buildAgentPrompt } from './agentPrompt';
import * as redlines from './redlines';

/** What the Changes view paints: the hunks against the current baseline. `v` names this comparison. */
export interface Changes {
  v: string;
  at: string;
  /** The baseline rendered, sent once per baseline (the view keeps it). */
  baseHtml?: string;
  baseId: string;
  hunks: redlines.Hunk[];
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
  | { type: 'agentPrompt'; prompt: string; count: number }
  | { type: 'prefs'; prefs: Record<string, unknown> }
  | { type: 'round'; round: Round | null }
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
  | { type: 'dismissRound' }
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
  /** Re-render when any of these files (the bibliography) changes. */
  watchFiles?(files: string[]): void;
  /**
   * Hand the prompt to an agent (e.g. start Claude Code in a terminal). Returns
   * a status line for the user. When absent, the prompt goes back to the
   * webview, which copies it to the clipboard.
   */
  runAgent?(prompt: string): string;
  /** Working directory for the agent; defaults to the Markdown file's folder. */
  agentCwd?(): string;
  /** Per-user view preferences (reading theme, zoom), shared by every file. */
  getPrefs?(): Record<string, unknown>;
  setPrefs?(prefs: Record<string, unknown>): void;
  /** Absolute path to cli/mdreview.mjs, if available. */
  cliPath?: string;
  /** Tell the user something happened while they may be looking elsewhere (the view isn't focused). */
  notify?(message: string): void;
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

export class ReviewSession {
  private lastSidecarWrite: string | undefined;
  private lastRendered = '';
  private watched = '';
  private history = new EditHistory();
  /** The suggestion the last recorded edit applied, so Undo can reopen it. */
  private lastApply: { id: string; from?: string; status: store.Status } | null = null;
  /** The threads of the last Send to Claude; once finished, the summary stays as it was until dismissed. */
  private round: { ids: string[]; summary?: Round } | null = null;
  private bases: redlines.Baselines | undefined;
  /** The Changes view is on, so every render carries the hunks. */
  private changesOn = false;
  /** The baseline's text, and (once the Changes view needs them) its HTML and blocks. */
  private baseView: { id: string; text: string; html?: string; blocks?: redlines.Block[] } | null = null;
  private sentBaseId = '';
  private hunks: { v: string; baseId: string; list: redlines.Hunk[] } | null = null;
  private lastInfo = '';
  /** The current text's blocks, from the last render's own parse. */
  private curBlocks: { text: string; blocks: redlines.Block[] } | null = null;

  constructor(private ctx: HostContext) {}

  render(): void {
    const text = this.ctx.getText();
    this.lastRendered = text;
    let html: string;
    const env: RenderEnv = { docDir: path.dirname(this.ctx.mdPath) };
    try {
      const r = renderTokens(text, this.ctx.resolveImage, env);
      html = r.html;
      this.curBlocks = this.changesOn ? { text, blocks: redlines.blocksOfTokens(r.tokens) } : null;
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

  private differs(b: redlines.Baseline, text = this.lastRendered): boolean {
    return this.view(b).text.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n');
  }

  private view(b: redlines.Baseline) {
    if (this.baseView?.id !== b.id) this.baseView = { id: b.id, text: redlines.baselineText(b) };
    return this.baseView;
  }

  private blocks(b: redlines.Baseline): redlines.Block[] {
    const v = this.view(b);
    return (v.blocks ||= redlines.blocksOf(v.text));
  }

  private baseHtml(b: redlines.Baseline): string {
    const v = this.view(b);
    if (v.html === undefined) {
      try {
        const r = renderTokens(v.text, this.ctx.resolveImage, { docDir: path.dirname(this.ctx.mdPath) });
        v.html = r.html;
        v.blocks ||= redlines.blocksOfTokens(r.tokens);
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
    const html = this.sentBaseId !== cur.id ? this.baseHtml(cur) : undefined; // renders and splits the baseline in one parse
    if (this.curBlocks?.text !== this.lastRendered) this.curBlocks = { text: this.lastRendered, blocks: redlines.blocksOf(this.lastRendered) };
    const list = redlines.diffBlocks(this.view(cur).text, this.lastRendered, this.blocks(cur), this.curBlocks.blocks);
    const v = redlines.sha1(cur.id + '\0' + this.lastRendered);
    this.hunks = { v, baseId: cur.id, list };
    this.sentBaseId = cur.id;
    return { v, at: cur.at, baseId: cur.id, baseHtml: html, hunks: list };
  }

  private postChanges(): void {
    if (this.changesOn) this.ctx.post({ type: 'changes', changes: this.changes() });
  }

  /** Revert copies the baseline's lines over the file's; Keep copies the file's into the baseline. */
  private settleChange(revert: boolean, v: string, i: number): void {
    const cur = this.baselines().current;
    const h = this.hunks && this.hunks.v === v && cur && this.hunks.baseId === cur.id ? this.hunks.list[i] : undefined;
    if (!cur || !h) {
      this.render();
      throw new Error('The file or its baseline changed since these changes were shown, so nothing was written. The view has been refreshed.');
    }
    const base = redlines.baselineBytes(cur);
    if (revert) {
      this.assertEditable(); // refuses if the file changed on disk since this render
      this.recorded(() => fs.writeFileSync(this.ctx.mdPath, spliceLines(fs.readFileSync(this.ctx.mdPath), h.c[0], h.c[1], base, h.b[0], h.b[1])));
      this.ctx.post({ type: 'toast', message: 'Reverted that change. Undo brings it back.' });
      this.render();
      return;
    }
    const next = spliceLines(base, h.b[0], h.b[1], Buffer.from(this.lastRendered, 'utf8'), h.c[0], h.c[1]);
    this.setBaselines({ ...this.baselines(), current: { ...cur, id: redlines.sha1(next), data: next.toString('base64') } });
    this.postChanges();
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
      if (base && disk !== undefined && this.differs(base, disk)) round.changes = redlines.changedBlocks(redlines.diffBlocks(this.view(base).text, disk, this.blocks(base)));
      this.ctx.notify?.(`Claude finished ${path.basename(this.ctx.mdPath)}: ${roundSummary(round)}.`);
      this.round.summary = round;
    }
    this.ctx.post({ type: 'round', round: round.total ? round : null });
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
      if (e instanceof BlockEditError) this.render();
      this.ctx.post({ type: 'error', message: String(e?.message || e) });
    }
  }

  private handleInner(msg: FromWebview): void {
    const author = this.ctx.author();
    switch (msg.type) {
      case 'ready':
        this.sentBaseId = ''; // a new view has no baseline yet
        this.lastInfo = 'null'; // and knows of none
        this.render();
        this.sendComments();
        this.postHistory();
        if (this.ctx.getPrefs) this.ctx.post({ type: 'prefs', prefs: this.ctx.getPrefs() });
        return;
      case 'addComment':
        return this.mutate((d) => {
          const c = store.addComment(d, author, msg.anchor, msg.body, msg.meta);
          if (typeof msg.suggestion === 'string' && c.scope === undefined) c.suggestion = { text: msg.suggestion };
        });
      case 'applySuggestion':
        this.assertEditable();
        try {
          this.recorded(() => applyInlineEdit(this.ctx.mdPath, msg.ls, msg.le, msg.kind, msg.oldText, msg.newText));
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
          const s = store.suggestionOf(c, msg.from);
          this.lastApply = { id: msg.id, from: msg.from, status: c.status };
          if (s) s.appliedAt = store.now();
          if (c.status !== 'resolved') store.setStatus(d, msg.id, 'resolved');
        });
        this.ctx.post({ type: 'blockSaved', ls: msg.ls });
        this.render();
        return;
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
        this.recorded(() => applyBlockEdit(this.ctx.mdPath, msg.ls, msg.le, msg.original, msg.newText));
        this.ctx.post({ type: 'blockSaved', ls: msg.ls });
        this.render();
        return;
      case 'saveInline':
        this.assertEditable();
        try {
          this.recorded(() => applyInlineEdit(this.ctx.mdPath, msg.ls, msg.le, msg.kind, msg.oldText, msg.newText));
        } catch (e) {
          if (e instanceof InlineMapError) {
            this.ctx.post({ type: 'inlineFailed', ls: msg.ls, le: msg.le, text: e.source, message: e.message });
            return;
          }
          throw e;
        }
        this.ctx.post({ type: 'blockSaved', ls: msg.ls });
        this.render();
        return;
      case 'openLink':
        this.ctx.openLink(msg.href);
        return;
      case 'toggleTask':
        try {
          this.assertEditable();
          this.recorded(() => toggleTask(this.ctx.mdPath, msg.line, msg.checked, msg.key));
        } finally {
          this.render(); // the webview repaints even if the HTML is unchanged, so a refused click is undone
        }
        return;
      case 'undo':
      case 'redo':
        return this.undoRedo(msg.type);
      case 'sendToAgent':
        return this.sendToAgent(msg.id);
      case 'dismissRound':
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
    }
  }

  /** Run a file edit and remember it for undo. */
  private recorded(write: () => unknown): void {
    this.lastApply = null;
    const before = fs.readFileSync(this.ctx.mdPath);
    write();
    this.history.record(before, fs.readFileSync(this.ctx.mdPath));
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
    let next: Buffer;
    try {
      next = which === 'undo' ? this.history.undo(cur) : this.history.redo(cur);
    } catch (e) {
      if (e instanceof HistoryError) this.postHistory();
      throw e;
    }
    fs.writeFileSync(this.ctx.mdPath, next);
    this.postHistory();
    // Undoing an applied suggestion puts the thread back the way it was.
    const applied = which === 'undo' ? this.lastApply : null;
    this.lastApply = null;
    if (applied) {
      try {
        this.mutate((d) => {
          const c = store.find(d, applied.id);
          const s = store.suggestionOf(c, applied.from);
          if (s) delete s.appliedAt;
          if (c.status !== applied.status) store.setStatus(d, applied.id, applied.status);
        });
      } catch {
        // the thread is gone; the text is back regardless
      }
    }
    this.ctx.post({ type: 'toast', message: which === 'undo' ? 'Undid the last edit.' : 'Redid the edit.' });
    this.render();
  }

  /**
   * Submit what's pending and hand the open threads to an agent. With an id,
   * only that thread is sent (and submitted if it was a draft).
   */
  private sendToAgent(id?: string): void {
    const { data, written } = store.mutate(this.ctx.mdPath, (d) => {
      if (id) {
        const c = store.find(d, id);
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
    // Only threads that are actually waiting on the agent count toward the round.
    const ids = comments.filter((c) => store.awaitsAgent(c)).map((c) => c.id);
    this.snapshot(ids);
    // Ask Claude on one thread while a round is still running adds to that round.
    if (id && this.round && !this.round.summary) this.round.ids = [...new Set([...this.round.ids, ...ids])];
    else this.round = ids.length ? { ids } : null;
    if (this.round) this.updateRound(data);
    else this.ctx.post({ type: 'round', round: null });
    const prompt = buildAgentPrompt({
      mdPath: this.ctx.mdPath,
      cwd: this.ctx.agentCwd?.() ?? path.dirname(this.ctx.mdPath),
      comments,
      cliPath: this.ctx.cliPath,
      suggest: this.ctx.suggestMode?.(),
    });
    if (this.ctx.runAgent) this.ctx.post({ type: 'toast', message: this.ctx.runAgent(prompt) });
    else this.ctx.post({ type: 'agentPrompt', prompt, count: comments.length });
  }

  /** Save the baseline the Changes view compares against (see redlines.onSend). */
  private snapshot(ids: string[]): void {
    if (!ids.length) return;
    let disk: Buffer;
    try {
      disk = fs.readFileSync(this.ctx.mdPath);
    } catch {
      return;
    }
    if (disk.length > redlines.MAX_BASELINE_BYTES) return;
    this.setBaselines(redlines.onSend(this.baselines(), disk, ids));
  }

  /** Block editing works on disk bytes, so the view must reflect the disk. */
  private assertEditable(): void {
    if (this.ctx.isDirty()) {
      throw new Error('This file has unsaved changes in another editor. Save or revert them before editing blocks here.');
    }
    const disk = fs.readFileSync(this.ctx.mdPath, 'utf8').replace(/^﻿/, '');
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    if (norm(disk) !== norm(this.lastRendered)) {
      this.render();
      throw new BlockEditError('The file changed on disk; the view was refreshed. Double-click the block again.');
    }
  }
}
