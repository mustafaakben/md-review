import type { Text } from '@codemirror/state';

export interface AnchoredThread {
  id: string; status: string; scope?: string;
  anchor: { quote: string; lineStart: number; lineEnd: number };
}
type Range = { from: number; to: number };
function sameAnchors(a: readonly AnchoredThread[], b: readonly AnchoredThread[]): boolean {
  return a.length === b.length && a.every((c, i) => c.id === b[i].id && c.scope === b[i].scope &&
    c.anchor.quote === b[i].anchor.quote && c.anchor.lineStart === b[i].anchor.lineStart && c.anchor.lineEnd === b[i].anchor.lineEnd);
}
/** Replies, authors and working timestamps do not change editor decorations. */
export function sameThreadDecorations(a: readonly AnchoredThread[], b: readonly AnchoredThread[]): boolean {
  return sameAnchors(a, b) && a.every((c, i) => c.status === b[i].status);
}

/** Cache only the current immutable document and anchor set; no unbounded history. */
export class ThreadRangeCache {
  private doc?: Text;
  private source = '';
  private sourceReady = false;
  private anchors: AnchoredThread[] = [];
  private ranges: ReadonlyMap<string, Range> = new Map();
  resolve(doc: Text, threads: readonly AnchoredThread[]): ReadonlyMap<string, Range> {
    if (doc === this.doc && sameAnchors(this.anchors, threads)) return this.ranges;
    if (doc !== this.doc) { this.source = ''; this.sourceReady = false; }
    this.doc = doc;
    this.anchors = threads.map(c => ({ id: c.id, status: c.status, scope: c.scope, anchor: { ...c.anchor } }));
    const ranges = new Map<string, Range>();
    for (const thread of threads) {
      if (thread.scope === 'document' || !thread.anchor.quote) continue;
      if (!this.sourceReady) { this.source = doc.toString(); this.sourceReady = true; }
      const start = doc.line(Math.max(1, Math.min(doc.lines, thread.anchor.lineStart || 1))).from;
      const end = doc.line(Math.max(1, Math.min(doc.lines, thread.anchor.lineEnd || 1))).to;
      let found = -1, distance = Infinity;
      // Ascending positions preserve the original tie-break: the earlier quote wins.
      for (let at = this.source.indexOf(thread.anchor.quote); at >= 0; at = this.source.indexOf(thread.anchor.quote, at + 1)) {
        const delta = Math.abs(at - start);
        if (delta < distance) { found = at; distance = delta; }
        if (at >= start) break; // Every later occurrence is further from the hint.
      }
      const from = found < 0 ? start : found;
      const to = found < 0 ? end : from + thread.anchor.quote.length;
      if (from < to) ranges.set(thread.id, { from, to });
    }
    this.ranges = ranges;
    return ranges;
  }
}

/** Cheap rejection before parsing HTML; false positives are harmless. */
export function needsPreviewParse(html: string): boolean {
  return /<(?:table|pre|img|section)\b|katex|mdr-front|mdr-cite|mdr-xref|mdr-refs|footnotes/i.test(html);
}
