// Pandoc citations and pandoc-crossref references.
//
// - `[@key]`, `[see @a, p. 4; -@b]` and `@key` resolve against the front
//   matter's `bibliography:` (.bib or CSL-JSON, relative to the file) and render
//   author-date. A References list is appended; unknown keys are flagged.
// - `{#fig:x}` on an image, `{#tbl:x}` on a table caption, `{#eq:x}` after
//   `$$…$$` and `{#sec:x}` on a heading are numbered; `@fig:x` links to them.
//
// Citations are only read when the file has a bibliography, so `@handles` in
// ordinary Markdown stay text. Generated text is `.mdr-ui`: comments anchor on
// the prose around it, and the CLI blanks the raw citation to match.
import * as path from 'path';
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { parseFrontMatter } from './frontMatter';
import { BibEntry, citeNames, citeYear, loadBibliography, referenceParts, referenceText } from './bibliography';

// Pandoc's key punctuation, minus < and > so `@key</span>` stops at the tag.
const KEY = /^[\p{L}\p{N}_]+(?:[:.#$%&\-+?~/]+[\p{L}\p{N}_]+)*/u;
const KEY_AT = new RegExp(KEY.source.slice(1), 'uy');
const XREF = /^(fig|tbl|eq|sec):/i;
const PREFIX: Record<string, [string, string]> = { fig: ['fig.', 'figs.'], tbl: ['tbl.', 'tbls.'], eq: ['eq.', 'eqns.'], sec: ['sec.', 'secs.'] };
const NOUN: Record<string, string> = { fig: 'Figure', tbl: 'Table', eq: 'Equation', sec: 'Section' };

type StateCore = Parameters<MarkdownIt['core']['process']>[0];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Item {
  prefix: string;
  suppress: boolean;
  key: string;
  suffix: string;
}

interface Target {
  kind: string;
  n: string;
}

interface CiteEnv {
  /** A bibliography was declared, so `@key` is a citation. */
  active: boolean;
  /** The text has `@fig:`-style references, so those are parsed even without one. */
  xref: boolean;
  entries: Map<string, BibEntry>;
  files: string[];
  problems: string[];
  suppress: boolean;
  cited: string[];
  targets: Map<string, Target>;
}

/** `see @a, p. 4; -@b` -> items, or null if any part has no key. */
function parseItems(body: string): Item[] | null {
  const items: Item[] = [];
  for (const part of body.split(';')) {
    const at = part.search(/(?:^|[^\p{L}\p{N}_@\\])-?@/u);
    if (at < 0) return null;
    const i = part.indexOf('@', at);
    const suppress = part[i - 1] === '-';
    const k = KEY.exec(part.slice(i + 1));
    if (!k) return null;
    items.push({ prefix: part.slice(0, suppress ? i - 1 : i).trimStart(), suppress, key: k[0], suffix: part.slice(i + 1 + k[0].length).trimEnd() });
  }
  return items.length ? items : null;
}

function setup(state: StateCore) {
  const env = state.env as { docDir?: string; bibFiles?: string[]; mdrCite?: CiteEnv };
  const cite: CiteEnv = { active: false, xref: /@(?:fig|tbl|eq|sec):/i.test(state.src), entries: new Map(), files: [], problems: [], suppress: false, cited: [], targets: new Map() };
  env.mdrCite = cite;
  const first = state.tokens[0];
  if (first?.type !== 'mdr_front_matter') return;
  const fm = parseFrontMatter(first.content);
  if (!fm.bibliography.length) return;
  cite.active = true;
  cite.suppress = !!fm.suppressBibliography;
  for (const f of fm.bibliography) {
    cite.files.push(path.basename(f));
    if (!env.docDir && !path.isAbsolute(f)) continue;
    const file = path.resolve(env.docDir || '', f);
    (env.bibFiles ||= []).push(file);
    const bib = loadBibliography(file);
    if (bib.error) cite.problems.push(`${f}: ${bib.error}`);
    for (const [k, e] of bib.entries) if (!cite.entries.has(k)) cite.entries.set(k, e);
  }
}

export function citationsPlugin(md: MarkdownIt): void {
  md.core.ruler.before('inline', 'mdr_cite_setup', setup);

  md.inline.ruler.before('link', 'mdr_cite', (state, silent) => {
    const cite = (state.env as { mdrCite?: CiteEnv }).mdrCite;
    if (!cite || !(cite.active || cite.xref)) return false;
    const src = state.src;
    const pos = state.pos;
    const ch = src.charCodeAt(pos);
    let items: Item[] | null = null;
    let end = pos;
    let bracket = false;
    let locator = '';
    if (ch === 0x5b /* [ */) {
      // A link's label is measured in silent mode: leave the brackets to it,
      // so `[see [@a]](url)` stays a link (the citation renders inside it).
      if (silent) return false;
      const close = src.indexOf(']', pos + 1);
      if (close < 0 || src.lastIndexOf('[', close - 1) !== pos) return false;
      if (src[close + 1] === '(' || src[close + 1] === '[') return false; // a link
      if (src.slice(pos, close).includes('`')) return false; // `[`@a`]` is code
      items = parseItems(src.slice(pos + 1, close));
      if (!items) return false;
      bracket = true;
      end = close + 1;
    } else if (ch === 0x40 /* @ */) {
      if (pos > 0 && /[\p{L}\p{N}_@.\\/:-]/u.test(src[pos - 1])) return false; // emails, paths
      KEY_AT.lastIndex = pos + 1;
      const k = KEY_AT.exec(src);
      if (!k) return false;
      items = [{ prefix: '', suppress: false, key: k[0], suffix: '' }];
      end = pos + 1 + k[0].length;
      // `@key [p. 4]`: an in-text locator.
      const loc = src[end] === ' ' && src[end + 1] === '[' ? /^ \[([^\]@\n]*)\]/.exec(src.slice(end, end + 200)) : null;
      if (loc && !XREF.test(k[0]) && src[end + loc[0].length] !== '(') {
        locator = loc[1].trim();
        end += loc[0].length;
      }
    } else return false;
    const refsOnly = items.every((it) => XREF.test(it.key));
    if (!refsOnly && !cite.active) return false;
    if (!silent) {
      const t = state.push('mdr_cite', '', 0);
      // Inside a link's text, a citation can't be a link itself.
      t.meta = { items, bracket, locator, plain: (state as unknown as { linkLevel: number }).linkLevel > 0 };
      for (const it of items) if (!XREF.test(it.key) && !cite.cited.includes(it.key)) cite.cited.push(it.key);
    }
    state.pos = end;
    return true;
  });

  // After markdown-it-attrs has set ids: number targets, then add References.
  md.core.ruler.push('mdr_crossref', (state) => {
    const cite = (state.env as { mdrCite?: CiteEnv }).mdrCite;
    if (!cite) return;
    if (/\{#(?:fig|tbl|eq|sec):/i.test(state.src)) number(state, cite);
    if (cite.active && !cite.suppress && (cite.cited.length || cite.problems.length)) {
      const t = new state.Token('html_block', '', 0);
      t.content = references(state.tokens, cite);
      // Before the footnotes, so the list sits right under a closing References heading.
      const foot = state.tokens.findIndex((x) => x.type === 'footnote_block_open');
      state.tokens.splice(foot < 0 ? state.tokens.length : foot, 0, t);
    }
  });

  // `[*see* @a, ch. 2]`: prefixes and suffixes are Markdown too.
  const inl = (s: string) => (/[*_`\\<&[]/.test(s) ? md.renderInline(s) : esc(s));

  md.renderer.rules.mdr_cite = (tokens, idx, _o, env) => {
    const cite = (env as { mdrCite?: CiteEnv }).mdrCite!;
    const { items, bracket, locator, plain } = tokens[idx].meta as { items: Item[]; bracket: boolean; locator: string; plain: boolean };
    if (items.every((it) => XREF.test(it.key))) return xrefs(items, cite, plain);
    const one = (it: Item, inText: boolean) => {
      if (XREF.test(it.key)) return xrefs([it], cite, plain);
      const e = cite.entries.get(it.key);
      const pre = inl(it.prefix);
      const suf = inl(it.suffix);
      if (!e) {
        const why = `No entry "${it.key}" in ${cite.files.join(', ')}` + (cite.problems.length ? ` (couldn't read ${cite.problems.join('; ')})` : '');
        return `${pre}<span class="mdr-cite-missing" title="${esc(why)}">${esc(it.key)}?</span>${suf}`;
      }
      const link = (text: string) =>
        plain ? `<span class="mdr-cite" title="${esc(referenceText(e))}">${text}</span>` : `<a class="mdr-cite" href="#ref-${esc(it.key)}" title="${esc(referenceText(e))}">${text}</a>`;
      if (inText) return `${link(esc(citeNames(e)))} (${esc(citeYear(e))}${locator ? ', ' + esc(locator) : ''})`;
      const who = it.suppress ? '' : esc(citeNames(e)) + ' ';
      return `${pre}${link(who + esc(citeYear(e)))}${suf}`;
    };
    const body = bracket ? `(${items.map((it) => one(it, false)).join('; ')})` : one(items[0], true);
    return `<span class="mdr-cite-group mdr-ui">${body}</span>`;
  };

  // `$$…$$ {#eq:x}` became a numbered equation: give it the id to link to.
  const eqno = md.renderer.rules.math_block_eqno;
  if (eqno) {
    md.renderer.rules.math_block_eqno = (tokens, idx, opts, env, self) => {
      const html = eqno(tokens, idx, opts, env, self);
      const id = tokens[idx].meta?.mdrId;
      return id ? html.replace(/^<section/, () => `<section id="${esc(id)}"`) : html;
    };
  }
}

function xrefs(items: Item[], cite: CiteEnv, plain = false): string {
  const kinds = new Set(items.map((it) => it.key.split(':')[0].toLowerCase()));
  const cap = /^[A-Z]/.test(items[0].key);
  const kind = kinds.size === 1 ? [...kinds][0] : '';
  const label = (it: Item, withPrefix: boolean) => {
    const k = it.key.split(':')[0].toLowerCase();
    const id = k + it.key.slice(k.length);
    const t = cite.targets.get(id);
    let p = withPrefix ? PREFIX[k][0] + ' ' : '';
    if (cap && p) p = p[0].toUpperCase() + p.slice(1);
    if (!t) return `<span class="mdr-xref mdr-xref-missing" title="${esc(`No ${NOUN[k].toLowerCase()} labelled {#${id}}`)}">¿${esc(id)}?</span>`;
    return plain ? `<span class="mdr-xref">${esc(p + t.n)}</span>` : `<a class="mdr-xref" href="#${esc(id)}">${esc(p + t.n)}</a>`;
  };
  let body: string;
  if (kind && items.length > 1) {
    let p = PREFIX[kind][1];
    if (cap) p = p[0].toUpperCase() + p.slice(1);
    body = `${esc(p)} ${items.map((it) => label(it, false)).join(', ')}`;
  } else body = items.map((it) => (it.prefix ? esc(it.prefix) : '') + label(it, true) + esc(it.suffix)).join('; ');
  return `<span class="mdr-xref-group mdr-ui">${body}</span>`;
}

/** Number figures, tables, equations and sections in document order. */
function number(state: StateCore, cite: CiteEnv) {
  const tokens = state.tokens;
  const count: Record<string, number> = { fig: 0, tbl: 0, eq: 0 };
  const heads: number[] = [];
  let top = 7;
  for (const t of tokens) if (t.type === 'heading_open') top = Math.min(top, Number(t.tag.slice(1)));
  let lines: string[] | null = null;
  const add = (id: string | null, kind: string, n: string) => {
    if (id && !cite.targets.has(id)) cite.targets.set(id, { kind, n });
  };
  const label = (text: string) => {
    const t = new state.Token('html_inline', '', 0);
    t.content = `<span class="mdr-xref-label mdr-ui">${esc(text)}</span>`;
    return t;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const id = t.attrGet('id');
    if (t.type === 'heading_open') {
      const lvl = Number(t.tag.slice(1)) - top;
      heads.length = lvl + 1;
      for (let k = 0; k < lvl; k++) heads[k] ||= 0;
      heads[lvl] = (heads[lvl] || 0) + 1;
      if (id && /^sec:/.test(id)) add(id, 'sec', heads.join('.'));
    } else if (t.type === 'paragraph_open' && id && /^tbl:/.test(id)) {
      // `Table: caption {#tbl:x}` or `: caption {#tbl:x}` next to a table.
      const inline = tokens[i + 1];
      const first = inline?.children?.[0];
      if (inline?.type !== 'inline' || cite.targets.has(id)) continue;
      add(id, 'tbl', String(++count.tbl));
      t.attrJoin('class', 'mdr-tbl-cap');
      if (first?.type === 'text') first.content = first.content.replace(/^(Table)?:\s*/, '');
      inline.children!.unshift(label(`Table ${count.tbl}:`), Object.assign(new state.Token('text', '', 0), { content: ' ' }));
    } else if (t.type === 'inline' && t.children) {
      for (let c = 0; c < t.children.length; c++) {
        const img = t.children[c];
        const fid = img.type === 'image' ? img.attrGet('id') : null;
        if (!fid || !/^fig:/.test(fid) || cite.targets.has(fid)) continue;
        add(fid, 'fig', String(++count.fig));
        const cap = new state.Token('html_inline', '', 0);
        const alt = (img.children || []).map((x) => (x.type === 'softbreak' ? ' ' : x.content)).join('') || img.content;
        cap.content = `<span class="mdr-fig-cap"><span class="mdr-xref-label mdr-ui">Figure ${count.fig}:</span> ${esc(alt)}</span>`;
        t.children.splice(++c, 0, cap);
      }
    } else if (t.type === 'math_block' && t.map) {
      lines ||= state.src.split('\n');
      const m = /\$\$\s*\{#(eq:[^\s}]+)\}\s*$/.exec(lines[t.map[1] - 1] || '');
      if (!m || cite.targets.has(m[1])) continue;
      add(m[1], 'eq', String(++count.eq));
      t.type = 'math_block_eqno';
      t.info = String(count.eq);
      t.meta = { ...(t.meta || {}), mdrId: m[1] };
    }
  }
}

function references(tokens: Token[], cite: CiteEnv): string {
  const found = cite.cited.map((k) => cite.entries.get(k)).filter((e): e is BibEntry => !!e);
  const missing = cite.cited.filter((k) => !cite.entries.has(k));
  found.sort((a, b) => citeNames(a).localeCompare(citeNames(b)) || citeYear(a).localeCompare(citeYear(b)));
  // Pandoc puts the list after a closing "References" heading if there is one.
  // Only when nothing but footnotes follows it; otherwise the list gets its own title.
  let last = '';
  const foot = tokens.findIndex((x) => x.type === 'footnote_block_open');
  for (let i = (foot < 0 ? tokens.length : foot) - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type === 'heading_open') {
      last = tokens[i + 1]?.content || '';
      break;
    }
    if (t.level === 0 && t.nesting !== -1) break;
  }
  const named = /^(references|bibliography|works cited|literature cited|sources)\s*(\{[^}]*\})?$/i.test(last.trim());
  const parts: string[] = [];
  if (!named) parts.push('<h2 class="mdr-refs-title">References</h2>');
  for (const p of cite.problems) parts.push(`<p class="mdr-refs-warn">Couldn't read ${esc(p)}</p>`);
  if (missing.length) {
    parts.push(`<p class="mdr-refs-warn">${missing.length} citation key${missing.length === 1 ? '' : 's'} not found in ${esc(cite.files.join(', '))}: ${missing.map(esc).join(', ')}</p>`);
  }
  for (const e of found) {
    const p = referenceParts(e);
    const title = p.title ? ` “${esc(p.title)}”` : '';
    const box = p.container ? ` <em>${esc(p.container)}</em>` : '';
    parts.push(`<p class="mdr-ref" id="ref-${esc(e.key)}">${esc(p.lead)}${title}${box}${esc(p.rest)}</p>`);
  }
  return `<section class="mdr-refs mdr-ui" aria-label="References">${parts.join('')}</section>\n`;
}
