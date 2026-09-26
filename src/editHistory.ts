// Undo/redo for edits made in the rendered view. Each entry stores only the
// changed byte span plus hashes of the whole file before and after, so an undo
// is byte-exact and is refused if anything else touched the file since.
import * as crypto from 'crypto';

export interface EditEntry {
  start: number; // byte offset where the change begins
  removed: Buffer; // bytes that were there before the edit
  inserted: Buffer; // bytes the edit wrote
  beforeHash: string;
  afterHash: string;
}

export class HistoryError extends Error {}

const hash = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');

/** The minimal span that differs between two buffers. */
export function diffEntry(before: Buffer, after: Buffer): EditEntry | null {
  if (before.equals(after)) return null;
  let s = 0;
  const max = Math.min(before.length, after.length);
  while (s < max && before[s] === after[s]) s++;
  let e = 0;
  while (e < max - s && before[before.length - 1 - e] === after[after.length - 1 - e]) e++;
  return {
    start: s,
    removed: Buffer.from(before.subarray(s, before.length - e)),
    inserted: Buffer.from(after.subarray(s, after.length - e)),
    beforeHash: hash(before),
    afterHash: hash(after),
  };
}

function swap(buf: Buffer, start: number, from: Buffer, to: Buffer): Buffer {
  return Buffer.concat([buf.subarray(0, start), to, buf.subarray(start + from.length)]);
}

export class EditHistory {
  private done: EditEntry[] = [];
  private undone: EditEntry[] = [];

  constructor(private limit = 100) {}

  get canUndo(): boolean {
    return this.done.length > 0;
  }
  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  record(before: Buffer, after: Buffer): void {
    const e = diffEntry(before, after);
    if (!e) return;
    this.done.push(e);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }

  /** Returns the file contents with the last edit reverted. */
  undo(current: Buffer): Buffer {
    const e = this.done[this.done.length - 1];
    if (!e) throw new HistoryError('Nothing to undo.');
    if (hash(current) !== e.afterHash) {
      this.clear();
      throw new HistoryError('The file changed outside MD Review since your last edit, so undo history was cleared.');
    }
    this.done.pop();
    this.undone.push(e);
    return swap(current, e.start, e.inserted, e.removed);
  }

  /** Returns the file contents with the last undone edit re-applied. */
  redo(current: Buffer): Buffer {
    const e = this.undone[this.undone.length - 1];
    if (!e) throw new HistoryError('Nothing to redo.');
    if (hash(current) !== e.beforeHash) {
      this.clear();
      throw new HistoryError('The file changed outside MD Review since the undo, so redo history was cleared.');
    }
    this.undone.pop();
    this.done.push(e);
    return swap(current, e.start, e.removed, e.inserted);
  }
}
