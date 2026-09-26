// Send to Claude: start the configured agent on a review prompt.
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanOldPrompts, commandLine, findProgram, parseCommand, shellKind, ShellKind } from './agentLaunch';

const DAY = 24 * 60 * 60 * 1000;
/** Set on activation; until then, a private folder made on first use. */
let promptDir: string | undefined;

/** Keep prompt files in the extension's storage, and drop ones from past days. */
export function initAgentPrompts(context: vscode.ExtensionContext): void {
  promptDir = path.join(context.globalStorageUri.fsPath, 'prompts');
  cleanOldPrompts(promptDir, DAY);
}

/**
 * Start the configured agent in a terminal. The review prompt is written to a
 * file and the agent gets one short argument that points at it: comment text
 * is untrusted, and on Windows a .cmd shim would run it through cmd.exe.
 * Returns a status line, '' when the user was already told what happened, or
 * null when no agent was started.
 */
export function runAgent(prompt: string, fileName: string, cwd: string): string | null {
  const cfg = vscode.workspace.getConfiguration('mdReview');
  const mode = cfg.get<string>('agent.mode', 'terminal');
  const command = (cfg.get<string>('agent.command') || 'claude').trim();
  void vscode.env.clipboard.writeText(prompt);
  if (mode === 'clipboard') return 'Review prompt copied. Paste it into your agent.';
  // Claude Code started here would load the folder's own settings and hooks.
  if (!vscode.workspace.isTrusted) return "This folder isn't trusted, so Claude Code wasn't started. The review prompt is on your clipboard.";

  const [program = 'claude', ...extra] = parseCommand(command, process.platform === 'win32');
  let home = '';
  try {
    home = os.homedir();
  } catch {
    // no home folder: skip the per-user install locations
  }
  const exe = findProgram(program, { platform: process.platform, env: process.env, home });
  if (!exe) {
    void vscode.window
      .showWarningMessage(
        `${program} wasn't found, so the review prompt was copied to the clipboard instead. Install Claude Code, or set its full path in the MD Review agent command setting.`,
        'Open Setting',
      )
      .then((pick) => pick && vscode.commands.executeCommand('workbench.action.openSettings', 'mdReview.agent.command'));
    return null;
  }

  let promptFile: string;
  try {
    promptDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mdreview-prompts-'));
    // Comments can be private: only this user may read the prompt.
    fs.mkdirSync(promptDir, { recursive: true, mode: 0o700 });
    promptFile = path.join(promptDir, `review-prompt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.md`);
    fs.writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    void vscode.window.showWarningMessage(
      `The review prompt couldn't be saved for ${path.basename(exe)} (${(e as Error).message}), so it was copied to the clipboard instead.`,
    );
    return null;
  }
  const args = [...extra, `Read and follow the review instructions in ${promptFile}`];
  const name = `Claude · ${fileName}`;
  const iconPath = new vscode.ThemeIcon('sparkle');

  if (cfg.get<string>('agent.launch', 'direct') === 'shell') {
    const term = vscode.window.createTerminal({ name, cwd, iconPath });
    term.show();
    runInShell(term, exe, args);
  } else {
    vscode.window.createTerminal({ name, cwd, shellPath: exe, shellArgs: args, iconPath }).show();
  }
  return `Sent to ${path.basename(exe)} in a new terminal. The prompt is on your clipboard too.`;
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
