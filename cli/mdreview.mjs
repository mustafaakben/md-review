#!/usr/bin/env node
// mdreview — zero-dependency CLI for agents to work MD Review comment sidecars.
//
//   node mdreview.mjs list    [paths…] [--status draft|submitted|resolved] [--json]
//   node mdreview.mjs summary [paths…]
//   node mdreview.mjs next    [paths…] [--all] [--json]
//   node mdreview.mjs context <file.md> <id> [--lines 2] [--json]
//   node mdreview.mjs show    <file.md> <id>
//   node mdreview.mjs reply   <file.md> <id> "<text>" [--author Claude]
//   node mdreview.mjs resolve <file.md> <id> ["<closing reply>"] [--author Claude]
//   node mdreview.mjs suggest <file.md> <id> "<replacement for the quote>" ["<note>"]
//   node mdreview.mjs reopen  <file.md> <id>
//   node mdreview.mjs comment <file.md> --quote "<text as it reads>" [--line N] [--kind question|praise]
//                             [--severity major|minor|nit] [--suggest "<replacement>"] "<body>"
//   node mdreview.mjs comment <file.md> --document "<body>"
//   node mdreview.mjs init-claude [folder] [--force]
//
// paths can be .md files or folders (searched recursively; default: the current
// folder). `next` prints the first open comment with the source lines its quote
// is on, so an agent can loop: next -> edit -> reply/resolve -> next. It skips
// threads whose last reply is from --author (waiting on the reviewer) unless --all.
// `comment` is for an agent reviewing first: it adds a draft from --author,
// marked origin "agent", for the reviewer to keep, act on, or dismiss.
//
// Every write re-reads the sidecar, applies the change, and writes it back, so
// it never clobbers comments the viewer added in the meantime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const bool = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

const status = flag('status');
const author = flag('author', 'Claude');
const around = Math.max(0, Number(flag('lines', 2)) || 0);
const asJson = bool('json');
const force = bool('force');
const includeAll = bool('all');
const quoteArg = flag('quote');
const lineArg = flag('line');
const kindArg = flag('kind');
const severityArg = flag('severity');
const suggestArg = flag('suggest');
const wholeDoc = bool('document');
const [cmd, ...rest] = args;

function usage(code = 1) {
  const head = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  console.error(head.slice(1, head.indexOf("import fs from 'node:fs';")).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(code);
}
if (!cmd) usage();

const now = () => new Date().toISOString();
const newId = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const mdOf = (p) => path.resolve(p.replace(/\.comments\.json$/, ''));
const sideOf = (md) => md + '.comments.json';
const shown = (md) => {
  const r = path.relative(process.cwd(), md);
  return !r || r.startsWith('..') || path.isAbsolute(r) ? md : r.split(path.sep).join('/');
};

function read(md) {
  const side = sideOf(md);
  const empty = { schemaVersion: 1, file: path.basename(md), comments: [] };
  if (!fs.existsSync(side)) return empty;
  const raw = fs.readFileSync(side, 'utf8').replace(/^﻿/, '');
  return raw.trim() ? JSON.parse(raw) : empty;
}
/** read() for commands that scan many files: a broken sidecar is reported and skipped. */
function readOrSkip(md) {
  try {
    return read(md);
  } catch (e) {
    console.error(`Skipping ${shown(sideOf(md))}: ${e.message}`);
    return { comments: [] };
  }
}
function mutate(md, fn) {
  const side = sideOf(md);
  const data = read(md);
  data.comments ||= [];
  fn(data);
  const tmp = `${side}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, side);
  } catch {
    fs.writeFileSync(side, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.rmSync(tmp, { force: true });
  }
  return data;
}
// Mark the thread an agent is on, so the viewer can show "Claude is working"
// there; reply and resolve clear it. Moving on clears our older marks.
function claim(md, id) {
  mutate(md, (d) => {
    for (const x of d.comments) {
      if (x.id === id) {
        x.workingAt = now();
        x.workingBy = author;
      } else if (x.workingBy === author) {
        delete x.workingAt;
        delete x.workingBy;
      }
    }
  });
}
function unclaim(c) {
  delete c.workingAt;
  delete c.workingBy;
}
function find(data, cid) {
  const c = (data.comments || []).find((x) => x.id === cid);
  if (!c) {
    console.error(`No comment with id ${cid}`);
    process.exit(2);
  }
  c.replies ||= [];
  return c;
}

/** The Markdown files the given paths cover: files as-is, folders searched for sidecars. */
function collect(paths) {
  const out = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md.comments.json')) out.add(mdOf(p));
    }
  };
  for (const p of paths.length ? paths : ['.']) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      st = null;
    }
    if (st?.isDirectory()) walk(path.resolve(p));
    else if (st || fs.existsSync(sideOf(mdOf(p)))) out.add(mdOf(p));
    else {
      console.error(`Not found: ${p}`);
      process.exit(2);
    }
  }
  return [...out].sort();
}

// ---- locating a comment's quote in the Markdown source ----
//
// The quote is rendered text: markup is gone. Compare letters and digits only,
// after blanking link targets, footnote refs, HTML tags, and {attrs} (same
// length, so offsets stay put). Several matches are ranked by prefix/suffix
// agreement, then by distance from the stored line hint.
const WORD = /[\p{L}\p{N}]/u;
function keyed(s) {
  let key = '';
  const at = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (WORD.test(ch)) {
      // Lowercasing can lengthen a character (İ -> i̇); keep `at` in step with `key`.
      for (const k of ch.toLowerCase()) {
        key += k;
        at.push(i);
      }
    }
  }
  return { key, at };
}
const blank = (m) => m.replace(/[^\n]/g, ' ');
function lineIndex(src) {
  const starts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  // 1-based line number of offset i (binary search over line starts).
  return (i) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** The character an HTML entity (`amp`, `#233`, `#xE9`) stands for, if it's one we know. */
function entity(k) {
  k = k.toLowerCase();
  if (k[0] !== '#') return ENTITY[k];
  const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
}

// The masked search key for one source, kept while the same file is searched
// again (next locates every open comment in a file).
let prepared = null;
function prepare(src) {
  if (prepared?.src === src) return prepared;
  // Code shows as written, so markup-looking text in it stays.
  const code = [...src.matchAll(CODE)].map((m) => [m.index, m.index + m[0].length]);
  const text = (fn) => (m, ...a) => {
    const at = a[a.length - 2];
    return code.some(([s, e]) => at < e && at + m.length > s) ? m : fn(m, ...a);
  };
  // Citations first, while `[x](url)` still shows it's a link, not a citation.
  const masked = maskCitations(src)
    .replace(/\]\([^)\n]*\)/g, text((m) => ']' + blank(m.slice(1))))
    .replace(/\[\^[^\]\n]*\]/g, text(blank))
    // Never across $…$ math, where `<`, `>`, and `{k=v}` are LaTeX, not markup.
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>\n]*)?\/?>/g, text((m) => (m.includes('$') ? m : blank(m))))
    .replace(/(?<![\w\\^_])\{(?:[#.][\w-]|[\w-]+=)[^}\n]*\}/g, text((m) => (m.includes('$') ? m : blank(m))))
    // An entity shows as its character: `AT&amp;T` reads "AT&T".
    .replace(
      /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi,
      text((m, k) => {
        const ch = entity(k);
        return ch && ch.length === 1 ? ch + ' '.repeat(m.length - 1) : m;
      }),
    );
  prepared = { src, ...keyed(masked), lineAt: lineIndex(src) };
  return prepared;
}

// Citations and cross-refs render as generated text the viewer leaves out of
// quotes, so blank them too: `[see @a, p. 4]`, `@a [p. 4]`, `@fig:x`. Bare
// `@key` is only a citation when the front matter names a bibliography.
const CITE_KEY = String.raw`[\p{L}\p{N}_]+(?:[:.#$%&\-+?~/]+[\p{L}\p{N}_]+)*`;
// One line, bounded, so a stray `[` can't reach across paragraphs or go quadratic.
const BRACKET_CITE = new RegExp(String.raw`\[(?:[^\[\]\n\x60]{0,200}?[^\p{L}\p{N}_@\[\]\n\\\x60])?-?@${CITE_KEY}[^\[\]\n\x60]{0,200}\](?![(\[])`, 'gu');
const BARE_CITE = new RegExp(String.raw`(?<![\p{L}\p{N}_@.\\/:-])@${CITE_KEY}(?: \[[^\]@\n]*\](?!\())?`, 'gu');
const XREF_CITE = new RegExp(String.raw`(?<![\p{L}\p{N}_@.\\/:-])@(?:fig|tbl|eq|sec):${CITE_KEY}`, 'giu');
const XREF_BRACKET = /\[[^\[\]\n`]{0,200}@(?:fig|tbl|eq|sec):[^\[\]\n`]{0,200}\](?![(\[])/gi;
const CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))|`[^`\n]+`/gm;
function maskCitations(src) {
  if (!src.includes('@')) return src;
  const fm = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  // Same rule as the viewer: a bibliography that names at least one file.
  const bib = fm && /^bibliography:[ \t]*(?!(?:\[\s*\]|""|''|~|null)[ \t]*(?:#.*)?$)(?:[^\s#]|\r?\n[ \t]+-[ \t]*\S)/m.test(fm[1]);
  const head = fm ? fm[0].length : 0;
  const body = src.slice(head);
  // Code shows as written, so leave `@x` in fences and backticks alone.
  const code = [...body.matchAll(CODE)].map((m) => [m.index, m.index + m[0].length]);
  const mask = (m, ...a) => {
    const at = a[a.length - 2];
    return code.some(([s, e]) => at < e && at + m.length > s) ? m : blank(m);
  };
  const out = bib ? body.replace(BRACKET_CITE, mask).replace(BARE_CITE, mask) : body.replace(XREF_BRACKET, mask).replace(XREF_CITE, mask);
  return src.slice(0, head) + out;
}

function locate(src, anchor) {
  const q = keyed(anchor?.quote || '').key;
  if (!q) return null;
  const { key, at, lineAt } = prepare(src);
  const pre = keyed(anchor.prefix || '').key.slice(-12);
  const suf = keyed(anchor.suffix || '').key.slice(0, 12);
  let best = null;
  let count = 0;
  for (let i = key.indexOf(q); i >= 0; i = key.indexOf(q, i + 1)) {
    count++;
    const start = lineAt(at[i]);
    const score =
      (pre && key.slice(Math.max(0, i - pre.length), i) === pre ? 2 : 0) +
      (suf && key.slice(i + q.length, i + q.length + suf.length) === suf ? 2 : 0) -
      (anchor.lineStart ? Math.min(1, Math.abs(start - anchor.lineStart) / 1000) : 0);
    if (!best || score > best.score) best = { score, i, start };
  }
  if (!best) return null;
  return { lineStart: best.start, lineEnd: lineAt(at[best.i + q.length - 1]), matches: count };
}

/** The comment plus where its quote is in the source, and those lines. */
function readSource(md) {
  try {
    return fs.readFileSync(md, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}
// CommonMark's HTML block tags (type 6): these start a raw HTML block even inside a paragraph.
const HTML_BLOCK = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i;
/** Last line (1-based) of the section whose heading is on line `h`: before the next heading at its level or above. */
function sectionEnd(lines, h) {
  const atx = (t) => /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(t);
  const m = atx(lines[h - 1] || '');
  const level = m ? m[1].length : /^ {0,3}=+[ \t]*$/.test(lines[h] || '') ? 1 : 2; // ATX, else setext
  let fence = null;
  let html = null; // what ends the raw HTML block we're in: a closing tag, '-->', or a blank line
  let para = 0; // first line of the paragraph just above, which a setext underline turns into a heading
  for (let n = h + 1; n <= lines.length; n++) {
    const t = lines[n - 1];
    if (html) {
      if (html === 'blank' ? !t.trim() : t.toLowerCase().includes(html)) html = null;
      continue;
    }
    const raw = /^ {0,3}<(?:(!--)|(script|pre|style|textarea)(?=[\s>]|$)|\/?([a-z][a-z0-9-]*)(?=[\s/>]|$))/i.exec(t);
    if (raw && (raw[1] || raw[2] || !para || HTML_BLOCK.test(raw[3]))) {
      const close = raw[1] ? '-->' : raw[2] ? `</${raw[2].toLowerCase()}>` : 'blank';
      if (close === 'blank' || !t.toLowerCase().includes(close, raw.index + 4)) html = close;
      para = 0;
      continue;
    }
    if (fence) {
      // Closed only by the same character, at least as long, and nothing after it.
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(t);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      continue;
    }
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(t);
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      para = 0;
      continue;
    }
    const a = atx(t);
    if (a) {
      if (a[1].length <= level) return n - 1;
      para = 0;
      continue;
    }
    const u = /^ {0,3}(=+|-+)[ \t]*$/.exec(t);
    if (u && para) {
      if ((u[1][0] === '=' ? 1 : 2) <= level) return para - 1;
      para = 0;
      continue;
    }
    if (!t.trim() || /^ {0,3}(?:[-*+][ \t]|\d+[.)][ \t]|>)/.test(t) || /^ {4}/.test(t) && !para) para = 0;
    else if (!para) para = n;
  }
  let end = lines.length;
  while (end > h && !lines[end - 1].trim()) end--;
  return end;
}
const SEVERITY_RANK = { major: 0, minor: 1, nit: 2 };
const severityRank = (c) => SEVERITY_RANK[c.severity] ?? 3;
const tagsOf = (c) => [c.scope === 'document' ? 'whole document' : c.scope === 'section' ? 'whole section' : '', c.kind === 'question' || c.kind === 'praise' ? c.kind : '', SEVERITY_RANK[c.severity] != null ? c.severity : ''].filter(Boolean);
const KIND_HINT = { question: "a question: answer it in a reply, don't edit the document", praise: 'praise: no change needed; resolve it' };

function contextOf(md, c) {
  const src = readSource(md);
  const lines = src != null ? src.split(/\r?\n/) : [];
  if (c.scope === 'document') return { file: shown(md), found: true, lineStart: 0, lineEnd: 0, source: [] };
  const hit = src != null ? locate(src, c.anchor) : null;
  const ls = hit?.lineStart || c.anchor?.lineStart || 0;
  let le = hit?.lineEnd || c.anchor?.lineEnd || ls;
  if (c.scope === 'section' && hit) le = Math.max(le, sectionEnd(lines, ls));
  const from = ls ? Math.max(1, ls - around) : 0;
  const to = ls ? Math.min(lines.length, le + around) : -1;
  const source = [];
  for (let n = from; n && n <= to; n++) source.push({ line: n, text: lines[n - 1], quoted: n >= ls && n <= le });
  return { file: shown(md), found: !!hit, lineStart: ls, lineEnd: le, source };
}

// ---- building an anchor for a new comment (the agent as first reviewer) ----
//
// The viewer anchors on rendered text: the quote, plus up to 32 characters of
// context each side. Without a renderer, approximate that text from the source:
// drop markup, keep what shows. Where the source renders as text we can't
// reproduce (footnote markers, math, the front matter card) the context stops,
// since the viewer trusts a match by how much of its context agrees.
const DROP = '\0';
const STOP = '\u0001';
function plainText(src) {
  const n = src.length;
  const out = src.split('');
  const lit = new Uint8Array(n); // code and escaped characters: shown as written
  const fill = (a, b, ch, force = false) => {
    for (let k = a; k < b; k++) if (force || (!lit[k] && out[k] !== STOP)) out[k] = ch;
  };
  const each = (re, fn) => {
    for (const m of src.matchAll(re)) {
      let busy = false;
      for (let k = m.index; k < m.index + m[0].length && !busy; k++) busy = !!lit[k];
      if (!busy) fn(m, m.index);
    }
  };
  const lines = [];
  for (let i = 0, s = 0; i <= n; i++) if (i === n || src[i] === '\n') lines.push([s, (s = i + 1) - 1]);
  const lineAt = (s, e) => src.slice(s, e).replace(/\r$/, '');
  // Front matter shows as a title card.
  const fm = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/.exec(src);
  if (fm) {
    fill(0, fm[0].length, STOP, true);
    lit.fill(1, 0, fm[0].length);
  }
  // Fences: the fence lines go, the code shows as written.
  let fence = null;
  for (const [s, e] of lines) {
    if (lit[s]) continue;
    const t = lineAt(s, e);
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(t);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !t.slice(f[0].length).trim()) {
        fill(s, e, DROP, true);
        fence = null;
      }
      lit.fill(1, s, e + 1);
    } else if (f) {
      fence = f[1];
      fill(s, e, DROP, true);
      lit.fill(1, s, e + 1);
    }
  }
  each(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, (m, i) => {
    fill(i, i + m[1].length, DROP);
    fill(i + m[0].length - m[1].length, i + m[0].length, DROP);
    lit.fill(1, i, i + m[0].length);
  });
  each(/\\([!-/:-@[-`{-~])/g, (m, i) => {
    out[i] = DROP;
    lit[i] = lit[i + 1] = 1;
  });
  each(/\\\r?\n/g, (m, i) => void (out[i] = DROP));
  each(/\$\$[\s\S]*?\$\$|\$(?=\S)[^$\n]*?\S\$(?!\d)|\$[^\s$]\$/g, (m, i) => fill(i, i + m[0].length, STOP));
  each(/<!--[\s\S]*?-->/g, (m, i) => fill(i, i + m[0].length, DROP));
  // Citations and cross-refs render as UI the viewer leaves out of the text.
  const cited = maskCitations(src);
  for (let k = 0; k < n; k++) if (cited[k] !== src[k] && !lit[k]) out[k] = DROP;
  each(/!\[[^\]\n]*\]\([^)\n]*\)/g, (m, i) => fill(i, i + m[0].length, DROP));
  each(/^ {0,3}\[\^[^\]\n]*\]:[ \t]*/gm, (m, i) => fill(i, i + m[0].length, STOP));
  each(/\[\^[^\]\n]*\]/g, (m, i) => fill(i, i + m[0].length, STOP));
  each(/^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]+\S.*$/gm, (m, i) => fill(i, i + m[0].length, DROP)); // link definitions
  each(/\[([^\]\n]*)\](\([^)\n]*\)|\[[^\]\n]*\])/g, (m, i) => {
    out[i] = DROP;
    fill(i + 1 + m[1].length, i + m[0].length, DROP);
  });
  each(/<(?:https?:|mailto:)[^>\s]*>/g, (m, i) => {
    out[i] = DROP;
    out[i + m[0].length - 1] = DROP;
  });
  each(/<\/?[a-zA-Z][\w-]*(?:\s[^<>\n]*)?\/?>/g, (m, i) => fill(i, i + m[0].length, DROP));
  each(/(?<![\w\\^_])\{(?:[#.][\w-]|[\w-]+=)[^}\n]*\}/g, (m, i) => fill(i, i + m[0].length, DROP));
  each(/\{(?:\+\+|--|~~|==|>>)|(?:\+\+|--|~~|==|<<)\}|~>/g, (m, i) => fill(i, i + m[0].length, DROP));
  each(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, i) => {
    const ch = entity(m[1]);
    if (!ch) return;
    fill(i, i + m[0].length, DROP);
    out[i] = ch;
  });
  // Block markers at the start of a line, rules, and table syntax.
  const isSep = (t) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(t) || /^\s*\|\s*:?-+:?\s*\|\s*$/.test(t);
  let table = false;
  for (let li = 0; li < lines.length; li++) {
    const [s, e] = lines[li];
    if (lit[s]) continue;
    const t = lineAt(s, e);
    const next = lines[li + 1] ? lineAt(...lines[li + 1]) : '';
    if (!t.trim()) table = false;
    else if (t.includes('|') && isSep(next)) table = true;
    if (/^ {0,3}([-=*_])(?:[ \t]*\1){2,}[ \t]*$/.test(t) || (table && isSep(t))) {
      fill(s, e, DROP);
      continue;
    }
    if (table) for (let k = s; k < e; k++) if (src[k] === '|' && src[k - 1] !== '\\' && !lit[k]) out[k] = ' ';
    const lead = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}(?=[ \t]|$)|\[!\w+\][ \t]*$)?/.exec(t)[0];
    fill(s, s + lead.length, DROP);
    const close = /[ \t]#+[ \t]*$/.exec(t);
    if (/^ {0,3}#{1,6}[ \t]/.test(t) && close) fill(s + close.index, e, DROP);
  }
  // Emphasis: doubled delimiters always; a single * unless spaced on both sides; a single _ at a word edge.
  each(/\*\*|__|~~|==/g, (m, i) => fill(i, i + 2, DROP));
  // Subscript and superscript: H~2~O, 2^10^.
  each(/(?<![~\\])~(?!~)[^~\s]+~(?!~)|(?<!\\)\^[^^\s\]]+\^/g, (m, i) => {
    fill(i, i + 1, DROP);
    fill(i + m[0].length - 1, i + m[0].length, DROP);
  });
  const word = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
  for (let k = 0; k < n; k++) {
    if (lit[k] || out[k] !== src[k]) continue;
    const a = src[k - 1];
    const b = src[k + 1];
    if (src[k] === '*' && !(/\s/.test(a || ' ') && /\s/.test(b || ' '))) out[k] = DROP;
    if (src[k] === '_' && word(a) !== word(b)) out[k] = DROP;
  }
  // Collapse whitespace; remember where a STOP fell between two characters.
  let text = '';
  const at = [];
  const stop = [];
  let pending = false;
  for (let k = 0; k < n; k++) {
    const ch = out[k];
    if (ch === DROP) continue;
    if (ch === STOP) {
      pending = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (!text || text.endsWith(' ')) continue;
      text += ' ';
    } else text += ch;
    at.push(k);
    stop.push(pending);
    pending = false;
  }
  return { text, at, stop };
}

/** 1-based first and last line of the block(s) covering source lines a..b. */
function blockLines(lines, a, b) {
  const starts = (t) => /^ {0,3}(#{1,6}[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>|`{3,}|~{3,}|\|)/.test(t);
  const single = (t) => /^ {0,3}(#{1,6}[ \t]|\|)/.test(t);
  let fence = null;
  const inFence = [];
  for (let i = 0; i < lines.length; i++) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      inFence[i] = fence;
      if (f && f[1][0] === fence.ch) fence = null;
    } else if (f) inFence[i] = fence = { ch: f[1][0], start: i };
  }
  let ls = a;
  if (inFence[a - 1]) ls = inFence[a - 1].start + 1;
  else while (ls > 1 && lines[ls - 2].trim() && !starts(lines[ls - 1]) && !single(lines[ls - 2]) && !inFence[ls - 2]) ls--;
  let le = b;
  if (inFence[b - 1]) {
    while (le < lines.length && inFence[le]) le++;
  } else if (!single(lines[b - 1])) while (le < lines.length && lines[le].trim() && !starts(lines[le]) && !inFence[le]) le++;
  return [ls, le];
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Anchor `quote` (rendered text) in the source: every place its letters and
 * digits occur, narrowed to exact matches of the rendered text when there
 * are some, then to the one nearest `line`. Exits 2 when that isn't one place.
 */
function anchorFor(md, src, quote, line) {
  const q = keyed(quote).key;
  if (!q) fail('The quote needs some letters or digits.');
  const { key, at } = prepare(src);
  const plain = plainText(src);
  const lines = src.split(/\r?\n/);
  const lineOf = lineIndex(src);
  // First plain-text index at or after source offset o.
  const toPlain = (o) => {
    let lo = 0;
    let hi = plain.at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (plain.at[mid] < o) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const lead = /^[^\p{L}\p{N}]*/u.exec(quote.trim())[0];
  const trail = /[^\p{L}\p{N}]*$/u.exec(quote.trim())[0];
  const found = [];
  for (let i = key.indexOf(q); i >= 0; i = key.indexOf(q, i + 1)) {
    const s = at[i];
    const e = at[i + q.length - 1];
    let pa = toPlain(s);
    let pb = toPlain(e + 1) - 1;
    const clean = plain.at[pa] === s && plain.at[pb] === e && !plain.stop.slice(pa + 1, pb + 1).some(Boolean);
    // Punctuation at the ends of the quote isn't in the key: take it when the text has it there.
    if (lead && plain.text.slice(pa - lead.length, pa) === lead && !plain.stop.slice(pa - lead.length + 1, pa + 1).some(Boolean)) pa -= lead.length;
    if (trail && plain.text.slice(pb + 1, pb + 1 + trail.length) === trail && !plain.stop.slice(pb + 1, pb + 1 + trail.length).some(Boolean)) pb += trail.length;
    found.push({ pa, pb, clean, line: lineOf(s), lastLine: lineOf(e), text: plain.text.slice(pa, pb + 1) });
  }
  if (!found.length) fail(`Quote not found in ${shown(md)}: "${quote}". Quote the text exactly as it reads in the document.`);
  const exact = found.filter((f) => collapse(f.text) === collapse(quote));
  let pool = exact.length ? exact : found;
  if (pool.length > 1 && line) {
    const d = (f) => (line < f.line ? f.line - line : line > f.lastLine ? line - f.lastLine : 0);
    const best = Math.min(...pool.map(d));
    pool = pool.filter((f) => d(f) === best);
  }
  if (pool.length > 1) {
    const where = [...new Set(pool.map((f) => f.line))].join(', ');
    fail(
      line
        ? `The quote appears ${pool.length} times on line ${where}. Quote more of the passage so it is unique.`
        : `The quote appears ${pool.length} times (lines ${where}). Add --line <n> for the one you mean, or quote more of the passage.`,
    );
  }
  const hit = pool[0];
  if (!hit.clean) fail(`The quote runs into a footnote marker, math, an image or the front matter, which the viewer can't anchor on. Quote a passage of plain text.`);
  // Context: up to 32 characters each side, stopping where the rendered text is unknown.
  let s = hit.pa;
  while (s > 0 && hit.pa - s < 32 && !plain.stop[s]) s--;
  let e = hit.pb + 1;
  while (e < plain.text.length && e - hit.pb - 1 < 32 && !plain.stop[e]) e++;
  const [lineStart, lineEnd] = blockLines(lines, hit.line, hit.lastLine);
  return { anchor: { quote: hit.text, prefix: plain.text.slice(s, hit.pa), suffix: plain.text.slice(hit.pb + 1, e), lineStart, lineEnd }, asGiven: collapse(hit.text) === collapse(quote) };
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

const sugState = (s) => (s.appliedAt ? ' (applied)' : s.dismissedAt ? ' (dismissed)' : '');
function describe(c) {
  const lines = c.anchor?.lineStart ? `L${c.anchor.lineStart}-${c.anchor.lineEnd}` : 'L?';
  const tags = tagsOf(c);
  let s = `[${c.id}] ${String(c.status).toUpperCase()} ${c.scope === 'document' ? 'document' : lines} ${c.author} ${c.createdAt}${tags.length ? ` (${tags.join(', ')})` : ''}${c.scope === 'document' ? '' : `\n  quote: "${c.anchor?.quote}"`}\n  body:  ${c.body}`;
  if (c.suggestion) s += `\n  suggestion: replace the quote with "${c.suggestion.text}"${sugState(c.suggestion)}`;
  for (const r of c.replies || []) s += `\n    ↳ ${r.author} (${r.createdAt}): ${r.body}${r.suggestion ? ` [suggests "${r.suggestion.text}"${sugState(r.suggestion)}]` : ''}`;
  return s;
}
function describeWithContext(c, ctx) {
  const where = ctx.lineStart
    ? `${ctx.file}:${ctx.lineStart}${ctx.lineEnd !== ctx.lineStart ? `-${ctx.lineEnd}` : ''}`
    : ctx.file;
  const tags = tagsOf(c);
  let s = `[${c.id}] ${String(c.status).toUpperCase()} ${where} ${c.author}${tags.length ? ` (${tags.join(', ')})` : ''}\n  comment: ${c.body}`;
  if (c.scope === 'document') s += '\n  about:   the whole document';
  else s += `\n  ${c.scope === 'section' ? 'section:' : 'quote:  '} "${c.anchor?.quote}"`;
  if (KIND_HINT[c.kind]) s += `\n  (${KIND_HINT[c.kind]})`;
  if (c.suggestion) s += `\n  suggestion: replace the quote with "${c.suggestion.text}"${sugState(c.suggestion)}`;
  for (const r of c.replies || []) s += `\n    ↳ ${r.author}: ${r.body}${r.suggestion ? ` [suggests "${r.suggestion.text}"${sugState(r.suggestion)}]` : ''}`;
  if (!ctx.found) s += `\n  (quote not found in the source as-is${ctx.lineStart ? '; showing the stored line hint' : ''})`;
  if (ctx.source.length) {
    const w = String(ctx.source.at(-1).line).length;
    s += '\n' + ctx.source.map((l) => `${l.quoted ? '>' : ' '} ${String(l.line).padStart(w)} | ${l.text}`).join('\n');
  }
  return s;
}
// Waiting on us: submitted, and our reply isn't the last word (or the reviewer
// reopened the thread after it). Same rule as awaitsAgent() in the extension.
function awaits(c) {
  if (c.status !== 'submitted') return false;
  const last = c.replies?.at(-1);
  return !last || last.author !== author || (!!c.reopenedAt && c.reopenedAt > last.createdAt);
}
const byLine = (a, b) => (a.anchor?.lineStart || 0) - (b.anchor?.lineStart || 0);

function initClaude(dir) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dest = path.join(path.resolve(dir || '.'), '.claude', 'skills', 'md-review');
  const files = [
    [path.join(here, 'SKILL.md'), path.join(dest, 'SKILL.md')],
    [path.join(here, 'mdreview.mjs'), path.join(dest, 'mdreview.mjs')],
  ];
  const skill = files[0][1];
  if (!force && fs.existsSync(skill) && fs.readFileSync(skill, 'utf8') !== fs.readFileSync(files[0][0], 'utf8')) {
    console.error(`${shown(skill)} exists and differs from this version. Re-run with --force to replace it.`);
    process.exit(2);
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const [from, to] of files) fs.copyFileSync(from, to);
  console.log(`Wrote ${shown(dest)}/SKILL.md and mdreview.mjs. Claude Code will now pick up MD Review comments in this folder.`);
}

switch (cmd) {
  case 'list': {
    const groups = collect(rest).map((md) => ({
      md,
      cs: (readOrSkip(md).comments || []).filter((c) => !status || c.status === status).sort(byLine),
    }));
    if (asJson) {
      console.log(JSON.stringify(groups.flatMap((g) => g.cs.map((c) => ({ ...c, file: shown(g.md) }))), null, 2));
      break;
    }
    const nonEmpty = groups.filter((g) => g.cs.length);
    if (!nonEmpty.length) console.log('(no comments)');
    else if (groups.length === 1) console.log(nonEmpty[0].cs.map(describe).join('\n\n'));
    else console.log(nonEmpty.map((g) => `== ${shown(g.md)}\n\n` + g.cs.map(describe).join('\n\n')).join('\n\n'));
    break;
  }
  case 'summary': {
    const rows = collect(rest).map((md) => {
      const n = { draft: 0, submitted: 0, resolved: 0, waiting: 0 };
      for (const c of readOrSkip(md).comments || []) {
        if (c.status in n) n[c.status]++;
        if (c.status === 'submitted' && !awaits(c)) n.waiting++;
      }
      return { file: shown(md), ...n };
    });
    if (asJson) {
      console.log(JSON.stringify(rows, null, 2));
      break;
    }
    if (!rows.length) {
      console.log('(no review files)');
      break;
    }
    const w = Math.max(...rows.map((r) => r.file.length));
    const total = { draft: 0, submitted: 0, resolved: 0, waiting: 0 };
    const line = (name, r) =>
      `${name.padEnd(w)}  ${r.submitted} open${r.waiting ? ` (${r.waiting} waiting on the reviewer)` : ''} · ${r.draft} draft · ${r.resolved} resolved`;
    for (const r of rows) {
      for (const k in total) total[k] += r[k];
      console.log(line(r.file, r));
    }
    if (rows.length > 1) console.log(line('total', total));
    break;
  }
  case 'next': {
    let waiting = 0;
    const open = collect(rest).flatMap((md) => {
      const src = readSource(md);
      return (
        (readOrSkip(md).comments || [])
          // A thread whose last word is ours is waiting on the reviewer, not us.
          .filter((c) => {
            if (c.status !== 'submitted') return false;
            if (includeAll || awaits(c)) return true;
            waiting++;
            return false;
          })
          // Major first, then document order by where the quote actually is, not the (possibly stale) hint.
          .map((c) => ({ md, c, line: c.scope === 'document' ? 0 : (src != null && locate(src, c.anchor)?.lineStart) || c.anchor?.lineStart || 0 }))
          .sort((a, b) => severityRank(a.c) - severityRank(b.c) || a.line - b.line)
      );
    });
    open.sort((a, b) => severityRank(a.c) - severityRank(b.c)); // stable: files keep their order
    const also = waiting ? ` (${waiting} waiting on the reviewer's answer; --all includes them)` : '';
    if (!open.length) {
      console.log(asJson ? 'null' : `No open comments.${also}`);
      break;
    }
    const { md, c } = open[0];
    if (awaits(c)) claim(md, c.id); // not a thread that's waiting on the reviewer (--all)
    const ctx = contextOf(md, c);
    if (asJson) {
      console.log(JSON.stringify({ comment: c, ...ctx, remaining: open.length - 1, waiting }, null, 2));
      break;
    }
    console.log(describeWithContext(c, ctx));
    const more = open.length - 1;
    console.log(`\n${more ? `${more} more open after this one.` : 'This is the last open comment.'}${also} When done: reply/resolve "${ctx.file}" ${c.id}`);
    break;
  }
  case 'context': {
    const [mdArg, id] = rest;
    if (!mdArg || !id) usage();
    const md = mdOf(mdArg);
    if (!fs.existsSync(md) && !fs.existsSync(sideOf(md))) {
      console.error(`Not found: ${mdArg}`);
      process.exit(2);
    }
    const c = find(read(md), id);
    if (c.status === 'submitted' && awaits(c)) claim(md, id);
    const ctx = contextOf(md, c);
    console.log(asJson ? JSON.stringify({ comment: c, ...ctx }, null, 2) : describeWithContext(c, ctx));
    break;
  }
  case 'show': {
    const [mdArg, id] = rest;
    if (!mdArg || !id) usage();
    console.log(JSON.stringify(find(read(mdOf(mdArg)), id), null, 2));
    break;
  }
  case 'reply': {
    const [mdArg, id, text] = rest;
    if (!mdArg || !id || !text) usage();
    mutate(mdOf(mdArg), (d) => {
      const c = find(d, id);
      c.replies.push({ id: newId('r'), author, createdAt: now(), body: text });
      unclaim(c);
    });
    console.log(`Replied to ${id}`);
    break;
  }
  case 'suggest': {
    // Propose the quote's replacement instead of editing; the reviewer applies it.
    const [mdArg, id, text, note] = rest;
    if (!mdArg || !id || text === undefined) usage();
    mutate(mdOf(mdArg), (d) => {
      const c = find(d, id);
      if (!c.anchor?.quote || c.scope) {
        console.error(`${id} has no quote to replace (it's about a whole ${c.scope || 'document'}). Reply instead.`);
        process.exit(2);
      }
      // One line of plain text: a line break could change the block's structure.
      c.replies.push({ id: newId('r'), author, createdAt: now(), body: note || 'Suggested edit.', suggestion: { text: text.replace(/\s*\n\s*/g, ' ') } });
      unclaim(c);
    });
    console.log(`Suggested an edit on ${id}`);
    break;
  }
  case 'resolve': {
    const [mdArg, id, text] = rest;
    if (!mdArg || !id) usage();
    mutate(mdOf(mdArg), (d) => {
      const c = find(d, id);
      if (text) c.replies.push({ id: newId('r'), author, createdAt: now(), body: text });
      c.status = 'resolved';
      c.resolvedAt = now();
      unclaim(c);
    });
    console.log(`Resolved ${id}`);
    break;
  }
  case 'reopen': {
    const [mdArg, id] = rest;
    if (!mdArg || !id) usage();
    mutate(mdOf(mdArg), (d) => {
      const c = find(d, id);
      if (c.status === 'resolved') c.reopenedAt = now();
      c.status = 'submitted';
      c.resolvedAt = null;
    });
    console.log(`Reopened ${id}`);
    break;
  }
  case 'comment': {
    const [mdArg, body] = rest;
    if (!mdArg || !body?.trim() || rest.length > 2) usage();
    if (wholeDoc === (quoteArg !== undefined)) fail('Pass either --quote "<text>" or --document.');
    if (kindArg && !['comment', 'question', 'praise'].includes(kindArg)) fail('--kind is question or praise.');
    if (severityArg && !(severityArg in SEVERITY_RANK)) fail('--severity is major, minor or nit.');
    if (wholeDoc && suggestArg !== undefined) fail('--suggest replaces a quote; a whole-document comment has none.');
    const line = lineArg === undefined ? 0 : Number(lineArg);
    if (!Number.isInteger(line) || line < 0) fail('--line is a 1-based line number.');
    const md = mdOf(mdArg);
    const src = readSource(md);
    if (src == null) fail(`Not found: ${mdArg}`);
    const hit = wholeDoc ? null : anchorFor(md, src, quoteArg, line);
    const c = {
      id: newId('c'),
      author,
      createdAt: now(),
      anchor: hit ? hit.anchor : { quote: '', prefix: '', suffix: '', lineStart: 0, lineEnd: 0 },
      body: body.trim(),
      status: 'draft',
      submittedAt: null,
      resolvedAt: null,
      ...(wholeDoc ? { scope: 'document' } : {}),
      ...(kindArg && kindArg !== 'comment' ? { kind: kindArg } : {}),
      ...(severityArg ? { severity: severityArg } : {}),
      ...(suggestArg !== undefined ? { suggestion: { text: suggestArg } } : {}),
      origin: 'agent',
      replies: [],
    };
    mutate(md, (d) => void d.comments.push(c));
    const where = hit ? ` on L${c.anchor.lineStart}${c.anchor.lineEnd > c.anchor.lineStart ? `-${c.anchor.lineEnd}` : ''}` : ' on the whole document';
    console.log(`Added ${c.id}${where}, a draft for the reviewer.`);
    if (hit && !hit.asGiven) console.log(`Quoted as it reads: "${c.anchor.quote}"`);
    break;
  }
  case 'init-claude':
    initClaude(rest[0]);
    break;
  default:
    usage();
}
