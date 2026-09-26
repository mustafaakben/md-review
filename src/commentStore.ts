// Sidecar comment store: <file>.md.comments.json next to the Markdown file.
// Every mutation re-reads the file from disk, applies the change, and writes
// it back, so concurrent edits by agents (Claude) are never clobbered.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export type Status = 'draft' | 'submitted' | 'resolved';

// Fields this version doesn't know (written by an agent, the CLI, or a newer
// MD Review) are kept as they are on every read and write.
type Extra = { [key: string]: unknown };

export interface Reply extends Extra {
  id: string;
  author: string;
  createdAt: string;
  body: string;
}

export interface Anchor extends Extra {
  quote: string;
  prefix: string;
  suffix: string;
  lineStart: number; // 1-based, inclusive
  lineEnd: number; // 1-based, inclusive
}

export interface Comment extends Extra {
  id: string;
  author: string;
  createdAt: string;
  anchor: Anchor;
  body: string;
  status: Status;
  submittedAt: string | null;
  resolvedAt: string | null;
  /** Set when a resolved thread is reopened; replies older than this are history. */
  reopenedAt?: string | null;
  replies: Reply[];
}

export interface Sidecar extends Extra {
  schemaVersion: 1;
  file: string;
  comments: Comment[];
}

export function sidecarPath(mdPath: string): string {
  return mdPath + '.comments.json';
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function emptySidecar(mdPath: string): Sidecar {
  return { schemaVersion: 1, file: path.basename(mdPath), comments: [] };
}

/** Read the sidecar; missing file -> empty. Tolerates missing optional fields. */
export function readSidecar(mdPath: string): Sidecar {
  const p = sidecarPath(mdPath);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return emptySidecar(mdPath);
  }
  if (!raw.trim()) return emptySidecar(mdPath);
  const data = JSON.parse(raw.replace(/^﻿/, ''));
  const out: Sidecar = { ...data, schemaVersion: 1, file: data.file || path.basename(mdPath), comments: [] };
  for (const c of data.comments || []) {
    out.comments.push({
      ...c,
      id: c.id || newId('c'),
      author: c.author || 'unknown',
      createdAt: c.createdAt || now(),
      anchor: {
        ...c.anchor,
        quote: c.anchor?.quote ?? c.quote ?? '',
        prefix: c.anchor?.prefix ?? '',
        suffix: c.anchor?.suffix ?? '',
        lineStart: c.anchor?.lineStart ?? 0,
        lineEnd: c.anchor?.lineEnd ?? 0,
      },
      body: c.body ?? '',
      status: (['draft', 'submitted', 'resolved'].includes(c.status) ? c.status : 'submitted') as Status,
      submittedAt: c.submittedAt ?? null,
      resolvedAt: c.resolvedAt ?? null,
      ...(c.reopenedAt ? { reopenedAt: c.reopenedAt } : { reopenedAt: undefined }),
      replies: (c.replies || []).map((r: any) => ({
        ...r,
        id: r.id || newId('r'),
        author: r.author || 'unknown',
        createdAt: r.createdAt || now(),
        body: r.body ?? '',
      })),
    });
  }
  return out;
}

export function serialize(data: Sidecar): string {
  return JSON.stringify(data, null, 2) + '\n';
}

/**
 * Read-modify-write. Returns the serialized text that was written (callers use
 * it to ignore the watcher event caused by their own write).
 */
export function mutate(mdPath: string, fn: (data: Sidecar) => void): { data: Sidecar; written: string } {
  const data = readSidecar(mdPath);
  fn(data);
  const written = serialize(data);
  const p = sidecarPath(mdPath);
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, written, 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch {
    // Windows and file-sync tools can briefly lock the target; fall back to a direct write.
    fs.writeFileSync(p, written, 'utf8');
    fs.rmSync(tmp, { force: true });
  }
  return { data, written };
}

// ---- operations shared by the extension, the harness server, and the CLI ----

export function find(data: Sidecar, id: string): Comment {
  const c = data.comments.find((x) => x.id === id);
  if (!c) throw new Error(`No comment with id ${id}`);
  return c;
}

export function addComment(data: Sidecar, author: string, anchor: Anchor, body: string): Comment {
  const c: Comment = {
    id: newId('c'),
    author,
    createdAt: now(),
    anchor,
    body,
    status: 'draft',
    submittedAt: null,
    resolvedAt: null,
    replies: [],
  };
  data.comments.push(c);
  return c;
}

export function addReply(data: Sidecar, id: string, author: string, body: string): Reply {
  const r: Reply = { id: newId('r'), author, createdAt: now(), body };
  find(data, id).replies.push(r);
  return r;
}

export function setStatus(data: Sidecar, id: string, status: Status): void {
  const c = find(data, id);
  if (c.status === 'resolved' && status !== 'resolved') c.reopenedAt = now();
  c.status = status;
  if (status === 'resolved') c.resolvedAt = now();
  else c.resolvedAt = null;
  if (status === 'submitted' && !c.submittedAt) c.submittedAt = now();
}

export function submitDrafts(data: Sidecar): number {
  const ts = now();
  let n = 0;
  for (const c of data.comments) {
    if (c.status === 'draft') {
      c.status = 'submitted';
      c.submittedAt = ts;
      n++;
    }
  }
  return n;
}

export function deleteComment(data: Sidecar, id: string): void {
  data.comments = data.comments.filter((c) => c.id !== id);
}

/**
 * Whether a submitted thread is waiting on the agent: its last reply isn't the
 * agent's, or the reviewer reopened it after that reply.
 */
export function awaitsAgent(c: Comment, agent = 'Claude'): boolean {
  if (c.status !== 'submitted') return false;
  const last = c.replies[c.replies.length - 1];
  return !last || last.author !== agent || (!!c.reopenedAt && c.reopenedAt > last.createdAt);
}

export function editBody(data: Sidecar, id: string, body: string): void {
  find(data, id).body = body;
}
