// Host-side message handling, independent of the VS Code API so the same code
// drives both the extension and the browser test harness.
import * as fs from 'fs';
import * as path from 'path';
import * as store from './commentStore';
import { applyBlockEdit, readBlock, toggleTask, BlockEditError } from './blockEdit';
import { renderMarkdown, RenderEnv, ResolveImage } from './render';
import { applyInlineEdit, InlineMapError, BlockKind } from './inlineEdit';
import { EditHistory, HistoryError } from './editHistory';
import { buildAgentPrompt } from './agentPrompt';

export type ToWebview =
  | { type: 'render'; html: string; fileName: string }
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
  | { type: 'dismissRound' };

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
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 resolved, 1 suggested edit and 1 question for you" */
export function roundSummary(r: Round): string {
  const yours = [r.suggestions && count(r.suggestions, 'suggested edit', 'suggested edits'), r.questions && count(r.questions, 'question', 'questions')].filter(Boolean);
  return `${r.resolved} resolved${yours.length ? `, ${yours.join(' and ')} for you` : ''}`;
}

/** A suggestion an edit applied, and the thread's status before it. */
interface Applied { id: string; from?: string; status: store.Status }

export class ReviewSession {
  private lastSidecarWrite: string | undefined;
  private lastRendered: string | undefined;
  private watched = '';
  private history = new EditHistory();
  /** The threads of the last Send to Claude; once finished, the summary stays as it was until dismissed. */
  private round: { ids: string[]; summary?: Round } | null = null;

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
    const env: RenderEnv = { docDir: path.dirname(this.ctx.mdPath) };
    try {
      html = renderMarkdown(text, this.ctx.resolveImage, env);
    } catch (e: any) {
      html = `<pre class="mdr-error">Render failed: ${String(e?.message || e)}</pre>`;
    }
    const bibs = (env.bibFiles || []).join('\n');
    if (bibs !== this.watched) {
      this.watched = bibs;
      this.ctx.watchFiles?.(env.bibFiles || []);
    }
    this.ctx.post({ type: 'render', html, fileName: path.basename(this.ctx.mdPath) });
    this.syncHistory();
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
      if (e instanceof BlockEditError) this.render(true);
      this.ctx.post({ type: 'error', message: String(e?.message || e) });
    }
  }

  private handleInner(msg: FromWebview): void {
    const author = this.ctx.author();
    switch (msg.type) {
      case 'ready':
        this.render(true);
        this.sendComments();
        this.postHistory();
        if (this.ctx.getPrefs) this.ctx.post({ type: 'prefs', prefs: this.ctx.getPrefs() });
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
          this.recorded(() => applyInlineEdit(this.ctx.mdPath, msg.ls, msg.le, msg.kind, msg.oldText, msg.newText), applied);
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
          applied.status = c.status;
          if (s) s.appliedAt = store.now();
          if (c.status !== 'resolved') store.setStatus(d, msg.id, 'resolved');
        });
        this.ctx.post({ type: 'blockSaved', ls: msg.ls });
        this.render();
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
        this.recorded(() => applyBlockEdit(this.ctx.mdPath, msg.ls, msg.le, msg.original, msg.newText));
        this.ctx.post({ type: 'blockSaved', ls: msg.ls });
        this.render(true); // the view changed the DOM; always repaint it
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
        this.render(true);
        return;
      case 'openLink':
        this.ctx.openLink(msg.href);
        return;
      case 'toggleTask':
        try {
          this.assertEditable();
          this.recorded(() => toggleTask(this.ctx.mdPath, msg.line, msg.checked, msg.key));
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
        this.round = null;
        return this.ctx.post({ type: 'round', round: null });
      case 'setPrefs':
        this.ctx.setPrefs?.(msg.prefs);
        return;
      case 'composing': // a VS Code context key for Alt+1/2/3; set by the extension
        return;
    }
  }

  /** Run a file edit and remember it for undo. */
  private recorded(write: () => unknown, tag?: Applied): void {
    const before = fs.readFileSync(this.ctx.mdPath);
    write();
    this.history.record(before, fs.readFileSync(this.ctx.mdPath), tag);
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
    const applied = this.history.nextTag(which) as Applied | undefined;
    let next: Buffer;
    try {
      next = which === 'undo' ? this.history.undo(cur) : this.history.redo(cur);
    } catch (e) {
      if (e instanceof HistoryError) this.postHistory();
      throw e;
    }
    fs.writeFileSync(this.ctx.mdPath, next);
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
          } else {
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
