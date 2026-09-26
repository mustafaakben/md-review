// Review inbox: every thread in the workspace, grouped by whose turn it is.
// Pure (no vscode), so the tests drive it directly; src/inboxView.ts shows it.
import { awaitsAgent, isAgentDraft, Comment, Kind, Reply, Scope, Severity, Status, KINDS, SEVERITIES } from './commentStore';
// The webview's rule for a live claim, so the inbox and the thread pulse agree.
import { isWorking, nextExpiry } from '../webview/round';

export type InboxGroup = 'needsYou' | 'triage' | 'waiting' | 'drafts' | 'resolved';

export const GROUPS: { id: InboxGroup; label: string }[] = [
  { id: 'needsYou', label: 'Needs you' },
  { id: 'triage', label: 'From Claude, to triage' },
  { id: 'waiting', label: 'Waiting on Claude' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'resolved', label: 'Resolved' },
];

/**
 * What the inbox keeps of a thread: enough to group, label and jump to it,
 * with every field the type it says whatever the file held. The latest reply
 * stands in for the rest (it decides whose turn it is).
 */
export interface InboxThread {
  id: string;
  author: string;
  createdAt: string;
  status: Status;
  /** Shortened; the tree shows its first line and the tooltip the rest. */
  body: string;
  anchor: { quote: string; lineStart: number };
  scope?: Scope;
  kind?: Kind;
  severity?: Severity;
  origin?: 'agent';
  reopenedAt?: string;
  workingAt?: string;
  workingBy?: string;
  /** The latest reply only, its body shortened. */
  replies: Pick<Reply, 'author' | 'createdAt' | 'body'>[];
  /** A suggested edit is waiting to be applied or dismissed (see openSuggestion). */
  suggested?: boolean;
}

export interface InboxFile {
  mdPath: string;
  threads: InboxThread[];
}

export interface Inbox {
  groups: Record<InboxGroup, InboxFile[]>;
  counts: Record<InboxGroup, number>;
  /** Ms until a working claim goes stale and a thread changes group, or null. */
  expires: number | null;
}

/**
 * Claude's untriaged drafts wait for triage, apart from the reviewer's own.
 * Submitted threads are the agent's turn until it has the last word (see
 * awaitsAgent), and while it holds a fresh claim on them (see isWorking).
 */
export function groupOf(c: InboxThread | Comment, agent = 'Claude', now = Date.now()): InboxGroup {
  if (isAgentDraft(c)) return 'triage';
  if (c.status === 'draft') return 'drafts';
  if (c.status === 'resolved') return 'resolved';
  return awaitsAgent(c, agent) || isWorking(c, now) ? 'waiting' : 'needsYou';
}

/**
 * Parse one sidecar's text into its threads; a malformed file gives null so
 * one bad file can't sink the list. Follows parseSidecar's defaults, except
 * that a thread without an id is left out: parseSidecar would make one up on
 * every read, so there is nothing stable to jump to.
 */
export function parseInboxSidecar(raw: string): InboxThread[] | null {
  try {
    if (!raw.trim()) return [];
    const list = obj(JSON.parse(raw.replace(/^\uFEFF/, ''))).comments ?? [];
    if (!Array.isArray(list)) return null;
    return list.map(obj).filter((c) => str(c.id)).map(slim);
  } catch {
    return null;
  }
}

function slim(c: Record<string, any>): InboxThread {
  const a = obj(c.anchor);
  const replies = (Array.isArray(c.replies) ? c.replies : []).map(obj);
  const last = replies[replies.length - 1];
  const open = (s: unknown) => !!s && typeof s === 'object' && !(s as any).appliedAt && !(s as any).dismissedAt;
  const t: InboxThread = {
    id: c.id,
    author: str(c.author) || 'unknown',
    createdAt: str(c.createdAt),
    status: ['draft', 'submitted', 'resolved'].includes(c.status) ? c.status : 'submitted',
    body: clip(str(c.body), 300),
    anchor: { quote: str(a.quote ?? c.quote), lineStart: Number.isInteger(a.lineStart) && a.lineStart > 0 ? a.lineStart : 0 },
    replies: last ? [{ author: str(last.author) || 'unknown', createdAt: str(last.createdAt), body: clip(str(last.body), 200) }] : [],
  };
  if (c.scope === 'section' || c.scope === 'document') t.scope = c.scope;
  if (KINDS.includes(c.kind) && c.kind !== 'comment') t.kind = c.kind;
  if (SEVERITIES.includes(c.severity)) t.severity = c.severity;
  if (c.origin === 'agent') t.origin = 'agent';
  for (const k of ['reopenedAt', 'workingAt', 'workingBy'] as const) if (str(c[k])) t[k] = c[k];
  if (open(c.suggestion) || replies.some((r: Record<string, any>) => open(r.suggestion))) t.suggested = true;
  return t;
}

/** Group every thread; files sort by path, threads by line (whole-document threads first). */
export function buildInbox(files: { mdPath: string; threads: InboxThread[] | null }[], agent = 'Claude', now = Date.now()): Inbox {
  const groups = { needsYou: [], triage: [], waiting: [], drafts: [], resolved: [] } as Record<InboxGroup, InboxFile[]>;
  const counts = { needsYou: 0, triage: 0, waiting: 0, drafts: 0, resolved: 0 } as Record<InboxGroup, number>;
  const sorted = files.filter((f) => f.threads).sort((a, b) => a.mdPath.localeCompare(b.mdPath));
  let expires: number | null = null;
  for (const { mdPath, threads: all } of sorted) {
    const by = new Map<InboxGroup, InboxThread[]>();
    for (const c of all!) {
      const g = groupOf(c, agent, now);
      if (!by.has(g)) by.set(g, []);
      by.get(g)!.push(c);
    }
    for (const [g, threads] of by) {
      threads.sort((a, b) => lineOf(a) - lineOf(b) || before(a.createdAt, b.createdAt));
      groups[g].push({ mdPath, threads });
      counts[g] += threads.length;
    }
    const left = nextExpiry(all!, now);
    if (left !== null && (expires === null || left < expires)) expires = left;
  }
  return { groups, counts, expires };
}

const lineOf = (c: InboxThread) => (c.scope === 'document' ? 0 : Number(c.anchor.lineStart) || 0);
// Plain comparison, safe on whatever a hand-edited file put there (ISO times sort as text).
const before = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/** First non-empty line of the body, shortened. */
export function threadLabel(c: InboxThread): string {
  const line = c.body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  return clip(line, 80) || '(no text)';
}

const SEVERITY = new Map<string, string>([
  ['major', 'Major'],
  ['minor', 'Minor'],
  ['nit', 'Nit'],
]);

/** "Major · L12 · quoted text", or where a thread without a quote sits. */
export function threadDescription(c: InboxThread): string {
  const severity = (c.severity && SEVERITY.get(c.severity)) || '';
  if (c.scope === 'document') return [severity, 'Whole document'].filter(Boolean).join(' · ');
  const at = c.anchor.lineStart ? `L${c.anchor.lineStart}` : '';
  const quote = clip(c.anchor.quote.replace(/\s+/g, ' ').trim(), 60);
  return [severity, at, quote].filter(Boolean).join(' · ');
}

/**
 * Whether a folder-relative path (with /) falls under one of these globs, as
 * files.exclude reads them: a pattern that matches a folder takes everything
 * in it. Knows `**`, `*`, `?`, `{a,b}` and `[...]`.
 */
export function excludedBy(rel: string, globs: string[]): boolean {
  const res = globs.map(globRe).filter((re): re is RegExp => !!re);
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length && res.length; i++) {
    const p = parts.slice(0, i).join('/');
    if (res.some((re) => re.test(p))) return true;
  }
  return false;
}

function globRe(glob: string): RegExp | null {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const close = ch === '[' ? glob.indexOf(']', i + 2) : -1;
    if (ch === '*' && glob[i + 1] === '*') {
      // `**/` is any number of folders, including none.
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:[^/]*/)*';
      } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      braces++;
      re += '(?:';
    } else if (ch === '}' && braces) {
      braces--;
      re += ')';
    } else if (ch === ',' && braces) re += '|';
    else if (close > 0) {
      re += '[' + glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
      i = close;
    } else re += ch.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re.replace(/\/$/, '')}$`);
  } catch {
    return null; // an unbalanced {: match nothing rather than fail
  }
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const str = (x: unknown) => (typeof x === 'string' ? x : '');
const obj = (x: unknown): Record<string, any> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, any>) : {});
