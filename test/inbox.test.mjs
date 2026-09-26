// Review inbox grouping (src/inbox.ts): whose turn each thread is, and order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inbox } = require('../dist/lib.cjs');

let n = 0;
function thread(status, { line = 1, replies = [], reopenedAt, scope, body = 'Fix this', quote = 'some text', createdAt } = {}) {
  n++;
  return {
    id: `c${n}`,
    author: 'Reviewer',
    createdAt: createdAt ?? `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`,
    anchor: { quote, prefix: '', suffix: '', lineStart: line, lineEnd: line },
    body,
    status,
    submittedAt: status === 'draft' ? null : '2026-01-01T00:01:00Z',
    resolvedAt: status === 'resolved' ? '2026-01-01T00:05:00Z' : null,
    ...(reopenedAt ? { reopenedAt } : {}),
    ...(scope ? { scope } : {}),
    replies: replies.map(([author, createdAt], i) => ({ id: `r${n}_${i}`, author, createdAt, body: 'ok' })),
  };
}
const file = (mdPath, comments) => ({ mdPath, data: { schemaVersion: 1, file: mdPath, comments } });
const ids = (f) => f.threads.map((c) => c.id);

test('needs you vs waiting on Claude, including a reopened thread', () => {
  const fresh = thread('submitted');
  const answered = thread('submitted', { replies: [['Claude', '2026-01-02T00:00:00Z']] });
  const reviewerLast = thread('submitted', { replies: [['Claude', '2026-01-02T00:00:00Z'], ['Reviewer', '2026-01-03T00:00:00Z']] });
  const reopened = thread('submitted', { replies: [['Claude', '2026-01-02T00:00:00Z']], reopenedAt: '2026-01-04T00:00:00Z' });
  const reopenedThenAnswered = thread('submitted', { replies: [['Claude', '2026-01-05T00:00:00Z']], reopenedAt: '2026-01-04T00:00:00Z' });
  assert.equal(inbox.groupOf(fresh), 'waiting');
  assert.equal(inbox.groupOf(answered), 'needsYou');
  assert.equal(inbox.groupOf(reviewerLast), 'waiting');
  assert.equal(inbox.groupOf(reopened), 'waiting');
  assert.equal(inbox.groupOf(reopenedThenAnswered), 'needsYou');
  assert.equal(inbox.groupOf(answered, 'Codex'), 'waiting');
});

test('drafts and resolved get their own groups, with counts', () => {
  const r = inbox.buildInbox([
    file('/w/a.md', [thread('draft'), thread('resolved'), thread('resolved', { replies: [['Claude', '2026-01-02T00:00:00Z']] })]),
    file('/w/b.md', [thread('submitted', { replies: [['Claude', '2026-01-02T00:00:00Z']] }), thread('submitted')]),
  ]);
  assert.deepEqual(r.counts, { needsYou: 1, waiting: 1, drafts: 1, resolved: 2 });
  assert.deepEqual(r.groups.resolved.map((f) => f.mdPath), ['/w/a.md']);
  assert.deepEqual(r.groups.needsYou.map((f) => f.mdPath), ['/w/b.md']);
  assert.deepEqual(r.groups.drafts.map((f) => f.threads.length), [1]);
});

test('files sort by path and threads by line, whole-document threads first', () => {
  const late = thread('draft', { line: 40 });
  const early = thread('draft', { line: 3 });
  const doc = thread('draft', { line: 0, scope: 'document', quote: '' });
  const sameLineA = thread('draft', { line: 3, createdAt: '2026-01-01T00:00:00Z' });
  const r = inbox.buildInbox([file('/w/z.md', [thread('draft')]), file('/w/docs/m.md', [late, early, doc, sameLineA])]);
  assert.deepEqual(r.groups.drafts.map((f) => f.mdPath), ['/w/docs/m.md', '/w/z.md']);
  assert.deepEqual(ids(r.groups.drafts[0]), [doc.id, sameLineA.id, early.id, late.id]);
});

test('a malformed sidecar is skipped, not thrown', () => {
  assert.equal(inbox.parseInboxSidecar('{ "comments": [ oops', '/w/bad.md'), null);
  const good = inbox.parseInboxSidecar(JSON.stringify({ schemaVersion: 1, file: 'ok.md', comments: [thread('draft')] }), '/w/ok.md');
  assert.equal(good.comments.length, 1);
  assert.deepEqual(inbox.parseInboxSidecar('', '/w/empty.md').comments, []);
  const r = inbox.buildInbox([{ mdPath: '/w/bad.md', data: null }, { mdPath: '/w/ok.md', data: good }]);
  assert.deepEqual(r.groups.drafts.map((f) => f.mdPath), ['/w/ok.md']);
});

test('labels: first line of the body, line and quote excerpt', () => {
  const c = thread('submitted', { line: 12, body: '\n  Tighten this claim.\nIt overreaches.', quote: 'a  very\nlong quote '.repeat(10) });
  assert.equal(inbox.threadLabel(c), 'Tighten this claim.');
  const d = inbox.threadDescription(c);
  assert.match(d, /^L12 · a very long quote/);
  assert.ok(d.length <= 'L12 · '.length + 60);
  assert.equal(inbox.threadLabel(thread('draft', { body: '   ' })), '(no text)');
  assert.equal(inbox.threadDescription(thread('draft', { scope: 'document', quote: '' })), 'Whole document');
});
