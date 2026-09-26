// Workspace-level agent commands: send every open review under a folder to
// Claude, and install the Claude Code skill that teaches it the review loop.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { awaitsAgent, readSidecar } from './commentStore';
import { buildFolderPrompt } from './agentPrompt';
import { runAgent } from './agentRun';

const SIDECAR = '.md.comments.json';

async function pickWorkspaceFolder(placeHolder: string): Promise<vscode.WorkspaceFolder | null | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) return undefined;
  if (folders.length === 1) return folders[0];
  const active = vscode.window.activeTextEditor?.document.uri;
  const current = active && vscode.workspace.getWorkspaceFolder(active);
  // null: the picker was cancelled, so say nothing.
  return current ?? (await vscode.window.showWorkspaceFolderPick({ placeHolder })) ?? null;
}

/** Files under `folder` with comments waiting on the agent (see awaitsAgent). */
export async function openReviews(folder: vscode.Uri): Promise<{ mdPath: string; open: number }[]> {
  const sidecars = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, `**/*${SIDECAR}`),
    '{**/node_modules/**,**/.*/**}',
  );
  const out: { mdPath: string; open: number }[] = [];
  for (const uri of sidecars) {
    const mdPath = uri.fsPath.slice(0, -'.comments.json'.length);
    try {
      const open = readSidecar(mdPath).comments.filter((c) => awaitsAgent(c)).length;
      if (open) out.push({ mdPath, open });
    } catch {
      // A sidecar mid-write or hand-broken JSON: skip it rather than fail the whole send.
    }
  }
  return out.sort((a, b) => a.mdPath.localeCompare(b.mdPath));
}

export async function sendFolderToClaude(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const ws = uri ? vscode.workspace.getWorkspaceFolder(uri) : await pickWorkspaceFolder('Send the open reviews in which folder?');
  if (ws === null) return;
  const folder = uri ?? ws?.uri;
  if (!folder) {
    void vscode.window.showInformationMessage('Open a folder first, then send its reviews to Claude.');
    return;
  }
  const files = await openReviews(folder);
  const name = path.basename(folder.fsPath);
  if (!files.length) {
    void vscode.window.showInformationMessage(`No open review comments in ${name}. Submit a review first.`);
    return;
  }
  const cwd = ws?.uri.fsPath ?? folder.fsPath;
  const prompt = buildFolderPrompt({
    folder: folder.fsPath,
    cwd,
    files,
    cliPath: vscode.Uri.joinPath(context.extensionUri, 'cli', 'mdreview.mjs').fsPath,
    suggest: vscode.workspace.getConfiguration('mdReview').get<string>('agent.editMode') === 'suggest',
  });
  const status = runAgent(prompt, name, cwd);
  if (status) void vscode.window.showInformationMessage(status);
}

export async function addClaudeSkill(context: vscode.ExtensionContext): Promise<void> {
  const ws = await pickWorkspaceFolder('Add the MD Review skill to which folder?');
  if (ws === null) return;
  if (!ws) {
    void vscode.window.showInformationMessage('Open a folder first; the skill is added to its .claude/skills.');
    return;
  }
  const src = (f: string) => vscode.Uri.joinPath(context.extensionUri, 'cli', f).fsPath;
  const dest = path.join(ws.uri.fsPath, '.claude', 'skills', 'md-review');
  const skill = path.join(dest, 'SKILL.md');
  const existing = fs.existsSync(skill) ? fs.readFileSync(skill, 'utf8') : undefined;
  if (existing !== undefined && existing !== fs.readFileSync(src('SKILL.md'), 'utf8')) {
    const replace = 'Replace';
    const pick = await vscode.window.showWarningMessage(
      `${ws.name}/.claude/skills/md-review/SKILL.md already exists and differs from this version.`,
      { modal: true },
      replace,
    );
    if (pick !== replace) return;
  }
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ['SKILL.md', 'mdreview.mjs']) fs.copyFileSync(src(f), path.join(dest, f));
  } catch (e) {
    void vscode.window.showErrorMessage(`Couldn't write ${dest}: ${(e as Error).message}`);
    return;
  }
  const open = 'Open SKILL.md';
  const pick = await vscode.window.showInformationMessage(
    `Added the MD Review skill to ${ws.name}. Claude Code started in this folder can now work through your review comments when you ask.`,
    open,
  );
  if (pick === open) void vscode.window.showTextDocument(vscode.Uri.file(skill));
}
