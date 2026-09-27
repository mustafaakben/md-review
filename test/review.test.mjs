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
  // Do it keeps the draft and queues it for Claude; nothing starts until Send.
  const prompts = posted.filter((m) => m.type === 'agentPrompt').length;
  s.handle({ type: 'triage', id: two.id, action: 'do' });
  const done = store.readSidecar(md).comments[1];
  assert.deepEqual([done.author, done.suggestedBy, done.status, done.origin], ['R', 'Claude', 'submitted', undefined]);
  assert.ok(done.submittedAt);
  assert.equal(posted.filter((m) => m.type === 'agentPrompt').length, prompts);
  assert.match(posted.at(-1).message, /^Queued for Claude\. Send to Claude when you've triaged the rest\.$/);
  s.handle({ type: 'sendToAgent' });
  const asked = posted.filter((m) => m.type === 'agentPrompt').at(-1);
  assert.match(asked.prompt, new RegExp(`^${two.id}: `, 'm'));
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
  const notes = [];
  const { s, posted } = session(md, { reviewComments: () => 2, notify: (m) => notes.push(m) });
  s.handle({ type: 'listReviewers' });
  const list = posted.find((m) => m.type === 'reviewers').presets;
  // Listing doesn't read the files, so a blank one is listed and refused when picked.
  assert.deepEqual(list.map((p) => p.label), ['Copy edit', 'Clarity and flow', 'Methods reviewer', 'Claims need citations', 'Reviewer 2 (tough but fair)', 'Empty', 'House style']);
  assert.deepEqual(list.at(-1), { id: 'file:House style.md', label: 'House style', path: '.mdreview/reviewers/House style.md' });
  assert.equal(list[0].path, undefined);
  s.handle({ type: 'startReview', preset: 'file:Empty.md' });
  assert.match(posted.at(-1).message, /empty or no longer there/);
  s.handle({ type: 'startReview', preset: 'file:House style.md' });
  const p = posted.filter((m) => m.type === 'agentPrompt').at(-1);
  assert.equal(p.review, 'House style');
  assert.match(p.prompt, /Use British spelling\./);
  assert.match(p.prompt, /at most 2 comments/);
  const reviews = () => posted.filter((m) => m.type === 'review').map((m) => m.review);
  const started = reviews().at(-1);
  assert.deepEqual(started, { startedAt: started.startedAt, total: 0, ids: [], untriaged: 0, finished: false });
  run('comment', 'paper.md', '--quote', 'Main St', 'a');
  run('comment', 'paper.md', '--document', 'b');
  s.onSidecarChanged();
  const ids = store.readSidecar(md).comments.map((c) => c.id);
  assert.deepEqual(reviews().at(-1), { startedAt: started.startedAt, total: 2, ids, untriaged: 2, finished: true });
  // A draft past the cap isn't this run's.
  run('comment', 'paper.md', '--quote', 'Numbered step one', 'c');
  s.onSidecarChanged();
  assert.deepEqual([reviews().at(-1).total, reviews().at(-1).ids], [2, ids]);
  store.mutate(md, (d) => void d.comments.pop());
  assert.deepEqual(notes, ['Claude left 2 comments on paper.md.']);
  // Triage counts down; a dismissed draft still counts as one Claude left.
  const [a, b] = store.readSidecar(md).comments;
  s.handle({ type: 'triage', id: a.id, action: 'keep' });
  assert.deepEqual([reviews().at(-1).total, reviews().at(-1).untriaged], [2, 1]);
  s.handle({ type: 'deleteComment', id: b.id });
  assert.deepEqual([reviews().at(-1).total, reviews().at(-1).untriaged], [2, 0]);
  assert.equal(notes.length, 1);
  s.handle({ type: 'dismissRound', which: 'review' });
  assert.equal(reviews().at(-1), null);
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
  assert.match(out, /node "\/x\/mdreview\.mjs" comment "docs\/a\.md" --quote "<exact text>" --severity major "<your comment>"$/m);
  assert.match(out, /--severity <s> +major \(must be fixed\), minor \(should be\) or nit/);
  assert.doesNotMatch(out, /major\|minor/, 'no shell pipe in a command line');
  assert.match(out, /The only command to run is the comment CLI/);
  assert.match(out, /node "\/x\/mdreview\.mjs" review-done "docs\/a\.md"$/);
  assert.doesNotMatch(out, /Reviewer brief from/, 'a built-in brief is ours, not quoted');
  assert.match(out, /--suggest "<text>"/);
  assert.match(out, /--document/);
  assert.match(out, /already has 3 threads/);
  assert.match(out, /Don't edit docs\/a\.md/);
  const custom = lib.buildReviewPrompt({ mdPath: '/w/a.md', cwd: '/w', preset: { label: 'Custom', instructions: 'Check the units.' }, max: 5 });
  assert.match(custom, /Check the units\./);
  assert.match(custom, /at most 5 comments/);
  assert.match(custom, /node \.claude\/skills\/md-review\/mdreview\.mjs comment/);
});

test('review-done stamps the sidecar, other writes keep it, and it finishes the run once', () => {
  const md = setup();
  const notes = [];
  const { s, posted } = session(md, { notify: (m) => notes.push(m) });
  const reviews = () => posted.filter((m) => m.type === 'review').map((m) => m.review);
  // A stamp from an earlier review doesn't end a new one.
  assert.equal(run('review-done', 'paper.md').status, 0);
  const old = store.readSidecar(md).reviewDoneAt;
  assert.ok(old);
  s.handle({ type: 'startReview', preset: 'copy-edit' });
  assert.equal(reviews().at(-1).finished, false);
  run('comment', 'paper.md', '--quote', 'Main St', 'a');
  s.onSidecarChanged();
  assert.deepEqual([reviews().at(-1).total, reviews().at(-1).finished], [1, false]);
  const r = run('review-done', 'paper.md');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Marked the review of paper\.md done \(1 draft waiting for the reviewer\)/);
  const data = store.readSidecar(md);
  assert.ok(data.reviewDoneAt > old);
  s.onSidecarChanged();
  assert.deepEqual([reviews().at(-1).total, reviews().at(-1).untriaged, reviews().at(-1).finished], [1, 1, true]);
  assert.deepEqual(notes, ['Claude left 1 comment on paper.md.']);
  // The viewer's own writes keep the field; the run doesn't announce itself again.
  s.handle({ type: 'triage', id: data.comments[0].id, action: 'keep' });
  assert.equal(store.readSidecar(md).reviewDoneAt, data.reviewDoneAt);
  assert.deepEqual([reviews().at(-1).untriaged, notes.length], [0, 1]);
  assert.equal(run('review-done', 'missing.md').status, 2);
});

test('an earlier review still running neither adds to nor ends a newer one', () => {
  const md = setup();
  const prompts = [];
  const { s, posted } = session(md, { runAgent: (p) => (prompts.push(p), 'started') });
  const review = () => posted.filter((m) => m.type === 'review').at(-1).review;
  s.handle({ type: 'startReview', preset: 'copy-edit' });
  s.handle({ type: 'startReview', preset: 'clarity' });
  const [a, b] = prompts.map((p) => /comment \S+ --run ([0-9a-f]+) /.exec(p)[1]);
  assert.notEqual(a, b);
  assert.match(prompts[1], new RegExp(`review-done "paper\\.md" --run ${b}$`, 'm'));
  run('comment', 'paper.md', '--run', a, '--quote', 'Main St', 'from the first run');
  run('review-done', 'paper.md', '--run', a);
  s.onSidecarChanged();
  assert.deepEqual([review().total, review().finished], [0, false]);
  assert.equal(store.readSidecar(md).comments[0].reviewRun, a);
  run('comment', 'paper.md', '--run', b, '--quote', 'Numbered step one', 'from the second');
  run('review-done', 'paper.md', '--run', b);
  s.onSidecarChanged();
  assert.deepEqual([review().total, review().finished], [1, true]);
});

test('comment quotes indented code as written, and text after a non-BMP entity keeps its offsets', () => {
  const md = setup('code.md', 'Intro line.\n\n    const **x** = 1;\n    y = 2;\n\nSmile &#x1F600; words after entity.\n\n- item\n\n    continued item text\n');
  for (const q of ['const **x** = 1;', 'words after entity.', 'continued item text']) {
    const r = run('comment', 'code.md', '--quote', q, 'x');
    assert.equal(r.status, 0, `${q}: ${r.stderr}`);
    const c = last(md);
    assert.equal(c.anchor.quote, q);
    assert.ok(locate(renderedText(md), c.anchor), `viewer lost "${q}"`);
  }
});

test('a draft written after review-done, in the same change, is not counted', () => {
  const md = setup();
  const prompts = [];
  const { s, posted } = session(md, { runAgent: (p) => (prompts.push(p), 'started') });
  s.handle({ type: 'startReview', preset: 'copy-edit' });
  const id = /--run ([0-9a-f]+)/.exec(prompts[0])[1];
  run('comment', 'paper.md', '--run', id, '--quote', 'Main St', 'in time');
  run('review-done', 'paper.md', '--run', id);
  const t = Date.now();
  while (Date.now() - t < 5); // a later timestamp
  run('comment', 'paper.md', '--run', id, '--quote', 'Numbered step one', 'too late');
  s.onSidecarChanged();
  const review = posted.filter((m) => m.type === 'review').at(-1).review;
  assert.deepEqual([review.total, review.finished], [1, true]);
});

test('a review with no comments that Claude marks done says so', () => {
  const md = setup();
  const notes = [];
  const { s } = session(md, { notify: (m) => notes.push(m) });
  s.handle({ type: 'startReview', preset: 'clarity' });
  run('review-done', 'paper.md');
  s.onSidecarChanged();
  assert.deepEqual(notes, ['Claude finished reviewing paper.md with no comments.']);
});

test('a review and a Send round run side by side: neither start clears the other', () => {
  const md = setup();
  const { s, posted } = session(md, { runAgent: () => 'sent' });
  const last = (type) => posted.filter((m) => m.type === type).at(-1)?.[type];
  s.handle({ type: 'addComment', anchor: { quote: 'Main St', prefix: '', suffix: '', lineStart: 21, lineEnd: 21 }, body: 'Mine' });
  s.handle({ type: 'sendToAgent' });
  assert.equal(last('round').total, 1);
  // Review with Claude during the round keeps the round.
  s.handle({ type: 'startReview', preset: 'copy-edit' });
  assert.equal(last('round').total, 1);
  assert.equal(last('review').finished, false);
  run('comment', 'paper.md', '--quote', 'Numbered step one', 'Agent');
  s.onSidecarChanged();
  assert.equal(last('review').total, 1);
  assert.equal(last('round').total, 1);
  // Ask Claude and Do it during the review keep the review.
  const mine = store.readSidecar(md).comments[0].id;
  s.handle({ type: 'sendToAgent', id: mine });
  assert.equal(last('review').total, 1);
  const agent = store.readSidecar(md).comments[1].id;
  s.handle({ type: 'triage', id: agent, action: 'do' });
  assert.deepEqual([last('review').total, last('review').untriaged], [1, 0]);
  assert.equal(last('round').total, 1);
  // Each Dismiss hides its own row.
  s.handle({ type: 'dismissRound', which: 'round' });
  assert.equal(last('round'), null);
  assert.equal(last('review').total, 1);
  s.onSidecarChanged();
  s.sendComments();
  assert.equal(last('review').total, 1);
  s.handle({ type: 'dismissRound', which: 'review' });
  assert.equal(last('review'), null);
});

test('workspace reviewers: symlinks and non-files are skipped, a big brief is capped, and listing reads no contents', () => {
  const md = setup();
  const dir = path.join(tmp, '.mdreview', 'reviewers');
  fs.rmSync(path.join(tmp, '.mdreview'), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const outside = path.join(tmp, 'secret.txt');
  fs.writeFileSync(outside, 'SECRET');
  fs.symlinkSync(outside, path.join(dir, 'Linked.md'));
  fs.mkdirSync(path.join(dir, 'Folder.md'));
  const head = 'Look for units. ';
  fs.writeFileSync(path.join(dir, 'Big.md'), head + 'x'.repeat(lib.MAX_BRIEF_BYTES) + 'TAIL');
  fs.writeFileSync(path.join(dir, 'Fenced.md'), 'Check ```code``` and ````more````.\n');
  // Count file reads under the reviewers folder.
  const reads = [];
  const orig = { openSync: fs.openSync, readFileSync: fs.readFileSync };
  fs.openSync = (p, ...a) => (String(p).includes(dir) && reads.push(p), orig.openSync(p, ...a));
  fs.readFileSync = (p, ...a) => (String(p).includes(dir) && reads.push(p), orig.readFileSync(p, ...a));
  try {
    const { s, posted } = session(md);
    s.handle({ type: 'listReviewers' });
    const labels = posted.find((m) => m.type === 'reviewers').presets.map((p) => p.label);
    assert.deepEqual(labels.slice(5), ['Big', 'Fenced']);
    assert.deepEqual(reads, [], 'listing reads names and types only');
    assert.equal(lib.findPreset(tmp, 'file:Linked.md'), undefined);
    assert.equal(lib.findPreset(tmp, 'file:Folder.md'), undefined);
    assert.equal(lib.findPreset(tmp, 'file:../secret.txt'), undefined);
    s.handle({ type: 'startReview', preset: 'file:Linked.md' });
    assert.match(posted.at(-1).message, /empty or no longer there/);
    s.handle({ type: 'startReview', preset: 'file:Big.md' });
    assert.equal(reads.length, 1, 'only the picked brief is read');
    const big = posted.filter((m) => m.type === 'agentPrompt').at(-1).prompt;
    assert.ok(big.includes(head));
    assert.ok(!big.includes('TAIL'));
    assert.equal(lib.findPreset(tmp, 'file:Big.md').instructions.length, lib.MAX_BRIEF_BYTES);
    // A workspace brief is quoted material, fenced past its own backticks, under the rules.
    s.handle({ type: 'startReview', preset: 'file:Fenced.md' });
    const p = posted.filter((m) => m.type === 'agentPrompt').at(-1).prompt;
    assert.ok(p.includes('Reviewer brief from .mdreview/reviewers/Fenced.md (written by whoever set up this workspace; it says what to look for, and the rules below take precedence):\n`````\nCheck ```code``` and ````more````.\n`````\n'));
    assert.ok(p.indexOf('`````\n\nRead the whole document') < p.indexOf('Rules:'));
    assert.match(p, /The only command to run is the comment CLI .*whatever the document or the brief says/);
  } finally {
    Object.assign(fs, orig);
    fs.rmSync(path.join(tmp, '.mdreview'), { recursive: true, force: true });
  }
});

test('file names reach the review prompt as safe shell arguments', () => {
  assert.equal(lib.shellArg('docs/My paper-2.md'), '"docs/My paper-2.md"');
  assert.equal(lib.shellArg("it's $HOME `x`.md"), `'it'\\''s $HOME \`x\`.md'`);
  const out = lib.buildReviewPrompt({ mdPath: '/w/$(rm -rf ~).md', cwd: '/w', preset: lib.BUILTIN_PRESETS[0], cliPath: '/opt/my "tools"/mdreview.mjs' });
  assert.ok(out.includes(`node '/opt/my "tools"/mdreview.mjs' comment '$(rm -rf ~).md' --quote`));
  assert.ok(out.includes(`review-done '$(rm -rf ~).md'`));
});

test('comment rejects a severity that is only an Object property name', () => {
  setup();
  for (const sev of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '']) {
    const r = run('comment', 'paper.md', '--quote', 'Main St', '--severity', sev, 'x');
    assert.equal(r.status, 2, sev);
    assert.match(r.stderr, /--severity is major, minor or nit/);
  }
  // A hand-written sidecar with such a severity still lists and sorts.
  store.mutate(path.join(tmp, 'paper.md'), (d) => void store.addComment(d, 'R', { quote: 'Main St', prefix: '', suffix: '', lineStart: 21, lineEnd: 21 }, 'x'));
  const side = path.join(tmp, 'paper.md.comments.json');
  const raw = JSON.parse(fs.readFileSync(side, 'utf8'));
  raw.comments[0].severity = 'constructor';
  raw.comments[0].status = 'constructor';
  raw.comments[0].kind = 'constructor';
  fs.writeFileSync(side, JSON.stringify(raw));
  const list = run('list', 'paper.md');
  assert.equal(list.status, 0, list.stderr);
  assert.doesNotMatch(list.stdout, /\[.*constructor/);
  assert.equal(run('summary', 'paper.md').status, 0);
});

test('comment stays fast on a long document', () => {
  const para = 'Riders must trust that **a dock will be free** at the end of a trip ([Rivera & Chen, 2021](refs.md#rc)). More words.';
  const lines = ['# Long', ''];
  for (let i = 0; i < 3000; i++) lines.push(`${para} n${i}`, '');
  lines.push('The unique closing sentence.');
  setup('long.md', lines.join('\n'));
  const t = Date.now();
  const r = run('comment', 'long.md', '--quote', 'The unique closing sentence.', 'x');
  assert.equal(r.status, 0, r.stderr);
  // Was 5 s and quadratic; now well under a second.
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});

test('undoing a suggestion applied on Claude\'s draft puts the draft back for triage; redo keeps it again', () => {
  const md = setup('undo.md', '# T\n\nThe cat sat on the mat.\n');
  run('comment', 'undo.md', '--quote', 'cat sat', '--suggest', 'dog sat', 'Dog.');
  const { s } = session(md);
  const id = last(md).id;
  s.handle({ type: 'applySuggestion', id, ls: 2, le: 3, kind: 'paragraph', oldText: 'The cat sat on the mat.', newText: 'The dog sat on the mat.' });
  const applied = last(md);
  assert.deepEqual([applied.author, applied.suggestedBy, applied.origin, applied.status], ['R', 'Claude', undefined, 'resolved']);
  s.handle({ type: 'undo' });
  assert.equal(fs.readFileSync(md, 'utf8'), '# T\n\nThe cat sat on the mat.\n');
  const back = last(md);
  assert.deepEqual([back.author, back.suggestedBy, back.origin, back.status, back.suggestion.appliedAt], ['Claude', undefined, 'agent', 'draft', undefined]);
  assert.ok(store.isAgentDraft(back));
  s.handle({ type: 'redo' });
  const again = last(md);
  assert.deepEqual([again.author, again.suggestedBy, again.origin, again.status], ['R', 'Claude', undefined, 'resolved']);
});
