// .docx -> review threads. Reads the comments (and threaded replies), the text
// each one covers, and tracked insertions/deletions, then anchors each on the
// Markdown's rendered text the way the view anchors a selection. Anything that
// can't be placed becomes a whole-document thread that quotes its text.
import * as path from 'path';
import type { Comment, Reply } from './commentStore';
import { newId, now } from './commentStore';
import { buildDocModel, DocModel, linesAt, wordView } from './docModel';
import { CONTEXT, Quote, locate, locateLoose, quoteAt } from './textQuote';
import { openZip, ZipReader } from './zip';

// ---- a tiny XML reader (docx parts are plain, namespaced XML) ----

export type XTok = { t: 'text'; s: string } | { t: 'open'; name: string; attrs: Record<string, string>; self: boolean } | { t: 'close'; name: string };

function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()] ?? m;
  });
}

/**
 * Tokens of an XML part, in one linear pass. DTDs are refused rather than
 * skipped: entity declarations are how "billion laughs" bombs and external
 * entities (XXE) get in, and Word never writes one. Only the five predefined
 * entities and character references are decoded.
 */
export function xmlTokens(src: string): XTok[] {
  if (/<!(DOCTYPE|ENTITY)/i.test(src)) throw new Error('This document declares a DTD, which MD Review does not read.');
  const out: XTok[] = [];
  let i = 0;
  const skipTo = (from: number, end: string) => {
    const e = src.indexOf(end, from);
    return e < 0 ? src.length : e + end.length;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0 || lt > i) out.push({ t: 'text', s: unescapeXml(src.slice(i, lt < 0 ? src.length : lt)) });
    if (lt < 0) break;
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      out.push({ t: 'text', s: src.slice(lt + 9, e < 0 ? src.length : e) });
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<!--', lt)) {
      i = skipTo(lt + 4, '-->');
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      i = skipTo(lt + 2, '>');
      continue;
    }
    // The tag's end, past any quoted attribute value (which may hold a '>').
    let j = lt + 1;
    for (let q = ''; j < src.length; j++) {
      const c = src[j];
      if (q) {
        if (c === q) q = '';
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
    }
    if (j >= src.length) break; // unterminated tag: the part is cut off
    const inner = src.slice(lt + 1, j);
    i = j + 1;
    if (inner[0] === '/') {
      out.push({ t: 'close', name: inner.slice(1).trim() });
      continue;
    }
    const name = /^[^\s/>]*/.exec(inner)![0];
    if (!name) continue;
    const attrs: Record<string, string> = {};
    // The value is optional, as in docModel's parseAttrs: required, a long run with no "=" is quadratic.
    const ar = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
    const rest = inner.slice(name.length);
    for (let a = ar.exec(rest); a; a = ar.exec(rest)) {
      const v = a[2] ?? a[3];
      if (v !== undefined) attrs[a[1]] = unescapeXml(v);
    }
    out.push({ t: 'open', name, attrs, self: /\/\s*$/.test(rest) });
  }
  return out;
}

/** Local name without the namespace prefix. */
const local = (n: string) => n.slice(n.indexOf(':') + 1);
const attr = (a: Record<string, string>, name: string) => {
  for (const k in a) if (local(k) === name) return a[k];
  return undefined;
};

// ---- reading the document ----

export interface WordComment {
  id: string;
  author: string;
  date?: string;
  text: string;
  /** Range in WordDoc.text (the original text: deletions in, insertions out). */
  start?: number;
  end?: number;
  /** Set for a threaded reply (Word 2013+ commentsExtended.xml). */
  parentId?: string;
  done?: boolean;
}

export interface WordChange {
  author: string;
  date?: string;
  /** Deleted text range in WordDoc.text; start === end for a pure insertion. */
  start: number;
  end: number;
  inserted: string;
}

export interface WordDoc {
  /** The document's text as it was before tracked changes: what the Markdown still says. */
  text: string;
  comments: WordComment[];
  changes: WordChange[];
}

function relTarget(files: ZipReader, type: string, fallback: string): string {
  const rels = files.read('word/_rels/document.xml.rels');
  if (rels) {
    for (const t of xmlTokens(rels.toString('utf8'))) {
      if (t.t === 'open' && local(t.name) === 'Relationship' && (t.attrs.Type || '').endsWith(`/${type}`) && t.attrs.Target) {
        const target = t.attrs.Target.replace(/^\//, '');
        return t.attrs.Target.startsWith('/') ? target : path.posix.normalize(path.posix.join('word', target));
      }
    }
  }
  return fallback;
}

/** Text of body content: runs, tabs, breaks; paragraphs end in "\n". */
const SKIP = new Set(['instrText', 'delInstrText', 'Fallback', 'txbxContent', 'rPr', 'pPr', 'sectPr', 'tblPr', 'trPr', 'tcPr', 'footnoteReference', 'endnoteReference']);

function commentText(xmlSrc: string): { byId: Map<string, { author: string; date?: string; text: string; paraIds: string[] }> } {
  const byId = new Map<string, { author: string; date?: string; text: string; paraIds: string[] }>();
  let cur: { author: string; date?: string; text: string; paraIds: string[] } | null = null;
  let skip = 0;
  let inText = false;
  for (const t of xmlTokens(xmlSrc)) {
    if (t.t === 'open') {
      const n = local(t.name);
      if (n === 'comment') {
        cur = { author: attr(t.attrs, 'author') || 'Word', date: attr(t.attrs, 'date'), text: '', paraIds: [] };
        byId.set(attr(t.attrs, 'id') ?? String(byId.size), cur);
        if (t.self) cur = null;
        continue;
      }
      if (!cur) continue;
      if (SKIP.has(n) && !t.self) skip++;
      else if (skip) continue;
      else if (n === 'p') {
        const pid = attr(t.attrs, 'paraId');
        if (pid) cur.paraIds.push(pid);
      } else if (n === 't' && !t.self) inText = true;
      else if (n === 'tab') cur.text += '\t';
      else if (n === 'br' || n === 'cr') cur.text += '\n';
      else if (n === 'noBreakHyphen') cur.text += '-';
    } else if (t.t === 'close') {
      const n = local(t.name);
      if (n === 'comment') cur = null;
      else if (!cur) continue;
      else if (SKIP.has(n)) skip = Math.max(0, skip - 1);
      else if (n === 't') inText = false;
      else if (n === 'p' && !skip) cur.text += '\n';
    } else if (cur && inText && !skip) cur.text += t.s;
  }
  for (const c of byId.values()) c.text = c.text.replace(/\s+$/, '');
  return { byId };
}

export function readDocx(buf: Buffer): WordDoc {
  // Only the parts read below are inflated; images and the rest stay packed.
  const files = openZip(buf);
  const docPath = (() => {
    const rels = files.read('_rels/.rels');
    if (rels) {
      for (const t of xmlTokens(rels.toString('utf8'))) {
        if (t.t === 'open' && (t.attrs.Type || '').endsWith('/officeDocument') && t.attrs.Target) return t.attrs.Target.replace(/^\//, '');
      }
    }
    return 'word/document.xml';
  })();
  const docXml = files.read(docPath);
  if (!docXml) throw new Error('This file has no Word document part (word/document.xml). Is it a .docx?');

  // Comments and their thread structure.
  const cPart = files.read(relTarget(files, 'comments', 'word/comments.xml'));
  const { byId } = cPart ? commentText(cPart.toString('utf8')) : { byId: new Map() };
  const parentOf = new Map<string, string>();
  const doneIds = new Set<string>();
  const ext = files.read(relTarget(files, 'commentsExtended', 'word/commentsExtended.xml'));
  if (ext) {
    const byPara = new Map<string, string>();
    for (const [id, c] of byId) for (const p of c.paraIds) byPara.set(p, id);
    for (const t of xmlTokens(ext.toString('utf8'))) {
      if (t.t !== 'open' || local(t.name) !== 'commentEx') continue;
      const id = byPara.get(attr(t.attrs, 'paraId') || '');
      if (!id) continue;
      const parent = byPara.get(attr(t.attrs, 'paraIdParent') || '');
      if (parent && parent !== id) parentOf.set(id, parent);
      if (attr(t.attrs, 'done') === '1') doneIds.add(id);
    }
  }

  // The body: original text, comment ranges and tracked changes.
  let text = '';
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  const refs = new Map<string, number>();
  const changes: WordChange[] = [];
  let ins = 0; // depth inside w:ins / w:moveTo
  let del = 0; // depth inside w:del / w:moveFrom
  let skip = 0;
  let inText: 'normal' | 'del' | null = null;
  let change = null as WordChange | null;
  let inBody = false;
  const startChange = (a: Record<string, string>) => {
    // Nested changes (an insertion someone else deleted) belong to the outer one.
    if (change) return;
    change = { author: attr(a, 'author') || 'Word', date: attr(a, 'date'), start: text.length, end: text.length, inserted: '' };
  };
  const endChange = () => {
    if (!change || ins || del) return;
    change.end = text.length;
    if (change.end > change.start || change.inserted) changes.push(change);
    change = null;
  };
  for (const t of xmlTokens(docXml.toString('utf8'))) {
    if (t.t === 'open') {
      const n = local(t.name);
      if (n === 'body') inBody = true;
      if (!inBody) continue;
      if (SKIP.has(n)) {
        if (!t.self) skip++;
        continue;
      }
      if (skip) continue;
      switch (n) {
        case 'ins':
        case 'moveTo':
          if (t.self) break;
          ins++;
          if (n === 'ins') startChange(t.attrs);
          break;
        case 'del':
        case 'moveFrom':
          if (t.self) break;
          del++;
          if (n === 'del') startChange(t.attrs);
          break;
        case 't':
          if (!t.self) inText = 'normal';
          break;
        case 'delText':
          if (!t.self) inText = 'del';
          break;
        case 'tab':
        case 'br':
        case 'cr':
        case 'noBreakHyphen': {
          const ch = n === 'tab' ? '\t' : n === 'noBreakHyphen' ? '-' : '\n';
          if (ins && change) change.inserted += ch;
          else if (!ins) text += ch;
          break;
        }
        case 'commentRangeStart': {
          const id = attr(t.attrs, 'id');
          if (id !== undefined && !starts.has(id)) starts.set(id, text.length);
          break;
        }
        case 'commentRangeEnd': {
          const id = attr(t.attrs, 'id');
          if (id !== undefined) ends.set(id, text.length);
          break;
        }
        case 'commentReference': {
          const id = attr(t.attrs, 'id');
          if (id !== undefined && !refs.has(id)) refs.set(id, text.length);
          break;
        }
      }
    } else if (t.t === 'close') {
      const n = local(t.name);
      if (n === 'body') inBody = false;
      if (!inBody) continue;
      if (SKIP.has(n)) {
        skip = Math.max(0, skip - 1);
        continue;
      }
      if (skip) continue;
      if (n === 't' || n === 'delText') inText = null;
      else if (n === 'ins' || n === 'moveTo') {
        ins = Math.max(0, ins - 1);
        endChange();
      } else if (n === 'del' || n === 'moveFrom') {
        del = Math.max(0, del - 1);
        endChange();
      } else if (n === 'p') text += '\n';
    } else if (inText && !skip && inBody) {
      if (ins) {
        if (change) change.inserted += inText === 'del' ? '' : t.s;
      } else text += t.s;
    }
  }

  const comments: WordComment[] = [];
  for (const [id, c] of byId) {
    let start = starts.get(id);
    let end = ends.get(id);
    if (start === undefined && end === undefined && refs.has(id)) start = end = refs.get(id);
    if (start !== undefined && end === undefined) end = start;
    if (end !== undefined && start === undefined) start = end;
    if (start !== undefined && end !== undefined && end < start) [start, end] = [end, start];
    comments.push({ id, author: c.author, date: c.date, text: c.text, start, end, parentId: parentOf.get(id), done: doneIds.has(id) });
  }
  return { text, comments, changes: mergeChanges(changes) };
}

/** A deletion right next to an insertion is one replacement. */
function mergeChanges(list: WordChange[]): WordChange[] {
  const out: WordChange[] = [];
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && last.end === c.start && last.author === c.author) {
      last.end = c.end;
      last.inserted += c.inserted;
    } else out.push({ author: c.author, date: c.date, start: c.start, end: c.end, inserted: c.inserted });
  }
  return out;
}

// ---- placing it on the Markdown ----

const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/** Widen [s, e) of `text` to whole words; an empty range takes the neighboring word. */
export function widenToWords(text: string, s: number, e: number): [number, number] {
  if (s < e) {
    if (isWord(text[s]) && isWord(text[s - 1])) while (isWord(text[s - 1])) s--;
    if (isWord(text[e - 1]) && isWord(text[e])) while (isWord(text[e])) e++;
    return [s, e];
  }
  if (isWord(text[s - 1]) || isWord(text[e])) {
    while (isWord(text[s - 1])) s--;
    while (isWord(text[e])) e++;
    return [s, e];
  }
  // Between punctuation or spaces: take the previous word (same line), else the next.
  let a = s;
  while (a > 0 && !isWord(text[a - 1]) && text[a - 1] !== '\n') a--;
  if (isWord(text[a - 1])) {
    while (isWord(text[a - 1])) a--;
    return [a, e];
  }
  let b = e;
  while (b < text.length && !isWord(text[b]) && text[b] !== '\n') b++;
  if (isWord(text[b])) {
    while (isWord(text[b])) b++;
    return [s, b];
  }
  return [s, e];
}

function contextQuote(text: string, s: number, e: number): Quote | null {
  const q = quoteAt(text, s, e);
  return q && { quote: q.quote, prefix: text.slice(Math.max(0, q.start - CONTEXT), q.start), suffix: text.slice(q.end, q.end + CONTEXT) };
}

/** A range of the Word view back in the view's text. */
function fromWordView(model: DocModel, r: [number, number] | null): [number, number] | null {
  if (!r) return null;
  const v = wordView(model);
  let s = Infinity;
  let e = -1;
  for (let i = r[0]; i < r[1]; i++) {
    if (v.to[i] > v.from[i]) {
      s = Math.min(s, v.from[i]);
      e = Math.max(e, v.to[i]);
    }
  }
  return e > s ? [s, e] : null;
}

/**
 * Where a quote from Word falls in the Markdown's rendered text, or null.
 * First in the text as the exported .docx has it (math as TeX and so on),
 * then in the view's own text, then ignoring spacing and punctuation.
 */
export function placeQuote(model: DocModel, q: Quote): Comment['anchor'] | null {
  const v = wordView(model);
  const r =
    fromWordView(model, locate(v.text, q)) ??
    locate(model.text, q) ??
    fromWordView(model, locateLoose(v.text, q)) ??
    locateLoose(model.text, q);
  if (!r) return null;
  const at = quoteAt(model.text, r[0], r[1]);
  if (!at) return null;
  const [lineStart, lineEnd] = linesAt(model, at.start, at.end);
  return { quote: at.quote, prefix: at.prefix, suffix: at.suffix, lineStart, lineEnd };
}

export interface ImportOptions {
  docDir?: string;
  /** Restricted Mode: the only folders the Markdown's bibliography may be read from. */
  readableRoots?: string[];
  /** Threads already in the sidecar: a Word comment that repeats one is skipped. */
  existing?: Comment[];
  /** Also turn tracked changes into threads with a suggestion (default true). */
  trackedChanges?: boolean;
}

export interface ImportResult {
  /** New draft threads. */
  comments: Comment[];
  /** Word replies to threads the sidecar already has (e.g. an advisor answering an exported comment). */
  replies: { id: string; reply: Reply }[];
  /** Word comments (not replies) and tracked changes turned into threads. */
  imported: number;
  /** Of those, how many became whole-document threads because their text wasn't found. */
  unplaced: number;
  /** Skipped because the sidecar already has them (e.g. re-importing an export). */
  duplicates: number;
  /** Threads from tracked changes. */
  changes: number;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Same place: both whole-document, or the same quote on the same line or between the same words. */
function sameAnchor(a: Comment, b: Comment): boolean {
  if ((a.scope === 'document') !== (b.scope === 'document')) return false;
  if (a.scope === 'document') return true;
  const x = a.anchor;
  const y = b.anchor;
  if (norm(x.quote) !== norm(y.quote)) return false;
  // The words around it tell apart two occurrences on one line; the line alone only when they're missing.
  if (x.prefix || x.suffix || y.prefix || y.suffix) return norm(x.prefix) === norm(y.prefix) && norm(x.suffix) === norm(y.suffix);
  return x.lineStart === y.lineStart;
}

/** The thread a Word comment repeats: same author, same body, same place. */
function duplicateOf(existing: Comment[], c: Comment): Comment | undefined {
  const b = norm(c.body);
  return existing.find((e) => {
    if (e.author !== c.author) return false;
    if (norm(e.body) === b) return sameAnchor(e, c);
    // A thread exported with its quote gone comes back unplaced, that quote in front of its body.
    return c.scope === 'document' && e.scope !== 'document' && !!e.anchor.quote && b === norm(`“${e.anchor.quote}”\n\n${e.body}`);
  });
}

// The "[question · major]" line MD Review's export writes under a comment's body.
const META_WORDS = 'question|praise|major|minor|nit|section|whole document|resolved';
const META = new RegExp(`^\\[((?:${META_WORDS})(?: · (?:${META_WORDS}))*)\\]$`);

// The "Suggested edit: …" line MD Review's export writes last (docx.ts suggestionLine).
// Tried only on the text from the last such line: over the whole text the greedy quote is quadratic.
const SUGGESTION = /^\nSuggested edit: (?:replace with “([\s\S]*)”|delete this text)$/;

/** Take MD Review's own suggested-edit and kind/severity/scope lines back out of an exported comment. */
export function splitMeta(text: string): { body: string; meta: Partial<Comment> } {
  const meta: Partial<Comment> = {};
  const at = text.lastIndexOf('\nSuggested edit: ');
  const sg = at < 0 ? null : SUGGESTION.exec(text.slice(at));
  if (sg) {
    meta.suggestion = { text: sg[1] ?? '' };
    text = text.slice(0, at);
  }
  // Only the last line: the export writes it there, and a body may hold a "[minor]" line of its own.
  const lines = text.split('\n');
  const i = lines.length - 1;
  if (i < 1 || !META.test(lines[i].trim())) return { body: text, meta };
  for (const w of META.exec(lines[i].trim())![1].split(' · ')) {
    if (w === 'question' || w === 'praise') meta.kind = w;
    else if (w === 'major' || w === 'minor' || w === 'nit') meta.severity = w;
    else if (w === 'section') meta.scope = 'section';
    else if (w === 'whole document') meta.scope = 'document';
  }
  lines.splice(i, 1);
  return { body: lines.join('\n'), meta };
}

function wordDate(d?: string): string {
  const t = d ? new Date(d) : null;
  return t && !isNaN(t.getTime()) ? t.toISOString() : now();
}

export function importDocx(markdown: string, docx: Buffer, opts: ImportOptions = {}): ImportResult {
  const word = readDocx(docx);
  const model = buildDocModel(markdown, { docDir: opts.docDir, readableRoots: opts.readableRoots });
  const existing = opts.existing ?? [];
  const out: Comment[] = [];
  const res: ImportResult = { comments: out, replies: [], imported: 0, unplaced: 0, duplicates: 0, changes: 0 };

  /** A new thread, or the existing one it repeats (flagged `dup`). */
  const make = (author: string, date: string | undefined, body: string, quote: Quote | null, extra: Partial<Comment> = {}): { c: Comment; dup: boolean } => {
    const anchor = quote && extra.scope !== 'document' ? placeQuote(model, quote) : null;
    const c: Comment = {
      id: newId('c'),
      author,
      createdAt: wordDate(date),
      anchor: anchor ?? { quote: '', prefix: '', suffix: '', lineStart: 0, lineEnd: 0 },
      body,
      status: 'draft',
      submittedAt: null,
      resolvedAt: null,
      replies: [],
      origin: 'word',
      ...extra,
    };
    // (Exported from MD Review as a whole-document thread: stays one.)
    const unplaced = extra.scope !== 'document' && !anchor;
    if (unplaced) {
      c.scope = 'document';
      delete c.suggestion; // nothing to apply it to
      // (An unanchored comment exported by MD Review is already in quotes.)
      if (quote?.quote) c.body = `“${quote.quote.replace(/^“([\s\S]*)”$/, '$1')}”\n\n${body}`;
    }
    const dup = duplicateOf([...existing, ...out], c);
    if (dup) {
      res.duplicates++;
      return { c: dup, dup: true };
    }
    if (unplaced) res.unplaced++;
    res.imported++;
    out.push(c);
    return { c, dup: false };
  };

  const byId = new Map(word.comments.map((c) => [c.id, c]));
  const threads = new Map<string, { c: Comment; dup: boolean }>();
  for (const wc of word.comments) {
    if (wc.parentId && byId.has(wc.parentId)) continue; // a reply: attached below
    let quote: Quote | null = null;
    if (wc.start !== undefined && wc.end !== undefined) {
      const [s, e] = wc.start === wc.end ? widenToWords(word.text, wc.start, wc.end) : [wc.start, wc.end];
      quote = contextQuote(word.text, s, e);
    }
    const { body, meta } = splitMeta(wc.text);
    // Resolved in Word (or exported resolved): stays resolved here.
    if (wc.done) Object.assign(meta, { status: 'resolved', resolvedAt: wordDate(wc.date) });
    threads.set(wc.id, make(wc.author, wc.date, body, quote, meta));
  }
  for (const wc of word.comments) {
    if (!wc.parentId || !byId.has(wc.parentId)) continue;
    // Walk up to the thread's first comment.
    let root = wc.parentId;
    for (let i = 0; i < 50; i++) {
      const up = byId.get(root)?.parentId;
      if (!up || !byId.has(up)) break;
      root = up;
    }
    const t = threads.get(root);
    if (!t) continue;
    const { body, meta } = splitMeta(wc.text);
    const reply: Reply = { id: newId('r'), author: wc.author, createdAt: wordDate(wc.date), body };
    if (meta.suggestion) reply.suggestion = meta.suggestion;
    if (t.c.replies.some((r) => r.author === reply.author && norm(r.body) === norm(reply.body))) continue;
    if (t.dup) res.replies.push({ id: t.c.id, reply });
    else t.c.replies.push(reply);
  }

  if (opts.trackedChanges !== false) {
    for (const ch of word.changes) {
      const deleted = word.text.slice(ch.start, ch.end);
      const [s, e] = widenToWords(word.text, ch.start, ch.end);
      const quote = contextQuote(word.text, s, e);
      const replacement = word.text.slice(s, ch.start) + ch.inserted + word.text.slice(ch.end, e);
      const what = deleted && ch.inserted ? `Replace “${deleted}” with “${ch.inserted}”` : deleted ? `Delete “${deleted}”` : `Insert “${ch.inserted}”`;
      const r = make(ch.author, ch.date, `${what} (tracked change in Word)`, quote, quote ? { suggestion: { text: replacement } } : {});
      if (!r.dup) res.changes++;
    }
  }
  return res;
}

