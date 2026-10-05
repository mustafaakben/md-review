import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
const sandbox = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(new URL('../webview/commands.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code, Object.assign(sandbox, { module: { exports: sandbox.exports } }));
const { commandForKey, isSaveReply, nativeTextHistory } = sandbox.module.exports;
const event = changes => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, getModifierState: () => false, ...changes });
test('Mac Option characters match physical keys and Windows uses Ctrl', () => {
  for (const mac of [true, false]) {
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    assert.equal(commandForKey(event({ ...mod, altKey: true, key: mac ? 'µ' : 'm', code: 'KeyM' }), mac), 'comment');
    assert.equal(commandForKey(event({ ...mod, altKey: true, code: 'KeyP' }), mac), 'comments');
    assert.equal(commandForKey(event({ ...mod, shiftKey: true, key: 'O' }), mac), 'outline');
    assert.equal(commandForKey(event({ ...mod, key: 'z' }), mac), 'undo');
    assert.equal(commandForKey(event({ ...mod, shiftKey: true, key: 'Z' }), mac), 'redo');
  }
  assert.equal(commandForKey(event({ ctrlKey: true, key: 'y' }), false), 'redo');
  assert.equal(commandForKey(event({ altKey: true, key: 'F5' }), false), 'nextChange');
  assert.equal(commandForKey(event({ metaKey: true, altKey: true, code: 'BracketRight' }), true), 'nextChange');
});
test('AltGr and extra modifiers never become comment or save commands', () => {
  assert.equal(commandForKey(event({ ctrlKey: true, altKey: true, code: 'KeyM', getModifierState: () => true }), false), null);
  for (const mac of [true, false]) {
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    assert.equal(isSaveReply(event({ ...mod, key: 'Enter' }), mac), true);
    for (const extra of [{ shiftKey: true }, { altKey: true }]) assert.equal(isSaveReply(event({ ...mod, ...extra, key: 'Enter' }), mac), false);
    assert.equal(commandForKey(event({ ...mod, shiftKey: true, altKey: true, key: 'Enter' }), mac), null);
  }
});
test('comment fields own native undo; the canvas owns its own history', () => {
  assert.equal(nativeTextHistory({ tagName: 'TEXTAREA', closest: () => null }, 'undo'), true);
  assert.equal(nativeTextHistory({ tagName: 'DIV', isContentEditable: true, closest: () => ({}) }, 'undo'), false);
  assert.equal(nativeTextHistory({ tagName: 'BUTTON', closest: () => null }, 'undo'), false);
});
