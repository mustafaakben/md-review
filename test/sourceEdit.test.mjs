import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { spliceSource, sourceText, ReviewSession } = createRequire(import.meta.url)('../dist/lib.cjs');

test('continuous source edits retain BOM, mixed line endings and unrelated bytes', () => {
  const before = Buffer.from('\ufeff# Title\r\n\r\nA **bold** claim.\n\nLast line  \r\n');
  const original = sourceText(before.toString());
  const from = original.indexOf('bold');
  const out = spliceSource(before, original, [{ from, to: from + 4, insert: 'strong' }]);
  assert.deepEqual(out, Buffer.from('\ufeff# Title\r\n\r\nA **strong** claim.\n\nLast line  \r\n'));
});

test('continuous source transactions insert headings, paragraphs, lists and unicode', () => {
  const before = Buffer.from('Start\r\nEnd');
  const out = spliceSource(before, 'Start\nEnd', [{ from: 5, to: 5, insert: '\n\n## Heading\nA café 🚲\n\n- one\n- two' }]);
  assert.equal(out.toString(), 'Start\r\n\r\n## Heading\r\nA café 🚲\r\n\r\n- one\r\n- two\r\nEnd');
});

test('disjoint edits preserve untouched mixed endings between them', () => {
  const before = Buffer.from('One\r\nkeep\nTwo\r\n');
  const out = spliceSource(before, 'One\nkeep\nTwo\n', [{ from: 0, to: 3, insert: 'First' }, { from: 9, to: 12, insert: 'Second' }]);
  assert.equal(out.toString(), 'First\r\nkeep\nSecond\r\n');
});

test('empty documents, complete deletion, emoji boundaries and stale writes', () => {
  assert.equal(spliceSource(Buffer.alloc(0), '', [{ from: 0, to: 0, insert: '# New\n' }]).toString(), '# New\n');
  assert.equal(spliceSource(Buffer.from('\ufeffabc'), 'abc', [{ from: 0, to: 3, insert: '' }]).toString(), '\ufeff');
  assert.throws(() => spliceSource(Buffer.from('🚲'), '🚲', [{ from: 1, to: 2, insert: '' }]), /Unicode/);
  assert.throws(() => spliceSource(Buffer.from('Changed'), 'Original', [{ from: 0, to: 8, insert: 'lost' }]), /changed elsewhere/);
  assert.throws(() => spliceSource(Buffer.from('abc'), 'abc', [{ from: -1, to: 1, insert: '' }]), /Invalid/);
});

test('host acknowledges saved revisions, rejects stale ones and supports byte exact undo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-source-'));
  try {
    const file = path.join(dir, 'doc.md');
    const before = Buffer.from('\ufeffOriginal\r\n'); fs.writeFileSync(file, before);
    const messages = [];
    const session = new ReviewSession({ mdPath: file, author: () => 'Test', showResolved: () => true, post: m => messages.push(m), resolveImage: s => s, getText: () => fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''), isDirty: () => false, openLink: () => {} });
    session.render();
    session.handle({ type: 'saveSource', seq: 1, original: 'Original\n', changes: [{ from: 0, to: 8, insert: '# Heading\nMore text' }] });
    assert.equal(messages.find(m => m.type === 'sourceSaved')?.source, '# Heading\nMore text\n');
    const saved = fs.readFileSync(file);
    session.handle({ type: 'saveSource', seq: 2, original: 'Original\n', changes: [{ from: 0, to: 8, insert: 'Old tab' }] });
    assert.equal(messages.find(m => m.type === 'sourceConflict')?.seq, 2);
    assert.deepEqual(fs.readFileSync(file), saved);
    session.handle({ type: 'undo' });
    assert.deepEqual(fs.readFileSync(file), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
