// Agent sessions MD Review can talk to: running Claude Code and Codex sessions
// in a folder, the past ones that can be resumed, and delivery of a message
// into one of them. No vscode dependency, so the harness uses it too.
//
// Claude Code: every running session writes ~/.claude/sessions/<pid>.json with
// its id, folder, status and an inbox socket; a JSON line posted there starts
// a turn when the session is idle and is read between tool calls when busy.
// How the inbox is reached depends on the OS (see inboxRoute): a Unix socket on
// macOS and Linux; on Windows a named pipe that first wants an auth line with
// the token from the session's key file, ~/.claude/sessions/<pid>.<hash>.key.
// Codex: `codex queue --thread <id> --message <text>` hands the message to the
// shared app-server, which runs it at once in an idle session or after the
// current turn.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';

export type AgentKind = 'claude' | 'codex';

export interface AgentSession {
  agent: AgentKind;
  id: string;
  /** The session's name or title, when it has one. */
  name?: string;
  cwd: string;
  /** Running now. Claude: its process is alive. Codex: seen active in the last few minutes. */
  live: boolean;
  /** 'idle' | 'busy' when the agent reports it (Claude). */
  status?: string;
  /** Last activity, ms since the epoch. */
  updatedAt: number;
  /** Claude: the inbox socket to post into. */
  socket?: string;
  /** Claude: the session's process, which names its inbox key on Windows. */
  pid?: number;
  /** Registered by MD Review's SessionStart hook. */
  connected?: boolean;
  /** Claude: the session runs in WSL, seen from Windows. */
  wsl?: WslHome;
}

/** The session a document's messages go to. */
export interface Binding {
  agent: AgentKind;
  id: string;
  name?: string;
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** `child` is `dir` or inside it (after resolving links, so /tmp and /private/tmp agree). */
export function within(dir: string, child: string): boolean {
  const a = real(dir);
  const b = real(child);
  const r = path.relative(a, b);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Where MD Review's SessionStart hook registers sessions. */
export function registryDir(home = os.homedir()): string {
  return path.join(home, '.mdreview', 'sessions');
}

function registered(home: string): Set<string> {
  try {
    return new Set(fs.readdirSync(registryDir(home)).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));
  } catch {
    return new Set();
  }
}

/** Running Claude Code sessions whose folder is `folder` or inside it, here and in WSL. */
export function liveClaudeSessions(folder: string, home = os.homedir(), platform: NodeJS.Platform = process.platform): AgentSession[] {
  const reg = registered(home);
  const out = claudeSessionsIn(path.join(home, '.claude', 'sessions'), folder, reg, { alive: (s) => alive(s.pid), cwd: (c) => c });
  if (platform === 'win32') for (const w of wslHomes(folder, home)) out.push(...wslClaudeSessions(folder, w, reg));
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function claudeSessionsIn(dir: string, folder: string, reg: Set<string>, o: { alive(s: any): boolean; cwd(c: string): string; wsl?: WslHome }): AgentSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: AgentSession[] = [];
  for (const n of names) {
    const s = readJson(path.join(dir, n));
    if (!s || typeof s.sessionId !== 'string' || typeof s.cwd !== 'string') continue;
    if (s.kind && s.kind !== 'interactive') continue; // headless -p runs and SDK children
    const cwd = o.cwd(s.cwd);
    if (!o.alive(s) || !within(folder, cwd)) continue;
    out.push({
      agent: 'claude',
      id: s.sessionId,
      name: typeof s.name === 'string' && s.name ? s.name : undefined,
      cwd,
      live: true,
      status: typeof s.status === 'string' ? s.status : undefined,
      updatedAt: Number(s.updatedAt) || 0,
      socket: typeof s.messagingSocketPath === 'string' ? s.messagingSocketPath : undefined,
      pid: s.pid,
      connected: reg.has(`claude-${s.sessionId}`),
      wsl: o.wsl,
    });
  }
  return out;
}

/**
 * A WSL install MD Review has seen a session from. Its hook registers WSL
 * sessions in the Windows home (see the CLI's wslHost) with these fields;
 * Windows reads the session files through \\wsl.localhost, but the inbox
 * socket lives inside the Linux VM, so delivery runs `node` there.
 */
export interface WslHome {
  distro: string;
  /** The Linux home, e.g. /home/mustafa. */
  home: string;
  /** A node inside WSL, for the relay. */
  node: string;
}

/** The Linux side of the \\wsl.localhost share: `/home/x` → `\\wsl.localhost\Ubuntu\home\x`. */
export function wslUnc(distro: string, p: string): string {
  return `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`;
}

/** A WSL path as Windows names it: /mnt/c/x → C:\x, anything else through the share. */
export function wslToWindows(distro: string, p: string): string {
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}` : wslUnc(distro, p);
}

/** WSL installs with a registered session in `folder`, one each. */
function wslHomes(folder: string, home: string): WslHome[] {
  let names: string[];
  try {
    names = fs.readdirSync(registryDir(home)).filter((n) => n.startsWith('claude-') && n.endsWith('.json'));
  } catch {
    return [];
  }
  const seen = new Map<string, WslHome>();
  for (const n of names) {
    const r = readJson(path.join(registryDir(home), n));
    if (r?.host !== 'wsl' || typeof r.cwd !== 'string' || !within(folder, r.cwd)) continue;
    if (![r.distro, r.home, r.node].every((x) => typeof x === 'string' && x)) continue;
    if (!/^[\w.-]+$/.test(r.distro) || !r.home.startsWith('/')) continue;
    seen.set(`${r.distro}\0${r.home}`, { distro: r.distro, home: r.home, node: r.node });
  }
  return [...seen.values()];
}

/** A WSL process is alive when /proc still has it, started when the session file says. */
function wslAlive(distro: string, s: any): boolean {
  if (typeof s.pid !== 'number' || s.pid <= 0) return false;
  try {
    const stat = fs.readFileSync(wslUnc(distro, `/proc/${s.pid}/stat`), 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return s.procStart === undefined || String(s.procStart) === start;
  } catch {
    return false;
  }
}

function wslClaudeSessions(folder: string, w: WslHome, reg: Set<string>): AgentSession[] {
  return claudeSessionsIn(wslUnc(w.distro, `${w.home}/.claude/sessions`), folder, reg, { alive: (s) => wslAlive(w.distro, s), cwd: (c) => wslToWindows(w.distro, c), wsl: w });
}

/** How Claude Code names a project folder under ~/.claude/projects. */
export function claudeProjectDir(folder: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'));
}

/** The title of a Claude transcript: its last ai-title, or the start of its first prompt. Reads the ends only. */
function claudeTitle(file: string, size: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const len = Math.min(size, 256 * 1024);
    const tail = Buffer.alloc(len);
    fs.readSync(fd, tail, 0, len, size - len);
    const titles = [...tail.toString('utf8').matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)];
    if (titles.length) return JSON.parse(`"${titles[titles.length - 1][1]}"`);
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    fs.readSync(fd, head, 0, head.length, 0);
    for (const line of head.toString('utf8').split('\n')) {
      try {
        const r = JSON.parse(line);
        if (r.type === 'user' && typeof r.message?.content === 'string') return r.message.content.replace(/\s+/g, ' ').slice(0, 80);
      } catch {}
    }
  } catch {
    // unreadable: no title
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

/** Past Claude sessions started in `folder`, newest first. */
export function pastClaudeSessions(folder: string, home = os.homedir(), limit = 8): AgentSession[] {
  const dir = claudeProjectDir(real(folder), home);
  let files: { f: string; mtime: number; size: number }[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n))
      .map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return { f: path.join(dir, n), mtime: st.mtimeMs, size: st.size };
      });
  } catch {
    return [];
  }
  return files
    .filter((x) => x.size > 0)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => ({ agent: 'claude' as const, id: path.basename(x.f, '.jsonl'), name: claudeTitle(x.f, x.size), cwd: folder, live: false, updatedAt: x.mtime }));
}

function firstLine(file: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const s = buf.subarray(0, n).toString('utf8');
    const nl = s.indexOf('\n');
    return nl < 0 ? s : s.slice(0, nl);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * id, cwd and timestamp from a rollout's session_meta line. The line carries
 * the whole base instructions and can be far longer than what's read, so the
 * fields are picked from its start rather than parsed.
 */
export function codexMeta(head: string): { id: string; cwd: string; timestamp: string } | undefined {
  try {
    const m = JSON.parse(head)?.payload;
    if (m?.id && typeof m.cwd === 'string') return { id: m.id, cwd: m.cwd, timestamp: m.timestamp };
  } catch {}
  if (!head.includes('"session_meta"')) return undefined;
  const field = (k: string) => {
    const m = head.match(new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) return undefined;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return undefined;
    }
  };
  const p = head.indexOf('"payload"');
  const rest = p < 0 ? head : head.slice(p);
  const id = (rest.match(/"id":"([0-9a-f-]{36})"/) || [])[1];
  const cwd = field('cwd');
  const timestamp = (rest.match(/"timestamp":"([^"]+)"/) || [])[1] ?? '';
  return id && cwd ? { id, cwd, timestamp } : undefined;
}

function codexNames(home: string): Map<string, string> {
  const names = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(path.join(home, '.codex', 'session_index.jsonl'), 'utf8').split('\n')) {
      try {
        const r = JSON.parse(line);
        if (r.id && r.thread_name) names.set(r.id, r.thread_name);
      } catch {}
    }
  } catch {}
  return names;
}

const LIVE_MS = 10 * 60 * 1000;

/**
 * Codex sessions started in `folder` over the last `days` days, newest first,
 * from their rollout files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 * `sinceMs`: only ones created after it (to find a session just started).
 */
export function codexSessions(folder: string, home = os.homedir(), opts: { days?: number; sinceMs?: number; now?: number; limit?: number } = {}): AgentSession[] {
  const now = opts.now ?? Date.now();
  const root = path.join(home, '.codex', 'sessions');
  const reg = registered(home);
  const names = codexNames(home);
  const out: AgentSession[] = [];
  for (let d = 0; d < (opts.days ?? 7); d++) {
    const t = new Date(now - d * 86400000);
    const dir = path.join(root, String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0'));
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const n of files) {
      const f = path.join(dir, n);
      const meta = codexMeta(firstLine(f));
      if (!meta?.id || typeof meta.cwd !== 'string' || !within(folder, meta.cwd)) continue;
      const created = Date.parse(meta.timestamp) || 0;
      if (opts.sinceMs && created < opts.sinceMs) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(f).mtimeMs;
      } catch {}
      if (out.some((s) => s.id === meta.id)) continue;
      out.push({ agent: 'codex', id: meta.id, name: names.get(meta.id), cwd: meta.cwd, live: now - mtime < LIVE_MS, updatedAt: mtime, connected: reg.has(`codex-${meta.id}`) });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, opts.limit ?? 12);
}

/** Everything the session menu lists for `folder`. */
export function listSessions(folder: string, home = os.homedir()): AgentSession[] {
  const live = liveClaudeSessions(folder, home);
  const liveIds = new Set(live.map((s) => s.id));
  return [...live, ...pastClaudeSessions(folder, home).filter((s) => !liveIds.has(s.id)), ...codexSessions(folder, home)];
}

/** Codex lookups for the chip's refresh read many rollout files; they are reused for a little while. */
const codexCache = new Map<string, { at: number; list: AgentSession[] }>();
const CODEX_CACHE_MS = 20000;

/** The current state of a bound session, or undefined when it's gone from the list. */
export function findSession(folder: string, b: Binding, home = os.homedir()): AgentSession | undefined {
  if (b.agent === 'claude') return liveClaudeSessions(folder, home).find((s) => s.id === b.id) ?? pastClaudeSessions(folder, home, 50).find((s) => s.id === b.id);
  const key = `${home}\0${folder}`;
  let hit = codexCache.get(key);
  if (!hit || Date.now() - hit.at > CODEX_CACHE_MS || !hit.list.some((s) => s.id === b.id)) {
    hit = { at: Date.now(), list: codexSessions(folder, home, { days: 14, limit: 200 }) };
    codexCache.set(key, hit);
  }
  return hit.list.find((s) => s.id === b.id);
}

export class DeliveryError extends Error {}

/**
 * How a Claude session's inbox is reached on each OS. Claude Code asks for an
 * auth line only on Windows, where a named pipe is open to other local users;
 * macOS and Linux sockets sit in a folder only the user can read.
 */
export type InboxRoute = 'windows' | 'unix';

export function inboxRoute(platform: NodeJS.Platform = process.platform): InboxRoute {
  return platform === 'win32' ? 'windows' : 'unix';
}

/** Where Claude Code keeps a Windows session's inbox token: <pid>.<sha256 of the lowercased pipe path>.key. */
export function inboxKeyFile(pid: number, socket: string, home = os.homedir()): string {
  const hash = crypto.createHash('sha256').update(socket.toLowerCase()).digest('hex');
  return path.join(home, '.claude', 'sessions', `${pid}.${hash}.key`);
}

function readToken(file: string): string | undefined {
  try {
    if (fs.statSync(file).size > 4096) return undefined;
    const t = JSON.parse(fs.readFileSync(file, 'utf8'))?.peerToken;
    return typeof t === 'string' && /^[0-9a-f]{32}$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** The token a Windows session wants before any message. Falls back to the newest key file for its process. */
export function inboxToken(pid: number, socket: string, home = os.homedir()): string | undefined {
  const exact = readToken(inboxKeyFile(pid, socket, home));
  if (exact) return exact;
  const dir = path.join(home, '.claude', 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => new RegExp(`^${pid}\\.[0-9a-f]{64}\\.key$`).test(n));
  } catch {
    return undefined;
  }
  return names
    .map((n) => path.join(dir, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .map(readToken)
    .find(Boolean);
}

/**
 * Post `text` into a running Claude Code session's inbox. Resolves once the
 * line is written; the session reads it on its next turn boundary. With a
 * `token` (Windows), an auth line goes first.
 */
function inboxLines(text: string, o: { token?: string; from?: string }): string {
  const auth = o.token ? JSON.stringify({ type: 'auth', token: o.token }) + '\n' : '';
  return (
    auth +
    JSON.stringify({ type: 'user', message: { content: text }, from: o.from ?? 'md-review', msg_id: `mdr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, priority: 'next' }) +
    '\n'
  );
}

/**
 * Post into a WSL session's inbox. Its Unix socket is inside the Linux VM,
 * out of Windows' reach, so WSL's own node writes the lines; the script and
 * the message go on stdin, clear of wsl.exe's argument quoting. The inbox is
 * the running process's own socket, so whichever Claude account either side
 * is signed in to plays no part.
 */
export function deliverWsl(w: WslHome, socket: string, text: string, o: { token?: string; timeoutMs?: number } = {}): Promise<void> {
  const script =
    `const s=require('net').connect(${JSON.stringify(socket)});` +
    `s.on('error',e=>{console.error(e.code||e.message);process.exit(1)});` +
    `s.on('connect',()=>s.end(${JSON.stringify(inboxLines(text, o))},()=>process.exit(0)));`;
  return new Promise((resolve, reject) => {
    const child = execFile('wsl.exe', ['-d', w.distro, '--exec', w.node, '-'], { timeout: o.timeoutMs ?? 20000, windowsHide: true }, (err, _out, stderr) => {
      if (!err) return resolve();
      const why = String(stderr || err.message).replace(/\0/g, '').trim().split('\n').pop() || err.message;
      reject(new DeliveryError(`Couldn't reach the Claude session in WSL (${why}).`));
    });
    child.stdin?.end(script);
  });
}

export function deliverClaude(socket: string, text: string, o: { token?: string; from?: string; timeoutMs?: number } = {}): Promise<void> {
  const line = inboxLines(text, o);
  return new Promise((resolve, reject) => {
    const s = net.connect(socket);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new DeliveryError("Claude's inbox didn't answer."));
    }, o.timeoutMs ?? 5000);
    s.on('connect', () => {
      s.end(line, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    s.on('error', (e) => {
      clearTimeout(timer);
      reject(new DeliveryError(`Couldn't reach the Claude session (${(e as NodeJS.ErrnoException).code || e.message}).`));
    });
  });
}

/** Queue `text` for a Codex session with `codex queue`. */
export function deliverCodex(codex: string, threadId: string, text: string, cwd?: string, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(codex, ['queue', '--thread', threadId, '--message', text], { cwd, timeout: timeoutMs, windowsHide: true }, (err, _out, stderr) => {
      if (!err) return resolve();
      const why = String(stderr || err.message).trim().split('\n').pop() || err.message;
      reject(new DeliveryError(`Codex didn't take the message: ${why}`));
    });
  });
}

/** Deliver to a bound session, whatever its agent. */
export async function deliver(b: Binding, text: string, o: { folder: string; codex?: string; home?: string; platform?: NodeJS.Platform }): Promise<AgentSession> {
  const s = findSession(o.folder, b, o.home);
  if (b.agent === 'claude') {
    if (!s?.live || !s.socket) throw new DeliveryError('That Claude session isn\'t running. Resume it or pick another session.');
    if (s.wsl) {
      // Linux inboxes take messages without a token; one goes along when the session has a key.
      const token = typeof s.pid === 'number' ? inboxToken(s.pid, s.socket, wslUnc(s.wsl.distro, s.wsl.home)) : undefined;
      await deliverWsl(s.wsl, s.socket, text, { token });
      return s;
    }
    let token: string | undefined;
    if (inboxRoute(o.platform) === 'windows') {
      token = typeof s.pid === 'number' ? inboxToken(s.pid, s.socket, o.home) : undefined;
      // Without it the session drops the message without a word; say so instead.
      if (!token) throw new DeliveryError("Couldn't find that Claude session's inbox key. Restart the session, or use Copy prompt instead.");
    }
    await deliverClaude(s.socket, text, { token });
    return s;
  }
  await deliverCodex(o.codex || 'codex', b.id, text, o.folder);
  return s ?? { agent: 'codex', id: b.id, cwd: o.folder, live: true, updatedAt: Date.now() };
}

/** A fresh id for `claude --session-id`, so the session is bound before it starts. */
export function newSessionId(): string {
  return crypto.randomUUID();
}
