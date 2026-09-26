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

// ---- checking only the edited block must agree with checking the whole file ----
// The old way re-parsed the whole file for every candidate. For many edits in
// many surroundings (including ones that try to change the block's structure),
// the file written, or the refusal, must be exactly what the old way gives.
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** What the whole-file check writes for this edit, or null if it refuses. */
function wholeFile(buf, ls, le, kind, oldText, newText) {
  const src = lib.readBlock(buf, ls, le);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  for (const cand of lib.candidates(src, oldText, newText)) {
    const out = lib.spliceBlock(buf, ls, le, src, cand);
    const got = lib.plainAt(md, out.subarray(bom).toString('utf8'), ls, kind);
    if (got !== null && collapse(got) === collapse(newText)) return out;
  }
  return null;
}

/** Apply the edit the fast way (optionally with the render's tokens) and compare. */
function agrees(text, ls, le, kind, oldText, newText, withParse, where) {
  const buf = Buffer.from(text);
  const want = wholeFile(buf, ls, le, kind, oldText, newText);
  const f = setup('fuzz.md', buf);
  const plainText = text.replace(/^\uFEFF/, '');
  const rendered = withParse ? { text: plainText, ...lib.renderParsed(plainText, (x) => x).parse } : undefined;
  let got = null;
  try {
    lib.applyInlineEdit(f, ls, le, kind, oldText, newText, rendered);
    got = fs.readFileSync(f);
  } catch (err) {
    if (!(err instanceof lib.InlineMapError)) throw err;
  }
  if (want === null) assert.equal(got, null, where);
  else assert.equal(got?.toString(), want.toString(), where);
}

test('block-only verification agrees on cases found in review', () => {
  const cases = [
    // A reference definition between a heading and the paragraph.
    ['# H\n[r]: https://x.example\n"Quoted" first\nsecond line [r]\n', 2, 'paragraph', (t) => t.replace(' first', '')],
    // A closing \] that pairs with an opener above.
    ['\\[ a + b\n\nRun `cmd` now.\n', 2, 'paragraph', (t) => t.replace('cmd', 'cmd\\]')],
    // A footnote definition right below the paragraph.
    ['Second has a note[^b] here and more.\n\n[^b]: B note.\n', 0, 'paragraph', (t) => t.replace('more', 'much more')],
    // A paragraph that becomes {attrs} joins the table or list above.
    ['| a |\n|---|\n| 1 |\n\nHello world {.c}\n', 4, 'paragraph', (t) => '{' + t],
    ['- a\n\nHello world {.c}\n', 2, 'paragraph', (t) => '{' + t],
    // A footnote definition inside a quote right below.
    ['Note[^1] and[^2] then [^1] again.\n> [^1]: in quote\n', 0, 'paragraph', (t) => t.replace('again', 'once more')],
    // Table captions with the same id.
    ['Table: first {#tbl:x}\n\nTable: second {#tbl:x}\n', 2, 'paragraph', (t) => t.replace('second', 'second one')],
    [': cap {#tbl:x}\n\n: caption {#tbl:x}\n', 2, 'paragraph', (t) => t.replace('n ', '')],
    // A table id written another way still makes a typed `Table:` a caption prefix.
    ['# Intro {#sec:intro}\n\nResults by group {.wide #tbl:r}\n', 2, 'paragraph', (t) => 'Table: ' + t],
    ['# Intro {#sec:intro}\n\nResults by group {id=tbl:r}\n', 2, 'paragraph', (t) => 'Table: ' + t],
    // With a bibliography, a typed @key is a citation, which only the front matter says.
    ['---\nbibliography: refs.bib\n---\n\nAs shown before.\n', 4, 'paragraph', (t) => t.replace('before', 'by @smith2020')],
    ['---\nbibliography: refs.bib\n---\n\nAs shown before.\n', 4, 'paragraph', (t) => t.replace('before', 'by me@example.com')],
  ];
  for (const [text, ls, kind, fn] of cases) {
    const le = md.parse(text, {}).find((t) => t.type === `${kind}_open` && t.map?.[0] === ls).map[1];
    const oldText = lib.plainAt(md, text, ls, kind);
    for (const withParse of [false, true]) agrees(text, ls, le, kind, oldText, fn(oldText), withParse, JSON.stringify(text));
  }
});

test('block-only verification writes exactly what whole-file verification would', () => {
  let seed = 12345;
  const next = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rand = (n) => Math.floor(next() * n);
  const H = '## A heading with *style* here';
  const blocks = [
    'The quick **brown** fox [jumps](https://x.y) over `the` lazy dog.\nA second line with $x^2$ and [a ref][r] and a note[^1] here.',
    H,
    'Plain words only here with no markup at all.',
    '"Quoted" first\nsecond line [r] and `code` and \\\\ slash',
    'Note[^1] and[^2] then [^1] again.',
    'Setext heading text\n=====',
    'x',
    '*a*',
  ];
  const before = [
    '', 'Intro para.\n\n', '- item one\n- item two\n\n', '> quoted text\n\n', '| a | b |\n|---|---|\n| 1 | 2 |\n\n',
    '```\ncode\n```\n', '# Title\n', '[^1]: The note.\n\n', '    indented code\n\n', '<div>\nhtml\n</div>\n\n', '---\n\n', '1. first\n\n   more\n\n',
    '| a | b |\n|---|---|\n| 1 | 2 |\n', '<!-- c -->\n', '$$\nx\n$$\n', '***\n', 'Setext\n===\n', '- a\n\n  b\n\n',
    '# H\n[r]: https://x.example\n', '---\n[q]: /u\n', '```\nc\n```\n[q]: /u\n', '\\[ a+b\n\n', '[^2]: two\n\n', 'x^[inline]\n\n',
    '---\ntitle: t\n---\n', '<!--\nmulti\n-->\n', '<!--\nmulti\n-->\n\n', 'Para[^1].\n\n', '| a |\n|---|\n', '* * *\n', ' \n',
    '> q\n>\n', '[^1]: note\n    cont\n\n', '---\nbibliography: refs.bib\n---\n', '---\nbibliography: refs.bib\n---\n\nSee @fig:a.\n\n', '<pre>\nx\n\ny\n</pre>\n', '# H {#i}\n', '> a\n\n', '#\n', 'text\n \n',
  ];
  const after = [
    '', '\n', '\nNext para.\n', '\n---\n', '\n===\n', '\n|---|---|\n', '\n- list\n', '\n> quote\n', '\n    code\n',
    '\n[r]: https://ref.example\n', '\n[^1]: A note.\n', '\n$$\nx\n$$\n', '\n[^1]: A note.\n\n[^2]: two\n', '\n\n[^1]: A note.\n',
    '\n\n[r]: https://ref.example\n', '\n{.cls}\n', '\n\n{.cls}\n', '\n| x |\n|---|\n', '\n<div>\n', '\n\\]\n', '\n$$\n', '\n```\n',
    '\nfoo\n===\n', '\n  - sub\n', '\n[^3]: three\n', '\n    indented\n', '\n<!-- x -->\n', '\n# H\n',
  ];
  const inserts = [
    '|', ' | ', '- ', '\n', '    ', '# ', '> ', '1. ', '===', '---', '```', '$$', '[^1]', '^[n]', '[r]', '*', '**', '_', '`', '{.c}',
    '<div>', ' ', 'word', '\\[', ']', '[', '~~', '{++', '++}', '\n\n', '\\]', '"t"', '(t)', '[^2]', '[^3]', '[x]: /u', '\\\\', '<!--',
    '-->', '{#id}', '{--', '--}', '{>>', '<<}', '$', '\\(', '\\)', '^', '~', '<b>', '&amp;', '  \n', '\t', '---\n', '\n===\n', '\n---\n',
    '\n|---|\n', '\n\n# ', '\\', '[^1]:', '\n \n', '[r]:', '\n"Quoted"\n', '@smith', ' @fig:a', '[@a; @b]', 'x@y.z',
  ];
  let checked = 0;
  for (let n = 0; n < 2000; n++) {
    const block = blocks[rand(blocks.length)];
    const kind = block === H || /\n=+$/.test(block) ? 'heading' : 'paragraph';
    const pre = before[rand(before.length)];
    const text0 = pre + block + after[rand(after.length)] + (rand(3) === 0 ? '\n[r]: https://r.example\n\n[^1]: Note.\n' : '') + (rand(4) === 0 ? '\n[^2]: Two.\n' : '');
    const eol = rand(6);
    const text = eol === 0 ? text0.replace(/\n/g, '\r\n') : eol === 1 ? '\uFEFF' + text0 : text0;
    const plainText = text.replace(/^\uFEFF/, '');
    const ls = pre.split('\n').length - 1;
    const open = md.parse(plainText, {}).find((t) => t.type === `${kind}_open` && t.map && t.map[0] === ls && t.level === 0);
    if (!open) continue;
    const oldText = lib.plainAt(md, plainText, ls, kind);
    let newText = oldText;
    for (let e = 1 + rand(3); e > 0; e--) {
      const at = rand(newText.length + 1);
      if (rand(3) === 0) newText = newText.slice(0, at) + newText.slice(at + 1 + rand(4));
      else newText = newText.slice(0, at) + inserts[rand(inserts.length)] + newText.slice(at);
    }
    if (!collapse(newText) || collapse(newText) === collapse(oldText)) continue;
    agrees(text, ls, open.map[1], kind, oldText, newText, rand(2) === 1, `case ${n}: ${JSON.stringify(text)} edited to ${JSON.stringify(newText)}`);
    checked++;
  }
  assert.ok(checked > 1000, `only ${checked} cases ran`);
});
