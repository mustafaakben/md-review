// Review inbox: every thread in the workspace, grouped by whose turn it is.
// Pure (no vscode), so the tests drive it directly; src/inboxView.ts shows it.
import { awaitsAgent, parseSidecar, Comment, Sidecar } from './commentStore';

export type InboxGroup = 'needsYou' | 'waiting' | 'drafts' | 'resolved';

export const GROUPS: { id: InboxGroup; label: string }[] = [
  { id: 'needsYou', label: 'Needs you' },
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
}

/** Submitted threads are the agent's turn until it has the last word (see awaitsAgent). */
export function groupOf(c: Comment, agent = 'Claude'): InboxGroup {
  if (c.status === 'draft') return 'drafts';
  if (c.status === 'resolved') return 'resolved';
  return awaitsAgent(c, agent) ? 'waiting' : 'needsYou';
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
export function buildInbox(files: { mdPath: string; data: Sidecar | null }[], agent = 'Claude'): Inbox {
  const groups = { needsYou: [], waiting: [], drafts: [], resolved: [] } as Record<InboxGroup, InboxFile[]>;
  const counts = { needsYou: 0, waiting: 0, drafts: 0, resolved: 0 } as Record<InboxGroup, number>;
  const sorted = files.filter((f) => f.data).sort((a, b) => a.mdPath.localeCompare(b.mdPath));
  for (const { mdPath, data } of sorted) {
    const by = new Map<InboxGroup, Comment[]>();
    for (const c of data!.comments) {
      const g = groupOf(c, agent);
      if (!by.has(g)) by.set(g, []);
      by.get(g)!.push(c);
    }
    for (const [g, threads] of by) {
      threads.sort((a, b) => lineOf(a) - lineOf(b) || a.createdAt.localeCompare(b.createdAt));
      groups[g].push({ mdPath, threads });
      counts[g] += threads.length;
    }
  }
  return { groups, counts };
}

const lineOf = (c: Comment) => (c.scope === 'document' ? 0 : c.anchor.lineStart || 0);

/** First non-empty line of the body, shortened. */
export function threadLabel(c: Comment): string {
  const line = c.body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  return clip(line, 80) || '(no text)';
}

/** "L12 · quoted text", or where a thread without a quote sits. */
export function threadDescription(c: Comment): string {
  if (c.scope === 'document') return 'Whole document';
  const at = c.anchor.lineStart ? `L${c.anchor.lineStart}` : '';
  const quote = clip(c.anchor.quote.replace(/\s+/g, ' ').trim(), 60);
  return [at, quote].filter(Boolean).join(' · ');
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
