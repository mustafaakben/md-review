// Word round-trip: zip container, .docx export with comments, import back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const sample = fs.readFileSync(path.join(fixtures, 'sample-lf.md'), 'utf8');

/** A thread quoting `text` in the rendered document, as the view would capture it. */
function thread(model, text, body, extra = {}) {
  const i = model.text.indexOf(text);
  assert.ok(i >= 0, `fixture text not found: ${text}`);
  const q = lib.quoteAt(model.text, i, i + text.length);
  return {
    id: `c_${Math.random().toString(36).slice(2, 8)}`,
    author: 'Ada Rivera',
    createdAt: '2026-09-20T10:00:00.000Z',
    anchor: { quote: q.quote, prefix: q.prefix, suffix: q.suffix, lineStart: 1, lineEnd: 1 },
    body,
    status: 'submitted',
    submittedAt: '2026-09-20T10:00:00.000Z',
    resolvedAt: null,
    replies: [],
    ...extra,
  };
}

/** Strict enough well-formedness check: balanced tags, legal entities, no raw < or &. */
function assertWellFormed(xml, name) {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[6]) assert.fail(`${name}: stray "<" at ${m.index}: ${body.slice(m.index, m.index + 40)}`);
    const text = m[5] ?? m[3] ?? '';
    const amp = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(text);
    if (amp) assert.fail(`${name}: bare "&" near ${text.slice(Math.max(0, amp.index - 20), amp.index + 20)}`);
    if (m[5] !== undefined) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `${name}: mismatched </${m[2]}>`);
    else if (!m[4]) stack.push(m[2]);
  }
  assert.deepEqual(stack, [], `${name}: unclosed ${stack.join(', ')}`);
}

/** Text of document.xml between commentRangeStart and commentRangeEnd of comment `id`. */
function commentedText(docXml, id) {
  const a = docXml.indexOf(`<w:commentRangeStart w:id="${id}"/>`);
  const b = docXml.indexOf(`<w:commentRangeEnd w:id="${id}"/>`);
  assert.ok(a >= 0 && b > a, `comment ${id} has a range`);
  const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return [...docXml.slice(a, b).matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<\/w:p>/g)].map((x) => (x[1] === undefined ? '\n' : unxml(x[1]))).join('');
}

test('zip: what is written reads back byte for byte', () => {
  const random = Buffer.alloc(5000);
  for (let i = 0; i < random.length; i++) random[i] = (i * 7919 + 13) % 251; // incompressible-ish: stored
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>'.repeat(200)) },
    { name: 'word/média ünïcode.xml', data: Buffer.from('héllo wörld') },
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'bin/random.bin', data: random },
  ];
  const zip = lib.writeZip(entries);
  const back = lib.readZip(zip);
  assert.deepEqual([...back.keys()], entries.map((e) => e.name));
  for (const e of entries) assert.ok(back.get(e.name).equals(e.data), e.name);
  assert.equal(lib.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.throws(() => lib.readZip(Buffer.from('not a zip at all, sorry')), /Not a ZIP/);
});

test('model text is the view text: paragraphs, lists, math, footnotes', () => {
  const m = lib.buildDocModel('# Title\n\nSome *em* and `code`.\n\n- one\n- two\n\nMath $x$ here.[^1]\n\n[^1]: Note.\n');
  assert.match(m.text, /^Title\nSome em and code\.\n\none\ntwo\n\nMath x\S* here\.\[1\]/);
  const h = m.blocks[0];
  assert.equal(h.style, 'Heading1');
  assert.equal(lib.linesAt(m, m.text.indexOf('Math'), m.text.indexOf('Math') + 4)[0], 8);
});

test('export: three threads become Word comments on exactly their quotes', () => {
  const model = lib.buildDocModel(sample, { docDir: fixtures });
  const threads = [
    thread(model, 'Station density explained the largest share of variance', 'Cite the <effect> & "size" here.', {
      replies: [{ id: 'r1', author: 'Claude', createdAt: '2026-09-21T09:00:00Z', body: 'Added 5 < 6 & done.' }],
    }),
    thread(model, 'Denser station networks would increase weekly trips', 'Is this directional?', { kind: 'question', severity: 'minor' }),
    thread(model, 'Median detour length in meters', 'Units ok?'), // inside a table cell
  ];
  const res = lib.exportDocx({ markdown: sample, comments: threads, docDir: fixtures, includeReplies: true });
  assert.equal(res.exported, 3);
  assert.equal(res.anchored, 3);
  assert.equal(res.unanchored, 0);

  const files = lib.readZip(res.docx);
  for (const f of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/comments.xml', 'word/commentsExtended.xml', 'word/_rels/document.xml.rels']) {
    assert.ok(files.has(f), f);
    if (f.endsWith('.xml') || f.endsWith('.rels')) assertWellFormed(files.get(f).toString('utf8'), f);
  }
  const types = files.get('[Content_Types].xml').toString();
  assert.match(types, /PartName="\/word\/document.xml" ContentType="application\/vnd.openxmlformats-officedocument.wordprocessingml.document.main\+xml"/);
  assert.match(types, /PartName="\/word\/comments.xml" ContentType="application\/vnd.openxmlformats-officedocument.wordprocessingml.comments\+xml"/);
  assert.ok(files.has('word/media/image1.png'), 'the local figure is embedded');

  const doc = files.get('word/document.xml').toString();
  // Comments are numbered in document order, each reply right after its thread, on the same text.
  assert.equal(commentedText(doc, 0), 'Station density explained the largest share of variance');
  assert.equal(commentedText(doc, 1), 'Station density explained the largest share of variance');
  assert.equal(commentedText(doc, 2), 'Median detour length in meters');
  assert.equal(commentedText(doc, 3), 'Denser station networks would increase weekly trips');
  for (const id of [0, 1, 2, 3]) assert.match(doc, new RegExp(`<w:commentReference w:id="${id}"/>`));
  assert.match(doc, /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Abstract</);
  assert.match(doc, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="\d+"\/><\/w:numPr>/);
  assert.match(doc, /<w:tbl>/);

  const comments = files.get('word/comments.xml').toString();
  assert.match(comments, /w:author="Ada Rivera"[^>]*w:initials="AR"/);
  assert.match(comments, /Cite the &lt;effect&gt; &amp; &quot;size&quot; here\./);
  // The reply is a Word reply: its own comment, threaded under the first in commentsExtended.xml.
  assert.match(comments, /<w:comment w:id="1" w:author="Claude" w:date="2026-09-21T09:00:00Z" w:initials="C">.*?Added 5 &lt; 6 &amp; done\.<\/w:t>/);
  const ext = files.get('word/commentsExtended.xml').toString();
  assert.match(ext, /<w15:commentEx w15:paraId="10000001" w15:paraIdParent="10000000" w15:done="0"\/>/);
  assert.match(comments, /<w:p w14:paraId="10000001" /);
  assert.match(comments, /\[question · minor\]/);
  assert.doesNotMatch(comments, /<effect>/);
});

test('export: resolved threads and replies follow the options; orphans are listed at the end', () => {
  const model = lib.buildDocModel(sample, { docDir: fixtures });
  const threads = [
    thread(model, 'Riders use them for commuting', 'Fine.', { status: 'resolved', replies: [{ id: 'r', author: 'Claude', createdAt: '2026-09-21T09:00:00Z', body: 'Thanks' }] }),
    { ...thread(model, 'Abstract', 'Overall this reads well.'), scope: 'document', anchor: { quote: '', prefix: '', suffix: '', lineStart: 0, lineEnd: 0 } },
    { ...thread(model, 'Abstract', 'This text was cut & moved.'), anchor: { quote: 'a sentence that is no longer in the file', prefix: 'x', suffix: 'y', lineStart: 3, lineEnd: 3 } },
  ];
  const open = lib.exportDocx({ markdown: sample, comments: threads, docDir: fixtures });
  assert.equal(open.exported, 2);
  assert.equal(open.unanchored, 1);
  const doc = lib.readZip(open.docx).get('word/document.xml').toString();
  // The document thread sits on the first paragraph; the orphan under its own heading.
  assert.equal(commentedText(doc, 0), 'Abstract');
  assert.match(doc, /Unanchored comments/);
  assert.equal(commentedText(doc, 1), '“a sentence that is no longer in the file”');
  const comments = lib.readZip(open.docx).get('word/comments.xml').toString();
  assert.match(comments, /This text was cut &amp; moved\./);
  assert.doesNotMatch(comments, /Fine\./);

  const all = lib.exportDocx({ markdown: sample, comments: threads, docDir: fixtures, includeResolved: true });
  assert.equal(all.exported, 3);
  const c2 = lib.readZip(all.docx).get('word/comments.xml').toString();
  assert.match(c2, /Fine\./);
  assert.doesNotMatch(c2, /Thanks/); // replies off
  assert.match(lib.readZip(all.docx).get('word/commentsExtended.xml').toString(), /w15:done="1"/); // resolved
  const c3 = lib.readZip(lib.exportDocx({ markdown: sample, comments: threads, includeResolved: true, includeReplies: true }).docx).get('word/comments.xml').toString();
  assert.match(c3, /w:author="Claude"[^>]*>.*?Thanks/);
});

test('round trip: an exported .docx imports back onto the same quotes', () => {
  const model = lib.buildDocModel(sample, { docDir: fixtures });
  const threads = [
    thread(model, 'Station density explained the largest share of variance', 'Cite the <effect> & "size" here.'),
    thread(model, 'Denser station networks would increase weekly trips', 'Is this directional?', { kind: 'question', severity: 'major' }),
    thread(model, 'Median detour length in meters', 'Units ok?'),
    { ...thread(model, 'Abstract', 'Whole thing: tighten.'), scope: 'document', anchor: { quote: '', prefix: '', suffix: '', lineStart: 0, lineEnd: 0 } },
    { ...thread(model, 'Abstract', 'Lost one.'), anchor: { quote: 'gone from the text', prefix: '', suffix: '', lineStart: 0, lineEnd: 0 } },
  ];
  const { docx } = lib.exportDocx({ markdown: sample, comments: threads, docDir: fixtures });
  const res = lib.importDocx(sample, docx, { docDir: fixtures });
  assert.equal(res.imported, 5);
  assert.equal(res.unplaced, 1);
  const byBody = new Map(res.comments.map((c) => [c.body, c]));
  for (const t of threads.slice(0, 3)) {
    const c = byBody.get(t.body);
    assert.ok(c, `imported: ${t.body}`);
    assert.equal(c.origin, 'word');
    assert.equal(c.status, 'draft');
    assert.equal(c.author, 'Ada Rivera');
    assert.equal(c.anchor.quote, t.anchor.quote);
    assert.deepEqual(lib.locate(model.text, c.anchor), lib.locate(model.text, t.anchor));
    assert.ok(c.anchor.lineStart > 0 && c.anchor.lineEnd >= c.anchor.lineStart);
  }
  assert.equal(byBody.get('Is this directional?').kind, 'question');
  assert.equal(byBody.get('Is this directional?').severity, 'major');
  assert.equal(byBody.get('Whole thing: tighten.').scope, 'document');
  const lost = res.comments.find((c) => c.body.endsWith('Lost one.'));
  assert.equal(lost.scope, 'document');
  assert.ok(lost.body.startsWith('“gone from the text”'), lost.body);

  // Importing into the sidecar it came from adds nothing.
  const again = lib.importDocx(sample, docx, { docDir: fixtures, existing: threads });
  assert.equal(again.comments.length, 0);
  assert.equal(again.duplicates, 5);
});

// A .docx the way Word writes one after review: comments, a threaded reply,
// tracked changes, and a comment on text the Markdown no longer has.
function wordReviewedDocx() {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
  const r = (t) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${r('Abstract')}</w:p>
<w:p>${r('Shared bicycles change how residents plan ')}<w:commentRangeStart w:id="7"/>${r('short ')}${r('trips')}<w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>${r(', choose routes, and combine modes of transport. We describe a ')}<w:del w:id="20" w:author="Prof. Kim" w:date="2026-09-25T08:00:00Z"><w:r><w:delText>fictional</w:delText></w:r></w:del><w:ins w:id="21" w:author="Prof. Kim" w:date="2026-09-25T08:00:00Z"><w:r><w:t>hypothetical</w:t></w:r></w:ins>${r(' study of 1,204 riders')}<w:ins w:id="22" w:author="Prof. Kim" w:date="2026-09-25T08:01:00Z"><w:r><w:t xml:space="preserve"> in total</w:t></w:r></w:ins>${r(' across six cities.')}</w:p>
<w:p><w:commentRangeStart w:id="8"/>${r('A sentence Word has &amp; the Markdown lacks.')}<w:commentRangeEnd w:id="8"/><w:r><w:commentReference w:id="8"/></w:r></w:p>
<w:p>${r('City bike-share systems now operate in hundreds of cities.')}<w:commentRangeStart w:id="9"/><w:commentRangeEnd w:id="9"/><w:r><w:commentReference w:id="9"/></w:r></w:p>
<w:sectPr/></w:body></w:document>`;
  const comments = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W}>
<w:comment w:id="7" w:author="Prof. Kim" w:date="2026-09-25T07:00:00Z" w:initials="PK"><w:p w14:paraId="0000A001"><w:r><w:annotationRef/></w:r><w:r><w:t>Which trips? Say &lt;short&gt; means under 3 km.</w:t></w:r></w:p></w:comment>
<w:comment w:id="10" w:author="Ada Rivera" w:date="2026-09-25T09:00:00Z" w:initials="AR"><w:p w14:paraId="0000A002"><w:r><w:annotationRef/></w:r><w:r><w:t>Will do.</w:t></w:r></w:p></w:comment>
<w:comment w:id="8" w:author="Prof. Kim" w:date="2026-09-25T07:05:00Z"><w:p w14:paraId="0000A003"><w:r><w:t>Cut this.</w:t></w:r></w:p><w:p w14:paraId="0000A004"><w:r><w:t>Second paragraph.</w:t></w:r></w:p></w:comment>
<w:comment w:id="9" w:author="Prof. Kim" w:date="2026-09-25T07:06:00Z"><w:p w14:paraId="0000A005"><w:r><w:t>Point comment.</w:t></w:r></w:p></w:comment>
</w:comments>`;
  const ext = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:commentsEx ${W}><w15:commentEx w15:paraId="0000A001" w15:done="0"/><w15:commentEx w15:paraId="0000A002" w15:paraIdParent="0000A001" w15:done="0"/><w15:commentEx w15:paraId="0000A004" w15:done="0"/></w15:commentsEx>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rId10" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/></Relationships>`;
  const b = (s) => Buffer.from(s, 'utf8');
  return lib.writeZip([
    { name: '[Content_Types].xml', data: b('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'word/document.xml', data: b(doc) },
    { name: 'word/comments.xml', data: b(comments) },
    { name: 'word/commentsExtended.xml', data: b(ext) },
    { name: 'word/_rels/document.xml.rels', data: b(rels) },
  ]);
}

test('import: Word comments, a threaded reply, tracked changes, and text that is gone', () => {
  const res = lib.importDocx(sample, wordReviewedDocx(), { docDir: fixtures });
  const model = lib.buildDocModel(sample, { docDir: fixtures });
  const find = (re) => res.comments.find((c) => re.test(c.body));

  const trips = find(/^Which trips/);
  assert.equal(trips.body, 'Which trips? Say <short> means under 3 km.');
  assert.equal(trips.author, 'Prof. Kim');
  assert.equal(trips.createdAt, '2026-09-25T07:00:00.000Z');
  assert.equal(trips.anchor.quote, 'short trips');
  assert.equal(trips.anchor.lineStart, 3);
  assert.equal(trips.replies.length, 1, 'the Word reply joins its thread');
  assert.equal(trips.replies[0].author, 'Ada Rivera');
  assert.equal(trips.replies[0].body, 'Will do.');
  assert.ok(lib.locate(model.text, trips.anchor));

  const gone = find(/Cut this/);
  assert.equal(gone.scope, 'document');
  assert.equal(gone.body, '“A sentence Word has & the Markdown lacks.”\n\nCut this.\nSecond paragraph.');

  const point = find(/Point comment/);
  assert.equal(point.anchor.quote, 'cities.', 'a comment on a point takes the word next to it');

  const repl = find(/^Replace “fictional” with “hypothetical”/);
  assert.equal(repl.anchor.quote, 'fictional');
  assert.equal(repl.suggestion.text, 'hypothetical');
  assert.equal(repl.author, 'Prof. Kim');
  const ins = find(/^Insert “ in total”/);
  assert.equal(ins.anchor.quote, 'riders');
  assert.equal(ins.suggestion.text, 'riders in total');

  assert.equal(res.imported, 5);
  assert.equal(res.unplaced, 1);
  assert.equal(res.changes, 2);
  assert.ok(res.comments.every((c) => c.status === 'draft' && c.origin === 'word'));

  // A second import with those threads in the sidecar only adds what's new: nothing.
  const again = lib.importDocx(sample, wordReviewedDocx(), { docDir: fixtures, existing: res.comments });
  assert.equal(again.comments.length, 0);
  assert.equal(again.replies.length, 0);
});

test('import: a Word reply to an exported thread is added to that thread', () => {
  const model = lib.buildDocModel(sample, { docDir: fixtures });
  const t = thread(model, 'short trips', 'Which trips? Say <short> means under 3 km.', { author: 'Prof. Kim' });
  const res = lib.importDocx(sample, wordReviewedDocx(), { docDir: fixtures, existing: [t] });
  assert.equal(res.duplicates, 1);
  assert.deepEqual(res.replies.map((r) => [r.id, r.reply.author, r.reply.body]), [[t.id, 'Ada Rivera', 'Will do.']]);
});

test('import: a file that is not a .docx fails with a clear message', () => {
  assert.throws(() => lib.importDocx(sample, Buffer.from('hello')), /Not a ZIP/);
  const zip = lib.writeZip([{ name: 'readme.txt', data: Buffer.from('x') }]);
  assert.throws(() => lib.importDocx(sample, zip), /no Word document part/);
});

// ---- a richer document: CRLF, BOM, non-ASCII, headings, nested lists, tables ----

const rich = '\ufeff' + [
  '# Einführung: çà et là',
  '',
  'Riders **must** trust that a *dock* is free, and Zoë’s café study — naïve as it is — agrees.',
  'A second line with $E=mc^2$ inside.',
  '',
  '- first item',
  '- second item',
  '  - nested **bold** item',
  '',
  '| Stadt | Anteil |',
  '|-------|-------:|',
  '| Köln | 12 % |',
  '| Zürich | 7 % |',
  '',
  '## Méthodes',
  '',
  'Overlapping comments share these words in the middle of one sentence.',
  '',
].join('\r\n');

test('round trip: CRLF, BOM, non-ASCII; headings, lists, tables; overlaps, replies, kinds and suggestions', () => {
  const model = lib.buildDocModel(rich);
  const threads = [
    thread(model, 'Einführung: çà et là', 'Heading ok?', { kind: 'question', severity: 'nit' }),
    thread(model, 'Zoë’s café study — naïve as it is', 'Tone.', {
      severity: 'major',
      suggestion: { text: 'the café study' },
      replies: [
        { id: 'r1', author: 'Claude', createdAt: '2026-09-21T09:00:00.000Z', body: 'How about this?\nSecond line.', suggestion: { text: 'Zoë’s study' } },
        { id: 'r2', author: 'Ada Rivera', createdAt: '2026-09-21T10:00:00.000Z', body: 'Better.' },
      ],
    }),
    thread(model, 'nested bold item', 'List item.'),
    thread(model, 'Zürich', 'Table cell.', { kind: 'praise' }),
    thread(model, 'Overlapping comments share these words', 'First of two.'),
    thread(model, 'share these words in the middle', 'Second of two.'),
    thread(model, 'Méthodes', 'Resolved already.', { status: 'resolved', resolvedAt: '2026-09-22T10:00:00.000Z' }),
  ];
  const res = lib.exportDocx({ markdown: rich, comments: threads, includeReplies: true, includeResolved: true });
  assert.equal(res.anchored, threads.length);
  const files = lib.readZip(res.docx);
  const doc = files.get('word/document.xml').toString();
  assertWellFormed(doc, 'document.xml');
  assertWellFormed(files.get('word/comments.xml').toString(), 'comments.xml');
  assertWellFormed(files.get('word/commentsExtended.xml').toString(), 'commentsExtended.xml');

  const back = lib.importDocx(rich, res.docx);
  assert.equal(back.imported, threads.length);
  assert.equal(back.unplaced, 0);
  for (const t of threads) {
    const c = back.comments.find((x) => x.body === t.body);
    assert.ok(c, `imported: ${t.body}`);
    assert.equal(c.anchor.quote, t.anchor.quote, t.body);
    assert.deepEqual(lib.locate(model.text, c.anchor), lib.locate(model.text, t.anchor), t.body);
    assert.equal(c.kind, t.kind);
    assert.equal(c.severity, t.severity);
    assert.deepEqual(c.suggestion, t.suggestion);
    assert.equal(c.status, t.status === 'resolved' ? 'resolved' : 'draft');
    assert.deepEqual(
      c.replies.map((r) => [r.author, r.createdAt, r.body, r.suggestion]),
      t.replies.map((r) => [r.author, r.createdAt, r.body, r.suggestion]),
    );
  }
  // The heading thread's lines are the heading's; the table cell's, its row.
  const heading = back.comments.find((c) => c.body === 'Heading ok?');
  assert.deepEqual([heading.anchor.lineStart, heading.anchor.lineEnd], [1, 1]);
  const cell = back.comments.find((c) => c.body === 'Table cell.');
  assert.deepEqual([cell.anchor.lineStart, cell.anchor.lineEnd], [13, 13]);

  // Re-importing into the imported threads adds neither threads nor replies.
  const again = lib.importDocx(rich, res.docx, { existing: back.comments });
  assert.equal(again.comments.length, 0);
  assert.equal(again.replies.length, 0);
  assert.equal(again.duplicates, threads.length);
});

// Word's own markup around the same text: runs split mid-word, proofing and
// bookmark marks, a comment across two paragraphs, one in a table cell, curly
// quotes where the Markdown has straight ones, and a moved sentence.
test('import: a Word-authored review of the richer document', () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const t = (s, attrs = ' xml:space="preserve"') => `<w:r><w:rPr><w:lang w:val="de-DE"/></w:rPr><w:t${attrs}>${s}</w:t></w:r>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/>${t('Einf')}${t('ührung: çà et là')}<w:bookmarkEnd w:id="0"/></w:p>
<w:p>${t('Riders must trust that a ')}<w:commentRangeStart w:id="1"/><w:proofErr w:type="spellStart"/>${t('do')}${t('ck')}<w:proofErr w:type="spellEnd"/>${t(' is free, and ')}${t('Zoë’s café study')}<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>${t(' — naïve as it is — agrees.')}</w:p>
<w:p>${t('A second line with E=mc^2 inside.')}</w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${t('first ')}<w:commentRangeStart w:id="2"/>${t('item')}</w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${t('second')}<w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r>${t(' item')}</w:p>
<w:tbl><w:tr><w:tc><w:p>${t('Stadt')}</w:p></w:tc><w:tc><w:p>${t('Anteil')}</w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:commentRangeStart w:id="3"/>${t('Köln')}<w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r></w:p></w:tc><w:tc><w:p>${t('12 %')}</w:p></w:tc></w:tr></w:tbl>
<w:p><w:moveFrom w:id="9" w:author="Prof. Kim"><w:r><w:t>Overlapping comments share these words</w:t></w:r></w:moveFrom>${t(' in the middle of one sentence.')}</w:p>
<w:sectPr/></w:body></w:document>`;
  const comments = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W}>
<w:comment w:id="1" w:author="Prof. Müller" w:date="2026-09-25T07:00:00Z"><w:p><w:r><w:t>Spans “split” runs.</w:t></w:r></w:p></w:comment>
<w:comment w:id="2" w:author="Prof. Müller" w:date="2026-09-25T07:01:00Z"><w:p><w:r><w:t>Across two items.</w:t></w:r></w:p></w:comment>
<w:comment w:id="3" w:author="Prof. Müller" w:date="2026-09-25T07:02:00Z"><w:p><w:r><w:t>In a cell.</w:t></w:r></w:p></w:comment>
</w:comments>`;
  const b = (s) => Buffer.from(s, 'utf8');
  const docx = lib.writeZip([
    { name: 'word/document.xml', data: b(doc) },
    { name: 'word/comments.xml', data: b(comments) },
  ]);
  const res = lib.importDocx(rich, docx);
  const model = lib.buildDocModel(rich);
  const by = (body) => res.comments.find((c) => c.body === body);
  assert.equal(by('Spans “split” runs.').anchor.quote, 'dock is free, and Zoë’s café study');
  assert.equal(by('Spans “split” runs.').author, 'Prof. Müller');
  assert.equal(by('Across two items.').anchor.quote, 'item\nsecond');
  assert.equal(by('In a cell.').anchor.quote, 'Köln');
  assert.equal(by('In a cell.').anchor.lineStart, 12);
  for (const c of res.comments) assert.ok(lib.locate(model.text, c.anchor), c.body);
  // A move is not an insertion or a deletion of the Markdown's text.
  assert.equal(res.changes, 0);
});

// ---- hostile files ----

/** Rewrite fields of a zip's central directory (the first entry's, or the one named). */
function patchCentral(zip, name, patch) {
  const buf = Buffer.from(zip);
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < buf.readUInt16LE(eocd + 10); n++) {
    const nlen = buf.readUInt16LE(p + 28);
    if (buf.toString('utf8', p + 46, p + 46 + nlen) === name) {
      patch(buf, p, eocd);
      return buf;
    }
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  throw new Error(`no entry ${name}`);
}

test('zip: bombs, lies and oversize files are refused before they are inflated', () => {
  const zeros = Buffer.alloc(4 * 1024 * 1024); // packs about 1000:1
  const bomb = lib.writeZip([{ name: 'word/document.xml', data: zeros }]);
  assert.ok(bomb.length < 10000);
  assert.throws(() => lib.readZip(bomb), /suspiciously well/);
  assert.throws(() => lib.importDocx(sample, bomb), /suspiciously well/);
  // The directory says 100 bytes; the stream holds 4 MB: inflating stops at 100.
  const liar = patchCentral(bomb, 'word/document.xml', (b, p) => b.writeUInt32LE(100, p + 24));
  assert.throws(() => lib.readZip(liar), /Couldn't inflate|wrong size/);
  // Declared sizes past the limits.
  const small = lib.writeZip([{ name: 'a.xml', data: Buffer.from('<a/>') }, { name: 'b.xml', data: Buffer.from('<b/>') }]);
  const huge = patchCentral(small, 'a.xml', (b, p) => b.writeUInt32LE(0xfffffff0, p + 24));
  assert.throws(() => lib.readZip(huge), /too large/);
  assert.throws(() => lib.readZip(small, { ...lib.zipLimits, total: 6 }), /too much data/);
  assert.throws(() => lib.readZip(small, { ...lib.zipLimits, entries: 1 }), /Too many entries/);
  assert.throws(() => lib.readZip(small, { ...lib.zipLimits, file: 100 }), /over/);
  // ZIP64 markers, encryption, other compression, truncation.
  assert.throws(() => lib.readZip(patchCentral(small, 'a.xml', (b, p, e) => b.writeUInt16LE(0xffff, e + 10))), /ZIP64/);
  assert.throws(() => lib.readZip(patchCentral(small, 'a.xml', (b, p) => b.writeUInt16LE(b.readUInt16LE(p + 8) | 1, p + 8))), /encrypted/);
  assert.throws(() => lib.readZip(patchCentral(small, 'a.xml', (b, p) => b.writeUInt16LE(12, p + 10))), /unsupported compression/);
  assert.throws(() => lib.readZip(patchCentral(small, 'a.xml', (b, p) => b.writeUInt32LE(small.length + 5, p + 42))), /Damaged/);
  assert.throws(() => lib.readZip(small.subarray(0, 20)), /Not a ZIP/);
});

test('zip: entry names that climb out of the archive are never looked up', () => {
  const x = Buffer.from('<w:document/>');
  const zip = lib.writeZip(['../evil.xml', '/abs.xml', 'C:/win.xml', 'word\\back.xml', 'word/./dot.xml', 'word/../word/document.xml', 'ok/fine.xml'].map((name) => ({ name, data: x })));
  assert.deepEqual(lib.openZip(zip).names, ['ok/fine.xml']);
  assert.equal(lib.openZip(zip).read('../evil.xml'), undefined);
  // A package whose relationships point outside it finds no document.
  const b = (s) => Buffer.from(s, 'utf8');
  const docx = lib.writeZip([
    { name: '_rels/.rels', data: b('<Relationships><Relationship Type="http://x/officeDocument" Target="../../../etc/passwd"/></Relationships>') },
    { name: '../../../etc/passwd', data: b('<w:document><w:body><w:p><w:r><w:t>root</w:t></w:r></w:p></w:body></w:document>') },
  ]);
  assert.throws(() => lib.readDocx(docx), /no Word document part/);
});

test('xml: DTDs and entity bombs are refused; unknown entities stay text; broken markup ends quietly', () => {
  const lol = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><w:t>&lol2;</w:t>';
  assert.throws(() => lib.xmlTokens(lol), /DTD/);
  const xxe = '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:t>&xxe;</w:t>';
  assert.throws(() => lib.xmlTokens(xxe), /DTD/);
  const b = (s) => Buffer.from(s, 'utf8');
  const docx = lib.writeZip([{ name: 'word/document.xml', data: b(xxe) }]);
  assert.throws(() => lib.importDocx(sample, docx), /DTD/);
  assert.deepEqual(lib.xmlTokens('<w:t>&foo; &amp; &#x41;&#66;</w:t>')[1], { t: 'text', s: '&foo; & AB' });
  // Linear on hostile input: unclosed comments, tags and CDATA.
  for (const bad of ['<!--'.repeat(200000), '<a '.repeat(200000), '<![CDATA['.repeat(100000), '<a b="'.repeat(100000)]) {
    const t0 = Date.now();
    lib.xmlTokens(bad);
    assert.ok(Date.now() - t0 < 2000, `slow on ${bad.slice(0, 8)}`);
  }
});

test('export: which images are read (Restricted Mode, network paths, devices)', () => {
  assert.ok(lib.isLocalImage('figs/a.png'));
  assert.ok(lib.isLocalImage('C:\\figs\\a.png'), 'a Windows drive path is a path');
  assert.ok(lib.isLocalImage('/abs/a.png'));
  for (const url of ['https://x.org/a.png', 'data:image/png;base64,AA', 'file:///a.png', '//host/a.png', '\\\\host\\share\\a.png']) assert.ok(!lib.isLocalImage(url), url);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-word-'));
  try {
    const docDir = path.join(tmp, 'doc');
    fs.mkdirSync(docDir);
    const png = fs.readFileSync(path.join(fixtures, 'media', 'sample', 'figure-1.png'));
    fs.writeFileSync(path.join(docDir, 'in.png'), png);
    fs.writeFileSync(path.join(tmp, 'out.png'), png);
    fs.mkdirSync(path.join(docDir, 'dir.png'));
    const md = '![inside](in.png)\n\n![outside](../out.png)\n\n![folder](dir.png)\n';
    const media = (opts) => [...lib.readZip(lib.exportDocx({ markdown: md, comments: [], docDir, ...opts }).docx).keys()].filter((n) => n.startsWith('word/media/'));
    assert.equal(media({}).length, 2, 'trusted: both files, not the folder');
    assert.equal(media({ readableRoots: [docDir] }).length, 1, 'Restricted Mode: only inside the readable roots');
    const doc = lib.readZip(lib.exportDocx({ markdown: md, comments: [], docDir, readableRoots: [docDir] }).docx).get('word/document.xml').toString();
    assert.match(doc, /\[outside\]/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('export: the package is complete: every part typed, every relationship resolves, all XML well-formed', () => {
  const model = lib.buildDocModel(sample, { docDir: fixtures });
  const { docx } = lib.exportDocx({
    markdown: sample,
    comments: [thread(model, 'Denser station networks', 'Directional?', { replies: [{ id: 'r', author: 'Claude', createdAt: '2026-09-21T09:00:00Z', body: 'Yes.' }] })],
    docDir: fixtures,
    includeReplies: true,
  });
  const files = lib.readZip(docx);
  const types = files.get('[Content_Types].xml').toString();
  const defaults = new Set([...types.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1]));
  const overrides = new Set([...types.matchAll(/<Override PartName="\/([^"]+)"/g)].map((m) => m[1]));
  for (const name of files.keys()) {
    if (name === '[Content_Types].xml') continue;
    assert.ok(overrides.has(name) || defaults.has(name.split('.').pop()), `content type for ${name}`);
    if (/\.(xml|rels)$/.test(name)) assertWellFormed(files.get(name).toString('utf8'), name);
  }
  for (const o of overrides) assert.ok(files.has(o), `override for a missing part: ${o}`);
  for (const [rels, base] of [['_rels/.rels', ''], ['word/_rels/document.xml.rels', 'word/']]) {
    for (const m of files.get(rels).toString().matchAll(/<Relationship ([^>]*)\/>/g)) {
      if (/TargetMode="External"/.test(m[1])) continue;
      const target = /Target="([^"]+)"/.exec(m[1])[1];
      assert.ok(files.has(path.posix.join(base, target)), `${rels} -> ${target}`);
    }
  }
  // Every comment has its range and reference in the document, and the other way round.
  const doc = files.get('word/document.xml').toString();
  const ids = [...files.get('word/comments.xml').toString().matchAll(/<w:comment w:id="(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['0', '1']);
  for (const id of ids) for (const tag of ['commentRangeStart', 'commentRangeEnd', 'commentReference']) assert.match(doc, new RegExp(`<w:${tag} w:id="${id}"/>`));
  // Where Python is installed, its expat parser must accept every part too.
  const py = ['python3', 'python'].find((c) => {
    try {
      execFileSync(c, ['-c', 'import xml.parsers.expat'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (py) {
    for (const [name, data] of files) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      execFileSync(py, ['-c', 'import sys, xml.parsers.expat as e; p = e.ParserCreate(); p.Parse(sys.stdin.buffer.read(), True)'], { input: data });
    }
  }
});

test('the Word code is a file of its own, off the start-up path, without a second renderer', () => {
  const dist = path.join(here, '..', 'dist');
  const ext = fs.readFileSync(path.join(dist, 'extension.js'), 'utf8');
  const word = fs.readFileSync(path.join(dist, 'word.js'), 'utf8');
  assert.doesNotMatch(ext, /commentRangeStart|commentsExtended/, 'no OOXML code in extension.js');
  assert.match(ext, /require\("\.\/word\.js"\)/);
  assert.match(word, /require\("\.\/extension\.js"\)\.shared\.render/);
  assert.doesNotMatch(word, /linkify|markdown-it-footnote|renderToString/, 'no markdown-it or KaTeX in word.js');
  assert.ok(word.length < 80 * 1024, `word.js is ${word.length} bytes`);
  assert.match(fs.readFileSync(path.join(here, '..', '.vscodeignore'), 'utf8'), /^!dist\/word\.js$/m);
});

// ---- duplicates, drafts, the file written, and speed on hostile input ----

/** A minimal .docx: `paras` are lists of text runs and [id] / [id, 'end'] comment marks. */
function miniDocx(paras, comments) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const run = (x) =>
    typeof x === 'string'
      ? `<w:r><w:t xml:space="preserve">${x}</w:t></w:r>`
      : x[1] === 'end'
        ? `<w:commentRangeEnd w:id="${x[0]}"/><w:r><w:commentReference w:id="${x[0]}"/></w:r>`
        : `<w:commentRangeStart w:id="${x[0]}"/>`;
  const doc = `<w:document ${W}><w:body>${paras.map((p) => `<w:p>${p.map(run).join('')}</w:p>`).join('')}</w:body></w:document>`;
  const cm = `<w:comments ${W}>${comments.map(([id, text]) => `<w:comment w:id="${id}" w:author="Adv"><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:comment>`).join('')}</w:comments>`;
  const b = (s) => Buffer.from(s, 'utf8');
  return lib.writeZip([
    { name: 'word/document.xml', data: b(doc) },
    { name: 'word/comments.xml', data: b(cm) },
  ]);
}

test('import: the same words on the same text elsewhere, or a longer comment, is new; only a true repeat is skipped', () => {
  const md = 'We extend prior work on bikes.\n\nUnlike prior work, we measure docks.\n';
  const docx = miniDocx(
    [
      ['We extend ', [1], 'prior work', [1, 'end'], ' on bikes.'],
      ['Unlike ', [2], 'prior work', [2, 'end'], ', we measure docks.'],
    ],
    [
      [1, 'Cite.'],
      [2, 'Cite.'],
    ],
  );
  const res = lib.importDocx(md, docx);
  assert.equal(res.imported, 2);
  assert.deepEqual(res.comments.map((c) => c.anchor.lineStart), [1, 3]);
  const again = lib.importDocx(md, docx, { existing: res.comments });
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 2);

  // A whole-document "See" doesn't swallow a comment that merely starts the same way.
  const see = { ...res.comments[0], id: 'c_see', body: 'See', scope: 'document', anchor: { quote: '', prefix: '', suffix: '', lineStart: 0, lineEnd: 0 } };
  const seems = miniDocx([['We extend ', [1], 'prior work', [1, 'end'], ' on bikes.']], [[1, 'Seems wrong: fix the numbers']]);
  assert.equal(lib.importDocx(md, seems, { existing: [see] }).imported, 1);
  // Nor does a placed thread match a whole-document one with the same body.
  assert.equal(lib.importDocx(md, docx, { existing: [{ ...see, body: 'Cite.' }] }).imported, 2);

  // A hundred comments on one quote, c1 … c100: every one is new, and a re-import adds none.
  const many = Array.from({ length: 100 }, (_, i) => i + 1);
  const hundred = miniDocx([['We extend ', ...many.map((i) => [i]), 'prior work', ...many.map((i) => [i, 'end']), ' on bikes.']], many.map((i) => [i, `c${i}`]));
  const r100 = lib.importDocx(md, hundred);
  assert.equal(r100.imported, 100);
  assert.equal(r100.duplicates, 0);
  assert.equal(lib.importDocx(md, hundred, { existing: r100.comments }).imported, 0);
});

test('export: drafts stay behind, yours and Claude\'s untriaged ones alike', () => {
  const model = lib.buildDocModel(sample, { docDir: fixtures });
  const threads = [
    thread(model, 'Riders use them for commuting', 'Submitted.'),
    thread(model, 'Median detour length in meters', 'My draft.', { status: 'draft', submittedAt: null }),
    thread(model, 'Denser station networks would increase weekly trips', 'Claude found this.', { status: 'draft', submittedAt: null, origin: 'agent', author: 'Claude' }),
  ];
  assert.deepEqual(lib.threadsToExport(threads, true).map((c) => c.body), ['Submitted.']);
  const res = lib.exportDocx({ markdown: sample, comments: threads, docDir: fixtures });
  assert.equal(res.exported, 1);
  const comments = lib.readZip(res.docx).get('word/comments.xml').toString();
  assert.doesNotMatch(comments, /My draft|Claude found this/);
});

test('export: the .docx replaces a file by rename, and never writes through a link or into a pipe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-docx-'));
  try {
    const out = path.join(dir, 'paper.docx');
    lib.writeDocxFile(out, Buffer.from('one'));
    lib.writeDocxFile(out, Buffer.from('two'));
    assert.equal(fs.readFileSync(out, 'utf8'), 'two');
    assert.deepEqual(fs.readdirSync(dir), ['paper.docx'], 'no temp file left behind');

    const target = path.join(dir, 'elsewhere.txt');
    fs.writeFileSync(target, 'keep');
    const link = path.join(dir, 'linked.docx');
    fs.symlinkSync(target, link);
    assert.match(lib.exportTargetProblem(link), /linked\.docx is a link/);
    assert.throws(() => lib.writeDocxFile(link, Buffer.from('x')), /is a link/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep');

    fs.mkdirSync(path.join(dir, 'folder.docx'));
    assert.throws(() => lib.writeDocxFile(path.join(dir, 'folder.docx'), Buffer.from('x')), /is a folder/);
    if (process.platform !== 'win32') {
      const fifo = path.join(dir, 'pipe.docx');
      execFileSync('mkfifo', [fifo]);
      assert.throws(() => lib.writeDocxFile(fifo, Buffer.from('x')), /is not a regular file/);
    }
    assert.equal(lib.exportTargetProblem(path.join(dir, 'new.docx')), null);
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp-')), 'no temp file left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('import: a megabyte-long tag and a comment full of suggested-edit lines read in linear time', () => {
  const b64 = crypto.randomBytes(768 * 1024).toString('base64');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const docx = lib.writeZip([{ name: 'word/document.xml', data: Buffer.from(`<w:document ${W}><w:body><w:p ${b64}/></w:body></w:document>`) }]);
  let t = performance.now();
  lib.importDocx(sample, docx);
  assert.ok(performance.now() - t < 1000, `tag read in ${(performance.now() - t).toFixed(0)} ms`);

  const text = 'Body' + '\nSuggested edit: replace with “a'.repeat(50000);
  t = performance.now();
  assert.equal(lib.splitMeta(text).meta.suggestion, undefined);
  assert.ok(performance.now() - t < 1000, `comment split in ${(performance.now() - t).toFixed(0)} ms`);
  assert.deepEqual(lib.splitMeta('Tighten.\n[minor]\nSuggested edit: replace with “new “words””'), { body: 'Tighten.', meta: { severity: 'minor', suggestion: { text: 'new “words”' } } });
  assert.deepEqual(lib.splitMeta('Cut.\nSuggested edit: delete this text').meta, { suggestion: { text: '' } });
});

test('word.js finds everything it takes from extension.js', () => {
  const dist = path.join(here, '..', 'dist');
  const word = fs.readFileSync(path.join(dist, 'word.js'), 'utf8');
  const used = [...new Set([...word.matchAll(/require\("\.\/extension\.js"\)\.shared\.(\w+)/g)].map((m) => m[1]))];
  assert.ok(used.length >= 3, `shared modules used: ${used}`);
  // Load the real bundle with a stand-in for the vscode module.
  const Module = require('node:module');
  const stub = new Proxy(function () {}, { get: (_, k) => (k === '__esModule' ? false : stub), apply: () => stub, construct: () => stub });
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? stub : load.call(this, request, ...rest);
  };
  try {
    const ext = require(path.join(dist, 'extension.js'));
    for (const k of used) assert.equal(typeof ext.shared[k], 'object', `extension.js shares ${k}`);
  } finally {
    Module._load = load;
  }
});

// LibreOffice smoke test: only where soffice can convert at all (probed with a tiny text file).
function sofficeWorks(dir) {
  try {
    fs.writeFileSync(path.join(dir, 'probe.txt'), 'probe');
    const profile = `-env:UserInstallation=file://${path.join(dir, 'profile').replace(/\\/g, '/')}`;
    execFileSync('soffice', [profile, '--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'probe.txt')], { stdio: 'ignore', timeout: 60000 });
    return fs.existsSync(path.join(dir, 'probe.pdf'));
  } catch {
    return false;
  }
}
const loDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-lo-'));
const lo = sofficeWorks(loDir);
test('LibreOffice converts the exported .docx to PDF', { skip: lo ? false : 'soffice is missing or cannot convert documents here' }, () => {
  const model = lib.buildDocModel(sample, { docDir: fixtures });
  const { docx } = lib.exportDocx({ markdown: sample, comments: [thread(model, 'Denser station networks', 'Directional?')], docDir: fixtures });
  const file = path.join(loDir, 'export.docx');
  fs.writeFileSync(file, docx);
  const profile = `-env:UserInstallation=file://${path.join(loDir, 'profile').replace(/\\/g, '/')}`;
  execFileSync('soffice', [profile, '--headless', '--convert-to', 'pdf', '--outdir', loDir, file], { stdio: 'ignore', timeout: 120000 });
  const pdf = path.join(loDir, 'export.pdf');
  assert.ok(fs.existsSync(pdf) && fs.statSync(pdf).size > 1000);
});
test.after(() => fs.rmSync(loDir, { recursive: true, force: true }));
