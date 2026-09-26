// Pandoc citations against a bibliography, pandoc-crossref numbering, and the
// CLI finding quotes next to citations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { renderMarkdown, parseBibTeX, parseCslJson } = require('../dist/lib.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'cite');
const cli = path.join(here, '..', 'cli', 'mdreview.mjs');

const BIB = `@string{jtr = "Journal of Transport Research"}
@article{rivera2021,
  author = {Rivera, Ada and Chen, Ben},
  title = {Station Density and {Bike-Share} Use},
  journal = jtr, year = 2021, volume = {12}, number = {3}, pages = {45--67},
  doi = {10.1000/x}
}
@book{chen2020, author = "Ben Chen and Carla Diaz and Dan Evans and Eve Ford", title = {Cities}, publisher = {Urban Press}, year = {2020}}
@misc{who2019, author = {{World Health Organization}}, title = {Physical Activity}, year = 2019}
@article{muller2018, author = {M\\"{u}ller, J{\\"o}rg and von Braun, Karl}, title = {Stra{\\ss}en}, year={2018}}
@comment{ @article{ignored, title = {x}} }
`;

function setup(md, bib = BIB, name = 'refs.bib') {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  if (bib !== null) fs.writeFileSync(path.join(tmp, name), bib);
  fs.writeFileSync(path.join(tmp, 'paper.md'), md);
  return renderMarkdown(md, (x) => x, { docDir: tmp });
}
const FM = '---\ntitle: T\nbibliography: refs.bib\n---\n\n';

test('BibTeX: strings, braces, LaTeX accents, corporate and particle names', () => {
  const bib = parseBibTeX(BIB);
  assert.deepEqual([...bib.keys()], ['rivera2021', 'chen2020', 'who2019', 'muller2018']);
  const r = bib.get('rivera2021');
  assert.deepEqual(r.names, ['Rivera', 'Chen']);
  assert.equal(r.container, 'Journal of Transport Research');
  assert.equal(r.title, 'Station Density and Bike-Share Use');
  assert.equal(r.pages, '45–67');
  assert.deepEqual(bib.get('who2019').names, ['World Health Organization']);
  assert.deepEqual(bib.get('muller2018').fullNames, ['Müller, Jörg', 'Karl von Braun']);
  assert.equal(bib.get('muller2018').title, 'Straßen');
  assert.deepEqual(bib.get('chen2020').names, ['Chen', 'Diaz', 'Evans', 'Ford']);
});

test('CSL-JSON entries', () => {
  const bib = parseCslJson(JSON.stringify([{ id: 'k1', author: [{ family: 'Lee', given: 'Min' }, { literal: 'NASA' }], issued: { 'date-parts': [[2019, 5]] }, title: 'T', 'container-title': 'J' }]));
  const e = bib.get('k1');
  assert.deepEqual([e.names, e.year, e.container], [['Lee', 'NASA'], '2019', 'J']);
});

test('citations render author-date, link to a generated References list, and flag unknown keys', () => {
  const html = setup(FM + 'A [@rivera2021, p. 4]. @chen2020 [ch. 2] disagree [see @who2019; -@muller2018] and [@nobody].\n');
  assert.match(html, /\(<a class="mdr-cite" href="#ref-rivera2021" title="Rivera, Ada, and Ben Chen\. 2021\. “Station Density[^"]*">Rivera and Chen 2021<\/a>, p\. 4\)/);
  assert.match(html, />Chen et al\.<\/a> \(2020, ch\. 2\)/);
  assert.match(html, /\(see <a[^>]*>World Health Organization 2019<\/a>; <a[^>]*>2018<\/a>\)/);
  assert.match(html, /<span class="mdr-cite-missing" title="No entry &quot;nobody&quot; in refs\.bib">nobody\?<\/span>/);
  assert.match(html, /<h2 class="mdr-refs-title">References<\/h2>/);
  assert.match(html, /1 citation key not found in refs\.bib: nobody/);
  const order = [...html.matchAll(/id="ref-([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['chen2020', 'muller2018', 'rivera2021', 'who2019']);
  assert.match(html, /<em>Journal of Transport Research<\/em> 12 \(3\): 45–67\. https:\/\/doi\.org\/10\.1000\/x\./);
  assert.match(html, /class="mdr-cite-group mdr-ui"/);
});

test('an existing References heading is reused; suppress-bibliography hides the list', () => {
  const a = setup(FM + 'X [@rivera2021].\n\n# References\n');
  assert.doesNotMatch(a, /mdr-refs-title/);
  assert.match(a, /<h1[^>]*>References<\/h1>\n<section class="mdr-refs/);
  const b = setup('---\nbibliography: refs.bib\nsuppress-bibliography: true\n---\n\nX [@rivera2021].\n');
  assert.match(b, /Rivera and Chen 2021/);
  assert.doesNotMatch(b, /mdr-refs/);
});

test('without a bibliography, @handles and [@x] stay text; emails and links are untouched', () => {
  const html = renderMarkdown('Ping @mustafa, see [@x] and mail ada@example.com or [@a](http://x).\n', (x) => x);
  assert.match(html, /Ping @mustafa, see \[@x\]/);
  assert.match(html, /mailto:ada@example\.com/);
  assert.match(html, /<a href="http:\/\/x">@a<\/a>/);
  const bib = setup(FM + 'Mail ada@example.com or [@rivera2021](http://x).\n');
  assert.match(bib, /mailto:ada@example\.com/);
  // Pandoc reads a citation inside link text; it must not become a nested link.
  assert.match(bib, /<a href="http:\/\/x"><span class="mdr-cite-group mdr-ui"><span class="mdr-cite" title="[^"]*">Rivera and Chen<\/span> \(2021\)<\/span><\/a>/);
});

test('a missing or broken bibliography file is reported, not fatal', () => {
  const html = setup(FM + 'X [@rivera2021].\n', null);
  assert.match(html, /Couldn't read refs\.bib: not found/);
  assert.match(html, /rivera2021\?/);
  const json = setup('---\nbibliography: refs.json\n---\n\nX [@a].\n', '{ nope', 'refs.json');
  assert.match(json, /refs\.json: not valid JSON/);
});

test('cross-refs: figures, tables, equations and sections are numbered and linked', () => {
  const html = renderMarkdown(
    [
      '# Intro {#sec:intro}',
      '',
      'See @fig:map, [@fig:map; @fig:hist], @Tbl:rides, @eq:e, @sec:data and @fig:none.',
      '',
      '![Station map](map.png){#fig:map}',
      '',
      '![Histogram](h.png){#fig:hist}',
      '',
      '# Methods',
      '',
      '## Data {#sec:data}',
      '',
      '| a |',
      '|---|',
      '| 1 |',
      '',
      ': Rides per city {#tbl:rides}',
      '',
      '$$',
      'E = mc^2',
      '$$ {#eq:e}',
      '',
    ].join('\n'),
    (x) => x,
  );
  assert.match(html, /<a class="mdr-xref" href="#fig:map">fig\. 1<\/a>/);
  assert.match(html, /figs\. <a[^>]*>1<\/a>, <a[^>]*>2<\/a>/);
  assert.match(html, />Tbl\. 1</);
  assert.match(html, /href="#eq:e">eq\. 1</);
  assert.match(html, /href="#sec:data">sec\. 2\.1</);
  assert.match(html, /mdr-xref-missing[^>]*>¿fig:none\?/);
  assert.match(html, /<span class="mdr-xref-label mdr-ui">Figure 2:<\/span> Histogram/);
  assert.match(html, /<p id="tbl:rides" class="mdr-tbl-cap"[^>]*><span class="mdr-xref-label mdr-ui">Table 1:<\/span> Rides per city<\/p>/);
  assert.match(html, /<section id="eq:e" class="eqno">[\s\S]*<span>\(1\)<\/span><\/section>/);
  assert.doesNotMatch(html, /mdr-refs/);
});

test('the CLI finds quotes that run across citations and cross-refs', () => {
  const md = FM + 'Station density explains most variance [@rivera2021, p. 4] across cities.\n\nAs @chen2020 [ch. 2] argue, see @fig:map for the network.\n';
  setup(md);
  const at = (quote) => {
    fs.writeFileSync(
      path.join(tmp, 'paper.md.comments.json'),
      JSON.stringify({ schemaVersion: 1, file: 'paper.md', comments: [{ id: 'c1', author: 'R', createdAt: '2026-09-26T10:00:00.000Z', anchor: { quote, prefix: '', suffix: '', lineStart: 1, lineEnd: 1 }, body: 'b', status: 'submitted', replies: [] }] }),
    );
    return JSON.parse(execFileSync(process.execPath, [cli, 'context', 'paper.md', 'c1', '--json'], { cwd: tmp, encoding: 'utf8' }));
  };
  // The viewer leaves generated citation text out of quotes.
  assert.deepEqual([at('most variance  across').found, at('most variance  across').lineStart], [true, 6]);
  assert.deepEqual([at('As  argue, see  for the').found, at('As  argue, see  for the').lineStart], [true, 8]);
});
