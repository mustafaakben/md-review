import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { ReviewSession, FromWebview } from './core';
import { runAgent } from './agentRun';

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
    this.pendingFocus.set(key, id);
    await vscode.commands.executeCommand('vscode.openWith', uri, this.viewType);
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

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
    const session = new ReviewSession({
      mdPath,
      author: () => cfg().get<string>('author')?.trim() || systemUser(),
      showResolved: () => cfg().get<boolean>('showResolved', true),
      post: (m) => void webview.postMessage(m),
      resolveImage: (src) => webview.asWebviewUri(vscode.Uri.file(path.resolve(dir, src))).toString(),
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
      runAgent: (prompt) => runAgent(prompt, path.basename(mdPath), vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dir),
      // The panel shows the summary itself; only reach out when it's out of sight.
      notify: (message) => {
        if (panel.visible) return; // the banner already says it
        void vscode.window.showInformationMessage(message, 'Open').then((pick) => {
          if (pick === 'Open') panel.reveal();
        });
      },
    });
    const key = fileKey(document.uri);
    const state: PanelState = { key, ready: false, focus: MdReviewEditorProvider.pendingFocus.get(key) };
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
        if (e.affectsConfiguration('mdReview')) session.sendComments();
      }),
    );

    // Sidecar watcher (works for files outside the workspace too).
    const sideWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), path.basename(mdPath) + '.comments.json'),
    );
    const onSide = () => session.onSidecarChanged();
    subs.push(sideWatcher, sideWatcher.onDidChange(onSide), sideWatcher.onDidCreate(onSide), sideWatcher.onDidDelete(onSide));

    // Markdown watcher: if VS Code hasn't reloaded the buffer (e.g. the file
    // lives outside the workspace), make sure we still show the disk content.
    const mdWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), path.basename(mdPath)),
    );
    // render() skips text it already showed, so this costs nothing when the
    // buffer listener above got there first.
    subs.push(mdWatcher, mdWatcher.onDidChange(() => rerender()), mdWatcher.onDidCreate(() => rerender()));

    subs.push(
      panel.onDidChangeViewState((e) => {
        if (!e.webviewPanel.active) void vscode.commands.executeCommand('setContext', 'mdReview.composing', false);
      }),
    );
    panel.onDidDispose(() => {
      MdReviewEditorProvider.panels.delete(panel);
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
<title>MD Review</title></head>
<body data-reading-theme="${prefs.theme}" data-reading-font="${prefs.font}" data-prefs="${attr(JSON.stringify(prefs))}"><div id="app"></div><script nonce="${nonce}" src="${media('webview.js')}"></script></body></html>`;
  }
}

interface PanelState {
  key: string;
  /** The webview has sent `ready`, so messages reach a live view. */
  ready: boolean;
  /** A thread to jump to once it is ready. */
  focus?: string;
}

/** Compare files by path; Windows paths are case-insensitive. */
function fileKey(uri: vscode.Uri): string {
  return process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
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

/** Stored reading preferences, with anything unexpected replaced by the default. */
function readingPrefs(stored: unknown): { zoom: number; theme: string; font: string } {
  const p = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const zoom = typeof p.zoom === 'number' && p.zoom >= 0.5 && p.zoom <= 3 ? p.zoom : 1;
  const theme = typeof p.theme === 'string' && ['auto', 'paper', 'sepia', 'dusk', 'night'].includes(p.theme) ? p.theme : 'auto';
  const font = p.font === 'serif' ? 'serif' : 'sans';
  return { zoom, theme, font };
}

function openLink(href: string, dir: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    const uri = vscode.Uri.parse(href);
    // file: links open here. In Restricted Mode only web and mail links leave
    // VS Code; other schemes (vscode:, other apps' handlers) need trust.
    const scheme = uri.scheme.toLowerCase();
    if (scheme === 'file') void vscode.commands.executeCommand('vscode.open', uri);
    else if (vscode.workspace.isTrusted || ['http', 'https', 'mailto'].includes(scheme)) void vscode.env.openExternal(uri);
    else void vscode.window.showInformationMessage(`Trust this folder to open ${uri.scheme}: links.`);
    return;
  }
  const [p] = href.split('#');
  if (!p) return;
  void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.resolve(dir, decodeURIComponent(p))));
}
