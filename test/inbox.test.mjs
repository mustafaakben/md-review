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
const file = (mdPath, threads) => ({ mdPath, threads });
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
  assert.equal(inbox.parseInboxSidecar('{ "comments": [ oops'), null);
  assert.equal(inbox.parseInboxSidecar(JSON.stringify({ comments: { a: 1 } })), null);
  assert.equal(inbox.parseInboxSidecar(JSON.stringify({ comments: 'abc' })), null);
  const good = inbox.parseInboxSidecar(JSON.stringify({ schemaVersion: 1, file: 'ok.md', comments: [thread('draft')] }));
  assert.equal(good.length, 1);
  for (const raw of ['', '  \n', 'null', '[1, 2]', '{ "comments": null }', '\uFEFF{}']) assert.deepEqual(inbox.parseInboxSidecar(raw), [], raw);
  const r = inbox.buildInbox([file('/w/bad.md', null), file('/w/ok.md', good)]);
  assert.deepEqual(r.groups.drafts.map((f) => f.mdPath), ['/w/ok.md']);
});

test('a hand-edited sidecar with the wrong types still groups and labels', () => {
  const raw = JSON.stringify({
    comments: [
      // Epoch times on two threads on one line: the sort compared them as text and threw.
      { ...thread('submitted', { line: 3 }), createdAt: 2 },
      { ...thread('submitted', { line: 3 }), createdAt: 1 },
      { ...thread('submitted'), body: 42, anchor: { quote: 5, lineStart: '7' } },
      { ...thread('submitted'), body: null, anchor: null, replies: { a: 1 } },
      { ...thread('submitted'), author: 7, replies: [null, { author: 'Claude', createdAt: '2026-01-02T00:00:00Z', body: ['x'] }] },
      { ...thread('draft'), status: 'weird', scope: 'everything', origin: 'robot', workingAt: 12 },
      // Keys every object has: looked up in a plain table, they gave functions, not labels.
      { ...thread('submitted', { line: 9 }), severity: 'constructor', kind: 'toString' },
      { ...thread('submitted'), severity: '__proto__', kind: 'hasOwnProperty' },
    ],
  });
  const threads = inbox.parseInboxSidecar(raw);
  assert.equal(threads.length, 8);
  for (const c of threads) {
    for (const k of ['id', 'author', 'createdAt', 'status', 'body']) assert.equal(typeof c[k], 'string', k);
    assert.equal(typeof c.anchor.quote, 'string');
    assert.equal(typeof c.anchor.lineStart, 'number');
    assert.ok(Array.isArray(c.replies));
    assert.equal(c.severity, undefined);
    assert.equal(c.kind, undefined);
    assert.equal(typeof inbox.threadLabel(c), 'string');
    assert.equal(typeof inbox.threadDescription(c), 'string');
  }
  assert.equal(threads[5].status, 'submitted');
  assert.equal(threads[5].scope, undefined);
  assert.equal(threads[4].replies[0].author, 'Claude');
  assert.equal(inbox.groupOf(threads[4]), 'needsYou');
  const r = inbox.buildInbox([file('/w/a.md', threads)]);
  assert.equal(r.counts.waiting + r.counts.needsYou, 8);
  assert.equal(inbox.threadDescription(threads[6]), 'L9 · some text');
  // Even unparsed objects with epoch times sort without throwing.
  const raw2 = [{ ...thread('draft', { line: 2 }), createdAt: 5 }, { ...thread('draft', { line: 2 }), createdAt: 4 }];
  assert.deepEqual(ids(inbox.buildInbox([file('/w/b.md', raw2)]).groups.drafts[0]), [raw2[1].id, raw2[0].id]);
});

test('the inbox keeps only what it shows of each thread', () => {
  const long = 'word '.repeat(1000);
  const replies = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, author: i % 2 ? 'Claude' : 'Reviewer', createdAt: `2026-01-02T00:00:${String(i).padStart(2, '0')}Z`, body: long }));
  replies[3].suggestion = { text: 'new words' };
  const [c] = inbox.parseInboxSidecar(JSON.stringify({ comments: [{ ...thread('submitted'), body: long, replies, prefix: long, extra: long }] }));
  assert.equal(c.replies.length, 1);
  assert.equal(c.replies[0].author, 'Claude');
  assert.ok(c.body.length <= 300 && c.replies[0].body.length <= 200);
  assert.equal(c.extra, undefined);
  assert.equal(c.suggested, true);
  assert.equal(inbox.groupOf(c), 'needsYou');
  const applied = { ...thread('submitted'), suggestion: { text: 'x', appliedAt: '2026-01-03T00:00:00Z' } };
  assert.equal(inbox.parseInboxSidecar(JSON.stringify({ comments: [applied] }))[0].suggested, undefined);
});

test('a thread without an id is left out: there is nothing stable to jump to', () => {
  const noId = { ...thread('submitted') };
  delete noId.id;
  const threads = inbox.parseInboxSidecar(JSON.stringify({ comments: [noId, { ...thread('submitted'), id: 7 }, thread('submitted', { body: 'kept' })] }));
  assert.deepEqual(threads.map((c) => c.body), ['kept']);
});

test('files.exclude globs, as the workspace search reads them', () => {
  const ex = (rel, ...globs) => inbox.excludedBy(rel, globs);
  assert.ok(ex('dist/a.md.comments.json', '**/dist'));
  assert.ok(ex('x/y/dist/a.md.comments.json', '**/dist'));
  assert.ok(ex('out/a.md.comments.json', 'out/'));
  assert.ok(ex('drafts/a.md.comments.json', '{drafts,tmp}'));
  assert.ok(ex('tmp2/a.md.comments.json', 'tmp[0-9]'));
  assert.ok(ex('a.md.comments.json', '**/*.comments.json'));
  assert.ok(!ex('distx/a.md.comments.json', '**/dist'));
  assert.ok(!ex('src/a.md.comments.json', '**/dist', '{unbalanced'));
  assert.ok(!ex('a.md.comments.json'));
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
