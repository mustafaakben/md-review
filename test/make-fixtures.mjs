// Generates the test fixtures: a fictional paper in the shape of a real
// manuscript (headings, citations, pipe tables with bold headers, a figure with
// a pandoc width, *Note.* paragraphs, lists, math, footnotes).
//   test/fixtures/sample-crlf.md   CRLF line endings
//   test/fixtures/sample-lf.md     LF line endings
// Several tests address blocks by line number, so the layout of the first
// ~90 lines is fixed here on purpose. Run: node test/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'fixtures');

const L = []; // L[i] is 0-based source line i
const at = (i, text) => {
  while (L.length < i) L.push('');
  if (L.length !== i) throw new Error(`line ${i} already used`);
  L.push(text);
};

at(0, '# Abstract');
at(2, 'Shared bicycles change how residents plan short trips, choose routes, and combine modes of transport. We describe a fictional study of 1,204 riders across six cities (*N* = 1,204) and report how station placement, pricing, and weather relate to weekly use. Station density explained the largest share of variance in trips per rider, and the association held in every city.');
at(4, '***Keywords:*** bicycle sharing; urban mobility; station placement; travel behavior; measurement');
at(6, '# 1. Introduction');
at(8, 'City bike-share systems now operate in hundreds of cities. Riders use them for commuting, errands, and leisure, and each use depends on whether a working bicycle is close by when it is needed.');
at(10, 'These systems require more than enthusiasm for active travel. Operators must balance fleet size against demand, and riders must trust that a dock will be free at the end of a trip (Rivera & Chen, 2021). Planners also need evidence about which design choices matter most.');
at(12, 'Research on these questions remains fragmented. Studies span transport engineering, public health, and urban economics, and they rarely share a common measure of use.');
at(14, '## 1.1. Measurement Gap');
at(16, 'Existing measures count trips, but they differ in what they treat as a trip and how they handle rebalancing by operators.');
at(18, 'The present study focuses on the choices riders make before, during, and after each ride, and on how station design shapes those choices.');
at(20, 'Station placement makes these established travel decisions relevant to specific design questions, such as spacing, dock count, and proximity to transit.');
at(22, '## 1.2. Conceptual Framework');
at(24, 'We define bike-share use as the set of observable trips a rider starts and completes within a week, grouped by purpose.');
at(26, '**Table 1**');
at(28, '*Station Conditions and Rider Responses*');
at(30, '| **Station condition** | **Station function** | **Rider response** | **Example measure** |');
at(31, '|:---|:---|:---|:---|');
at(32, '| Uncertain availability: variable demand, empty docks at peak hours | Signal availability | Plan ahead | Share of trips started after checking the app |');
at(33, '| Changing routes: new lanes, closed streets, detours | Guide routing | Adapt the route | Median detour length in meters |');
at(34, '| Pricing changes as membership plans expand | Set incentives | Compare costs | Trips per rider after a price change |');
at(36, '*Note.* Rows describe fictional conditions used only to exercise the renderer.');
at(38, '## 1.3. Hypotheses');
at(40, 'We expected three patterns:');
at(42, '1. Denser station networks would increase weekly trips.');
at(43, '2. Higher prices would reduce casual trips more than commuting trips.');
at(44, '3. Rain would reduce trips on the same day but not across the week.');
at(46, 'Two further questions were exploratory:');
at(48, '- Whether distance to the nearest transit stop moderates the density effect.');
at(49, '- Whether the effects differ between members and casual riders.');
at(51, 'Weekly trips were modeled as $y_{ij} = \\beta_0 + \\beta_1 d_{j} + u_j + e_{ij}$, where $d_j$ is station density in city $j$.');
at(53, '$$');
at(54, 'R^2_{\\text{marginal}} = \\frac{\\sigma^2_f}{\\sigma^2_f + \\sigma^2_u + \\sigma^2_e}');
at(55, '$$');
at(57, 'Density was measured as docks per square kilometer within 500 m of each rider\'s home.[^density]');
at(59, '[^density]: Fictional; chosen only to exercise footnote rendering.');
at(61, '> A blockquote, to check that quoted material renders and stays editable as raw source.');
at(63, '```text');
at(64, 'code blocks fall back to raw-source editing');
at(65, '```');
at(67, 'Water is H~2~O and the area is 2^10^ square meters, which exercises sub- and superscripts.');
at(69, '---');
at(71, '## 1.4. Data Sources');
at(73, 'Trip records came from six fictional operators. Each record lists a start station, an end station, a start time, and a duration in seconds.');
at(75, '**Figure 1**');
at(78, '*Conceptual Model of Station Density and Use*');
at(80, '![Conceptual model: station density, pricing, and weather feed into weekly trips.](media/sample/figure-1.png){width="6.5in"}');
at(82, '*Note.* Arrows show the hypothesized direction of each association. The model is illustrative.');
at(84, '## 1.5. Contributions');
at(86, 'The study offers a common measure of use, a comparison across six cities, and a template for evaluating station design.');
at(88, '# 2. Method');
at(90, '## 2.1. Participants');
at(92, 'Riders were recruited through operator newsletters. Table 2 summarizes the sample.');
at(94, '**Table 2**');
at(96, '*Sample Characteristics by City*');
at(98, '| City | *n* | Members (%) | Median age |');
at(99, '|:---|---:|---:|---:|');
const cities = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir'];
cities.forEach((c, k) => at(100 + k, `| ${c} | ${190 + k * 7} | ${48 + k * 3} | ${29 + k} |`));
at(107, '## 2.2. Measures');
at(109, 'Weekly trips, trip purpose, and membership status were taken from operator records. Weather came from the nearest public station.');
at(111, '# 3. Results');
at(113, 'Station density was associated with more weekly trips in every city (see Table 1 and Figure 1).');
at(115, '# References');
at(117, 'Rivera, A., & Chen, B. (2021). Docking decisions in shared mobility. *Journal of Fictional Transport*, *12*(3), 45–67.');
L.push('');

fs.mkdirSync(path.join(dir, 'media', 'sample'), { recursive: true });
fs.writeFileSync(path.join(dir, 'sample-crlf.md'), L.join('\r\n'));
fs.writeFileSync(path.join(dir, 'sample-lf.md'), L.join('\n'));

// A 4x4 grey PNG as the figure.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 0, 0, 0, 0]);
const raw = Buffer.alloc(4 * 5, 0xb0);
for (let r = 0; r < 4; r++) raw[r * 5] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(dir, 'media', 'sample', 'figure-1.png'), png);
console.log(`wrote ${L.length} lines to sample-crlf.md and sample-lf.md`);
