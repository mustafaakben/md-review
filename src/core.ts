// Host-side message handling, independent of the VS Code API so the same code
// drives both the extension and the browser test harness.
import * as fs from 'fs';
import * as path from 'path';
import * as store from './commentStore';
import { applyBlockEdit, readBlock, toggleTask, BlockEditError } from './blockEdit';
import { renderMarkdown, ResolveImage } from './render';
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
  | { type: 'error'; message: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'addComment'; anchor: store.Anchor; body: string }
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
  | { type: 'setPrefs'; prefs: Record<string, unknown> };

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
}

export class ReviewSession {
  private lastSidecarWrite: string | undefined;
  private lastRendered = '';
  private history = new EditHistory();

  constructor(private ctx: HostContext) {}

  render(): void {
    const text = this.ctx.getText();
    this.lastRendered = text;
    let html: string;
    try {
      html = renderMarkdown(text, this.ctx.resolveImage, { docDir: path.dirname(this.ctx.mdPath) });
    } catch (e: any) {
      html = `<pre class="mdr-error">Render failed: ${String(e?.message || e)}</pre>`;
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
        this.render();
        this.sendComments();
        this.postHistory();
        if (this.ctx.getPrefs) this.ctx.post({ type: 'prefs', prefs: this.ctx.getPrefs() });
        return;
      case 'addComment':
        return this.mutate((d) => void store.addComment(d, author, msg.anchor, msg.body));
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
      case 'setPrefs':
        this.ctx.setPrefs?.(msg.prefs);
        return;
    }
  }

  /** Run a file edit and remember it for undo. */
  private recorded(write: () => unknown): void {
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
    const prompt = buildAgentPrompt({
      mdPath: this.ctx.mdPath,
      cwd: this.ctx.agentCwd?.() ?? path.dirname(this.ctx.mdPath),
      comments,
      cliPath: this.ctx.cliPath,
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
    if (norm(disk) !== norm(this.lastRendered)) {
      this.render();
      throw new BlockEditError('The file changed on disk; the view was refreshed. Double-click the block again.');
    }
  }
}
