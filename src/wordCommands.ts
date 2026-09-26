// Word round-trip commands: export the Markdown and its threads to a .docx
// with real Word comments, and import a reviewer's Word comments (and tracked
// changes) back as draft threads. The work lives in docx.ts / wordImport.ts.
// Loaded on first use (see extension.ts).
//
// In Restricted Mode both commands still work, within the view's own rules:
// images and the bibliography are read only from the document's folder and the
// workspace, export writes only <file>.docx beside the Markdown and doesn't
// offer to open it in another program, and import reads only the .docx you
// pick and writes only the comments file. Nothing is run.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as store from './commentStore';
import { exportDocx } from './docx';
import { importDocx } from './wordImport';
import { LIMITS } from './zip';

const VIEW_TYPE = 'mdReview.editor';
const plural = (n: number, word: string, many = word + 's') => `${n} ${n === 1 ? word : many}`;

/** The Markdown file the command is about: the argument, the active MD Review tab, or the active editor. */
function targetMarkdown(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri instanceof vscode.Uri && uri.scheme === 'file') return uri;
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === VIEW_TYPE) return tab.input.uri;
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && doc.uri.scheme === 'file' && (doc.languageId === 'markdown' || /\.md$/i.test(doc.uri.fsPath))) return doc.uri;
  return undefined;
}

/** What the view shows: the editor buffer when the file is open, else the disk. */
function currentText(uri: vscode.Uri): string {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  return (open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8')).replace(/^﻿/, '');
}

/** Restricted Mode: the folders a document may make us read, as in the view. */
function readableRoots(mdPath: string): string[] | undefined {
  if (vscode.workspace.isTrusted) return undefined;
  return [path.dirname(mdPath), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)];
}

function readThreads(mdPath: string): store.Comment[] | undefined {
  try {
    return store.readSidecar(mdPath).comments;
  } catch (e) {
    void vscode.window.showErrorMessage(`Couldn't read ${path.basename(store.sidecarPath(mdPath))}: ${(e as Error).message}`);
    return undefined;
  }
}

export async function exportToWord(uri?: vscode.Uri): Promise<void> {
  const md = targetMarkdown(uri);
  if (!md) {
    void vscode.window.showInformationMessage('Open a Markdown file (in MD Review or the text editor) to export it to Word.');
    return;
  }
  const mdPath = md.fsPath;
  const replies: vscode.QuickPickItem = { label: 'Include replies', description: 'as extra paragraphs in each Word comment', picked: true };
  const resolved: vscode.QuickPickItem = { label: 'Include resolved threads', picked: false };
  const picks = await vscode.window.showQuickPick([replies, resolved], {
    canPickMany: true,
    title: `Export ${path.basename(mdPath)} to Word`,
    placeHolder: 'Open threads are always exported. Check what else to include, then press Enter.',
  });
  if (!picks) return;
  const comments = readThreads(mdPath);
  if (!comments) return;

  const out = path.join(path.dirname(mdPath), path.basename(mdPath).replace(/\.(md|markdown|mdown|mkd)$/i, '') + '.docx');
  const name = path.basename(out);
  if (fs.existsSync(out)) {
    const replace = 'Replace';
    const ok = await vscode.window.showWarningMessage(`${name} already exists. Replace it?`, { modal: true }, replace);
    if (ok !== replace) return;
  }
  let res: ReturnType<typeof exportDocx>;
  try {
    res = exportDocx({
      markdown: currentText(md),
      comments,
      docDir: path.dirname(mdPath),
      readableRoots: readableRoots(mdPath),
      includeReplies: picks.includes(replies),
      includeResolved: picks.includes(resolved),
    });
    fs.writeFileSync(out, res.docx);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const hint = err.code === 'EBUSY' || err.code === 'EPERM' ? ' If it is open in Word, close it and try again.' : '';
    void vscode.window.showErrorMessage(`Couldn't export ${name}: ${err.message}.${hint}`);
    return;
  }
  const what = res.exported ? `with ${plural(res.exported, 'comment')}` : 'with no comments';
  const lost = res.unanchored ? ` (${res.unanchored} whose text wasn't found are listed at the end)` : '';
  const open = 'Open';
  const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal';
  // Opening hands the file to another program: not in Restricted Mode, and not from a remote window (the file isn't on this machine).
  const actions = vscode.workspace.isTrusted && !vscode.env.remoteName ? [open, reveal] : [reveal];
  const pick = await vscode.window.showInformationMessage(`Exported ${name} ${what}${lost}.`, ...actions);
  if (pick === open) void vscode.env.openExternal(vscode.Uri.file(out));
  else if (pick === reveal) void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(out));
}

export async function importFromWord(uri?: vscode.Uri): Promise<void> {
  const md = targetMarkdown(uri);
  if (!md) {
    void vscode.window.showInformationMessage('Open the Markdown file the Word document was made from, then import its comments.');
    return;
  }
  const mdPath = md.fsPath;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    defaultUri: vscode.Uri.file(path.dirname(mdPath)),
    filters: { 'Word documents': ['docx'] },
    openLabel: 'Import Comments',
    title: `Import Word comments into ${path.basename(mdPath)}`,
  });
  if (!picked?.length) return;
  const docxPath = picked[0].fsPath;
  const existing = readThreads(mdPath);
  if (!existing) return;
  let res: ReturnType<typeof importDocx>;
  try {
    // A regular file of sane size: never a device or a pipe, which would not finish.
    const st = fs.statSync(docxPath);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > LIMITS.file) throw new Error(`it is over ${LIMITS.file / 1024 / 1024} MB`);
    res = importDocx(currentText(md), fs.readFileSync(docxPath), { docDir: path.dirname(mdPath), readableRoots: readableRoots(mdPath), existing });
  } catch (e) {
    void vscode.window.showErrorMessage(`Couldn't read ${path.basename(docxPath)}: ${(e as Error).message}`);
    return;
  }
  const dupNote = res.duplicates ? ` ${plural(res.duplicates, 'comment')} already here ${res.duplicates === 1 ? 'was' : 'were'} skipped.` : '';
  if (!res.comments.length && !res.replies.length) {
    void vscode.window.showInformationMessage(`No new comments in ${path.basename(docxPath)}.${dupNote}`);
    return;
  }
  try {
    store.mutate(mdPath, (d) => {
      d.comments.push(...res.comments);
      for (const { id, reply } of res.replies) d.comments.find((c) => c.id === id)?.replies.push(reply);
    });
  } catch (e) {
    void vscode.window.showErrorMessage(`Couldn't save the imported comments: ${(e as Error).message}`);
    return;
  }
  const parts = [`Imported ${plural(res.imported, 'comment')}`];
  if (res.unplaced) parts[0] += ` (${res.unplaced} could not be placed; added as document comments)`;
  if (res.changes) parts.push(`${res.changes} of them from tracked changes, with suggested edits`);
  if (res.replies.length) parts.push(`${plural(res.replies.length, 'reply', 'replies')} to existing threads`);
  const msg = `${parts.join(', ')}.${dupNote} They are drafts: review them, then submit.`;
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const showing = tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === VIEW_TYPE && tab.input.uri.toString() === md.toString();
  const open = 'Open in MD Review';
  const pick = await vscode.window.showInformationMessage(msg, ...(showing ? [] : [open]));
  if (pick === open) void vscode.commands.executeCommand('vscode.openWith', md, VIEW_TYPE);
}
