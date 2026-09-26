import * as vscode from 'vscode';
import { MdReviewEditorProvider } from './editorProvider';
import { addClaudeSkill, sendFolderToClaude } from './agentCommands';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
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
    ...(
      [
        ['mdReview.undo', { type: 'command', command: 'undo' }],
        ['mdReview.redo', { type: 'command', command: 'redo' }],
        ['mdReview.find', { type: 'command', command: 'find' }],
        ['mdReview.nextComment', { type: 'command', command: 'next' }],
        ['mdReview.previousComment', { type: 'command', command: 'prev' }],
        ['mdReview.toggleOutline', { type: 'command', command: 'outline' }],
        ['mdReview.sendToClaude', { type: 'command', command: 'send' }],
        ['mdReview.addComment', { type: 'command', command: 'comment' }],
        ['mdReview.submitReview', { type: 'command', command: 'submit' }],
        ['mdReview.toggleComments', { type: 'command', command: 'comments' }],
        ['mdReview.showShortcuts', { type: 'command', command: 'shortcuts' }],
        ['mdReview.zoomIn', { type: 'command', command: 'zoomIn' }],
        ['mdReview.zoomOut', { type: 'command', command: 'zoomOut' }],
        ['mdReview.zoomReset', { type: 'command', command: 'zoomReset' }],
        ['mdReview.readingView', { type: 'command', command: 'reading' }],
      ] as const
    ).map(([id, msg]) => vscode.commands.registerCommand(id, () => MdReviewEditorProvider.postToActive(msg))),
  );
}

export function deactivate() {}
