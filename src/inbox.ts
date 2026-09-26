// Review inbox: every thread in the workspace, grouped by whose turn it is.
// Pure (no vscode), so the tests drive it directly; src/inboxView.ts shows it.
import { awaitsAgent, isAgentDraft, parseSidecar, Comment, Sidecar } from './commentStore';
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

export interface InboxFile {
  mdPath: string;
  threads: Comment[];
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
export function groupOf(c: Comment, agent = 'Claude', now = Date.now()): InboxGroup {
  if (isAgentDraft(c)) return 'triage';
  if (c.status === 'draft') return 'drafts';
  if (c.status === 'resolved') return 'resolved';
  return awaitsAgent(c, agent) || isWorking(c, now) ? 'waiting' : 'needsYou';
}

/** Parse one sidecar's text; a malformed file gives null so one bad file can't sink the list. */
export function parseInboxSidecar(raw: string, mdPath: string): Sidecar | null {
  try {
    return parseSidecar(raw, mdPath);
  } catch {
    return null;
  }
}

/** Group every thread; files sort by path, threads by line (whole-document threads first). */
export function buildInbox(files: { mdPath: string; data: Sidecar | null }[], agent = 'Claude', now = Date.now()): Inbox {
  const groups = { needsYou: [], triage: [], waiting: [], drafts: [], resolved: [] } as Record<InboxGroup, InboxFile[]>;
  const counts = { needsYou: 0, triage: 0, waiting: 0, drafts: 0, resolved: 0 } as Record<InboxGroup, number>;
  const sorted = files.filter((f) => f.data).sort((a, b) => a.mdPath.localeCompare(b.mdPath));
  let expires: number | null = null;
  for (const { mdPath, data } of sorted) {
    const by = new Map<InboxGroup, Comment[]>();
    for (const c of data!.comments) {
      const g = groupOf(c, agent, now);
      if (!by.has(g)) by.set(g, []);
      by.get(g)!.push(c);
    }
    for (const [g, threads] of by) {
      threads.sort((a, b) => lineOf(a) - lineOf(b) || a.createdAt.localeCompare(b.createdAt));
      groups[g].push({ mdPath, threads });
      counts[g] += threads.length;
    }
    const left = nextExpiry(data!.comments, now);
    if (left !== null && (expires === null || left < expires)) expires = left;
  }
  return { groups, counts, expires };
}

const lineOf = (c: Comment) => (c.scope === 'document' ? 0 : c.anchor.lineStart || 0);

/** First non-empty line of the body, shortened. */
export function threadLabel(c: Comment): string {
  const line = c.body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  return clip(line, 80) || '(no text)';
}

const SEVERITY = { major: 'Major', minor: 'Minor', nit: 'Nit' };

/** "Major · L12 · quoted text", or where a thread without a quote sits. */
export function threadDescription(c: Comment): string {
  const severity = c.severity ? SEVERITY[c.severity] : '';
  if (c.scope === 'document') return [severity, 'Whole document'].filter(Boolean).join(' · ');
  const at = c.anchor.lineStart ? `L${c.anchor.lineStart}` : '';
  const quote = clip(c.anchor.quote.replace(/\s+/g, ' ').trim(), 60);
  return [severity, at, quote].filter(Boolean).join(' · ');
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
