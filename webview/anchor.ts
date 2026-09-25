// Text-quote anchoring (W3C TextQuoteSelector style) over the rendered DOM.
// Capture and re-anchoring both use the same text-node walk, so offsets agree.

const SKIP = '.katex-mathml, .mdr-ui, .mdr-block-editor, script, style';
const CONTEXT = 32;

export interface TextMap {
  text: string;
  nodes: Text[];
  starts: number[];
}

export function buildTextMap(root: Element): TextMap {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      return p && p.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  return { text, nodes, starts };
}

/** Global text offset of a DOM boundary point. */
export function offsetOf(map: TextMap, container: Node, offset: number): number {
  if (container.nodeType === Node.TEXT_NODE) {
    const i = map.nodes.indexOf(container as Text);
    if (i >= 0) return map.starts[i] + Math.min(offset, (container as Text).length);
  }
  const r = document.createRange();
  r.setStart(container, offset);
  for (let i = 0; i < map.nodes.length; i++) {
    if (r.comparePoint(map.nodes[i], 0) >= 0) return map.starts[i];
  }
  return map.text.length;
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

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function bestMatch(text: string, quote: string, prefix: string, suffix: string): [number, number, number] | null {
  if (!quote) return null;
  let best: [number, number, number] | null = null;
  let bestScore = -1;
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
    const e = i + quote.length;
    const score =
      commonSuffix(text.slice(Math.max(0, i - prefix.length), i), prefix) +
      commonPrefix(text.slice(e, e + suffix.length), suffix);
    if (score > bestScore) {
      bestScore = score;
      best = [i, e, score];
    }
  }
  return best;
}

function collapse(s: string): { out: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) {
      if (!space) {
        out += ' ';
        map.push(i);
      }
      space = true;
    } else {
      out += s[i];
      map.push(i);
      space = false;
    }
  }
  map.push(s.length);
  return { out, map };
}

/**
 * A match is trusted if the quote is long enough to be distinctive on its own,
 * or if enough of the surrounding context still agrees. Otherwise a short quote
 * that now only appears elsewhere (e.g. in the reference list) would silently
 * jump there; we'd rather show it as orphaned.
 */
function trusted(quote: string, prefix: string, suffix: string, score: number): boolean {
  if (quote.trim().length >= 60) return true;
  const need = Math.min(8, Math.floor((prefix.length + suffix.length) / 4));
  return score >= need;
}

/** Find the anchor in the current text. Exact first, then whitespace-insensitive. */
export function locate(text: string, a: { quote: string; prefix: string; suffix: string }): [number, number] | null {
  const exact = bestMatch(text, a.quote, a.prefix, a.suffix);
  if (exact && trusted(a.quote, a.prefix, a.suffix, exact[2])) return [exact[0], exact[1]];
  const t = collapse(text);
  const q = collapse(a.quote.trim()).out;
  const pre = collapse(a.prefix).out;
  const suf = collapse(a.suffix).out;
  const m = bestMatch(t.out, q, pre, suf);
  if (!m || !trusted(q, pre, suf, m[2])) return null;
  return [t.map[m[0]], t.map[m[1] - 1] + 1];
}

/** Wrap [start, end) in elements produced by make(); returns the created elements. */
export function wrapRange(root: Element, start: number, end: number, make: () => HTMLElement): HTMLElement[] {
  const map = buildTextMap(root);
  const out: HTMLElement[] = [];
  for (let i = 0; i < map.nodes.length; i++) {
    const node = map.nodes[i];
    const ns = map.starts[i];
    const ne = ns + node.length;
    if (ne <= start || ns >= end) continue;
    const s = Math.max(start, ns) - ns;
    const e = Math.min(end, ne) - ns;
    const seg = node.data.slice(s, e);
    if (!seg.trim()) continue; // don't wrap structural whitespace (e.g. between table rows)
    let target = node;
    if (s > 0) target = target.splitText(s);
    if (e - s < target.length) target.splitText(e - s);
    const el = make();
    target.parentNode!.insertBefore(el, target);
    el.appendChild(target);
    out.push(el);
  }
  return out;
}
