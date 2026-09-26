// Decisions behind file watching: which names match, when to poll, how long to
// wait for a half-written sidecar. No vscode dependency, so it can be tested alone.
import * as fs from 'fs';
import * as path from 'path';

/** Wait this long (ms) before each re-read of a sidecar that didn't parse. */
export const SIDECAR_RETRY_MS = [50, 150, 400];

/** How often (ms) a visible panel checks its files where events are unreliable. */
export const POLL_MS = 2000;

/** A name or path as the disk compares it: case-insensitive on Windows and macOS. */
export function nameKey(name: string, platform: string): string {
  return platform === 'win32' || platform === 'darwin' ? name.toLowerCase() : name;
}

export function sameName(a: string, b: string, platform: string): boolean {
  return nameKey(a, platform) === nameKey(b, platform);
}

/** One key per folder, however the path is spelled. */
export function folderKey(dir: string, platform: string): string {
  return nameKey(path.resolve(dir), platform);
}

/**
 * Whether to poll instead of trusting file events: always when the setting is
 * on, and on Windows for network paths (\\server\share, \\wsl$\...), which
 * don't deliver them.
 */
export function shouldPoll(fsPath: string, platform: string, setting: boolean): boolean {
  return setting || (platform === 'win32' && /^[\\/]{2}/.test(fsPath));
}

/**
 * mtime and size, or '' when the file is missing. Asynchronous: the paths
 * polled are the ones that can hang (a dropped share), and a blocking stat
 * would freeze every extension, not just this one.
 */
export async function fileStamp(p: string): Promise<string> {
  try {
    const s = await fs.promises.stat(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '';
  }
}

/** Remembers each file's stamp; check() gives the files that changed since the last look. */
export class StampTracker {
  private stamps = new Map<string, string>();
  private busy: Promise<string[]> | undefined;

  constructor(private files: string[], private stamp: (p: string) => string | Promise<string> = fileStamp) {
    void this.check();
  }

  /** A check still waiting on a slow disk is shared, not stacked. */
  check(): Promise<string[]> {
    return (this.busy ??= this.look().finally(() => (this.busy = undefined)));
  }

  private async look(): Promise<string[]> {
    const changed: string[] = [];
    for (const f of this.files) {
      const s = await this.stamp(f);
      if (this.stamps.has(f) && this.stamps.get(f) !== s) changed.push(f);
      this.stamps.set(f, s);
    }
    return changed;
  }
}
