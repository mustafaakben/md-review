// Live agent status: the "Claude is working · 2 of 5" banner over the threads,
// the summary when the round ends, and which threads Claude is on right now.

export interface Round { total: number; done: number; resolved: number; questions: number; finished: boolean }

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

export function roundBanner(r: Round | null, working: boolean): string {
  if (!r) return '';
  if (r.finished) {
    const q = r.questions ? `, ${plural(r.questions, 'question')} for you` : '';
    return `<div class="mdr-round-row"><span class="mdr-round-icon done" aria-hidden="true"></span>
      <span class="mdr-round-text">Claude finished: ${r.resolved} resolved${q}</span></div>
      <div class="mdr-round-row mdr-round-actions">${r.questions ? `<button data-round="questions">Show questions</button>` : ''}<button data-round="dismiss">Dismiss</button></div>`;
  }
  const pct = r.total ? Math.round((100 * r.done) / r.total) : 0;
  const what = working ? 'Claude is working' : 'Waiting for Claude';
  return `<div class="mdr-round-row"><span class="mdr-round-dot${working ? ' live' : ''}" aria-hidden="true"></span>
    <span class="mdr-round-text">${what} · ${r.done} of ${r.total}</span>
    <button class="mdr-round-x" data-round="dismiss" title="Hide" aria-label="Hide progress"></button></div>
    <div class="mdr-round-bar" role="progressbar" aria-label="Threads answered" aria-valuemin="0" aria-valuemax="${r.total}" aria-valuenow="${r.done}"><span style="width:${pct}%"></span></div>`;
}
