// Agent sessions: finding running and past Claude Code and Codex sessions for a
// folder, delivering into a Claude session's inbox, Connect this folder (the
// extension and the CLI merge the same settings), the SessionStart hook, and
// the review session's binding, session menu and live delivery.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'cli', 'mdreview.mjs');
const made = [];
const mk = (name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `mdr-${name}-`)));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function claudeFile(home, n, s) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify({ kind: 'interactive', status: 'idle', updatedAt: Date.now(), ...s }));
}

test('running Claude sessions: only live ones, in this folder or below, and not headless runs', () => {
  const home = mk('home');
  const proj = mk('proj');
  fs.mkdirSync(path.join(proj, 'sub'));
  claudeFile(home, 1, { pid: process.pid, sessionId: 'a', cwd: proj, messagingSocketPath: '/s/a', name: 'Alpha' });
  claudeFile(home, 2, { pid: process.pid, sessionId: 'b', cwd: path.join(proj, 'sub'), status: 'busy' });
  claudeFile(home, 3, { pid: process.pid, sessionId: 'c', cwd: home }); // another folder
  claudeFile(home, 4, { pid: 2 ** 22 + 12345, sessionId: 'd', cwd: proj }); // no such process
  claudeFile(home, 5, { pid: process.pid, sessionId: 'e', cwd: proj, kind: 'sdk-cli' });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', '6.json'), 'not json');
  const got = lib.liveClaudeSessions(proj, home);
  assert.deepEqual(got.map((s) => s.id).sort(), ['a', 'b']);
  const a = got.find((s) => s.id === 'a');
  assert.equal(a.socket, '/s/a');
  assert.equal(a.name, 'Alpha');
  assert.equal(got.find((s) => s.id === 'b').status, 'busy');
  // A session the hook registered is marked.
  fs.mkdirSync(path.join(home, '.mdreview', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.mdreview', 'sessions', 'claude-a.json'), '{}');
  assert.equal(lib.liveClaudeSessions(proj, home).find((s) => s.id === 'a').connected, true);
});

test('a folder reached through a link matches the session that names its real path', { skip: process.platform === 'win32' }, () => {
  const home = mk('home');
  const real = mk('real');
  const link = path.join(mk('links'), 'here');
  fs.symlinkSync(real, link);
  claudeFile(home, 1, { pid: process.pid, sessionId: 'a', cwd: real });
  assert.equal(lib.liveClaudeSessions(link, home).length, 1);
});

test('past Claude sessions are titled from their transcript', () => {
  const home = mk('home');
  const proj = mk('proj');
  const dir = lib.claudeProjectDir(proj, home);
  fs.mkdirSync(dir, { recursive: true });
  const id = '0f0f0f0f-1111-4222-8333-444444444444';
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [JSON.stringify({ type: 'user', message: { content: 'fix the abstract please' } }), JSON.stringify({ type: 'ai-title', aiTitle: 'Tighten "abstract"', sessionId: id })].join('\n'));
  const untitled = '1f1f1f1f-1111-4222-8333-444444444444';
  fs.writeFileSync(path.join(dir, `${untitled}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'hello\nthere' } }));
  const got = lib.pastClaudeSessions(proj, home);
  assert.equal(got.find((s) => s.id === id).name, 'Tighten "abstract"');
  assert.equal(got.find((s) => s.id === untitled).name, 'hello there');
  assert.ok(got.every((s) => !s.live));
});

test('Codex sessions come from rollout files whose first line is too long to read whole', () => {
  const home = mk('home');
  const proj = mk('proj');
  const now = new Date();
  const day = path.join(home, '.codex', 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const id = '01a0e298-171b-7e93-af02-a3074d24d1a3';
  const meta = { timestamp: now.toISOString(), type: 'session_meta', payload: { session_id: id, id, timestamp: now.toISOString(), cwd: proj, base_instructions: { text: 'x'.repeat(40000) } } };
  fs.writeFileSync(path.join(day, `rollout-a-${id}.jsonl`), JSON.stringify(meta) + '\n{}\n');
  const other = { ...meta, payload: { ...meta.payload, id: '01a0e298-0000-7e93-af02-a3074d24d1a3', cwd: home } };
  fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), JSON.stringify(other) + '\n');
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'), JSON.stringify({ id, thread_name: 'Fix intro' }) + '\n');
  const got = lib.codexSessions(proj, home);
  assert.deepEqual(got.map((s) => [s.id, s.name, s.live]), [[id, 'Fix intro', true]]);
  assert.deepEqual(lib.codexSessions(proj, home, { sinceMs: Date.now() + 60000 }), []);
  assert.equal(lib.codexMeta('{"type":"session_meta","payload":{"id":"' + id + '","cwd":"C:\\\\x\\\\y","instructions":"…').cwd, 'C:\\x\\y');
});

test('WSL paths as Windows names them: drives under /mnt, the rest through \\\\wsl.localhost', () => {
  assert.equal(lib.wslToWindows('Ubuntu', '/mnt/c/Users/me/Proj'), 'C:\\Users\\me\\Proj');
  assert.equal(lib.wslToWindows('Ubuntu', '/mnt/d'), 'D:\\');
  assert.equal(lib.wslToWindows('Ubuntu', '/home/me/proj'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj');
  assert.equal(lib.wslUnc('Debian', '/proc/12/stat'), '\\\\wsl.localhost\\Debian\\proc\\12\\stat');
});

test('the SessionStart hook outside WSL writes one plain registration', () => {
  const home = mk('home');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.WSL_DISTRO_NAME;
  spawnSync(process.execPath, [cli, 'hook', 'session-start', '--agent', 'claude'], { input: JSON.stringify({ session_id: 'plain-0001', cwd: home }), env });
  const r = JSON.parse(fs.readFileSync(path.join(home, '.mdreview', 'sessions', 'claude-plain-0001.json'), 'utf8'));
  assert.equal(r.host, undefined);
  assert.equal(r.cwd, home);
});

/** An inbox that records each line it gets: a named pipe on Windows, a socket elsewhere. */
async function inbox() {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\mdr-agents-${process.pid}-${Math.random().toString(16).slice(2)}` : path.join(mk('sock'), 'in.sock');
  const lines = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => (buf += d));
    c.on('end', () => lines.push(...buf.split('\n').filter(Boolean)));
  });
  await new Promise((r) => server.listen(sock, r));
  return { sock, lines, server };
}

test('the inbox route follows the OS: an auth line on Windows, none on macOS or Linux', async () => {
  assert.equal(lib.inboxRoute('win32'), 'windows');
  assert.equal(lib.inboxRoute('darwin'), 'unix');
  assert.equal(lib.inboxRoute('linux'), 'unix');
  const home = mk('home');
  const proj = mk('proj');
  const { sock, lines, server } = await inbox();
  claudeFile(home, 1, { pid: process.pid, sessionId: 'w', cwd: proj, messagingSocketPath: sock });
  const b = { agent: 'claude', id: 'w' };
  const settle = async (n) => {
    for (let i = 0; i < 50 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  };
  // No key file: an error, not a message the session would drop without a word.
  await assert.rejects(lib.deliver(b, 'hi', { folder: proj, home, platform: 'win32' }), /inbox key/);
  // Claude names the key after the lowercased pipe path.
  const token = 'ab'.repeat(16);
  const key = lib.inboxKeyFile(process.pid, sock, home);
  assert.equal(path.basename(key), `${process.pid}.${crypto.createHash('sha256').update(sock.toLowerCase()).digest('hex')}.key`);
  fs.writeFileSync(key, JSON.stringify({ peerToken: token, pidDomain: 'x' }));
  await lib.deliver(b, 'hi', { folder: proj, home, platform: 'win32' });
  await settle(2);
  assert.deepEqual(JSON.parse(lines[0]), { type: 'auth', token });
  assert.equal(JSON.parse(lines[1]).message.content, 'hi');
  await lib.deliver(b, 'again', { folder: proj, home, platform: 'darwin' });
  await settle(3);
  server.close();
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[2]).message.content, 'again');
  // A key under another name for the same process still works; a malformed one doesn't count.
  fs.renameSync(key, path.join(path.dirname(key), `${process.pid}.${'0'.repeat(64)}.key`));
  assert.equal(lib.inboxToken(process.pid, sock, home), token);
  fs.writeFileSync(path.join(path.dirname(key), `${process.pid}.${'0'.repeat(64)}.key`), JSON.stringify({ peerToken: 'nope' }));
  assert.equal(lib.inboxToken(process.pid, sock, home), undefined);
});

test("delivery writes one JSON line into the session's inbox", async () => {
  const { sock, lines, server } = await inbox();
  await lib.deliverClaude(sock, 'Please address c_1');
  await lib.deliverClaude(sock, 'Please address c_1');
  for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  server.close();
  const [a, b] = lines.map((l) => JSON.parse(l));
  assert.equal(a.type, 'user');
  assert.equal(a.message.content, 'Please address c_1');
  assert.equal(a.from, 'md-review');
  assert.notEqual(a.msg_id, b.msg_id, 'a repeat is not dropped as a duplicate');
  await assert.rejects(lib.deliverClaude(process.platform === 'win32' ? `${sock}-gone` : path.join(path.dirname(sock), 'gone.sock'), 'x'), /Couldn't reach the Claude session/);
});

test('Connect merges into the settings and keeps what is there; running it again changes nothing', () => {
  const s0 = { model: 'opus', permissions: { allow: ['Bash(ls:*)'], deny: ['Read(.env)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  const { settings, changes } = lib.mergeSettings(s0);
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions.deny, ['Read(.env)', ...lib.EDIT_DENY]);
  assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)', lib.CLI_RULE, lib.EDIT_RULE]);
  assert.equal(settings.hooks.SessionStart.length, 2);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'echo mine');
  assert.match(settings.hooks.SessionStart[1].hooks[0].command, /mdreview\.mjs" hook session-start --agent claude$/);
  assert.equal(settings.crossSessionInbound, undefined, 'only when asked');
  assert.deepEqual(changes, ['SessionStart hook', 'SessionEnd hook', 'permission to run the MD Review CLI', 'permission to edit Markdown files (not CLAUDE.md, AGENTS.md or .claude/)']);
  assert.deepEqual(lib.mergeSettings(settings).changes, []);
  assert.deepEqual(lib.mergeSettings(settings, true).changes, ['crossSessionInbound: accept']);
  assert.deepEqual(s0.permissions.allow, ['Bash(ls:*)'], 'the input is left alone');
});

test("the CLI's init-claude writes the same settings as the extension, and refuses a settings file it can't read", () => {
  const a = mk('a');
  const b = mk('b');
  for (const d of [a, b]) {
    fs.mkdirSync(path.join(d, '.claude'));
    fs.writeFileSync(path.join(d, '.claude', 'settings.local.json'), JSON.stringify({ env: { X: '1' } }));
  }
  lib.connectFolder(a, { cliDir: path.dirname(cli), acceptInbound: true });
  const r = spawnSync(process.execPath, [cli, 'init-claude', b, '--accept-inbound'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const read = (d) => fs.readFileSync(path.join(d, '.claude', 'settings.local.json'), 'utf8');
  assert.equal(read(b), read(a));
  assert.ok(fs.existsSync(path.join(b, '.claude', 'skills', 'md-review', 'mdreview.mjs')));
  assert.equal(lib.hooksInstalled(a), true);
  const c = mk('c');
  fs.mkdirSync(path.join(c, '.claude'));
  fs.writeFileSync(path.join(c, '.claude', 'settings.local.json'), '{ broken');
  assert.notEqual(spawnSync(process.execPath, [cli, 'init-claude', c], { encoding: 'utf8' }).status, 0);
  assert.equal(fs.readFileSync(path.join(c, '.claude', 'settings.local.json'), 'utf8'), '{ broken');
  assert.throws(() => lib.connectFolder(c, { cliDir: path.dirname(cli) }));
});

test('the SessionStart hook registers the session and tells it how comments arrive; SessionEnd forgets it', () => {
  const home = mk('home');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const start = spawnSync(process.execPath, [cli, 'hook', 'session-start', '--agent', 'claude'], { input: JSON.stringify({ session_id: 'abc12345-x', cwd: '/w', source: 'startup' }), env, encoding: 'utf8' });
  assert.equal(start.status, 0);
  const out = JSON.parse(start.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /MD Review is connected/);
  const file = path.join(home, '.mdreview', 'sessions', 'claude-abc12345-x.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cwd, '/w');
  // A session id that could name a path is ignored; the hook still succeeds.
  const odd = spawnSync(process.execPath, [cli, 'hook', 'session-start'], { input: JSON.stringify({ session_id: '../../x' }), env, encoding: 'utf8' });
  assert.equal(odd.status, 0);
  assert.deepEqual(fs.readdirSync(path.join(home, '.mdreview', 'sessions')), ['claude-abc12345-x.json']);
  spawnSync(process.execPath, [cli, 'hook', 'session-end'], { input: JSON.stringify({ session_id: 'abc12345-x' }), env });
  assert.equal(fs.existsSync(file), false);
});

// The review session with an agent host: a fake one that records what's delivered.
function session({ sessions = [], delivery = 'onSend', bound } = {}) {
  const dir = mk('doc');
  const md = path.join(dir, 'paper.md');
  fs.writeFileSync(md, '# Paper\n\nRiders trust docks.\n\nBikes are shared.\n');
  const posted = [];
  const sent = [];
  const timers = [];
  let binding = bound;
  const agents = {
    list: () => sessions,
    binding: () => binding,
    bind: (b) => (binding = b),
    state: (b) => sessions.find((s) => s.id === b.id),
    start: async (agent) => ({ agent, id: 'new-1', name: 'New' }),
    delivery: () => delivery,
    setDelivery: (d) => (delivery = d),
    connected: () => false,
  };
  const s = new lib.ReviewSession({
    mdPath: md, author: () => 'R', showResolved: () => true, post: (m) => posted.push(m), resolveImage: (x) => x,
    getText: () => fs.readFileSync(md, 'utf8'), isDirty: () => false, openLink: () => {},
    agents, runAgent: (p) => (sent.push(p), 'Sent.'), schedule: (fn) => timers.push(fn),
  });
  s.handle({ type: 'ready' });
  const anchor = (quote, line) => ({ quote, prefix: '', suffix: '', lineStart: line, lineEnd: line });
  const flush = () => timers.splice(0).forEach((f) => f());
  return { s, posted, sent, anchor, flush, md, get binding() { return binding; } };
}
const lastAgent = (posted) => posted.filter((m) => m.type === 'agent').at(-1)?.agent;

test('Send with no session bound opens the session menu, and sends once one is picked', () => {
  const t = session({ sessions: [{ agent: 'claude', id: 's1', live: true, updatedAt: 1 }, { agent: 'codex', id: 's2', live: true, updatedAt: 1 }] });
  t.s.handle({ type: 'addComment', anchor: t.anchor('Riders trust docks.', 3), body: 'Cite this.' });
  t.s.handle({ type: 'sendToAgent' });
  assert.equal(t.sent.length, 0);
  assert.equal(lastAgent(t.posted).ask, true);
  const c = lib.store.readSidecar(t.md).comments[0];
  assert.equal(c.status, 'draft', 'nothing submitted until there is somewhere to send it');
  t.s.handle({ type: 'bindSession', agent: 'codex', id: 's2' });
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0], /Cite this\./);
  assert.equal(lastAgent(t.posted).bound.id, 's2');
  assert.equal(lib.store.readSidecar(t.md).comments[0].status, 'submitted');
});

test('with one running session started with the hook, Send goes there without asking', () => {
  const t = session({ sessions: [{ agent: 'claude', id: 'h', live: true, connected: true, updatedAt: 1 }, { agent: 'claude', id: 'x', live: true, updatedAt: 1 }] });
  t.s.handle({ type: 'addComment', anchor: t.anchor('Riders trust docks.', 3), body: 'Cite this.' });
  t.s.handle({ type: 'sendToAgent' });
  assert.equal(t.binding.id, 'h');
  assert.equal(t.sent.length, 1);
});

test('live: comments saved together go as one message; praise stays a draft; a reply on an open thread goes back', () => {
  const t = session({ bound: { agent: 'claude', id: 's1' }, delivery: 'live', sessions: [{ agent: 'claude', id: 's1', live: true, updatedAt: 1 }] });
  t.s.handle({ type: 'addComment', anchor: t.anchor('Riders trust docks.', 3), body: 'One.' });
  t.s.handle({ type: 'addComment', anchor: t.anchor('Bikes are shared.', 5), body: 'Two.' });
  t.s.handle({ type: 'addComment', anchor: t.anchor('Bikes are shared.', 5), body: 'Nice.', meta: { kind: 'praise' } });
  assert.equal(t.sent.length, 0, 'waits a moment for more');
  t.flush();
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0], /One\./);
  assert.match(t.sent[0], /Two\./);
  assert.doesNotMatch(t.sent[0], /Nice\./);
  const cs = lib.store.readSidecar(t.md).comments;
  assert.deepEqual(cs.map((c) => c.status), ['submitted', 'submitted', 'draft']);
  // The agent asks back; the reviewer's answer goes straight to it.
  lib.store.mutate(t.md, (d) => lib.store.addReply(d, cs[0].id, 'Claude', 'Which source?'));
  t.s.handle({ type: 'reply', id: cs[0].id, body: 'Rivera 2021.' });
  t.flush();
  assert.equal(t.sent.length, 2);
  assert.match(t.sent[1], /Rivera 2021\./);
  // On Send (the default), nothing goes until Send.
  t.s.handle({ type: 'setDelivery', delivery: 'onSend' });
  t.s.handle({ type: 'addComment', anchor: t.anchor('Riders trust docks.', 3), body: 'Three.' });
  t.flush();
  assert.equal(t.sent.length, 2);
});

test('the session menu lists sessions on request; starting one binds it', async () => {
  const t = session({ sessions: [{ agent: 'claude', id: 's1', live: true, updatedAt: 1 }] });
  t.s.handle({ type: 'listSessions' });
  assert.deepEqual(lastAgent(t.posted).sessions.map((s) => s.id), ['s1']);
  t.s.handle({ type: 'startSession', agent: 'claude' });
  assert.equal(lastAgent(t.posted).starting, 'Starting Claude…');
  await new Promise((r) => setImmediate(r));
  assert.equal(t.binding.id, 'new-1');
  assert.equal(lastAgent(t.posted).starting, undefined);
  t.s.handle({ type: 'unbindSession' });
  assert.equal(t.binding, undefined);
});

test('a delivery that fails says why and starts no round', async () => {
  const t = session({ bound: { agent: 'claude', id: 's1' } });
  t.s.handle({ type: 'addComment', anchor: t.anchor('Riders trust docks.', 3), body: 'One.' });
  // eslint-disable-next-line no-unused-vars
  const s = new lib.ReviewSession({
    mdPath: t.md, author: () => 'R', showResolved: () => true, post: (m) => t.posted.push(m), resolveImage: (x) => x,
    getText: () => fs.readFileSync(t.md, 'utf8'), isDirty: () => false, openLink: () => {},
    agents: { list: () => [], binding: () => ({ agent: 'claude', id: 's1' }), bind() {}, state: () => undefined, start: async () => null, delivery: () => 'onSend', setDelivery() {} },
    runAgent: async () => {
      throw new Error("That Claude session isn't running.");
    },
  });
  s.handle({ type: 'sendToAgent' });
  await new Promise((r) => setImmediate(r));
  assert.match(t.posted.filter((m) => m.type === 'error').at(-1).message, /isn't running/);
  assert.equal(t.posted.filter((m) => m.type === 'round' && m.round).length, 0);
});

// Speed: the prompt carries the source lines and one `apply` command does the work.
test('the prompt names the file absolutely, shows each quote\'s source lines, and asks for one apply command', () => {
  const src = '# T\n\nPlain **bold words** here.\n\nOther line.\n';
  const c = (id, quote, line, body, extra = {}) => ({ id, anchor: { quote, prefix: '', suffix: '', lineStart: line, lineEnd: line }, body, status: 'submitted', replies: [], ...extra });
  const p = lib.buildAgentPrompt({ mdPath: '/w/d/a.md', cwd: '/w', cliPath: '/w/.claude/skills/md-review/mdreview.mjs', source: src, comments: [c('c_1', 'bold words here', 3, 'Fix.'), c('c_2', 'Other line.', 1, 'Why?', { kind: 'question' })] });
  assert.match(p, /^MD Review: 2 comments on d\/a\.md \(\/w\/d\/a\.md\)\.$/m);
  assert.match(p, /run in \/w exactly as written:\n {2}node \.claude\/skills\/md-review\/mdreview\.mjs apply "d\/a\.md" <actions>/);
  assert.match(p, /^ {4}3 \| Plain \*\*bold words\*\* here\.$/m, 'found through the markup');
  assert.match(p, /^ {4}5 \| Other line\.$/m, 'a stale line hint still finds the line');
  assert.match(p, /\[question\]: answer with reply/);
  assert.doesNotMatch(p, /\[praise\]|major before minor|whole section/, 'rules only for what the comments use');
  // Suggest mode keeps the full prompt.
  assert.match(lib.buildAgentPrompt({ mdPath: '/w/a.md', cwd: '/w', cliPath: '/x/m.mjs', source: src, comments: [c('c_1', 'Other line.', 5, 'x')], suggest: true }), /suggest "a\.md"/);
  assert.deepEqual(lib.quoteLines(src, { anchor: { quote: 'not in the file', lineStart: 1, lineEnd: 1 } }), []);
});

test('fix and apply: byte-exact edits, one write, nothing written when any part fails', () => {
  const dir = mk('apply');
  const md = path.join(dir, 'p.md');
  const orig = '﻿# T\r\n\r\nThe same words. And more.\r\n\r\nThe same words. Twice.\r\n';
  fs.writeFileSync(md, orig);
  lib.store.mutate(md, (d) => {
    for (const [q, l] of [['And more.', 3], ['Twice.', 5], ['T', 1]]) lib.store.addComment(d, 'R', { quote: q, prefix: '', suffix: '', lineStart: l, lineEnd: l }, 'x').status = 'submitted';
  });
  const [a, b, h] = lib.store.readSidecar(md).comments.map((c) => c.id);
  const cli1 = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  // Ambiguous text and a missing one: refused, and nothing changes.
  let r = cli1('apply', md, 'fix', a, 'The same words.', 'Same words.', 'n', 'fix', b, 'missing', 'x', 'n');
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(md, 'utf8'), orig);
  assert.ok(lib.store.readSidecar(md).comments.every((c) => c.status === 'submitted' && !c.replies.length));
  // Twice in the file, but once on the comment's line: that one. Line endings and BOM kept.
  r = cli1('apply', md, 'fix', b, 'The same words. Twice.', 'The same words, twice.', 'Joined.', 'reply', h, 'Kept the title.', 'resolve', a, 'Nothing to do.');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(md, 'utf8'), orig.replace('The same words. Twice.', 'The same words, twice.'));
  const cs = lib.store.readSidecar(md).comments;
  assert.deepEqual(cs.map((c) => [c.status, c.replies.at(-1)?.body]), [['resolved', 'Nothing to do.'], ['resolved', 'Joined.'], ['submitted', 'Kept the title.']]);
  // fix alone, with the default note; a new line written as \n becomes \r\n here.
  r = cli1('fix', md, h, '# T', '# Title\nline');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(md, 'utf8').startsWith('﻿# Title\r\nline\r\n'));
  assert.equal(lib.store.readSidecar(md).comments[2].replies.at(-1).body, 'Changed "# T" to "# Title line".');
  assert.notEqual(cli1('apply', md, 'fix', a).status, 0, 'too few arguments');
  assert.notEqual(cli1('apply', md, 'resolve', 'c_nope', 'x').status, 0, 'unknown id');
});

test("a folder's older copy of the CLI isn't put in the prompt; the user is told once to connect again", () => {
  const dir = mk('stale');
  const md = path.join(dir, 'a.md');
  fs.writeFileSync(md, 'Alpha beta.\n');
  const skill = path.join(dir, '.claude', 'skills', 'md-review');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'mdreview.mjs'), '// an older CLI\n');
  const posted = [];
  const sent = [];
  const s = new lib.ReviewSession({
    mdPath: md, author: () => 'R', showResolved: () => true, post: (m) => posted.push(m), resolveImage: (x) => x,
    getText: () => fs.readFileSync(md, 'utf8'), isDirty: () => false, openLink: () => {}, agentCwd: () => dir, cliPath: cli,
    runAgent: (p) => (sent.push(p), ''),
  });
  s.handle({ type: 'ready' });
  const anchor = { quote: 'beta', prefix: '', suffix: '', lineStart: 1, lineEnd: 1 };
  s.handle({ type: 'addComment', anchor, body: 'One.' });
  s.handle({ type: 'sendToAgent' });
  s.handle({ type: 'addComment', anchor, body: 'Two.' });
  s.handle({ type: 'sendToAgent' });
  assert.ok(sent[0].includes(`node "${cli}" apply`), 'the extension\'s own CLI');
  assert.equal(posted.filter((m) => m.type === 'toast' && /older than the extension/.test(m.message)).length, 1);
  // Connected again: the same bytes, so the folder's copy (a bare relative path the permission rule matches).
  fs.copyFileSync(cli, path.join(skill, 'mdreview.mjs'));
  s.handle({ type: 'addComment', anchor, body: 'Three.' });
  s.handle({ type: 'sendToAgent' });
  assert.ok(sent.at(-1).includes('node .claude/skills/md-review/mdreview.mjs apply "a.md"'));
});
