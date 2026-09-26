// Runs inside VS Code's extension host (see run.mjs). No test framework: VS
// Code awaits run() and fails the run if it throws.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../../package.json');

async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function activeIsMdReview() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return !!tab && tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'mdReview.editor';
}

exports.run = async function run() {
  const dir = process.env.MDR_SMOKE_DIR;
  const md = path.join(dir, 'doc.md');
  const sidecar = md + '.comments.json';
  const original = fs.readFileSync(md, 'utf8');

  const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
  assert.ok(ext, 'the extension under test is loaded');

  // 1. Opens a document in MD Review.
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(md), 'mdReview.editor');
  await until(activeIsMdReview, 'the MD Review editor');
  const api = await ext.activate();
  assert.equal(typeof api?.handle, 'function', 'test hook is exported in test mode');
  // Let the webview load and ask for its first render.
  await new Promise((r) => setTimeout(r, 1500));

  // 2. Every contributed command is registered.
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const { command } of pkg.contributes.commands) assert.ok(registered.has(command), `${command} is registered`);

  // 3. Adds a comment: it lands in the sidecar.
  const anchor = { quote: 'bold claim', prefix: 'A ', suffix: ' here.', lineStart: 3, lineEnd: 3 };
  assert.equal(api.handle({ type: 'addComment', anchor, body: 'Cite this.' }), true, 'an MD Review panel is focused');
  const side = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  assert.equal(side.comments.length, 1);
  assert.equal(side.comments[0].body, 'Cite this.');
  assert.equal(side.comments[0].anchor.quote, 'bold claim');

  // 4. An inline edit rewrites just those bytes, and Undo puts them back.
  api.handle({ type: 'saveInline', ls: 2, le: 3, kind: 'paragraph', oldText: 'A bold claim here.', newText: 'A bold claim right here.' });
  assert.equal(fs.readFileSync(md, 'utf8'), original.replace('claim here', 'claim right here'));
  api.handle({ type: 'undo' });
  assert.equal(fs.readFileSync(md, 'utf8'), original);

  // 5. Each keybinding's command reaches the focused MD Review panel. (The
  // keys themselves go through VS Code's keybinding service, which the API
  // can't press; this checks the commands they are bound to are routed.)
  const bound = [...new Set(pkg.contributes.keybindings.map((k) => k.command))];
  for (const command of bound) {
    await until(activeIsMdReview, `MD Review to be focused before ${command}`, 5000);
    const routed = await vscode.commands.executeCommand(command);
    assert.equal(routed, true, `${command} reached the MD Review panel`);
    await new Promise((r) => setTimeout(r, 100)); // let the view act on it
  }

  // The view is still there and still answering.
  assert.ok(activeIsMdReview(), 'MD Review is still the active editor');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
};
