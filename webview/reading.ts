// Reading preferences for the document area: zoom, colour theme, and font.
// They belong to the user, not the file, so the host keeps them across files
// and sessions (VS Code globalState); the view just applies and reports them.

import { isMac, keyLabel } from './keys';
import { blockAtY, settle } from './reveal';

export type ReadingTheme = 'auto' | 'paper' | 'sepia' | 'dusk' | 'night';
export type ReadingFont = 'sans' | 'serif';

export interface ReadingPrefs {
  zoom: number; // 1 = 100%
  theme: ReadingTheme;
  font: ReadingFont;
}

export const DEFAULT_PREFS: ReadingPrefs = { zoom: 1, theme: 'auto', font: 'sans' };
const THEMES: [ReadingTheme, string][] = [
  ['auto', 'Match VS Code'],
  ['paper', 'Paper'],
  ['sepia', 'Sepia'],
  ['dusk', 'Dusk'],
  ['night', 'Night'],
];
const STEPS = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2, 2.5];
const MIN = STEPS[0];
const MAX = STEPS[STEPS.length - 1];

export interface Reading {
  apply(p: Partial<ReadingPrefs>): void;
  zoomBy(dir: 1 | -1): void;
  resetZoom(): void;
  /** `focus` (default true): move focus into the panel when opening it. */
  togglePanel(focus?: boolean): void;
}

export function createReading(
  doc: HTMLElement,
  button: HTMLElement,
  panel: HTMLElement,
  save: (p: ReadingPrefs) => void,
  note: (msg: string) => void,
): Reading {
  const prefs: ReadingPrefs = { ...DEFAULT_PREFS };
  let saveT: any;

  function render() {
    // Re-rendering replaces the buttons, so remember which one had focus.
    const had = panel.contains(document.activeElement) ? keyOf(document.activeElement as HTMLElement) : '';
    document.body.dataset.readingTheme = prefs.theme;
    document.body.dataset.readingFont = prefs.font;
    document.documentElement.style.setProperty('--doc-zoom', String(prefs.zoom));
    const pct = `${Math.round(prefs.zoom * 100)}%`;
    button.title = `Reading view: theme, font, and zoom (${pct})`;
    panel.innerHTML = `
      <div class="mdr-rp-label">Theme</div>
      <div class="mdr-rp-themes" role="radiogroup" aria-label="Reading theme">${THEMES.map(
        ([k, label]) =>
          `<button class="mdr-swatch t-${k}${prefs.theme === k ? ' on' : ''}" data-theme="${k}" role="radio" aria-checked="${prefs.theme === k}" title="${label}"><span></span>${label}</button>`,
      ).join('')}</div>
      <div class="mdr-rp-label">Font</div>
      <div class="mdr-rp-seg" role="radiogroup" aria-label="Font">
        <button data-font="sans" class="${prefs.font === 'sans' ? 'on' : ''}" aria-checked="${prefs.font === 'sans'}" role="radio">Sans</button>
        <button data-font="serif" class="serif${prefs.font === 'serif' ? ' on' : ''}" aria-checked="${prefs.font === 'serif'}" role="radio">Serif</button>
      </div>
      <div class="mdr-rp-label">Zoom <span class="mdr-rp-hint">${isMac ? '⌘' : 'Ctrl+'}wheel · ${keyLabel('Mod+=')} / ${keyLabel('Mod+-')} / ${keyLabel('Mod+0')}</span></div>
      <div class="mdr-rp-seg">
        <button data-zoom="-1" aria-label="Zoom out" ${prefs.zoom <= MIN ? 'disabled' : ''}>−</button>
        <button data-zoom="0" class="mdr-rp-pct" title="Reset to 100%">${pct}</button>
        <button data-zoom="1" aria-label="Zoom in" ${prefs.zoom >= MAX ? 'disabled' : ''}>+</button>
      </div>`;
    // Roving tabindex inside each radio group: Tab reaches the checked option.
    panel.querySelectorAll('[role="radio"]').forEach((b) => b.setAttribute('tabindex', b.getAttribute('aria-checked') === 'true' ? '0' : '-1'));
    if (had) {
      const again = panel.querySelector(had) as HTMLButtonElement | null;
      (again && !again.disabled ? again : (panel.querySelector('[data-zoom="0"]') as HTMLElement))?.focus();
    }
  }

  function keyOf(el: HTMLElement): string {
    const b = el.closest('button');
    if (!b) return '';
    for (const k of ['theme', 'font', 'zoom']) if (b.dataset[k] !== undefined) return `[data-${k}="${b.dataset[k]}"]`;
    return '';
  }

  function close(returnFocus: boolean) {
    if (panel.hidden) return;
    const inside = panel.contains(document.activeElement);
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus || inside) button.focus();
  }

  function set(p: Partial<ReadingPrefs>, persist: boolean) {
    Object.assign(prefs, p);
    prefs.zoom = Math.min(MAX, Math.max(MIN, Math.round(prefs.zoom * 100) / 100));
    render();
    if (persist) {
      clearTimeout(saveT);
      saveT = setTimeout(() => save({ ...prefs }), 250);
    }
  }

  /** Zoom while keeping the text under `anchorY` (viewport px) in place. */
  function zoomTo(z: number, anchorY = window.innerHeight / 3) {
    const before = prefs.zoom;
    z = Math.min(MAX, Math.max(MIN, z));
    if (Math.abs(z - before) < 0.001) return;
    // Keep the same point of the block under anchorY there. Blocks off screen
    // have estimated or remembered heights that don't scale with the zoom, so
    // the document's height is no guide.
    const el = blockAtY(doc.children, anchorY);
    const r = el?.getBoundingClientRect();
    const frac = r && r.height ? (anchorY - r.top) / r.height : 0;
    set({ zoom: z }, true);
    if (el) {
      settle(() => {
        const n = el.getBoundingClientRect();
        return n.top + frac * n.height - anchorY;
      });
    }
    note(`Zoom ${Math.round(z * 100)}%`);
  }

  function step(dir: 1 | -1) {
    const z = prefs.zoom;
    const next = dir > 0 ? STEPS.find((s) => s > z + 0.001) : [...STEPS].reverse().find((s) => s < z - 0.001);
    zoomTo(next ?? z);
  }

  // Ctrl/Cmd + wheel (and trackpad pinch, which Chromium reports the same way).
  let wheelAcc = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      wheelAcc += e.deltaY;
      // Pinch sends many tiny deltas: scale smoothly. A wheel notch is ~100: one step.
      if (Math.abs(e.deltaY) < 50) {
        zoomTo(prefs.zoom * Math.exp(-wheelAcc / 300), e.clientY);
        wheelAcc = 0;
      } else if (Math.abs(wheelAcc) >= 50) {
        const dir = wheelAcc < 0 ? 1 : -1;
        wheelAcc = 0;
        const z = prefs.zoom;
        const next = dir > 0 ? STEPS.find((s) => s > z + 0.001) : [...STEPS].reverse().find((s) => s < z - 0.001);
        if (next) zoomTo(next, e.clientY);
      }
    },
    { passive: false },
  );

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    api.togglePanel();
  });
  // Arrow keys move and select within a radio group, as native radios do.
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return close(true);
    }
    const t = e.target as HTMLElement;
    const group = t.closest('[role="radiogroup"]');
    if (!group || !/^Arrow(Up|Down|Left|Right)$/.test(e.key)) return;
    e.preventDefault();
    const opts = Array.from(group.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = opts[(opts.indexOf(t as HTMLButtonElement) + d + opts.length) % opts.length];
    next?.focus();
    next?.click();
  });
  // Tabbing out of the panel closes it, like a menu.
  panel.addEventListener('focusout', (e) => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (to && !panel.contains(to) && to !== button) close(false);
  });
  panel.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = (e.target as Element).closest('button');
    if (!t) return;
    if (t.dataset.theme) set({ theme: t.dataset.theme as ReadingTheme }, true);
    else if (t.dataset.font) set({ font: t.dataset.font as ReadingFont }, true);
    else if (t.dataset.zoom === '0') api.resetZoom();
    else if (t.dataset.zoom) step(Number(t.dataset.zoom) as 1 | -1);
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node)) close(false);
  });
  document.addEventListener('keydown', (e) => {
    // Escape in a text field belongs to that field.
    const t = e.target as HTMLElement;
    if (e.key === 'Escape' && !panel.hidden && !(t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) close(true);
  });

  const api: Reading = {
    apply(p) {
      set(p, false);
    },
    zoomBy: step,
    resetZoom() {
      zoomTo(1);
    },
    togglePanel(focus = true) {
      if (!panel.hidden) return close(focus);
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      // Focus the selected theme so the panel is usable from the keyboard.
      if (focus) (panel.querySelector('.mdr-swatch[aria-checked="true"]') as HTMLElement | null)?.focus();
    },
  };
  render();
  return api;
}
