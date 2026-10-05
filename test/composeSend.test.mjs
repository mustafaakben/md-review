import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const lib = createRequire(import.meta.url)('../dist/lib.cjs');
function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdreview-compose-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const md = path.join(dir, 'doc.md'); fs.writeFileSync(md, '# Test\n\nSelected passage.\n');
  const anchor = { quote: 'Selected passage.', prefix: '', suffix: '', lineStart: 3, lineEnd: 3 };
  lib.store.mutate(md, d => lib.store.addComment(d, 'Reviewer', anchor, 'OTHER_DO_NOT_SEND'));
  const messages = [], prompts = [];
  let bound = options.disconnected ? undefined : { agent: 'codex', id: 'test-only' };
  const agents = { list: () => [], binding: () => bound, bind: b => bound = b, state: () => undefined, start: async () => null, delivery: () => options.live ? 'live' : 'onSend', setDelivery: () => {} };
  const session = new lib.ReviewSession({ mdPath: md, author: () => 'Reviewer', showResolved: () => true,
    post: m => messages.push(m), resolveImage: x => x, getText: () => fs.readFileSync(md, 'utf8'), isDirty: () => false, openLink: () => {}, agents,
    runAgent: prompt => { if (options.deliver) return options.deliver(prompt); prompts.push(prompt); return 'sent'; },
  });
  return { md, messages, prompts, session, request: { type: 'addComment', requestId: 'compose-request', send: true, anchor, body: 'ONLY_THIS_COMMENT' }, read: () => lib.store.readSidecar(md) };
}
test('composer saves and sends only its new thread; retries do not duplicate it', t => {
  const q = setup(t, { live: true });
  q.session.handle(q.request); q.session.handle(q.request);
  const comments = q.read().comments;
  assert.equal(comments.length, 2); assert.equal(comments[0].status, 'draft');
  assert.equal(comments[1].status, 'submitted'); assert.equal(comments[1].delivery.agent, 'codex');
  assert.equal(q.prompts.length, 1); assert.ok(q.prompts[0].includes('ONLY_THIS_COMMENT')); assert.ok(!q.prompts[0].includes('OTHER_DO_NOT_SEND'));
  assert.equal(q.messages.filter(m => m.type === 'commentSaved').length, 2);
});
test('save draft alone does not send', t => {
  const q = setup(t); q.session.handle({ ...q.request, send: false });
  assert.equal(q.prompts.length, 0); assert.equal(q.read().comments[1].status, 'draft');
});
test('choosing a session resumes only the saved composer thread', t => {
  const q = setup(t, { disconnected: true }); q.session.handle(q.request);
  assert.equal(q.prompts.length, 0); assert.ok(q.messages.some(m => m.type === 'agent' && m.agent.ask));
  q.session.handle({ type: 'bindSession', agent: 'codex', id: 'test-only' });
  assert.equal(q.prompts.length, 1); assert.equal(q.read().comments[0].status, 'draft');
});
test('failed saving returns a request-specific failure and never sends', t => {
  const q = setup(t); const file = q.md + '.comments.json'; fs.writeFileSync(file, '{broken');
  q.session.handle(q.request);
  assert.equal(q.prompts.length, 0); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  assert.ok(q.messages.some(m => m.type === 'commentSaveFailed' && m.requestId === q.request.requestId));
});
test('failed delivery preserves the saved thread and returns an exact retry id', t => {
  const q = setup(t, { deliver: () => { throw new Error('offline'); } }); q.session.handle(q.request);
  const comment = q.read().comments[1];
  assert.equal(comment.body, 'ONLY_THIS_COMMENT'); assert.equal(comment.delivery, undefined);
  assert.deepEqual(q.messages.find(m => m.type === 'deliveryFailed').ids, [comment.id]);
});
test('edits made while delivery is pending are not marked as delivered', async t => {
  let complete;
  const q = setup(t, { deliver: () => new Promise(resolve => { complete = resolve; }) }); q.session.handle(q.request);
  const id = q.read().comments[1].id;
  lib.store.mutate(q.md, d => lib.store.editBody(d, id, 'A NEW REQUEST'));
  complete('sent'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(q.read().comments[1].delivery, undefined);
});
