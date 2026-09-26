// Keyboard shortcuts: one table that drives the help sheet and the tooltips,
// written the native way for the platform (⌘/⌥/⇧ on macOS, Ctrl/Alt/Shift elsewhere).
// VS Code dispatches the modifier shortcuts through package.json keybindings;
// keep the two in step.

export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** The platform's command modifier is held (⌘ on macOS, Ctrl elsewhere). */
export const hasMod = (e: KeyboardEvent | MouseEvent) => (isMac ? e.metaKey : e.ctrlKey);

const MAC_MOD: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod']; // Apple's order: ⌃⌥⇧⌘
const PC_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'];
const KEY_NAME: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', '-': '−' };

/** `'Mod+Shift+O'` → `⇧⌘O` on macOS, `Ctrl+Shift+O` elsewhere. `Mod` is ⌘ or Ctrl. */
export function keyLabel(combo: string): string {
  const parts = combo.split('+');
  const key = parts.pop()!;
  const name = KEY_NAME[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (isMac) {
    const mods = MAC_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_MOD[m]);
    return mods.join('') + (key === 'Enter' ? '↩' : name);
  }
  const mods = PC_ORDER.filter((m) => parts.includes(m)).map((m) => (m === 'Mod' ? 'Ctrl' : m));
  return [...mods, name].join('+');
}

/** Tooltip text: `Find in document (⌘F)`. */
export const tip = (label: string, ...combos: string[]) => `${label} (${combos.map(keyLabel).join(', ')})`;

/** "Alt" or "Option", for prose such as Alt+double-click. */
export const altName = isMac ? 'Option' : 'Alt';

interface Row { label: string; keys: string[][] } // alternatives, each a list of combos shown together
const SHEET: { title: string; rows: Row[] }[] = [
  {
    title: 'Review',
    rows: [
      { label: 'Comment on selection', keys: [['Mod+Alt+M'], ['C']] },
      { label: 'Comment on a section (heading reached from the outline)', keys: [['C']] },
      { label: 'Mark Major, Minor or Nit (in a comment box)', keys: [['Alt+1'], ['Alt+2'], ['Alt+3']] },
      { label: 'Save a comment or reply', keys: [['Mod+Enter']] },
      { label: 'Reply to the current thread', keys: [['R']] },
      { label: 'Submit review', keys: [['Mod+Shift+Enter']] },
      { label: 'Send to Claude', keys: [['Mod+Alt+Enter']] },
    ],
  },
  {
    title: 'Move around',
    rows: [
      { label: 'Next / previous comment', keys: [['Alt+ArrowDown', 'Alt+ArrowUp'], ['J', 'K']] },
      { label: 'Next / previous change (turns on Changes)', keys: [[']', '[']] },
      { label: 'Find in document', keys: [['Mod+F'], ['/']] },
      { label: 'Next / previous match', keys: [['Enter', 'Shift+Enter']] },
      { label: 'Outline', keys: [['Mod+Shift+O']] },
      { label: 'Comments pane', keys: [['Mod+Alt+P']] },
    ],
  },
  {
    title: 'Edit',
    rows: [
      { label: 'Edit mode on / off', keys: [['E']] },
      { label: 'Save an edit / cancel it', keys: [['Enter', 'Escape']] },
      { label: 'Save raw Markdown (' + (isMac ? 'Option' : 'Alt') + '+double-click)', keys: [['Mod+Enter']] },
      { label: 'Undo edit', keys: [['Mod+Z']] },
      { label: 'Redo edit', keys: isMac ? [['Mod+Shift+Z']] : [['Mod+Y'], ['Mod+Shift+Z']] },
    ],
  },
  {
    title: 'View',
    rows: [
      { label: 'Zoom in / out', keys: [['Mod+=', 'Mod+-']] },
      { label: 'Reset zoom', keys: [['Mod+0']] },
      { label: 'Keyboard shortcuts', keys: [['?']] },
    ],
  },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const kbd = (combo: string) => `<kbd>${esc(keyLabel(combo))}</kbd>`;

export interface ShortcutSheet {
  toggle(): void;
  isOpen(): boolean;
}

/** The `?` sheet: a modal list of every shortcut, closed by Esc, `?`, or a click outside. */
export function createShortcutSheet(el: HTMLElement): ShortcutSheet {
  let returnFocus: HTMLElement | null = null;
  el.innerHTML = `<div class="mdr-keys-card" role="dialog" aria-modal="true" aria-labelledby="mdr-keys-title" tabindex="-1">
    <div class="mdr-pane-head"><span id="mdr-keys-title">Keyboard shortcuts</span><button data-act="close-keys" title="Close (Esc)" aria-label="Close"></button></div>
    <div class="mdr-keys-grid">${SHEET.map(
      (g) => `<section><h3>${g.title}</h3><dl>${g.rows
        .map((r) => `<dt>${esc(r.label)}</dt><dd>${r.keys.map((alt) => alt.map(kbd).join(' ')).join('<span class="mdr-keys-or">or</span>')}</dd>`)
        .join('')}</dl></section>`,
    ).join('')}</div>
  </div>`;
  const card = el.firstElementChild as HTMLElement;

  const setExpanded = (open: boolean) => document.getElementById('mdr-keys-btn')?.setAttribute('aria-expanded', String(open));
  function close() {
    el.hidden = true;
    setExpanded(false);
    returnFocus?.focus();
    returnFocus = null;
  }
  el.addEventListener('click', (e) => {
    if (e.target === el || (e.target as Element).closest('[data-act="close-keys"]')) close();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // one control inside: keep focus in the dialog
      (card.querySelector('button') as HTMLElement).focus();
    }
  });

  return {
    toggle() {
      if (!el.hidden) return close();
      returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      el.hidden = false;
      setExpanded(true);
      card.focus();
    },
    isOpen: () => !el.hidden,
  };
}
