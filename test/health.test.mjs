// Document health: word targets from front matter, word counting, re-anchoring
// orphaned threads, and the host's on-request link check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'health');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const wordsJs = path.join(tmp, 'words.cjs');
esbuild.buildSync({ entryPoints: [path.join(here, '..', 'webview', 'words.ts')], outfile: wordsJs, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' });
const { countWords, countDocument, DocumentCount, fmtWords } = require(wordsJs);
const healthJs = path.join(tmp, 'health.cjs');
esbuild.buildSync({ entryPoints: [path.join(here, '..', 'webview', 'health.ts')], outfile: healthJs, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' });
const { orphanRows } = require(healthJs);

function session(md, extra = {}) {
  const posted = [];
  const s = new lib.ReviewSession({
    mdPath: md,
    author: () => 'Reviewer',
    showResolved: () => true,
    post: (m) => posted.push(m),
    resolveImage: (x) => x,
    getText: () => fs.readFileSync(md, 'utf8'),
    isDirty: () => false,
    openLink: () => {},
    ...extra,
  });
  s.handle({ type: 'ready' });
  return { s, posted, last: (type) => posted.filter((m) => m.type === type).at(-1) };
}

const targetsOf = (front) => {
  const env = {};
  lib.renderMarkdown(`---\n${front}\n---\n\n# A\n`, (x) => x, env);
  return env.front?.targets;
};

test('word targets: nested flow map, keys as written', () => {
  assert.deepEqual(targetsOf('title: X\nmdreview: { words: { total: 8000, "Abstract": 250, Related  Work: 1200 } }'), {
    total: 8000,
    sections: { Abstract: 250, 'Related Work': 1200 },
  });
});

test('word targets: quoted commas, list items, odd keys and absurd numbers', () => {
  // A quoted key or value may hold commas and colons.
  assert.deepEqual(targetsOf('mdreview: { words: { "Results, part 1": 300, Intro: "1,200", \'Q&A: B\': 5 } }'), {
    sections: { 'Results, part 1': 300, Intro: 1200, 'Q&A: B': 5 },
  });
  // `- Intro: 5` list items read as the pairs they hold.
  assert.deepEqual(targetsOf('mdreview:\n  words:\n    - total: 900\n    - Intro: 5\n    - Methods: 7'), { total: 900, sections: { Intro: 5, Methods: 7 } });
  // __proto__ and constructor are just keys: nothing leaks onto Object.prototype.
  const t = targetsOf('mdreview: { words: { __proto__: 5, constructor: 6, toString: 7 } }');
  assert.equal(Object.getPrototypeOf(t.sections), Object.prototype);
  assert.deepEqual(Object.keys(t.sections), ['__proto__', 'constructor', 'toString']);
  assert.equal(Object.getOwnPropertyDescriptor(t.sections, '__proto__').value, 5);
  assert.equal({}.polluted, undefined);
  const t2 = targetsOf('mdreview:\n  __proto__:\n    polluted: 1\n  words:\n    Intro: 3');
  assert.deepEqual(t2, { sections: { Intro: 3 } });
  assert.equal({}.polluted, undefined);
  // More than a billion, zero, negative and fractional values are dropped.
  assert.deepEqual(targetsOf('mdreview: { words: { total: 99999999999, A: 0, B: -5, C: 2.5, D: 1000000000 } }'), { sections: { D: 1e9 } });
});

test('word targets: flat form, block style, and words as the total', () => {
  assert.deepEqual(targetsOf('mdreview: { total: 8000, abstract: 250 }'), { total: 8000, sections: { abstract: 250 } });
  assert.deepEqual(targetsOf('mdreview:\n  words:\n    total: 5,000 # soft limit\n    "Methods: Data": 900\n  other: x\ntitle: T'), {
    total: 5000,
    sections: { 'Methods: Data': 900 },
  });
  assert.deepEqual(targetsOf('mdreview:\n  total: 300\n  Intro: 100'), { total: 300, sections: { Intro: 100 } });
  assert.deepEqual(targetsOf('mdreview: { words: 4000 }'), { total: 4000, sections: {} });
  assert.equal(targetsOf('mdreview: { theme: dark }'), undefined);
  assert.equal(targetsOf('title: No targets'), undefined);
});

test('the render message carries the targets', () => {
  const md = path.join(tmp, 'targets.md');
  fs.writeFileSync(md, '---\nmdreview: { words: { total: 10, Abstract: 3 } }\n---\n\n# Abstract\n\nOne two three four.\n');
  const { last } = session(md);
  assert.deepEqual(last('render').targets, { total: 10, sections: { Abstract: 3 } });
  fs.writeFileSync(md, '# Plain\n');
  const s2 = session(md);
  assert.equal(s2.last('render').targets, undefined);
});

test('countWords: words, contractions, numbers, CJK', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('  The quick brown fox.  '), 4);
  assert.equal(countWords("Don't split well-known words, e.g. these."), 6);
  assert.equal(countWords('It cost 8,000 dollars — or 3.5 k€.'), 7);
  assert.equal(countWords('日本語の文章'), 6);
  assert.equal(countWords('Mixed 中文 text'), 4);
  assert.equal(countWords('한국어 문장'), 2); // Hangul is spaced like English
  assert.equal(countWords('— … * ##'), 0);
});

test('countWords: joiners, web addresses, emoji', () => {
  // Zero-width non-joiner and joiner, soft hyphen, Unicode hyphens join a word.
  assert.equal(countWords('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 ok'), 2);
  assert.equal(countWords('hy\u00adphen non\u2010stop well\u2011known'), 3);
  // A web address is one word, however many parts it has.
  assert.equal(countWords('See https://example.com/a/b?q=1 and http://x.org/y here.'), 5);
  assert.equal(countWords('ratio 3:2 and time 10:30'), 7); // a colon alone doesn't start one
  // An emoji on its own is a word; next to a word it is part of it. Symbols like © and → aren't.
  assert.equal(countWords('hello 🎉 world 👍🏽 ok'), 5);
  assert.equal(countWords('great🎉 👨\u200d👩\u200d👧 ☀\ufe0f'), 3);
  assert.equal(countWords('© 2024 a → b ™'), 3);
  assert.equal(fmtWords(1), '1 word');
  assert.equal(fmtWords(1234), '1,234 words');
});

// Just enough of a DOM for countDocument: elements with tag names and classes, and text.
const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'col', 'wbr', 'source', 'area']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
function parseHtml(html) {
  const el = (tag, cls = '', svg = false) => ({ nodeType: 1, tagName: svg ? tag : tag.toUpperCase(), classList: Object.assign(cls.split(/\s+/).filter(Boolean), { contains(c) { return this.includes(c); } }), kids: [], svg });
  const root = el('main');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  for (let m; (m = re.exec(html)); ) {
    const top = stack.at(-1);
    if (m[5] !== undefined) top.kids.push({ nodeType: 3, data: m[5].replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENT[e]) });
    else if (m[1]) {
      const i = stack.findLastIndex((e) => e.tagName.toLowerCase() === m[2].toLowerCase());
      if (i > 0) stack.length = i;
    } else if (m[2]) {
      const cls = /\bclass="([^"]*)"/.exec(m[3])?.[1] || '';
      const e = el(m[2], cls, top.svg || m[2] === 'svg');
      top.kids.push(e);
      if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(e);
    }
  }
  const link = (n) => {
    n.firstChild = n.kids?.[0] || null;
    n.kids?.forEach((k, i) => {
      k.nextSibling = n.kids[i + 1] || null;
      link(k);
    });
    return n;
  };
  return link(root);
}
const sample = `---
title: Sample paper
mdreview: { words: { total: 40, Methods: 5 } }
---

# Abstract

Short words here, e.g. four[^1] of them.

## Methods

We measured $x^2$ and \`code\` too.

\`\`\`js
let notCounted = true;
\`\`\`

$$
E = mc^2
$$

### Data

One two three.

# Results

| A | B |
|---|---|
| cell one | cell two |

日本語 text, see [@nokey] and @fig:none.

[^1]: A footnote that is not counted.
`;

test('countDocument: prose only, a formula is one word, sections include their subsections and headings', () => {
  const doc = parseHtml(lib.renderMarkdown(sample, (x) => x, {}));
  const { total, sections } = countDocument(doc);
  const by = Object.fromEntries([...sections].map(([h, n]) => [h.kids[0].data, n]));
  // Abstract: 7. Methods: 5 + inline and display formula; the code block and the
  // front matter don't count, nor do the footnote and its marker. Results: the
  // table's 6, then 3 CJK characters, "text see nokey and" (no bibliography, so
  // [@nokey] stays text), but not the unresolved cross-reference's marker. Each
  // heading's own word counts in its section, so the sections add up to the total.
  assert.deepEqual(by, { Abstract: 1 + 7 + 1 + 7 + 1 + 3, Methods: 1 + 7 + 1 + 3, Data: 1 + 3, Results: 1 + 6 + 7 });
  assert.equal(total, by.Abstract + by.Results);
});

test('countDocument: CriticMarkup counts as accepted, equation numbers and web addresses as noted', () => {
  const words = (md) => countDocument(parseHtml(lib.renderMarkdown(md, (x) => x, {}))).total;
  // What's left once the changes are accepted: This added and new and hi end.
  assert.equal(words('This {--deleted words--}{++added++} and {~~old~>new~~} and {==hi==}{>>critic comment<<} end.\n'), 7);
  // An insertion's edges end a word even with no space around it: a{--b--}{++c++}d is a, c, d.
  assert.equal(words('a{--b--}{++c++}d\n'), 3);
  // A numbered display formula is one word, its number included.
  assert.equal(words('$$\nx = 1\n$$ (1)\n\nNext line.\n'), 3);
  assert.equal(words('See [the docs](https://example.com/x) and https://example.com/a/b here.\n'), 6);
  assert.equal(words('Use `npm run build` now.\n'), 5); // inline code counts
});

test('countDocument: counted a block at a time gives the same result', () => {
  const html = lib.renderMarkdown(sample.repeat(3).replace(/^---[\s\S]*?---\n/, ''), (x) => x, {});
  const whole = countDocument(parseHtml(html));
  const doc = parseHtml(html);
  const count = new DocumentCount(doc);
  let steps = 0;
  while (!count.step(() => false)) steps++;
  const sliced = count.result();
  assert.ok(steps > 10);
  assert.equal(sliced.total, whole.total);
  assert.deepEqual([...sliced.sections.values()], [...whole.sections.values()]);
  // Words split across inline elements are one word; block edges split them.
  const one = parseHtml('<p>well-<em>known</em> <strong>8</strong>,000</p><p>end</p><ul><li>a</li><li>b</li></ul>');
  assert.equal(countDocument(one).total, 5);
});

test('DocumentCount: after a repaint that kept most blocks, only the new ones are counted', () => {
  const html = lib.renderMarkdown(sample.replace(/^---[\s\S]*?---\n/, ''), (x) => x, {});
  const doc = parseHtml(html);
  const counted = [];
  class Cache extends WeakMap {
    set(k, v) {
      counted.push(k);
      return super.set(k, v);
    }
  }
  const cache = new Cache();
  const first = new DocumentCount(doc, cache);
  first.step(() => true);
  const before = first.result();
  const blocks = counted.length;
  assert.ok(blocks > 8);
  // Replace one paragraph, as a patched repaint does: a new element in its place.
  const i = doc.kids.findIndex((k) => k.tagName === 'P' && /Short words/.test(JSON.stringify(k.kids.map((x) => x.data))));
  const repl = parseHtml('<p data-ls="7">Now five words in here.</p>').kids[0];
  doc.kids.splice(i, 1, repl);
  const relink = (n) => {
    n.firstChild = n.kids?.[0] || null;
    n.kids?.forEach((k, j) => (k.nextSibling = n.kids[j + 1] || null));
  };
  relink(doc);
  counted.length = 0;
  const again = new DocumentCount(doc, cache);
  again.step(() => true);
  const after = again.result();
  assert.deepEqual(counted, [repl]);
  // The same result as counting the patched document from scratch.
  const fresh = countDocument(doc);
  assert.equal(after.total, fresh.total);
  assert.deepEqual([...after.sections.values()], [...fresh.sections.values()]);
  assert.equal(after.total, before.total - 7 + 5);
  assert.deepEqual([...after.sections.keys()], [...before.sections.keys()]); // headings kept their elements
});

test('orphaned comments leave out resolved threads and applied suggestions', () => {
  const c = (id, extra = {}) => ({ id, status: 'submitted', body: 'b', anchor: { quote: `q${id}` }, replies: [], ...extra });
  const list = [
    c('a'),
    c('b', { status: 'resolved' }),
    c('c', { suggestion: { text: 'x', appliedAt: '2026-01-01' } }),
    c('d', { replies: [{ suggestion: { text: 'y', appliedAt: '2026-01-01' } }] }),
    c('e', { suggestion: { text: 'x', dismissedAt: '2026-01-01' } }),
    c('f', { status: 'draft' }),
    c('g'),
  ];
  assert.deepEqual(orphanRows(list, (id) => id !== 'g').map((o) => o.id), ['a', 'e', 'f']);
  assert.deepEqual(orphanRows(list, () => true)[0], { id: 'a', quote: 'qa', body: 'b' });
});

test('reanchor refuses malformed anchors with a clear message, and changes nothing', () => {
  const md = path.join(tmp, 'reanchor-bad.md');
  fs.writeFileSync(md, 'Some text here.\n');
  const { s, last } = session(md);
  s.handle({ type: 'addComment', anchor: { quote: 'gone', prefix: '', suffix: '', lineStart: 1, lineEnd: 1 }, body: 'B' });
  const id = last('comments').data.comments[0].id;
  const before = fs.readFileSync(md + '.comments.json', 'utf8');
  const good = { quote: 'text', prefix: 'Some ', suffix: ' here.', lineStart: 1, lineEnd: 1 };
  const cases = [
    [null, /Select the passage/],
    ['text', /Select the passage/],
    [{ ...good, quote: 42 }, /Select the passage/],
    [{ ...good, quote: 'x'.repeat(100_001) }, /too long/],
    [{ ...good, prefix: 7 }, /text around the passage/],
    [{ ...good, suffix: 'y'.repeat(1001) }, /text around the passage/],
    [{ ...good, lineStart: 0 }, /valid lines/],
    [{ ...good, lineStart: 1.5, lineEnd: 2 }, /valid lines/],
    [{ ...good, lineStart: '1' }, /valid lines/],
    [{ ...good, lineStart: 3, lineEnd: 2 }, /valid lines/],
    [{ ...good, lineEnd: undefined }, /valid lines/],
    [{ ...good, lineEnd: Infinity }, /valid lines/],
  ];
  for (const [anchor, msg] of cases) {
    s.handle({ type: 'reanchor', id, anchor });
    assert.match(last('error').message, msg, JSON.stringify(anchor)?.slice(0, 80));
    assert.equal(fs.readFileSync(md + '.comments.json', 'utf8'), before);
  }
  // Unknown thread: the store's own message.
  s.handle({ type: 'reanchor', id: 'nope', anchor: good });
  assert.equal(fs.readFileSync(md + '.comments.json', 'utf8'), before);
  // Prefix and suffix may be left out.
  s.handle({ type: 'reanchor', id, anchor: { quote: 'text', lineStart: 1, lineEnd: 1 } });
  assert.deepEqual(last('comments').data.comments[0].anchor, { quote: 'text', prefix: '', suffix: '', lineStart: 1, lineEnd: 1 });
});

test('reanchor moves an orphaned thread and keeps unknown anchor fields', () => {
  const md = path.join(tmp, 'reanchor.md');
  fs.writeFileSync(md, 'The new sentence is here.\n');
  const { s, last } = session(md);
  s.handle({ type: 'addComment', anchor: { quote: 'old text', prefix: '', suffix: '', lineStart: 5, lineEnd: 5 }, body: 'Fix' });
  const id = last('comments').data.comments[0].id;
  const raw = JSON.parse(fs.readFileSync(md + '.comments.json', 'utf8'));
  raw.comments[0].anchor.extra = 'kept';
  fs.writeFileSync(md + '.comments.json', JSON.stringify(raw));
  s.handle({ type: 'reanchor', id, anchor: { quote: 'new sentence', prefix: 'The ', suffix: ' is here.', lineStart: 1, lineEnd: 1 } });
  const c = last('comments').data.comments[0];
  assert.deepEqual(c.anchor, { quote: 'new sentence', prefix: 'The ', suffix: ' is here.', lineStart: 1, lineEnd: 1, extra: 'kept' });
  assert.equal(c.body, 'Fix');
  // Nothing selected, or a whole-document thread: refused, file unchanged.
  const before = fs.readFileSync(md + '.comments.json', 'utf8');
  s.handle({ type: 'reanchor', id, anchor: { quote: '  ', prefix: '', suffix: '', lineStart: 0, lineEnd: 0 } });
  assert.match(last('error').message, /Select the passage/);
  const data = lib.store.readSidecar(md);
  const doc = lib.store.addComment(data, 'R', { quote: '', prefix: '', suffix: '', lineStart: 0, lineEnd: 0 }, 'All', { scope: 'document' });
  assert.throws(() => lib.store.reanchor(data, doc.id, { quote: 'x', prefix: '', suffix: '', lineStart: 1, lineEnd: 1 }), /whole-document/);
  assert.equal(fs.readFileSync(md + '.comments.json', 'utf8'), before);
});

test('linkPath: files only, anchors and queries dropped', () => {
  assert.equal(lib.linkPath('notes/a%20b.md#part'), 'notes/a b.md');
  assert.equal(lib.linkPath('a.md?x=1#y'), 'a.md');
  // A drive letter is a path, not a one-letter URL scheme; so is a \\host path (checked, then skipped as a network path).
  assert.equal(lib.linkPath('C:/notes/x.md'), 'C:/notes/x.md');
  assert.equal(lib.linkPath('C:%5Cnotes%5Cx.md'), 'C:\\notes\\x.md');
  assert.equal(lib.linkPath('\\\\server\\share\\x.md'), '\\\\server\\share\\x.md');
  assert.equal(lib.linkPath('file:///C:/x.md'), null);
  assert.equal(lib.linkPath('?q'), null);
  assert.equal(lib.linkPath('img.png?raw=1'), 'img.png');
  assert.equal(lib.linkPath('#heading'), null);
  assert.equal(lib.linkPath('https://example.com/x.md'), null);
  assert.equal(lib.linkPath('mailto:a@b.c'), null);
  assert.equal(lib.linkPath('//cdn/x.png'), null);
  assert.equal(lib.linkPath('bad%zz.md'), 'bad%zz.md');
});

test('checkLinks reports only missing files, and only when asked', async () => {
  const md = path.join(tmp, 'links.md');
  fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'sub', 'here.md'), '# Here\n');
  fs.writeFileSync(md, '[ok](sub/here.md#here) [gone](sub/gone.md) ![img](missing.png) [web](https://x.org)\n');
  const { s, posted, last } = session(md);
  assert.equal(posted.filter((m) => m.type === 'linkCheck').length, 0);
  assert.match(last('render').blocks.join(''), /<img src="missing.png"[^>]*data-mdr-src="missing.png"/);
  s.handle({ type: 'checkLinks', hrefs: ['sub/here.md#here', 'sub/gone.md', 'missing.png', 'https://x.org', 'sub/gone.md', 'C:/nowhere/x.md'], seq: 7 });
  for (let i = 0; i < 50 && !last('linkCheck'); i++) await new Promise((r) => setTimeout(r, 10));
  // A drive path is checked too (on Linux it's a relative name that isn't there).
  assert.deepEqual(last('linkCheck').missing, ['sub/gone.md', 'missing.png', 'C:/nowhere/x.md']);
  // The question's number comes back, so the view can drop an answer to an older one.
  assert.equal(last('linkCheck').seq, 7);
});

test('insideRealRoots never looks at a network path on Windows', () => {
  const calls = [];
  const spy = (name) => {
    const orig = fs[name];
    fs[name] = (...a) => {
      calls.push(name);
      return orig(...a);
    };
    return () => (fs[name] = orig);
  };
  const undo = [spy('realpathSync'), spy('lstatSync'), spy('readlinkSync')];
  try {
    const bib = lib;
    assert.equal(bib.insideRealRoots('\\\\server\\share\\x.md', ['\\\\server\\share'], 'win32'), false);
    assert.equal(bib.insideRealRoots('//server/share/x.md', ['//server/share'], 'win32'), false);
    // Relative to a document on a share: resolves onto the share, so skipped too.
    assert.equal(bib.insideRealRoots('\\\\server\\share\\docs\\..\\x.md', ['C:\\docs'], 'win32'), false);
    assert.deepEqual(calls, []);
    // A local Windows path is compared as a path.
    assert.equal(bib.insideRealRoots('C:\\docs\\sub\\x.md', ['C:\\docs'], 'win32'), true);
    assert.equal(bib.insideRealRoots('C:\\other\\x.md', ['C:\\docs'], 'win32'), false);
  } finally {
    undo.forEach((f) => f());
  }
});

test('insideRealRoots follows links, but not a link to a network path', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp, 'roots');
  fs.mkdirSync(path.join(dir, 'in'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'x.md'), 'x');
  fs.rmSync(path.join(dir, 'in', 'link.md'), { force: true });
  fs.symlinkSync(path.join(dir, 'out', 'x.md'), path.join(dir, 'in', 'link.md'));
  const roots = lib.realRoots([path.join(dir, 'in')]);
  assert.equal(lib.insideRealRoots(path.join(dir, 'in', 'link.md'), roots), false);
  assert.equal(lib.insideRealRoots(path.join(dir, 'in', 'new.md'), roots), true);
  assert.equal(lib.insideRealRoots(path.join(dir, 'out', 'x.md'), lib.realRoots([path.join(dir, 'out')])), true);
  // A missing file under a linked folder is judged by where the link leads.
  fs.rmSync(path.join(dir, 'in', 'outdir'), { force: true });
  fs.symlinkSync(path.join(dir, 'out'), path.join(dir, 'in', 'outdir'));
  assert.equal(lib.insideRealRoots(path.join(dir, 'in', 'outdir', 'missing.md'), roots), false);
  assert.equal(lib.insideRealRoots(path.join(dir, 'in', 'sub', 'missing.md'), roots), true);
  // A network root is kept as written, never resolved.
  assert.deepEqual(lib.realRoots(['\\\\server\\share\\docs'], 'win32'), ['\\\\server\\share\\docs']);
});

test('checkLinks in Restricted Mode looks only inside the readable folders', async () => {
  const dir = path.join(tmp, 'restricted');
  fs.mkdirSync(dir, { recursive: true });
  const md = path.join(dir, 'doc.md');
  fs.writeFileSync(md, '[in](gone.md) [out](../../elsewhere/gone.md)\n');
  const { s, last } = session(md, { readableRoots: () => [dir] });
  s.handle({ type: 'checkLinks', hrefs: ['gone.md', '../../elsewhere/gone.md'] });
  for (let i = 0; i < 50 && !last('linkCheck'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(last('linkCheck').missing, ['gone.md']);
});
