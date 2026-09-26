// Live agent status: the "Claude is working · 2 of 5" banner over the threads,
// the summary when the round ends, and which threads Claude is on right now.

export interface Round {
  total: number; done: number; resolved: number; questions: number; suggestions: number; questionIds: string[]; finished: boolean;
  /** A Review with Claude run: total is the drafts Claude has left so far. */
  review?: boolean; startedAt?: string;
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
 * A review run has no list of threads to finish, so it counts as live while
 * Claude keeps adding drafts: until FRESH_MS after the start or its newest one.
 * Returns ms until it goes quiet, or null when it already has.
 */
export function reviewLeft(r: Round, list: { origin?: string; createdAt: string }[], now = Date.now()): number | null {
  let last = Date.parse(r.startedAt || '') || 0;
  for (const c of list) if (c.origin === 'agent') last = Math.max(last, Date.parse(c.createdAt) || 0);
  const left = last + FRESH_MS - now;
  return left > 0 ? left : null;
}

function reviewBanner(r: Round, live: boolean): string {
  const show = r.total ? `<button data-round="from-claude">Show them</button>` : '';
  if (live && !r.finished) {
    return `<div class="mdr-round-row"><span class="mdr-round-dot live" aria-hidden="true"></span>
      <span class="mdr-round-text">Claude is reviewing · ${plural(r.total, 'comment')} so far</span>
      <button class="mdr-round-x" data-round="dismiss" title="Hide" aria-label="Hide progress"></button></div>`;
  }
  const text = r.total ? `Claude left ${plural(r.total, 'comment')} for you to triage` : 'No comments from Claude yet';
  return `<div class="mdr-round-row"><span class="mdr-round-icon${r.total ? ' done' : ''}" aria-hidden="true"></span>
    <span class="mdr-round-text">${text}</span></div>
    <div class="mdr-round-row mdr-round-actions">${show}<button data-round="dismiss">Dismiss</button></div>`;
}

export function roundBanner(r: Round | null, working: boolean): string {
  if (!r) return '';
  if (r.review) return reviewBanner(r, working);
  if (r.finished) {
    const yours = [r.suggestions && plural(r.suggestions, 'suggested edit'), r.questions && plural(r.questions, 'question')].filter(Boolean);
    const q = yours.length ? `, ${yours.join(' and ')} for you` : '';
    return `<div class="mdr-round-row"><span class="mdr-round-icon done" aria-hidden="true"></span>
      <span class="mdr-round-text">Claude finished: ${r.resolved} resolved${q}</span></div>
      <div class="mdr-round-row mdr-round-actions">${r.questionIds.length ? `<button data-round="questions">${r.suggestions ? 'Show them' : 'Show questions'}</button>` : ''}<button data-round="dismiss">Dismiss</button></div>`;
  }
  const pct = r.total ? Math.round((100 * r.done) / r.total) : 0;
  const what = working ? 'Claude is working' : 'Waiting for Claude';
  return `<div class="mdr-round-row"><span class="mdr-round-dot${working ? ' live' : ''}" aria-hidden="true"></span>
    <span class="mdr-round-text">${what} · ${r.done} of ${r.total}</span>
    <button class="mdr-round-x" data-round="dismiss" title="Hide" aria-label="Hide progress"></button></div>
    <div class="mdr-round-bar" role="progressbar" aria-label="Threads answered" aria-valuemin="0" aria-valuemax="${r.total}" aria-valuenow="${r.done}"><span style="width:${pct}%"></span></div>`;
}
