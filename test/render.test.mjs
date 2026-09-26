// Renderer extensions: YAML front matter and CriticMarkup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderMarkdown } = require('../dist/lib.cjs');
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
