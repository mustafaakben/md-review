// Bibliography files for pandoc citations: BibTeX/BibLaTeX (.bib) and
// CSL-JSON (.json). Parsed into a small common shape and formatted
// author-date (close to pandoc's default Chicago style), without CSL.
import * as fs from 'fs';
import * as path from 'path';

export interface BibEntry {
  key: string;
  /** Family names (or a whole corporate name), for in-text citations. */
  names: string[];
  /** "Family, Given" for the first name, "Given Family" after, for the list. */
  fullNames: string[];
  /** The author list ended in "and others". */
  etal?: boolean;
  year: string;
  title?: string;
  container?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  doi?: string;
  url?: string;
}

export interface Bibliography {
  entries: Map<string, BibEntry>;
  error?: string;
  /** Refused for what the path is (a device, a pipe, a network path): don't watch it either. */
  skip?: boolean;
}

// ---- BibTeX ----

const ACCENTS: Record<string, string> = { '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', '=': '̄', '.': '̇', c: '̧', v: '̌', u: '̆', H: '̋' };
const SYMBOLS: Record<string, string> = { ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', oe: 'œ', OE: 'Œ', '&': '&', '%': '%', _: '_', $: '$', '#': '#' };

/** `{\"u}ber \emph{x} --` -> `über x –`: the common LaTeX in bib fields, not all of it. */
export function delatex(s: string): string {
  return s
    .replace(/\\([`'^"~=.])\s*\{?\\?([A-Za-z])\}?/g, (_, a, c) => (c + ACCENTS[a]).normalize('NFC'))
    .replace(/\\([cvuH])\s*\{([A-Za-z])\}/g, (_, a, c) => (c + ACCENTS[a]).normalize('NFC'))
    .replace(/\\(ss|ae|AE|aa|AA|oe|OE|[oOlLi])(?![A-Za-z])\s*/g, (_, k) => SYMBOLS[k])
    .replace(/\\([&%_$#])/g, '$1')
    .replace(/\\[A-Za-z]+\s*/g, '')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/~/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a BibTeX name list on top-level " and ". */
function splitNames(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth === 0 && /^\sand\s/i.test(s.slice(i, i + 5))) {
      out.push(cur);
      cur = '';
      i += 4;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** One BibTeX name -> [family, given]. `{World Health Organization}` stays whole. */
function bibName(raw: string): [string, string] {
  const t = raw.trim();
  if (/^\{.*\}$/.test(t) && !/\}.*\{/.test(t.slice(1, -1))) return [delatex(t), ''];
  const parts = t.split(/,(?![^{]*\})/).map((x) => x.trim());
  if (parts.length >= 2) return [delatex(parts[0]), delatex(parts[parts.length - 1])];
  // "Given von Family": the family name is the last word, plus lowercase particles before it.
  const words = t.split(/\s+(?![^{]*\})/);
  let i = words.length - 1;
  while (i > 0 && /^[a-z]/.test(words[i - 1])) i--;
  return [delatex(words.slice(i).join(' ')), delatex(words.slice(0, i).join(' '))];
}

export function parseBibTeX(text: string): Map<string, BibEntry> {
  const entries = new Map<string, BibEntry>();
  const strings: Record<string, string> = { jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June', jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December' };
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n && /\s/.test(text[i])) i++;
  };
  /** A braced or quoted value, or a bare word/number; `#` concatenates. */
  const value = (): string => {
    let out = '';
    for (;;) {
      ws();
      if (text[i] === '{') {
        let depth = 0;
        const start = i + 1;
        for (; i < n; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}' && --depth === 0) break;
        }
        out += text.slice(start, i++);
      } else if (text[i] === '"') {
        let depth = 0;
        const start = ++i;
        for (; i < n; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') depth--;
          else if (text[i] === '"' && depth === 0) break;
        }
        out += text.slice(start, i++);
      } else {
        const m = /^[^\s,#}\)]+/.exec(text.slice(i, i + 200));
        const w = m ? m[0] : '';
        i += w.length;
        out += strings[w.toLowerCase()] ?? w;
      }
      ws();
      if (text[i] !== '#') return out;
      i++;
    }
  };
  while (i < n) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    // `% @article{…}` is commented out.
    if (text.slice(text.lastIndexOf('\n', at) + 1, at).includes('%')) continue;
    const tm = /^([A-Za-z]+)\s*([{(])/.exec(text.slice(i, i + 40));
    if (!tm) continue;
    const type = tm[1].toLowerCase();
    i += tm[0].length;
    const closer = tm[2] === '{' ? '}' : ')';
    if (type === 'comment' || type === 'preamble') {
      // Only the entry's own brackets nest; a stray "(" in a {…} comment doesn't.
      let depth = 1;
      for (; i < n && depth; i++) {
        if (text[i] === tm[2]) depth++;
        else if (text[i] === closer) depth--;
      }
      continue;
    }
    const fields: Record<string, string> = {};
    let key = '';
    if (type !== 'string') {
      const km = /^\s*([^,\s}]+)\s*,?/.exec(text.slice(i, i + 300));
      if (!km) continue;
      key = km[1];
      i += km[0].length;
    }
    for (;;) {
      ws();
      if (i >= n || text[i] === closer) {
        i++;
        break;
      }
      const fm = /^([A-Za-z][\w:.+-]*)\s*=/.exec(text.slice(i, i + 100));
      if (!fm) {
        // Malformed: skip to the next field or the entry's end.
        const next = text.slice(i).search(/[,})]/);
        if (next < 0) {
          i = n;
          break;
        }
        i += next;
        if (text[i] !== closer) i++;
        continue;
      }
      i += fm[0].length;
      fields[fm[1].toLowerCase()] = value();
      ws();
      if (text[i] === ',') i++;
    }
    if (type === 'string') {
      for (const [k, v] of Object.entries(fields)) strings[k] = v;
      continue;
    }
    const raw = splitNames(fields.author || fields.editor || '');
    const etal = raw.length > 0 && /^others$/i.test(raw[raw.length - 1].trim());
    const people = (etal ? raw.slice(0, -1) : raw).map(bibName);
    const year = /\d{4}/.exec(fields.year || fields.date || '')?.[0] || '';
    entries.set(key, {
      key,
      names: people.map(([f]) => f),
      fullNames: people.map(([f, g], k) => (g ? (k === 0 ? `${f}, ${g}` : `${g} ${f}`) : f)),
      ...(etal && people.length ? { etal } : {}),
      year,
      title: fields.title && delatex(fields.title),
      container: delatex(fields.journal || fields.journaltitle || fields.booktitle || '') || undefined,
      volume: fields.volume && delatex(fields.volume),
      issue: (fields.number || fields.issue) && delatex(fields.number || fields.issue),
      pages: fields.pages && delatex(fields.pages),
      publisher: delatex(fields.publisher || fields.institution || fields.school || '') || undefined,
      doi: fields.doi && delatex(fields.doi),
      url: fields.url,
    });
  }
  return entries;
}

// ---- CSL-JSON ----

export function parseCslJson(text: string): Map<string, BibEntry> {
  const data = JSON.parse(text);
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const entries = new Map<string, BibEntry>();
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);
  for (const it of list) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string') continue;
    const people: any[] = Array.isArray(it.author) ? it.author : Array.isArray(it.editor) ? it.editor : [];
    const pairs = people.map((p) => [str(p?.family) ?? str(p?.literal) ?? '', str(p?.given) ?? ''] as [string, string]).filter(([f]) => f);
    const parts = it.issued?.['date-parts']?.[0];
    const year = str(Array.isArray(parts) ? parts[0] : undefined) ?? /\d{4}/.exec(str(it.issued?.raw) ?? '')?.[0] ?? '';
    entries.set(it.id, {
      key: it.id,
      names: pairs.map(([f]) => f),
      fullNames: pairs.map(([f, g], k) => (g ? (k === 0 ? `${f}, ${g}` : `${g} ${f}`) : f)),
      year,
      title: str(it.title),
      container: str(it['container-title']),
      volume: str(it.volume),
      issue: str(it.issue),
      pages: str(it.page),
      publisher: str(it.publisher),
      doi: str(it.DOI),
      url: str(it.URL),
    });
  }
  return entries;
}

// ---- loading (cached by mtime and size) ----

const cache = new Map<string, { stamp: string; bib: Bibliography }>();

/** Larger than any real reference library; stops a stray huge file freezing the view. */
const MAX_BIB_BYTES = 20 * 1024 * 1024;

/**
 * True for a Windows path starting with two slashes: a network share
 * (\\server\share, //server/share) or a device or long-path form (\\.\pipe\x,
 * \\?\UNC\…). Touching a share at all (stat, realpath, a watcher) makes Windows
 * connect to that server and offer the user's credentials, so this is checked
 * before anything else looks at the path.
 */
export function isNetworkPath(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /^[\\/]{2}/.test(file);
}

export function loadBibliography(file: string, platform: NodeJS.Platform = process.platform): Bibliography {
  if (isNetworkPath(file, platform)) return { entries: new Map(), error: 'network paths are not read', skip: true };
  let stamp: string;
  try {
    const st = fs.statSync(file);
    // Reading a device or a pipe (/dev/zero, a FIFO) would never finish.
    if (!st.isFile()) return { entries: new Map(), error: 'not a file', skip: true };
    if (st.size > MAX_BIB_BYTES) return { entries: new Map(), error: 'too large' };
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return { entries: new Map(), error: 'not found' };
  }
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.bib;
  let bib: Bibliography;
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const entries = /\.json$/i.test(file) ? parseCslJson(text) : parseBibTeX(text);
    bib = { entries };
  } catch (e) {
    bib = { entries: new Map(), error: e instanceof SyntaxError ? 'not valid JSON' : 'unreadable' };
  }
  cache.set(file, { stamp, bib });
  return bib;
}

/**
 * `p` with links followed. When it doesn't exist, its deepest existing folder
 * is resolved and the rest appended, so a missing file under a linked folder
 * is judged by where the link leads.
 */
function realOr(file: string, p: typeof path = path): string {
  const abs = p.resolve(file);
  let dir = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return p.join(fs.realpathSync(dir), ...rest);
    } catch {
      const up = p.dirname(dir);
      if (up === dir) return abs;
      rest.unshift(p.basename(dir));
      dir = up;
    }
  }
}

/** Whether `abs` or any folder above it is a link to a network path (read without following it). */
function linksToNetwork(abs: string, p: typeof path, platform: NodeJS.Platform): boolean {
  for (let dir = abs; ; ) {
    try {
      if (fs.lstatSync(dir).isSymbolicLink() && isNetworkPath(p.resolve(p.dirname(dir), fs.readlinkSync(dir)), platform)) return true;
    } catch {
      // missing: nothing to follow here
    }
    const up = p.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/** Folders for insideRoots, with links followed. Resolve them once when checking many files. */
export function realRoots(roots: string[], platform: NodeJS.Platform = process.platform): string[] {
  // A network root is never resolved (that would touch the share); files under it are refused anyway.
  return roots.map((r) => (isNetworkPath(r, platform) ? r : realOr(r)));
}

/**
 * True if `file` (after following links) is inside one of `roots`, which
 * realRoots has resolved. Following a link can reach out to a network share
 * (slow, and on Windows it sends credentials), so a network path, or a link
 * to one, is never looked at and counts as outside.
 */
export function insideRealRoots(file: string, real: string[], platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path;
  const abs = p.resolve(file);
  if (isNetworkPath(abs, platform)) return false;
  if (linksToNetwork(abs, p, platform)) return false;
  const target = realOr(abs, p);
  if (isNetworkPath(target, platform)) return false;
  return real.some((r) => {
    const rel = p.relative(r, target);
    return rel === '' || (!!rel && !rel.startsWith('..') && !p.isAbsolute(rel));
  });
}

/** True if `file` (after following links) is inside one of `roots`. */
export function insideRoots(file: string, roots: string[]): boolean {
  return insideRealRoots(file, realRoots(roots));
}

// ---- formatting ----

/** "Rivera", "Rivera and Chen", "Rivera, Chen, and Diaz", "Rivera et al." */
export function citeNames(e: BibEntry): string {
  const n = e.names;
  if (!n.length) return e.title ? `“${e.title}”` : e.key;
  if (n.length === 1 || e.etal) return e.etal ? `${n[0]} et al.` : n[0];
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  if (n.length === 3) return `${n[0]}, ${n[1]}, and ${n[2]}`;
  return `${n[0]} et al.`;
}

export const citeYear = (e: BibEntry) => e.year || 'n.d.';

/** One reference-list entry as plain text parts: [lead, title, rest]. */
export function referenceParts(e: BibEntry): { lead: string; title?: string; container?: string; rest: string } {
  const f = e.fullNames;
  let names = f.length <= 1 ? f.join('') : f.length === 2 ? `${f[0]}, and ${f[1]}` : `${f.slice(0, -1).join(', ')}, and ${f[f.length - 1]}`;
  if (names && e.etal) names += ', et al';
  // With no author the title leads, as in pandoc's default style.
  const lead = `${dot(names || e.title || e.key)} ${dot(citeYear(e))}`;
  const title = names ? e.title : undefined;
  let rest = '';
  if (e.volume) rest += ` ${e.volume}`;
  if (e.issue) rest += ` (${e.issue})`;
  if (e.pages) rest += `${e.volume || e.issue ? ':' : ','} ${e.pages}`;
  if (e.container || rest) rest += '.';
  if (e.publisher) rest += ` ${e.publisher}.`;
  if (e.doi) rest += ` https://doi.org/${e.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}.`;
  else if (e.url) rest += ` ${e.url}.`;
  return { lead, title: title && dot(title), container: e.container, rest };
}

/** End a sentence once: "N." stays "N.", "n.d." stays "n.d.". */
const dot = (s: string) => (/[.?!]$/.test(s) ? s : s + '.');

export function referenceText(e: BibEntry): string {
  const p = referenceParts(e);
  return [p.lead, p.title ? `“${p.title}”` : '', p.container ? p.container : ''].filter(Boolean).join(' ') + p.rest;
}
