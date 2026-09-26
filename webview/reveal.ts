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

function wanted(r: DOMRect, place: Place): number {
  if (place === 'start') return viewTop() + 8;
  if (place === 'third') return window.innerHeight / 3;
  return (viewTop() + window.innerHeight) / 2 - Math.min(r.height, window.innerHeight / 2) / 2;
}

/**
 * Scroll by `delta()` pixels now, then re-measure and correct on each of the
 * next few frames: blocks that just came into view take their real height a
 * frame after the jump, which moves the target. `delta` reads live layout.
 */
export function settle(delta: () => number, frames = 8): void {
  const d = delta();
  if (Math.abs(d) >= 1) window.scrollBy(0, d);
  if (frames > 0) requestAnimationFrame(() => settle(delta, frames - 1));
}

export function reveal(target: Target | null | undefined, place: Place, smooth = true): void {
  if (!target) return;
  const delta = () => {
    const r = target.getBoundingClientRect();
    return r.top - wanted(r, place);
  };
  const d = delta();
  if (smooth && Math.abs(d) < window.innerHeight) window.scrollBy({ top: d, behavior: 'smooth' });
  else settle(delta);
}
