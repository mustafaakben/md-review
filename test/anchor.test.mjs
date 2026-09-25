// Re-anchoring logic (pure string part of webview/anchor.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'tmp', 'anchor.cjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
esbuild.buildSync({ entryPoints: [path.join(here, '..', 'webview', 'anchor.ts')], outfile: out, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' });
const { locate } = createRequire(import.meta.url)(out);

const text = 'Intro. The cat sat on the mat. Later, the cat sat on the sofa. End.';
const at = (t, r) => (r ? t.slice(r[0], r[1]) : null);

test('context picks the right one of two identical quotes', () => {
  const r = locate(text, { quote: 'the cat sat', prefix: 'Later, ', suffix: ' on the sofa' });
  assert.equal(r[0], text.indexOf('the cat sat on the sofa'));
});

test('survives edits elsewhere (shifted offsets)', () => {
  const edited = 'A brand new first sentence. ' + text;
  const r = locate(edited, { quote: 'sat on the mat', prefix: 'Intro. The cat ', suffix: '. Later, the cat' });
  assert.equal(at(edited, r), 'sat on the mat');
});

test('survives an edit right next to the quote (one side of context still matches)', () => {
  const edited = text.replace('Intro. The', 'Preface. A');
  const r = locate(edited, { quote: 'cat sat on the mat', prefix: 'Intro. The ', suffix: '. Later, the cat sat' });
  assert.equal(at(edited, r), 'cat sat on the mat');
});

test('whitespace-insensitive fallback (reflowed line breaks)', () => {
  const edited = text.replace('sat on the mat', 'sat on\n  the mat');
  const r = locate(edited, { quote: 'sat on the mat', prefix: 'Intro. The cat ', suffix: '. Later' });
  assert.equal(at(edited, r), 'sat on\n  the mat');
});

test('short quote whose context vanished is orphaned, not moved elsewhere', () => {
  const doc = 'Body: we discuss things here. References: Smith. The paradox. Journal.';
  const r = locate(doc, { quote: 'The paradox', prefix: 'for technology adoption. ', suffix: ' describes how automating' });
  assert.equal(r, null);
});

test('deleted text is orphaned', () => {
  assert.equal(locate(text, { quote: 'the dog barked', prefix: '', suffix: '' }), null);
});
