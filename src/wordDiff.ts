// Sequence and word diffs for the Changes view. No DOM and no Node APIs, so
// the host (block matching) and the webview (word redlines) share it.

/** -1 deleted from the old side, 0 kept, 1 inserted from the new side. */
export type Edit = -1 | 0 | 1;

/**
 * Myers' O(ND) diff. Returns one edit per step, in order, or null when the two
 * sides differ by more than `maxD` edits (the caller then treats them as replaced).
 */
export function diffSeq<T>(a: readonly T[], b: readonly T[], maxD = Infinity): Edit[] | null {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const n = a.length - p - s;
  const m = b.length - p - s;
  const at = (i: number) => a[p + i];
  const bt = (j: number) => b[p + j];
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[k] for k in [-d, d] after step d, for walking back.
  const trace: Int32Array[] = [];
  let done = -1;
  for (let d = 0; d <= max && done < 0; d++) {
    if (d > maxD) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && at(x) === bt(y)) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) done = d;
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  const mid: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = done; d > 0; d--) {
    const prev = trace[d - 1];
    const get = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = get(pk);
    const py = px - pk;
    while (x > px && y > py) {
      mid.push(0);
      x--;
      y--;
    }
    mid.push(down ? 1 : -1);
    if (down) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    mid.push(0);
    x--;
    y--;
  }
  mid.reverse();
  return [...new Array<Edit>(p).fill(0), ...mid, ...new Array<Edit>(s).fill(0)];
}

// Chinese, Japanese and Korean text is compared character by character (it has no spaces between words).
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const WORD = String.raw`(?:(?![${CJK}])[\p{L}\p{N}_])+`;
const TOKEN = new RegExp(String.raw`\s+|[${CJK}]|${WORD}(?:['’]${WORD})*|[^\s\p{L}\p{N}_]`, 'gu');

export function words(text: string): string[] {
  return text.match(TOKEN) || [];
}

/**
 * Word-level diff as runs of [edit, text]. In each changed stretch the
 * deletion comes before the insertion, and a lone space between two changes
 * is folded into them, so "a b c" → "x y z" reads as one replacement.
 */
export function diffWords(before: string, after: string, maxD = 1500): [Edit, string][] {
  const a = words(before);
  const b = words(after);
  const script = diffSeq(a, b, maxD);
  const runs: [Edit, string][] = [];
  const push = (e: Edit, t: string) => {
    const last = runs[runs.length - 1];
    if (last && last[0] === e) last[1] += t;
    else runs.push([e, t]);
  };
  if (!script) {
    if (before) push(-1, before);
    if (after) push(1, after);
    return runs;
  }
  let i = 0;
  let j = 0;
  for (const e of script) {
    if (e === 1) push(1, b[j++]);
    else {
      push(e, a[i++]);
      if (e === 0) j++;
    }
  }
  // Fold whitespace-only kept runs that sit between changes, then order each
  // changed stretch as deletion, insertion.
  const out: [Edit, string][] = [];
  let del = '';
  let ins = '';
  const flush = () => {
    if (del) out.push([-1, del]);
    if (ins) out.push([1, ins]);
    del = ins = '';
  };
  runs.forEach(([e, t], k) => {
    const between = e === 0 && /^\s+$/.test(t) && k > 0 && k < runs.length - 1;
    if (e === -1) del += t;
    else if (e === 1) ins += t;
    else if (between && (del || ins)) {
      del += t;
      ins += t;
    } else {
      flush();
      out.push([0, t]);
    }
  });
  flush();
  return out;
}
