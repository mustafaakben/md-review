import type { Comment } from './commentTypes';
import { isWorking } from './round';
/** Display delivery state without changing the portable draft/submitted/resolved protocol. */
export function threadStatus(c: Comment, now = Date.now()): string {
  if (c.status === 'draft') return 'Draft';
  if (c.status === 'resolved') return 'Resolved';
  const agent = c.delivery?.agent === 'codex' ? 'Codex' : c.delivery?.agent === 'claude' ? 'Claude' : 'agent';
  if (isWorking(c, now)) return `${c.delivery?.agent ? agent : c.workingBy || agent} is working`;
  const last = c.replies.at(-1);
  if (last && last.author !== c.author && (!c.reopenedAt || c.reopenedAt <= last.createdAt)) return 'Needs your reply';
  if (c.delivery && Math.max(Date.parse(c.reopenedAt || c.submittedAt || c.createdAt), Date.parse(last?.createdAt || c.createdAt)) <= Date.parse(c.delivery.at)) return `Waiting on ${agent}`;
  return 'Ready to send';
}
