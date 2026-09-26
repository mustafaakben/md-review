// Where the Changes view keeps the copy of each file taken at Send. The bytes
// go in a file of their own in the extension's storage, named by a hash of the
// document's path; only the small details (when, which threads) sit in
// workspace state, so nothing large is parsed at startup or rewritten per edit.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Baseline } from './redlines';

/** One file's baseline, as a session sees it. */
export interface BaselineHook {
  /** The saved baseline's details (no bytes), or undefined. */
  get(): Baseline | undefined;
  /** Its bytes, or undefined if they're gone. */
  read(): Buffer | undefined;
  /** Save the details, and the bytes when they changed; null drops the baseline and its bytes. */
  set(b: Baseline | null, bytes?: Buffer): void;
}

/** A baseline kept in memory only (tests, the browser harness). */
export function memoryBaselines(): BaselineHook {
  let meta: Baseline | undefined;
  let data: Buffer | undefined;
  return {
    get: () => meta,
    read: () => data,
    set(b, bytes) {
      meta = b ?? undefined;
      if (!b) data = undefined;
      else if (bytes) data = bytes;
    },
  };
}

/** The part of VS Code's Memento this needs. */
export interface StateLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): unknown;
  keys?(): readonly string[];
}

interface Entry extends Baseline {
  /** The document it belongs to, for people reading the state. */
  file: string;
  size: number;
  /** Last saved, ms: the oldest go first when over the limits. */
  used: number;
}

const INDEX = 'mdReview.baselines';

/** Baselines for every file of a workspace: at most `maxFiles` of them and `maxBytes` in all, oldest dropped first. */
export class BaselineStore {
  constructor(
    private dir: string,
    private state: StateLike,
    private opts: { maxFiles?: number; maxBytes?: number; win32?: boolean } = {},
  ) {
    // Earlier builds kept the bytes themselves in workspace state, one key per file.
    for (const k of state.keys?.() ?? []) if (k.startsWith(INDEX + ':')) state.update(k, undefined);
  }

  /** A file's key: a hash of its path (case-folded on Windows, where paths are). */
  key(mdPath: string): string {
    let p = path.resolve(mdPath);
    if (this.opts.win32 ?? process.platform === 'win32') p = p.toLowerCase();
    return crypto.createHash('sha1').update(p).digest('hex');
  }

  private index(): Record<string, Entry> {
    return this.state.get<Record<string, Entry>>(INDEX) ?? {};
  }

  private file(key: string): string {
    return path.join(this.dir, key);
  }

  forFile(mdPath: string): BaselineHook {
    const key = this.key(mdPath);
    return {
      get: () => {
        const e = this.index()[key];
        if (!e) return undefined;
        const { file: _f, size: _s, used: _u, ...b } = e;
        return b;
      },
      read: () => {
        try {
          return fs.readFileSync(this.file(key));
        } catch {
          return undefined;
        }
      },
      set: (b, bytes) => {
        const all = { ...this.index() };
        if (!b) {
          if (!all[key]) return;
          delete all[key];
          this.remove(key);
        } else {
          if (bytes) {
            fs.mkdirSync(this.dir, { recursive: true });
            fs.writeFileSync(this.file(key), bytes);
          }
          // Later than every other, even within one millisecond.
          const used = Math.max(Date.now(), ...Object.values(all).map((e) => e.used + 1));
          all[key] = { ...b, file: mdPath, size: bytes?.length ?? all[key]?.size ?? 0, used };
          this.evict(all, key);
        }
        this.state.update(INDEX, Object.keys(all).length ? all : undefined);
      },
    };
  }

  private evict(all: Record<string, Entry>, keep: string): void {
    const maxFiles = this.opts.maxFiles ?? 50;
    const maxBytes = this.opts.maxBytes ?? 64 * 1024 * 1024;
    const old = Object.keys(all).filter((k) => k !== keep).sort((a, b) => all[a].used - all[b].used);
    let total = Object.values(all).reduce((n, e) => n + e.size, 0);
    while (old.length && (Object.keys(all).length > maxFiles || total > maxBytes)) {
      const k = old.shift()!;
      total -= all[k].size;
      delete all[k];
      this.remove(k);
    }
  }

  private remove(key: string): void {
    fs.rmSync(this.file(key), { force: true });
  }
}
