// Workspace-level agent commands: send every open review under a folder to
// Claude, and install the Claude Code skill that teaches it the review loop.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { awaitsAgent, readSidecar } from './commentStore';
import { buildFolderPrompt } from './agentPrompt';
import { runAgent } from './agentRun';
import { MdReviewEditorProvider } from './editorProvider';

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
  const status = startAgent(context, folder, ws?.uri.fsPath ?? folder.fsPath, files);
  if (status) void vscode.window.showInformationMessage(status);
}

/**
 * The review inbox's Send All: every workspace folder with open reviews gets
 * its own Claude, started in that folder. When prompts only go to the
 * clipboard there is room for one, so it asks for a folder as above.
 */
export async function sendWorkspaceToClaude(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const clipboard = vscode.workspace.getConfiguration('mdReview').get<string>('agent.mode') === 'clipboard' || !vscode.workspace.isTrusted;
  if (folders.length < 2 || clipboard) return sendFolderToClaude(context);
  const sent: string[] = [];
  let status: string | null = '';
  for (const ws of folders) {
    const files = await openReviews(ws.uri);
    if (!files.length) continue;
    status = startAgent(context, ws.uri, ws.uri.fsPath, files);
    // null: nothing started (no claude found), and the user was already told.
    if (status === null) return;
    sent.push(ws.name);
  }
  if (!sent.length) void vscode.window.showInformationMessage('No open review comments in this workspace. Submit a review first.');
  else if (sent.length > 1) void vscode.window.showInformationMessage(`Sent the open reviews in ${sent.join(', ')} to Claude, each in its own terminal.`);
  else if (status) void vscode.window.showInformationMessage(status);
}

function startAgent(context: vscode.ExtensionContext, folder: vscode.Uri, cwd: string, files: { mdPath: string; open: number }[]): string | null {
  const prompt = buildFolderPrompt({
    folder: folder.fsPath,
    cwd,
    files,
    cliPath: vscode.Uri.joinPath(context.extensionUri, 'cli', 'mdreview.mjs').fsPath,
    suggest: vscode.workspace.getConfiguration('mdReview').get<string>('agent.editMode') === 'suggest',
  });
  // The copies the Changes view compares against, taken before Claude can start (as Send in a panel does).
  const before = files.map((f) => [f.mdPath, MdReviewEditorProvider.textOf(f.mdPath)] as const);
  const status = runAgent(prompt, path.basename(folder.fsPath), cwd);
  // null: nothing started, so nothing to compare against.
  if (status !== null) for (const [mdPath, text] of before) if (text !== undefined) MdReviewEditorProvider.snapshotSent(context, mdPath, text);
  return status;
}

export async function addClaudeSkill(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showInformationMessage('Trust this folder first; the skill is for running Claude Code in it.');
    return;
  }
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
