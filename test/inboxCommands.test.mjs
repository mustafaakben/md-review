// The review inbox's commands against a stand-in vscode API: Send All starts
// one Claude per workspace folder with open reviews, and jumping to a thread
// in a file that won't open leaves nothing queued for a later panel.
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
const build = (name) => {
  const outfile = path.join(here, 'tmp', `${name}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(here, '..', 'src', `${name}.ts`)], outfile, bundle: true, format: 'cjs', platform: 'node', external: ['vscode'], logLevel: 'silent' });
  return outfile;
};

const made = [];
const mkroot = (name) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-cmd-')));
  made.push(base);
  const dir = path.join(base, name);
  fs.mkdirSync(dir);
  return dir;
};
const state = { folders: [], mode: 'terminal', trusted: true, pick: undefined, openWith: async () => {} };
const calls = { terminals: [], info: [], warnings: [], openWith: [] };

const Uri = {
  file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
  joinPath: (u, ...s) => Uri.file(path.join(u.fsPath, ...s)),
};
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name), acc);
    else if (e.name.endsWith('.md.comments.json')) acc.push(Uri.file(path.join(dir, e.name)));
  }
  return acc;
}
const promptFile = (t) => t.shellArgs.at(-1).replace('Read and follow the review instructions in ', '');
const folder = (p) => ({ uri: Uri.file(p), name: path.basename(p), index: 0 });
const vscode = {
  Uri,
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  window: {
    activeTextEditor: undefined,
    showWorkspaceFolderPick: async () => state.pick,
    showInformationMessage: async (m) => void calls.info.push(m),
    showWarningMessage: async (m) => void calls.warnings.push(m),
    createTerminal: (o) => {
      calls.terminals.push(o);
      made.push(path.dirname(promptFile(o))); // runAgent's own temporary folder
      return { show() {} };
    },
  },
  commands: {
    executeCommand: async (id, ...args) => {
      if (id !== 'vscode.openWith') return;
      calls.openWith.push(args[0].fsPath);
      return state.openWith(...args);
    },
  },
  env: { clipboard: { writeText: async () => {} } },
  workspace: {
    get workspaceFolders() {
      return state.folders.map(folder);
    },
    get isTrusted() {
      return state.trusted;
    },
    getWorkspaceFolder: (uri) => state.folders.map(folder).find((f) => uri.fsPath.startsWith(f.uri.fsPath + path.sep)),
    getConfiguration: () => ({
      get: (k, d) => ({ 'agent.mode': state.mode, 'agent.command': process.execPath, 'agent.launch': 'direct' })[k] ?? d,
    }),
    findFiles: async (pattern) => walk(pattern.base.fsPath),
    fs: {
      stat: async (uri) => {
        const st = await fs.promises.stat(uri.fsPath);
        return { mtime: st.mtimeMs, size: st.size };
      },
    },
  },
};
const Module = require('node:module');
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};
const { sendWorkspaceToClaude } = require(build('agentCommands'));
const { MdReviewEditorProvider } = require(build('editorProvider'));
const context = { extensionUri: Uri.file(path.join(here, '..')) };

function review(dir, rel, status) {
  const md = path.join(dir, rel);
  fs.mkdirSync(path.dirname(md), { recursive: true });
  fs.writeFileSync(md, '# Doc\n');
  const c = { id: 'c1', author: 'Reviewer', createdAt: '2026-01-01T00:00:00Z', anchor: { quote: 'Doc', prefix: '', suffix: '', lineStart: 1, lineEnd: 1 }, body: 'Fix', status, replies: [] };
  fs.writeFileSync(md + '.comments.json', JSON.stringify({ schemaVersion: 1, file: path.basename(md), comments: [c] }));
  return md;
}
const one = mkroot('one');
const two = mkroot('two');
const three = mkroot('three');
review(one, 'a.md', 'submitted');
review(two, 'docs/b.md', 'submitted');
review(three, 'c.md', 'resolved'); // nothing waiting on Claude here
const promptOf = (t) => fs.readFileSync(promptFile(t), 'utf8');
const reset = () => {
  calls.terminals = [];
  calls.info = [];
  calls.warnings = [];
  calls.openWith = [];
};

test('Send All: one Claude per workspace folder with open reviews, each in its own folder', async () => {
  reset();
  state.folders = [one, two, three];
  await sendWorkspaceToClaude(context);
  assert.deepEqual(
    calls.terminals.map((t) => t.cwd),
    [one, two],
  );
  assert.match(promptOf(calls.terminals[0]), /- a\.md \(1 open\)/);
  assert.match(promptOf(calls.terminals[1]), /- docs\/b\.md \(1 open\)/);
  assert.deepEqual(calls.info, ['Sent the open reviews in one, two to Claude, each in its own terminal.']);
});

test('Send All with one folder, or nothing open', async () => {
  reset();
  state.folders = [two, three];
  await sendWorkspaceToClaude(context);
  assert.deepEqual(
    calls.terminals.map((t) => t.cwd),
    [two],
  );
  assert.match(calls.info[0], /^Sent to /);
  reset();
  state.folders = [three];
  await sendWorkspaceToClaude(context);
  assert.equal(calls.terminals.length, 0);
  assert.deepEqual(calls.info, ['No open review comments in three. Submit a review first.']);
});

test('Send All when prompts only go to the clipboard: one folder, picked', async () => {
  reset();
  state.folders = [one, two];
  state.mode = 'clipboard';
  state.pick = folder(two);
  await sendWorkspaceToClaude(context);
  assert.equal(calls.terminals.length, 0);
  assert.deepEqual(calls.info, ['Review prompt copied. Paste it into your agent.']);
  state.mode = 'terminal';
});

test('jumping to a thread whose file is gone says so and opens nothing', async () => {
  reset();
  await MdReviewEditorProvider.focusThread(Uri.file(path.join(one, 'gone.md')), 'c1');
  assert.deepEqual(calls.openWith, []);
  assert.match(calls.warnings[0], /^gone\.md no longer exists; its review threads are still in gone\.md\.comments\.json\.$/);
  assert.equal(MdReviewEditorProvider.pendingFocus.size, 0);
});

test('a jump whose editor fails to open leaves nothing queued', async () => {
  reset();
  const md = path.join(one, 'a.md');
  state.openWith = async () => {
    throw new Error('cannot open');
  };
  await assert.rejects(MdReviewEditorProvider.focusThread(Uri.file(md), 'c1'), /cannot open/);
  assert.deepEqual(calls.openWith, [md]);
  assert.equal(MdReviewEditorProvider.pendingFocus.size, 0);
  // Opened, but no MD Review panel took the thread (another editor won): nothing queued either.
  state.openWith = async () => {};
  await MdReviewEditorProvider.focusThread(Uri.file(md), 'c1');
  assert.equal(MdReviewEditorProvider.pendingFocus.size, 0);
});

after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
