// Live agent status: the "Claude is working · 2 of 5" banner over the threads,
// the summary when the round ends, and which threads Claude is on right now.
// A Review with Claude run has its own row, shown alongside a Send round.

export interface Round {
  total: number; done: number; resolved: number; questions: number; suggestions: number; questionIds: string[]; finished: boolean;
  /** Blocks changed since the baseline, counted when the round finishes. */
  changes?: number;
}

/** A Review with Claude run: the drafts Claude has left so far, and how many still need triage. */
export interface ReviewRun {
  startedAt: string; total: number; ids: string[]; untriaged: number; finished: boolean;
}

/** A claim older than this is treated as abandoned (the agent crashed or was stopped). */
const FRESH_MS = 5 * 60 * 1000;

export function isWorking(c: { status: string; workingAt?: string }, now = Date.now()): boolean {
  if (!c.workingAt || c.status === 'resolved') return false;
  // A claim from the future (a synced machine with a fast clock) counts, but only for as long as a fresh one.
  const age = now - Date.parse(c.workingAt);
  return age < FRESH_MS && age > -FRESH_MS;
}

/** When the next claim goes stale, so the view can drop its "working" state on time. */
export function nextExpiry(list: { status: string; workingAt?: string }[], now = Date.now()): number | null {
  let min: number | null = null;
  for (const c of list) {
    if (!isWorking(c, now)) continue;
    const left = Math.min(Date.parse(c.workingAt!) + FRESH_MS - now, FRESH_MS);
    if (min === null || left < min) min = left;
  }
  return min;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Claude says when a review is done (review-done), but in case it never does,
 * a run that isn't finished counts as live only while Claude keeps adding
 * drafts: until FRESH_MS after the start or its newest one. Returns ms until
 * it goes quiet, or null when it's finished or already quiet.
 */
export function reviewLeft(r: ReviewRun, list: { origin?: string; createdAt: string }[], now = Date.now()): number | null {
  if (r.finished) return null;
  let last = Date.parse(r.startedAt) || 0;
  for (const c of list) if (c.origin === 'agent') last = Math.max(last, Date.parse(c.createdAt) || 0);
  const left = last + FRESH_MS - now;
  return left > 0 ? left : null;
}

/** The Review with Claude row: live, then how much of what Claude left is still to triage. */
export function reviewBanner(r: ReviewRun | null, live: boolean): string {
  if (!r) return '';
  if (live) {
    return `<div class="mdr-round-row"><span class="mdr-round-dot live" aria-hidden="true"></span>
      <span class="mdr-round-text">Claude is reviewing · ${plural(r.total, 'comment')} so far</span>
      <button class="mdr-round-x" data-round="dismiss-review" title="Hide" aria-label="Hide review progress"></button></div>`;
  }
  const text =
    r.untriaged ? `Claude left ${plural(r.total, 'comment')} · ${r.untriaged} to triage`
    : r.total === 1 ? "Claude's comment is triaged"
    : r.total ? `All ${r.total} of Claude's comments triaged`
    : r.finished ? 'Claude left no comments'
    : 'No comments from Claude yet';
  const show = r.untriaged ? `<button data-round="from-claude">Show them</button>` : '';
  return `<div class="mdr-round-row"><span class="mdr-round-icon${r.total ? ' done' : ''}" aria-hidden="true"></span>
    <span class="mdr-round-text">${text}</span></div>
    <div class="mdr-round-row mdr-round-actions">${show}<button data-round="dismiss-review" aria-label="Dismiss the review summary">Dismiss</button></div>`;
}

/** The Send to Claude row: progress while Claude works, then the summary. */
export function roundBanner(r: Round | null, working: boolean): string {
  if (!r) return '';
  if (r.finished) {
    const yours = [r.suggestions && plural(r.suggestions, 'suggested edit'), r.questions && plural(r.questions, 'question')].filter(Boolean);
    const q = yours.length ? `, ${yours.join(' and ')} for you` : '';
    const ch = r.changes ? `. ${plural(r.changes, 'block')} changed` : '';
    return `<div class="mdr-round-row"><span class="mdr-round-icon done" aria-hidden="true"></span>
      <span class="mdr-round-text">Claude finished: ${r.resolved} resolved${q}${ch}</span></div>
      <div class="mdr-round-row mdr-round-actions">${r.changes ? '<button data-round="changes">Review changes</button>' : ''}${r.questionIds.length ? `<button data-round="questions">${r.suggestions ? 'Show them' : 'Show questions'}</button>` : ''}<button data-round="dismiss-round" aria-label="Dismiss the round summary">Dismiss</button></div>`;
  }
  const pct = r.total ? Math.round((100 * r.done) / r.total) : 0;
  const what = working ? 'Claude is working' : 'Waiting for Claude';
  return `<div class="mdr-round-row"><span class="mdr-round-dot${working ? ' live' : ''}" aria-hidden="true"></span>
    <span class="mdr-round-text">${what} · ${r.done} of ${r.total}</span>
    <button class="mdr-round-x" data-round="dismiss-round" title="Hide" aria-label="Hide the Send to Claude progress"></button></div>
    <div class="mdr-round-bar" role="progressbar" aria-label="Threads answered" aria-valuemin="0" aria-valuemax="${r.total}" aria-valuenow="${r.done}"><span style="width:${pct}%"></span></div>`;
}
