// Review with Claude: the CLI's `comment` command builds anchors the viewer
// re-finds in the rendered text, agent drafts stay out of Submit and Send
// until triaged, and the reviewer presets turn into a prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const { store } = lib;
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'review');
const cli = path.join(here, '..', 'cli', 'mdreview.mjs');
const anchorJs = path.join(here, 'tmp', 'anchor-review.cjs');
fs.mkdirSync(path.dirname(anchorJs), { recursive: true });
esbuild.buildSync({ entryPoints: [path.join(here, '..', 'webview', 'anchor.ts')], outfile: anchorJs, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' });
const { locate } = require(anchorJs);

const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: tmp, encoding: 'utf8' });

const DOC = [
  '---', // 1
  'title: A study', // 2
  '---', // 3
  '', // 4
  '# Methods and *data* {#sec:m}', // 5
  '', // 6
  'Riders must trust that **a dock will be free** at the end of a trip ([Rivera & Chen, 2021](refs.md#rc)).', // 7
  '', // 8
  'A dock will be free, we assume, in the model too. See the `dock_count` field and snake_case_names.', // 9
  '', // 10
  '> Quoted _emphasis_ inside a blockquote, with an escaped \\*star\\*.', // 11
  '', // 12
  '- First item with [a link](http://x.y) and', // 13
  '  a second line', // 14
  '- [ ] A task about AT&amp;T pricing', // 15
  '', // 16
  '1. Numbered step one', // 17
  '', // 18
  '| Station | Docks |', // 19
  '|---------|------:|', // 20
  '| Main St | 12 |', // 21
  '', // 22
  'Results follow.[^1] Then 2 * 3 = 6 and ~~old~~ text.', // 23
  '', // 24
  '[^1]: A footnote.', // 25
  '',
].join('\n');

function setup(name = 'paper.md', text = DOC) {
  fs.mkdirSync(tmp, { recursive: true });
  const md = path.join(tmp, name);
  fs.writeFileSync(md, text);
  fs.rmSync(md + '.comments.json', { force: true });
  return md;
}

/** The text the viewer anchors on: text nodes of the rendered HTML (the test docs have no .mdr-ui parts). */
function renderedText(md) {
  const html = lib.renderMarkdown(fs.readFileSync(md, 'utf8'), (s) => s, { docDir: path.dirname(md) });
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  return html.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ent[k]);
}

const last = (md) => store.readSidecar(md).comments.at(-1);

test('comment anchors quotes through markup, and the viewer finds each one again', () => {
  const md = setup();
  const text = renderedText(md);
  const quotes = [
    'Methods and data',
    'a dock will be free at the end of a trip',
    'See the dock_count field and snake_case_names.',
    'Quoted emphasis inside a blockquote, with an escaped *star*.',
    'First item with a link and a second line',
    'A task about AT&T pricing',
    'Numbered step one',
    'Main St',
    'Then 2 * 3 = 6 and old text.',
  ];
  for (const q of quotes) {
    const r = run('comment', 'paper.md', '--quote', q, 'Note');
    assert.equal(r.status, 0, `${q}: ${r.stderr}`);
    const c = last(md);
    assert.equal(c.anchor.quote, q);
    const hit = locate(text, c.anchor);
    assert.ok(hit, `viewer lost "${q}" (prefix "${c.anchor.prefix}", suffix "${c.anchor.suffix}")`);
    assert.equal(text.slice(hit[0], hit[1]).replace(/\s+/g, ' '), q);
  }
  const lines = Object.fromEntries(store.readSidecar(md).comments.map((c) => [c.anchor.quote, [c.anchor.lineStart, c.anchor.lineEnd]]));
  assert.deepEqual(lines['Methods and data'], [5, 5]);
  assert.deepEqual(lines['First item with a link and a second line'], [13, 14]);
  assert.deepEqual(lines['Main St'], [21, 21]);
});

test('a quote given with source markup is stored as it renders', () => {
  const md = setup();
  const r = run('comment', 'paper.md', '--quote', 'trust that **a dock**', 'x');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Quoted as it reads: "trust that a dock"/);
  assert.equal(last(md).anchor.quote, 'trust that a dock');
  assert.ok(locate(renderedText(md), last(md).anchor));
});

test('a repeated quote needs --line, which picks the occurrence the viewer then finds', () => {
  const md = setup();
  const amb = run('comment', 'paper.md', '--quote', 'dock will be free', 'x');
  assert.equal(amb.status, 2);
  assert.match(amb.stderr, /appears 2 times \(lines 7, 9\)\. Add --line/);
  assert.ok(!fs.existsSync(md + '.comments.json'));
  const r = run('comment', 'paper.md', '--quote', 'dock will be free', '--line', '9', 'Second one');
  assert.equal(r.status, 0, r.stderr);
  const c = last(md);
  assert.deepEqual([c.anchor.lineStart, c.anchor.lineEnd], [9, 9]);
  const text = renderedText(md);
  const hit = locate(text, c.anchor);
  assert.equal(hit[0], text.indexOf('A dock will be free,') + 2);
  // The same words twice on one line can't be told apart by line.
  setup('twice.md', 'Then the cat and the cat.\n');
  const same = run('comment', 'twice.md', '--quote', 'the cat', '--line', '1', 'x');
  assert.equal(same.status, 2);
  assert.match(same.stderr, /Quote more of the passage/);
});

test('comment refuses what it cannot anchor, with exit 2', () => {
  setup();
  const cases = [
    [['--quote', 'text that is not there', 'x'], /Quote not found/],
    [['--quote', 'follow. Then 2', 'x'], /footnote marker, math/],
    [['x'], /either --quote/],
    [['--quote', 'Main St', '--document', 'x'], /either --quote/],
    [['--quote', 'Main St', '--kind', 'rant', 'x'], /--kind is question or praise/],
    [['--quote', 'Main St', '--severity', 'huge', 'x'], /--severity is major, minor or nit/],
    [['--document', '--suggest', 'y', 'x'], /whole-document comment has none/],
  ];
  for (const [args, msg] of cases) {
    const r = run('comment', 'paper.md', ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, msg);
  }
  assert.equal(run('comment', 'missing.md', '--document', 'x').status, 2);
});

test('comment writes an agent draft: kind, severity, suggestion, and whole-document notes', () => {
  const md = setup();
  assert.equal(run('comment', 'paper.md', '--quote', 'Numbered step one', '--kind', 'question', '--severity', 'major', '--suggest', 'Step one', 'Why numbered?').status, 0);
  assert.equal(run('comment', 'paper.md', '--document', '--severity', 'minor', 'Needs a conclusion.').status, 0);
  assert.equal(run('comment', 'paper.md', '--quote', 'Main St', '--suggest', '', '--author', 'Codex', 'Drop it').status, 0);
  const [a, b, c] = store.readSidecar(md).comments;
  assert.equal(a.author, 'Claude');
  assert.equal(a.status, 'draft');
  assert.equal(a.origin, 'agent');
  assert.deepEqual([a.kind, a.severity, a.suggestion], ['question', 'major', { text: 'Step one' }]);
  assert.deepEqual([b.scope, b.severity, b.anchor.quote, b.body], ['document', 'minor', '', 'Needs a conclusion.']);
  assert.deepEqual([c.author, c.suggestion], ['Codex', { text: '' }]);
});

function session(md, extra = {}) {
  const posted = [];
  const s = new lib.ReviewSession({
    mdPath: md, author: () => 'R', showResolved: () => true, post: (m) => posted.push(m), resolveImage: (x) => x,
    getText: () => fs.readFileSync(md, 'utf8'), isDirty: () => false, openLink: () => {}, cliPath: '/x/mdreview.mjs', ...extra,
  });
  s.handle({ type: 'ready' });
  return { s, posted };
}

test('Submit and Send to Claude leave agent drafts alone; Keep and Do it triage them', () => {
  const md = setup();
  run('comment', 'paper.md', '--quote', 'Main St', 'Agent one');
  run('comment', 'paper.md', '--quote', 'Numbered step one', 'Agent two');
  const { s, posted } = session(md);
  s.handle({ type: 'addComment', anchor: { quote: 'Results follow.', prefix: '', suffix: '', lineStart: 23, lineEnd: 23 }, body: 'Mine' });
  const data = store.readSidecar(md);
  assert.equal(store.submitDrafts(data), 1);
  assert.deepEqual(data.comments.map((c) => c.status), ['draft', 'draft', 'submitted']);
  s.handle({ type: 'sendToAgent' });
  const sent = posted.filter((m) => m.type === 'agentPrompt').at(-1);
  assert.equal(sent.count, 1);
  assert.doesNotMatch(sent.prompt, /Agent one|Agent two/);
  const [one, two] = store.readSidecar(md).comments;
  s.handle({ type: 'triage', id: one.id, action: 'keep' });
  const kept = store.readSidecar(md).comments[0];
  assert.deepEqual([kept.author, kept.suggestedBy, kept.origin, kept.status], ['R', 'Claude', undefined, 'draft']);
  s.handle({ type: 'triage', id: two.id, action: 'do' });
  const done = store.readSidecar(md).comments[1];
  assert.deepEqual([done.author, done.status, done.origin], ['R', 'submitted', undefined]);
  const asked = posted.filter((m) => m.type === 'agentPrompt').at(-1);
  assert.match(asked.prompt, new RegExp(`review comment with id ${two.id}`));
  // Dismiss is a plain delete.
  s.handle({ type: 'deleteComment', id: one.id });
  assert.equal(store.readSidecar(md).comments.length, 2);
});

test('the reviewer menu lists workspace reviewers on demand, and a review round counts Claude\'s drafts', () => {
  const md = setup();
  const dir = path.join(tmp, '.mdreview', 'reviewers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'House style.md'), 'Use British spelling.\n');
  fs.writeFileSync(path.join(dir, 'Empty.md'), '  \n');
  const { s, posted } = session(md, { reviewComments: () => 2 });
  s.handle({ type: 'listReviewers' });
  const list = posted.find((m) => m.type === 'reviewers').presets;
  assert.deepEqual(list.map((p) => p.label), ['Copy edit', 'Clarity and flow', 'Methods reviewer', 'Claims need citations', 'Reviewer 2 (tough but fair)', 'House style']);
  s.handle({ type: 'startReview', preset: 'file:House style.md' });
  const p = posted.filter((m) => m.type === 'agentPrompt').at(-1);
  assert.equal(p.review, 'House style');
  assert.match(p.prompt, /Use British spelling\./);
  assert.match(p.prompt, /at most 2 comments/);
  assert.deepEqual(posted.filter((m) => m.type === 'round').at(-1).round, { total: 0, done: 0, resolved: 0, questions: 0, suggestions: 0, questionIds: [], finished: false, review: true, startedAt: posted.filter((m) => m.type === 'round').at(-1).round.startedAt });
  run('comment', 'paper.md', '--quote', 'Main St', 'a');
  run('comment', 'paper.md', '--document', 'b');
  s.onSidecarChanged();
  const r = posted.filter((m) => m.type === 'round').at(-1).round;
  assert.deepEqual([r.total, r.finished, r.review], [2, true, true]);
  s.handle({ type: 'startReview', preset: 'custom', instruction: '  ' });
  assert.match(posted.at(-1).message, /Type what Claude should look for/);
  fs.rmSync(path.join(tmp, '.mdreview'), { recursive: true, force: true });
});

test('the review prompt carries the reviewer brief, the cap, and the comment command', () => {
  const [preset] = lib.BUILTIN_PRESETS;
  const out = lib.buildReviewPrompt({ mdPath: '/w/docs/a.md', cwd: '/w', preset, cliPath: '/x/mdreview.mjs', existing: 3 });
  assert.match(out, /Please review docs\/a\.md as a first reviewer\. Reviewer: Copy edit\./);
  assert.ok(out.includes(preset.instructions));
  assert.match(out, /at most 12 comments, most important first/);
  assert.match(out, /node "\/x\/mdreview\.mjs" comment "docs\/a\.md" --quote "<exact text>" --severity major\|minor\|nit/);
  assert.match(out, /--suggest "<text>"/);
  assert.match(out, /--document/);
  assert.match(out, /already has 3 threads/);
  assert.match(out, /Don't edit docs\/a\.md/);
  const custom = lib.buildReviewPrompt({ mdPath: '/w/a.md', cwd: '/w', preset: { label: 'Custom', instructions: 'Check the units.' }, max: 5 });
  assert.match(custom, /Check the units\./);
  assert.match(custom, /at most 5 comments/);
  assert.match(custom, /node \.claude\/skills\/md-review\/mdreview\.mjs comment/);
});
