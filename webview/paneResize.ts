/** Draggable pane edges. Preferred widths survive collapse and temporary narrow layouts. */
export function createPaneResize(options: {
  saved?: { outline?: number; sidebar?: number };
  save: (widths: { outline?: number; sidebar?: number }) => void;
  keepReadingPlace: () => (() => void) | null;
}) {
  type Pane = 'outline' | 'sidebar';
  const root = document.documentElement;
  const layout = document.querySelector<HTMLElement>('.mdr-layout')!;
  const panes = {
    outline: document.getElementById('mdr-outline')!,
    sidebar: document.querySelector<HTMLElement>('.mdr-sidebar')!,
  };
  const preferred: { outline?: number; sidebar?: number } = {};
  for (const name of ['outline', 'sidebar'] as const) {
    const value = options.saved?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) preferred[name] = value;
  }
  const minimum = { outline: 180, sidebar: 240 };
  const maximum = { outline: 480, sidebar: 560 };
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const visible = (name: Pane) => !document.body.classList.contains(name === 'outline' ? 'mdr-outline-closed' : 'mdr-side-collapsed');
  const floating = () => window.innerWidth <= 1000;
  const stacked = () => window.innerWidth <= 680;
  const width = (name: Pane) => panes[name].getBoundingClientRect().width;
  const limit = (name: Pane) => {
    if (name === 'outline' && floating()) return Math.max(minimum.outline, Math.min(maximum.outline, root.clientWidth - 40));
    const other = name === 'outline' ? 'sidebar' : 'outline';
    const occupied = visible(other) && !(other === 'outline' && floating()) ? width(other) : 0;
    return Math.max(minimum[name], Math.min(maximum[name], layout.clientWidth - occupied - 320));
  };
  const handles = {} as Record<Pane, HTMLDivElement>;
  let drag: { name: Pane; id: number; x: number; width: number; restore: (() => void) | null } | null = null;

  function place() {
    for (const name of ['outline', 'sidebar'] as const) {
      const rect = panes[name].getBoundingClientRect();
      const handle = handles[name];
      handle.style.left = `${name === 'outline' ? rect.right : rect.left}px`;
      handle.setAttribute('aria-valuenow', String(Math.round(rect.width)));
      handle.setAttribute('aria-valuemax', String(Math.round(limit(name))));
    }
  }

  function setWidth(name: Pane, value: number) {
    preferred[name] = clamp(value, minimum[name], limit(name));
    root.style.setProperty(`--${name}-w`, `${preferred[name]}px`);
    if (name === 'outline') root.style.setProperty('--outline-drawer-w', `${preferred[name]}px`);
    place();
  }

  function finish() {
    if (!drag) return;
    const previous = drag;
    drag = null;
    root.classList.remove('mdr-resizing');
    handles[previous.name].classList.remove('mdr-resize-active');
    if (handles[previous.name].hasPointerCapture(previous.id)) handles[previous.name].releasePointerCapture(previous.id);
    options.save({ ...preferred });
    previous.restore?.();
  }

  for (const name of ['outline', 'sidebar'] as const) {
    const handle = document.createElement('div');
    handles[name] = handle;
    handle.className = `mdr-pane-resize mdr-resize-${name}`;
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize ${name === 'outline' ? 'outline' : 'comments'} pane`);
    if (!panes[name].id) panes[name].id = 'mdr-sidebar';
    handle.setAttribute('aria-controls', panes[name].id);
    handle.setAttribute('aria-valuemin', String(minimum[name]));
    handle.title = 'Drag to resize; use Left and Right arrow keys when focused';
    layout.parentElement!.append(handle);
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || drag) return;
      event.preventDefault();
      drag = { name, id: event.pointerId, x: event.clientX, width: width(name), restore: options.keepReadingPlace() };
      handle.setPointerCapture(event.pointerId);
      root.classList.add('mdr-resizing');
      handle.classList.add('mdr-resize-active');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      const delta = (event.clientX - drag.x) * (name === 'outline' ? 1 : -1);
      setWidth(name, drag.width + delta);
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const restore = options.keepReadingPlace();
      const step = (event.shiftKey ? 40 : 10) * (name === 'outline' ? 1 : -1);
      const next = event.key === 'Home' ? minimum[name] : event.key === 'End' ? limit(name) : width(name) + (event.key === 'ArrowRight' ? step : -step);
      setWidth(name, next);
      options.save({ ...preferred });
      restore?.();
    });
  }

  function fit() {
    // Let CSS supply the breakpoint defaults before applying the user's preferences.
    root.style.removeProperty('--outline-w');
    root.style.removeProperty('--sidebar-w');
    root.style.removeProperty('--outline-drawer-w');
    const defaults = getComputedStyle(root);
    let outline = clamp(preferred.outline ?? parseFloat(defaults.getPropertyValue('--outline-w')), 180, 480);
    const sidebar = clamp(preferred.sidebar ?? parseFloat(defaults.getPropertyValue('--sidebar-w')), 240, 560);
    if (!floating() && visible('outline') && visible('sidebar')) {
      outline = Math.max(180, Math.min(outline, layout.clientWidth - sidebar - 320));
    }
    root.style.setProperty('--outline-w', `${outline}px`);
    if (preferred.outline !== undefined) root.style.setProperty('--outline-drawer-w', `${clamp(preferred.outline, 180, Math.min(480, root.clientWidth - 40))}px`);
    if (!stacked()) root.style.setProperty('--sidebar-w', `${Math.min(sidebar, limit('sidebar'))}px`);
    place();
  }
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (drag) place(); else fit(); });
  };
  new ResizeObserver(schedule).observe(layout);
  new MutationObserver(() => { finish(); schedule(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', () => { finish(); schedule(); });
  window.addEventListener('blur', finish);
  fit();
}
