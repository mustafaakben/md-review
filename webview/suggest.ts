// Suggested edits: a replacement for a thread's quote, shown as a small
// redline on the card and applied through the same verified inline-edit path
// as typing in the view.

export interface Suggestion { text: string; appliedAt?: string; dismissedAt?: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "…keep <del>old</del><ins>new</ins> keep…", trimmed to whole words around the change. */
export function suggestionDiff(before: string, after: string): string {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const lead = a.slice(0, p).join('');
  const tail = a.slice(a.length - s).join('');
  const clip = (t: string, end: boolean) => (t.length > 40 ? (end ? t.slice(0, 40) + '…' : '…' + t.slice(-40)) : t);
  const del = a.slice(p, a.length - s).join('');
  const ins = b.slice(p, b.length - s).join('');
  return `${esc(clip(lead, false))}${del ? `<del><span class="mdr-sr">deleted: </span>${esc(del)}</del>` : ''}${ins ? `<ins><span class="mdr-sr">inserted: </span>${esc(ins)}</ins>` : ''}${esc(clip(tail, true))}`;
}

export function suggestionBlock(quote: string, s: Suggestion, from: string, who: string, open: boolean): string {
  const state = s.appliedAt ? '<span class="mdr-sugg-state">Applied</span>' : s.dismissedAt ? '<span class="mdr-sugg-state">Dismissed</span>' : '';
  const acts = open
    ? `<div class="mdr-row"><button class="mdr-primary" data-act="apply-sugg" data-from="${esc(from)}" title="Make this change in the file and resolve the thread" aria-label="Apply ${esc(who)}'s suggestion">Apply</button>${from ? `<button data-act="dismiss-sugg" data-from="${esc(from)}" aria-label="Dismiss ${esc(who)}'s suggestion">Dismiss</button>` : ''}</div>`
    : '';
  const diff = s.text ? suggestionDiff(quote, s.text) : `<del><span class="mdr-sr">deleted: </span>${esc(quote)}</del>`;
  return `<div class="mdr-sugg${open ? '' : ' done'}"><div class="mdr-sugg-head">${esc(who)} suggests${s.text ? '' : ' deleting'}${state}</div><div class="mdr-sugg-diff">${diff}</div>${acts}</div>`;
}

export interface ApplyEdit { ls: number; le: number; kind: string; oldText: string; newText: string }

/**
 * The block edit that replaces thread `id`'s highlighted text with `text`, or a
 * reason it can't be done in place (the quote spans blocks, sits in math, …).
 */
export function suggestionEdit(doc: HTMLElement, id: string, text: string, kindOf: (el: HTMLElement) => string | null): ApplyEdit | string {
  text = text.replace(/\s*\n\s*/g, ' '); // a line break could change the block's structure
  const marks = Array.from(doc.querySelectorAll<HTMLElement>(`mark.mdr-hl[data-cid="${CSS.escape(id)}"]`));
  if (!marks.length) return "The quoted text isn't in the document any more.";
  const block = marks[0].closest<HTMLElement>('[data-ls]');
  if (!block || marks.some((m) => m.closest('[data-ls]') !== block)) return 'The quote spans more than one block.';
  const kind = kindOf(block);
  if (!kind) return 'This block has math, citations or other generated text.';
  const r = document.createRange();
  r.setStart(block, 0);
  r.setEndBefore(marks[0]);
  const start = r.toString().length;
  r.setEndAfter(marks[marks.length - 1]);
  const end = r.toString().length;
  const oldText = block.textContent || '';
  return { ls: Number(block.dataset.ls), le: Number(block.dataset.le), kind, oldText, newText: oldText.slice(0, start) + text + oldText.slice(end) };
}
