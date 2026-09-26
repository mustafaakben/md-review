// Changes view ("redlines"): what changed in the Markdown since a saved
// baseline. The host matches blocks on their source lines and hands the view a
// list of hunks; the view word-diffs only the blocks that changed.
import * as crypto from 'crypto';
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { createRenderer } from './render';
import { diffSeq, Edit } from './wordDiff';
import type { BaselineHook } from './baselineStore';

/** A block of source lines [ls, le) and its token type ('paragraph', 'li', 'table', 'fence', …). */
export interface Block {
  ls: number;
  le: number;
  type: string;
}

export interface Hunk {
  /** 'source': lines outside any block changed (a link definition), which render as nothing. */
  kind: 'changed' | 'inserted' | 'deleted' | 'source';
  /** The same block was deleted in one place and inserted in another. */
  moved?: boolean;
  /** For a move, the index of its other half: Keep and Revert settle both. */
  pair?: number;
  /** The block in the current file and in the baseline, to find in each rendered view. */
  cur?: Block;
  base?: Block;
  /** Lines [start, end) that Revert copies from the baseline (b) over the file (c), and Keep the other way. One may be empty. */
  c: [number, number];
  b: [number, number];
  /** For a source change, its lines in the baseline and in the file, for the view to show as they are. */
  was?: string;
  now?: string;
}

/**
 * The copy of the file taken when the review was sent. Only these details
 * live in workspace state; the bytes are kept in a file of their own.
 */
export interface Baseline {
  /** Names this copy's text (see textId). */
  id: string;
  at: string;
  /** The threads sent to the agent while this baseline was current. */
  threads: string[];
  /** Where each thread's text was in the baseline, as lines [start, end): Show change looks for changes there. */
  spans?: Record<string, [number, number]>;
  /** Every change shown was kept or reverted: the next Send starts a new baseline. */
  settled?: boolean;
}

/** Files larger than this get no baseline. */
export const MAX_BASELINE_BYTES = 4 * 1024 * 1024;

export const sha1 = (b: Buffer | string) => crypto.createHash('sha1').update(b).digest('hex');

/** A text without its BOM, with LF line breaks: what two copies are compared as. */
export const normText = (s: string) => s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
export const textId = (s: string) => sha1(normText(s));

/** A baseline's line spans after lines [lo, at) became `delta` more (or fewer) lines. A span the change touches ends where the new lines do. */
export function shiftSpans(spans: Record<string, [number, number]> | undefined, lo: number, at: number, delta: number): Record<string, [number, number]> | undefined {
  if (!spans) return spans;
  const out: Record<string, [number, number]> = {};
  for (const [id, [s, e]] of Object.entries(spans)) {
    out[id] = s >= at ? [s + delta, e + delta] : e <= lo ? [s, e] : [Math.min(s, lo), Math.max(e > at ? e + delta : at + delta, lo)];
  }
  return out;
}

/** A thread's lines [start, end) in the file, from its anchor. */
export const threadSpan = (a: { lineStart: number; lineEnd: number }): [number, number] => [Math.max(0, a.lineStart - 1), Math.max(a.lineStart, a.lineEnd)];

/**
 * The baseline a Send saves, for `text` and the threads sent. While the
 * current one (`cur`) still has changes to review, or Claude hasn't changed
 * anything yet, it stays (nothing an earlier round changed drops out of view)
 * and the new threads join it; otherwise the copy is `text`, with bytes to
 * write. `changes` is asked only for an unreviewed `cur`: the hunks of `text`
 * against it, null for the same text, undefined when its copy is gone. Null
 * when the file is too large to keep a copy of.
 */
export function sendBaseline(
  cur: Baseline | undefined,
  changes: () => Hunk[] | null | undefined,
  threads: { id: string; anchor: { lineStart: number; lineEnd: number } }[],
  text: string,
): { baseline: Baseline; bytes?: Buffer } | null {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_BASELINE_BYTES) return null;
  const ids = threads.map((c) => c.id);
  const hunks = cur && !cur.settled ? changes() : undefined;
  if (cur && hunks !== undefined && (!hunks || hunks.length)) {
    // The new threads' lines are the file's: find them in the baseline.
    const spans = { ...cur.spans };
    for (const c of threads) if (!spans[c.id]) spans[c.id] = baseSpan(hunks ?? [], threadSpan(c.anchor));
    return { baseline: { ...cur, threads: [...new Set([...cur.threads, ...ids])], spans } };
  }
  const spans = Object.fromEntries(threads.map((c) => [c.id, threadSpan(c.anchor)]));
  return { baseline: { id: textId(text), at: new Date().toISOString(), threads: ids, spans }, bytes };
}

/** Save what a Send saves (see sendBaseline) into a file's baseline, with no session open on it. False when the file is too large. */
export function saveSendBaseline(hook: BaselineHook, threads: { id: string; anchor: { lineStart: number; lineEnd: number } }[], text: string): boolean {
  if (!threads.length) return true;
  const next = sendBaseline(hook.get(), () => {
    const bytes = hook.read();
    if (!bytes) return undefined;
    const base = normText(bytes.toString('utf8'));
    return base === normText(text) ? null : diffBlocks(base, text);
  }, threads, text);
  if (next) hook.set(next.baseline, next.bytes);
  return !!next;
}

let parser: MarkdownIt | undefined;

/**
 * The leaf blocks of a document, in source order: paragraphs, headings, list
 * items (their text), tables, code, math, HTML and rules. Containers (lists,
 * quotes) contribute their blocks.
 */
export function blocksOf(text: string): Block[] {
  // No bibliography is read: blocks need only the source lines.
  return blocksOfTokens((parser ||= createRenderer((s) => s)).parse(text, { bibRoots: [] }));
}

export function blocksOfTokens(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.map || t.type === 'inline' || t.nesting === -1) continue;
    if (t.nesting === 0) {
      out.push({ ls: t.map[0], le: t.map[1], type: t.type });
      continue;
    }
    if (!/^(paragraph|heading|table)_open$/.test(t.type)) continue; // a container: its blocks follow
    // A tight list item's text renders without a <p>; the view marks its <li>.
    out.push({ ls: t.map[0], le: t.map[1], type: t.hidden ? 'li' : t.type.slice(0, -5) });
    for (let depth = 1; depth > 0 && i + 1 < tokens.length; ) depth += tokens[++i].nesting;
  }
  // Footnotes are moved to the end of the tokens; line ranges need source order.
  out.sort((x, y) => x.ls - y.ls || x.le - y.le);
  let end = 0;
  return out.filter((k) => k.ls >= end && k.le > k.ls && (end = k.le) >= 0);
}

const linesOf = (text: string) => text.replace(/\r\n/g, '\n').split('\n');
/** A blank line, or a quote's bare `>`: what separates blocks. */
const blank = (line: string | undefined) => line !== undefined && /^[\s>]*$/.test(line);

/**
 * Match the blocks of the baseline and the current text on their source.
 * Unchanged blocks pair up in order (a diff over blocks); in each stretch
 * between them, a deleted and an inserted block of the same type are one
 * changed block. A block deleted in one place and inserted verbatim in
 * another is marked moved. The caller can pass blocks it already has.
 *
 * Each hunk also gets the lines Revert and Keep copy. Lines outside blocks
 * (blank lines, link definitions, a quote's bare `>`) that both sides share
 * are fixed points no hunk's lines cross; the rest go with the nearest block,
 * so that settling hunks one at a time, in any order, ends at the other side.
 * Lines of text outside blocks that only one side has (a link definition
 * whose URL changed) are a source hunk of their own: no hunks means no
 * difference but blank lines.
 */
export function diffBlocks(baseText: string, curText: string, baseBlocks = blocksOf(baseText), curBlocks = blocksOf(curText)): Hunk[] {
  const B = baseBlocks;
  const C = curBlocks;
  const bl = linesOf(baseText);
  const cl = linesOf(curText);
  const ids = new Map<string, number>();
  const idOf = (s: string) => {
    let n = ids.get(s);
    if (n === undefined) ids.set(s, (n = ids.size));
    return n;
  };
  const bk = B.map((k) => idOf(bl.slice(k.ls, k.le).join('\n')));
  const ck = C.map((k) => idOf(cl.slice(k.ls, k.le).join('\n')));
  // Too different to match block by block: everything was replaced.
  const script = diffSeq(bk, ck, 2000) ?? [...bk.map(() => -1 as const), ...ck.map(() => 1 as const)];

  // Stretches between unchanged blocks: the blocks deleted and inserted there, and their lines.
  interface Gap { del: number[]; ins: number[]; b: [number, number]; c: [number, number] }
  const gaps: Gap[] = [];
  let gap: Gap = { del: [], ins: [], b: [0, 0], c: [0, 0] };
  let i = 0;
  let j = 0;
  /** The lines of text in [lo, hi): not blank lines, which alone are no change. */
  const texts = (lines: string[], lo: number, hi: number) => lines.slice(lo, hi).filter((l) => !blank(l));
  const close = (b: number, c: number) => {
    gap.b[1] = b;
    gap.c[1] = c;
    if (gap.del.length || gap.ins.length) gaps.push(gap);
    else if (b - gap.b[0] || c - gap.c[0]) {
      // No block here, but the lines between blocks (link definitions) may differ.
      const tb = texts(bl, gap.b[0], b);
      const tc = texts(cl, gap.c[0], c);
      if (tb.length !== tc.length || tb.some((l, k) => l !== tc[k])) gaps.push(gap);
    }
  };
  for (const e of script) {
    if (e === 0) {
      close(B[i].ls, C[j].ls);
      gap = { del: [], ins: [], b: [B[i].le, 0], c: [C[j].le, 0] };
      i++;
      j++;
    } else if (e === -1) gap.del.push(i++);
    else gap.ins.push(j++);
  }
  close(bl.length, cl.length);

  const moved = new Set<string>(); // 'b3', 'c7'
  const gapOf = new Map<number, Gap>();
  const unmatchedDel = new Map<number, number[]>();
  for (const g of gaps) for (const d of g.del) {
    gapOf.set(d, g);
    (unmatchedDel.get(bk[d]) || unmatchedDel.set(bk[d], []).get(bk[d])!).push(d);
  }
  for (const g of gaps) {
    for (const n of g.ins) {
      const list = unmatchedDel.get(ck[n]);
      const d = list?.find((x) => gapOf.get(x) !== g);
      if (d === undefined) continue;
      list!.splice(list!.indexOf(d), 1);
      moved.add('b' + d).add('c' + n);
    }
  }
  // Each block's words, once.
  const bags = new Map<string, Set<string>>();
  const bag = (side: 'b' | 'c', n: number) => {
    let s = bags.get(side + n);
    if (!s) {
      const [lines, k] = side === 'b' ? [bl, B[n]] : [cl, C[n]];
      bags.set(side + n, (s = new Set(lines.slice(k.ls, k.le).join(' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])));
    }
    return s;
  };

  const hunks: Hunk[] = [];
  const del = (d: number, c: [number, number], b: [number, number]) =>
    hunks.push({ kind: 'deleted', moved: moved.has('b' + d) || undefined, base: B[d], c, b });
  const ins = (n: number, c: [number, number], b: [number, number]) =>
    hunks.push({ kind: 'inserted', moved: moved.has('c' + n) || undefined, cur: C[n], c, b });
  /** Lines of text outside blocks one side lacks, as one hunk with those next to them. */
  const source = (b: [number, number], c: [number, number]) => {
    const h = hunks[hunks.length - 1];
    if (h?.kind === 'source' && h.b[1] === b[0] && h.c[1] === c[0]) [h.b[1], h.c[1]] = [b[1], c[1]];
    else hunks.push({ kind: 'source', c, b });
  };
  /** Separator lines that differ with no block among them (a blank line became a bare `>`): they go with a hunk beside them. */
  const loose: { b: [number, number]; c: [number, number] }[] = [];
  // Both files end in a line break: their empty last lines stay put.
  const tails = bl[bl.length - 1] === '' && cl[cl.length - 1] === '' ? 1 : 0;

  interface Tok { id: number; ls: number; le: number; n?: number }
  // A block is one token, a line outside blocks is its text. Both are named by their text, so
  // a line that is a block on one side only (a footnote no longer referenced) isn't a change.
  const tokens = (lines: string[], [lo, hi]: [number, number], blocks: Block[], list: number[], keys: number[]) => {
    const out: Tok[] = [];
    let k = 0;
    for (let l = lo; l < hi; ) {
      while (k < list.length && blocks[list[k]].ls < l) k++;
      const blk = k < list.length && blocks[list[k]].ls === l ? list[k] : undefined;
      if (blk !== undefined) {
        out.push({ id: keys[blk], ls: l, le: blocks[blk].le, n: blk });
        l = blocks[blk].le;
      } else if (l === lines.length - 1 && !lines[l]) out.push({ id: lines === bl ? -1 : -2, ls: l, le: ++l }); // after the last line break: no line to match
      else out.push({ id: idOf(lines[l]), ls: l, le: ++l });
    }
    return out;
  };

  for (const g of gaps) {
    const b: [number, number] = [g.b[0], Math.max(g.b[0], g.b[1] - (g.b[1] === bl.length ? tails : 0))];
    const c: [number, number] = [g.c[0], Math.max(g.c[0], g.c[1] - (g.c[1] === cl.length ? tails : 0))];
    const tb = tokens(bl, b, B, g.del, bk);
    const tc = tokens(cl, c, C, g.ins, ck);
    const text = (t: Tok, lines: string[]) => t.n === undefined && !blank(lines[t.ls]);
    // Lines both sides have, in order, are fixed: first the lines of text outside blocks (link
    // definitions), then between those, blank lines and blocks. Too many differences there: none.
    const xb = tb.filter((t) => text(t, bl));
    const xc = tc.filter((t) => text(t, cl));
    const script: Edit[] = [];
    let x = 0;
    let y = 0;
    const fine = (xe: number, ye: number) => {
      const sb = tb.slice(x, xe);
      const sc = tc.slice(y, ye);
      script.push(...(diffSeq(sb.map((t) => t.id), sc.map((t) => t.id), 500) ?? [...sb.map(() => -1 as const), ...sc.map(() => 1 as const)]));
      x = xe;
      y = ye;
    };
    let i = 0;
    let j = 0;
    for (const e of diffSeq(xb.map((t) => t.id), xc.map((t) => t.id))!) {
      if (e === -1) i++;
      else if (e === 1) j++;
      else {
        fine(tb.indexOf(xb[i++], x), tc.indexOf(xc[j++], y));
        script.push(0);
        x++;
        y++;
      }
    }
    fine(tb.length, tc.length);
    // Runs between fixed lines. A line of text outside blocks (a link definition) that only one side has ends a run too, and is a source hunk.
    x = 0;
    y = 0;
    let at = [b[0], c[0]];
    let run = { b: [] as Tok[], c: [] as Tok[] };
    const flush = (bEnd: number, cEnd: number) => {
      if (run.b.length || run.c.length) stretch(run.b, run.c, [at[0], bEnd], [at[1], cEnd]);
      run = { b: [], c: [] };
    };
    const next = (t: Tok[], k: number, end: number) => (k < t.length ? t[k].ls : end);
    for (const e of script) {
      if (e === 0) {
        flush(tb[x].ls, tc[y].ls);
        at = [tb[x++].le, tc[y++].le];
      } else if (e === -1) {
        const t = tb[x++];
        if (!text(t, bl)) run.b.push(t);
        else {
          const p = next(tc, y, c[1]);
          flush(t.ls, p);
          source([t.ls, t.le], [p, p]);
          at = [t.le, p];
        }
      } else {
        const t = tc[y++];
        if (!text(t, cl)) run.c.push(t);
        else {
          const p = next(tb, x, b[1]);
          flush(p, t.ls);
          source([p, p], [t.ls, t.le]);
          at = [p, t.le];
        }
      }
    }
    flush(b[1], c[1]);
  }

  /**
   * A run of lines between fixed points, [rb) and [rc): its deleted and
   * inserted blocks, and the blank lines around them. A deleted and an
   * inserted block of the same type with words in common are one changed
   * block, a hunk of its own; what lies between changed blocks is shared out.
   */
  function stretch(tb: Tok[], tc: Tok[], rb: [number, number], rc: [number, number]) {
    const ds = tb.filter((t) => t.n !== undefined && !moved.has('b' + t.n)).map((t) => t.n!);
    const ns = tc.filter((t) => t.n !== undefined && !moved.has('c' + t.n)).map((t) => t.n!);
    const pairs = align(ds.map((d) => B[d].type), ns.map((n) => C[n].type), (x, y) => similar(bag('b', ds[x]), bag('c', ns[y])));
    let b0 = rb[0];
    let c0 = rc[0];
    for (let k = 0; k <= pairs.length; k++) {
      const pair = pairs[k];
      const b1 = pair ? B[ds[pair[0]]].ls : rb[1];
      const c1 = pair ? C[ns[pair[1]]].ls : rc[1];
      const sb = tb.filter((t) => t.ls >= b0 && t.ls < b1);
      const sc = tc.filter((t) => t.ls >= c0 && t.ls < c1);
      if (sb.some((t) => t.n !== undefined) || sc.some((t) => t.n !== undefined)) region(sb, sc, [b0, b1], [c0, c1]);
      else if (b1 > b0 || c1 > c0) loose.push({ b: [b0, b1], c: [c0, c1] });
      if (!pair) break;
      const [d, n] = [ds[pair[0]], ns[pair[1]]];
      hunks.push({ kind: 'changed', cur: C[n], base: B[d], c: [C[n].ls, C[n].le], b: [B[d].ls, B[d].le] });
      b0 = B[d].le;
      c0 = C[n].le;
    }
  }

  /**
   * One run of lines between fixed points, [rb) and [rc), and its blocks. What
   * one side lacks goes back in where the other's run starts. A lone block
   * takes the whole run. Among several, a block takes a separator (blank
   * lines) only when it has one on both sides, so removing it never joins
   * its neighbours nor splits a tight list: after a blank line (or at the
   * top) the one after it, after text the one before it.
   */
  function region(tb: { ls: number; n?: number }[], tc: { ls: number; n?: number }[], rb: [number, number], rc: [number, number]) {
    const follow = rb[0] === 0 || blank(bl[rb[0] - 1]);
    const split = (r: [number, number], blocks: Block[], end: number): [number, number][] => {
      let taken = r[0]; // lines before this are the previous block's
      return blocks.map((k, n) => {
        if (blocks.length === 1) return r;
        const lo = Math.max(taken, n ? blocks[n - 1].le : r[0]);
        const hi = n + 1 < blocks.length ? blocks[n + 1].ls : r[1];
        // The top and the end of the file count as separators, with no lines to take.
        const before = k.ls > lo || (!n && lo === 0);
        const after = hi > k.le || (n + 1 === blocks.length && hi >= end);
        const range: [number, number] = !before || !after ? [k.ls, k.le] : (follow ? hi > k.le : k.ls === lo) ? [k.ls, hi] : [lo, k.le];
        taken = range[1];
        return range;
      });
    };
    const ds = tb.filter((t) => t.n !== undefined).map((t) => t.n!);
    const ns = tc.filter((t) => t.n !== undefined).map((t) => t.n!);
    const db = split(rb, ds.map((d) => B[d]), bl.length - tails);
    const nc = split(rc, ns.map((n) => C[n]), cl.length - tails);
    // A side with no blocks still has its lines: the first hunk takes them, and the rest go back after them.
    const at = (r: [number, number], k: number, none: boolean): [number, number] => (!none ? [r[0], r[0]] : k ? [r[1], r[1]] : r);
    ds.forEach((d, k) => del(d, at(rc, k, !ns.length), db[k]));
    ns.forEach((n, k) => ins(n, nc[k], at(rb, k, !ds.length)));
  }

  for (const r of loose) {
    const h = hunks.find((h) => h.c[1] === r.c[0] && h.b[1] === r.b[0]) ?? hunks.find((h) => h.c[0] === r.c[1] && h.b[0] === r.b[1]);
    if (h && h.c[1] === r.c[0] && h.b[1] === r.b[0]) [h.c[1], h.b[1]] = [r.c[1], r.b[1]];
    else if (h) [h.c[0], h.b[0]] = [r.c[0], r.b[0]];
  }
  // The raw lines of each source change, without the blank lines it took along.
  const raw = (lines: string[], [lo, hi]: [number, number]) => texts(lines, lo, hi).join('\n');
  for (const h of hunks) if (h.kind === 'source') [h.was, h.now] = [raw(bl, h.b), raw(cl, h.c)];
  // In reading order; a deletion sits before the block that now follows it.
  hunks.sort((x, y) => x.c[0] - y.c[0] || (x.kind === 'deleted' ? -1 : 0) - (y.kind === 'deleted' ? -1 : 0) || (x.b[0] - y.b[0]));
  // Link the two halves of each move.
  const half = new Map<string, number>();
  hunks.forEach((h, k) => {
    if (!h.moved) return;
    const key = String(h.kind === 'deleted' ? bk[B.indexOf(h.base!)] : ck[C.indexOf(h.cur!)]);
    const other = half.get((h.kind === 'deleted' ? 'i' : 'd') + key);
    if (other !== undefined) {
      h.pair = other;
      hunks[other].pair = k;
      half.delete((h.kind === 'deleted' ? 'i' : 'd') + key);
    } else half.set((h.kind === 'deleted' ? 'd' : 'i') + key, k);
  });
  return hunks;
}

/** Dice overlap of two word sets, 0 to 1. */
function similar(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return (2 * n) / (a.size + b.size);
}

/**
 * Pair deleted and inserted blocks of one stretch as edits of each other: same
 * type, enough words in common, in order, most overlap overall. A very long
 * stretch pairs same-type blocks in order instead.
 */
function align(a: string[], b: string[], score: (x: number, y: number) => number): [number, number][] {
  const out: [number, number][] = [];
  if (!a.length || !b.length) return out;
  if (a.length * b.length > 40000) {
    let from = 0;
    a.forEach((t, x) => {
      const y = b.indexOf(t, from);
      if (y < 0) return;
      out.push([x, y]);
      from = y + 1;
    });
    return out;
  }
  // best[x][y]: the most overlap pairing the first x of a with the first y of b.
  const w = b.length + 1;
  const best = new Float64Array((a.length + 1) * w);
  for (let x = 1; x <= a.length; x++) {
    for (let y = 1; y <= b.length; y++) {
      const v = a[x - 1] === b[y - 1] ? score(x - 1, y - 1) : 0;
      best[x * w + y] = Math.max(best[(x - 1) * w + y], best[x * w + y - 1], v >= 0.3 ? best[(x - 1) * w + y - 1] + v : 0);
    }
  }
  for (let x = a.length, y = b.length; x > 0 && y > 0; ) {
    if (best[x * w + y] === best[(x - 1) * w + y]) x--;
    else if (best[x * w + y] === best[x * w + y - 1]) y--;
    else out.push([--x, --y]);
  }
  return out.reverse();
}

/** Lines [start, end) of the current file, as the baseline's lines, going by the hunks between them. */
export function baseSpan(hunks: Hunk[], [s, e]: [number, number]): [number, number] {
  const at = (l: number, end: boolean) => {
    let d = 0;
    for (const h of hunks) {
      if (h.c[1] <= l && (h.c[0] < h.c[1] || h.c[0] < l || !end)) d += h.b[1] - h.b[0] - (h.c[1] - h.c[0]);
      else if (h.c[0] < l) return end ? h.b[1] : h.b[0]; // inside a change: all of it
    }
    return l + d;
  };
  return [at(s, false), Math.max(at(s, false), at(e, true))];
}

/** The threads whose baseline lines a hunk touches. */
export function touchedThreads(hunks: Hunk[], spans: Record<string, [number, number]> | undefined): string[] {
  return Object.entries(spans ?? {})
    .filter(([, [lo, hi]]) => hunks.some(({ b: [bs, be] }) => (bs === be ? bs >= lo && bs <= hi : bs < hi && be > lo)))
    .map(([id]) => id);
}

/** How many blocks changed; a move counts once. */
export const changedBlocks = (hunks: Hunk[]) => hunks.filter((h) => !(h.moved && h.kind === 'deleted')).length;
