// Seamless (rendered-text) edits mapped back to Markdown: markup preserved,
// only the edited lines change, unverifiable edits rejected without writing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'inline');
fs.mkdirSync(tmp, { recursive: true });
const md = lib.createRenderer((x) => x);

function setup(name, content) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, content);
  return f;
}

/** Edit the rendered text of block (ls, le, kind) with fn; return new file text. */
function edit(f, ls, le, kind, fn) {
  const text = fs.readFileSync(f, 'utf8');
  const oldText = lib.plainAt(md, text, ls, kind);
  lib.applyInlineEdit(f, ls, le, kind, oldText, fn(oldText));
  return fs.readFileSync(f, 'utf8');
}

test('plain word replacement in a paragraph', () => {
  const f = setup('a.md', '# T\n\nThe cat sat on the mat.\n');
  assert.equal(edit(f, 2, 3, 'paragraph', (t) => t.replace('cat', 'dog')), '# T\n\nThe dog sat on the mat.\n');
});

test('edit inside bold keeps the bold markers', () => {
  const f = setup('b.md', 'A **very bold** claim.\n');
  assert.equal(edit(f, 0, 1, 'paragraph', (t) => t.replace('very bold', 'quite bold')), 'A **quite bold** claim.\n');
});

test('deleting a whole bold word removes its markers too', () => {
  const f = setup('c.md', 'A **bold** claim.\n');
  assert.equal(edit(f, 0, 1, 'paragraph', (t) => t.replace('bold ', '')), 'A claim.\n');
});

test('link text edit keeps the URL', () => {
  const f = setup('d.md', 'See [the docs](https://example.com/x) for more.\n');
  assert.equal(edit(f, 0, 1, 'paragraph', (t) => t.replace('the docs', 'our docs')), 'See [our docs](https://example.com/x) for more.\n');
});

test('typing after a link lands after the URL', () => {
  const f = setup('e.md', 'See [the docs](https://example.com/x) for more.\n');
  assert.equal(edit(f, 0, 1, 'paragraph', (t) => t.replace('for more', 'now for more')), 'See [the docs](https://example.com/x) now for more.\n');
});

test('heading edit keeps the # marker', () => {
  const f = setup('h.md', '## 1.1. Measurement Gap\n\nText.\n');
  assert.equal(edit(f, 0, 1, 'heading', (t) => t.replace('Gap', 'Gaps')), '## 1.1. Measurement Gaps\n\nText.\n');
});

test('soft-wrapped paragraph edit across the line break', () => {
  const f = setup('w.md', 'first line of text\nsecond line here\n');
  assert.equal(edit(f, 0, 2, 'paragraph', (t) => t.replace('text\nsecond', 'prose, second')), 'first line of prose, second line here\n');
});

test('a lone * is literal text and is accepted as typed', () => {
  const f = setup('y.md', 'Plain words here.\n');
  assert.equal(edit(f, 0, 1, 'paragraph', () => 'Plain *words here.'), 'Plain *words here.\n');
});

test('unverifiable edit (text that would render differently) is rejected and nothing is written', () => {
  const f = setup('x.md', 'Plain words here.\n');
  const before = fs.readFileSync(f);
  const oldText = lib.plainAt(md, before.toString(), 0, 'paragraph');
  assert.throws(() => lib.applyInlineEdit(f, 0, 1, 'paragraph', oldText, 'Plain **words** here.'), lib.InlineMapError);
  assert.ok(fs.readFileSync(f).equals(before));
});

test('stale view (text changed on disk) is rejected', () => {
  const f = setup('s.md', 'Old text.\n');
  assert.throws(() => lib.applyInlineEdit(f, 0, 1, 'paragraph', 'Different text.', 'New text.'), lib.BlockEditError);
});

// ---- on the manuscript-shaped CRLF fixture (see test/make-fixtures.mjs) ----
const fixture = fs.readFileSync(path.join(here, 'fixtures', 'sample-crlf.md'));
function onFixture(name, ls, le, kind, fn, expectLine) {
  test(`sample-crlf.md: ${name}`, () => {
    const f = setup('m-' + name.replace(/\W+/g, '-') + '.md', fixture);
    edit(f, ls, le, kind, fn);
    const out = fs.readFileSync(f);
    const idx = lib.indexLines(fixture);
    const from = idx.starts[ls];
    const to = idx.starts[le];
    assert.ok(out.subarray(0, from).equals(fixture.subarray(0, from)), 'bytes before block identical');
    assert.ok(out.subarray(out.length - (fixture.length - to)).equals(fixture.subarray(to)), 'bytes after block identical');
    assert.equal(out.toString('utf8').split('\r\n')[ls], expectLine);
    assert.ok(!/[^\r]\n/.test(out.toString('latin1')), 'still pure CRLF');
  });
}
const lines = fixture.toString('utf8').split('\r\n');
onFixture('keywords line with ***bold-italic*** label', 4, 5, 'paragraph', (t) => t.replace('measurement', 'measurement invariance'), lines[4].replace(/measurement$/, 'measurement invariance'));
onFixture('bold table header cell', 30, 31, 'tr', (t) => t.replace('Station function', 'Stop function'), lines[30].replace('**Station function**', '**Stop function**'));
onFixture('table body cell', 32, 33, 'tr', (t) => t.replace('variable demand', 'fluctuating demand'), lines[32].replace('variable demand', 'fluctuating demand'));
onFixture('paragraph with citations', 10, 11, 'paragraph', (t) => t.replace('(Rivera & Chen, 2021)', '(Rivera & Chen, 2021, p. 52)'), lines[10].replace('(Rivera & Chen, 2021)', '(Rivera & Chen, 2021, p. 52)'));
onFixture('italic *Note.* paragraph', 82, 83, 'paragraph', (t) => t.replace('Note.', 'Notes.'), lines[82].replace('*Note.*', '*Notes.*'));

test('the last list item, which owns the blank line after it, edits in place', () => {
  for (const eol of ['\n', '\r\n']) {
    const src = ['# T', '', '- one item', '- three item', '', 'After para.', ''].join(eol);
    const f = setup('lastitem.md', src);
    assert.equal(edit(f, 3, 5, 'list_item', (t) => t.replace('three', 'third')), src.replace('three', 'third'));
  }
});

test('the source editor keeps the blank line after the last list item', () => {
  const src = '- one\n- two\n\nAfter.\n';
  const f = setup('lastitem-src.md', src);
  lib.applyBlockEdit(f, 1, 3, lib.readBlock(fs.readFileSync(f), 1, 3), '- two, edited\n');
  assert.equal(fs.readFileSync(f, 'utf8'), '- one\n- two, edited\n\nAfter.\n');
});
