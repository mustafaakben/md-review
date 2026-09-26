// Images outside the folders the webview may load from. No vscode dependency,
// so it can be tested alone.
import * as fs from 'fs';
import * as path from 'path';
import { isNetworkPath } from './bibliography';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

/** Figures are rarely bigger; a larger file stays unshown rather than bloating every render. */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

const cache = new Map<string, { stamp: string; url: string }>();
/** Keep at most this much encoded image text around between renders. */
const MAX_CACHE_CHARS = 64 * 1024 * 1024;
let cached = 0;

/**
 * `file` as a data: URL, so the webview can show it without widening the
 * folders it may load from (which would also mean reloading the page). Only
 * regular image files up to 8 MB; never a Windows network path, which would
 * connect to that server. Returns null when the file can't be shown this way.
 */
export function inlineImage(file: string, platform: NodeJS.Platform = process.platform): string | null {
  if (isNetworkPath(file, platform)) return null;
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return null;
  let stamp: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_INLINE_BYTES) return null;
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.url;
  let url: string;
  try {
    url = `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
  if (hit) cached -= hit.url.length;
  if (cached + url.length > MAX_CACHE_CHARS) {
    cache.clear();
    cached = 0;
  }
  cache.set(file, { stamp, url });
  cached += url.length;
  return url;
}

/** Whether `p` is `root` or inside it (case-insensitively on Windows, as path.relative is). */
export function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
