// Renderer extensions: YAML front matter and CriticMarkup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { renderMarkdown, hasUrlScheme } = require('../dist/lib.cjs');
const render = (s) => renderMarkdown(s, (x) => x);

test('front matter becomes a title card with its source range', () => {
  const html = render(
    '---\ntitle: "Bike Share and Trips"\nsubtitle: A fictional study\nauthor:\n  - name: Ada Rivera\n    affiliation: X\n  - Ben Chen\ndate: 2026-09-26\nkeywords: [mobility, cities]\nbibliography: refs.bib\n---\n\n# Intro\n\nText.\n',
  );
  assert.match(html, /<div class="mdr-wrap mdr-front" data-ls="0" data-le="11">/);
  assert.match(html, /mdr-front-title">Bike Share and Trips</);
  assert.match(html, /mdr-front-subtitle">A fictional study</);
  assert.match(html, /Ada Rivera, Ben Chen/);
  assert.match(html, /2026-09-26/);
  assert.match(html, /<span>mobility<\/span><span>cities<\/span>/);
  assert.match(html, /bibliography: refs.bib/); // raw YAML stays reachable
  assert.doesNotMatch(html, /<hr/);
  assert.doesNotMatch(html, /<h2/);
  assert.match(html, /<h1 data-ls="12" data-le="13">Intro<\/h1>/);
});

test('a leading thematic break is not front matter', () => {
  assert.match(render('---\n\nJust prose.\n\n---\n'), /^<hr/);
  assert.match(render('---\nNot yaml here\n---\n'), /<h2/); // setext heading, as before
  assert.match(render('Text\n\n---\ntitle: x\n---\n'), /<hr/); // only on the first line
});

test('front matter with CRLF and ... closer', () => {
  const html = render('---\r\ntitle: CRLF\r\n...\r\nBody\r\n');
  assert.match(html, /mdr-front-title">CRLF</);
  assert.match(html, /<p data-ls="3" data-le="4">Body<\/p>/);
});

test('CriticMarkup renders instead of vanishing', () => {
  const html = render('a {++added++} b {--gone--} c {~~old~>new~~} d {==hl==}{>>why?<<} e {++*em*++}\n');
  assert.match(html, /<ins class="mdr-critic-add">added<\/ins>/);
  assert.match(html, /<del class="mdr-critic-del">gone<\/del>/);
  assert.match(html, /<del class="mdr-critic-del">old<\/del><ins class="mdr-critic-add">new<\/ins>/);
  assert.match(html, /<mark class="mdr-critic-mark">hl<\/mark>/);
  assert.match(html, /<span class="mdr-critic-note">why\?<\/span>/);
  assert.match(html, /<ins class="mdr-critic-add"><em>em<\/em><\/ins>/);
});

test('attribute lists still work next to CriticMarkup', () => {
  assert.match(render('## Heading {#sec-a}\n'), /<h2 id="sec-a"/);
  assert.match(render('![x](a.png){width=50%}\n'), /style="width:50%"/);
  assert.match(render('{--x'), /\{--x/); // unclosed: left as text
});

test('CriticMarkup inside link labels, brackets and inline footnotes', () => {
  assert.match(render('See [the {++new++} paper](http://x).\n'), /<a href="http:\/\/x">the <ins class="mdr-critic-add">new<\/ins> paper<\/a>/);
  assert.match(render('[a {==b==} c]\n'), /\[a <mark class="mdr-critic-mark">b<\/mark> c\]/);
  assert.doesNotMatch(render('Text^[inline {++fn++}] x\n'), /Render failed/);
});

test('front matter follows pandoc: no blank line after the opening ---', () => {
  const html = render('---\n\nNote: read this first.\n\n---\n\nBody\n');
  assert.doesNotMatch(html, /mdr-front/);
  assert.match(html, /^<hr/);
});

test('Quarto author affiliations are not listed as authors; flow lists respect quotes', () => {
  const html = render(
    '---\ntitle: T\nauthor:\n  - name: Ada\n    affiliations:\n      - name: MIT\n      - name: Elon University\n  - name: Ben\nkeywords: [a, "b, c"]\n---\n',
  );
  assert.match(html, /mdr-front-meta">Ada, Ben</);
  assert.match(html, /<span>a<\/span><span>b, c<\/span><\/div>/);
  assert.match(render('---\nauthor: [{name: A}, B]\n---\n'), /mdr-front-meta">A, B</);
});

test('flow lists: apostrophes are plain text; quoted names keep their commas', () => {
  assert.match(render("---\nkeywords: [Ada's work, cities]\n---\n"), /<span>Ada's work<\/span><span>cities<\/span>/);
  assert.match(render('---\nauthor: [{name: "Rivera, Ada"}, B]\n---\n'), /mdr-front-meta">Rivera, Ada, B</);
});

test('front matter: single-map author; an indented --- is not front matter', () => {
  assert.match(render('---\nauthor:\n  name: Solo\n  email: s@x\n---\n'), /mdr-front-meta">Solo</);
  assert.doesNotMatch(render(' ---\ntitle: x\n---\n'), /mdr-front/);
});

test('many footnotes keep their numbers, order, and back-links', () => {
  const n = 300;
  const body = Array.from({ length: n }, (_, i) => `Claim ${i + 1}.[^f${i + 1}]`).join('\n\n');
  const defs = Array.from({ length: n }, (_, i) => `[^f${i + 1}]: Note ${i + 1}.`).join('\n');
  const html = render(`${body}\n\nAgain.[^f1]\n\n${defs}\n`);
  const notes = [...html.matchAll(/<li id="fn(\d+)" class="footnote-item"><p[^>]*>Note (\d+)\./g)];
  assert.equal(notes.length, n);
  assert.ok(notes.every(([, id, note]) => id === note));
  // The note cited twice gets two back-links.
  assert.match(html, /Note 1\. <a href="#fnref1" class="footnote-backref">↩︎<\/a> <a href="#fnref1:1" class="footnote-backref">↩︎<\/a><\/p>/);
});

test('repeated formulas render the same, inline and display apart', () => {
  const once = render('Let $x^2$ be.\n');
  assert.equal(render('Let $x^2$ be.\n'), once);
  const both = render('Inline $x^2$.\n\n$$\nx^2\n$$\n');
  assert.equal((both.match(/katex-display/g) || []).length, 1);
  assert.equal((both.match(/class="katex"/g) || []).length, 2);
});

test('the per-block HTML joins to exactly the whole document, footnotes as one block', () => {
  const { renderParsed, createRenderer } = require('../dist/lib.cjs');
  const renderBlocks = (d, r) => renderParsed(d, r).blocks;
  const whole = createRenderer((x) => x);
  const docs = [
    '---\ntitle: T\n---\n\n# H\n\nPara[^a] with $x$.\n\n- a\n  - b\n\n> q\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$$\ny\n$$\n\n<div>\nraw\n</div>\n\n    code\n\n```js\nf()\n```\n\n---\n\nText^[inline] {++add++}\n\n[^a]: Note.\n',
    '',
    'just text',
    '<details>\n<summary>s</summary>\n\ninside\n\n</details>\n',
    '- [ ] task\n- [x] done\n\n> [!NOTE]\n> An alert.\n\nSome ==marked== text.\n\n```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst x = 1;\n```\n',
    '# Intro {#sec:intro}\n\n![Cap](a.png){#fig:a}\n\nSee @fig:a and @sec:intro and a note[^n].\n\n[^n]: Note.\n',
    ...fs.readdirSync(path.join(here, 'fixtures')).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(here, 'fixtures', f), 'utf8')),
  ];
  for (const d of docs) {
    const blocks = renderBlocks(d, (x) => x);
    assert.equal(blocks.join(''), whole.render(d));
    const notes = blocks.filter((b) => b.includes('class="footnotes"'));
    assert.ok(notes.length <= 1 && (!notes.length || notes[0] === blocks.at(-1)));
  }
  assert.equal(renderBlocks('# A\n\nB\n\n- c\n- d\n', (x) => x).length, 3);
});

test('images on a Windows drive are local paths, not URLs with a one-letter scheme', () => {
  const seen = [];
  const html = renderMarkdown('![a](C:\\figs\\a.png) ![b](C:/figs/b.png) ![c](<D:\\my figs\\c.png>)\n', (src) => {
    seen.push(src);
    return `vscode-resource:${seen.length}`;
  });
  assert.deepEqual(seen, ['C:\\figs\\a.png', 'C:/figs/b.png', 'D:\\my figs\\c.png']);
  assert.match(html, /<img src="vscode-resource:1" alt="a"> <img src="vscode-resource:2" alt="b"> <img src="vscode-resource:3" alt="c">/);
  // Real schemes, protocol-relative URLs and anchors are left alone.
  const other = renderMarkdown('![x](https://e.org/x.png) ![y](data:image/png;base64,AA) ![z](//e.org/z.png) ![w](file:///tmp/w.png)\n', () => 'RESOLVED');
  assert.doesNotMatch(other, /RESOLVED/);
});

test('URL schemes need two or more characters', () => {
  assert.equal(hasUrlScheme('C:/notes/other.md'), false);
  assert.equal(hasUrlScheme('c:\\x.md'), false);
  assert.equal(hasUrlScheme('https://e.org'), true);
  assert.equal(hasUrlScheme('vscode://file/x'), true);
  assert.equal(hasUrlScheme('mailto:a@b.c'), true);
  assert.equal(hasUrlScheme('notes/other.md'), false);
});

test('network paths are never resolved as local images', () => {
  // After Markdown's escapes these are \\srv\share\a.png and /\srv\share\b.png: network paths on Windows.
  const html = renderMarkdown(String.raw`![a](<\\\\srv\\share\\a.png>) ![b](/\\srv\\share\\b.png)` + '\n', () => 'RESOLVED');
  assert.doesNotMatch(html, /RESOLVED/);
  assert.match(renderMarkdown(String.raw`![c](\\figs\\c.png)` + '\n', () => 'RESOLVED'), /RESOLVED/, 'one backslash: a path on the current drive');
});

test('images outside the allowed folders go inline: image files only, never network paths', () => {
  const { inlineImage } = require('../dist/lib.cjs');
  const dir = fs.mkdtempSync(path.join(here, 'tmp', 'img-'));
  const png = path.join(dir, 'a.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(inlineImage(png), 'data:image/png;base64,iVBORw==');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'secret');
  assert.equal(inlineImage(path.join(dir, 'notes.txt')), null, 'not an image type');
  fs.mkdirSync(path.join(dir, 'd.png'));
  assert.equal(inlineImage(path.join(dir, 'd.png')), null, 'a folder');
  assert.equal(inlineImage(path.join(dir, 'missing.png')), null);
  assert.equal(inlineImage('\\\\srv\\share\\a.png', 'win32'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
