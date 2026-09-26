// Changes view ("redlines"): what changed in the Markdown since a saved
// baseline. The host matches blocks on their source lines and hands the view a
// list of hunks; the view word-diffs only the blocks that changed.
import * as crypto from 'crypto';
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { createRenderer } from './render';
import { diffSeq } from './wordDiff';

/** A block of source lines [ls, le) and its token type ('paragraph', 'li', 'table', 'fence', …). */
export interface Block {
  ls: number;
  le: number;
  type: string;
}

export interface Hunk {
  kind: 'changed' | 'inserted' | 'deleted';
  /** The same block was deleted in one place and inserted in another. */
  moved?: boolean;
  /** The block in the current file and in the baseline, to find in each rendered view. */
  cur?: Block;
  base?: Block;
  /** Lines [start, end) that Revert copies from the baseline (b) over the file (c), and Keep the other way. One may be empty. */
  c: [number, number];
  b: [number, number];
}

/** A copy of the file taken when the review was sent. `data` is the bytes, base64. */
export interface Baseline {
  id: string;
  at: string;
  data: string;
  /** The threads sent to the agent while this baseline was current. */
  threads: string[];
}

export interface Baselines {
  current: Baseline | null;
  /** Accepted baselines, newest first. */
  past: Baseline[];
}

/** At most this many baselines per file (the current one plus accepted ones). */
export const KEEP_BASELINES = 3;
/** Files larger than this get no baseline. */
export const MAX_BASELINE_BYTES = 4 * 1024 * 1024;

export const sha1 = (b: Buffer | string) => crypto.createHash('sha1').update(b).digest('hex');

export function makeBaseline(bytes: Buffer, threads: string[]): Baseline {
  return { id: sha1(bytes), at: new Date().toISOString(), data: bytes.toString('base64'), threads };
}

export const baselineBytes = (b: Baseline) => Buffer.from(b.data, 'base64');
export const baselineText = (b: Baseline) => baselineBytes(b).toString('utf8').replace(/^﻿/, '');

/**
 * On Send: take a new baseline, unless the current one still has changes to
 * review (the file differs from it). Then the older copy stays, so nothing an
 * earlier round changed drops out of the Changes view, and the new threads join it.
 */
export function onSend(s: Baselines, disk: Buffer, ids: string[]): Baselines {
  const cur = s.current;
  if (cur && !baselineBytes(cur).equals(disk)) return { ...s, current: { ...cur, threads: [...new Set([...cur.threads, ...ids])] } };
  return { current: makeBaseline(disk, ids), past: s.past };
}

/** Accept all: the current baseline is done with. */
export function accept(s: Baselines): Baselines {
  return { current: null, past: s.current ? [s.current, ...s.past].slice(0, KEEP_BASELINES - 1) : s.past };
}

let parser: MarkdownIt | undefined;

/**
 * The leaf blocks of a document, in order: paragraphs, headings, list items
 * (their text), tables, code, math, HTML and rules. Containers (lists, quotes)
 * contribute their blocks.
 */
export function blocksOf(text: string): Block[] {
  return blocksOfTokens((parser ||= createRenderer((s) => s)).parse(text, {}));
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
  return out;
}

const linesOf = (text: string) => text.replace(/\r\n/g, '\n').split('\n');

/**
 * Match the blocks of the baseline and the current text on their source.
 * Unchanged blocks pair up in order (a diff over blocks); in each stretch
 * between them, a deleted and an inserted block of the same type are one
 * changed block. A block deleted in one place and inserted verbatim in
 * another is marked moved. The caller can pass blocks it already has.
 */
export function diffBlocks(baseText: string, curText: string, baseBlocks = blocksOf(baseText), curBlocks = blocksOf(curText)): Hunk[] {
  const B = baseBlocks;
  const C = curBlocks;
  const bl = linesOf(baseText);
  const cl = linesOf(curText);
  const ids = new Map<string, number>();
  const key = (lines: string[], k: Block) => {
    const s = lines.slice(k.ls, k.le).join('\n');
    let n = ids.get(s);
    if (n === undefined) ids.set(s, (n = ids.size));
    return n;
  };
  const bk = B.map((k) => key(bl, k));
  const ck = C.map((k) => key(cl, k));
  // Too different to match block by block: everything was replaced.
  const script = diffSeq(bk, ck, 2000) ?? [...bk.map(() => -1 as const), ...ck.map(() => 1 as const)];

  // Counterparts: bOf[j] is the baseline block for current block j (and cOf the reverse).
  const bOf = new Array<number>(C.length).fill(-1);
  const cOf = new Array<number>(B.length).fill(-1);
  const gaps: { del: number[]; ins: number[] }[] = [];
  let gap = { del: [] as number[], ins: [] as number[] };
  let i = 0;
  let j = 0;
  for (const e of script) {
    if (e === 0) {
      if (gap.del.length || gap.ins.length) gaps.push(gap);
      gap = { del: [], ins: [] };
      bOf[j++] = i;
      cOf[i++] = j - 1;
    } else if (e === -1) gap.del.push(i++);
    else gap.ins.push(j++);
  }
  if (gap.del.length || gap.ins.length) gaps.push(gap);

  const moved = new Set<string>(); // 'b3', 'c7'
  const unmatchedDel = new Map<number, number[]>();
  for (const g of gaps) for (const d of g.del) (unmatchedDel.get(bk[d]) || unmatchedDel.set(bk[d], []).get(bk[d])!).push(d);
  for (const g of gaps) {
    for (const n of g.ins) {
      const list = unmatchedDel.get(ck[n]);
      const d = list?.find((x) => !g.del.includes(x));
      if (d === undefined) continue;
      list!.splice(list!.indexOf(d), 1);
      moved.add('b' + d).add('c' + n);
    }
  }
  const pairs: [number, number][] = [];
  const bag = (lines: string[], k: Block) => new Set(lines.slice(k.ls, k.le).join(' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  for (const g of gaps) {
    const dels = g.del.filter((d) => !moved.has('b' + d));
    const ins = g.ins.filter((n) => !moved.has('c' + n));
    for (const [x, y] of align(dels.map((d) => B[d].type), ins.map((n) => C[n].type), (x, y) => similar(bag(bl, B[dels[x]]), bag(cl, C[ins[y]])))) {
      pairs.push([dels[x], ins[y]]);
      bOf[ins[y]] = dels[x];
      cOf[dels[x]] = ins[y];
    }
  }

  // Where a block missing on one side would go on the other: after the other
  // side's copy of the nearest earlier block that has one. The block's own
  // lines include the gap before it then (so removing it leaves one gap), or,
  // with nothing before it, the gap after it.
  const place = (own: Block[], other: Block[], counterpart: number[], ownLines: number) => {
    const out: { range: [number, number]; at: number }[] = [];
    let last = -1;
    own.forEach((k, n) => {
      if (last >= 0) out.push({ range: [Math.min(own[n - 1].le, k.ls), k.le], at: other[last].le });
      else out.push({ range: [k.ls, n + 1 < own.length ? own[n + 1].ls : ownLines], at: other.length ? other[0].ls : 0 });
      if (counterpart[n] >= 0) last = counterpart[n];
    });
    return out;
  };
  const cPlace = place(C, B, bOf, cl.length);
  const bPlace = place(B, C, cOf, bl.length);

  const hunks: Hunk[] = [];
  for (const [d, n] of pairs) hunks.push({ kind: 'changed', cur: C[n], base: B[d], c: [C[n].ls, C[n].le], b: [B[d].ls, B[d].le] });
  C.forEach((k, n) => {
    if (bOf[n] >= 0 && !moved.has('c' + n)) return;
    hunks.push({ kind: 'inserted', moved: moved.has('c' + n) || undefined, cur: k, c: cPlace[n].range, b: [cPlace[n].at, cPlace[n].at] });
  });
  B.forEach((k, d) => {
    if (cOf[d] >= 0 && !moved.has('b' + d)) return;
    hunks.push({ kind: 'deleted', moved: moved.has('b' + d) || undefined, base: k, c: [bPlace[d].at, bPlace[d].at], b: bPlace[d].range });
  });
  // In reading order; a deletion sits before the block that now follows it.
  return hunks.sort((x, y) => x.c[0] - y.c[0] || (x.kind === 'deleted' ? -1 : 0) - (y.kind === 'deleted' ? -1 : 0));
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

/** How many blocks changed; a move counts once. */
export const changedBlocks = (hunks: Hunk[]) => hunks.filter((h) => !(h.moved && h.kind === 'deleted')).length;
