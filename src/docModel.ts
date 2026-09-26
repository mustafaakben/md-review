// The reading view as data: renders Markdown with the same renderer the
// webview uses, then walks that HTML the way the webview's text-node walk
// does (webview/anchor.ts), so `text` is the text comments are anchored in.
// Alongside it, a block model (paragraphs, lists, tables, runs with
// formatting) that the Word writer turns into OOXML. Each run knows which
// slice of `text` it shows, so a thread's quote maps onto Word runs.
import * as path from 'path';
import { hasUrlScheme, renderMarkdown, RenderEnv } from './render';

export interface Fmt {
  b?: boolean;
  i?: boolean;
  code?: boolean;
  strike?: boolean;
  u?: boolean;
  mark?: boolean;
  sup?: boolean;
  sub?: boolean;
  link?: string;
}

export interface Run {
  kind: 'text' | 'br' | 'image';
  /** What Word shows ('' for a run that only occupies anchor text). */
  text: string;
  /** The slice of the anchor text this run stands for. */
  a0: number;
  a1: number;
  /** True when `text` is exactly text[a0, a1), so the run can be cut anywhere. */
  split: boolean;
  fmt: Fmt;
  image?: { src: string; alt: string };
}

export interface Para {
  type: 'p';
  style?: string;
  /** Numbered or bulleted: list instance index and level. */
  list?: { id: number; ilvl: number };
  /** Left indent in twips. */
  indent?: number;
  code?: boolean;
  hr?: boolean;
  runs: Run[];
}

export interface Table {
  type: 'table';
  rows: { header: boolean; cells: Block[][] }[];
}

export type Block = Para | Table;

export interface ListDef {
  ordered: boolean;
  start: number;
  ilvl: number;
}

export interface DocModel {
  /** The rendered text, as the webview's text map sees it. */
  text: string;
  blocks: Block[];
  lists: ListDef[];
  /** Source line range (0-based, end exclusive) of each stretch of text. */
  lines: { a0: number; a1: number; ls: number; le: number }[];
}

// ---- a small HTML tokenizer (markdown-it output plus any raw HTML in the file) ----

type Tok = { t: 'text'; s: string } | { t: 'open'; name: string; attrs: Record<string, string>; self: boolean } | { t: 'close'; name: string };

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®',
  trade: '™', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', divide: '÷', deg: '°',
  plusmn: '±', middot: '·', bull: '•', shy: '­', thinsp: ' ', ensp: ' ', emsp: ' ', minus: '−', larr: '←',
  rarr: '→', harr: '↔', uarr: '↑', darr: '↓', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', sect: '§', para: '¶',
  euro: '€', pound: '£', yen: '¥', cent: '¢', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', mu: 'μ', pi: 'π', sigma: 'σ',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
      return String.fromCodePoint(n);
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

export function tokenizeHtml(html: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', s: decodeEntities(text) });
    text = '';
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    i = lt;
    const next = html[i + 1] || '';
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const close = /^<\/([a-zA-Z][^\s\/>]*)[^>]*>/.exec(html.slice(i, i + 200));
    if (close) {
      flush();
      out.push({ t: 'close', name: close[1].toLowerCase() });
      i += close[0].length;
      continue;
    }
    if (/[a-zA-Z]/.test(next)) {
      // Find the tag's end, skipping quoted attribute values.
      let j = i + 1;
      let q = '';
      for (; j < html.length; j++) {
        const c = html[j];
        if (q) {
          if (c === q) q = '';
        } else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
      }
      if (j >= html.length) {
        text += html.slice(i);
        break;
      }
      const inner = html.slice(i + 1, j);
      const nm = /^[^\s\/>]+/.exec(inner)![0];
      const name = nm.toLowerCase();
      flush();
      out.push({ t: 'open', name, attrs: parseAttrs(inner.slice(nm.length)), self: /\/\s*$/.test(inner) });
      i = j + 1;
      if (RAW.has(name)) {
        const end = html.toLowerCase().indexOf(`</${name}`, i);
        const body = html.slice(i, end < 0 ? html.length : end);
        if (body) out.push({ t: 'text', s: name === 'textarea' || name === 'title' ? decodeEntities(body) : body });
        i = end < 0 ? html.length : end;
      }
      continue;
    }
    text += '<';
    i++;
  }
  flush();
  return out;
}

// ---- the walk ----

/** Not part of the view's text (webview/anchor.ts SKIP). */
const HIDDEN_CLASS = ['katex-mathml', 'mdr-block-editor', 'mdr-front-raw'];
const HIDDEN_TAG = new Set(['script', 'style', 'template']);
const BLOCK = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'div', 'section', 'hr', 'details', 'summary', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'header', 'footer', 'article', 'aside',
  'nav', 'main', 'address', 'caption', 'eqn', 'center', 'form', 'fieldset',
]);

interface El {
  name: string;
  cls: string[];
  attrs: Record<string, string>;
  hidden: boolean;
  ui: boolean;
  noDocx: boolean;
  fmt: Fmt;
  ls?: number;
  le?: number;
  list?: { id: number; ilvl: number; n: number };
  footnote?: boolean;
}

export interface ModelOptions {
  /** Folder of the Markdown file: for its bibliography and relative images. */
  docDir?: string;
  /** Restricted Mode: the only folders a bibliography may be read from (as in the view). */
  readableRoots?: string[];
}

// Image sources stay as written; the Word writer resolves local ones itself.
const keepSrc = (src: string) => src;

export function buildDocModel(markdown: string, opts: ModelOptions = {}): DocModel {
  const env: RenderEnv = { docDir: opts.docDir, bibRoots: opts.readableRoots };
  return modelFromHtml(renderMarkdown(markdown.replace(/^﻿/, ''), keepSrc, env));
}

export function modelFromHtml(html: string): DocModel {
  let text = '';
  const blocks: Block[] = [];
  const lists: ListDef[] = [];
  const lines: DocModel['lines'] = [];
  const stack: El[] = [];
  let para: Para | null = null;
  let containers: Block[][] = [blocks];
  const tables: { table: Table; outer: Block[][] }[] = [];
  let pendingPrefix: string | null = null;
  let afterBr = false;
  let math: { tex: string; a0: number; depth: number; fmt: Fmt } | null = null;
  let annotation = false;
  let footnoteN = 0;

  const top = (): El | undefined => stack[stack.length - 1];
  const has = (name: string) => stack.some((e) => e.name === name);
  const hidden = () => !!top()?.hidden;

  const lineRange = (): [number, number] | null => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].ls !== undefined) return [stack[k].ls!, stack[k].le!];
    return null;
  };
  const noteLines = (a0: number, a1: number) => {
    const r = lineRange();
    if (!r || a1 <= a0) return;
    const last = lines[lines.length - 1];
    if (last && last.ls === r[0] && last.le === r[1] && last.a1 === a0) last.a1 = a1;
    else lines.push({ a0, a1, ls: r[0], le: r[1] });
  };

  const closePara = () => {
    if (!para) return;
    if (para.code) {
      // Code ends with a newline; keep it in the anchor text, not as an empty line in Word.
      const last = para.runs[para.runs.length - 1];
      if (last && !last.split && last.a0 === last.a1) last.text = last.text.replace(/\n+$/, '');
      else if (last?.split) {
        const m = /\n+$/.exec(last.text);
        if (m) {
          const cut = last.text.length - m[0].length;
          para.runs.push({ kind: 'text', text: '', a0: last.a0 + cut, a1: last.a1, split: false, fmt: {} });
          last.text = last.text.slice(0, cut);
          last.a1 = last.a0 + cut;
        }
      }
    }
    para = null;
    afterBr = false;
  };

  const openPara = (): Para => {
    if (para) return para;
    const p: Para = { type: 'p', runs: [] };
    let quote = 0;
    let li: El | undefined;
    let listDepth = 0;
    for (const e of stack) {
      if (e.name === 'blockquote') quote++;
      if (e.name === 'ul' || e.name === 'ol') listDepth++;
      if (e.name === 'li') li = e;
    }
    const h = [...stack].reverse().find((e) => /^h[1-6]$/.test(e.name));
    if (h) p.style = `Heading${h.name[1]}`;
    else if (stack.some((e) => e.cls.includes('mdr-front-title'))) p.style = 'Title';
    else if (stack.some((e) => e.cls.includes('mdr-front-subtitle'))) p.style = 'Subtitle';
    else if (has('pre')) {
      p.style = 'Code';
      p.code = true;
    } else if (quote) p.style = 'Quote';
    if (li?.list && !li.footnote) {
      if (li.list.n === 0) p.list = { id: li.list.id, ilvl: li.list.ilvl };
      else p.indent = 720 * (li.list.ilvl + 1);
      li.list.n++;
    } else if (listDepth && !li?.footnote) p.indent = 720 * listDepth;
    if (quote) p.indent = (p.indent || 0) + 360 * quote;
    containers[containers.length - 1].push(p);
    para = p;
    if (pendingPrefix) {
      p.runs.push({ kind: 'text', text: pendingPrefix, a0: text.length, a1: text.length, split: false, fmt: {} });
      pendingPrefix = null;
    }
    return p;
  };

  const addText = (s: string) => {
    if (top()?.ui) {
      // Interface text (alert titles, the reference list): not in the view's text, but shown in Word.
      if (!math && !top()?.noDocx && (para || /\S/.test(s) || has('pre'))) addExtra(s);
      return;
    }
    const a0 = text.length;
    text += s;
    const a1 = text.length;
    noteLines(a0, a1);
    if (math) return; // katex-html glyphs: anchored, shown in Word as the TeX source
    const el = top();
    if (el?.noDocx) {
      if (para) para.runs.push({ kind: 'text', text: '', a0, a1, split: false, fmt: {} });
      return;
    }
    const ws = !/\S/.test(s);
    if (!para && ws && !has('pre')) return; // whitespace between blocks
    if (afterBr && para && /^\n/.test(s)) {
      // The newline markdown-it writes after <br>: text in the view, nothing in Word.
      para.runs.push({ kind: 'text', text: '', a0, a1: a0 + 1, split: false, fmt: {} });
      afterBr = false;
      if (s.length === 1) return;
      return pushRun(s.slice(1), a0 + 1, a1);
    }
    afterBr = false;
    pushRun(s, a0, a1);
  };
  const pushRun = (s: string, a0: number, a1: number) => {
    openPara().runs.push({ kind: 'text', text: s, a0, a1, split: true, fmt: { ...(top()?.fmt || {}) } });
  };
  // Text Word shows that isn't in the view's text (alt text, task boxes, math).
  const addExtra = (s: string, fmt: Fmt = top()?.fmt || {}) => {
    const p = openPara();
    p.runs.push({ kind: 'text', text: s, a0: text.length, a1: text.length, split: false, fmt: { ...fmt } });
  };

  for (const tok of tokenizeHtml(html)) {
    if (tok.t === 'text') {
      if (annotation && math) {
        math.tex += tok.s;
        continue;
      }
      if (hidden()) continue;
      let s = tok.s;
      // The HTML parser drops a newline right after <pre>.
      const t = top();
      if (t?.name === 'pre' && t.attrs['data-fresh'] === '1') {
        t.attrs['data-fresh'] = '';
        s = s.replace(/^\n/, '');
      }
      if (s) addText(s);
      continue;
    }
    if (tok.t === 'open') {
      const { name, attrs } = tok;
      const parent = top();
      const cls = (attrs.class || '').split(/\s+/).filter(Boolean);
      if (parent?.name === 'pre') parent.attrs['data-fresh'] = '';
      const el: El = {
        name,
        cls,
        attrs,
        hidden: !!parent?.hidden || HIDDEN_TAG.has(name) || cls.some((c) => HIDDEN_CLASS.includes(c)),
        ui: !!parent?.ui || cls.includes('mdr-ui'),
        noDocx: !!parent?.noDocx || cls.includes('footnote-backref'),
        fmt: { ...(parent?.fmt || {}) },
      };
      if (attrs['data-ls'] !== undefined && /^\d+$/.test(attrs['data-ls']) && /^\d+$/.test(attrs['data-le'] || '')) {
        el.ls = Number(attrs['data-ls']);
        el.le = Number(attrs['data-le']);
      }
      if (math && name === 'annotation' && /tex/i.test(attrs.encoding || '')) annotation = true;
      if (!el.hidden) {
        switch (name) {
          case 'strong':
          case 'b':
          case 'th':
            el.fmt.b = true;
            break;
          case 'em':
          case 'i':
          case 'cite':
            el.fmt.i = true;
            break;
          case 'code':
          case 'kbd':
          case 'samp':
          case 'tt':
            if (!has('pre')) el.fmt.code = true;
            break;
          case 's':
          case 'del':
          case 'strike':
            el.fmt.strike = true;
            break;
          case 'ins':
          case 'u':
            el.fmt.u = true;
            break;
          case 'mark':
            el.fmt.mark = true;
            break;
          case 'sup':
            el.fmt.sup = true;
            break;
          case 'sub':
            el.fmt.sub = true;
            break;
          case 'a':
            if (attrs.href && !attrs.href.startsWith('#')) el.fmt.link = attrs.href;
            break;
        }
        if (cls.includes('mdr-critic-note')) el.fmt.i = true;
      }
      if (BLOCK.has(name) && !el.hidden && !math) {
        closePara();
        if (name === 'hr') {
          containers[containers.length - 1].push({ type: 'p', hr: true, runs: [] });
        } else if (name === 'ul' || name === 'ol') {
          const ilvl = Math.min(8, stack.filter((e) => e.name === 'ul' || e.name === 'ol').length);
          const start = Number(attrs.start);
          lists.push({ ordered: name === 'ol', start: Number.isFinite(start) && start > 0 ? Math.floor(start) : 1, ilvl });
          el.list = { id: lists.length - 1, ilvl, n: 0 };
        } else if (name === 'li') {
          const owner = [...stack].reverse().find((e) => e.name === 'ul' || e.name === 'ol');
          if (owner?.list) el.list = { id: owner.list.id, ilvl: owner.list.ilvl, n: 0 };
          if (cls.includes('footnote-item')) {
            el.footnote = true;
            pendingPrefix = `[${++footnoteN}] `;
          }
        } else if (name === 'table') {
          const table: Table = { type: 'table', rows: [] };
          containers[containers.length - 1].push(table);
          tables.push({ table, outer: containers });
          containers = [...containers];
        } else if (name === 'tr' && tables.length) {
          tables[tables.length - 1].table.rows.push({ header: has('thead'), cells: [] });
        } else if ((name === 'td' || name === 'th') && tables.length) {
          const rows = tables[tables.length - 1].table.rows;
          if (!rows.length) rows.push({ header: false, cells: [] });
          const cell: Block[] = [];
          rows[rows.length - 1].cells.push(cell);
          containers = [...tables[tables.length - 1].outer, cell];
        } else if (name === 'pre') {
          el.attrs['data-fresh'] = '1';
        }
      }
      if (!el.hidden && !math && name === 'span' && cls.includes('katex')) {
        math = { tex: '', a0: text.length, depth: stack.length, fmt: el.fmt };
      }
      if (!el.hidden && !math && !el.noDocx) {
        if (name === 'br') {
          openPara().runs.push({ kind: 'br', text: '', a0: text.length, a1: text.length, split: false, fmt: {} });
          afterBr = true;
        } else if (name === 'img') {
          openPara().runs.push({ kind: 'image', text: '', a0: text.length, a1: text.length, split: false, fmt: { ...el.fmt }, image: { src: attrs.src || '', alt: attrs.alt || '' } });
        } else if (name === 'input' && (attrs.type || '').toLowerCase() === 'checkbox') {
          addExtra('checked' in attrs ? '☒ ' : '☐ ', {});
        }
      }
      // `<path/>` in KaTeX's SVG closes itself; a stray `<div/>` in raw HTML is treated the same.
      if (!VOID.has(name) && !tok.self) stack.push(el);
      continue;
    }
    // close
    const { name } = tok;
    let k = stack.length - 1;
    while (k >= 0 && stack[k].name !== name) k--;
    if (k < 0) continue; // stray close tag
    while (stack.length > k) {
      const el = stack.pop()!;
      if (el.name === 'annotation') annotation = false;
      if (math && stack.length === math.depth) {
        const tex = math.tex.trim();
        const p = openPara();
        p.runs.push({ kind: 'text', text: tex, a0: math.a0, a1: text.length, split: false, fmt: { ...math.fmt, code: true } });
        math = null;
      }
      if (BLOCK.has(el.name) && !el.hidden && !math) {
        closePara();
        if (el.name === 'table' && tables.length) containers = tables.pop()!.outer;
        else if ((el.name === 'td' || el.name === 'th') && tables.length) containers = [...tables[tables.length - 1].outer];
      }
    }
  }
  closePara();
  return { text, blocks, lists, lines };
}

/**
 * The text as the exported .docx reads (math as TeX, footnote numbers, task
 * boxes, one "\n" per paragraph), with the slice of the view's text each
 * character stands for. Import matches Word quotes here first, so a comment
 * on an exported equation still finds its place.
 */
export interface WordView {
  text: string;
  from: number[];
  to: number[];
}

const wordViews = new WeakMap<DocModel, WordView>();

export function wordView(model: DocModel): WordView {
  const cached = wordViews.get(model);
  if (cached) return cached;
  const v: WordView = { text: '', from: [], to: [] };
  let last = 0;
  const put = (s: string, from: (i: number) => number, to: (i: number) => number) => {
    for (let i = 0; i < s.length; i++) {
      v.text += s[i];
      v.from.push(from(i));
      v.to.push(to(i));
    }
  };
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type === 'table') {
        for (const row of b.rows) {
          for (const cell of row.cells) {
            walk(cell);
            if (!cell.length || cell[cell.length - 1].type !== 'p') put('\n', () => last, () => last);
          }
        }
        continue;
      }
      for (const r of b.runs) {
        if (r.kind === 'br') put('\n', () => r.a0, () => r.a0);
        else if (r.kind === 'text' && r.text) {
          const s = b.code ? r.text : r.text.replace(/[\n\r]/g, ' ');
          if (r.split) put(s, (i) => r.a0 + i, (i) => r.a0 + i + 1);
          else put(s, () => r.a0, () => r.a1);
        }
        if (r.a1 > r.a0) last = r.a1;
      }
      put('\n', () => last, () => last);
    }
  };
  walk(model.blocks);
  wordViews.set(model, v);
  return v;
}

/** Source lines (1-based, inclusive) under [start, end) of the model's text. */
export function linesAt(model: DocModel, start: number, end: number): [number, number] {
  let ls = Infinity;
  let le = 0;
  for (const l of model.lines) {
    if (l.a1 <= start || l.a0 >= Math.max(end, start + 1)) continue;
    ls = Math.min(ls, l.ls);
    le = Math.max(le, l.le);
  }
  return ls === Infinity ? [0, 0] : [ls + 1, le];
}

/** A path on this machine (relative, absolute or on a drive), as the renderer decides: not a URL, `//host` or `\\host`. */
export function isLocalImage(src: string): boolean {
  return !!src && !hasUrlScheme(src) && !/^[\\/]{2}/.test(src);
}

export function resolveLocal(docDir: string, src: string): string {
  let p = src.split(/[?#]/)[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as is */
  }
  return path.resolve(docDir, p);
}
