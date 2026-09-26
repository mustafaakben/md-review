// The review inbox tree (src/inboxView.ts) against a small workspace on disk,
// with a stand-in for the parts of the vscode API it uses: nothing runs until
// the view is shown, then one search, then only the sidecars that change, and
// hand-edited files, folder moves and links don't knock it over.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'tmp', 'inboxView.cjs');
esbuild.buildSync({ entryPoints: [path.join(here, '..', 'src', 'inboxView.ts')], outfile: out, bundle: true, format: 'cjs', platform: 'node', external: ['vscode'], logLevel: 'silent' });

const mkroot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-inbox-')));
const root = mkroot();
const made = [root];
const state = { roots: [root], exclude: {} };
const calls = { findFiles: 0, stats: 0, reads: [], watchers: 0, statusItems: 0, trees: [] };
/** Every watcher made, with the events it asked for. */
const watchers = [];
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
// Timers still pending, to catch one left behind by a disposed view.
const live = new Set();
const { setTimeout: st, clearTimeout: ct } = globalThis;
globalThis.setTimeout = (f, ms, ...a) => {
  const t = st(() => {
    live.delete(t);
    f(...a);
  }, ms);
  live.add(t);
  return t;
};
globalThis.clearTimeout = (t) => {
  live.delete(t);
  ct(t);
};

class EventEmitter {
  listeners = [];
  event = (f) => {
    this.listeners.push(f);
    return { dispose: () => {} };
  };
  fire(x) {
    this.listeners.forEach((f) => f(x));
  }
  dispose() {}
}
const Uri = { file: (p) => ({ fsPath: p, scheme: 'file' }) };
const skip = (name) => name === 'node_modules' || name.startsWith('.');
// Like the search: follows links to folders, but not round a loop.
function walk(dir, acc = [], seen = new Set()) {
  const real = fs.realpathSync(dir);
  if (seen.has(real)) return acc;
  seen.add(real);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (fs.statSync(p).isDirectory()) {
      if (!skip(e.name) && !state.exclude[`**/${e.name}`]) walk(p, acc, seen);
    } else if (e.name.endsWith('.md.comments.json')) acc.push(Uri.file(p));
  }
  return acc;
}
const folderOf = (p) => state.roots.find((r) => p === r || p.startsWith(r + path.sep));
/** What VS Code's watchers would pass on: sidecar events to the sidecar watcher, deletes of anything to the `**` one. */
function emit(kind, p) {
  for (const w of watchers) if (w.glob === '**' || p.endsWith('.md.comments.json')) w[kind].forEach((f) => f(Uri.file(p)));
}
const vscode = {
  EventEmitter,
  Uri,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeIcon: class ThemeIcon {
    static File = { id: 'file' };
    constructor(id) {
      this.id = id;
    }
  },
  TreeItem: class TreeItem {
    constructor(label, collapsibleState) {
      if (typeof label === 'string') this.label = label;
      else this.resourceUri = label;
      this.collapsibleState = collapsibleState;
    }
  },
  window: {
    createTreeView(id, opts) {
      const view = { id, provider: opts.treeDataProvider, visible: true, message: undefined, badge: undefined, dispose() {} };
      calls.trees.push(view);
      return view;
    },
    createStatusBarItem() {
      calls.statusItems++;
      return { shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
    },
  },
  workspace: {
    async findFiles(include, exclude, max) {
      calls.findFiles++;
      return state.roots.flatMap((r) => walk(r)).slice(0, max);
    },
    fs: {
      async stat(uri) {
        calls.stats++;
        const st = fs.statSync(uri.fsPath);
        return { mtime: st.mtimeMs, size: st.size };
      },
      async readFile(uri) {
        calls.reads.push(path.relative(root, uri.fsPath));
        return fs.readFileSync(uri.fsPath);
      },
    },
    createFileSystemWatcher(glob, ignoreCreate, ignoreChange, ignoreDelete) {
      calls.watchers++;
      const w = { glob, change: [], create: [], delete: [] };
      watchers.push(w);
      const on = (k, off) => (f) => {
        if (!off) w[k].push(f);
        return { dispose: () => (w[k] = w[k].filter((x) => x !== f)) };
      };
      return { onDidChange: on('change', ignoreChange), onDidCreate: on('create', ignoreCreate), onDidDelete: on('delete', ignoreDelete), dispose() {} };
    },
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    getWorkspaceFolder: (uri) => (folderOf(uri.fsPath) ? { uri: Uri.file(folderOf(uri.fsPath)) } : undefined),
    getConfiguration: (section) => ({ get: (k, d) => (section === 'files' && k === 'exclude' ? state.exclude : d) }),
    asRelativePath: (uri) => {
      const p = typeof uri === 'string' ? uri : uri.fsPath;
      return path.relative(folderOf(p) ?? root, p);
    },
  },
};
const Module = require('node:module');
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};
const { InboxView } = require(out);

// ---------------------------------------------------------------- the workspace
let n = 0;
function thread(status, extra = {}) {
  n++;
  return {
    id: `c${n}`,
    author: 'Reviewer',
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`,
    anchor: { quote: 'some text', prefix: '', suffix: '', lineStart: n, lineEnd: n },
    body: `Thread ${n}`,
    status,
    submittedAt: status === 'draft' ? null : '2026-01-01T00:01:00Z',
    resolvedAt: status === 'resolved' ? '2026-01-01T00:05:00Z' : null,
    replies: [],
    ...extra,
  };
}
const claude = () => ({ id: `r${n}`, author: 'Claude', createdAt: '2026-01-02T00:00:00Z', body: 'Done.' });
function write(rel, comments, at = root) {
  const p = path.join(at, rel + '.comments.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(path.join(at, rel), '# Doc\n');
  fs.writeFileSync(p, typeof comments === 'string' ? comments : JSON.stringify({ schemaVersion: 1, file: path.basename(rel), comments }, null, 2));
  return p;
}
const answered = thread('submitted', { body: 'Answered', replies: [claude()] });
const working = thread('submitted', { body: 'Working', replies: [claude()], workingAt: new Date().toISOString(), workingBy: 'Claude' });
const fromClaude = thread('draft', { body: 'From Claude', author: 'Claude', origin: 'agent', reviewRun: 'run1', severity: 'major' });
write('paper.md', [answered, thread('submitted', { body: 'Open' }), thread('draft', { body: 'Mine' }), fromClaude]);
write('docs/notes.md', [working, thread('resolved', { body: 'Done' })]);
write('docs/broken.md', '{ "comments": [ oops');
write('node_modules/pkg/readme.md', [thread('submitted')]);
write('.hidden/x.md', [thread('submitted')]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (globalThis.view = new InboxView());
const tree = calls.trees[0];
const labelOf = (item, at = root) => item.label ?? path.relative(at, item.resourceUri.fsPath);
async function snapshot(view = globalThis.view, at = root) {
  const out = {};
  for (const g of await view.getChildren()) {
    const gi = view.getTreeItem(g);
    const files = {};
    for (const f of await view.getChildren(g)) {
      files[labelOf(view.getTreeItem(f), at)] = (await view.getChildren(f)).map((t) => view.getTreeItem(t).label);
    }
    out[`${gi.label} (${gi.description})`] = files;
  }
  return out;
}
const changes = (v = view) => {
  let k = 0;
  v.onDidChangeTreeData(() => k++);
  return () => k;
};
/** A view on a workspace of its own; views made before it stop hearing events. */
function fresh(...roots) {
  state.roots = roots;
  watchers.length = 0;
  const v = new InboxView();
  return { view: v, tree: calls.trees.at(-1) };
}
async function treeIds(v) {
  const ids = [];
  for (const g of await v.getChildren()) {
    ids.push(v.getTreeItem(g).id);
    for (const f of await v.getChildren(g)) {
      ids.push(v.getTreeItem(f).id);
      for (const t of await v.getChildren(f)) ids.push(v.getTreeItem(t).id);
    }
  }
  return ids;
}

test('nothing runs until the view is shown', () => {
  assert.equal(tree.id, 'mdReview.inbox');
  assert.equal(calls.findFiles, 0);
  assert.equal(calls.watchers, 0);
  assert.equal(calls.statusItems, 0);
  assert.equal(calls.reads.length, 0);
});

test('first look: one search, groups by whose turn it is', async () => {
  assert.deepEqual(await snapshot(), {
    'Needs you (1)': { 'paper.md': ['Answered'] },
    'From Claude, to triage (1)': { 'paper.md': ['From Claude'] },
    'Waiting on Claude (2)': { 'docs/notes.md': ['Working'], 'paper.md': ['Open'] },
    'Drafts (1)': { 'paper.md': ['Mine'] },
    'Resolved (1)': { 'docs/notes.md': ['Done'] },
  });
  assert.equal(calls.findFiles, 1);
  // Sidecar events, and deletes of anything (a folder going is one event).
  assert.equal(calls.watchers, 2);
  assert.deepEqual(calls.reads.sort(), ['docs/broken.md.comments.json', 'docs/notes.md.comments.json', 'paper.md.comments.json']);
  // Claude's drafts to triage count as the reviewer's turn.
  assert.equal(tree.badge.value, 2);
  assert.equal(tree.message, undefined);
});

test('tree items: icons, descriptions and jump-to-thread', async () => {
  const groups = await view.getChildren();
  const items = new Map();
  for (const g of groups) for (const f of await view.getChildren(g)) for (const t of await view.getChildren(f)) items.set(t.comment.id, view.getTreeItem(t));
  const w = items.get(working.id);
  assert.equal(w.iconPath.id, 'sync~spin');
  assert.match(w.tooltip, /Claude is working on this/);
  assert.match(w.accessibilityInformation.label, /^Working, Claude is working on it, L\d+, some text$/);
  // Needs you: the tooltip shows what Claude said last.
  assert.equal(items.get(answered.id).tooltip, 'Answered\n\nClaude: Done.');
  assert.equal(items.get(answered.id).accessibilityInformation.label, `Answered, comment, L${answered.anchor.lineStart}, some text`);
  const d = items.get(fromClaude.id);
  assert.equal(d.description, 'Major · L3 · some text');
  assert.equal(d.accessibilityInformation.label, 'From Claude, comment, Major, L3, some text');
  assert.deepEqual(d.command, { command: 'mdReview.openThread', title: 'Open Thread', arguments: [path.join(root, 'paper.md'), fromClaude.id] });
  assert.equal(items.get(answered.id).iconPath.id, 'comment');
  const file = view.getTreeItem((await view.getChildren(groups.find((g) => g.group === 'waiting')))[0]);
  assert.equal(file.description, 'docs · 1');
  // Every icon is a codicon.
  for (const g of groups) assert.equal(typeof view.getTreeItem(g).iconPath.id, 'string');
});

test('a changed sidecar is read on its own after a pause, without searching again', async () => {
  const count = changes();
  const reads = calls.reads.length;
  const p = write('paper.md', [answered, thread('submitted', { body: 'Also answered', replies: [claude()] }), fromClaude]);
  emit('change', p);
  emit('change', p); // a burst settles into one update
  await wait(450);
  assert.equal(count(), 1);
  assert.equal(calls.findFiles, 1);
  assert.deepEqual(calls.reads.slice(reads), ['paper.md.comments.json']);
  const snap = await snapshot();
  assert.deepEqual(snap['Needs you (2)'], { 'paper.md': ['Answered', 'Also answered'] });
  assert.equal(snap['Drafts (1)'], undefined);
});

test('new and deleted sidecars, skipping node_modules and dot-folders', async () => {
  const added = write('new.md', [thread('submitted')]);
  const hidden = write('.cache/y.md', [thread('submitted')]);
  emit('create', added);
  emit('create', hidden);
  await wait(450);
  let snap = await snapshot();
  assert.deepEqual(Object.keys(snap['Waiting on Claude (2)']), ['docs/notes.md', 'new.md']);
  const notes = path.join(root, 'docs/notes.md.comments.json');
  fs.rmSync(notes);
  emit('delete', notes);
  await wait(450);
  snap = await snapshot();
  assert.deepEqual(Object.keys(snap['Waiting on Claude (1)']), ['new.md']);
  assert.equal(snap['Resolved (1)'], undefined);
  assert.equal(calls.findFiles, 1);
});

test('Refresh searches again and drops what is gone', async () => {
  fs.rmSync(path.join(root, 'new.md.comments.json'));
  view.refresh();
  await wait(50);
  assert.equal(calls.findFiles, 2);
  assert.deepEqual(Object.keys(await snapshot()), ['Needs you (2)', 'From Claude, to triage (1)']);
});

test('a sidecar with the wrong types arrives by event: the view keeps updating', async () => {
  const count = changes();
  // Epoch times on two threads on one line used to throw in the sort and jam every update after it.
  const p = write('epoch.md', JSON.stringify({ comments: [{ ...thread('submitted'), createdAt: 2, anchor: { quote: 'q', lineStart: 1 } }, { ...thread('submitted'), createdAt: 1, body: 42, anchor: { quote: 5, lineStart: 1 } }] }));
  emit('create', p);
  await wait(450);
  assert.equal(count(), 1);
  assert.deepEqual((await snapshot())['Waiting on Claude (2)'], { 'epoch.md': ['Thread ' + (n - 1), '(no text)'] });
  write('epoch.md', [thread('submitted', { body: 'fixed' })]);
  emit('change', p);
  await wait(450);
  assert.equal(count(), 2);
  assert.deepEqual((await snapshot())['Waiting on Claude (1)'], { 'epoch.md': ['fixed'] });
  fs.rmSync(p);
  view.refresh();
  await wait(50);
  assert.equal((await snapshot())['Waiting on Claude (1)'], undefined);
  assert.deepEqual(unhandled, []);
});

test('threads sharing an id still get distinct tree ids', async () => {
  const p = write('dup.md', [thread('submitted', { id: 'same', body: 'one' }), thread('submitted', { id: 'same', body: 'two' })]);
  emit('create', p);
  await wait(450);
  assert.deepEqual((await snapshot())['Waiting on Claude (2)'], { 'dup.md': ['one', 'two'] });
  const ids = await treeIds(view);
  assert.equal(new Set(ids).size, ids.length);
  fs.rmSync(p);
  emit('delete', p);
  await wait(450);
});

test('the throttle: steady writes still show every so often', async () => {
  const count = changes();
  const p = write('busy.md', [thread('submitted')]);
  const t0 = Date.now();
  let first = null;
  view.onDidChangeTreeData(() => (first ??= Date.now() - t0));
  for (let i = 0; i < 12; i++) {
    write('busy.md', [thread('submitted', { body: `v${i}` })]);
    emit('change', p);
    await wait(100);
  }
  await wait(400);
  assert.ok(first !== null && first < 600, `first update after ${first} ms`);
  assert.ok(count() >= 3, `${count()} updates`);
  assert.deepEqual((await snapshot())['Waiting on Claude (1)'], { 'busy.md': ['v11'] });
  fs.rmSync(p);
  emit('delete', p);
  await wait(450);
});

test('an event reads that one sidecar and stats nothing else', async () => {
  const at = mkroot();
  made.push(at);
  for (let i = 0; i < 30; i++) write(`d${i % 3}/f${i}.md`, [thread('submitted')], at);
  const { view: v } = fresh(at);
  await snapshot(v, at);
  const stats = calls.stats;
  const reads = calls.reads.length;
  const p = write('d0/f0.md', [thread('resolved')], at);
  emit('change', p);
  await wait(450);
  assert.deepEqual(Object.keys(await snapshot(v, at)), ['Waiting on Claude (29)', 'Resolved (1)']);
  assert.equal(calls.stats - stats, 1);
  assert.equal(calls.reads.length - reads, 1);
  v.dispose();
});

test('a folder deleted or renamed as one event: its threads go, and move with it', async () => {
  const at = mkroot();
  made.push(at);
  write('notes/a.md', [thread('submitted', { body: 'a' })], at);
  write('notes/deep/b.md', [thread('submitted', { body: 'b' })], at);
  write('old/c.md', [thread('submitted', { body: 'c' })], at);
  write('top.md', [thread('submitted', { body: 'top' })], at);
  const { view: v } = fresh(at);
  assert.deepEqual(Object.keys((await snapshot(v, at))['Waiting on Claude (4)']), ['notes/a.md', 'notes/deep/b.md', 'old/c.md', 'top.md']);
  const searches = calls.findFiles;
  // Deleting a file nobody reviewed changes nothing.
  fs.writeFileSync(path.join(at, 'scratch.txt'), '');
  fs.rmSync(path.join(at, 'scratch.txt'));
  emit('delete', path.join(at, 'scratch.txt'));
  fs.rmSync(path.join(at, 'notes'), { recursive: true });
  emit('delete', path.join(at, 'notes'));
  await wait(450);
  assert.deepEqual(Object.keys((await snapshot(v, at))['Waiting on Claude (2)']), ['old/c.md', 'top.md']);
  fs.renameSync(path.join(at, 'old'), path.join(at, 'archive'));
  emit('delete', path.join(at, 'old'));
  emit('create', path.join(at, 'archive'));
  await wait(450);
  assert.deepEqual(Object.keys((await snapshot(v, at))['Waiting on Claude (2)']), ['archive/c.md', 'top.md']);
  // One search for each folder that took reviewed files with it, none for the scratch file.
  assert.equal(calls.findFiles - searches, 2);
  v.dispose();
});

test('events the search would skip are skipped too', async () => {
  const at = mkroot();
  const outside = mkroot();
  made.push(at, outside);
  write('doc.md', [thread('submitted', { body: 'doc' })], at);
  const { view: v } = fresh(at);
  await snapshot(v, at);
  const reads = calls.reads.length;
  state.exclude = { '**/build': true, '**/keep': false };
  for (const [rel, where] of [['y.md', outside], ['.cache/y.md', at], ['node_modules/p/y.md', at], ['build/y.md', at]]) emit('create', write(rel, [thread('submitted')], where));
  emit('create', write('keep/y.md', [thread('submitted', { body: 'kept' })], at));
  await wait(450);
  assert.deepEqual(calls.reads.slice(reads), [path.relative(root, path.join(at, 'keep/y.md.comments.json'))]);
  assert.deepEqual(Object.keys((await snapshot(v, at))['Waiting on Claude (2)']), ['doc.md', 'keep/y.md']);
  state.exclude = {};
  v.dispose();
});

test('a folder linked in beside its target is listed once', async () => {
  const at = mkroot();
  made.push(at);
  write('a/doc.md', [thread('submitted', { body: 'in a' })], at);
  fs.symlinkSync(path.join(at, 'a'), path.join(at, 'b'), 'dir');
  fs.symlinkSync(at, path.join(at, 'a', 'loop'), 'dir');
  const { view: v } = fresh(at);
  assert.deepEqual(await snapshot(v, at), { 'Waiting on Claude (1)': { 'a/doc.md': ['in a'] } });
  v.dispose();
});

test('two workspace folders: the same file name in each, each its own node', async () => {
  const r1 = mkroot();
  const r2 = mkroot();
  made.push(r1, r2);
  write('README.md', [thread('submitted', { id: 'x', body: 'one' })], r1);
  write('README.md', [thread('submitted', { id: 'x', body: 'two' })], r2);
  const { view: v } = fresh(r1, r2);
  const [g] = await v.getChildren();
  assert.equal(v.getTreeItem(g).description, '2');
  const ids = await treeIds(v);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  v.dispose();
});

test('disposed while the first search runs, or with an update pending: nothing left behind', async () => {
  const at = mkroot();
  made.push(at);
  const p = write('doc.md', [thread('submitted', { replies: [claude()], workingAt: new Date().toISOString() })], at);
  const before = live.size;
  const items = calls.statusItems;
  const { view: v } = fresh(at);
  const first = v.getChildren();
  v.dispose();
  assert.deepEqual(await first, []);
  await wait(10);
  assert.equal(calls.statusItems, items);
  assert.equal(live.size, before);
  const { view: w } = fresh(at);
  await w.getChildren();
  emit('change', p);
  w.dispose();
  assert.equal(live.size, before);
  let fired = 0;
  w.onDidChangeTreeData(() => fired++);
  await wait(450);
  assert.equal(fired, 0);
});

after(() => {
  view.dispose(); // also stops the timer for the working claim going stale
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
