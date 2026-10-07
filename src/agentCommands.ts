// Workspace-level agent commands: send every open review under a folder to
// the folder's agent session, and connect a folder (skill, CLI and hooks).
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { awaitsAgent, readSidecar } from './commentStore';
import { buildFolderPrompt, primedSessions } from './agentPrompt';
import { agentHostFor, pickSession } from './agentRun';
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
  const status = await sendReviews(context, folder, ws?.uri.fsPath ?? folder.fsPath, files);
  if (status) void vscode.window.showInformationMessage(status);
}

/**
 * The review inbox's Send All: every workspace folder with open reviews sends
 * them to the session bound to that folder (asking for one where none is).
 */
export async function sendWorkspaceToClaude(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length < 2) return sendFolderToClaude(context);
  const sent: string[] = [];
  let status: string | null = '';
  for (const ws of folders) {
    const files = await openReviews(ws.uri);
    if (!files.length) continue;
    status = await sendReviews(context, ws.uri, ws.uri.fsPath, files);
    if (status !== null) sent.push(ws.name);
  }
  if (!sent.length && status === '') void vscode.window.showInformationMessage('No open review comments in this workspace. Submit a review first.');
  else if (sent.length > 1) void vscode.window.showInformationMessage(`Sent the open reviews in ${sent.join(', ')}, each to its folder's session.`);
  else if (status) void vscode.window.showInformationMessage(status);
}

/**
 * Deliver the folder's open reviews to its bound session. Returns a status
 * line, or null when nothing was sent (cancelled, or the user was told why).
 */
async function sendReviews(context: vscode.ExtensionContext, folder: vscode.Uri, cwd: string, files: { mdPath: string; open: number }[]): Promise<string | null> {
  const host = agentHostFor(context, cwd, path.basename(cwd));
  if (!(await pickSession(host, path.basename(cwd)))) return null;
  const local = path.join(cwd, '.claude', 'skills', 'md-review', 'mdreview.mjs');
  // A session that has had the instructions gets a reminder; `next --session` shortens what it was shown.
  const bound = host.binding();
  const key = bound && `${bound.agent}:${bound.id}`;
  const prompt = buildFolderPrompt({
    session: bound?.agent === 'claude' ? bound.id : undefined,
    primed: !!key && primedSessions.has(key),
    folder: folder.fsPath,
    cwd,
    files,
    cliPath: fs.existsSync(local) ? local : vscode.Uri.joinPath(context.extensionUri, 'cli', 'mdreview.mjs').fsPath,
    suggest: vscode.workspace.getConfiguration('mdReview').get<string>('agent.editMode') === 'suggest',
  });
  // The copies the Changes view compares against, taken before the agent can start (as Send in a panel does).
  const before = files.map((f) => [f.mdPath, MdReviewEditorProvider.textOf(f.mdPath)] as const);
  let status: string | null;
  try {
    status = await host.deliverPrompt(prompt);
  } catch (e) {
    void vscode.window.showErrorMessage((e as Error).message);
    return null;
  }
  if (status !== null && key) primedSessions.add(key);
  if (status !== null) for (const [mdPath, text] of before) if (text !== undefined) MdReviewEditorProvider.snapshotSent(context, mdPath, text);
  return status;
}

/** Connect Agents to Workspace: the skill, CLI and hooks for Claude Code in a workspace folder. */
export async function addClaudeSkill(context: vscode.ExtensionContext): Promise<void> {
  const ws = await pickWorkspaceFolder('Connect which folder to MD Review?');
  if (ws === null) return;
  if (!ws) {
    void vscode.window.showInformationMessage('Open a folder first; connecting adds to its .claude folder.');
    return;
  }
  const host = agentHostFor(context, ws.uri.fsPath, ws.name);
  try {
    const status = await host.connect?.();
    if (status) void vscode.window.showInformationMessage(status);
  } catch (e) {
    void vscode.window.showErrorMessage(`Couldn't connect ${ws.name}: ${(e as Error).message}`);
  }
}
