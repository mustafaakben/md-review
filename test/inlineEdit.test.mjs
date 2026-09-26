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

// ---- checking only the edited block must agree with checking the whole file ----
// The old way re-parsed the whole file for every candidate. For many edits in
// many surroundings (including ones that try to change the block's structure),
// the file written, or the refusal, must be exactly what the old way gives.
test('block-only verification writes exactly what whole-file verification would', () => {
  let seed = 12345;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  const collapse = (s) => s.replace(/\s+/g, ' ').trim();
  const P = 'The quick **brown** fox [jumps](https://x.y) over `the` lazy dog.\nA second line with $x^2$ and [a ref][r] and a note[^1] here.';
  const H = '## A heading with *style* here';
  const before = [
    '', 'Intro para.\n\n', '- item one\n- item two\n\n', '> quoted text\n\n', '| a | b |\n|---|---|\n| 1 | 2 |\n\n',
    '```\ncode\n```\n', '# Title\n', '[^1]: The note.\n\n', '    indented code\n\n', '<div>\nhtml\n</div>\n\n', '---\n\n', '1. first\n\n   more\n\n',
    '| a | b |\n|---|---|\n| 1 | 2 |\n', '<!-- c -->\n', '$$\nx\n$$\n', '***\n', 'Setext\n===\n', '- a\n\n  b\n\n',
  ];
  const after = [
    '', '\n', '\nNext para.\n', '\n---\n', '\n===\n', '\n|---|---|\n', '\n- list\n', '\n> quote\n', '\n    code\n',
    '\n[r]: https://ref.example\n', '\n[^1]: A note.\n', '\n$$\nx\n$$\n',
  ];
  const inserts = ['|', ' | ', '- ', '\n', '    ', '# ', '> ', '1. ', '===', '---', '```', '$$', '[^1]', '^[n]', '[r]', '*', '**', '_', '`', '{.c}', '<div>', ' ', 'word', '\\[', ']', '[', '~~', '{++', '++}', '\n\n'];
  let checked = 0;
  for (let n = 0; n < 1500; n++) {
    const block = rand(4) === 0 ? H : P;
    const kind = block === H ? 'heading' : 'paragraph';
    const pre = before[rand(before.length)];
    const text0 = pre + block + after[rand(after.length)] + (rand(3) === 0 ? '\n[r]: https://r.example\n\n[^1]: Note.\n' : '');
    const text = rand(5) === 0 ? text0.replace(/\n/g, '\r\n') : text0;
    const buf = Buffer.from(text);
    const toks = md.parse(text, {});
    const ls = pre.split('\n').length - 1;
    const open = toks.find((t) => t.type === `${kind}_open` && t.map && t.map[0] === ls && t.level === 0);
    if (!open) continue;
    const le = open.map[1];
    const oldText = lib.plainAt(md, text, ls, kind);
    let newText = oldText;
    for (let e = 1 + rand(2); e > 0; e--) {
      const at = rand(newText.length + 1);
      if (rand(3) === 0) newText = newText.slice(0, at) + newText.slice(at + 1 + rand(4));
      else newText = newText.slice(0, at) + inserts[rand(inserts.length)] + newText.slice(at);
    }
    if (!collapse(newText) || collapse(newText) === collapse(oldText)) continue;

    // The old way.
    const src = lib.readBlock(buf, ls, le);
    let want = null;
    for (const cand of lib.candidates(src, oldText, newText)) {
      const out = lib.spliceBlock(buf, ls, le, src, cand);
      const got = lib.plainAt(md, out.toString('utf8'), ls, kind);
      if (got !== null && collapse(got) === collapse(newText)) {
        want = out;
        break;
      }
    }

    const f = setup('fuzz.md', buf);
    if (rand(2)) lib.renderMarkdown(text, (x) => x); // tokens of the render on screen
    let got = null;
    try {
      lib.applyInlineEdit(f, ls, le, kind, oldText, newText);
      got = fs.readFileSync(f);
    } catch (err) {
      if (!(err instanceof lib.InlineMapError)) throw err;
    }
    const where = `case ${n}: ${JSON.stringify(text)} edited to ${JSON.stringify(newText)}`;
    if (want === null) assert.equal(got, null, where);
    else assert.equal(got?.toString(), want.toString(), where);
    checked++;
  }
  assert.ok(checked > 800, `only ${checked} cases ran`);
});
