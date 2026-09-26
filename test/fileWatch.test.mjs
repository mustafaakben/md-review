// File watching: name matching, when to poll, and half-written sidecars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'fileWatch');

test('names match case-insensitively on Windows and macOS only', () => {
  assert.ok(lib.sameName('paper.md.comments.json', 'Paper.md.comments.json', 'win32'));
  assert.ok(lib.sameName('paper.md.comments.json', 'Paper.md.comments.json', 'darwin'));
  assert.ok(!lib.sameName('paper.md.comments.json', 'Paper.md.comments.json', 'linux'));
  assert.ok(lib.sameName('a.md', 'a.md', 'linux'));
  assert.equal(lib.folderKey('/Docs/Notes', 'darwin'), lib.folderKey('/docs/notes/', 'darwin'));
  assert.notEqual(lib.folderKey('/Docs/Notes', 'linux'), lib.folderKey('/docs/notes', 'linux'));
});

test('polls network paths on Windows, or anywhere with the setting', () => {
  assert.ok(lib.shouldPoll('\\\\wsl$\\Ubuntu\\home\\jo\\a.md', 'win32', false));
  assert.ok(lib.shouldPoll('\\\\wsl.localhost\\Ubuntu\\a.md', 'win32', false));
  assert.ok(lib.shouldPoll('\\\\server\\share\\a.md', 'win32', false));
  assert.ok(!lib.shouldPoll('C:\\docs\\a.md', 'win32', false));
  assert.ok(!lib.shouldPoll('/home/jo/a.md', 'linux', false));
  assert.ok(lib.shouldPoll('/mnt/nfs/a.md', 'linux', true));
  assert.deepEqual(lib.SIDECAR_RETRY_MS, [50, 150, 400]);
});

test('the stamp tracker reports files whose mtime or size changed', async () => {
  const stamps = { a: '1:10', b: '1:20' };
  const t = new lib.StampTracker(['a', 'b'], (f) => stamps[f]);
  assert.deepEqual(await t.check(), []);
  stamps.b = '2:20';
  assert.deepEqual(await t.check(), ['b']);
  assert.deepEqual(await t.check(), []);
  stamps.a = ''; // deleted
  assert.deepEqual(await t.check(), ['a']);
});

test('a check waiting on a slow disk is shared, and real stamps are async', async () => {
  let calls = 0;
  const t = new lib.StampTracker(['a'], async () => (calls++, '1'));
  await t.check();
  const n = calls;
  await Promise.all([t.check(), t.check(), t.check()]);
  assert.equal(calls, n + 1);
  assert.equal(await lib.fileStamp(path.join(here, 'no-such-file')), '');
});

function session(md, extra) {
  const posted = [];
  const timers = [];
  const s = new lib.ReviewSession({
    mdPath: md,
    author: () => 'Reviewer',
    showResolved: () => true,
    post: (m) => posted.push(m),
    resolveImage: (x) => x,
    getText: () => fs.readFileSync(md, 'utf8'),
    isDirty: () => false,
    openLink: () => {},
    schedule: (fn, ms) => timers.push({ fn, ms }),
    ...extra,
  });
  // Run the next pending timer, as if its delay passed.
  const tick = () => {
    const t = timers.shift();
    assert.ok(t, 'a retry is scheduled');
    t.fn();
    return t.ms;
  };
  return { s, posted, timers, tick };
}

const sidecar = (md) => JSON.stringify({ schemaVersion: 1, file: path.basename(md), comments: [
  { id: 'c1', author: 'Claude', createdAt: '2026-01-01T00:00:00Z', anchor: { quote: 'x', prefix: '', suffix: '', lineStart: 1, lineEnd: 1 }, body: 'Done', status: 'submitted', submittedAt: null, resolvedAt: null, replies: [] },
] }, null, 2);

function setup() {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const md = path.join(tmp, 'doc.md');
  fs.writeFileSync(md, '# Doc\n\nx\n');
  return md;
}

test('a half-written sidecar is read again before any error shows', () => {
  const md = setup();
  const full = sidecar(md);
  fs.writeFileSync(md + '.comments.json', full.slice(0, full.length / 2));
  const { s, posted, timers, tick } = session(md);
  s.onSidecarChanged();
  assert.equal(posted.length, 0);
  assert.equal(tick(), 50);
  assert.equal(posted.length, 0);
  fs.writeFileSync(md + '.comments.json', full); // the writer finishes
  assert.equal(tick(), 150);
  assert.ok(!posted.some((m) => m.type === 'error'));
  const comments = posted.filter((m) => m.type === 'comments');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].data.comments[0].id, 'c1');
  assert.equal(timers.length, 0);
});

test('a sidecar that stays broken shows the error after the last retry', () => {
  const md = setup();
  fs.writeFileSync(md + '.comments.json', '{"schemaVersion": 1, "comm');
  const { s, posted, tick } = session(md);
  s.onSidecarChanged();
  assert.deepEqual([tick(), tick(), tick()], [50, 150, 400]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'error');
  assert.match(posted[0].message, /Could not parse doc\.md\.comments\.json/);
});

test('a newer sidecar event replaces pending retries', () => {
  const md = setup();
  fs.writeFileSync(md + '.comments.json', '{');
  const { s, posted, timers, tick } = session(md, { sidecarRetryMs: [1] });
  s.onSidecarChanged();
  s.onSidecarChanged(); // the older chain gives way
  tick();
  tick();
  assert.equal(timers.length, 0);
  assert.equal(posted.filter((m) => m.type === 'error').length, 1);
});

test('an empty sidecar (truncated, not yet written) is read again too', () => {
  const md = setup();
  fs.writeFileSync(md + '.comments.json', '');
  const { s, posted, tick } = session(md);
  s.onSidecarChanged();
  assert.equal(posted.length, 0);
  fs.writeFileSync(md + '.comments.json', sidecar(md));
  tick();
  assert.equal(posted.filter((m) => m.type === 'comments')[0].data.comments.length, 1);
});

test('the same change reported twice (event and poll) is shown once', () => {
  const md = setup();
  fs.writeFileSync(md + '.comments.json', sidecar(md));
  const { s, posted } = session(md);
  s.onSidecarChanged();
  s.onSidecarChanged();
  assert.equal(posted.filter((m) => m.type === 'comments').length, 1);
});

test('re-reads pending when the panel closes do nothing', () => {
  const md = setup();
  fs.writeFileSync(md + '.comments.json', '{');
  const { s, posted, tick } = session(md);
  s.onSidecarChanged();
  s.dispose();
  tick();
  assert.equal(posted.length, 0);
});
