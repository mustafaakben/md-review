// Agent sessions in VS Code: the binding for each workspace folder, terminals
// for starting or resuming a session, and Connect this folder. Delivery itself
// (Claude's session inbox, codex queue) is in agentSessions.ts.
import * as vscode from 'vscode';
import * as path from 'path';
import { cleanOldPrompts, commandLine, shellKind, ShellKind } from './agentLaunch';
import { createAgentHost } from './agentHost';
import { connectFolder, planConnect } from './agentConnect';
import type { AgentHost, Delivery } from './core';
import type { AgentKind, Binding } from './agentSessions';

const bindingKey = (folder: string) => `mdReview.agent.binding:${folder}`;
const cfg = () => vscode.workspace.getConfiguration('mdReview');

/** Earlier versions wrote a prompt file per Send; drop any left behind. */
export function initAgentPrompts(context: vscode.ExtensionContext): void {
  cleanOldPrompts(path.join(context.globalStorageUri.fsPath, 'prompts'), 0);
}

export type VscodeAgentHost = AgentHost & { deliverPrompt(prompt: string): Promise<string | null> };

/** The agent host for a workspace folder (or a lone file's folder). */
export function agentHostFor(context: vscode.ExtensionContext, folder: string, fileName: string): VscodeAgentHost {
  return createAgentHost({
    folder: () => folder,
    fileName,
    getBinding: () => context.workspaceState.get<Binding>(bindingKey(folder)),
    setBinding: (b) => void context.workspaceState.update(bindingKey(folder), b),
    getDelivery: () => (cfg().get<string>('agent.delivery') === 'live' ? 'live' : 'onSend'),
    setDelivery: (d: Delivery) =>
      void cfg().update('agent.delivery', d, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global),
    command: (agent: AgentKind) => ((agent === 'codex' ? cfg().get<string>('agent.codexCommand') : cfg().get<string>('agent.command')) || agent).trim(),
    openTerminal,
    connect: () => connectWithConsent(context, folder),
  });
}

/** Start argv in a terminal of its own, running in the user's shell so it stays open. */
function openTerminal(argv: string[], name: string, cwd: string): boolean {
  // Claude Code or Codex started here would load the folder's own settings and hooks.
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("This folder isn't trusted, so no agent was started here. Trust the folder, or pick a session that's already running.");
    return false;
  }
  const term = vscode.window.createTerminal({ name, cwd, iconPath: new vscode.ThemeIcon('sparkle') });
  term.show();
  runInShell(term, argv[0], argv.slice(1));
  return true;
}

/** Install the skill and hooks, after saying what will change. */
async function connectWithConsent(context: vscode.ExtensionContext, folder: string): Promise<string | null> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showInformationMessage('Trust this folder first; connecting adds hooks that Claude Code runs in it.');
    return null;
  }
  const cliDir = vscode.Uri.joinPath(context.extensionUri, 'cli').fsPath;
  const plan = planConnect(folder, { cliDir, acceptInbound: true });
  const name = path.basename(folder);
  const connect = 'Connect';
  const accept = 'Connect, and accept messages';
  const pick = await vscode.window.showInformationMessage(
    `Connect ${name} to MD Review?`,
    {
      modal: true,
      detail: [
        `Adds to ${name}/.claude/:`,
        `• skills/md-review/ (the skill and CLI${plan.skillDiffers ? ', replacing the version there' : ''})`,
        '• settings.local.json: SessionStart and SessionEnd hooks, so Claude sessions started here register with MD Review, and a rule that lets them run the MD Review CLI without asking.',
        '',
        '"Accept messages" also sets crossSessionInbound to accept. Sessions that skip permission prompts then take messages from other sessions (MD Review included) without holding them for your approval.',
      ].join('\n'),
    },
    connect,
    accept,
  );
  if (!pick) return null;
  const changed = connectFolder(folder, { cliDir, acceptInbound: pick === accept });
  return `Connected ${name}: ${changed.join(', ')}. Claude sessions started here now connect by themselves.`;
}

interface SessionPick extends vscode.QuickPickItem {
  run: () => Promise<Binding | null> | Binding | null;
}

/**
 * For the folder commands: the session to send to, bound if needed. A single
 * running session started with MD Review's hook is taken without asking.
 * Returns null when the picker was cancelled.
 */
export async function pickSession(host: VscodeAgentHost, folderName: string): Promise<Binding | null> {
  const bound = host.binding();
  if (bound) return bound;
  const sessions = host.list();
  const live = sessions.filter((s) => s.live);
  const hooked = live.filter((s) => s.connected);
  if (hooked.length === 1) {
    const b = { agent: hooked[0].agent, id: hooked[0].id, name: hooked[0].name };
    host.bind(b);
    return b;
  }
  const label = (a: AgentKind) => (a === 'codex' ? 'Codex' : 'Claude');
  const items: (SessionPick | vscode.QuickPickItem)[] = [
    ...(live.length ? [{ label: 'Running in this folder', kind: vscode.QuickPickItemKind.Separator }] : []),
    ...live.map((s) => ({
      label: `$(${s.agent === 'codex' ? 'terminal' : 'sparkle'}) ${label(s.agent)} · ${s.name || s.id.slice(0, 8)}`,
      description: s.status || 'running',
      detail: s.id,
      run: () => ({ agent: s.agent, id: s.id, name: s.name }),
    })),
    { label: 'Start', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) New Claude session', run: () => host.start('claude') },
    { label: '$(add) New Codex session', run: () => host.start('codex') },
  ];
  const pick = (await vscode.window.showQuickPick(items, { placeHolder: `Send the reviews in ${folderName} to which session?` })) as SessionPick | undefined;
  if (!pick?.run) return null;
  const b = await pick.run();
  if (b) host.bind(b);
  return b;
}

/** The kind of shell a terminal runs, as shell integration reports it. */
function termShell(term: vscode.Terminal): ShellKind {
  // `state.shell` is newer than our minimum VS Code; fall back to the default shell.
  const known = (term.state as { shell?: string }).shell;
  if (known === 'pwsh' || known === 'cmd' || known === 'fish') return known;
  if (known) return 'posix';
  return shellKind(vscode.env.shell);
}

/**
 * Run the agent inside the user's own shell, which stays open when it exits.
 * The line is quoted here for the terminal's shell: shell integration's
 * argument form leaves quoting to heuristics that don't cover every character.
 * Without shell integration (it can take a moment to start, or be off), the
 * same line is typed in.
 */
function runInShell(term: vscode.Terminal, exe: string, args: string[]): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    sub.dispose();
    clearTimeout(timer);
    const line = commandLine(termShell(term), [exe, ...args]);
    try {
      if (term.shellIntegration) return void term.shellIntegration.executeCommand(line);
    } catch {
      // fall through to typing it
    }
    term.sendText(line);
  };
  const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => e.terminal === term && run());
  const timer = setTimeout(run, 3000);
  if (term.shellIntegration) run();
}
