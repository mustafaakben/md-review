// Outline pane: the document's headings, with the current section tracked
// while scrolling and a count of open threads in each section.

export interface Outline {
  /** Rebuild from the freshly painted document. */
  rebuild(): void;
  setOpen(open: boolean): void;
  isOpen(): boolean;
}

export function createOutline(doc: HTMLElement, pane: HTMLElement, onToggle: (open: boolean) => void): Outline {
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

  pane.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.closest('[data-act="close-outline"]')) return api.setOpen(false);
    const item = t.closest('.mdr-toc-item') as HTMLElement | null;
    if (!item) return;
    const h = heads[Number(item.dataset.i)];
    h?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  const api: Outline = {
    rebuild() {
      heads = Array.from(doc.querySelectorAll('h1, h2, h3, h4')) as HTMLElement[];
      // Open (non-resolved) threads per section, in one document-order pass.
      const counts = new Array(heads.length).fill(0);
      const seen = new Set<string>();
      let sec = -1;
      for (const el of Array.from(doc.querySelectorAll('h1, h2, h3, h4, mark.mdr-hl')) as HTMLElement[]) {
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
          const text = (h.textContent || '').trim() || '(untitled)';
          const n = counts[i] ? `<span class="mdr-toc-count" title="${counts[i]} open thread${counts[i] > 1 ? 's' : ''}">${counts[i]}</span>` : '';
          return `<div class="mdr-toc-item lvl${lvl}" data-i="${i}" title="${esc(text)}"><span class="mdr-toc-text">${esc(text)}</span>${n}</div>`;
        })
        .join('');
      pane.innerHTML = `<div class="mdr-pane-head"><span>Outline</span><button data-act="close-outline" title="Hide outline (Ctrl+Shift+O)" aria-label="Hide outline">✕</button></div>
        ${items || '<div class="mdr-empty">No headings in this document.</div>'}`;
      current = -1;
      track();
    },
    setOpen(open) {
      document.body.classList.toggle('mdr-outline-closed', !open);
      onToggle(open);
      if (open) {
        current = -1;
        track();
      }
    },
    isOpen: () => !document.body.classList.contains('mdr-outline-closed'),
  };
  return api;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
