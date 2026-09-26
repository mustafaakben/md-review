// Review inbox grouping (src/inbox.ts): whose turn each thread is, and order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inbox } = require('../dist/lib.cjs');

let n = 0;
function thread(status, { line = 1, replies = [], reopenedAt, scope, body = 'Fix this', quote = 'some text', createdAt, origin, workingAt, severity, kind } = {}) {
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
    ...(origin ? { origin, author: 'Claude', reviewRun: 'run1' } : {}),
    ...(workingAt ? { workingAt, workingBy: 'Claude' } : {}),
    ...(severity ? { severity } : {}),
    ...(kind ? { kind } : {}),
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
  assert.deepEqual(r.counts, { needsYou: 1, triage: 0, waiting: 1, drafts: 1, resolved: 2 });
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

test("Claude's untriaged drafts are their own group, not the reviewer's drafts", () => {
  const mine = thread('draft');
  const fromClaude = thread('draft', { origin: 'agent' });
  const kept = { ...thread('draft'), suggestedBy: 'Claude' }; // Keep: origin dropped, now the reviewer's
  const queued = { ...thread('submitted'), suggestedBy: 'Claude' }; // Do it: submitted for Claude
  assert.equal(inbox.groupOf(fromClaude), 'triage');
  assert.equal(inbox.groupOf(mine), 'drafts');
  assert.equal(inbox.groupOf(kept), 'drafts');
  assert.equal(inbox.groupOf(queued), 'waiting');
  const r = inbox.buildInbox([file('/w/a.md', [mine, fromClaude, thread('draft', { origin: 'agent', line: 9 })])]);
  assert.deepEqual(r.counts, { needsYou: 0, triage: 2, waiting: 0, drafts: 1, resolved: 0 });
  assert.deepEqual(ids(r.groups.drafts[0]), [mine.id]);
  assert.equal(inbox.GROUPS.find((g) => g.id === 'triage').label, 'From Claude, to triage');
  assert.deepEqual(inbox.GROUPS.map((g) => g.id), ['needsYou', 'triage', 'waiting', 'drafts', 'resolved']);
});

test('a thread Claude is working on is its turn until the claim goes stale', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  // Claude answered, the reviewer's turn, but Claude has picked it up again (the CLI's next).
  const answered = [['Claude', '2026-01-02T00:00:00Z']];
  const working = thread('submitted', { replies: answered, workingAt: ago(60_000) });
  const stale = thread('submitted', { replies: answered, workingAt: ago(6 * 60_000) });
  const resolved = thread('resolved', { workingAt: ago(1000) });
  assert.equal(inbox.groupOf(working, 'Claude', now), 'waiting');
  assert.equal(inbox.groupOf(stale, 'Claude', now), 'needsYou');
  assert.equal(inbox.groupOf(resolved, 'Claude', now), 'resolved');
  const r = inbox.buildInbox([file('/w/a.md', [working, stale]), file('/w/b.md', [thread('submitted')])], 'Claude', now);
  assert.deepEqual(r.counts, { needsYou: 1, triage: 0, waiting: 2, drafts: 0, resolved: 0 });
  // The view regroups when the claim runs out: 4 minutes from now.
  assert.equal(r.expires, 4 * 60_000);
  assert.equal(inbox.buildInbox([file('/w/b.md', [stale])], 'Claude', now).expires, null);
});

test('a reopened thread goes back to Claude, whatever its history', () => {
  const r = inbox.buildInbox([
    file('/w/a.md', [
      thread('submitted', { replies: [['Claude', '2026-01-02T00:00:00Z'], ['Reviewer', '2026-01-02T01:00:00Z'], ['Claude', '2026-01-03T00:00:00Z']], reopenedAt: '2026-01-04T00:00:00Z' }),
      thread('submitted', { replies: [['Claude', '2026-01-02T00:00:00Z']], reopenedAt: '2026-01-01T12:00:00Z' }),
    ]),
  ]);
  assert.equal(r.groups.waiting[0].threads.length, 1);
  assert.equal(r.groups.needsYou[0].threads.length, 1);
});

test('the description leads with severity', () => {
  assert.equal(inbox.threadDescription(thread('submitted', { line: 4, quote: 'x', severity: 'major' })), 'Major · L4 · x');
  assert.equal(inbox.threadDescription(thread('submitted', { scope: 'document', quote: '', severity: 'nit' })), 'Nit · Whole document');
});
