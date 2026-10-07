// The review inbox's commands against a stand-in vscode API: Send All delivers
// each workspace folder's open reviews into the Claude session bound to that
// folder (stand-in sessions with real inbox sockets), and jumping to a thread
// in a file that won't open leaves nothing queued for a later panel.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
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
/** The commands and the editor provider in one bundle, so they share the provider's open panels. */
const buildCommands = () => {
  const outfile = path.join(here, 'tmp', 'inboxCommands.cjs');
  esbuild.buildSync({
    stdin: { contents: "export * from './agentCommands';\nexport { MdReviewEditorProvider } from './editorProvider';", resolveDir: path.join(here, '..', 'src'), loader: 'ts' },
    outfile, bundle: true, format: 'cjs', platform: 'node', external: ['vscode'], logLevel: 'silent',
  });
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
const state = { folders: [], trusted: true, pick: undefined, quickPick: undefined, openWith: async () => {} };
const calls = { terminals: [], info: [], warnings: [], errors: [], openWith: [], quickPicks: [] };

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
    showErrorMessage: async (m) => void calls.errors.push(m),
    showQuickPick: async (items, o) => {
      calls.quickPicks.push({ items, placeHolder: o?.placeHolder });
      return state.quickPick?.(items);
    },
    createTerminal: (o) => {
      calls.terminals.push(o);
      return { show() {}, state: {} };
    },
    onDidChangeTerminalShellIntegration: () => ({ dispose() {} }),
  },
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  commands: {
    executeCommand: async (id, ...args) => {
      if (id !== 'vscode.openWith') return;
      calls.openWith.push(args[0].fsPath);
      return state.openWith(...args);
    },
  },
  env: { clipboard: { writeText: async () => {} }, shell: '/bin/sh' },
  workspace: {
    get workspaceFolders() {
      return state.folders.map(folder);
    },
    get isTrusted() {
      return state.trusted;
    },
    textDocuments: [],
    getWorkspaceFolder: (uri) => state.folders.map(folder).find((f) => uri.fsPath.startsWith(f.uri.fsPath + path.sep)),
    getConfiguration: () => ({
      get: (k, d) => ({ 'agent.command': 'claude' })[k] ?? d,
      update: async () => {},
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
// Sessions are found under the home folder: a stand-in one, with stand-in Claude sessions in it.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-home-')));
made.push(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
const inboxes = [];
/** A running Claude session in `cwd`: a sessions file and an inbox socket that records what arrives. */
async function claudeSession(cwd, id, { hooked = false } = {}) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\mdr-test-${id}` : path.join(home, `${id.slice(-12)}.sock`);
  const got = [];
  // On Windows, Claude drops a connection whose first line isn't its token.
  const token = process.platform === 'win32' ? crypto.randomBytes(16).toString('hex') : undefined;
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => (buf += d));
    c.on('end', () => {
      const lines = buf.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (token && !(lines[0]?.type === 'auth' && lines[0].token === token)) return;
      lines.filter((m) => m.type !== 'auth').forEach((m) => got.push(m));
    });
  });
  await new Promise((r) => server.listen(sock, r));
  inboxes.push(server);
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  if (token) fs.writeFileSync(lib.inboxKeyFile(process.pid, sock, home), JSON.stringify({ peerToken: token }));
  // Our own pid: a process that is certainly alive. One file per session, so a fake pid suffix keeps them apart.
  fs.writeFileSync(path.join(dir, `${process.pid}${inboxes.length}.json`), JSON.stringify({ pid: process.pid, sessionId: id, cwd, kind: 'interactive', status: 'idle', messagingSocketPath: sock, name: `s-${id.slice(0, 4)}`, updatedAt: Date.now() }));
  if (hooked) {
    fs.mkdirSync(path.join(home, '.mdreview', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.mdreview', 'sessions', `claude-${id}.json`), '{}');
  }
  return got;
}
const arrived = async (got, n = 1) => {
  for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 20));
  return got.map((m) => m.message.content);
};
const bind = (dir, id) => context.workspaceState.update(`mdReview.agent.binding:${dir}`, { agent: 'claude', id });
const { sendWorkspaceToClaude, MdReviewEditorProvider } = require(buildCommands());
const lib = require('../dist/lib.cjs');
const storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-cmd-store-')));
made.push(storage);
/** Workspace state as VS Code keeps it: every value is serialized on write. */
const memento = () => {
  const data = new Map();
  return { get: (k) => (data.has(k) ? JSON.parse(data.get(k)) : undefined), update: (k, v) => (v === undefined ? data.delete(k) : data.set(k, JSON.stringify(v))), keys: () => [...data.keys()] };
};
const context = { extensionUri: Uri.file(path.join(here, '..')), storageUri: Uri.file(storage), workspaceState: memento() };
/** The store the extension keeps baselines in, as a second reader of the same state and folder. */
const baselineOf = (md) => new lib.BaselineStore(path.join(storage, 'baselines'), context.workspaceState).forFile(md);

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
const reset = () => {
  calls.terminals = [];
  calls.info = [];
  calls.warnings = [];
  calls.errors = [];
  calls.openWith = [];
  calls.quickPicks = [];
};
const inboxOne = await claudeSession(one, '11111111-0000-4000-8000-000000000001');
const inboxTwo = await claudeSession(two, '22222222-0000-4000-8000-000000000002');
bind(one, '11111111-0000-4000-8000-000000000001');
bind(two, '22222222-0000-4000-8000-000000000002');

test("Send All: each workspace folder's open reviews go into the session bound to it, and nothing starts", async () => {
  reset();
  state.folders = [one, two, three];
  await sendWorkspaceToClaude(context);
  assert.equal(calls.terminals.length, 0, 'no new process: the sessions are running');
  const [a] = await arrived(inboxOne);
  const [b] = await arrived(inboxTwo);
  assert.match(a, /^a\.md \(1 open\)$/m);
  assert.match(b, /^docs\/b\.md \(1 open\)$/m);
  assert.deepEqual(calls.info, ["Sent the open reviews in one, two, each to its folder's session."]);
  inboxOne.length = inboxTwo.length = 0;
});

test('Send All saves the copy the Changes view compares against, as Send in a panel does', async () => {
  reset();
  state.folders = [one, two, three];
  const a = path.join(one, 'a.md');
  const b = path.join(two, 'docs', 'b.md');
  // The first Send All saved them already; start from none.
  baselineOf(a).set(null);
  baselineOf(b).set(null);
  // b.md has unsaved edits in an editor: those are what Claude is sent, so they are the copy.
  vscode.workspace.textDocuments = [{ uri: Uri.file(b), isDirty: true, getText: () => '# Doc, unsaved\n' }];
  // a.md is open in a panel: its session saves the copy, so what it holds stays current.
  const posted = [];
  const mem = lib.memoryBaselines();
  const session = new lib.ReviewSession({
    mdPath: a, author: () => 'R', showResolved: () => true, post: (m) => posted.push(m), resolveImage: (x) => x,
    getText: () => fs.readFileSync(a, 'utf8'), isDirty: () => false, openLink: () => {}, baselines: mem,
  });
  session.handle({ type: 'ready' });
  const panel = {};
  MdReviewEditorProvider.panels.set(panel, { session, key: lib.nameKey(a, process.platform), ready: true });
  try {
    await sendWorkspaceToClaude(context);
    assert.equal((await arrived(inboxOne)).length + (await arrived(inboxTwo)).length, 2);
    assert.deepEqual(mem.get().threads, ['c1']);
    assert.equal(mem.read().toString(), '# Doc\n');
    assert.ok(posted.some((m) => m.type === 'baseline' && m.info), 'the panel was told');
    assert.equal(baselineOf(a).get(), undefined, 'the session saved it, not a second copy');
    const saved = baselineOf(b);
    assert.deepEqual(saved.get().threads, ['c1']);
    assert.deepEqual(saved.get().spans, { c1: [0, 1] });
    assert.equal(saved.read().toString(), '# Doc, unsaved\n');
    assert.equal(baselineOf(path.join(three, 'c.md')).get(), undefined, 'nothing sent from there');
    // Claude changes b.md; a second Send keeps the unreviewed copy, so its change stays in view.
    fs.writeFileSync(b, '# Doc, changed by Claude\n');
    vscode.workspace.textDocuments = [];
    await sendWorkspaceToClaude(context);
    assert.equal(saved.read().toString(), '# Doc, unsaved\n');
    await arrived(inboxOne, 2);
    await arrived(inboxTwo, 2);
  } finally {
    MdReviewEditorProvider.panels.delete(panel);
    vscode.workspace.textDocuments = [];
    fs.writeFileSync(b, '# Doc\n');
  }
});

test('Send All with one folder, or nothing open', async () => {
  inboxOne.length = inboxTwo.length = 0;
  reset();
  state.folders = [two, three];
  await sendWorkspaceToClaude(context);
  assert.equal((await arrived(inboxTwo)).length, 1);
  assert.match(calls.info[0], /^Sent to Claude · s-2222\./);
  reset();
  state.folders = [three];
  await sendWorkspaceToClaude(context);
  assert.deepEqual(calls.info, ['No open review comments in three. Submit a review first.']);
});

test('no session bound: the one started with MD Review\'s hook is taken; otherwise the user picks, and cancelling sends nothing', async () => {
  const four = mkroot('four');
  review(four, 'd.md', 'submitted');
  const hooked = await claudeSession(four, '44444444-0000-4000-8000-000000000004', { hooked: true });
  reset();
  state.folders = [four];
  await sendWorkspaceToClaude(context);
  assert.equal(calls.quickPicks.length, 0, 'no question asked');
  assert.match((await arrived(hooked))[0], /^d\.md \(1 open\)$/m);
  assert.equal(context.workspaceState.get(`mdReview.agent.binding:${four}`).id, '44444444-0000-4000-8000-000000000004');

  const five = mkroot('five');
  review(five, 'e.md', 'submitted');
  const a = await claudeSession(five, '55555555-0000-4000-8000-00000000000a');
  const b = await claudeSession(five, '55555555-0000-4000-8000-00000000000b');
  reset();
  state.folders = [five];
  state.quickPick = () => undefined; // cancelled
  await sendWorkspaceToClaude(context);
  assert.equal(calls.quickPicks.length, 1);
  assert.deepEqual(calls.quickPicks[0].items.filter((i) => i.detail).map((i) => i.detail).sort(), ['55555555-0000-4000-8000-00000000000a', '55555555-0000-4000-8000-00000000000b']);
  assert.deepEqual(calls.info, []);
  assert.equal(a.length + b.length, 0);
  // Picked: bound, and sent there.
  reset();
  state.quickPick = (items) => items.find((i) => i.detail === '55555555-0000-4000-8000-00000000000b');
  await sendWorkspaceToClaude(context);
  assert.match((await arrived(b))[0], /^e\.md \(1 open\)$/m);
  assert.equal(a.length, 0);
  state.quickPick = undefined;
});

test('a bound session that has stopped: an error, nothing sent, and no terminal', async () => {
  const six = mkroot('six');
  review(six, 'f.md', 'submitted');
  bind(six, '66666666-0000-4000-8000-000000000006'); // no such session running
  reset();
  state.folders = [six];
  await sendWorkspaceToClaude(context);
  assert.equal(calls.terminals.length, 0);
  assert.match(calls.errors[0] || '', /isn't running/);
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
  for (const s of inboxes) s.close();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
