import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import vm from 'node:vm';
import { ChangeSet, EditorSelection, Text } from '@codemirror/state';
const module = { exports: {} };
vm.runInNewContext(buildSync({ entryPoints: ['webview/textChanges.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, { module, exports: module.exports });
const { externalChanges } = module.exports;
function changes(before, after) {
  const result = ChangeSet.of(externalChanges(before, after), before.length);
  assert.equal(result.apply(Text.of(before.split('\n'))).toString(), after);
  return result;
}
test('agent insertions before the caret follow the same text, not the old offset', () => {
  const before = '# Intro\n\nMy caret belongs HERE in this paragraph.\n';
  const after = '# New section\n\nExtra agent text.\n\n' + before;
  assert.equal(changes(before, after).mapPos(before.indexOf('HERE')), after.indexOf('HERE'));
});
test('multiple edits around the caret preserve a reverse selection', () => {
  const before = 'First old paragraph.\n\nKeep THIS SELECTION intact.\n\nLast old paragraph.';
  const after = 'First rewritten paragraph with more words.\n\nKeep THIS SELECTION intact.\n\nLast replacement.';
  const from = before.indexOf('THIS'), to = from + 'THIS SELECTION'.length;
  const mapped = EditorSelection.single(to, from).map(changes(before, after)).main;
  assert.equal(mapped.head, after.indexOf('THIS'));
  assert.equal(after.slice(mapped.from, mapped.to), 'THIS SELECTION');
  assert.ok(mapped.anchor > mapped.head);
});
test('edits in the same paragraph and Unicode keep source offsets correct', () => {
  const before = '😀 Old words before the caret HERE and old words after it.';
  const after = '😀 Much clearer words before the caret HERE and updated wording after it.';
  assert.equal(changes(before, after).mapPos(before.indexOf('HERE')), after.indexOf('HERE'));
});
test('deleting the caret passage leaves a valid nearest boundary', () => {
  const before = 'Before\n\nDELETE THIS PARAGRAPH\n\nAfter';
  const after = 'Before\n\nAfter';
  const mapped = changes(before, after).mapPos(before.indexOf('THIS'));
  assert.ok(mapped >= 'Before'.length && mapped <= after.length);
});
test('large rewrites preserve stable paragraphs and no-op updates make no edits', () => {
  const lines = Array.from({ length: 800 }, (_, i) => `Paragraph ${i}: unique stable words.`);
  const before = lines.join('\n\n');
  lines[2] = 'A rewritten opening.'; lines[700] = 'A rewritten ending.';
  const after = 'An inserted preface.\n\n' + lines.join('\n\n');
  assert.equal(changes(before, after).mapPos(before.indexOf('Paragraph 400:')), after.indexOf('Paragraph 400:'));
  assert.equal(externalChanges(before, before).length, 0);
});
