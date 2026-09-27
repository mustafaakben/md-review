// Agent sessions MD Review can talk to: running Claude Code and Codex sessions
// in a folder, the past ones that can be resumed, and delivery of a message
// into one of them. No vscode dependency, so the harness uses it too.
//
// Claude Code: every running session writes ~/.claude/sessions/<pid>.json with
// its id, folder, status and an inbox socket; a JSON line posted there starts
// a turn when the session is idle and is read between tool calls when busy.
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
  /** Registered by MD Review's SessionStart hook. */
  connected?: boolean;
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

/** Running Claude Code sessions whose folder is `folder` or inside it. */
export function liveClaudeSessions(folder: string, home = os.homedir()): AgentSession[] {
  const dir = path.join(home, '.claude', 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const reg = registered(home);
  const out: AgentSession[] = [];
  for (const n of names) {
    const s = readJson(path.join(dir, n));
    if (!s || typeof s.sessionId !== 'string' || typeof s.cwd !== 'string') continue;
    if (s.kind && s.kind !== 'interactive') continue; // headless -p runs and SDK children
    if (!alive(s.pid) || !within(folder, s.cwd)) continue;
    out.push({
      agent: 'claude',
      id: s.sessionId,
      name: typeof s.name === 'string' && s.name ? s.name : undefined,
      cwd: s.cwd,
      live: true,
      status: typeof s.status === 'string' ? s.status : undefined,
      updatedAt: Number(s.updatedAt) || 0,
      socket: typeof s.messagingSocketPath === 'string' ? s.messagingSocketPath : undefined,
      connected: reg.has(`claude-${s.sessionId}`),
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
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
      let meta: any;
      try {
        meta = JSON.parse(firstLine(f)).payload;
      } catch {
        continue;
      }
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

/** The current state of a bound session, or undefined when it's gone from the list. */
export function findSession(folder: string, b: Binding, home = os.homedir()): AgentSession | undefined {
  if (b.agent === 'claude') return liveClaudeSessions(folder, home).find((s) => s.id === b.id) ?? pastClaudeSessions(folder, home, 50).find((s) => s.id === b.id);
  return codexSessions(folder, home, { days: 30, limit: 500 }).find((s) => s.id === b.id);
}

export class DeliveryError extends Error {}

/**
 * Post `text` into a running Claude Code session's inbox. Resolves once the
 * line is written; the session reads it on its next turn boundary.
 */
export function deliverClaude(socket: string, text: string, from = 'md-review', timeoutMs = 5000): Promise<void> {
  const line =
    JSON.stringify({ type: 'user', message: { content: text }, from, msg_id: `mdr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, priority: 'next' }) + '\n';
  return new Promise((resolve, reject) => {
    const s = net.connect(socket);
    const timer = setTimeout(() => {
      s.destroy();
      reject(new DeliveryError("Claude's inbox didn't answer."));
    }, timeoutMs);
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
export async function deliver(b: Binding, text: string, o: { folder: string; codex?: string; home?: string }): Promise<AgentSession> {
  const s = findSession(o.folder, b, o.home);
  if (b.agent === 'claude') {
    if (!s?.live || !s.socket) throw new DeliveryError('That Claude session isn\'t running. Resume it or pick another session.');
    await deliverClaude(s.socket, text);
    return s;
  }
  await deliverCodex(o.codex || 'codex', b.id, text, o.folder);
  return s ?? { agent: 'codex', id: b.id, cwd: o.folder, live: true, updatedAt: Date.now() };
}

/** A fresh id for `claude --session-id`, so the session is bound before it starts. */
export function newSessionId(): string {
  return crypto.randomUUID();
}
