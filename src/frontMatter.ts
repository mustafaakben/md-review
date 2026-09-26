// YAML front matter (pandoc, Quarto, Jekyll, Hugo, Obsidian). A `---` block on
// the first line is shown as a compact title card instead of being parsed as
// Markdown (which turned it into an <hr> and a heading full of YAML). The card
// carries the block's source range, so Alt+double-click opens the raw YAML.
import type MarkdownIt from 'markdown-it';

export interface FrontMatter {
  raw: string;
  title?: string;
  subtitle?: string;
  authors: string[];
  date?: string;
  keywords: string[];
  /** `bibliography:` file(s), as written. */
  bibliography: string[];
  suppressBibliography?: boolean;
  /** `mdreview: { words: {…} }`: word targets for the document and its sections. */
  targets?: WordTargets;
}

export interface WordTargets {
  total?: number;
  /** Heading text as written (single spaces) -> words. */
  sections: Record<string, number>;
}

const unquote = (s: string) => {
  s = s.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) s = s.slice(1, -1);
  return s.trim();
};

/** `[a, "b, c", {name: D}]` -> ['a', 'b, c', 'D']. Commas inside quotes or braces don't split. */
function flowList(s: string): string[] | null {
  s = s.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const out: string[] = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  for (const ch of s.slice(1, -1)) {
    if (quote) {
      if (ch === quote) quote = '';
      cur += ch;
    } else if ((ch === '"' || ch === "'") && !cur.trim()) {
      // In YAML a quote only opens at the start of an item (so "Ada's" is plain).
      quote = ch;
      cur += ch;
    } else if (ch === '{' || ch === '[') {
      depth++;
      cur += ch;
    } else if (ch === '}' || ch === ']') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out
    .map((x) => {
      const named = /^\{\s*name:\s*("[^"]*"|'[^']*'|[^,}]*)/.exec(x.trim());
      return unquote(named ? named[1] : x);
    })
    .filter(Boolean);
}

/** Drop a YAML `# comment` (a # after a space, outside quotes). */
function uncomment(s: string): string {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}

/** Split at top-level `sep`: not inside quotes, braces or brackets. A quote opens a string only at the start of a key or a value. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if ((ch === '"' || ch === "'") && /(^|[:{\[,])\s*$/.test(cur)) quote = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// Without a prototype, so a key like `__proto__` or `constructor` is just a key.
type YMap = { [k: string]: string | YMap };
const newMap = (): YMap => Object.create(null);

/** `{a: 1, "b c": {d: 2}}` -> a nested map of strings. */
function flowMap(s: string): YMap | null {
  s = s.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  const out = newMap();
  for (const item of splitTop(s.slice(1, -1), ',')) {
    const [k, ...v] = splitTop(item, ':');
    if (!k.trim() || !v.length) continue;
    const value = v.join(':').trim();
    out[unquote(k)] = flowMap(value) ?? unquote(value);
  }
  return out;
}

/**
 * Indented `key: value` lines (a block map, possibly nested) -> a nested map
 * of strings. A list item holding one pair (`- Intro: 500`) is read as that pair.
 */
function blockMap(lines: string[]): YMap {
  const root = newMap();
  const stack: { indent: number; map: YMap }[] = [{ indent: -1, map: root }];
  for (const line of lines) {
    const m = /^(\s*(?:-\s+)?)("[^"]*"|'[^']*'|[^\s:#"'-][^:#]*?)\s*:(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const value = uncomment(m[3] || '').trim();
    const into = stack[stack.length - 1].map;
    if (!value) stack.push({ indent, map: (into[unquote(m[2])] = newMap()) });
    else into[unquote(m[2])] = flowMap(value) ?? unquote(value);
  }
  return root;
}

/** A positive whole number of words, up to a billion ("8,000" and "8_000" too). */
const wordCount = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && /^\d[\d,_]*$/.test(v.trim()) ? Number(v.replace(/[,_]/g, '')) : NaN;
  return n > 0 && n <= 1e9 ? n : undefined;
};

/**
 * `mdreview: { words: { total: 8000, Abstract: 250 } }`, or the flat
 * `mdreview: { total: 8000, abstract: 250 }`, in flow or block style. Section
 * keys keep their spelling; the view matches them to headings ignoring case.
 */
export function parseTargets(value: string, block: string[]): WordTargets | undefined {
  const map = flowMap(value) ?? blockMap(block);
  const words = map.words;
  const src = typeof words === 'object' ? words : map;
  const sections: [string, number][] = [];
  for (const [k, v] of Object.entries(src)) {
    const n = wordCount(v);
    const name = k.trim().replace(/\s+/g, ' ');
    if (n && name && name !== 'total' && name !== 'words') sections.push([name, n]);
  }
  // fromEntries defines keys as own properties, so `__proto__` stays a key here too.
  const t: WordTargets = { total: wordCount(src.total) ?? wordCount(words), sections: Object.fromEntries(sections) };
  if (!t.total) delete t.total;
  return t.total || sections.length ? t : undefined;
}

/**
 * Reads the handful of keys the title card shows. Not a general YAML parser:
 * anything it doesn't understand is still visible in the raw view.
 */
export function parseFrontMatter(raw: string): FrontMatter {
  const fm: FrontMatter = { raw, authors: [], keywords: [], bibliography: [] };
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = uncomment(m[2]);
    // Block scalar (`abstract: |`) or nested list/map below the key.
    // Only items at the first list indent under the key count, so nested
    // lists (Quarto's author affiliations) aren't read as more authors.
    const items: string[] = [];
    let indent = -1;
    let j = i + 1;
    while (j < lines.length && (/^\s+\S/.test(lines[j]) || /^-\s/.test(lines[j]))) {
      const item = /^(\s*)-\s+(.*)$/.exec(lines[j]);
      if (item && indent < 0) indent = item[1].length;
      if (item && item[1].length === indent) {
        const named = /^name:\s*(.*)$/.exec(item[2].trim());
        items.push(unquote(uncomment(named ? named[1] : item[2])));
      }
      // A single map (`author:\n  name: Solo`) rather than a list.
      const single = indent < 0 && /^\s+name:\s*(.+)$/.exec(lines[j]);
      if (single) items.push(unquote(single[1]));
      j++;
    }
    if (/^[|>][+-]?$/.test(value.trim())) value = '';
    const list = flowList(value) ?? (value.trim() ? [unquote(value)] : items);
    switch (key) {
      case 'title':
        fm.title = unquote(value) || undefined;
        break;
      case 'subtitle':
        fm.subtitle = unquote(value) || undefined;
        break;
      case 'author':
      case 'authors':
        fm.authors = list.filter((a) => a && !/^[\w-]+:/.test(a));
        break;
      case 'date':
        fm.date = unquote(value) || undefined;
        break;
      case 'bibliography':
        fm.bibliography = list;
        break;
      case 'suppress-bibliography':
        fm.suppressBibliography = /^(true|yes|on)$/i.test(unquote(value));
        break;
      case 'mdreview':
        fm.targets = parseTargets(value, lines.slice(i + 1, j));
        break;
      case 'keywords':
      case 'tags':
        if (!fm.keywords.length) fm.keywords = list;
        break;
    }
  }
  return fm;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function frontMatterPlugin(md: MarkdownIt): void {
  md.block.ruler.before(
    'hr',
    'mdr_front_matter',
    (state, startLine, endLine, silent) => {
      if (startLine !== 0 || state.blkIndent !== 0 || state.parentType !== 'root' || state.tShift[0] !== 0) return false;
      const first = state.src.slice(state.bMarks[0] + state.tShift[0], state.eMarks[0]);
      if (first.trim() !== '---') return false;
      let end = -1;
      for (let l = 1; l < endLine; l++) {
        const s = state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]).trim();
        if (s === '---' || s === '...') {
          end = l;
          break;
        }
      }
      // A lone `---` followed by prose is a thematic break, not front matter:
      // the block must close, and the line right after `---` must be `key:`.
      if (end < 1) return false;
      // Like pandoc, that line must not be blank.
      const line1 = state.src.slice(state.bMarks[1] + state.tShift[1], state.eMarks[1]);
      if (end === 1 || !/^[A-Za-z_][\w-]*:(\s|$)/.test(line1)) return false;
      if (silent) return true;
      const raw = state.src.slice(state.bMarks[1], state.bMarks[end]).replace(/\r?\n$/, '');
      const token = state.push('mdr_front_matter', 'div', 0);
      token.block = true;
      token.map = [0, end + 1];
      token.content = raw;
      state.line = end + 1;
      return true;
    },
    { alt: [] },
  );

  md.renderer.rules.mdr_front_matter = (tokens, idx, _opts, env) => {
    const t = tokens[idx];
    const fm = parseFrontMatter(t.content);
    (env as { front?: FrontMatter }).front = fm; // handed back in the render env
    const range = t.map ? ` data-ls="${t.map[0]}" data-le="${t.map[1]}"` : '';
    const parts: string[] = [];
    if (fm.title) parts.push(`<div class="mdr-front-title">${md.renderInline(fm.title)}</div>`);
    if (fm.subtitle) parts.push(`<div class="mdr-front-subtitle">${md.renderInline(fm.subtitle)}</div>`);
    const meta = [fm.authors.map(esc).join(', '), fm.date ? esc(fm.date) : ''].filter(Boolean);
    if (meta.length) parts.push(`<div class="mdr-front-meta">${meta.join('<span class="mdr-front-sep"> · </span>')}</div>`);
    if (fm.keywords.length) parts.push(`<div class="mdr-front-tags">${fm.keywords.map((k) => `<span>${esc(k)}</span>`).join('')}</div>`);
    const lines = t.content ? t.content.split(/\r?\n/).length : 0;
    parts.push(
      `<details class="mdr-front-raw"><summary>Front matter · ${lines} line${lines === 1 ? '' : 's'}</summary><pre>${esc(t.content)}</pre></details>`,
    );
    return `<div class="mdr-wrap mdr-front"${range}>${parts.join('')}</div>\n`;
  };
}
