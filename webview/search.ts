// Find in document. Matches are painted with the CSS Custom Highlight API, so
// searching never touches the document DOM (no conflict with comment marks or
// editing) and a repaint only has to recompute ranges.
import { buildTextMap, TextMap } from './anchor';

const MAX_MATCHES = 5000;

declare const Highlight: any;
const highlights: Map<string, unknown> | undefined = (globalThis as any).CSS?.highlights;

function rangeAt(map: TextMap, start: number, end: number): Range | null {
  const at = (off: number, isEnd: boolean): [Text, number] | null => {
    let lo = 0;
    let hi = map.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (map.starts[mid] < off || (!isEnd && map.starts[mid] === off)) lo = mid;
      else hi = mid - 1;
    }
    const n = map.nodes[lo];
    return n ? [n, Math.min(off - map.starts[lo], n.length)] : null;
  };
  const a = at(start, false);
  const b = at(end, true);
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a[0], a[1]);
  r.setEnd(b[0], b[1]);
  return r;
}

export interface Search {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Recompute matches after the document was repainted. */
  refresh(): void;
}

export function createSearch(doc: HTMLElement, bar: HTMLElement): Search {
  bar.innerHTML = `<input type="search" placeholder="Find in document" aria-label="Find in document" spellcheck="false">
    <span class="mdr-find-count"></span>
    <button data-find="prev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
    <button data-find="next" title="Next match (Enter)" aria-label="Next match">↓</button>
    <button data-find="close" title="Close (Esc)" aria-label="Close">✕</button>`;
  const input = bar.querySelector('input') as HTMLInputElement;
  const countEl = bar.querySelector('.mdr-find-count') as HTMLElement;
  let ranges: Range[] = [];
  let index = -1;
  let timer: any;

  function paintHighlights() {
    if (!highlights) return;
    highlights.delete('mdr-find');
    highlights.delete('mdr-find-current');
    if (!ranges.length) return;
    highlights.set('mdr-find', new Highlight(...ranges));
    if (index >= 0) highlights.set('mdr-find-current', new Highlight(ranges[index]));
  }

  function showCount() {
    const q = input.value;
    countEl.textContent = !q ? '' : ranges.length ? `${index + 1} of ${ranges.length}${ranges.length >= MAX_MATCHES ? '+' : ''}` : 'No results';
    bar.classList.toggle('none', !!q && !ranges.length);
  }

  function reveal() {
    const r = ranges[index];
    if (!r) return;
    const rect = r.getBoundingClientRect();
    if (rect.top < 70 || rect.bottom > window.innerHeight - 40) {
      window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3, behavior: 'smooth' });
    }
  }

  function compute(keepIndex: boolean) {
    const q = input.value;
    const prev = index;
    ranges = [];
    index = -1;
    if (q) {
      const map = buildTextMap(doc);
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
      for (let m = re.exec(map.text); m && ranges.length < MAX_MATCHES; m = re.exec(map.text)) {
        if (!m[0].length) {
          re.lastIndex++;
          continue;
        }
        const r = rangeAt(map, m.index, m.index + m[0].length);
        if (r) ranges.push(r);
      }
      if (ranges.length) {
        if (keepIndex && prev >= 0) index = Math.min(prev, ranges.length - 1);
        else {
          // Start from the first match below the top of the viewport.
          index = ranges.findIndex((r) => r.getBoundingClientRect().top >= 60);
          if (index < 0) index = 0;
        }
      }
    }
    paintHighlights();
    showCount();
  }

  function step(d: number) {
    if (!ranges.length) return;
    index = (index + d + ranges.length) % ranges.length;
    paintHighlights();
    showCount();
    reveal();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      compute(false);
      reveal();
    }, 60);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      if (index < 0) compute(false);
      step(e.shiftKey ? -1 : index < 0 ? 0 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      api.close();
    }
  });
  bar.addEventListener('click', (e) => {
    const act = (e.target as Element).closest('[data-find]')?.getAttribute('data-find');
    if (act === 'next') step(1);
    else if (act === 'prev') step(-1);
    else if (act === 'close') api.close();
  });

  const api: Search = {
    open() {
      const sel = window.getSelection()?.toString().trim();
      if (sel && !sel.includes('\n') && sel.length < 200) input.value = sel;
      bar.hidden = false;
      input.focus();
      input.select();
      compute(false);
      reveal();
    },
    close() {
      clearTimeout(timer);
      bar.hidden = true;
      ranges = [];
      index = -1;
      paintHighlights();
    },
    isOpen: () => !bar.hidden,
    refresh() {
      if (!bar.hidden && input.value) compute(true);
    },
  };
  return api;
}
