// Reading preferences for the document area: zoom, colour theme, and font.
// They belong to the user, not the file, so the host keeps them across files
// and sessions (VS Code globalState); the view just applies and reports them.

import { isMac, keyLabel } from './keys';
import { blockAtY, settle } from './reveal';
import { EXTRA_FONTS, FONT_GROUPS } from '../src/readingFonts';

export type ReadingTheme = 'auto' | 'paper' | 'sepia' | 'dusk' | 'night' | 'typewriter' | 'manuscript' | 'sage' | 'espresso' | 'ocean';
/**
 * 'theme': the font the theme comes with (see THEME_FONTS); sans for a theme
 * without one. Any other value is the id of a bundled font (EXTRA_FONTS).
 */
export type ReadingFont = 'sans' | 'serif' | 'theme' | (string & {});

export interface ReadingPrefs {
  zoom: number; // 1 = 100%
  theme: ReadingTheme;
  font: ReadingFont;
  density: 'comfortable' | 'compact';
  width: number | 'full';
}

export const DEFAULT_PREFS: ReadingPrefs = { zoom: 1, theme: 'auto', font: 'sans', density: 'comfortable', width: 68 };
const WIDTHS = [['52', 'Narrow'], ['68', 'Standard'], ['92', 'Wide'], ['full', 'Full width']] as const;
const THEMES: [ReadingTheme, string][] = [
  ['auto', 'MD Review'],
  ['paper', 'Paper'],
  ['sepia', 'Sepia'],
  ['dusk', 'Dusk'],
  ['night', 'Night'],
  ['typewriter', 'Typewriter'],
  ['manuscript', 'Manuscript'],
  ['sage', 'Sage'],
  ['espresso', 'Espresso'],
  ['ocean', 'Ocean'],
];
// Writing themes that come with a font of their own (features.css sets the
// face); the Font row offers it as a third choice, named here.
const THEME_FONTS: Partial<Record<ReadingTheme, [cls: string, label: string]>> = {
  typewriter: ['mono', 'Mono'],
  manuscript: ['book', 'Book'],
  sage: ['humanist', 'Humanist'],
  espresso: ['book', 'Book'],
  ocean: ['humanist', 'Humanist'],
};
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
  keepPlace: (anchorY?: number) => (() => void) | null = () => null,
): Reading {
  const prefs: ReadingPrefs = { ...DEFAULT_PREFS };
  let saveT: any;
  let fontsOpen = false; // the "More fonts" list, which survives re-rendering the panel

  function widthLabel() { return prefs.width === 'full' ? 'Uses available space' : `Approx. ${prefs.width} characters`; }
  function applyWidth() {
    document.documentElement.style.setProperty('--doc-max-width', prefs.width === 'full' ? '100%' : `calc(${prefs.width}ch + 100px)`);
  }
  function widthControls() {
    const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-width]'));
    buttons.forEach((button, index) => {
      const selected = button.dataset.width === String(prefs.width);
      button.classList.toggle('on', selected);
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected || (!buttons.some(b => b.dataset.width === String(prefs.width)) && index === 0) ? 0 : -1;
    });
    const slider = panel.querySelector<HTMLInputElement>('#mdr-width-slider');
    if (slider) { slider.value = String(prefs.width === 'full' ? 120 : prefs.width); slider.setAttribute('aria-valuetext', widthLabel()); }
    const output = panel.querySelector('#mdr-width-value'); if (output) output.textContent = widthLabel();
  }
  function render() {
    // Re-rendering replaces the buttons, so remember which one had focus.
    const had = panel.contains(document.activeElement) ? keyOf(document.activeElement as HTMLElement) : '';
    document.body.dataset.readingTheme = prefs.theme;
    document.body.dataset.readingFont = prefs.font;
    document.body.dataset.reviewDensity = prefs.density;
    document.documentElement.style.setProperty('--doc-zoom', String(prefs.zoom));
    applyWidth();
    const pct = `${Math.round(prefs.zoom * 100)}%`;
    button.title = `Reading view: theme, font, writing width, and zoom (${pct})`;
    const paired = THEME_FONTS[prefs.theme];
    // Without a theme font, 'theme' shows (and renders) as Sans.
    const font = prefs.font === 'theme' && !paired ? 'sans' : prefs.font;
    const extra = EXTRA_FONTS.find((f) => f.id === font);
    // A font from the list leaves the Sans / Serif row with nothing checked;
    // Tab then reaches its first button.
    const fontBtn = (k: ReadingFont, label: string, cls = '') =>
      `<button data-font="${k}" class="${cls}${font === k ? ' on' : ''}" aria-checked="${font === k}" role="radio">${label}</button>`;
    const fontList = FONT_GROUPS.map(([g, name]) => `
        <div class="mdr-font-group" role="group" aria-label="${name}"><div class="mdr-font-gl" aria-hidden="true">${name}</div>${EXTRA_FONTS.filter((f) => f.group === g).map(
          (f) => `<button data-font="${f.id}" class="mdr-font-opt ff-${f.id}${font === f.id ? ' on' : ''}" role="option" aria-selected="${font === f.id}" tabindex="-1"><span>${f.label}</span><small>${f.note}</small></button>`,
        ).join('')}</div>`).join('');
    panel.innerHTML = `
      <div class="mdr-rp-label">Theme</div>
      <div class="mdr-rp-themes" role="radiogroup" aria-label="Reading theme">${THEMES.map(
        ([k, label]) =>
          `<button class="mdr-swatch t-${k}${prefs.theme === k ? ' on' : ''}" data-theme="${k}" role="radio" aria-checked="${prefs.theme === k}" title="${label}"><span></span>${label}</button>`,
      ).join('')}</div>
      <div class="mdr-rp-label">Font</div>
      <div class="mdr-rp-seg" role="radiogroup" aria-label="Font">
        ${fontBtn('sans', 'Sans')}${fontBtn('serif', 'Serif', 'serif')}${paired ? fontBtn('theme', paired[1], `tf-${paired[0]}`) : ''}
      </div>
      <button class="mdr-font-pick${extra ? ' on' : ''}" data-fontlist="" aria-haspopup="listbox" aria-expanded="${fontsOpen}" aria-controls="mdr-font-list">
        <span class="${extra ? `ff-${extra.id}` : ''}">${extra ? extra.label : 'More fonts…'}</span><i aria-hidden="true"></i>
      </button>
      <div id="mdr-font-list" class="mdr-font-list" role="listbox" aria-label="More fonts"${fontsOpen ? '' : ' hidden'}>${fontList}
      </div>
      <div class="mdr-rp-label">Review spacing</div>
      <div class="mdr-rp-seg" role="radiogroup" aria-label="Review spacing">
        <button data-density="comfortable" role="radio" aria-checked="${prefs.density === 'comfortable'}" class="${prefs.density === 'comfortable' ? 'on' : ''}">Comfortable</button>
        <button data-density="compact" role="radio" aria-checked="${prefs.density === 'compact'}" class="${prefs.density === 'compact' ? 'on' : ''}">Compact</button>
      </div>
      <div class="mdr-rp-label">Writing width</div>
      <div class="mdr-rp-seg mdr-rp-widths" role="radiogroup" aria-label="Writing width presets">${WIDTHS.map(([value, label]) => `<button data-width="${value}" role="radio" aria-checked="${String(prefs.width) === value}" class="${String(prefs.width) === value ? 'on' : ''}">${label}</button>`).join('')}</div>
      <label class="mdr-width-label" for="mdr-width-slider">Custom width <output id="mdr-width-value">${widthLabel()}</output></label>
      <input id="mdr-width-slider" class="mdr-width-slider" type="range" min="40" max="120" step="1" value="${prefs.width === 'full' ? 120 : prefs.width}" aria-label="Custom writing width" aria-valuetext="${widthLabel()}">
      <div class="mdr-rp-label">Zoom <span class="mdr-rp-hint">${isMac ? '⌘' : 'Ctrl+'}wheel · ${keyLabel('Mod+=')} / ${keyLabel('Mod+-')} / ${keyLabel('Mod+0')}</span></div>
      <div class="mdr-rp-seg">
        <button data-zoom="-1" aria-label="Zoom out" ${prefs.zoom <= MIN ? 'disabled' : ''}>−</button>
        <button data-zoom="0" class="mdr-rp-pct" title="Reset to 100%">${pct}</button>
        <button data-zoom="1" aria-label="Zoom in" ${prefs.zoom >= MAX ? 'disabled' : ''}>+</button>
      </div>`;
    // Roving tabindex inside each radio group: Tab reaches the checked option.
    panel.querySelectorAll('[role="radio"]').forEach((b) => b.setAttribute('tabindex', b.getAttribute('aria-checked') === 'true' ? '0' : '-1'));
    panel.querySelectorAll('[role="radiogroup"]').forEach((g) => {
      if (!g.querySelector('[aria-checked="true"]')) g.querySelector('[role="radio"]')?.setAttribute('tabindex', '0');
    });
    (panel.querySelector('.mdr-font-opt[aria-selected="true"]') ?? panel.querySelector('.mdr-font-opt'))?.setAttribute('tabindex', '0');
    widthControls();
    if (had) {
      const again = panel.querySelector(had) as HTMLButtonElement | null;
      (again && !again.disabled ? again : (panel.querySelector('[data-zoom="0"]') as HTMLElement))?.focus({ preventScroll: true });
    }
  }

  function keyOf(el: HTMLElement): string {
    if (el.id === 'mdr-width-slider') return '#mdr-width-slider';
    const b = el.closest('button');
    if (!b) return '';
    for (const k of ['theme', 'font', 'fontlist', 'density', 'width', 'zoom']) if (b.dataset[k] !== undefined) return `[data-${k}="${b.dataset[k]}"]`;
    return '';
  }

  function close(returnFocus: boolean) {
    if (panel.hidden) return;
    const inside = panel.contains(document.activeElement);
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus || inside) button.focus({ preventScroll: true });
  }

  function set(p: Partial<ReadingPrefs>, persist: boolean, widthOnly = false) {
    const restore = ('width' in p || 'font' in p) ? keepPlace() : null;
    Object.assign(prefs, p);
    if (prefs.width !== 'full') prefs.width = typeof prefs.width === 'number' && Number.isFinite(prefs.width) ? Math.max(40, Math.min(120, Math.round(prefs.width))) : 68;
    prefs.zoom = Math.min(MAX, Math.max(MIN, Math.round(prefs.zoom * 100) / 100));
    if (widthOnly) { applyWidth(); widthControls(); } else render();
    restore?.();
    if (persist) {
      clearTimeout(saveT);
      saveT = setTimeout(() => save({ ...prefs }), 250);
    }
  }

  /** Zoom while keeping the text under `anchorY` (viewport px) in place. */
  function zoomTo(z: number, anchorY?: number) {
    const before = prefs.zoom;
    z = Math.min(MAX, Math.max(MIN, z));
    if (Math.abs(z - before) < 0.001) return;
    // The live canvas owns its source positions. Measuring its hidden rendered
    // mirror returns zero-sized blocks and can repeatedly scroll back to line 1.
    const restore = keepPlace(anchorY);
    if (restore) {
      set({ zoom: z }, true);
      restore();
      note(`Zoom ${Math.round(z * 100)}%`);
      return;
    }
    // Keep the same point of the block under anchorY there. Blocks off screen
    // have estimated or remembered heights that don't scale with the zoom, so
    // the document's height is no guide.
    const y = anchorY ?? window.innerHeight / 3;
    const el = doc.hidden ? null : blockAtY(doc.children, y);
    const r = el?.getBoundingClientRect();
    const frac = r && r.height ? (y - r.top) / r.height : 0;
    set({ zoom: z }, true);
    if (el) {
      settle(() => {
        const n = el.getBoundingClientRect();
        return n.top + frac * n.height - y;
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
    // The font list: arrows, Home and End move through it; Escape closes just the list.
    const inList = (e.target as HTMLElement).closest('.mdr-font-list');
    if (inList) {
      const opts = Array.from(inList.querySelectorAll<HTMLButtonElement>('.mdr-font-opt'));
      const at = opts.indexOf(e.target as HTMLButtonElement);
      const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: opts.length - 1 }[e.key];
      if (to !== undefined) {
        e.preventDefault();
        opts[Math.max(0, Math.min(opts.length - 1, to))]?.focus({ preventScroll: false });
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        fontsOpen = false;
        render();
        (panel.querySelector('[data-fontlist]') as HTMLElement | null)?.focus({ preventScroll: true });
        return;
      }
    }
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
    next?.focus({ preventScroll: true });
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
    if (t.dataset.theme) {
      // A writing theme switches to its own font; Sans or Serif is one click away.
      // Leaving one for a theme without a font goes back to Sans. Sending the
      // font along keeps the reading place while the text reflows.
      // A font picked from the list stays whatever the theme.
      const theme = t.dataset.theme as ReadingTheme;
      const chosen = EXTRA_FONTS.some((f) => f.id === prefs.font);
      if (THEME_FONTS[theme] && !chosen) set({ theme, font: 'theme' }, true);
      else set(prefs.font === 'theme' && !THEME_FONTS[theme] ? { theme, font: 'sans' } : { theme }, true);
    } else if (t.dataset.fontlist !== undefined) {
      fontsOpen = !fontsOpen;
      render();
      const sel = panel.querySelector<HTMLElement>('.mdr-font-opt[aria-selected="true"]') ?? panel.querySelector<HTMLElement>('.mdr-font-opt');
      (fontsOpen ? sel : (panel.querySelector('[data-fontlist]') as HTMLElement | null))?.focus({ preventScroll: true });
      if (fontsOpen) sel?.scrollIntoView({ block: 'nearest' });
    } else if (t.dataset.font) {
      const fromList = t.classList.contains('mdr-font-opt');
      if (fromList) fontsOpen = false;
      set({ font: t.dataset.font as ReadingFont }, true);
      if (fromList) (panel.querySelector('[data-fontlist]') as HTMLElement | null)?.focus({ preventScroll: true });
    }
    else if (t.dataset.density === 'compact' || t.dataset.density === 'comfortable') set({ density: t.dataset.density }, true);
    else if (t.dataset.width) set({ width: t.dataset.width === 'full' ? 'full' : Number(t.dataset.width) }, true);
    else if (t.dataset.zoom === '0') api.resetZoom();
    else if (t.dataset.zoom) step(Number(t.dataset.zoom) as 1 | -1);
  });
  panel.addEventListener('input', e => {
    const input = e.target as HTMLInputElement;
    if (input.id === 'mdr-width-slider') set({ width: Number(input.value) }, true, true);
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
      if (focus) (panel.querySelector('.mdr-swatch[aria-checked="true"]') as HTMLElement | null)?.focus({ preventScroll: true });
    },
  };
  render();
  return api;
}
