import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { ReviewSession, FromWebview } from './core';

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
  private static panels = new Set<vscode.WebviewPanel>();

  /** Forward a command (undo, find, …) to the focused MD Review webview. */
  static postToActive(msg: unknown): boolean {
    for (const p of this.panels) {
      if (p.active) {
        void p.webview.postMessage(msg);
        return true;
      }
    }
    return false;
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
    const session = new ReviewSession({
      mdPath,
      author: () => cfg().get<string>('author') || os.userInfo().username,
      showResolved: () => cfg().get<boolean>('showResolved', true),
      post: (m) => void webview.postMessage(m),
      resolveImage: (src) => webview.asWebviewUri(vscode.Uri.file(path.resolve(dir, src))).toString(),
      // Clean buffer -> render the disk bytes (the source of truth for block
      // edits); dirty buffer -> render what the user is typing.
      getText: () => (document.isDirty ? document.getText() : readDisk(mdPath) ?? document.getText()),
      isDirty: () => document.isDirty,
      openLink: (href) => openLink(href, dir),
      agentCwd: () => vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dir,
      cliPath: vscode.Uri.joinPath(this.context.extensionUri, 'cli', 'mdreview.mjs').fsPath,
      runAgent: (prompt) => runAgent(prompt, path.basename(mdPath), vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dir),
    });
    MdReviewEditorProvider.panels.add(panel);

    const subs: vscode.Disposable[] = [];
    let timer: NodeJS.Timeout | undefined;
    const rerender = () => {
      clearTimeout(timer);
      timer = setTimeout(() => session.render(), 150);
    };
    subs.push(
      webview.onDidReceiveMessage((m: FromWebview) => {
        session.handle(m);
        if (m.type === 'saveBlock' || m.type === 'undo' || m.type === 'redo') setTimeout(() => void refreshFromDisk(document, session), 400);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString()) rerender();
      }),
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
    subs.push(mdWatcher, mdWatcher.onDidChange(() => setTimeout(() => void refreshFromDisk(document, session), 300)));

    panel.onDidDispose(() => {
      MdReviewEditorProvider.panels.delete(panel);
      subs.forEach((d) => d.dispose());
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
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('katex/katex.min.css')}">
<link rel="stylesheet" href="${media('style.css')}">
<link rel="stylesheet" href="${media('features.css')}">
<title>MD Review</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${media('webview.js')}"></script></body></html>`;
  }
}

/** Re-render; when the buffer is clean the session reads straight from disk. */
async function refreshFromDisk(_document: vscode.TextDocument, session: ReviewSession) {
  session.render();
}

function openLink(href: string, dir: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    void vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  const [p] = href.split('#');
  if (!p) return;
  void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.resolve(dir, decodeURIComponent(p))));
}

/**
 * Start the configured agent in a terminal with the review prompt. The command
 * is launched directly (no shell), so the prompt needs no quoting.
 */
function runAgent(prompt: string, fileName: string, cwd: string): string {
  const cfg = vscode.workspace.getConfiguration('mdReview');
  const mode = cfg.get<string>('agent.mode', 'terminal');
  const command = (cfg.get<string>('agent.command') || 'claude').trim();
  void vscode.env.clipboard.writeText(prompt);
  if (mode === 'clipboard') return 'Review prompt copied. Paste it into your agent.';
  const [shellPath, ...extra] = command.split(/\s+/);
  const term = vscode.window.createTerminal({
    name: `Claude · ${fileName}`,
    cwd,
    shellPath,
    shellArgs: [...extra, prompt],
    iconPath: new vscode.ThemeIcon('sparkle'),
  });
  term.show();
  return `Sent to ${shellPath} in a new terminal. The prompt is on your clipboard too.`;
}
