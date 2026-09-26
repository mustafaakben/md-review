// Word counts from the rendered document: only its text, not the review UI,
// code blocks, math source, footnotes, the front-matter card or text CriticMarkup
// deletes. Inline code and headings count. A formula (with its equation number)
// counts as one word, as does a web address; Chinese and Japanese characters
// count one each, and an emoji standing alone is a word.
//
// A word is a run of letters and digits, joined by apostrophes, hyphens, dots
// and underscores ("don't", "e.g.", "well-known"), by the invisible joiners and
// soft hyphens some scripts and editors put inside words, and by commas between
// digits ("8,000"). Counted a character at a time rather than with a Unicode
// regex, which is several times slower on a long document.

const SEP = 0;
const LETTER = 1;
const DIGIT = 2;
const JOIN = 3; // ' ’ . - _, and inside-word marks (see classify)
const COMMA = 4;
const CJK = 5;

const isCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const isDigit = /\p{N}/u;
const isLetter = /[\p{L}\p{M}]/u;
// Emoji shown as emoji by default (not ©, ™ or →), skin tones and flag letters.
// A text-style symbol followed by U+FE0F (a mark, so a letter here) counts too.
const isEmoji = /[\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}]/u;
// ’, zero-width non-joiner and joiner (Persian, Indic scripts, emoji sequences),
// soft hyphen, and the Unicode hyphen and non-breaking hyphen.
const JOINERS = new Set(['’', '\u200c', '\u200d', '\u00ad', '\u2010', '\u2011']);
const kinds = new Uint8Array(0x10000).fill(255); // per BMP code unit, filled on first sight

function classify(ch: string): number {
  if (JOINERS.has(ch)) return JOIN;
  return isCjk.test(ch) ? CJK : isDigit.test(ch) ? DIGIT : isLetter.test(ch) || isEmoji.test(ch) ? LETTER : SEP;
}

/** Space, tab, newline and the Unicode spaces: what ends a web address. */
const isSpace = (c: number) => c <= 32 || c === 0xa0 || c === 0x3000 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f;

function kindAt(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c < 128) {
    if (c >= 48 && c <= 57) return DIGIT;
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) return LETTER;
    return c === 39 || c === 46 || c === 45 || c === 95 ? JOIN : c === 44 ? COMMA : SEP;
  }
  if (c >= 0xd800 && c < 0xdc00) return classify(String.fromCodePoint(s.codePointAt(i)!));
  let k = kinds[c];
  if (k === 255) k = kinds[c] = classify(String.fromCharCode(c));
  return k;
}

/** Counts words across several pieces of text, as if they were one string; `stop()` marks a word break between pieces. */
export class WordCounter {
  n = 0;
  private prev = SEP; // the last letter or digit, if the current word is still open
  private join = SEP; // a joiner right after it, waiting to see what follows
  private url = false; // inside a web address, which ends at a space

  add(s: string): void {
    let { n, prev, join, url } = this; // locals: this loop runs once per character
    for (let i = 0; i < s.length; i++) {
      if (url) {
        if (isSpace(s.charCodeAt(i))) url = false;
        continue;
      }
      const k = kindAt(s, i);
      if (k === LETTER || k === DIGIT) {
        const joined = join === JOIN || (join === COMMA && prev === DIGIT && k === DIGIT);
        if (prev === SEP || (join !== SEP && !joined)) n++;
        prev = k;
        join = SEP;
      } else if ((k === JOIN || k === COMMA) && prev !== SEP && join === SEP) {
        join = k;
      } else if (s.charCodeAt(i) === 58 && prev !== SEP && join === SEP && s.charCodeAt(i + 1) === 47 && s.charCodeAt(i + 2) === 47) {
        url = true; // `https://…`: the scheme was the word, the rest belongs to it
        prev = join = SEP;
      } else {
        if (k === CJK) n++;
        prev = join = SEP;
      }
      if (s.charCodeAt(i) >= 0xd800 && s.charCodeAt(i) < 0xdc00) i++; // the rest of a surrogate pair
    }
    this.n = n;
    this.prev = prev;
    this.join = join;
    this.url = url;
  }

  stop(): void {
    this.prev = SEP;
    this.join = SEP;
    this.url = false;
  }

  /** The count so far, starting again from zero. */
  take(): number {
    const n = this.n;
    this.n = 0;
    return n;
  }
}

export function countWords(text: string): number {
  const c = new WordCounter();
  c.add(text);
  return c.n;
}

export interface WordCounts {
  total: number;
  /** Words under each h1–h4, its own text included, up to the next heading of the same or higher level. */
  sections: Map<HTMLElement, number>;
}

/** One top-level block's words: those before its first heading, then each heading in it with the words from there on. */
export interface BlockCount {
  lead: number;
  heads: { el: HTMLElement; lvl: number; words: number }[];
}

const SKIP = new Set(['PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'BUTTON', 'svg']);
// Generated or set apart: the review UI (citations, reference list, figure
// labels), the front-matter card, footnotes with their markers, and CriticMarkup
// deletions and notes (what the text would read once the changes are accepted).
const SKIP_CLASS = ['mdr-ui', 'mdr-front', 'footnotes', 'footnote-ref', 'mdr-critic-del', 'mdr-critic-note'];
// One word each: a formula, and a displayed one with its equation number.
const ONE_WORD = ['katex', 'katex-error', 'eqno'];
// Elements whose edges separate words even without whitespace between them.
const BREAK = new Set(['P', 'LI', 'TD', 'TH', 'TR', 'DIV', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DT', 'DD', 'BR', 'SECTION', 'FIGCAPTION', 'CAPTION', 'TABLE', 'UL', 'OL', 'DL']);
const HEADS: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4 };

/** Counts one top-level block. */
class BlockCounter {
  private words = new WordCounter();
  readonly out: BlockCount = { lead: 0, heads: [] };

  /** End the words counted so far, into the current section. */
  private close(): void {
    const w = this.words.take();
    const { heads } = this.out;
    if (heads.length) heads[heads.length - 1].words += w;
    else this.out.lead += w;
  }

  count(c: ChildNode): BlockCount {
    this.visit(c);
    this.close();
    return this.out;
  }

  private visit(c: ChildNode): void {
    const words = this.words;
    if (c.nodeType === 3) return words.add((c as Text).data);
    if (c.nodeType !== 1) return;
    const e = c as HTMLElement;
    if (SKIP.has(e.tagName)) return words.stop();
    const cl = e.classList;
    if (cl.length) {
      if (SKIP_CLASS.some((x) => cl.contains(x))) return words.stop();
      if (ONE_WORD.some((x) => cl.contains(x))) {
        words.stop();
        words.n++;
        return;
      }
      if (cl.contains('mdr-critic-add')) {
        // An insertion's edges are word edges: {--old--}{++new++}text is "new text".
        words.stop();
        this.walk(e);
        return words.stop();
      }
    }
    const lvl = HEADS[e.tagName];
    if (lvl) {
      words.stop();
      this.close();
      this.out.heads.push({ el: e, lvl, words: 0 });
      this.walk(e);
      words.stop();
      return;
    }
    this.walk(e);
    if (BREAK.has(e.tagName)) words.stop();
  }

  private walk(el: Element): void {
    for (let c = el.firstChild; c; c = c.nextSibling) this.visit(c);
  }
}

/**
 * Counts the painted document a top-level block at a time, so a long document
 * can be counted over several idle moments. Reads text only: no layout.
 * Blocks already in `cache` aren't read again: after a repaint that kept most
 * blocks, only the new ones are counted. A cached block must not have changed
 * its text since (a repaint replaces a block an edit touched).
 */
export class DocumentCount {
  private next: ChildNode | null;
  private blocks: BlockCount[] = [];

  constructor(
    doc: HTMLElement,
    private cache: WeakMap<Node, BlockCount> = new WeakMap(),
  ) {
    this.next = doc.firstChild;
  }

  /** Count blocks while `more()` allows; true once the whole document is counted. */
  step(more: () => boolean): boolean {
    while (this.next) {
      const c = this.next;
      this.next = c.nextSibling;
      let b = this.cache.get(c);
      if (!b) {
        b = new BlockCounter().count(c);
        if (c.nodeType === 1) this.cache.set(c, b);
      }
      if (b.lead || b.heads.length) this.blocks.push(b);
      if (!more()) break;
    }
    return !this.next;
  }

  result(): WordCounts {
    // Each section's own words (before its first subsection), then add each
    // section's to its open ancestors: a section includes its subsections.
    const heads: { el: HTMLElement; lvl: number }[] = [];
    const own: number[] = [];
    let total = 0;
    for (const b of this.blocks) {
      total += b.lead;
      if (own.length) own[own.length - 1] += b.lead;
      for (const h of b.heads) {
        total += h.words;
        heads.push(h);
        own.push(h.words);
      }
    }
    const sec = own.slice();
    const stack: number[] = [];
    heads.forEach((h, i) => {
      while (stack.length && heads[stack[stack.length - 1]].lvl >= h.lvl) stack.pop();
      for (const a of stack) sec[a] += own[i];
      stack.push(i);
    });
    return { total, sections: new Map(heads.map((h, i) => [h.el, sec[i]])) };
  }
}

/** Count the whole document at once. */
export function countDocument(doc: HTMLElement): WordCounts {
  const count = new DocumentCount(doc);
  count.step(() => true);
  return count.result();
}

const numbers = new Intl.NumberFormat('en-US'); // toLocaleString makes a new formatter each call
/** 1234 -> "1,234". */
export const fmtCount = (n: number) => numbers.format(n);
/** 1 -> "1 word", 1234 -> "1,234 words". */
export const fmtWords = (n: number) => `${numbers.format(n)} ${n === 1 ? 'word' : 'words'}`;
/** Minutes to read at about 230 words a minute. */
export const readingMinutes = (words: number) => Math.max(1, Math.round(words / 230));
