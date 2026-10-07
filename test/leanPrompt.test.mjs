// Lean prompts: the instructions go to a session once, a thread it has seen
// carries only what's new, and the reviewer's exact selection is tagged apart
// from the source lines around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const lib = createRequire(import.meta.url)('../dist/lib.cjs');

const LINE = 'Leadership scholarship offers well-developed accounts of how leaders grow through demanding experience (DeRue et al., 2012), and how they establish standards (Brown et al., 2005). **AI** unsettles these accounts.';
const SELECTED = 'Leadership scholarship offers well-developed accounts of how leaders grow through demanding experience (DeRue et al., 2012)';
const SRC = `# T\n\n${LINE}\n`;
const thread = (replies = []) => ({ id: 'c_1', author: 'Moose', anchor: { quote: SELECTED, prefix: '', suffix: '', lineStart: 3, lineEnd: 3 }, body: 'Propose two alternative rewrites of this part.', status: 'submitted', replies });
const opts = (o) => ({ mdPath: '/w/m.md', cwd: '/w', cliPath: '/x/mdreview.mjs', source: SRC, agentName: 'Claude', ...o });

test('first send: full instructions, the whole selection tagged apart from its source lines', () => {
  const p = lib.buildAgentPrompt(opts({ comments: [thread()] }));
  assert.match(p, /^<md_review file="m\.md" path="\/w\/m\.md" cwd="\/w" threads="1">$/m);
  assert.match(p, /<instructions>\nHandle every thread below with ONE command/);
  assert.match(p, /Change only it unless the <request> asks for more/);
  assert.ok(p.includes(`<user_selected_text>${SELECTED}</user_selected_text>`), 'not cut at 90 characters');
  assert.doesNotMatch(p, /seen="true"|^\[r_/m, 'nothing is shortened on a first send');
  assert.ok(p.includes(`<context lines="3">\n    3 | ${LINE}\n</context>`));
  assert.match(p, /<request author="Moose">Propose two alternative rewrites of this part\.<\/request>/);
  assert.match(p, /<\/md_review>$/);
});

test('follow-up: earlier messages shrink to id and opening words, only the new one goes whole', () => {
  const replies = [
    { id: 'r_a', author: 'Claude', body: '**Option A** (more conversational): Leadership research has mapped how leaders grow', createdAt: '1' },
    { id: 'r_b', author: 'Claude', body: '**Option B** (tighter, keeps three-part structure): Leadership scholarship offers', createdAt: '2' },
    { id: 'r_c', author: 'Moose', parentId: 'r_b', body: 'Make Option B shorter and keep the citation.', createdAt: '3' },
  ];
  const c = thread(replies);
  // The session saw the comment, wrote r_a and r_b itself; r_c is new.
  const known = { c_1: { seen: ['c_1'], lines: lib.linesHash(lib.quoteLines(SRC, c)) } };
  const p = lib.buildAgentPrompt(opts({ comments: [c], primed: true, known }));
  assert.match(p, /^Same MD Review instructions as before\. One command, run in \/w: node "\/x\/mdreview\.mjs" apply "m\.md" then fix/m);
  assert.match(p, /reply-to <thread-id> <message-id> "<text>"/);
  assert.doesNotMatch(p, /Later sends shrink/, 'the long instructions are not repeated');
  assert.match(p, /<thread id="c_1" follow_up="true">/);
  assert.match(p, /<request author="Moose">Propose two alternative rewrites of this part\.<\/request>/, 'the request always goes whole');
  assert.match(p, /^\[r_a\] Claude: \*\*Option A\*\* \(more conversational\): Leadership research has mapped …$/m);
  assert.match(p, /^\[r_b\] Claude: \*\*Option B\*\* \(tighter, keeps three-part structure\): Leadership scholarship …$/m);
  assert.match(p, /<message id="r_c" reply_to="r_b" author="Moose" new="true">Make Option B shorter and keep the citation\.<\/message>/);
  assert.match(p, /<context lines="3" unchanged="true"\/>/);
  assert.ok(!p.includes(LINE), 'the unchanged source line is not resent');
  assert.ok(p.includes(`<user_selected_text>${SELECTED}</user_selected_text>`), 'the selection is the scope: always whole');
  assert.ok(p.length < lib.buildAgentPrompt(opts({ comments: [c] })).length, 'smaller than the full prompt');
});

test('follow-up resends the source lines when they changed, and a thread with nothing new goes whole', () => {
  const c = thread([{ id: 'r_a', author: 'Claude', body: 'Done.', createdAt: '1' }, { id: 'r_b', author: 'Moose', body: 'Again please.', createdAt: '2' }]);
  const stale = { c_1: { seen: ['c_1'], lines: '00000000' } };
  const p = lib.buildAgentPrompt(opts({ comments: [c], primed: true, known: stale }));
  assert.match(p, /follow_up="true"/);
  assert.ok(p.includes(`<context lines="3">\n    3 | ${LINE}\n</context>`));
  assert.ok(p.includes(`<user_selected_text>${SELECTED}</user_selected_text>`));
  // Everything already seen: a resend, so the thread goes in full.
  const all = { c_1: { seen: ['c_1', 'r_a', 'r_b'], lines: lib.linesHash(lib.quoteLines(SRC, c)) } };
  const again = lib.buildAgentPrompt(opts({ comments: [c], primed: true, known: all }));
  assert.doesNotMatch(again, /follow_up="true"/);
  assert.match(again, /<message id="r_b" author="Moose">Again please\.<\/message>/);
});

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdreview-lean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const md = path.join(dir, 'm.md');
  fs.writeFileSync(md, SRC);
  const prompts = [], messages = [];
  let bound = { agent: 'claude', id: 's1' };
  const agents = { list: () => [], binding: () => bound, bind: b => (bound = b), state: () => undefined, start: async () => null, delivery: () => 'onSend', setDelivery: () => {} };
  const session = new lib.ReviewSession({ mdPath: md, author: () => 'Moose', showResolved: () => true, post: m => messages.push(m), resolveImage: x => x,
    getText: () => fs.readFileSync(md, 'utf8'), isDirty: () => false, openLink: () => {}, agents, cliPath: '/ext/cli/mdreview.mjs',
    runAgent: p => (prompts.push(p), 'sent') });
  session.handle({ type: 'addComment', anchor: thread().anchor, body: 'Propose two rewrites.' });
  const id = () => lib.store.readSidecar(md).comments[0].id;
  const claude = (body) => lib.store.mutate(md, d => d.comments[0].replies.push({ id: `r_${Math.random().toString(36).slice(2, 8)}`, author: 'Claude', createdAt: lib.store.now(), body }));
  return { md, prompts, messages, session, id, claude, rebind: b => (bound = b) };
}

test('a session gets the instructions once, then only what is new; another session or the clipboard gets everything', t => {
  const q = setup(t);
  q.session.handle({ type: 'sendToAgent', id: q.id() });
  assert.match(q.prompts[0], /Handle every thread below/);
  const d1 = lib.store.readSidecar(q.md).comments[0].delivery;
  assert.equal(d1.session, 's1');
  assert.deepEqual(d1.seen, [q.id()]);
  assert.match(d1.lines, /^[0-9a-f]{8}$/);

  q.claude('Option A: a long rewrite of the passage that the reviewer already read once.');
  const optionA = lib.store.readSidecar(q.md).comments[0].replies[0].id;
  q.session.handle({ type: 'reply', id: q.id(), parentId: optionA, body: 'Shorter, please.' });
  q.session.handle({ type: 'sendToAgent', id: q.id() });
  const p2 = q.prompts[1];
  assert.match(p2, /Same MD Review instructions as before/);
  assert.doesNotMatch(p2, /Handle every thread below/);
  assert.match(p2, /follow_up="true"/);
  assert.match(p2, /\] Claude: Option A: a long rewrite of the passage …$/m);
  assert.match(p2, new RegExp(`<message id="r_[^"]+" reply_to="${optionA}" author="Moose" new="true">Shorter, please\\.</message>`));
  assert.match(p2, /<context lines="3" unchanged="true"\/>/);
  assert.match(p2, /<request author="Moose">Propose two rewrites\.<\/request>/);
  assert.ok(p2.length < q.prompts[0].length, `follow-up ${p2.length} < first ${q.prompts[0].length}`);

  // The source line changed since: the lines go again.
  fs.writeFileSync(q.md, SRC.replace('demanding experience', 'hard experience'));
  q.claude('Option B.');
  q.session.handle({ type: 'reply', id: q.id(), body: 'One more.' });
  q.session.handle({ type: 'sendToAgent', id: q.id() });
  assert.match(q.prompts[2], /<context lines="3">\n {4}3 \| .*hard experience/);

  // A different session hasn't seen any of it.
  q.rebind({ agent: 'claude', id: 's2' });
  q.session.handle({ type: 'sendToAgent', id: q.id() });
  assert.match(q.prompts[3], /Handle every thread below/);
  assert.doesNotMatch(q.prompts[3], /follow_up="true"|seen="true"|^\[r_/m);

  // The clipboard copy is always complete.
  q.session.handle({ type: 'copyPrompt' });
  const copied = q.messages.filter(m => m.type === 'agentPrompt').at(-1).prompt;
  assert.match(copied, /Handle every thread below/);
  assert.doesNotMatch(copied, /follow_up="true"/);
});

test('Send all: the folder prompt passes the session to next, and a primed session gets a reminder', () => {
  const o = { folder: '/w', cwd: '/w', files: [{ mdPath: '/w/a.md', open: 2 }], cliPath: '/x/mdreview.mjs', session: 's1' };
  const full = lib.buildFolderPrompt(o);
  assert.match(full, /^<md_review folder="\." cwd="\/w" threads="2">\n<files>\na\.md \(2 open\)\n<\/files>\n<instructions>$/m);
  assert.match(full, /`node "\/x\/mdreview\.mjs" next "\." --session s1`/);
  assert.match(full, /<user_selected_text> is exactly what the reviewer highlighted/);
  assert.match(full, /fix <file\.md> <id> "<old>" "<new>" "<note>"/);
  const short = lib.buildFolderPrompt({ ...o, primed: true });
  assert.match(short, /^Same MD Review instructions as before\. In \/w, run `node "\/x\/mdreview\.mjs" next "\." --session s1`/m);
  assert.ok(short.length < full.length / 2, `${short.length} vs ${full.length}`);
  assert.doesNotMatch(lib.buildFolderPrompt({ ...o, session: undefined }), /--session/);
  assert.match(lib.buildFolderPrompt({ ...o, suggest: true }), /suggest <file\.md> <id> "<replacement for the whole selection>"/);
});

test('next --session: a thread the session was shown comes back with only what is new', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdreview-next-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'm.md'), SRC);
  const c = { ...thread([{ id: 'r_a', author: 'Claude', body: 'Option A: one long rewrite of the whole passage for the reviewer.', createdAt: '1' }]), createdAt: '0', submittedAt: '0', resolvedAt: null };
  c.replies.push({ id: 'r_b', author: 'Moose', parentId: 'r_a', body: 'Shorter, please.', createdAt: '2' });
  fs.writeFileSync(path.join(dir, 'm.md.comments.json'), JSON.stringify({ schemaVersion: 1, file: 'm.md', comments: [c] }));
  const cli = path.resolve('cli/mdreview.mjs');
  const next = (...a) => execFileSync(process.execPath, [cli, 'next', '.', ...a], { cwd: dir, encoding: 'utf8' });
  const first = next('--session', 's1');
  assert.doesNotMatch(first, /follow_up="true"/);
  assert.ok(first.includes(`<user_selected_text>${SELECTED}</user_selected_text>`));
  assert.match(first, /<message id="r_a" author="Claude">Option A: one long rewrite of the whole passage for the reviewer\.<\/message>/);
  assert.match(first, /^> 3 \| Leadership/m);
  assert.deepEqual(lib.store.readSidecar(path.join(dir, 'm.md')).comments[0].delivery.seen, ['c_1', 'r_a', 'r_b']);
  // The reviewer answers again; the same session sees only that in full.
  lib.store.mutate(path.join(dir, 'm.md'), d => d.comments[0].replies.push({ id: 'r_c', author: 'Moose', body: 'And keep the citation.', createdAt: '3' }));
  const again = next('--session', 's1');
  assert.match(again, /follow_up="true"/);
  assert.match(again, /^\[r_a\] Claude: Option A: one long rewrite of the whole …$/m);
  assert.match(again, /^\[r_b reply to r_a\] Moose: Shorter, please\.$/m);
  assert.match(again, /<message id="r_c" author="Moose" new="true">And keep the citation\.<\/message>/);
  assert.ok(again.includes(`<user_selected_text>${SELECTED}</user_selected_text>`), 'the selection always goes whole');
  // Another session, and `context`, get the thread whole.
  lib.store.mutate(path.join(dir, 'm.md'), d => d.comments[0].replies.push({ id: 'r_d', author: 'Moose', body: 'One more.', createdAt: '4' }));
  assert.doesNotMatch(next('--session', 's2'), /follow_up="true"/);
  assert.doesNotMatch(execFileSync(process.execPath, [cli, 'context', 'm.md', 'c_1'], { cwd: dir, encoding: 'utf8' }), /follow_up="true"|^\[r_/m);
});
