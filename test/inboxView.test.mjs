// The review inbox tree (src/inboxView.ts) against a small workspace on disk,
// with a stand-in for the parts of the vscode API it uses: nothing runs until
// the view is shown, then one search, then only the sidecars that change.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-inbox-'));
const calls = { findFiles: 0, reads: [], watchers: 0, statusItems: 0, trees: [] };
const watch = { change: [], create: [], delete: [] };

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
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!skip(e.name)) walk(path.join(dir, e.name), acc);
    } else if (e.name.endsWith('.md.comments.json')) acc.push(Uri.file(path.join(dir, e.name)));
  }
  return acc;
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
      return walk(root).slice(0, max);
    },
    fs: {
      async stat(uri) {
        const st = fs.statSync(uri.fsPath);
        return { mtime: st.mtimeMs, size: st.size };
      },
      async readFile(uri) {
        calls.reads.push(path.relative(root, uri.fsPath));
        return fs.readFileSync(uri.fsPath);
      },
    },
    createFileSystemWatcher() {
      calls.watchers++;
      const on = (k) => (f) => {
        watch[k].push(f);
        return { dispose() {} };
      };
      return { onDidChange: on('change'), onDidCreate: on('create'), onDidDelete: on('delete'), dispose() {} };
    },
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    asRelativePath: (uri) => path.relative(root, typeof uri === 'string' ? uri : uri.fsPath),
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
function write(rel, comments) {
  const p = path.join(root, rel + '.comments.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(path.join(root, rel), '# Doc\n');
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
const view = new InboxView();
const tree = calls.trees[0];
const labelOf = (item) => item.label ?? path.relative(root, item.resourceUri.fsPath);
async function snapshot() {
  const out = {};
  for (const g of await view.getChildren()) {
    const gi = view.getTreeItem(g);
    const files = {};
    for (const f of await view.getChildren(g)) {
      files[labelOf(view.getTreeItem(f))] = (await view.getChildren(f)).map((t) => view.getTreeItem(t).label);
    }
    out[`${gi.label} (${gi.description})`] = files;
  }
  return out;
}
const changes = () => {
  let k = 0;
  view.onDidChangeTreeData(() => k++);
  return () => k;
};

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
  assert.equal(calls.watchers, 1);
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
  const d = items.get(fromClaude.id);
  assert.equal(d.description, 'Major · L3 · some text');
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
  watch.change.forEach((f) => f(Uri.file(p)));
  watch.change.forEach((f) => f(Uri.file(p))); // a burst settles into one update
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
  watch.create.forEach((f) => f(Uri.file(added)));
  watch.create.forEach((f) => f(Uri.file(hidden)));
  await wait(450);
  let snap = await snapshot();
  assert.deepEqual(Object.keys(snap['Waiting on Claude (2)']), ['docs/notes.md', 'new.md']);
  const notes = path.join(root, 'docs/notes.md.comments.json');
  fs.rmSync(notes);
  watch.delete.forEach((f) => f(Uri.file(notes)));
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

after(() => {
  view.dispose(); // also stops the timer for the working claim going stale
  fs.rmSync(root, { recursive: true, force: true });
});
