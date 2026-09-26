// Thread filters (status and author) shown above the comment list.

export type StatusFilter = 'all' | 'draft' | 'submitted' | 'resolved';

export interface FilterState {
  status: StatusFilter;
  author: string; // '' = everyone
}

interface Filterable {
  author: string;
  status: 'draft' | 'submitted' | 'resolved';
  replies: { author: string }[];
}

const LABEL: Record<StatusFilter, string> = { all: 'All', draft: 'Drafts', submitted: 'Open', resolved: 'Resolved' };

/**
 * A thread passes when its status matches and the author started it or
 * replied in it. Resolved threads stay hidden under "All" when showResolved is
 * off, but picking "Resolved" always shows them.
 */
export function passes(c: Filterable, f: FilterState, showResolved: boolean): boolean {
  if (f.status === 'all' ? c.status === 'resolved' && !showResolved : c.status !== f.status) return false;
  return !f.author || c.author === f.author || c.replies.some((r) => r.author === f.author);
}

export function authorsOf(comments: Filterable[]): string[] {
  const s = new Set<string>();
  for (const c of comments) {
    s.add(c.author);
    for (const r of c.replies) s.add(r.author);
  }
  return [...s].sort((a, b) => a.localeCompare(b));
}

/** Markup for the filter bar; `counts` is per status over the author-filtered set. */
export function filterBar(f: FilterState, authors: string[], counts: Record<StatusFilter, number>): string {
  const chips = (Object.keys(LABEL) as StatusFilter[])
    .map((k) => `<button class="mdr-chip${f.status === k ? ' on' : ''}" data-filter-status="${k}" aria-pressed="${f.status === k}">${LABEL[k]}<span>${counts[k]}</span></button>`)
    .join('');
  const opts = ['<option value="">Everyone</option>']
    .concat(authors.map((a) => `<option value="${esc(a)}"${a === f.author ? ' selected' : ''}>${esc(a)}</option>`))
    .join('');
  return `<div class="mdr-chips" role="group" aria-label="Filter by status">${chips}</div>
    ${authors.length > 1 || f.author ? `<select class="mdr-author-filter" aria-label="Filter by author">${opts}</select>` : ''}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
