// Thread filters (status, author and severity) shown above the comment list.

export type StatusFilter = 'all' | 'draft' | 'submitted' | 'resolved';

export type SeverityFilter = '' | 'major' | 'minor' | 'nit';

export interface FilterState {
  status: StatusFilter;
  author: string; // '' = everyone
  severity: SeverityFilter; // '' = any
  ids?: string[]; // only these threads (the last round's questions); not remembered
}

interface Filterable {
  id: string;
  author: string;
  status: 'draft' | 'submitted' | 'resolved';
  severity?: string;
  replies: { author: string }[];
}

const SEVERITY: Record<Exclude<SeverityFilter, ''>, string> = { major: 'Major', minor: 'Minor', nit: 'Nit' };

const LABEL: Record<StatusFilter, string> = { all: 'All', draft: 'Drafts', submitted: 'Open', resolved: 'Resolved' };

/**
 * A thread passes when its status matches and the author started it or
 * replied in it. Resolved threads stay hidden under "All" when showResolved is
 * off, but picking "Resolved" always shows them.
 */
export function passes(c: Filterable, f: FilterState, showResolved: boolean): boolean {
  if (f.status === 'all' ? c.status === 'resolved' && !showResolved : c.status !== f.status) return false;
  if (f.severity && c.severity !== f.severity) return false;
  if (f.ids && !f.ids.includes(c.id)) return false;
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

/**
 * Markup for the filter bar; `counts` is per status over the author-filtered
 * set. Severity chips show only once some thread has a severity.
 */
export function filterBar(f: FilterState, authors: string[], counts: Record<StatusFilter, number>, severities: Record<string, number> = {}): string {
  const chips = f.ids
    ? `<button class="mdr-chip on" data-filter-status="all" aria-pressed="true" title="Show all threads">Waiting on you<span>${f.ids.length}</span></button>`
    : (Object.keys(LABEL) as StatusFilter[])
        .map((k) => `<button class="mdr-chip${f.status === k ? ' on' : ''}" data-filter-status="${k}" aria-pressed="${f.status === k}">${LABEL[k]}<span>${counts[k]}</span></button>`)
        .join('');
  const opts = ['<option value="">Everyone</option>']
    .concat(authors.map((a) => `<option value="${esc(a)}"${a === f.author ? ' selected' : ''}>${esc(a)}</option>`))
    .join('');
  const sev = (Object.keys(SEVERITY) as Exclude<SeverityFilter, ''>[])
    .filter((k) => severities[k] || f.severity === k)
    .map((k) => `<button class="mdr-chip mdr-sev-${k}${f.severity === k ? ' on' : ''}" data-filter-severity="${k}" aria-pressed="${f.severity === k}">${SEVERITY[k]}<span>${severities[k] || 0}</span></button>`)
    .join('');
  return `<div class="mdr-chips" role="group" aria-label="Filter by status">${chips}</div>
    ${sev ? `<div class="mdr-chips" role="group" aria-label="Filter by severity">${sev}</div>` : ''}
    ${authors.length > 1 || f.author ? `<select class="mdr-author-filter" aria-label="Filter by author">${opts}</select>` : ''}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
