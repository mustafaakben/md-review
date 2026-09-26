// Undo/redo of in-view edits and the Send to Claude prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'features');

function session(md, extra = {}) {
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
    ...extra,
  });
  s.handle({ type: 'ready' });
  return { s, posted, last: (type) => posted.filter((m) => m.type === type).at(-1) };
}

function fresh(name, text) {
  fs.mkdirSync(tmp, { recursive: true });
  const md = path.join(tmp, name);
  fs.writeFileSync(md, text);
  fs.rmSync(md + '.comments.json', { force: true });
  return md;
}

test('EditHistory diff/undo/redo is byte-exact', () => {
  const h = new lib.EditHistory();
  const a = Buffer.from('one\r\ntwo\r\nthree\r\n');
  const b = Buffer.from('one\r\nTWO!\r\nthree\r\n');
  const c = Buffer.from('one\r\nTWO!\r\nthree\r\nfour\r\n');
  h.record(a, b);
  h.record(b, c);
  h.record(c, c); // no-op edits are not recorded
  assert.ok(h.canUndo && !h.canRedo);
  const u1 = h.undo(c);
  assert.ok(u1.equals(b));
  const u2 = h.undo(u1);
  assert.ok(u2.equals(a));
  assert.ok(!h.canUndo && h.canRedo);
  assert.ok(h.redo(u2).equals(b));
});

test('EditHistory refuses to undo over outside changes', () => {
  const h = new lib.EditHistory();
  h.record(Buffer.from('a b c'), Buffer.from('a B c'));
  assert.throws(() => h.undo(Buffer.from('a B c, edited by an agent')), lib.HistoryError);
  assert.ok(!h.canUndo, 'history is cleared');
});

test('undo and redo an inline edit through the session', () => {
  const src = '# Title\r\n\r\nA **bold** claim here.\r\n\r\nSecond para.\r\n';
  const md = fresh('undo.md', src);
  const { s, posted, last } = session(md);
  assert.deepEqual(last('history'), { type: 'history', canUndo: false, canRedo: false });

  s.handle({ type: 'saveInline', ls: 2, le: 3, kind: 'paragraph', oldText: 'A bold claim here.', newText: 'A bold claim right here.' });
  const edited = fs.readFileSync(md, 'utf8');
  assert.equal(edited, src.replace('claim here', 'claim right here'));
  assert.equal(last('history').canUndo, true);

  s.handle({ type: 'saveBlock', ls: 4, le: 5, original: 'Second para.', newText: 'Second paragraph.' });
  s.handle({ type: 'undo' });
  assert.equal(fs.readFileSync(md, 'utf8'), edited);
  s.handle({ type: 'undo' });
  assert.equal(fs.readFileSync(md, 'utf8'), src, 'back to the original bytes, CRLF intact');
  assert.deepEqual(last('history'), { type: 'history', canUndo: false, canRedo: true });
  s.handle({ type: 'undo' });
  assert.equal(last('toast').message, 'Nothing to undo.');
  s.handle({ type: 'redo' });
  assert.equal(fs.readFileSync(md, 'utf8'), edited);
  assert.ok(!posted.some((m) => m.type === 'error'));
});

test('undo is refused after an outside edit', () => {
  const md = fresh('outside.md', 'Hello world.\n');
  const { s, last } = session(md);
  s.handle({ type: 'saveBlock', ls: 0, le: 1, original: 'Hello world.', newText: 'Hello there.' });
  fs.writeFileSync(md, 'Hello there, says the agent.\n');
  s.handle({ type: 'undo' });
  assert.match(last('error').message, /changed outside MD Review/);
  assert.equal(fs.readFileSync(md, 'utf8'), 'Hello there, says the agent.\n');
  assert.equal(last('history').canUndo, false);
});

test('an outside edit disables undo as soon as the view re-renders', () => {
  const md = fresh('outside-render.md', 'Hello world.\n');
  const { s, last } = session(md);
  s.handle({ type: 'saveBlock', ls: 0, le: 1, original: 'Hello world.', newText: 'Hello there.' });
  assert.equal(last('history').canUndo, true);
  s.render(); // our own write: history still applies
  assert.equal(last('history').canUndo, true);
  fs.writeFileSync(md, 'Hello there, says the agent.\n');
  s.render(); // what the file watcher does after an outside change
  assert.deepEqual(last('history'), { type: 'history', canUndo: false, canRedo: false });
});

test('EditHistory.sync keeps history that still matches the file', () => {
  const h = new lib.EditHistory();
  const a = Buffer.from('x'), b = Buffer.from('y');
  h.record(a, b);
  assert.equal(h.sync(b), false);
  h.undo(b);
  assert.equal(h.sync(a), false, 'after undo the file is the before-state');
  assert.ok(h.canRedo);
  assert.equal(h.sync(Buffer.from('z')), true);
  assert.ok(!h.canUndo && !h.canRedo);
});

test('Send to Claude submits drafts and builds a prompt', () => {
  const md = fresh('send.md', '# T\n\nSome paragraph with a claim.\n');
  const { s, last } = session(md);
  const anchor = { quote: 'a claim', prefix: 'Some paragraph with ', suffix: '.', lineStart: 3, lineEnd: 3 };
  s.handle({ type: 'addComment', anchor, body: 'Cite this.' });
  s.handle({ type: 'addComment', anchor: { ...anchor, quote: 'T', prefix: '', suffix: '', lineStart: 1, lineEnd: 1 }, body: 'Better title.' });
  s.handle({ type: 'sendToAgent' });
  const d = JSON.parse(fs.readFileSync(md + '.comments.json', 'utf8'));
  assert.deepEqual(d.comments.map((c) => c.status), ['submitted', 'submitted']);
  const p = last('agentPrompt');
  assert.equal(p.count, 2);
  assert.match(p.prompt, /the 2 submitted review comments on send\.md/);
  assert.match(p.prompt, /send\.md\.comments\.json/);
  assert.ok(p.prompt.includes(`${d.comments[0].id} (lines 3-3): "a claim" -> Cite this.`));
});

test('Ask Claude on one thread sends only that thread', () => {
  const md = fresh('one.md', 'Alpha beta gamma.\n');
  const calls = [];
  const { s, last } = session(md, { runAgent: (p) => (calls.push(p), 'started'), cliPath: '/ext/cli/mdreview.mjs' });
  const anchor = { quote: 'beta', prefix: 'Alpha ', suffix: ' gamma.', lineStart: 1, lineEnd: 1 };
  s.handle({ type: 'addComment', anchor, body: 'First.' });
  s.handle({ type: 'addComment', anchor, body: 'Second.' });
  const [c1, c2] = JSON.parse(fs.readFileSync(md + '.comments.json', 'utf8')).comments;
  s.handle({ type: 'sendToAgent', id: c2.id });
  const d = JSON.parse(fs.readFileSync(md + '.comments.json', 'utf8'));
  assert.equal(d.comments.find((c) => c.id === c1.id).status, 'draft', 'other drafts stay drafts');
  assert.equal(d.comments.find((c) => c.id === c2.id).status, 'submitted');
  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(`the review comment with id ${c2.id}`));
  assert.ok(!calls[0].includes('First.'));
  assert.ok(calls[0].includes('node "/ext/cli/mdreview.mjs" reply "one.md"'));
  assert.equal(last('toast').message, 'started');
});

test('Send to Claude with nothing open says so', () => {
  const md = fresh('empty.md', 'Nothing here.\n');
  const { s, last } = session(md, { runAgent: () => assert.fail('should not run') });
  s.handle({ type: 'sendToAgent' });
  assert.match(last('toast').message, /No open comments/);
});

test('reading prefs are sent on ready and saved on change', () => {
  const md = fresh('prefs.md', 'Text.\n');
  let stored = { theme: 'sepia', zoom: 1.2 };
  const { s, last } = session(md, { getPrefs: () => stored, setPrefs: (p) => (stored = p) });
  assert.deepEqual(last('prefs').prefs, { theme: 'sepia', zoom: 1.2 });
  s.handle({ type: 'setPrefs', prefs: { theme: 'night', zoom: 1.5, font: 'serif' } });
  assert.deepEqual(stored, { theme: 'night', zoom: 1.5, font: 'serif' });
});

test('a file change reaching the host several ways renders once', () => {
  const md = fresh('once.md', 'First paragraph.\n\nSecond paragraph.\n');
  const { s, posted } = session(md);
  const renders = () => posted.filter((m) => m.type === 'render').length;
  assert.equal(renders(), 1); // ready
  // The same text again (file watcher, buffer reload): nothing new to paint.
  s.render();
  s.render();
  assert.equal(renders(), 1);
  // An in-view edit repaints once; the watcher and buffer events that follow don't.
  s.handle({ type: 'saveBlock', ls: 0, le: 1, original: 'First paragraph.', newText: 'First, edited.' });
  s.render();
  s.render();
  assert.equal(renders(), 2);
  assert.match(posted.filter((m) => m.type === 'render').at(-1).html, /First, edited\./);
  // An outside change is still picked up.
  fs.writeFileSync(md, 'Replaced.\n');
  s.render();
  assert.equal(renders(), 3);
  // A reloaded view asks again and gets a fresh copy.
  s.handle({ type: 'ready' });
  assert.equal(renders(), 4);
});

test('on open the document comes last, after the reading look, comments and history', () => {
  const md = fresh('open-order.md', '# Title\n\nText.\n');
  const { posted } = session(md, { getPrefs: () => ({ zoom: 1.2 }) });
  assert.deepEqual(posted.map((m) => m.type), ['prefs', 'comments', 'history', 'render']);
});
