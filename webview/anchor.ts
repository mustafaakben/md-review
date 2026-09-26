// Text-quote anchoring (W3C TextQuoteSelector style) over the rendered DOM.
// Capture and re-anchoring both use the same text-node walk, so offsets agree.

const SKIP = '.katex-mathml, .mdr-ui, .mdr-block-editor, .mdr-front-raw, script, style';
import { CONTEXT } from '../src/textQuote';
// Re-anchoring is plain string matching, shared with the host (Word export/import).
export { locate } from '../src/textQuote';

export interface TextMap {
  text: string;
  nodes: Text[];
  starts: number[];
  /** Lazily built node -> index lookup (see offsetOf). */
  index?: Map<Text, number>;
}

export function buildTextMap(root: Element): TextMap {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  if (root.closest(SKIP)) return { text, nodes, starts };
  // Walk text nodes only (no per-element callback) and drop the ones inside a
  // skipped subtree, found with one querySelectorAll.
  const skip = new Set(Array.from(root.querySelectorAll(SKIP)));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  outer: for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (skip.size) for (let p = n.parentElement; p && p !== root; p = p.parentElement) if (skip.has(p)) continue outer;
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  return { text, nodes, starts };
}

// One text map per root, reused until the DOM under the root changes. A
// MutationObserver says when it has; its records are read synchronously
// (takeRecords) before each use, so a change made a moment ago is never missed.
interface MapCache {
  obs: MutationObserver;
  map: TextMap | null;
}
const caches = new WeakMap<Element, MapCache>();
const SKIP_CLASS = /(?:^|\s)(?:katex-mathml|mdr-ui|mdr-block-editor|mdr-front-raw)(?:\s|$)/;
function changesText(recs: MutationRecord[]): boolean {
  for (const r of recs) {
    if (r.type !== 'attributes') return true;
    // A class change matters only when it moves an element in or out of SKIP.
    if (SKIP_CLASS.test(r.oldValue || '') || SKIP_CLASS.test((r.target as Element).getAttribute('class') || '')) return true;
  }
  return false;
}

/** The root's text map, rebuilt only when something under the root changed since the last call. */
export function textMap(root: Element): TextMap {
  let c = caches.get(root);
  if (!c) {
    const cache: MapCache = {
      map: null,
      obs: new MutationObserver((recs) => {
        if (changesText(recs)) cache.map = null;
      }),
    };
    cache.obs.observe(root, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    caches.set(root, (c = cache));
  }
  if (changesText(c.obs.takeRecords())) c.map = null;
  return (c.map ??= buildTextMap(root));
}

/** Global text offset of a DOM boundary point. */
export function offsetOf(map: TextMap, container: Node, offset: number): number {
  if (container.nodeType === Node.TEXT_NODE) {
    if (!map.index) {
      map.index = new Map();
      map.nodes.forEach((n, i) => map.index!.set(n, i));
    }
    const i = map.index.get(container as Text);
    if (i !== undefined) return map.starts[i] + Math.min(offset, (container as Text).length);
  }
  const r = document.createRange();
  r.setStart(container, offset);
  // Nodes are in document order, so "starts at or after the point" flips from
  // false to true exactly once: binary search for the first such node.
  let lo = 0;
  let hi = map.nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.comparePoint(map.nodes[mid], 0) >= 0) hi = mid;
    else lo = mid + 1;
  }
  return lo < map.nodes.length ? map.starts[lo] : map.text.length;
}

export interface Captured {
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}

export function capture(map: TextMap, range: Range): Captured | null {
  let start = offsetOf(map, range.startContainer, range.startOffset);
  let end = offsetOf(map, range.endContainer, range.endOffset);
  while (start < end && /\s/.test(map.text[start])) start++;
  while (end > start && /\s/.test(map.text[end - 1])) end--;
  if (end <= start) return null;
  return {
    start,
    end,
    quote: map.text.slice(start, end),
    prefix: map.text.slice(Math.max(0, start - CONTEXT), start),
    suffix: map.text.slice(end, end + CONTEXT),
  };
}

/** Wrap [start, end) in elements produced by make(); returns the created elements. */
export function wrapRange(root: Element, start: number, end: number, make: () => HTMLElement): HTMLElement[] {
  return wrapRanges(root, [{ start, end, make }])[0];
}

export interface WrapSpec {
  start: number;
  end: number;
  make: () => HTMLElement;
}

/**
 * Wrap several ranges, in order, with a single text walk. Equivalent to calling
 * wrapRange() for each spec in turn: the text map is patched in place as nodes
 * split, instead of being rebuilt per range.
 */
/** `map`: the root's current text map, when the caller has it (it is updated as marks go in). */
export function wrapRanges(root: Element, specs: WrapSpec[], map = textMap(root)): HTMLElement[][] {
  const out = specs.map((sp) => wrapInMap(map, sp.start, sp.end, sp.make));
  // The map was patched along with the DOM, so it stays the root's current map:
  // drop the records of our own splits and wraps.
  const c = caches.get(root);
  if (c) {
    c.obs.takeRecords();
    c.map = map;
  }
  return out;
}

function wrapInMap(map: TextMap, start: number, end: number, make: () => HTMLElement): HTMLElement[] {
  const { nodes, starts } = map;
  map.index = undefined;
  const out: HTMLElement[] = [];
  // First node that ends after `start` (node ends are non-decreasing).
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] + nodes[mid].length <= start) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < nodes.length && starts[i] < end; i++) {
    const node = nodes[i];
    const ns = starts[i];
    const s = Math.max(start, ns) - ns;
    const e = Math.min(end, ns + node.length) - ns;
    const seg = node.data.slice(s, e);
    if (!seg.trim()) continue; // don't wrap structural whitespace (e.g. between table rows)
    let target = node;
    if (s > 0) {
      target = target.splitText(s);
      nodes.splice(++i, 0, target);
      starts.splice(i, 0, ns + s);
    }
    if (e - s < target.length) {
      nodes.splice(i + 1, 0, target.splitText(e - s));
      starts.splice(i + 1, 0, ns + e);
    }
    const el = make();
    target.parentNode!.insertBefore(el, target);
    el.appendChild(target);
    out.push(el);
  }
  return out;
}

/** Remove wrapper elements, keeping their contents, and re-merge split text nodes. */
export function unwrap(els: Iterable<Element>): void {
  const parents = new Set<Node>();
  for (const el of els) {
    const p = el.parentNode;
    if (!p) continue;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
    parents.add(p);
  }
  for (const p of parents) if (p.isConnected) p.normalize();
}
