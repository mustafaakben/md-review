// Source transactions from the continuous editor. Offsets are UTF-16 in the
// LF-normalized document; bytes outside each changed range are preserved.
import * as fs from 'fs';
import { BlockEditError } from './blockEdit';
export interface SourceChange { from: number; to: number; insert: string }
export const sourceText = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
export function spliceSource(bytes: Buffer, original: string, changes: SourceChange[]): Buffer {
  const raw = bytes.toString('utf8');
  if (sourceText(raw) !== original) throw new BlockEditError('The file changed elsewhere. Your writing is still here; copy it before loading the updated file.');
  const bom = raw.startsWith('\uFEFF') ? 1 : 0;
  // Map source offsets to raw string offsets, retaining each existing CRLF.
  const offsets = [bom];
  for (let i = bom; i < raw.length; i++) {
    if (raw[i] === '\r' && raw[i + 1] === '\n') i++;
    offsets.push(i + 1);
  }
  let end = 0;
  const parts: Buffer[] = [];
  const eol = raw.match(/\r?\n/)?.[0] ?? '\n';
  for (const change of changes) {
    const { from, to, insert } = change;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < end || to < from || to > original.length || typeof insert !== 'string' || insert.includes('\r')) throw new Error('Invalid source transaction.');
    // A browser cursor cannot split a surrogate pair; reject malformed messages.
    for (const at of [from, to]) if (at > 0 && /[\uD800-\uDBFF]/.test(original[at - 1]) && /[\uDC00-\uDFFF]/.test(original[at] || '')) throw new Error('Invalid Unicode boundary.');
    const startByte = Buffer.byteLength(raw.slice(0, offsets[end]));
    const stopByte = Buffer.byteLength(raw.slice(0, offsets[from]));
    if (!parts.length && bom) parts.push(bytes.subarray(0, 3));
    parts.push(bytes.subarray(startByte, stopByte), Buffer.from(insert.replace(/\n/g, eol)));
    end = to;
  }
  if (!changes.length) return bytes;
  parts.push(bytes.subarray(Buffer.byteLength(raw.slice(0, offsets[end]))));
  return Buffer.concat(parts);
}
export function applySourceEdit(file: string, original: string, changes: SourceChange[]): string {
  const before = fs.readFileSync(file);
  const after = spliceSource(before, original, changes);
  if (!after.equals(before)) fs.writeFileSync(file, after);
  return sourceText(after.toString('utf8'));
}
