// "Review with Claude": the toolbar menu of reviewers. The host sends the list
// when the menu opens (built-ins plus .mdreview/reviewers/*.md), so nothing is
// read until someone asks. Picking one starts Claude as first reviewer.

export interface Reviewer { id: string; label: string }

export interface ReviewMenu {
  setReviewers(list: Reviewer[]): void;
  toggle(focus?: boolean): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createReviewMenu(button: HTMLElement, panel: HTMLElement, post: (m: unknown) => void, started: () => void): ReviewMenu {
  let focusFirst = false;

  function items(): HTMLButtonElement[] {
    return Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  }

  function render(list: Reviewer[] | null) {
    const builtIn = (list || []).filter((r) => !r.id.startsWith('file:'));
    const mine = (list || []).filter((r) => r.id.startsWith('file:'));
    const item = (r: Reviewer) => `<button role="menuitem" tabindex="-1" data-reviewer="${esc(r.id)}">${esc(r.label)}</button>`;
    panel.innerHTML = `
      <div class="mdr-rv-note">Claude reads the document and leaves draft comments. You keep, act on, or dismiss each one.</div>
      <div class="mdr-rv-list" role="menu" aria-label="Reviewers">${
        list
          ? builtIn.map(item).join('') +
            (mine.length ? `<div class="mdr-rv-label" role="presentation">This workspace</div>${mine.map(item).join('')}` : '') +
            `<button role="menuitem" tabindex="-1" data-reviewer="custom" aria-expanded="false">Custom…</button>`
          : '<div class="mdr-rv-label" role="presentation">Loading…</div>'
      }</div>
      <form class="mdr-rv-custom" hidden>
        <input type="text" maxlength="500" aria-label="What should Claude look for?" placeholder="What should Claude look for?">
        <button type="submit" class="mdr-primary">Start</button>
      </form>`;
    const first = items()[0];
    if (first) first.tabIndex = 0;
    if (focusFirst && first) {
      focusFirst = false;
      first.focus();
    }
  }

  function close(returnFocus: boolean) {
    if (panel.hidden) return;
    const inside = panel.contains(document.activeElement);
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus || inside) button.focus();
  }

  function open(focus: boolean) {
    render(null);
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // Line the menu up under the button, inside the window.
    const r = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${r.bottom + 6}px`;
    focusFirst = focus;
    post({ type: 'listReviewers' });
  }

  function start(id: string, instruction?: string) {
    post({ type: 'startReview', preset: id, instruction });
    close(true);
    started();
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    api.toggle(e.detail === 0);
  });
  panel.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = (e.target as Element).closest<HTMLElement>('[data-reviewer]');
    if (!b) return;
    if (b.dataset.reviewer !== 'custom') return start(b.dataset.reviewer!);
    const form = panel.querySelector('.mdr-rv-custom') as HTMLElement;
    form.hidden = false;
    b.setAttribute('aria-expanded', 'true');
    (form.querySelector('input') as HTMLInputElement).focus();
  });
  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = panel.querySelector('.mdr-rv-custom input') as HTMLInputElement;
    const text = input.value.trim();
    if (text) start('custom', text);
    else input.focus();
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return close(true);
    }
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || !/^(ArrowUp|ArrowDown|Home|End)$/.test(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list.forEach((b, k) => (b.tabIndex = k === next ? 0 : -1));
    list[next].focus();
  });
  // Tabbing or clicking out of the menu closes it.
  panel.addEventListener('focusout', (e) => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (to && !panel.contains(to) && to !== button) close(false);
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node)) close(false);
  });
  document.addEventListener('keydown', (e) => {
    // Escape in a text field belongs to that field.
    const t = e.target as HTMLElement;
    if (e.key === 'Escape' && !panel.hidden && !(t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) close(true);
  });

  const api: ReviewMenu = {
    setReviewers(list) {
      if (!panel.hidden) render(list);
    },
    toggle(focus = true) {
      if (panel.hidden) open(focus);
      else close(focus);
    },
  };
  return api;
}
