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
import * as fs from 'fs';
import type MarkdownIt from 'markdown-it';
import { readBlock, spliceBlock, BlockEditError } from './blockEdit';
import { createRenderer } from './render';

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

/** Plain text of the block of `kind` that starts at source line `ls`. */
export function plainAt(md: MarkdownIt, text: string, ls: number, kind: BlockKind): string | null {
  const toks = md.parse(text, {});
  const i = toks.findIndex((t) => t.type === `${kind}_open` && t.map && t.map[0] === ls);
  if (i < 0) return null;
  const level = toks[i].level;
  let out = '';
  for (let k = i + 1; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === `${kind}_close` && t.level === level) break;
    if (t.type === 'inline') out += inlineText(t.children) + ' ';
  }
  return out;
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

/**
 * Apply a rendered-text edit to lines [ls, le) of the file. Returns the new
 * block source. Throws BlockEditError if the view is stale, InlineMapError if
 * the edit can't be mapped to Markdown with certainty.
 */
export function applyInlineEdit(filePath: string, ls: number, le: number, kind: BlockKind, oldText: string, newText: string): string {
  const md = createRenderer((x) => x);
  const buf = fs.readFileSync(filePath);
  const src = readBlock(buf, ls, le);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const docText = buf.subarray(bom).toString('utf8');
  const current = plainAt(md, docText, ls, kind);
  if (current === null || collapse(current) !== collapse(oldText)) {
    throw new BlockEditError('The file changed on disk since this block was rendered. The view has been refreshed — please try again.');
  }
  if (!collapse(newText)) throw new InlineMapError('To delete a whole block, use the source editor.', src);
  if (collapse(newText) === collapse(oldText)) return src;

  for (const cand of candidates(src, oldText, newText)) {
    const out = spliceBlock(buf, ls, le, src, cand);
    const got = plainAt(md, out.subarray(bom).toString('utf8'), ls, kind);
    if (got !== null && collapse(got) === collapse(newText)) {
      fs.writeFileSync(filePath, out);
      return cand;
    }
  }
  throw new InlineMapError("Couldn't map that change onto the Markdown safely, so nothing was written. Edit the source below instead.", src);
}
