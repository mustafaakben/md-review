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
    } else if (ch === '"' || ch === "'") {
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
      const named = /^\{\s*name:\s*(.*?)\s*(,.*)?\}$/.exec(x.trim());
      return unquote(named ? named[1] : x);
    })
    .filter(Boolean);
}

/**
 * Reads the handful of keys the title card shows. Not a general YAML parser:
 * anything it doesn't understand is still visible in the raw view.
 */
export function parseFrontMatter(raw: string): FrontMatter {
  const fm: FrontMatter = { raw, authors: [], keywords: [] };
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = m[2];
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
        items.push(unquote(named ? named[1] : item[2]));
      }
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
      if (startLine !== 0 || state.blkIndent !== 0 || state.parentType !== 'root') return false;
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
      // the block must close, and its first non-blank line must be `key:`.
      if (end < 1) return false;
      // Like pandoc, the line right after the opening `---` must not be blank.
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

  md.renderer.rules.mdr_front_matter = (tokens, idx) => {
    const t = tokens[idx];
    const fm = parseFrontMatter(t.content);
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
