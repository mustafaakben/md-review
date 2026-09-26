// Byte-exact block editing. The file is treated as raw bytes split on "\n";
// only the bytes of lines [lineStart, lineEnd) (0-based, end exclusive) are
// replaced. Every other byte in the file — including BOM, line endings, and
// trailing whitespace — is left untouched. Never re-serializes the document.
import * as fs from 'fs';

const BOM = [0xef, 0xbb, 0xbf];

export interface LineIndex {
  bom: number; // 3 if the file starts with a UTF-8 BOM, else 0
  starts: number[]; // byte offset where each line begins
}

export function indexLines(buf: Buffer): LineIndex {
  const bom = buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2] ? 3 : 0;
  const starts = [bom];
  for (let i = bom; i < buf.length; i++) if (buf[i] === 0x0a) starts.push(i + 1);
  return { bom, starts };
}

/** Normalize text for comparison: CRLF -> LF, no trailing newline. */
function norm(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

function regionBounds(buf: Buffer, idx: LineIndex, lineStart: number, lineEnd: number) {
  const n = idx.starts.length;
  if (!(lineStart >= 0 && lineEnd > lineStart && lineEnd <= n)) {
    throw new BlockEditError(`Line range ${lineStart}-${lineEnd} is outside the file (${n} lines).`);
  }
  const from = idx.starts[lineStart];
  const to = lineEnd < n ? idx.starts[lineEnd] : buf.length;
  return { from, to };
}

export class BlockEditError extends Error {}

/** Current source text of lines [lineStart, lineEnd), LF-normalized. */
export function readBlock(buf: Buffer, lineStart: number, lineEnd: number): string {
  const idx = indexLines(buf);
  const { from, to } = regionBounds(buf, idx, lineStart, lineEnd);
  return norm(buf.subarray(from, to).toString('utf8'));
}

/**
 * Return a new buffer where lines [lineStart, lineEnd) are replaced by newText.
 * `original` is the block text the editor showed; if the file no longer has
 * that text at that range, the edit is rejected (stale line map).
 */
export function spliceBlock(buf: Buffer, lineStart: number, lineEnd: number, original: string, newText: string): Buffer {
  const idx = indexLines(buf);
  const { from, to } = regionBounds(buf, idx, lineStart, lineEnd);
  const region = buf.subarray(from, to).toString('utf8');
  // A list's last item owns the blank line after it, so compare and keep every trailing line break.
  if (norm(region).replace(/\n+$/, '') !== norm(original).replace(/\n+$/, '')) {
    throw new BlockEditError('The file changed on disk since this block was rendered. The view has been refreshed — please try again.');
  }
  // Line ending of the block's last line (kept verbatim), and the separator
  // used inside the block (taken from the block's own first line).
  const trailing = /(?:\r?\n)*$/.exec(region)![0];
  const firstEol = /\r?\n/.exec(region)?.[0] ?? (trailing || detectEol(buf));
  let body = newText.replace(/\r\n/g, '\n');
  body = body.replace(/\n+$/, '');
  const replacement = body === '' && newText === '' ? '' : body.split('\n').join(firstEol) + trailing;
  return Buffer.concat([buf.subarray(0, from), Buffer.from(replacement, 'utf8'), buf.subarray(to)]);
}

/**
 * Replace lines [ts, te) of `target` with lines [ss, se) of `source`, as raw
 * bytes. Either span may be empty (ts === te inserts), and an end may be the
 * line count (the end of the file). Every byte outside the span is kept. The
 * copied lines take the target's line endings when the two files differ, and
 * a line break is added where the copy would otherwise run into its neighbour.
 */
export function spliceLines(target: Buffer, ts: number, te: number, source: Buffer, ss: number, se: number): Buffer {
  const span = (buf: Buffer, from: number, to: number) => {
    const { starts } = indexLines(buf);
    if (!(from >= 0 && to >= from && to <= starts.length)) {
      throw new BlockEditError(`Line range ${from}-${to} is outside the file (${starts.length} lines).`);
    }
    const at = (l: number) => (l < starts.length ? starts[l] : buf.length);
    const end = at(to);
    return [at(from), end, /^[\r\n]*$/.test(buf.subarray(end).toString('latin1')) ? 1 : 0]; // 1: nothing but line breaks follows
  };
  const [tf, tt, tEnd] = span(target, ts, te);
  const [sf, st, sEnd] = span(source, ss, se);
  let seg = source.subarray(sf, st);
  const eol = detectEol(target);
  if (seg.length && detectEol(source) !== eol) seg = Buffer.from(seg.toString('utf8').replace(/\r?\n/g, eol), 'utf8');
  const nl = (b: Buffer) => b.length > 0 && b[b.length - 1] === 0x0a;
  const parts = [target.subarray(0, tf)];
  // Inserting after a last line that has no line break.
  if (seg.length && tf === target.length && tf > indexLines(target).bom && !nl(target)) parts.push(Buffer.from(eol));
  parts.push(seg);
  // The copy ends the source file without a break, but lines follow it here.
  if (seg.length && !nl(seg) && tt < target.length) parts.push(Buffer.from(eol));
  parts.push(target.subarray(tt));
  const out = Buffer.concat(parts);
  // Removing the last block of both files: end with a line break only if the source does.
  if (!seg.length && tEnd && sEnd && nl(out) && !nl(source)) return out.subarray(0, out.length - (out.length > 1 && out[out.length - 2] === 0x0d ? 2 : 1));
  return out;
}

function detectEol(buf: Buffer): string {
  const i = buf.indexOf(0x0a);
  return i > 0 && buf[i - 1] === 0x0d ? '\r\n' : '\n';
}

/** Read the file, splice, write back. Returns the new buffer. */
export function applyBlockEdit(filePath: string, lineStart: number, lineEnd: number, original: string, newText: string): Buffer {
  const buf = fs.readFileSync(filePath);
  const out = spliceBlock(buf, lineStart, lineEnd, original, newText);
  if (!out.equals(buf)) fs.writeFileSync(filePath, out);
  return out;
}

export const TASK_LINE = /^([ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)( |x|X)\]/;

/**
 * A short fingerprint of a task line, ignoring its tick and line ending, so a
 * click can prove it still points at the task the user saw.
 */
export function taskKey(line: string): string {
  const text = line.replace(/^\uFEFF/, '').replace(/\r$/, '').replace(TASK_LINE, '$1 ]');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * Tick or untick the task list item that starts on `line` (0-based) by
 * rewriting the single byte between its brackets. Nothing else changes.
 * With `key`, the line must still be the task that was rendered.
 */
export function toggleTask(filePath: string, line: number, checked: boolean, key?: string): void {
  const buf = fs.readFileSync(filePath);
  const idx = indexLines(buf);
  if (!(line >= 0 && line < idx.starts.length)) throw new BlockEditError(`Line ${line + 1} is outside the file.`);
  const start = idx.starts[line];
  const end = line + 1 < idx.starts.length ? idx.starts[line + 1] : buf.length;
  const text = buf.subarray(start, end).toString('utf8');
  const m = TASK_LINE.exec(text);
  if (!m || (key !== undefined && taskKey(text.replace(/\n$/, '')) !== key)) throw new BlockEditError('That task changed on disk; the view was refreshed.');
  if ((m[2] !== ' ') === checked) return;
  buf[start + Buffer.byteLength(m[1])] = checked ? 0x78 /* x */ : 0x20;
  fs.writeFileSync(filePath, buf);
}
