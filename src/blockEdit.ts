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
  if (norm(region) !== norm(original)) {
    throw new BlockEditError('The file changed on disk since this block was rendered. The view has been refreshed — please try again.');
  }
  // Line ending of the block's last line (kept verbatim), and the separator
  // used inside the block (taken from the block's own first line).
  const trailing = region.endsWith('\r\n') ? '\r\n' : region.endsWith('\n') ? '\n' : '';
  const firstEol = /\r?\n/.exec(region)?.[0] ?? (trailing || detectEol(buf));
  let body = newText.replace(/\r\n/g, '\n');
  if (body.endsWith('\n')) body = body.slice(0, -1);
  const replacement = body === '' && newText === '' ? '' : body.split('\n').join(firstEol) + trailing;
  return Buffer.concat([buf.subarray(0, from), Buffer.from(replacement, 'utf8'), buf.subarray(to)]);
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
 * Tick or untick the task list item that starts on `line` (0-based) by
 * rewriting the single byte between its brackets. Nothing else changes.
 */
export function toggleTask(filePath: string, line: number, checked: boolean): void {
  const buf = fs.readFileSync(filePath);
  const idx = indexLines(buf);
  if (!(line >= 0 && line < idx.starts.length)) throw new BlockEditError(`Line ${line + 1} is outside the file.`);
  const start = idx.starts[line];
  const end = line + 1 < idx.starts.length ? idx.starts[line + 1] : buf.length;
  const m = TASK_LINE.exec(buf.subarray(start, end).toString('utf8'));
  if (!m) throw new BlockEditError('That task changed on disk; the view was refreshed.');
  if ((m[2] !== ' ') === checked) return;
  buf[start + Buffer.byteLength(m[1])] = checked ? 0x78 /* x */ : 0x20;
  fs.writeFileSync(filePath, buf);
}
