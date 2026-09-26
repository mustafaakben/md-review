// Agent CLI: folder scans, summary, the `next` loop with source locating,
// context, init-claude, and the folder prompt Send to Claude builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'cli');
const cli = path.join(here, '..', 'cli', 'mdreview.mjs');

const run = (args, cwd = tmp) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

function comment(id, quote, extra = {}) {
  return {
    id,
    author: 'Reviewer',
    createdAt: '2026-09-26T10:00:00.000Z',
    anchor: { quote, prefix: '', suffix: '', lineStart: 1, lineEnd: 1, ...extra.anchor },
    body: extra.body ?? `About ${quote}`,
    status: extra.status ?? 'submitted',
    submittedAt: null,
    resolvedAt: null,
    replies: extra.replies ?? [],
  };
}

function write(rel, md, comments) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, md);
  if (comments) fs.writeFileSync(p + '.comments.json', JSON.stringify({ schemaVersion: 1, file: path.basename(p), comments }, null, 2));
  return p;
}

const paper = [
  '# Methods', // 1
  '', // 2
  'Riders must trust that **a dock will be free** at the end of a trip ([Rivera & Chen, 2021](refs.md#rc)).', // 3
  '', // 4
  'A dock will be free, we assume, in the model too.', // 5
  '', // 6
  'Results follow.[^1] See <em>Table 2</em> for details.', // 7
  '',
  '[^1]: A footnote.',
  '',
].join('\n');

function setup() {
  fs.rmSync(tmp, { recursive: true, force: true });
  write('ch1/paper.md', paper, [
    // Stale hint (line 1), markup inside the quote, link text in the suffix.
    comment('c_bold', 'a dock will be free at the end of a trip', { anchor: { prefix: 'Riders must trust that ', suffix: ' (Rivera & Chen, 2021)', lineStart: 1, lineEnd: 1 } }),
    // Appears twice; the prefix picks line 5 even though the hint says 3.
    comment('c_dup', 'dock will be free', { anchor: { prefix: 'A ', suffix: ', we assume', lineStart: 3, lineEnd: 3 } }),
    // Footnote ref and HTML tags between the words.
    comment('c_tags', 'Results follow. See Table 2', { anchor: { lineStart: 7, lineEnd: 7 } }),
    comment('c_gone', 'text that is no longer here', { anchor: { lineStart: 5, lineEnd: 5 } }),
    comment('c_draft', 'Methods', { status: 'draft' }),
  ]);
  write('ch2/notes.md', 'One.\n\nTwo.\n', [
    comment('c_done', 'One', { status: 'resolved' }),
    comment('c_asked', 'Two', { anchor: { lineStart: 3, lineEnd: 3 }, replies: [{ id: 'r_1', author: 'Claude', createdAt: 't', body: 'Which figure?' }] }),
  ]);
  // Hidden folders and node_modules are not searched.
  write('node_modules/pkg/readme.md', 'x\n', [comment('c_nm', 'x')]);
  write('.claude/skills/x.md', 'x\n', [comment('c_hidden', 'x')]);
}

test('summary and list cover a folder, skipping node_modules and dot-folders', () => {
  setup();
  const out = run(['summary']);
  assert.match(out, /ch1\/paper\.md\s+4 open · 1 draft · 0 resolved/);
  assert.match(out, /ch2\/notes\.md\s+1 open \(1 waiting on the reviewer\) · 0 draft · 1 resolved/);
  assert.match(out, /total\s+5 open \(1 waiting on the reviewer\) · 1 draft · 1 resolved/);
  assert.doesNotMatch(out, /node_modules|\.claude/);

  const listed = JSON.parse(run(['list', '.', '--status', 'submitted', '--json']));
  assert.deepEqual(listed.map((c) => c.file + ' ' + c.id).sort(), [
    'ch1/paper.md c_bold',
    'ch1/paper.md c_dup',
    'ch1/paper.md c_gone',
    'ch1/paper.md c_tags',
    'ch2/notes.md c_asked',
  ]);
  // One file keeps the old single-file output (no headers).
  assert.doesNotMatch(run(['list', 'ch2/notes.md']), /^==/m);
  assert.match(run(['list', 'ch1', 'ch2']), /^== ch1\/paper\.md/m);
});

test('context finds the quote in the source despite markup and stale hints', () => {
  setup();
  const ctx = (id) => JSON.parse(run(['context', 'ch1/paper.md', id, '--json']));
  const bold = ctx('c_bold');
  assert.equal(bold.found, true);
  assert.equal(bold.lineStart, 3);
  assert.equal(bold.source.find((l) => l.quoted).text.startsWith('Riders'), true);

  const dup = ctx('c_dup');
  assert.equal(dup.lineStart, 5, 'prefix/suffix pick the right occurrence');

  const tags = ctx('c_tags');
  assert.equal(tags.found, true);
  assert.equal(tags.lineStart, 7);

  const gone = ctx('c_gone');
  assert.equal(gone.found, false);
  assert.equal(gone.lineStart, 5, 'falls back to the stored hint');
  assert.match(run(['context', 'ch1/paper.md', 'c_gone']), /quote not found in the source as-is/);

  const text = run(['context', 'ch1/paper.md', 'c_bold', '--lines', '1']);
  assert.match(text, /^> 3 \| Riders/m);
  assert.match(text, /^  2 \| $/m);
  assert.doesNotMatch(text, /^ {2}5 \|/m, '--lines limits the context');
});

test('next walks open comments in order and skips ones waiting on the reviewer', () => {
  setup();
  const next = (...a) => JSON.parse(run(['next', ...a, '--json']));
  let n = next();
  assert.equal(n.comment.id, 'c_bold', 'first file, lowest line hint first');
  assert.equal(n.file, 'ch1/paper.md');
  assert.equal(n.remaining, 3, 'c_asked ends with a Claude reply, so it is not counted');

  for (const id of ['c_bold', 'c_dup', 'c_gone']) run(['resolve', 'ch1/paper.md', id, 'Done.']);
  n = next();
  assert.equal(n.comment.id, 'c_tags');
  run(['reply', 'ch1/paper.md', 'c_tags', 'Which table?']);
  assert.equal(run(['next', '--json']).trim(), 'null');
  assert.match(run(['next']), /No open comments/);
  assert.equal(next('--all').comment.id, 'c_tags', '--all includes threads we already answered');
  assert.equal(next('ch2', '--all').comment.id, 'c_asked');

  const text = run(['next', '--all', 'ch1']);
  assert.match(text, /^\[c_tags\] SUBMITTED ch1\/paper\.md:7 Reviewer/m);
  assert.match(text, /This is the last open comment\./);
});

test('unknown paths and ids fail with a message', () => {
  setup();
  const r = spawnSync(process.execPath, [cli, 'list', 'nope'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Not found: nope/);
  const r2 = spawnSync(process.execPath, [cli, 'context', 'ch1/paper.md', 'c_x'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /No comment with id c_x/);
});

test('init-claude installs a working skill and refuses to overwrite edits', () => {
  setup();
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(proj);
  run(['init-claude', proj]);
  const dir = path.join(proj, '.claude', 'skills', 'md-review');
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: md-review\ndescription: .+\n---\n/);
  assert.match(skill, /node \.claude\/skills\/md-review\/mdreview\.mjs next/);
  // The copied CLI runs on its own from the project root.
  write('proj/draft.md', 'Hello.\n', [comment('c_p', 'Hello')]);
  assert.match(execFileSync(process.execPath, ['.claude/skills/md-review/mdreview.mjs', 'summary'], { cwd: proj, encoding: 'utf8' }), /draft\.md\s+1 open/);

  run(['init-claude', proj]); // unchanged: fine
  fs.appendFileSync(path.join(dir, 'SKILL.md'), '\nMy house rules.\n');
  const r = spawnSync(process.execPath, [cli, 'init-claude', proj], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--force/);
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /My house rules/);
  run(['init-claude', proj, '--force']);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /My house rules/);
});

test('folder prompt lists files and drives the next loop', () => {
  const p = lib.buildFolderPrompt({
    folder: '/w/papers',
    cwd: '/w',
    files: [
      { mdPath: '/w/papers/a.md', open: 2 },
      { mdPath: '/w/papers/b/c.md', open: 1 },
    ],
    cliPath: '/ext/cli/mdreview.mjs',
  });
  assert.match(p, /^Please address the 3 open MD Review comments in 2 files under papers:/);
  assert.match(p, /^- papers\/a\.md \(2 open\)$/m);
  assert.match(p, /^- papers\/b\/c\.md \(1 open\)$/m);
  assert.match(p, /node "\/ext\/cli\/mdreview\.mjs" next "papers"/);
  const one = lib.buildFolderPrompt({ folder: '/w', cwd: '/w', files: [{ mdPath: '/w/a.md', open: 1 }], cliPath: '/c.mjs' });
  assert.match(one, /^Please address the 1 open MD Review comment in 1 file in this folder:/);
  assert.match(one, /next "\."/);
});

test('locating survives characters that lengthen when lowercased (İ)', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  write('tr.md', 'Kahneman & İnönü (2020).\n\nsecond line target\n\nthird\n', [comment('c_tr', 'second line target', { anchor: { lineStart: 1, lineEnd: 1 } })]);
  const ctx = JSON.parse(run(['context', 'tr.md', 'c_tr', '--json']));
  assert.equal(ctx.found, true);
  assert.deepEqual([ctx.lineStart, ctx.lineEnd], [3, 3]);
});

test('next orders by located line, and a broken sidecar is skipped with a warning', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  write('a.md', 'Alpha one.\n\nBeta two.\n\nGamma three.\n', [
    comment('c_late', 'Gamma three', { anchor: { lineStart: 1, lineEnd: 1 } }), // stale hint says line 1
    comment('c_early', 'Alpha one', { anchor: { lineStart: 3, lineEnd: 3 } }),
  ]);
  write('b.md', 'x\n');
  fs.writeFileSync(path.join(tmp, 'b.md.comments.json'), '{bad');
  const r = spawnSync(process.execPath, [cli, 'next', '--json'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Skipping b\.md\.comments\.json/);
  assert.equal(JSON.parse(r.stdout).comment.id, 'c_early');
  assert.match(spawnSync(process.execPath, [cli, 'summary'], { cwd: tmp, encoding: 'utf8' }).stdout, /a\.md\s+2 open/);
  const r2 = spawnSync(process.execPath, [cli, 'context', 'nope.md', 'c_1'], { cwd: tmp, encoding: 'utf8' });
  assert.match(r2.stderr, /Not found: nope\.md/);
});

test('a thread reopened after the agent resolved it is open again', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  const md = write('p.md', 'Some claim here.\n', [comment('c1', 'Some claim')]);
  run(['resolve', 'p.md', 'c1', 'Fixed.']);
  run(['reopen', 'p.md', 'c1']);
  assert.equal(JSON.parse(run(['next', '--json'])).comment.id, 'c1');
  run(['reply', 'p.md', 'c1', 'Which part?']);
  assert.match(run(['next']), /No open comments\. \(1 waiting on the reviewer's answer; --all includes them\)/);
  assert.match(run(['summary']), /p\.md\s+1 open \(1 waiting on the reviewer\)/);

  // The viewer's Reopen (setStatus) stamps reopenedAt too, and it survives a viewer write.
  run(['resolve', 'p.md', 'c1', 'Done.']);
  lib.store.mutate(md, (d) => lib.store.setStatus(d, 'c1', 'submitted'));
  const c = lib.store.readSidecar(md).comments[0];
  assert.ok(c.reopenedAt, 'reopenedAt stamped');
  assert.equal(lib.store.awaitsAgent(c), true);
  lib.store.mutate(md, (d) => lib.store.addReply(d, 'c1', 'Claude', 'On it.'));
  assert.equal(lib.store.awaitsAgent(lib.store.readSidecar(md).comments[0]), false);
});

test('math is not mistaken for HTML tags or pandoc attributes', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  write('m.md', 'Intro.\n\nWe have $x<y$ holds when $y>0$ and $\\sum_{i=1}^n a_i$ converges nicely.\n', [
    comment('c_lt', 'holds when', { anchor: { lineStart: 1, lineEnd: 1 } }),
    comment('c_sum', 'i=1', { anchor: { lineStart: 1, lineEnd: 1 } }),
  ]);
  const at = (id) => JSON.parse(run(['context', 'm.md', id, '--json']));
  assert.deepEqual([at('c_lt').found, at('c_lt').lineStart], [true, 3]);
  assert.deepEqual([at('c_sum').found, at('c_sum').lineStart], [true, 3]);
});
