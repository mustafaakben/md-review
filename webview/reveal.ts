// Scrolling the document to a target. Off-screen blocks skip layout (see
// content-visibility in style.css) and use an estimated height until they are
// first shown, so a far target's position is only approximate before the jump.
// A near target scrolls smoothly; a far one jumps, then corrects over a few
// frames as the blocks around it take their real size.

type Target = Element | Range;

/** Where the target should end up: the vertical offset its top should have. */
export type Place = 'start' | 'center' | 'third';

/** Bottom edge of the sticky toolbar: the top of the readable area. */
export const viewTop = () => document.querySelector('.mdr-toolbar')?.getBoundingClientRect().bottom ?? 0;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** The first of `blocks` (in document order) whose bottom is below viewport y. */
export function blockAtY(blocks: HTMLCollection, y: number): Element | undefined {
  if (!blocks.length) return undefined;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].getBoundingClientRect().bottom > y) hi = mid;
    else lo = mid + 1;
  }
  return blocks[lo];
}

function wanted(r: DOMRect, place: Place): number {
  if (place === 'start') return viewTop() + 8;
  if (place === 'third') return window.innerHeight / 3;
  return (viewTop() + window.innerHeight) / 2 - Math.min(r.height, window.innerHeight / 2) / 2;
}

// Only the newest correction runs: a new jump, or the reader scrolling, ends
// the one before.
let generation = 0;

export function cancelScrolls(): void {
  generation++;
}

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);
for (const type of ['wheel', 'touchstart', 'pointerdown']) {
  window.addEventListener(type, cancelScrolls, { capture: true, passive: true });
}
window.addEventListener(
  'keydown',
  (e) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (SCROLL_KEYS.has(e.key) && !typing) cancelScrolls();
  },
  { capture: true },
);

/**
 * Scroll by `delta()` pixels now, then re-measure and correct on each of the
 * next few frames: blocks that just came into view take their real height a
 * frame after the jump, which moves the target. `delta` reads live layout and
 * returns null once the target is gone. `done` runs when the correction ends,
 * finished or cancelled.
 */
export function settle(delta: () => number | null, frames = 8, done?: () => void): void {
  const mine = ++generation;
  const step = (left: number) => {
    const d = mine === generation ? delta() : null;
    if (d === null) return done?.();
    if (Math.abs(d) >= 1) window.scrollBy(0, d);
    if (left > 0) requestAnimationFrame(() => step(left - 1));
    else done?.();
  };
  step(frames);
}

export function reveal(target: Target | null | undefined, place: Place, smooth = true): void {
  if (!target) return;
  const node = target instanceof Range ? target.startContainer : target;
  const delta = () => {
    if (!node.isConnected) return null;
    const r = target.getBoundingClientRect();
    return r.top - wanted(r, place);
  };
  const d = delta()!;
  if (smooth && !reducedMotion.matches && Math.abs(d) < window.innerHeight) {
    cancelScrolls();
    window.scrollBy({ top: d, behavior: 'smooth' });
  } else settle(delta);
}
