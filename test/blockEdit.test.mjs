// Byte-level proof that block edits touch only the edited lines.
// Runs the same applyBlockEdit() the extension calls, on copies of the fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp');
fs.mkdirSync(tmp, { recursive: true });

function eolCounts(buf) {
  let crlf = 0, lf = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) (i > 0 && buf[i - 1] === 0x0d ? crlf++ : lf++);
  return { crlf, lf };
}

/** Compare two buffers: identical prefix bytes, identical suffix bytes, report the differing window in line numbers. */
export function byteDiff(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const lineOf = (buf, off) => { let n = 0; for (let i = 0; i < off; i++) if (buf[i] === 0x0a) n++; return n; };
  return { prefixBytes: p, suffixBytes: s, firstChangedLine: lineOf(a, p), lastChangedLineOld: lineOf(a, a.length - s) };
}

function blocks(text) {
  const md = lib.createRenderer((s) => s);
  return md.parse(text, {}).filter((t) => t.map && t.nesting !== -1 && t.type !== 'inline');
}

for (const fixture of ['sample-crlf.md', 'sample-lf.md']) {
  const src = path.join(here, 'fixtures', fixture);
  const original = fs.readFileSync(src);
  const eol0 = eolCounts(original);
  const toks = blocks(original.toString('utf8'));
  const para = toks.find((t) => t.type === 'paragraph_open' && t.level === 0 && t.map[0] > 20);
  const heading = toks.find((t) => t.type === 'heading_open' && t.map[0] > 20);
  const row = toks.find((t) => t.type === 'tr_open' && t.map[0] > 30);
  const list = toks.find((t) => t.type === 'list_item_open');

  const cases = [
    ['paragraph', para, (s) => s.replace(/\.$/, '') + ' — EDITED.'],
    ['heading', heading, (s) => s + ' (edited)'],
    ['table row', row, (s) => s.replace('|', '| EDITED')],
    ['multi-line replacement', para, (s) => s + '\n\nA brand new second paragraph.'],
  ];
  if (list) cases.push(['list item', list, (s) => s + ' (edited)']);

  for (const [name, tok, change] of cases) {
    test(`${fixture}: ${name} edit changes only lines ${tok.map[0] + 1}-${tok.map[1]}`, () => {
      const f = path.join(tmp, `${name.replace(/\W+/g, '-')}-${fixture}`);
      fs.writeFileSync(f, original);
      const [ls, le] = tok.map;
      const before = lib.readBlock(original, ls, le);
      const after = change(before);
      const out = lib.applyBlockEdit(f, ls, le, before, after);
      const onDisk = fs.readFileSync(f);
      assert.ok(out.equals(onDisk));

      // Everything before line ls and after line le is byte-identical.
      const idxA = lib.indexLines(original);
      const from = idxA.starts[ls];
      const to = le < idxA.starts.length ? idxA.starts[le] : original.length;
      assert.ok(onDisk.subarray(0, from).equals(original.subarray(0, from)), 'prefix bytes identical');
      const tail = original.subarray(to);
      assert.ok(onDisk.subarray(onDisk.length - tail.length).equals(tail), 'suffix bytes identical');

      // The edited region reads back as the new text.
      const newLines = after.split('\n').length;
      assert.equal(lib.readBlock(onDisk, ls, ls + newLines), after);

      // EOL style preserved: no bare LF in a CRLF file, no CRLF in an LF file.
      const eol1 = eolCounts(onDisk);
      if (eol0.lf === 0) assert.equal(eol1.lf, 0, 'CRLF file stays pure CRLF');
      if (eol0.crlf === 0) assert.equal(eol1.crlf, 0, 'LF file stays pure LF');
      assert.equal(eol1.crlf + eol1.lf - (eol0.crlf + eol0.lf), newLines - (le - ls), 'line count delta');

      const d = byteDiff(original, onDisk);
      // First differing byte is never before the block (the prefix/suffix checks above are the strict proof).
      assert.ok(d.firstChangedLine >= ls, JSON.stringify(d));
    });
  }

  test(`${fixture}: stale edit is rejected and file untouched`, () => {
    const f = path.join(tmp, `stale-${fixture}`);
    fs.writeFileSync(f, original);
    const [ls, le] = para.map;
    assert.throws(() => lib.applyBlockEdit(f, ls, le, 'text that is not there', 'x'), lib.BlockEditError);
    assert.ok(fs.readFileSync(f).equals(original));
  });

  test(`${fixture}: no-op edit leaves file byte-identical`, () => {
    const f = path.join(tmp, `noop-${fixture}`);
    fs.writeFileSync(f, original);
    const [ls, le] = para.map;
    const before = lib.readBlock(original, ls, le);
    lib.applyBlockEdit(f, ls, le, before, before);
    assert.ok(fs.readFileSync(f).equals(original));
  });
}

test('mixed EOLs, BOM, and last line without newline are preserved', () => {
  const buf = Buffer.from('﻿# T\r\n\r\npara one\nstill one\r\n\r\nlast line', 'utf8');
  const out = lib.spliceBlock(buf, 2, 4, 'para one\nstill one', 'new A\nnew B\nnew C');
  assert.equal(out.toString('utf8'), '﻿# T\r\n\r\nnew A\nnew B\nnew C\r\n\r\nlast line');
  const out2 = lib.spliceBlock(buf, 5, 6, 'last line', 'final');
  assert.equal(out2.toString('utf8'), '﻿# T\r\n\r\npara one\nstill one\r\n\r\nfinal');
});
