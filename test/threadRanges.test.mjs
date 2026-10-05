import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import vm from 'node:vm';
import { Text, ChangeSet } from '@codemirror/state';
import { createRequire } from 'node:module';
const module = { exports: {} };
vm.runInNewContext(buildSync({ entryPoints: ['webview/threadRanges.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, { module, exports: module.exports });
const { ThreadRangeCache, sameThreadDecorations, needsPreviewParse } = module.exports;
const thread = (id, quote, line = 1) => ({ id, status: 'submitted', anchor: { quote, lineStart: line, lineEnd: line } });
function previous(doc, threads) {
  const result = new Map();
  for (const c of threads) {
    if (c.scope === 'document' || !c.anchor.quote) continue;
    const start = doc.line(Math.max(1, Math.min(doc.lines, c.anchor.lineStart || 1))).from;
    const end = doc.line(Math.max(1, Math.min(doc.lines, c.anchor.lineEnd || 1))).to;
    const source = doc.toString(), matches = [];
    for (let at = source.indexOf(c.anchor.quote); at >= 0; at = source.indexOf(c.anchor.quote, at + 1)) matches.push(at);
    const found = matches.sort((a,b) => Math.abs(a-start)-Math.abs(b-start))[0] ?? -1;
    const from = found < 0 ? start : found, to = found < 0 ? end : from+c.anchor.quote.length;
    if (from < to) result.set(c.id,{from,to});
  }
  return [...result];
}
const plain = map => JSON.parse(JSON.stringify([...map]));
test('cached anchors exactly preserve duplicate-quote, line-hint and fallback behavior', () => {
  const doc = Text.of(['repeated phrase', '', '**repeated phrase** with markup', 'last repeated phrase', 'fallback text']);
  const threads = [thread('a','repeated phrase',1),thread('b','repeated phrase',3),thread('c','absent quote',5),thread('d','with markup',99),{...thread('e','',1),scope:'document'}];
  assert.deepEqual(plain(new ThreadRangeCache().resolve(doc,threads)),previous(doc,threads));
});
test('caret movement and reply-only updates reuse ranges; anchor changes invalidate them', () => {
  const doc = Text.of(['first quote', 'second quote']);
  const cache = new ThreadRangeCache(), threads = [thread('a','first quote')];
  const original = cache.resolve(doc,threads);
  const updated = [{...threads[0],anchor:{...threads[0].anchor},body:'New reply',workingAt:'now'}];
  assert.equal(cache.resolve(doc,updated),original);
  assert.equal(sameThreadDecorations(threads,updated),true);
  assert.equal(sameThreadDecorations(threads,[{...threads[0],status:'resolved'}]),false);
  updated[0].anchor.quote = 'second quote'; updated[0].anchor.lineStart=2; updated[0].anchor.lineEnd=2;
  const reanchored=cache.resolve(doc,updated);
  assert.notEqual(reanchored,original);
  assert.equal(reanchored.get('a').from,12);
});
test('typing and external edits invalidate cached source positions', () => {
  const doc = Text.of(['keep this quote']);
  const cache = new ThreadRangeCache(), threads = [thread('a','keep this quote')];
  cache.resolve(doc,threads);
  const next=ChangeSet.of({from:0,insert:'Inserted above.\n'},doc.length).apply(doc);
  assert.equal(cache.resolve(next,threads).get('a').from,16);
  assert.deepEqual(plain(cache.resolve(next,threads)),previous(next,threads));
});
test('plain prose skips HTML parsing while every supported rich block remains eligible', () => {
  const {renderParsed} = createRequire(import.meta.url)('../dist/lib.cjs');
  for(const source of ['A plain paragraph.', '# Heading\n\nOrdinary **bold** words.', '- First\n- Second']) {
    assert.ok(renderParsed(source,x=>x).blocks.every(block=>!needsPreviewParse(block)));
  }
  for(const source of ['|A|B|\n|-|-|\n|1|2|', '```js\nconst n=1;\n```', '$x^2$', '![Image](image.png)', '---\ntitle: Title\n---\n', 'Text[^1].\n\n[^1]: Footnote.']) {
    assert.ok(renderParsed(source,x=>x).blocks.some(needsPreviewParse),source);
  }
  assert.equal(needsPreviewParse('<a class="mdr-cite" href="#ref">Citation</a>'),true);
  assert.equal(needsPreviewParse('<span class="mdr-xref">Figure 1</span>'),true);
  assert.equal(needsPreviewParse('<div class="mdr-refs">References</div>'),true);
});
