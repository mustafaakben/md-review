// Send to Claude: start the configured agent on a review prompt.
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanOldPrompts, commandLine, findProgram, parseCommand, shellKind } from './agentLaunch';

const DAY = 24 * 60 * 60 * 1000;
let promptDir = path.join(os.tmpdir(), 'mdreview-prompts');

/** Keep prompt files in the extension's storage, and drop ones from past days. */
export function initAgentPrompts(context: vscode.ExtensionContext): void {
  promptDir = path.join(context.globalStorageUri.fsPath, 'prompts');
  cleanOldPrompts(promptDir, DAY);
}

/**
 * Start the configured agent in a terminal. The review prompt is written to a
 * file and the agent gets one short argument that points at it: comment text
 * is untrusted, and on Windows a .cmd shim would run it through cmd.exe.
 * Returns a status line, or '' when the user was already told what happened.
 */
export function runAgent(prompt: string, fileName: string, cwd: string): string {
  const cfg = vscode.workspace.getConfiguration('mdReview');
  const mode = cfg.get<string>('agent.mode', 'terminal');
  const command = (cfg.get<string>('agent.command') || 'claude').trim();
  void vscode.env.clipboard.writeText(prompt);
  if (mode === 'clipboard') return 'Review prompt copied. Paste it into your agent.';

  const [program = 'claude', ...extra] = parseCommand(command, process.platform === 'win32');
  const exe = findProgram(program, { platform: process.platform, env: process.env, home: os.homedir() });
  if (!exe) {
    void vscode.window
      .showWarningMessage(
        `${program} wasn't found, so the review prompt was copied to the clipboard instead. Install Claude Code, or set its full path in the MD Review agent command setting.`,
        'Open Setting',
      )
      .then((pick) => pick && vscode.commands.executeCommand('workbench.action.openSettings', 'mdReview.agent.command'));
    return '';
  }

  fs.mkdirSync(promptDir, { recursive: true });
  const promptFile = path.join(promptDir, `review-prompt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.md`);
  fs.writeFileSync(promptFile, prompt, 'utf8');
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

/**
 * Run the agent inside the user's own shell, which stays open when it exits.
 * Shell integration quotes for whatever shell it is; without it (it can take
 * a moment to start, or be off), type a line quoted for the default shell.
 */
function runInShell(term: vscode.Terminal, exe: string, args: string[]): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    sub.dispose();
    clearTimeout(timer);
    if (term.shellIntegration) term.shellIntegration.executeCommand(exe, args);
    else term.sendText(commandLine(shellKind(vscode.env.shell), [exe, ...args]));
  };
  const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => e.terminal === term && run());
  const timer = setTimeout(run, 3000);
  if (term.shellIntegration) run();
}
