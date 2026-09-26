// Text-quote anchoring (W3C TextQuoteSelector style) over plain text: the
// string half of webview/anchor.ts, shared with the host (Word export and
// import) so a quote lands on the same place in both.

export const CONTEXT = 32;

export interface Quote {
  quote: string;
  prefix: string;
  suffix: string;
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

// The whitespace fallback collapses the whole document text; when several
// comments fall back during one paint, collapse it once.
let lastDoc: { src: string; res: { out: string; map: number[] } } | null = null;
function collapseDoc(text: string) {
  if (lastDoc?.src !== text) lastDoc = { src: text, res: collapse(text) };
  return lastDoc.res;
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
export function locate(text: string, a: Quote): [number, number] | null {
  const exact = bestMatch(text, a.quote, a.prefix, a.suffix);
  if (exact && trusted(a.quote, a.prefix, a.suffix, exact[2])) return [exact[0], exact[1]];
  const t = collapseDoc(text);
  const q = collapse(a.quote.trim()).out;
  const pre = collapse(a.prefix).out;
  const suf = collapse(a.suffix).out;
  const m = bestMatch(t.out, q, pre, suf);
  if (!m || !trusted(q, pre, suf, m[2])) return null;
  return [t.map[m[0]], t.map[m[1] - 1] + 1];
}

/** The quote at [start, end) of `text`, trimmed of surrounding whitespace, with its context. */
export function quoteAt(text: string, start: number, end: number): (Quote & { start: number; end: number }) | null {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end <= start) return null;
  return {
    start,
    end,
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

// ---- a looser match for text that went through another editor (Word) ----
// Letters and digits only, lowercased: survives changed spacing, quotes and
// dashes. Used only after locate() fails.
const WORD = /[\p{L}\p{N}]/u;
function keyed(s: string): { key: string; at: number[] } {
  let key = '';
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (!WORD.test(s[i])) continue;
    for (const k of s[i].toLowerCase()) {
      key += k;
      at.push(i);
    }
  }
  return { key, at };
}

export function locateLoose(text: string, a: Quote): [number, number] | null {
  const q = keyed(a.quote).key;
  if (q.length < 4) return null;
  const t = keyed(text);
  const pre = keyed(a.prefix).key;
  const suf = keyed(a.suffix).key;
  let best: [number, number] | null = null;
  let bestScore = -1;
  let count = 0;
  for (let i = t.key.indexOf(q); i >= 0; i = t.key.indexOf(q, i + 1)) {
    count++;
    const e = i + q.length;
    const score = commonSuffix(t.key.slice(Math.max(0, i - pre.length), i), pre) + commonPrefix(t.key.slice(e, e + suf.length), suf);
    if (score > bestScore) {
      bestScore = score;
      best = [i, e];
    }
  }
  if (!best) return null;
  const need = Math.min(8, Math.floor((pre.length + suf.length) / 4));
  if (!(count === 1 && q.length >= 12) && bestScore < need) return null;
  return [t.at[best[0]], t.at[best[1] - 1] + 1];
}
