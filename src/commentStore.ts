// Sidecar comment store: <file>.md.comments.json next to the Markdown file.
// Every mutation re-reads the file from disk, applies the change, and writes
// it back, so concurrent edits by agents (Claude) are never clobbered.
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export type Status = 'draft' | 'submitted' | 'resolved';
/** What the reviewer wants: a change (the default), an answer only, or nothing. */
export type Kind = 'comment' | 'question' | 'praise';
export type Severity = 'major' | 'minor' | 'nit';
/** A thread about a whole section (anchored on its heading) or the whole document (no quote). */
export type Scope = 'section' | 'document';

export const KINDS: Kind[] = ['comment', 'question', 'praise'];
export const SEVERITIES: Severity[] = ['major', 'minor', 'nit'];

/** Replacement text for the thread's quote ('' deletes it), from the reviewer or the agent. */
export interface Suggestion {
  text: string;
  appliedAt?: string;
  dismissedAt?: string;
}

export interface Reply {
  id: string;
  author: string;
  createdAt: string;
  body: string;
  suggestion?: Suggestion;
}

export interface Anchor {
  quote: string;
  prefix: string;
  suffix: string;
  lineStart: number; // 1-based, inclusive
  lineEnd: number; // 1-based, inclusive
}

export interface Comment {
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
  /** Absent means a plain comment. */
  kind?: Kind;
  severity?: Severity;
  scope?: Scope;
  suggestion?: Suggestion;
  /** Set by the CLI while an agent works on this thread; cleared when it replies or resolves. */
  workingAt?: string;
  workingBy?: string;
  /**
   * Where a thread written outside the view came from. "agent": a draft an agent
   * left as first reviewer, waiting for the reviewer to triage it. "word": a
   * comment or tracked change imported from a Word document.
   */
  origin?: 'agent' | 'word';
  /** The Review with Claude run that left this draft (the CLI's --run). */
  reviewRun?: string;
  /** Who first raised a thread the reviewer took over (kept from an agent's draft). */
  suggestedBy?: string;
  replies: Reply[];
}

export interface CommentMeta {
  kind?: Kind | null;
  severity?: Severity | null;
  scope?: Scope | null;
}

/** Set or clear kind/severity/scope; unknown values and the defaults are dropped. */
function applyMeta(c: Comment, meta: CommentMeta) {
  if ('kind' in meta) {
    if (meta.kind && meta.kind !== 'comment' && KINDS.includes(meta.kind)) c.kind = meta.kind;
    else delete c.kind;
  }
  if ('severity' in meta) {
    if (meta.severity && SEVERITIES.includes(meta.severity)) c.severity = meta.severity;
    else delete c.severity;
  }
  if ('scope' in meta) {
    if (meta.scope === 'section' || meta.scope === 'document') c.scope = meta.scope;
    else delete c.scope;
  }
}

export interface Sidecar {
  schemaVersion: 1;
  file: string;
  comments: Comment[];
  /** Set by the CLI's review-done when an agent finishes reviewing the file first. */
  reviewDoneAt?: string;
  /** The review run review-done ended (its --run), when Claude was given one. */
  reviewDoneRun?: string;
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

/** Plain JSON objects only; anything else (a hand-damaged value) reads as empty. */
const obj = (x: unknown): Record<string, any> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, any>) : {});

/**
 * Read the sidecar; missing file -> empty. Tolerates missing optional fields.
 * Fields this version doesn't know (written by an agent, the CLI, or a newer
 * MD Review) are kept as they are, on the file, comments, anchors and replies.
 */
export function readSidecar(mdPath: string): Sidecar {
  let raw: string;
  try {
    raw = fs.readFileSync(sidecarPath(mdPath), 'utf8');
  } catch {
    return emptySidecar(mdPath);
  }
  return parseSidecar(raw, mdPath);
}

/** Parse sidecar text (see readSidecar); throws on invalid JSON. */
export function parseSidecar(raw: string, mdPath: string): Sidecar {
  if (!raw.trim()) return emptySidecar(mdPath);
  const data = obj(JSON.parse(raw.replace(/^﻿/, '')));
  const out: Sidecar = { ...data, schemaVersion: 1, file: data.file || path.basename(mdPath), comments: [] };
  for (const item of data.comments || []) {
    const c = obj(item);
    const a = obj(c.anchor);
    const { quote: legacyQuote, ...rest } = c; // pre-anchor files kept the quote here
    out.comments.push({
      ...rest,
      id: c.id || newId('c'),
      author: c.author || 'unknown',
      createdAt: c.createdAt || now(),
      anchor: {
        ...a,
        quote: a.quote ?? legacyQuote ?? '',
        prefix: a.prefix ?? '',
        suffix: a.suffix ?? '',
        lineStart: a.lineStart ?? 0,
        lineEnd: a.lineEnd ?? 0,
      },
      body: c.body ?? '',
      status: (['draft', 'submitted', 'resolved'].includes(c.status) ? c.status : 'submitted') as Status,
      submittedAt: c.submittedAt ?? null,
      resolvedAt: c.resolvedAt ?? null,
      ...(c.reopenedAt ? { reopenedAt: c.reopenedAt } : { reopenedAt: undefined }),
      replies: (c.replies || []).map(obj).map((r: Record<string, any>) => ({
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

export function addComment(data: Sidecar, author: string, anchor: Anchor, body: string, meta: CommentMeta = {}): Comment {
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
  applyMeta(c, meta);
  data.comments.push(c);
  return c;
}

/** The comment's own suggestion, or the one on reply `from`. */
export function suggestionOf(c: Comment, from?: string): Suggestion | undefined {
  return from ? c.replies.find((r) => r.id === from)?.suggestion : c.suggestion;
}

/** The suggestion still waiting on the reviewer: the newest one neither applied nor dismissed. */
export function openSuggestion(c: Comment): { from?: string; s: Suggestion } | null {
  for (let i = c.replies.length - 1; i >= 0; i--) {
    const s = c.replies[i].suggestion;
    if (s && !s.appliedAt && !s.dismissedAt) return { from: c.replies[i].id, s };
  }
  return c.suggestion && !c.suggestion.appliedAt && !c.suggestion.dismissedAt ? { s: c.suggestion } : null;
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
  delete c.workingAt; // a status change ends any claim on the thread
  delete c.workingBy;
  if (status === 'resolved') c.resolvedAt = now();
  else c.resolvedAt = null;
  if (status === 'submitted' && !c.submittedAt) c.submittedAt = now();
}

/** An agent's draft the reviewer hasn't kept, acted on, or dismissed yet. */
export const isAgentDraft = (c: Pick<Comment, 'status' | 'origin'>): boolean => c.status === 'draft' && c.origin === 'agent';

/** Take over an agent's draft: it becomes the reviewer's own, noting who raised it. */
export function keepAgentDraft(data: Sidecar, id: string, author: string): void {
  const c = find(data, id);
  if (c.origin !== 'agent') return;
  c.suggestedBy = c.author;
  c.author = author;
  delete c.origin;
}

/** Submit the reviewer's drafts; an agent's untriaged drafts stay where they are. */
export function submitDrafts(data: Sidecar): number {
  const ts = now();
  let n = 0;
  for (const c of data.comments) {
    if (c.status === 'draft' && c.origin !== 'agent') {
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
export function awaitsAgent(c: Pick<Comment, 'status' | 'reopenedAt'> & { replies: Pick<Reply, 'author' | 'createdAt'>[] }, agent = 'Claude'): boolean {
  if (c.status !== 'submitted') return false;
  const last = c.replies[c.replies.length - 1];
  return !last || last.author !== agent || (!!c.reopenedAt && c.reopenedAt > last.createdAt);
}

export function editBody(data: Sidecar, id: string, body: string): void {
  find(data, id).body = body;
}

/** Longest quote, and prefix or suffix, a re-anchor accepts. */
const MAX_QUOTE = 100_000;
const MAX_CONTEXT = 1_000;

/**
 * Move a thread onto a new passage (an orphan whose quoted text was rewritten).
 * The anchor comes from the view, so it is checked field by field. Anchor
 * fields this version doesn't know are kept.
 */
export function reanchor(data: Sidecar, id: string, anchor: Anchor): void {
  const c = find(data, id);
  if (c.scope === 'document') throw new Error('A whole-document thread has no passage to move.');
  const a = (anchor && typeof anchor === 'object' ? anchor : {}) as Partial<Record<keyof Anchor, unknown>>;
  const { quote, prefix = '', suffix = '', lineStart, lineEnd } = a;
  if (typeof quote !== 'string' || !quote.trim()) throw new Error('Select the passage to move the thread to.');
  if (quote.length > MAX_QUOTE) throw new Error('That passage is too long to anchor a comment to.');
  if (typeof prefix !== 'string' || typeof suffix !== 'string' || prefix.length > MAX_CONTEXT || suffix.length > MAX_CONTEXT) {
    throw new Error('Could not move the thread: the text around the passage is invalid.');
  }
  const line = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  if (!line(lineStart) || !line(lineEnd) || lineEnd < lineStart) throw new Error('Could not move the thread: the passage has no valid lines.');
  c.anchor = { ...c.anchor, quote, prefix, suffix, lineStart, lineEnd };
}

export function setMeta(data: Sidecar, id: string, meta: CommentMeta): void {
  applyMeta(find(data, id), meta);
}
