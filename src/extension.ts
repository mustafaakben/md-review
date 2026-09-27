import * as vscode from 'vscode';
import { MdReviewEditorProvider } from './editorProvider';
import { addClaudeSkill, sendFolderToClaude, sendWorkspaceToClaude } from './agentCommands';
import { initAgentPrompts } from './agentRun';
import type { FromWebview } from './core';
import { InboxView } from './inboxView';
import * as render from './render';
import * as commentStore from './commentStore';
import * as bibliography from './bibliography';
import * as localImage from './localImage';

// The Word commands are their own file (dist/word.js), read on first use rather
// than at start-up. It takes these modules from this bundle instead of carrying
// its own copies (see esbuild.mjs).
export const shared = { render, commentStore, bibliography, localImage };
const word = () => require('./word.js') as typeof import('./wordCommands');

export function activate(context: vscode.ExtensionContext) {
  initAgentPrompts(context);
  // Registers the tree only; the workspace is scanned when the view is first shown.
  const inbox = new InboxView();
  context.subscriptions.push(
    inbox,
    vscode.window.registerCustomEditorProvider(MdReviewEditorProvider.viewType, new MdReviewEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('mdReview.open', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      await vscode.commands.executeCommand('vscode.openWith', target, MdReviewEditorProvider.viewType);
    }),
    vscode.commands.registerCommand('mdReview.openSource', async (uri?: vscode.Uri) => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const target = uri ?? (tab?.input instanceof vscode.TabInputCustom ? tab.input.uri : undefined);
      if (!target) return;
      await vscode.commands.executeCommand('vscode.openWith', target, 'default', vscode.ViewColumn.Beside);
    }),
    vscode.commands.registerCommand('mdReview.sendFolderToClaude', (uri?: vscode.Uri) => sendFolderToClaude(context, uri)),
    vscode.commands.registerCommand('mdReview.addClaudeSkill', () => addClaudeSkill(context)),
    vscode.commands.registerCommand('mdReview.openThread', (mdPath: string, id: string) =>
      MdReviewEditorProvider.focusThread(vscode.Uri.file(mdPath), id),
    ),
    vscode.commands.registerCommand('mdReview.inbox.refresh', () => inbox.refresh()),
    vscode.commands.registerCommand('mdReview.inbox.sendAll', () => sendWorkspaceToClaude(context)),
    vscode.commands.registerCommand('mdReview.exportWord', (uri?: vscode.Uri) => word().exportToWord(uri)),
    vscode.commands.registerCommand('mdReview.importWord', (uri?: vscode.Uri) => word().importFromWord(uri)),
    ...(
      [
        ['mdReview.undo', { type: 'command', command: 'undo' }],
        ['mdReview.redo', { type: 'command', command: 'redo' }],
        ['mdReview.find', { type: 'command', command: 'find' }],
        ['mdReview.nextComment', { type: 'command', command: 'next' }],
        ['mdReview.previousComment', { type: 'command', command: 'prev' }],
        ['mdReview.nextChange', { type: 'command', command: 'nextChange' }],
        ['mdReview.previousChange', { type: 'command', command: 'prevChange' }],
        ['mdReview.replyToThread', { type: 'command', command: 'reply' }],
        ['mdReview.toggleOutline', { type: 'command', command: 'outline' }],
        ['mdReview.sendToClaude', { type: 'command', command: 'send' }],
        ['mdReview.reviewWithClaude', { type: 'command', command: 'review' }],
        ['mdReview.addComment', { type: 'command', command: 'comment' }],
        ['mdReview.submitReview', { type: 'command', command: 'submit' }],
        ['mdReview.toggleComments', { type: 'command', command: 'comments' }],
        ['mdReview.showShortcuts', { type: 'command', command: 'shortcuts' }],
        ['mdReview.zoomIn', { type: 'command', command: 'zoomIn' }],
        ['mdReview.zoomOut', { type: 'command', command: 'zoomOut' }],
        ['mdReview.zoomReset', { type: 'command', command: 'zoomReset' }],
        ['mdReview.readingView', { type: 'command', command: 'reading' }],
        ['mdReview.severity1', { type: 'command', command: 'severity1' }],
        ['mdReview.severity2', { type: 'command', command: 'severity2' }],
        ['mdReview.severity3', { type: 'command', command: 'severity3' }],
      ] as const
    ).map(([id, msg]) => vscode.commands.registerCommand(id, () => MdReviewEditorProvider.postToActive(msg))),
  );
  // Only for test/smoke: drive the focused panel's host side the way its webview would.
  if (context.extensionMode === vscode.ExtensionMode.Test) return { handle: (msg: FromWebview) => MdReviewEditorProvider.handleInActive(msg) };
}

export function deactivate() {}
