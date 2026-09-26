import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { ReviewSession, FromWebview } from './core';
import type { Baselines } from './redlines';

const PREFS_KEY = 'mdReview.readingPrefs';
/** Changes baselines per file, in workspace storage (never next to the document). */
const BASELINES_KEY = 'mdReview.baselines:';

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
      author: () => cfg().get<string>('author') || os.userInfo().username,
      showResolved: () => cfg().get<boolean>('showResolved', true),
      post: (m) => void webview.postMessage(m),
      resolveImage: (src) => webview.asWebviewUri(vscode.Uri.file(path.resolve(dir, src))).toString(),
      // Clean buffer -> render the disk bytes (the source of truth for block
      // edits); dirty buffer -> render what the user is typing.
      getText: () => (document.isDirty ? document.getText() : readDisk(mdPath) ?? document.getText()),
      isDirty: () => document.isDirty,
      openLink: (href) => openLink(href, dir),
      watchFiles: watchBibs,
      suggestMode: () => cfg().get<string>('agent.editMode') === 'suggest',
      reviewComments: () => cfg().get<number>('agent.reviewComments', 12),
      agentCwd: () => vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? dir,
      cliPath: vscode.Uri.joinPath(this.context.extensionUri, 'cli', 'mdreview.mjs').fsPath,
      getPrefs: () => this.context.globalState.get<Record<string, unknown>>(PREFS_KEY) ?? {},
      setPrefs: (prefs) => {
        void this.context.globalState.update(PREFS_KEY, prefs);
        // Keep other open MD Review panels in step.
        for (const p of MdReviewEditorProvider.panels) if (p !== panel) void p.webview.postMessage({ type: 'prefs', prefs });
      },
      baselines: {
        load: () => this.context.workspaceState.get<Baselines>(BASELINES_KEY + mdPath),
        save: (b) => void this.context.workspaceState.update(BASELINES_KEY + mdPath, b.current || b.past.length ? b : undefined),
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
    MdReviewEditorProvider.panels.add(panel);

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
 * Start the configured agent in a terminal. The review prompt is written to a
 * temp file and the agent gets one short argument that points at it.
 */
export function runAgent(prompt: string, fileName: string, cwd: string): string {
  const cfg = vscode.workspace.getConfiguration('mdReview');
  const mode = cfg.get<string>('agent.mode', 'terminal');
  const command = (cfg.get<string>('agent.command') || 'claude').trim();
  void vscode.env.clipboard.writeText(prompt);
  if (mode === 'clipboard') return 'Review prompt copied. Paste it into your agent.';
  const [shellPath, ...extra] = command.split(/\s+/);
  // Pass a short fixed argument pointing at a file instead of the prompt itself:
  // comment text is untrusted, and on Windows a .cmd shim would run it through cmd.exe.
  const promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdreview-')), 'review-prompt.md');
  fs.writeFileSync(promptFile, prompt, 'utf8');
  const term = vscode.window.createTerminal({
    name: `Claude · ${fileName}`,
    cwd,
    shellPath,
    shellArgs: [...extra, `Read and follow the review instructions in ${promptFile}`],
    iconPath: new vscode.ThemeIcon('sparkle'),
  });
  term.show();
  return `Sent to ${shellPath} in a new terminal. The prompt is on your clipboard too.`;
}
