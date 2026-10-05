import type { Meta } from './commentMeta';
import type { Suggestion } from './suggest';
export type Status = 'draft' | 'submitted' | 'resolved';
export interface Reply { id: string; parentId?: string; author: string; createdAt: string; body: string; suggestion?: Suggestion }
export interface Comment extends Meta {
  reopenedAt?: string | null;
  delivery?: { at: string; agent?: 'claude' | 'codex' };
  id: string; author: string; createdAt: string; body: string; status: Status;
  submittedAt: string | null; resolvedAt: string | null; replies: Reply[];
  suggestion?: Suggestion;
  /** Set by the CLI while an agent is on this thread. */
  workingAt?: string; workingBy?: string;
  /** "agent": Claude's draft from Review with Claude, not yet triaged. */
  origin?: 'agent' | 'word'; suggestedBy?: string;
  anchor: { quote: string; prefix: string; suffix: string; lineStart: number; lineEnd: number };
}
