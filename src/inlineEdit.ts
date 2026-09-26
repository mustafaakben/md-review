// Seamless (WYSIWYG-style) editing of a rendered block, mapped back to the
// Markdown source without re-serializing anything.
//
// The webview sends the block's rendered text before and after the edit. We
//   1. diff the two texts (common prefix / suffix -> one changed window),
//   2. align rendered characters to source characters (markup is skipped),
//   3. try a few candidate source splices around the changed window,
//   4. keep the first candidate whose re-rendered text equals the edited text.
// Only that verified candidate is written, via the byte-exact spliceBlock().
// If no candidate verifies, nothing is written and the caller falls back to
// raw-source editing.
//
// Verifying a paragraph or heading doesn't need the whole file: see
// localPlain(). Anything else is checked by re-parsing the whole file.
import * as fs from 'fs';
import type MarkdownIt from 'markdown-it';
import { readBlock, spliceBlock, BlockEditError } from './blockEdit';
import { rendererFor, Parse } from './render';

type Token = Parse['tokens'][number];

const plain = (src: string) => src;

export type BlockKind = 'paragraph' | 'heading' | 'list_item' | 'tr' | 'blockquote';

export class InlineMapError extends Error {
  constructor(message: string, public readonly source: string) {
    super(message);
  }
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

function inlineText(children: any[] | null): string {
  let s = '';
  for (const c of children || []) {
    if (c.type === 'text' || c.type === 'code_inline' || c.type === 'math_inline') s += c.content;
    else if (c.type === 'softbreak' || c.type === 'hardbreak') s += '\n';
    else if (c.type === 'footnote_ref') s += `[${c.meta.id + 1}]`;
  }
  return s;
}

const blockAt = (toks: Token[], ls: number, kind: BlockKind) =>
  toks.findIndex((t) => t.type === `${kind}_open` && t.map && t.map[0] === ls);

function plainOf(toks: Token[], i: number, kind: BlockKind): string {
  const level = toks[i].level;
  let out = '';
  for (let k = i + 1; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === `${kind}_close` && t.level === level) break;
    if (t.type === 'inline') out += inlineText(t.children) + ' ';
  }
  return out;
}

/** Plain text of the block of `kind` that starts at source line `ls`. */
export function plainAt(md: MarkdownIt, text: string, ls: number, kind: BlockKind): string | null {
  const toks = md.parse(text, {});
  const i = blockAt(toks, ls, kind);
  return i < 0 ? null : plainOf(toks, i, kind);
}

/**
 * Where a top-level paragraph or heading can be re-checked on its own: its
 * lines, what follows them, and the file's link reference definitions.
 */
interface Local {
  indent: string;
  tail: string;
  env: Parse['env'];
  notes: string;
  /** The file has a bibliography, so `@key` depends on its front matter. */
  cites: boolean;
}

const indentOf = (s: string) => /^[ \t]*/.exec(s)![0];
// An inline footnote renumbers every note after it, and block-math delimiters
// can pair with ones far above or below: none of that shows in the block alone.
const needsWholeFile = (s: string) => /\^\[|\$\$|\\[[\]]/.test(s);
// A footnote definition in the lines that come along would be defined twice.
const noteDefinition = /^ {0,3}\[\^[^\]]+\]:/m;

/** Labels of the footnote references in the block at toks[i], in order. */
function noteLabels(toks: Token[], i: number): string {
  const labels: string[] = [];
  for (let k = i + 1; k < toks.length && toks[k].level > toks[i].level; k++) {
    for (const c of toks[k].children || []) if (c.type === 'footnote_ref') labels.push(c.meta.label);
  }
  return JSON.stringify(labels);
}

/** The whole file's link and footnote definitions, as inline parsing leaves them. */
function definitions(env: Parse['env']): Parse['env'] {
  const out: Parse['env'] = { references: { ...env.references } };
  const notes = env.footnotes;
  if (notes) out.footnotes = { refs: { ...notes.refs }, list: notes.list?.map((n: object) => ({ ...n })) };
  return out;
}

/**
 * Whether the block at toks[i] (lines [ls, le) of `lines`) can be checked
 * locally. Parsing is line by line from the top, so a block that starts at the
 * top level, after a blank line or a block that ends on its own line, is
 * parsed from a fresh state: the same lines give the same tokens wherever they
 * are. Its end depends only on the lines after it (a blank line, a heading, a
 * setext underline, a table's delimiter row), so two of those come along.
 * Inline parsing also needs the link and footnote definitions, from anywhere
 * in the file. Footnote numbers follow the order of first references, so they
 * stay put while the block refers to the same notes in the same order.
 */
function localContext(toks: Token[], i: number, env: Parse['env'], lines: string[], ls: number, le: number, kind: BlockKind, src: string): Local | undefined {
  if (kind !== 'paragraph' && kind !== 'heading') return undefined;
  const open = toks[i];
  if (open.level !== 0 || !open.map || open.map[1] !== le || needsWholeFile(src)) return undefined;
  // A block that ends on its own line must end right above: definitions in
  // between leave no tokens, but they are part of the parser's state.
  const prev = toks[i - 1];
  const prevOpen = prev?.type === 'heading_close' ? toks[i - 3] : prev;
  const freshStart =
    ls === 0 ||
    !lines[ls - 1].trim() ||
    (prev?.level === 0 && ['heading_close', 'hr', 'fence'].includes(prev.type) && prevOpen?.map?.[1] === ls);
  if (!freshStart) return undefined;
  const tail = lines.slice(le, le + 2).join('\n');
  if (noteDefinition.test(tail)) return undefined;
  const cites = !!env.mdrCite?.active;
  if (cites && src.includes('@')) return undefined;
  return { indent: indentOf(src), tail, env, notes: noteLabels(toks, i), cites };
}

/**
 * Plain text of `block` standing in for the original lines, parsed locally, or
 * undefined when only a whole-file parse can tell.
 */
function localPlain(md: MarkdownIt, local: Local, block: string, kind: BlockKind): string | undefined {
  if (indentOf(block) !== local.indent || needsWholeFile(block) || (local.cites && block.includes('@'))) return undefined;
  const body = block.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const n = body.split('\n').length;
  const toks = md.parse(local.tail ? `${body}\n${local.tail}` : body, definitions(local.env));
  const open = toks[0];
  // It must still be one block of the same kind spanning exactly these lines.
  if (!open || open.type !== `${kind}_open` || open.level !== 0 || !open.map || open.map[0] !== 0 || open.map[1] !== n) return undefined;
  if (noteLabels(toks, 0) !== local.notes) return undefined;
  return plainOf(toks, 0, kind);
}

/** For each rendered character, the index of the source character it came from. */
export function align(src: string, rendered: string): number[] {
  const map: number[] = [];
  let j = 0;
  for (const c of rendered) {
    if (/\s/.test(c)) {
      if (j < src.length && /\s/.test(src[j])) map.push(j++);
      else map.push(j);
      continue;
    }
    const k = src.indexOf(c, j);
    if (k < 0) {
      map.push(j);
      continue;
    }
    map.push(k);
    j = k + 1;
  }
  return map;
}

/** Candidate new block sources, most conservative first. */
export function candidates(src: string, oldText: string, newText: string): string[] {
  const oldChars = [...oldText];
  const newChars = [...newText];
  let p = 0;
  while (p < oldChars.length && p < newChars.length && oldChars[p] === newChars[p]) p++;
  let s = 0;
  while (s < oldChars.length - p && s < newChars.length - p && oldChars[oldChars.length - 1 - s] === newChars[newChars.length - 1 - s]) s++;
  const map = align(src, oldText);
  // A pure insertion or deletion can slide left over repeated characters
  // ("x| y" + "z " == "x |z y" + " z") — try each equivalent position.
  const variants: [number, number, string][] = [[p, oldChars.length - s, newChars.slice(p, newChars.length - s).join('')]];
  for (let k = 0; k < 20; k++) {
    const [vp, ve, vi] = variants[variants.length - 1];
    if (vp === 0) break;
    if (vi && ve === vp && oldChars[vp - 1] === vi[vi.length - 1]) variants.push([vp - 1, ve - 1, oldChars[vp - 1] + vi.slice(0, -1)]);
    else if (!vi && ve > vp && oldChars[vp - 1] === oldChars[ve - 1]) variants.push([vp - 1, ve - 1, '']);
    else break;
  }
  const out: string[] = [];
  for (const [vp, oldEnd, ins] of variants) {
    const pairs: [number, number][] = [];
    if (oldEnd > vp) {
      const starts = [map[vp], vp > 0 ? map[vp - 1] + 1 : map[vp]];
      const ends = [map[oldEnd - 1] + 1, oldEnd < oldChars.length ? map[oldEnd] : src.length];
      for (const a of starts) for (const b of ends) pairs.push([a, b]);
    } else {
      const at = [vp > 0 ? map[vp - 1] + 1 : map[0] ?? 0, vp < oldChars.length ? map[vp] : src.length];
      for (const a of at) pairs.push([a, a]);
    }
    for (const [a, b] of pairs) {
      if (a > b || a < 0 || b > src.length) continue;
      const cand = src.slice(0, a) + ins + src.slice(b);
      if (!out.includes(cand)) out.push(cand);
    }
  }
  return out;
}

/** A parse of the file's text, from the render on screen. */
export type RenderedParse = Parse & { text: string };

/**
 * Apply a rendered-text edit to lines [ls, le) of the file. Returns the new
 * block source. Throws BlockEditError if the view is stale, InlineMapError if
 * the edit can't be mapped to Markdown with certainty.
 */
export function applyInlineEdit(filePath: string, ls: number, le: number, kind: BlockKind, oldText: string, newText: string, rendered?: RenderedParse): string {
  const md = rendererFor(plain);
  const buf = fs.readFileSync(filePath);
  const src = readBlock(buf, ls, le);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const docText = buf.subarray(bom).toString('utf8');
  // The file matches the render on screen (the session checks), so the
  // session's tokens of that render usually still apply.
  const { tokens, env } = rendered?.text === docText ? rendered : (() => {
    const env = {};
    return { tokens: md.parse(docText, env), env };
  })();
  const i = blockAt(tokens, ls, kind);
  if (i < 0 || collapse(plainOf(tokens, i, kind)) !== collapse(oldText)) {
    throw new BlockEditError('The file changed on disk since this block was rendered. The view has been refreshed — please try again.');
  }
  if (!collapse(newText)) throw new InlineMapError('To delete a whole block, use the source editor.', src);
  if (collapse(newText) === collapse(oldText)) return src;

  const local = localContext(tokens, i, env, docText.split(/\r\n?|\n/), ls, le, kind, src);
  for (const cand of candidates(src, oldText, newText)) {
    const out = spliceBlock(buf, ls, le, src, cand);
    const got = (local && localPlain(md, local, cand, kind)) ?? plainAt(md, out.subarray(bom).toString('utf8'), ls, kind);
    if (got !== null && collapse(got) === collapse(newText)) {
      fs.writeFileSync(filePath, out);
      return cand;
    }
  }
  throw new InlineMapError("Couldn't map that change onto the Markdown safely, so nothing was written. Edit the source below instead.", src);
}
