// Comment sidecar round-trip: viewer ops (via ReviewSession, same code as the
// extension) interleaved with agent ops (via the CLI), no clobbering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'store');
const cli = path.join(here, '..', 'cli', 'mdreview.mjs');

function session(md) {
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
  });
  return { s, posted, last: (type) => posted.filter((m) => m.type === type).at(-1) };
}

test('add → submit → agent reply → resolve round-trip', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const md = path.join(tmp, 'doc.md');
  fs.writeFileSync(md, '# Title\n\nSome paragraph with a claim.\n');
  const { s, last } = session(md);
  s.handle({ type: 'ready' });
  assert.equal(last('comments').data.comments.length, 0);

  const anchor = { quote: 'a claim', prefix: 'Some paragraph with ', suffix: '.', lineStart: 3, lineEnd: 3 };
  s.handle({ type: 'addComment', anchor, body: 'Cite this.' });
  s.handle({ type: 'addComment', anchor: { ...anchor, quote: 'Title', prefix: '', suffix: '' }, body: 'Rename?' });
  let d = JSON.parse(fs.readFileSync(md + '.comments.json', 'utf8'));
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.file, 'doc.md');
  assert.deepEqual(d.comments.map((c) => c.status), ['draft', 'draft']);

  s.handle({ type: 'submitReview' });
  d = JSON.parse(fs.readFileSync(md + '.comments.json', 'utf8'));
  assert.deepEqual(d.comments.map((c) => c.status), ['submitted', 'submitted']);
  assert.equal(d.comments[0].submittedAt, d.comments[1].submittedAt, 'one batch timestamp');

  // Agent side (CLI) replies and resolves.
  const [c1, c2] = d.comments;
  const listed = execFileSync(process.execPath, [cli, 'list', md, '--status', 'submitted', '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(listed).length, 2);
  execFileSync(process.execPath, [cli, 'reply', md, c1.id, 'Added Smith (2020).']);
  execFileSync(process.execPath, [cli, 'resolve', md, c1.id]);

  // Viewer picks up the external change (watcher path) and keeps both.
  s.onSidecarChanged();
  const seen = last('comments').data.comments;
  assert.equal(seen.find((c) => c.id === c1.id).status, 'resolved');
  assert.equal(seen.find((c) => c.id === c1.id).replies[0].author, 'Claude');

  // Viewer reply after the agent's write must not drop the agent's reply.
  s.handle({ type: 'reply', id: c2.id, body: 'Keep it.' });
  d = JSON.parse(fs.readFileSync(md + '.comments.json', 'utf8'));
  assert.equal(d.comments.find((c) => c.id === c1.id).replies.length, 1);
  assert.equal(d.comments.find((c) => c.id === c2.id).replies[0].author, 'Reviewer');
});

test('own writes are ignored by the watcher; external ones are not', () => {
  const md = path.join(tmp, 'doc.md');
  const { s, posted } = session(md);
  s.handle({ type: 'setStatus', id: JSON.parse(fs.readFileSync(md + '.comments.json', 'utf8')).comments[1].id, status: 'resolved' });
  const n = posted.length;
  s.onSidecarChanged(); // triggered by our own write
  assert.equal(posted.length, n);
  fs.writeFileSync(md + '.comments.json', fs.readFileSync(md + '.comments.json', 'utf8').replace('Keep it.', 'Keep it!'));
  s.onSidecarChanged();
  assert.equal(posted.length, n + 1);
});

test('block edit through the session rejects when the file changed since render', () => {
  const md = path.join(tmp, 'doc.md');
  const { s, last } = session(md);
  s.handle({ type: 'ready' });
  fs.appendFileSync(md, '\nAdded by Claude.\n');
  s.handle({ type: 'saveBlock', ls: 2, le: 3, original: 'Some paragraph with a claim.', newText: 'Changed.' });
  assert.match(last('error').message, /changed on disk/);
  assert.match(fs.readFileSync(md, 'utf8'), /Some paragraph with a claim\./);
  // After re-render the same edit goes through.
  s.handle({ type: 'saveBlock', ls: 2, le: 3, original: 'Some paragraph with a claim.', newText: 'Changed.' });
  assert.equal(fs.readFileSync(md, 'utf8'), '# Title\n\nChanged.\n\nAdded by Claude.\n');
});

test('rendered HTML carries source line ranges and resolves pandoc image widths', () => {
  const text = fs.readFileSync(path.join(here, 'fixtures', 'sample-crlf.md'), 'utf8');
  const html = lib.renderMarkdown(text, (s) => 'RES:' + s);
  assert.match(html, /<h1 data-ls="0" data-le="1">Abstract<\/h1>/);
  assert.match(html, /<img src="RES:media\/sample\/figure-1.png"[^>]*style="width:6.5in"/);
  assert.doesNotMatch(html, /\{width=/);
  assert.match(html, /<th style="text-align:left"/);
  assert.match(html, /<tr data-ls="32" data-le="33">/);
});

test('fields this version does not know survive viewer writes', () => {
  fs.mkdirSync(tmp, { recursive: true });
  const md = path.join(tmp, 'extra.md');
  fs.writeFileSync(md, '# T\n\nA claim here.\n');
  const side = md + '.comments.json';
  fs.writeFileSync(
    side,
    JSON.stringify({
      schemaVersion: 1,
      file: 'extra.md',
      tool: { name: 'future' },
      comments: [
        {
          id: 'c_1',
          author: 'Reviewer',
          createdAt: '2026-09-26T10:00:00.000Z',
          anchor: { quote: 'A claim', prefix: '', suffix: ' here.', lineStart: 3, lineEnd: 3, blockId: 'p3' },
          body: 'Cite this.',
          status: 'submitted',
          submittedAt: '2026-09-26T10:00:00.000Z',
          resolvedAt: null,
          severity: 'major',
          suggestion: { kind: 'replace', text: 'A cited claim' },
          replies: [{ id: 'r_1', author: 'Claude', createdAt: '2026-09-26T10:01:00.000Z', body: 'Done.', change: { lines: [3, 3] } }],
        },
      ],
    }),
  );
  const { s } = session(md);
  s.handle({ type: 'ready' });
  s.handle({ type: 'reply', id: 'c_1', body: 'Thanks' });
  s.handle({ type: 'setStatus', id: 'c_1', status: 'resolved' });
  const d = JSON.parse(fs.readFileSync(side, 'utf8'));
  assert.deepEqual(d.tool, { name: 'future' });
  const c = d.comments[0];
  assert.equal(c.severity, 'major');
  assert.deepEqual(c.suggestion, { kind: 'replace', text: 'A cited claim' });
  assert.equal(c.anchor.blockId, 'p3');
  assert.deepEqual(c.replies[0].change, { lines: [3, 3] });
  assert.equal(c.replies.length, 2);
  assert.equal(c.status, 'resolved');
  assert.ok(!('reopenedAt' in c));
});
