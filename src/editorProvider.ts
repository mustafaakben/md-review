import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { ReviewSession, FromWebview, linkPath, readingPrefs } from './core';
import { BaselineStore } from './baselineStore';
import { saveSendBaseline } from './redlines';
import { awaitsAgent, readSidecar, Comment } from './commentStore';
import { agentHostFor } from './agentRun';
import { sameName, shouldPoll, folderKey, nameKey, StampTracker, POLL_MS } from './fileWatch';
import { hasUrlScheme } from './render';
import { inlineImage, isInside } from './localImage';

const PREFS_KEY = 'mdReview.readingPrefs';

function readDisk(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  } catch {
    return undefined;
  }
}

export class MdReviewEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'mdReview.editor';
  /** Every open MD Review panel, so commands can reach the focused one. */
  private static panels = new Map<vscode.WebviewPanel, PanelState>();
  /** Threads to jump to once a panel that is still opening says it's ready. */
  private static pendingFocus = new Map<string, string>();

  /** Forward a command (undo, find, …) to the focused MD Review webview. */
  static postToActive(msg: unknown): boolean {
    for (const p of this.panels.keys()) {
      if (p.active) {
        void p.webview.postMessage(msg);
        return true;
      }
    }
    return false;
  }

  /** Changes baselines: files in the extension's storage (never next to the document), details in workspace state. */
  private baselines: BaselineStore;
  private static store: BaselineStore | undefined;

  private static baselineStore(context: vscode.ExtensionContext): BaselineStore {
    return (this.store ||= new BaselineStore(vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'baselines').fsPath, context.workspaceState));
  }

  /**
   * The file's text as a panel would read it: the open document's while it
   * has unsaved edits, else the disk's. Undefined when it can't be read.
   */
  static textOf(mdPath: string): string | undefined {
    const key = nameKey(mdPath, process.platform);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && nameKey(d.uri.fsPath, process.platform) === key);
    return doc?.isDirty ? doc.getText() : readDisk(mdPath) ?? doc?.getText();
  }

  /**
   * Claude was sent a file's open threads from outside its panel (a folder's
   * reviews, the inbox's Send All): save the copy the Changes view compares
   * against, as Send in the panel does. An open panel's session does it, so
   * what it holds stays current; otherwise it goes straight to the store.
   * `text` is the file before Claude started (see textOf).
   */
  static snapshotSent(context: vscode.ExtensionContext, mdPath: string, text: string): void {
    let comments: Comment[];
    try {
      comments = readSidecar(mdPath).comments.filter((c) => awaitsAgent(c));
    } catch {
      return; // a sidecar mid-write or hand-broken: the send skipped it too
    }
    const key = nameKey(mdPath, process.platform);
    // One panel on the file is enough: the others read the saved baseline when they next compare.
    const open = [...this.panels.values()].find((s) => s.key === key);
    if (open) open.session.snapshotSent(comments, text);
    else saveSendBaseline(this.baselineStore(context).forFile(mdPath), comments, text);
  }

  /** Hand a message to the focused panel's session as if its webview sent it (the smoke test's way in). */
  static handleInActive(msg: FromWebview): boolean {
    for (const [p, s] of this.panels) {
      if (p.active) {
        s.session.handle(msg);
        return true;
      }
    }
    return false;
  }

  /** Open `uri` in MD Review (or reveal the panel already showing it) and jump to a thread. */
  static async focusThread(uri: vscode.Uri, id: string): Promise<void> {
    const key = fileKey(uri);
    for (const [p, s] of this.panels) {
      if (s.key !== key) continue;
      p.reveal();
      if (s.ready) void p.webview.postMessage({ type: 'focusThread', id });
      else s.focus = id;
      return;
    }
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      // The inbox lists threads from the sidecar, which can outlive its Markdown file.
      void vscode.window.showWarningMessage(`${path.basename(uri.fsPath)} no longer exists; its review threads are still in ${path.basename(uri.fsPath)}.comments.json.`);
      return;
    }
    this.pendingFocus.set(key, id);
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, this.viewType);
    } finally {
      // The panel took it when it opened; if it never did, don't jump in a later one.
      if (this.pendingFocus.get(key) === id) this.pendingFocus.delete(key);
    }
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.baselines = MdReviewEditorProvider.baselineStore(context);
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const mdPath = document.uri.fsPath;
    const dir = path.dirname(mdPath);
    const webview = panel.webview;
    const roots = [vscode.Uri.file(dir), vscode.Uri.joinPath(this.context.extensionUri, 'media')];
    for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri);
    webview.options = { enableScripts: true, localResourceRoots: roots };
    webview.html = this.shell(webview);

    const cfg = () => vscode.workspace.getConfiguration('mdReview');
    // The bibliography can live anywhere; watch exactly the files the last render read.
    let bibWatchers: vscode.Disposable[] = [];
    const watchBibs = (files: string[]) => {
      bibWatchers.forEach((d) => d.dispose());
      bibWatchers = files.map((f) => {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(f)), path.basename(f)));
        const again = () => rerender(true); // same text, new references
        w.onDidChange(again);
        w.onDidCreate(again);
        w.onDidDelete(again);
        return w;
      });
    };
    // Comments go to the session bound to this workspace folder (a lone file: its own folder).
    const agentFolder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dir;
    const agents = agentHostFor(this.context, agentFolder, path.basename(mdPath));
    const session = new ReviewSession({
      mdPath,
      author: () => cfg().get<string>('author')?.trim() || systemUser(),
      showResolved: () => cfg().get<boolean>('showResolved', true),
      post: (m) => void webview.postMessage(m),
      resolveImage: (src) => {
        const file = path.resolve(dir, src);
        // In a trusted folder, an image outside the folders above (`../figures/a.png`
        // beside a file opened on its own) is sent inline instead.
        if (vscode.workspace.isTrusted && !roots.some((r) => isInside(r.fsPath, file))) {
          const inline = inlineImage(file);
          if (inline) return inline;
        }
        return webview.asWebviewUri(vscode.Uri.file(file)).toString();
      },
      // Clean buffer -> render the disk bytes (the source of truth for block
      // edits); dirty buffer -> render what the user is typing.
      getText: () => (document.isDirty ? document.getText() : readDisk(mdPath) ?? document.getText()),
      isDirty: () => document.isDirty,
      openLink: (href) => openLink(href, dir),
      watchFiles: watchBibs,
      // In Restricted Mode a document can't make us read files elsewhere on the
      // machine. (A document at a drive root or in the home folder allows that folder.)
      readableRoots: () => (vscode.workspace.isTrusted ? undefined : [dir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)]),
      suggestMode: () => cfg().get<string>('agent.editMode') === 'suggest',
      reviewComments: () => cfg().get<number>('agent.reviewComments', 12),
      agentCwd: () => vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dir,
      cliPath: vscode.Uri.joinPath(this.context.extensionUri, 'cli', 'mdreview.mjs').fsPath,
      getPrefs: () => this.context.globalState.get<Record<string, unknown>>(PREFS_KEY) ?? {},
      setPrefs: (prefs) => {
        void this.context.globalState.update(PREFS_KEY, prefs);
        // Keep other open MD Review panels in step.
        for (const p of MdReviewEditorProvider.panels.keys()) if (p !== panel) void p.webview.postMessage({ type: 'prefs', prefs });
      },
      baselines: this.baselines.forFile(mdPath),
      agents,
      runAgent: (prompt) => agents.deliverPrompt(prompt),
      // The panel shows the summary itself; only reach out when it's out of sight.
      notify: (message) => {
        if (panel.visible) return; // the banner already says it
        void vscode.window.showInformationMessage(message, 'Open').then((pick) => {
          if (pick === 'Open') panel.reveal();
        });
      },
    });
    const key = fileKey(document.uri);
    const state: PanelState = { session, key, ready: false, focus: MdReviewEditorProvider.pendingFocus.get(key) };
    MdReviewEditorProvider.pendingFocus.delete(key);
    MdReviewEditorProvider.panels.set(panel, state);

    const subs: vscode.Disposable[] = [];
    let timer: NodeJS.Timeout | undefined;
    let forced = false;
    // `force` when the text may be unchanged but its rendering isn't.
    const rerender = (force = false) => {
      forced ||= force;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const f = forced;
        forced = false;
        session.render(f);
      }, 150);
    };
    subs.push(
      webview.onDidReceiveMessage((m: FromWebview) => {
        // Alt+1/2/3 are VS Code's "open editor N"; bind them only while a comment box has focus.
        if (m.type === 'composing') return void vscode.commands.executeCommand('setContext', 'mdReview.composing', m.on);
        session.handle(m);
        if (m.type === 'ready') {
          state.ready = true;
          if (state.focus) void webview.postMessage({ type: 'focusThread', id: state.focus });
          state.focus = undefined;
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString()) rerender();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => rerender(true)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => vscode.workspace.isTrusted || rerender(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('mdReview')) return;
        session.sendComments();
        updatePolling();
      }),
    );

    // Watch the folder rather than the two files: editors, sync tools and agents
    // often save by replacing the file (delete + create), and a glob would miss a
    // sidecar whose name differs only in case. This works outside the workspace too.
    const mdName = path.basename(mdPath);
    const sideName = mdName + '.comments.json';
    const onFile = (name: string) => {
      // render() skips text it already showed, so this costs nothing when the
      // buffer listener above got there first.
      if (sameName(name, mdName, process.platform)) rerender();
      else if (sameName(name, sideName, process.platform)) session.onSidecarChanged();
    };
    subs.push(watchFolder(dir, (uri) => onFile(path.basename(uri.fsPath))));

    // Network shares and \\wsl$ send no file events: look every 2 s while the panel shows.
    let tracker: StampTracker | undefined;
    let poll: NodeJS.Timeout | undefined;
    const check = () => void tracker?.check().then((changed) => changed.forEach((f) => onFile(path.basename(f))));
    const updatePolling = () => {
      if (!(panel.visible && shouldPoll(mdPath, process.platform, cfg().get<boolean>('pollFiles', false)))) {
        clearInterval(poll);
        poll = undefined;
      } else if (!poll) {
        tracker ??= new StampTracker([mdPath, path.join(dir, sideName)]);
        check(); // catch up on changes made while hidden
        poll = setInterval(check, POLL_MS);
      }
    };
    updatePolling();
    subs.push({ dispose: () => clearInterval(poll) });

    subs.push(
      panel.onDidChangeViewState((e) => {
        updatePolling();
        if (!e.webviewPanel.active) void vscode.commands.executeCommand('setContext', 'mdReview.composing', false);
      }),
    );
    panel.onDidDispose(() => {
      MdReviewEditorProvider.panels.delete(panel);
      clearTimeout(timer);
      session.dispose();
      subs.forEach((d) => d.dispose());
      bibWatchers.forEach((d) => d.dispose());
    });
  }

  private shell(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      // Nonce only: the Mermaid chunks webview.js imports inherit its nonce, and
      // allowing a host would let document HTML load scripts from the workspace.
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    // The reading look goes into the page itself, so the first paint has it.
    const prefs = readingPrefs(this.context.globalState.get(PREFS_KEY));
    const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<!DOCTYPE html><html lang="en" style="--doc-zoom:${prefs.zoom}"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('katex/katex.min.css')}">
<link rel="stylesheet" href="${media('style.css')}">
<link rel="stylesheet" href="${media('features.css')}">
<link rel="stylesheet" href="${media('fonts/fonts.css')}">
<title>MD Review</title></head>
<body data-reading-theme="${prefs.theme}" data-reading-font="${prefs.font}" data-prefs="${attr(JSON.stringify(prefs))}"><div id="app"></div><script nonce="${nonce}" src="${media('webview.js')}"></script></body></html>`;
  }
}

type FileEvent = (uri: vscode.Uri) => void;

/** One watcher per folder, shared by every panel showing a file in it. */
const folderWatchers = new Map<string, { watcher: vscode.FileSystemWatcher; listeners: Set<FileEvent> }>();

/** Call `listener` on every change, creation or deletion of a file directly in `dir`. */
function watchFolder(dir: string, listener: FileEvent): vscode.Disposable {
  const key = folderKey(dir, process.platform);
  let entry = folderWatchers.get(key);
  if (!entry) {
    // '*' without '**' watches only the folder's own files, not its subfolders.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*'));
    const listeners = new Set<FileEvent>();
    const fire = (uri: vscode.Uri) => listeners.forEach((l) => l(uri));
    watcher.onDidChange(fire);
    watcher.onDidCreate(fire);
    watcher.onDidDelete(fire);
    entry = { watcher, listeners };
    folderWatchers.set(key, entry);
  }
  const e = entry;
  e.listeners.add(listener);
  return new vscode.Disposable(() => {
    e.listeners.delete(listener);
    if (e.listeners.size) return;
    e.watcher.dispose();
    folderWatchers.delete(key);
  });
}

interface PanelState {
  session: ReviewSession;
  key: string;
  /** The webview has sent `ready`, so messages reach a live view. */
  ready: boolean;
  /** A thread to jump to once it is ready. */
  focus?: string;
}

/** Compare files by path; Windows and macOS paths are case-insensitive. */
function fileKey(uri: vscode.Uri): string {
  return nameKey(uri.fsPath, process.platform);
}

/**
 * The OS user name. os.userInfo() throws when the user has no passwd entry,
 * as in many dev containers and CI images that run under an arbitrary uid.
 */
function systemUser(): string {
  try {
    const name = os.userInfo().username;
    if (name) return name;
  } catch {
    // fall through
  }
  return process.env.USER || process.env.USERNAME || 'Reviewer';
}

function openLink(href: string, dir: string) {
  // `C:/notes/x.md` is a path on a drive, not a URL with scheme `c`.
  if (hasUrlScheme(href)) {
    const uri = vscode.Uri.parse(href);
    // file: links open here. In Restricted Mode only web and mail links leave
    // VS Code; other schemes (vscode:, other apps' handlers) need trust.
    const scheme = uri.scheme.toLowerCase();
    if (scheme === 'file') void vscode.commands.executeCommand('vscode.open', uri);
    else if (vscode.workspace.isTrusted || ['http', 'https', 'mailto'].includes(scheme)) void vscode.env.openExternal(uri);
    else void vscode.window.showInformationMessage(`Trust this folder to open ${uri.scheme}: links.`);
    return;
  }
  const p = linkPath(href);
  if (p) void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.resolve(dir, p)));
}
