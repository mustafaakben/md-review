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
  const mem = lib.memoryBaselines();
  const saved = {
    writes: 0,
    get meta() { return mem.get(); },
    get text() { return mem.read()?.toString('utf8'); },
  };
  const resolveImage = (x) => x;
  const s = new lib.ReviewSession({
    mdPath: md, author: () => 'R', showResolved: () => true, post: (m) => posted.push(m), resolveImage,
    getText: () => fs.readFileSync(md, 'utf8').replace(/^\uFEFF/, ''), isDirty: () => false, openLink: () => {},
    baselines: { get: () => mem.get(), read: () => mem.read(), set: (b, bytes) => { saved.writes++; mem.set(b, bytes); } },
  });
  s.handle({ type: 'ready' });
  const last = (type) => posted.filter((m) => m.type === type).at(-1);
  const changes = () => {
    s.handle({ type: 'showChanges', on: true });
    return last('changes').changes;
  };
  /** The latest hunks the view got, with a render or on their own. */
  const shown = () => posted.filter((m) => m.type === 'changes' || (m.type === 'render' && m.changes !== undefined)).at(-1).changes;
  return { md, s, posted, saved, last, changes, shown, resolveImage };
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
  assert.ok(t.saved.text.includes('ALPHA'), 'the kept text is now part of the baseline');
  // The view renumbers the baseline it has instead of being sent it again.
  assert.equal(ch.baseHtml, undefined);
  assert.deepEqual(ch.baseShift.steps, [{ lo: 2, at: 3, delta: 0 }]);
  t.s.handle({ type: 'acceptChanges' });
  assert.equal(t.last('changes').changes, null);
  assert.equal(t.last('baseline').info, null);
  assert.equal(t.saved.meta, undefined);
  assert.equal(t.saved.text, undefined, 'the copy is gone too');
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith('keep.md')).sort(), ['keep.md', 'keep.md.comments.json']);
});

test("your own edits in the view after a Send aren't Claude's changes, and Undo takes them back out", () => {
  const t = session('yours.md', '# T\n\nalpha.\n\nbeta.\n\ngamma.\n');
  sendThenEdit(t, 'alpha', 3, (b) => Buffer.from(b.toString().replace('alpha', 'ALPHA')));
  const ch = t.changes();
  assert.equal(ch.hunks.length, 1);
  // Edits outside Claude's change: a changed paragraph and a new one.
  t.s.handle({ type: 'saveBlock', ls: 6, le: 7, original: 'gamma.\n', newText: 'GAMMA.\n\ndelta.\n' });
  let now = t.shown();
  assert.deepEqual(now.hunks.map((h) => h.cur.ls), [2], 'only Claude\'s change shows');
  assert.equal(now.baseHtml, undefined);
  assert.equal(t.saved.text, '# T\n\nalpha.\n\nbeta.\n\nGAMMA.\n\ndelta.\n');
  // An edit inside Claude's change stays part of it.
  t.s.handle({ type: 'saveBlock', ls: 2, le: 3, original: 'ALPHA.\n', newText: 'ALPHA!\n' });
  now = t.shown();
  assert.deepEqual(now.hunks.map((h) => h.cur.ls), [2]);
  assert.ok(t.saved.text.includes('alpha.'));
  t.s.handle({ type: 'undo' });
  t.s.handle({ type: 'undo' });
  assert.equal(t.saved.text, '# T\n\nalpha.\n\nbeta.\n\ngamma.\n');
  assert.deepEqual(t.shown().hunks.map((h) => h.cur.ls), [2]);
  // A change that shows lines the view's copy never had brings the baseline again.
  t.s.handle({ type: 'redo' });
  fs.writeFileSync(t.md, fs.readFileSync(t.md, 'utf8').replace('delta', 'DELTA'));
  t.s.render();
  const last = t.shown();
  assert.ok(last.baseHtml.includes('delta'));
});

test('baseline lifecycle: a new Send keeps an unreviewed or untouched baseline, replaces a reviewed one', () => {
  const t = session('life.md', '# T\n\none.\n\ntwo.\n');
  t.s.handle({ type: 'addComment', anchor: anchor('one', 3), body: 'a' });
  t.s.handle({ type: 'sendToAgent' });
  const first = t.saved.meta;
  assert.ok(first && first.threads.length === 1);
  assert.deepEqual(first.spans, { [first.threads[0]]: [2, 3] }, "the thread's lines in the copy");
  assert.equal(t.saved.text, '# T\n\none.\n\ntwo.\n');
  assert.deepEqual(t.last('baseline').info, { at: first.at, threads: first.threads, changed: false });
  // Sent again before Claude changed anything: the threads add up, the copy and its time stay.
  t.s.handle({ type: 'addComment', anchor: anchor('two', 5), body: 'b' });
  t.s.handle({ type: 'sendToAgent' });
  assert.equal(t.saved.meta.at, first.at);
  assert.equal(t.saved.meta.threads.length, 2);
  // The agent edits; the reviewer sends again before reviewing.
  fs.writeFileSync(t.md, '# T\n\nONE.\n\ntwo.\n');
  t.s.render();
  assert.equal(t.last('baseline').info.changed, true);
  t.s.handle({ type: 'sendToAgent' });
  const second = t.saved.meta;
  assert.equal(second.id, first.id, 'still compares against the copy from before the first round');
  assert.equal(second.threads.length, 2);
  // Reviewed (kept) → the next Send starts from the file as it is.
  const ch = t.changes();
  t.s.handle({ type: 'keepChange', v: ch.v, i: 0 });
  assert.equal(t.last('baseline').info.changed, false);
  assert.equal(t.saved.meta.settled, true);
  t.s.handle({ type: 'sendToAgent' });
  assert.equal(t.saved.meta.settled, undefined, 'a new copy');
  assert.equal(t.saved.text, '# T\n\nONE.\n\ntwo.\n');
  // An open Changes bar hears about the new copy at once.
  assert.equal(t.last('changes').changes.baseId, t.saved.meta.id);
  t.s.handle({ type: 'acceptChanges' });
  assert.equal(t.saved.meta, undefined);
  t.s.handle({ type: 'sendToAgent' });
  assert.ok(t.saved.meta);
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

/** Send `base`, let the agent write `agent`, then Keep or Revert every change, picking with `pick`. */
function settleAll(name, base, agent, mode, pick) {
  const t = session(name, base);
  t.s.handle({ type: 'addComment', anchor: anchor('a', 1), body: 'x' });
  t.s.handle({ type: 'sendToAgent' });
  fs.writeFileSync(t.md, agent);
  t.s.render();
  let ch = t.changes();
  for (let k = 0; k < 60 && ch && ch.hunks.length; k++) {
    const errors = t.posted.filter((m) => m.type === 'error').length;
    t.s.handle({ type: mode === 'keep' ? 'keepChange' : 'revertChange', v: ch.v, i: pick(ch.hunks.length) });
    assert.equal(t.posted.filter((m) => m.type === 'error').length, errors, t.last('error')?.message);
    ch = t.shown();
  }
  assert.deepEqual(ch?.hunks ?? [], [], 'nothing left to settle');
  return t;
}

const rng = (seed) => (n) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return Math.floor((((x ^ (x >>> 14)) >>> 0) / 2 ** 32) * n);
};

/** Revert all, in several orders, gives back the baseline's bytes; Keep all makes the baseline the file. */
function roundTrips(name, base, agent, orders = 4) {
  const rnd = rng(name.length);
  for (let o = 0; o < orders; o++) {
    const pick = o === 0 ? () => 0 : o === 1 ? (n) => n - 1 : rnd;
    const t = settleAll(`${name}-r${o}.md`, base, agent, 'revert', pick);
    assert.equal(fs.readFileSync(t.md).toString('latin1'), Buffer.from(base).toString('latin1'), `${name}: revert order ${o}`);
    const k = settleAll(`${name}-k${o}.md`, base, agent, 'keep', pick);
    assert.ok(fs.readFileSync(k.md).equals(Buffer.from(agent)), `${name}: Keep never writes the file`);
    assert.equal(k.saved.text.replace(/^﻿/, '').replace(/\r\n/g, '\n'), agent.toString().replace(/^﻿/, '').replace(/\r\n/g, '\n'), `${name}: keep order ${o}`);
  }
}

const crlf = (s) => '\uFEFF' + s.replace(/\n/g, '\r\n');
for (const [name, base, agent] of [
  ['ref-def after a changed block', 'Para [x] one.\n\n[x]: http://a\n\nOld.\n\nEnd.\n', 'Para [x] two.\n\n[x]: http://a\n\nEnd.\n'],
  ['ref-def between replaced blocks', 'Alpha one.\n[x]: http://a\n\nBeta.\n', 'Gamma two.\n[x]: http://a\n\nDelta three.\n\nBeta.\n'],
  ['footnote no longer referenced', 'Note[^1] here.\n\n[^1]: a note.\n\nMore.\n', 'Note here.\n\n[^1]: a note.\n\nMore text.\n'],
  ['first block deleted', 'First.\n\nSecond.\n\nThird.\n', 'Second.\n\nThird.\n'],
  ['only block deleted', 'Only.\n', ''],
  ['everything replaced', 'One.\n\nTwo.\n', '# New\n\n- a\n- b\n'],
  ['tight list: item removed, added, changed', '- a one\n- b two\n- c three\n\nAfter.\n', '- a one\n- c three changed\n- d four\n\nAfter.\n'],
  ['loose list', '- a one\n\n- b two\n\n- c three\n', '- a one\n\n- c three\n\n- d new\n'],
  ['list turned into paragraphs', 'Intro.\n- a\n- b\n', 'Intro.\n\nA para.\n\nB para.\n'],
  ['table row changed, table deleted', '| a | b |\n|---|---|\n| 1 | 2 |\n\nText.\n\n| c |\n|---|\n| 3 |\n', '| a | b |\n|---|---|\n| 1 | 9 |\n\nText.\n'],
  ['quote split', '> one\n>\n> two\n\nEnd.\n', '> one changed\n\nEnd.\n'],
  ['moved block', 'A block.\n\nB block.\n\nC block.\n', 'B block.\n\nC block.\n\nA block.\n'],
]) {
  test(`Revert all in any order is the baseline, Keep all is the file: ${name}`, () => roundTrips(name.replace(/\W+/g, '-'), base, agent));
  test(`... with CRLF and a BOM: ${name}`, () => roundTrips('crlf-' + name.replace(/\W+/g, '-'), crlf(base), crlf(agent)));
}

test('Revert all and Keep all round-trip on generated documents', () => {
  const rnd = rng(11);
  const W = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta'];
  let u = 0;
  const para = () => Array.from({ length: 1 + rnd(4) }, () => W[rnd(W.length)]).join(' ') + ` u${u++}.`;
  const chunk = () => [
    () => '#'.repeat(1 + rnd(2)) + ' ' + para(),
    () => Array.from({ length: 1 + rnd(3) }, () => '- ' + para()).join('\n'),
    () => '```\n' + para() + '\n```',
    () => '> ' + para() + '\n>\n> ' + para(),
    () => '| a | b |\n|---|---|\n| ' + para() + ' | x |',
    para,
    para,
  ][rnd(7)]();
  for (let n = 0; n < 60; n++) {
    const doc = Array.from({ length: 1 + rnd(5) }, chunk);
    if (rnd(2)) doc.splice(rnd(doc.length + 1), 0, '[x]: http://a');
    const next = [...doc];
    for (let k = 0, m = 1 + rnd(3); k < m; k++) {
      const i = rnd(next.length + 1);
      const r = rnd(3);
      if (r === 0) next.splice(i, 0, chunk());
      else if (next[i] && next[i] !== '[x]: http://a') r === 1 ? next.splice(i, 1) : (next[i] = chunk());
    }
    const [eol, bom, fin] = [rnd(3) ? '\n' : '\r\n', rnd(4) ? '' : '\uFEFF', rnd(4) ? 1 : 0];
    const enc = (d) => bom + d.join('\n\n').replace(/\n/g, eol) + (fin ? eol : '');
    const base = enc(doc);
    const agent = enc(next);
    if (base === agent) continue;
    roundTrips(`gen${n}`, base, agent, 2);
  }
});

/** Workspace state as VS Code keeps it: every value is serialized on write. */
function fakeState(init = {}) {
  const data = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  const writes = [];
  return {
    writes,
    get: (k) => (data.has(k) ? JSON.parse(data.get(k)) : undefined),
    update: (k, v) => {
      const json = v === undefined ? undefined : JSON.stringify(v);
      writes.push([k, json?.length ?? 0]);
      if (json === undefined) data.delete(k);
      else data.set(k, json);
    },
    keys: () => [...data.keys()],
  };
}

test('baseline store: bytes in files named by the path, details in state, oldest dropped over the limits', () => {
  const dir = path.join(tmp, 'store');
  fs.rmSync(dir, { recursive: true, force: true });
  const state = fakeState({ 'mdReview.baselines:/old.md': { bytes: 'x'.repeat(1000) } });
  const st = new lib.BaselineStore(dir, state, { maxFiles: 2, maxBytes: 25, win32: true });
  assert.deepEqual(state.keys(), [], 'copies kept in state by earlier builds are removed');
  assert.equal(st.key('C:\\Docs\\A.md'), st.key('c:\\docs\\a.md'), 'case-folded on Windows');
  assert.notEqual(new lib.BaselineStore(dir, state, { win32: false }).key('/d/A.md'), new lib.BaselineStore(dir, state, { win32: false }).key('/d/a.md'));
  const meta = (id) => ({ id, at: 'now', threads: ['t'] });
  const a = st.forFile('/d/a.md');
  const b = st.forFile('/d/b.md');
  const c = st.forFile('/d/c.md');
  a.set(meta('A'), Buffer.from('a'.repeat(10)));
  b.set(meta('B'), Buffer.from('b'.repeat(10)));
  assert.equal(a.read().toString(), 'a'.repeat(10));
  assert.deepEqual(a.get(), meta('A'));
  assert.ok(state.writes.every(([, n]) => n < 400), 'no bytes in state');
  // Details alone don't rewrite the file.
  a.set({ ...meta('A'), settled: true });
  assert.equal(a.read().toString(), 'a'.repeat(10));
  c.set(meta('C'), Buffer.from('c'.repeat(10))); // three files: b is now the oldest
  assert.equal(b.get(), undefined);
  assert.equal(b.read(), undefined);
  assert.ok(a.get() && c.get());
  c.set(meta('C2'), Buffer.from('c'.repeat(20))); // 30 bytes: over the size limit
  assert.equal(a.get(), undefined);
  assert.equal(c.read().length, 20);
  c.set(null);
  assert.equal(c.read(), undefined);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(state.get('mdReview.baselines'), undefined);
});

test("with the view off, your edit costs no parse of the baseline and writes no bytes to state", () => {
  const dir = path.join(tmp, 'store2');
  fs.rmSync(dir, { recursive: true, force: true });
  const state = fakeState();
  const md = path.join(tmp, 'cost.md');
  const para = (n) => `Paragraph ${n} with some words in it.\n\n`;
  const baseText = '# T\n\n' + Array.from({ length: 400 }, (_, n) => para(n)).join('');
  fs.writeFileSync(md, baseText);
  fs.rmSync(md + '.comments.json', { force: true });
  const resolveImage = (x) => x;
  const parsed = [];
  const r = lib.rendererFor(resolveImage);
  const parse = r.parse.bind(r);
  r.parse = (src, env) => (parsed.push(src), parse(src, env));
  const posted = [];
  const s = new lib.ReviewSession({
    mdPath: md, author: () => 'R', showResolved: () => true, post: (m) => posted.push(m), resolveImage,
    getText: () => fs.readFileSync(md, 'utf8'), isDirty: () => false, openLink: () => {},
    baselines: new lib.BaselineStore(dir, state).forFile(md),
  });
  try {
    s.handle({ type: 'ready' });
    s.handle({ type: 'addComment', anchor: anchor('Paragraph 1', 5), body: 'x' });
    s.handle({ type: 'sendToAgent' });
    fs.writeFileSync(md, baseText.replace('Paragraph 1 ', 'Paragraph one '));
    s.render();
    parsed.length = 0;
    state.writes.length = 0;
    s.handle({ type: 'saveBlock', ls: 300, le: 301, original: para(149).slice(0, -1), newText: 'Mine.\n' });
    assert.equal(posted.filter((m) => m.type === 'error').length, 0);
    assert.ok(!parsed.includes(baseText), 'the baseline was not parsed');
    assert.equal(parsed.length, 1, 'only the file, to render it');
    assert.ok(state.writes.every(([, n]) => n < 400), 'state holds details only');
    const saved = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
    assert.ok(saved.includes('Mine.') && saved.includes('Paragraph 1 '), 'your edit is in the copy, Claude\'s is not');
  } finally {
    r.parse = parse;
  }
});

test('a copy into a file with no line break keeps the source\'s CRLF', () => {
  const src = Buffer.from('One.\r\n\r\nTwo.\r\n');
  assert.equal(lib.spliceLines(Buffer.from(''), 0, 0, src, 0, 3).toString(), 'One.\r\n\r\nTwo.\r\n');
});

test('Keep all leaves nothing unreviewed, even when only blank lines differ', () => {
  const t = settleAll('keepstuck.md', '```\nx\n```\n', 'zeta.\n\n> theta.\n', 'keep', () => 0);
  assert.equal(t.saved.text, 'zeta.\n\n> theta.\n');
  assert.equal(t.saved.meta.settled, true);
  assert.equal(t.last('baseline').info.changed, false);
});

test('Chinese, Japanese and Korean text diffs by character', () => {
  assert.deepEqual(lib.diffWords('我们今天去', '我们明天去'), [[0, '我们'], [-1, '今'], [1, '明'], [0, '天去']]);
});
