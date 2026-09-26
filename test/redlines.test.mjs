// Changes view: word diff, block matching, byte-exact Revert and Keep, and the
// baseline saved on Send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const { store } = lib;
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'redlines');
const anchor = (quote, line) => ({ quote, prefix: '', suffix: '', lineStart: line, lineEnd: line });

/** A session with an in-memory baseline hook, like the harness. */
function session(name, bytes) {
  fs.mkdirSync(tmp, { recursive: true });
  const md = path.join(tmp, name);
  fs.writeFileSync(md, bytes);
  fs.rmSync(md + '.comments.json', { force: true });
  const posted = [];
  const saved = { value: undefined, writes: 0 };
  const s = new lib.ReviewSession({
    mdPath: md, author: () => 'R', showResolved: () => true, post: (m) => posted.push(m), resolveImage: (x) => x,
    getText: () => fs.readFileSync(md, 'utf8').replace(/^\uFEFF/, ''), isDirty: () => false, openLink: () => {},
    baselines: { load: () => saved.value, save: (b) => { saved.value = b; saved.writes++; } },
  });
  s.handle({ type: 'ready' });
  const last = (type) => posted.filter((m) => m.type === type).at(-1);
  const changes = () => {
    s.handle({ type: 'showChanges', on: true });
    return last('changes').changes;
  };
  return { md, s, posted, saved, last, changes };
}

/** Comment on `quote`, send, then let the "agent" rewrite the file. */
function sendThenEdit(t, quote, line, edit) {
  t.s.handle({ type: 'addComment', anchor: anchor(quote, line), body: 'fix' });
  t.s.handle({ type: 'sendToAgent' });
  fs.writeFileSync(t.md, edit(fs.readFileSync(t.md)));
  t.s.render();
}

test('word diff: deletions before insertions, whole words, spaces folded into a replacement', () => {
  assert.deepEqual(lib.diffWords('The quick brown fox jumps.', 'The slow brown dog jumps high.'), [
    [0, 'The '], [-1, 'quick'], [1, 'slow'], [0, ' brown '], [-1, 'fox'], [1, 'dog'], [0, ' jumps'], [1, ' high'], [0, '.'],
  ]);
  assert.deepEqual(lib.diffWords('a b c', 'x y z'), [[-1, 'a b c'], [1, 'x y z']]);
  assert.deepEqual(lib.diffWords('same text', 'same text'), [[0, 'same text']]);
  assert.deepEqual(lib.diffWords("don't stop", "don't go"), [[0, "don't "], [-1, 'stop'], [1, 'go']]);
  assert.deepEqual(lib.diffWords('', 'new'), [[1, 'new']]);
  // Past the edit limit, the block is one replacement.
  assert.deepEqual(lib.diffWords('a b c d', 'e f g h', 2), [[-1, 'a b c d'], [1, 'e f g h']]);
});

const lcs = (a, b) => {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
  return t[a.length][b.length];
};

test('diffSeq finds a shortest edit script', () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  for (let k = 0; k < 200; k++) {
    const a = Array.from({ length: rnd(12) }, () => rnd(4));
    const b = Array.from({ length: rnd(12) }, () => rnd(4));
    const script = lib.diffSeq(a, b);
    const out = [];
    let i = 0, j = 0;
    for (const e of script) {
      if (e === 0) { assert.equal(a[i], b[j]); out.push(a[i]); i++; j++; }
      else if (e === -1) i++;
      else out.push(b[j++]);
    }
    assert.deepEqual(out, b);
    assert.equal(i, a.length);
    assert.equal(script.filter((e) => e === 0).length, lcs(a, b), 'keeps as much as possible');
  }
});

test('block matching: changed, inserted, deleted and moved blocks', () => {
  const base = '# T\n\nalpha one two.\n\n- a\n- b\n  - c\n- d\n\nMoved para.\n\n## Methods\n\nkeep this\n\nOLD gone\n\nlast\n';
  const cur = '# T\n\nalpha ONE two.\n\n- a\n- b\n  - c changed\n- d\n\n## Methods and data\n\nkeep this\n\nNEW para\n\nlast\n\nMoved para.\n';
  const h = lib.diffBlocks(base, cur);
  const brief = h.map((x) => `${x.kind}${x.moved ? ' moved' : ''} ${x.cur ? x.cur.type + '@' + x.cur.ls : ''}${x.base ? ' was ' + x.base.type + '@' + x.base.ls : ''}`);
  assert.deepEqual(brief, [
    'changed paragraph@2 was paragraph@2',
    'changed li@6 was li@6', // the nested item's own line, not its parent's
    'deleted moved  was paragraph@9',
    'changed heading@9 was heading@11', // paired by words in common, not position
    'deleted  was paragraph@15',
    'inserted paragraph@13',
    'inserted moved paragraph@17',
  ]);
  assert.equal(lib.changedBlocks(h), 6, 'a move counts once');
  assert.deepEqual(lib.diffBlocks(base, base), []);
  // Only changed blocks come back, and a table is one block.
  const tb = '| a | b |\n|---|---|\n| 1 | 2 |\n';
  assert.deepEqual(lib.diffBlocks(tb, tb.replace('2', '3')).map((x) => [x.kind, x.cur.type, x.c]), [['changed', 'table', [0, 3]]]);
});

for (const [name, base, last] of [
  ['CRLF with a BOM and no final line break, last change first', Buffer.from('\uFEFF# Title\r\n\r\nThe quick brown fox.\r\n\r\n- one\r\n- two\r\n\r\nGone soon.\r\n\r\nEnd.', 'utf8'), true],
  ['LF, first change first', Buffer.from('# Title\n\nThe quick brown fox.\n\n- one\n- two\n\nGone soon.\n\nEnd.\n', 'utf8'), false],
]) test(`Revert every change restores the baseline byte for byte (${name}); Undo brings one back`, () => {
  const t = session(`revert-${last}.md`, base);
  const eol = base.includes('\r\n') ? '\r\n' : '\n';
  sendThenEdit(t, 'quick', 3, (b) => Buffer.from(
    b.toString('utf8').replace('quick brown', 'slow red').replace(`- two${eol}`, `- two${eol}- three${eol}`).replace(`Gone soon.${eol}${eol}`, '').replace(/(\r?\n)?$/, `${eol}${eol}Added at the end.${eol}`),
    'utf8',
  ));
  const agent = fs.readFileSync(t.md);
  let ch = t.changes();
  assert.equal(ch.hunks.length, 4);
  assert.ok(ch.baseHtml.includes('quick brown'), 'the baseline is sent rendered, once');
  // Revert the first; Undo puts the agent's text back exactly.
  t.s.handle({ type: 'revertChange', v: ch.v, i: 0 });
  assert.ok(fs.readFileSync(t.md, 'utf8').includes('quick brown'));
  assert.equal(t.last('history').canUndo, true);
  t.s.handle({ type: 'undo' });
  assert.ok(fs.readFileSync(t.md).equals(agent));
  for (let n = 0; n < 10; n++) {
    ch = t.last('render').changes;
    if (!ch.hunks.length) break;
    t.s.handle({ type: 'revertChange', v: ch.v, i: last ? ch.hunks.length - 1 : 0 });
  }
  assert.equal(fs.readFileSync(t.md).toString('latin1'), base.toString('latin1'), 'every byte is back');
  assert.equal(t.last('render').changes.baseHtml, undefined, 'the baseline HTML is not sent again');
});

test('Revert refuses when the file changed underneath, or the hunks are stale', () => {
  const t = session('stale.md', '# T\n\nalpha beta.\n\ngamma.\n');
  sendThenEdit(t, 'alpha', 3, (b) => Buffer.from(b.toString().replace('alpha', 'ALPHA')));
  const ch = t.changes();
  fs.writeFileSync(t.md, '# T\n\nALPHA beta.\n\ngamma, edited elsewhere.\n'); // not rendered yet
  const before = fs.readFileSync(t.md);
  t.s.handle({ type: 'revertChange', v: ch.v, i: 0 });
  assert.match(t.last('error').message, /changed on disk/);
  assert.ok(fs.readFileSync(t.md).equals(before));
  // The view refreshed, so the old comparison no longer applies.
  t.s.handle({ type: 'revertChange', v: ch.v, i: 0 });
  assert.match(t.last('error').message, /nothing was written/);
  assert.ok(fs.readFileSync(t.md).equals(before));
});

test('Keep folds a change into the baseline; Accept all drops it; nothing is written next to the file', () => {
  const t = session('keep.md', '# T\n\nalpha beta.\n\ngamma.\n');
  sendThenEdit(t, 'alpha', 3, (b) => Buffer.from(b.toString().replace('alpha', 'ALPHA').replace('gamma', 'GAMMA')));
  let ch = t.changes();
  assert.equal(ch.hunks.length, 2);
  const file = fs.readFileSync(t.md);
  t.s.handle({ type: 'keepChange', v: ch.v, i: 0 });
  assert.ok(fs.readFileSync(t.md).equals(file), 'Keep never touches the file');
  ch = t.last('changes').changes;
  assert.deepEqual(ch.hunks.map((h) => h.cur.ls), [4]);
  assert.ok(ch.baseHtml.includes('ALPHA'), 'the kept text is now part of the baseline');
  t.s.handle({ type: 'acceptChanges' });
  assert.equal(t.last('changes').changes, null);
  assert.equal(t.last('baseline').info, null);
  assert.equal(t.saved.value.current, null);
  assert.equal(t.saved.value.past.length, 1);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('keep.md')).sort(), ['keep.md', 'keep.md.comments.json']);
});

test('baseline lifecycle: a new Send keeps an unreviewed baseline, replaces a reviewed one, and only a few are kept', () => {
  const t = session('life.md', '# T\n\none.\n\ntwo.\n');
  t.s.handle({ type: 'addComment', anchor: anchor('one', 3), body: 'a' });
  t.s.handle({ type: 'sendToAgent' });
  const first = t.saved.value.current;
  assert.ok(first && first.threads.length === 1);
  assert.equal(Buffer.from(first.data, 'base64').toString(), '# T\n\none.\n\ntwo.\n');
  assert.deepEqual(t.last('baseline').info, { at: first.at, threads: first.threads, changed: false });
  // The agent edits; the reviewer sends another thread before reviewing.
  fs.writeFileSync(t.md, '# T\n\nONE.\n\ntwo.\n');
  t.s.render();
  assert.equal(t.last('baseline').info.changed, true);
  t.s.handle({ type: 'addComment', anchor: anchor('two', 5), body: 'b' });
  t.s.handle({ type: 'sendToAgent' });
  const second = t.saved.value.current;
  assert.equal(second.id, first.id, 'still compares against the copy from before the first round');
  assert.equal(second.threads.length, 2);
  // Reviewed (kept) → the next Send starts from the file as it is.
  const ch = t.changes();
  t.s.handle({ type: 'keepChange', v: ch.v, i: 0 });
  assert.equal(t.last('baseline').info.changed, false);
  t.s.handle({ type: 'sendToAgent' });
  assert.notEqual(t.saved.value.current.at, undefined);
  assert.equal(Buffer.from(t.saved.value.current.data, 'base64').toString(), '# T\n\nONE.\n\ntwo.\n');
  // Accepted baselines are kept, but only a few.
  for (let n = 0; n < 5; n++) {
    t.s.handle({ type: 'acceptChanges' });
    t.s.handle({ type: 'sendToAgent' });
  }
  assert.ok(t.saved.value.current);
  assert.equal(t.saved.value.past.length, lib.KEEP_BASELINES - 1);
});

test('a finished round says how many blocks changed', () => {
  const t = session('round.md', '# T\n\nalpha.\n\nbeta.\n\ngamma.\n');
  t.s.handle({ type: 'addComment', anchor: anchor('alpha', 3), body: 'a' });
  t.s.handle({ type: 'sendToAgent' });
  fs.writeFileSync(t.md, '# T\n\nALPHA.\n\nbeta.\n\nnew.\n\ngamma.\n');
  // The agent resolves before the edit has been rendered: the count reads the disk.
  store.mutate(t.md, (d) => store.setStatus(d, d.comments[0].id, 'resolved'));
  t.s.onSidecarChanged();
  const r = t.last('round').round;
  assert.equal(r.finished, true);
  assert.equal(r.changes, 2);
});
