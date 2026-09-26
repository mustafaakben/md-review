// Outline pane: the document's headings, with the current section tracked
// while scrolling and a count of open threads in each section.

import { tip } from './keys';
import { reveal } from './reveal';

export interface Outline {
  /** Rebuild from the freshly painted document. */
  rebuild(): void;
  /** `focus`: move keyboard focus into the pane (open) or back to its toggle (close). */
  setOpen(open: boolean, focus?: boolean): void;
  isOpen(): boolean;
}

export function createOutline(
  doc: HTMLElement,
  pane: HTMLElement,
  onToggle: (open: boolean) => void,
  toggleBtn?: HTMLElement,
): Outline {
  let heads: HTMLElement[] = [];
  let current = -1;
  let raf = 0;

  function track() {
    raf = 0;
    if (!heads.length || document.body.classList.contains('mdr-outline-closed')) return;
    let i = 0;
    // Binary search for the last heading above the reading line.
    let lo = 0;
    let hi = heads.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (heads[mid].getBoundingClientRect().top <= 90) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (i === current) return;
    pane.querySelector('.mdr-toc-item.current')?.classList.remove('current');
    const item = pane.querySelector(`.mdr-toc-item[data-i="${i}"]`) as HTMLElement | null;
    item?.classList.add('current');
    item?.setAttribute('aria-current', 'location');
    pane.querySelector('[aria-current]:not(.current)')?.removeAttribute('aria-current');
    // Tab into the outline lands on the current section, unless focus is already inside.
    if (item && !pane.contains(document.activeElement)) focusItem(item, false);
    // Keep the current item visible without scrolling the page.
    if (item) {
      const pr = pane.getBoundingClientRect();
      const ir = item.getBoundingClientRect();
      if (ir.top < pr.top + 30 || ir.bottom > pr.bottom) pane.scrollTop += ir.top - pr.top - pr.height / 3;
    }
    current = i;
  }

  window.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(track);
  }, { passive: true });

  // Below 1000px the pane floats over the document, so a jump also closes it.
  const floating = window.matchMedia('(max-width: 1000px)');

  function jump(item: HTMLElement, viaKeyboard: boolean) {
    const h = heads[Number(item.dataset.i)];
    if (!h) return;
    reveal(h, 'start');
    if (viaKeyboard) {
      // Move focus to the heading so reading (and Tab) continues from there.
      if (!h.hasAttribute('tabindex')) h.tabIndex = -1;
      h.focus({ preventScroll: true });
    }
    if (floating.matches) api.setOpen(false);
  }

  pane.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.closest('[data-act="close-outline"]')) return api.setOpen(false, true);
    const item = t.closest('.mdr-toc-item') as HTMLElement | null;
    if (item) jump(item, e.detail === 0);
  });

  // Keyboard: arrows move between entries, Enter/Space jumps, Escape closes.
  pane.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return; // Alt+arrows jump between comments
    const item = (e.target as Element).closest('.mdr-toc-item') as HTMLElement | null;
    const items = Array.from(pane.querySelectorAll('.mdr-toc-item')) as HTMLElement[];
    const at = item ? items.indexOf(item) : -1;
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(items.length - 1, at + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (item && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      return jump(item, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return api.setOpen(false, true);
    }
    if (next < 0 || !items[next]) return;
    e.preventDefault();
    focusItem(items[next]);
  });

  /** Roving tabindex: exactly one entry is reachable with Tab. */
  function focusItem(item: HTMLElement | null, move = true) {
    if (!item) return;
    pane.querySelectorAll('.mdr-toc-item[tabindex="0"]').forEach((x) => x.setAttribute('tabindex', '-1'));
    item.setAttribute('tabindex', '0');
    if (move) item.focus();
  }

  const api: Outline = {
    rebuild() {
      // Headings in UI (a Changes before view) aren't the document's.
      const own = (e: Element) => !e.closest('.mdr-ui');
      heads = (Array.from(doc.querySelectorAll('h1, h2, h3, h4')) as HTMLElement[]).filter(own);
      // Open (non-resolved) threads per section, in one document-order pass.
      const counts = new Array(heads.length).fill(0);
      const seen = new Set<string>();
      let sec = -1;
      for (const el of (Array.from(doc.querySelectorAll('h1, h2, h3, h4, mark.mdr-hl')) as HTMLElement[]).filter(own)) {
        if (el.tagName !== 'MARK') {
          sec++;
          continue;
        }
        const id = el.dataset.cid!;
        if (sec < 0 || seen.has(id) || el.classList.contains('mdr-resolved')) continue;
        seen.add(id);
        counts[sec]++;
      }
      const min = heads.reduce((m, h) => Math.min(m, Number(h.tagName[1])), 6);
      const items = heads
        .map((h, i) => {
          const lvl = Number(h.tagName[1]) - min;
          const text = textOf(h).trim() || '(untitled)';
          const n = counts[i] ? `<span class="mdr-toc-count" title="${counts[i]} open thread${counts[i] > 1 ? 's' : ''}">${counts[i]}</span>` : '';
          return `<div class="mdr-toc-item lvl${lvl}" data-i="${i}" role="link" tabindex="${i === 0 ? 0 : -1}" title="${esc(text)}"><span class="mdr-toc-text">${esc(text)}</span>${n}</div>`;
        })
        .join('');
      const focused = (document.activeElement as HTMLElement | null)?.closest?.('.mdr-toc-item') as HTMLElement | null;
      const refocus = focused && pane.contains(focused) ? focused.dataset.i : null;
      pane.innerHTML = `<div class="mdr-pane-head"><span>Outline</span><button data-act="close-outline" title="${tip('Hide outline', 'Mod+Shift+O')}" aria-label="Hide outline">✕</button></div>
        ${items || '<div class="mdr-empty">No headings in this document.</div>'}`;
      current = -1;
      track();
      if (refocus !== null) focusItem(pane.querySelector(`.mdr-toc-item[data-i="${refocus}"]`) as HTMLElement | null);
    },
    setOpen(open, focus = false) {
      const wasInside = pane.contains(document.activeElement);
      document.body.classList.toggle('mdr-outline-closed', !open);
      toggleBtn?.setAttribute('aria-expanded', String(open));
      onToggle(open);
      if (open) {
        current = -1;
        track();
        if (focus) ((pane.querySelector('.mdr-toc-item[tabindex="0"]') || pane.querySelector('button')) as HTMLElement | null)?.focus();
      } else if (focus) toggleBtn?.focus();
      else if (wasInside) (document.activeElement as HTMLElement | null)?.blur();
    },
    isOpen: () => !document.body.classList.contains('mdr-outline-closed'),
  };
  return api;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A heading's text without UI inside it (a Changes chip, struck-out words). */
function textOf(h: HTMLElement): string {
  if (!h.querySelector('.mdr-ui')) return h.textContent || '';
  const c = h.cloneNode(true) as HTMLElement;
  c.querySelectorAll('.mdr-ui').forEach((x) => x.remove());
  return c.textContent || '';
}
