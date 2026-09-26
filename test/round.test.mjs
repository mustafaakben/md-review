// Live agent status: the CLI marks the thread it's on, and the session tracks
// a round of sent threads until the agent has answered them all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const { store } = lib;
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'round');
const cli = path.join(here, '..', 'cli', 'mdreview.mjs');
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const anchor = (quote, line) => ({ quote, prefix: '', suffix: '', lineStart: line, lineEnd: line });

function setup(name) {
  fs.mkdirSync(tmp, { recursive: true });
  const md = path.join(tmp, name);
  fs.writeFileSync(md, '# T\n\nalpha one\n\nbeta two\n\ngamma three\n');
  try { fs.unlinkSync(md + '.comments.json'); } catch {}
  let ids;
  store.mutate(md, (data) => {
    ids = ['alpha', 'beta', 'gamma'].map((w, i) => store.addComment(data, 'R', anchor(w, 3 + 2 * i), 'about ' + w).id);
    store.submitDrafts(data);
  });
  return { md, ids };
}
const get = (md, id) => store.readSidecar(md).comments.find((c) => c.id === id);

test('next and context mark the thread the agent is on; reply and resolve clear it', () => {
  const { md, ids } = setup('claim.md');
  run('next', md);
  const first = get(md, ids[0]);
  assert.equal(first.workingBy, 'Claude');
  assert.ok(Date.now() - Date.parse(first.workingAt) < 60_000);
  // Moving to another thread clears the agent's earlier mark.
  run('context', md, ids[1]);
  assert.equal(get(md, ids[0]).workingAt, undefined);
  assert.equal(get(md, ids[1]).workingBy, 'Claude');
  run('reply', md, ids[1], 'Which one?');
  assert.equal(get(md, ids[1]).workingAt, undefined);
  run('context', md, ids[2]);
  run('resolve', md, ids[2], 'Done.');
  assert.equal(get(md, ids[2]).workingAt, undefined);
  // A resolved thread isn't claimed by reading it.
  run('context', md, ids[2]);
  assert.equal(get(md, ids[2]).workingAt, undefined);
});

test('a round reports progress and one summary when the agent is done', () => {
  const { md, ids } = setup('progress.md');
  const posted = [];
  const notes = [];
  const s = new lib.ReviewSession({
    mdPath: md, author: () => 'R', showResolved: () => true, post: (m) => posted.push(m), resolveImage: (x) => x,
    getText: () => fs.readFileSync(md, 'utf8'), isDirty: () => false, openLink: () => {},
    runAgent: () => 'sent', notify: (m) => notes.push(m),
  });
  s.handle({ type: 'ready' });
  s.handle({ type: 'sendToAgent' });
  const rounds = () => posted.filter((m) => m.type === 'round').map((m) => m.round);
  assert.deepEqual(rounds().at(-1), { total: 3, done: 0, resolved: 0, questions: 0, finished: false });

  run('resolve', md, ids[0], 'Fixed.');
  s.onSidecarChanged();
  assert.deepEqual(rounds().at(-1), { total: 3, done: 1, resolved: 1, questions: 0, finished: false });
  run('reply', md, ids[1], 'Did you mean the first or second?');
  run('resolve', md, ids[2]);
  s.onSidecarChanged();
  assert.deepEqual(rounds().at(-1), { total: 3, done: 3, resolved: 2, questions: 1, finished: true });
  assert.deepEqual(notes, ['Claude finished progress.md: 2 resolved, 1 question for you.']);
  // Later changes don't announce the same round again.
  s.onSidecarChanged();
  s.sendComments();
  assert.equal(notes.length, 1);
  s.handle({ type: 'dismissRound' });
  assert.equal(rounds().at(-1), null);
});
