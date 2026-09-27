// A thread beside its passage, without changing the document's width.
interface Thread {
  id: string; author: string; body: string; status: string;
  anchor: { quote: string };
  replies: { author: string; body: string }[];
}
interface Options {
  get(id: string): Thread | undefined;
  rect(id: string): DOMRect | null;
  reply(id: string, body: string): void;
  resolve(id: string, status: 'resolved' | 'submitted'): void;
  sidebar(id: string): void;
  edit(id: string): void;
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function createThreadPopover(options: Options) {
  const el = document.createElement('aside');
  el.className = 'mdr-thread-popover mdr-ui'; el.hidden = true;
  el.setAttribute('aria-label', 'Comment thread');
  document.body.appendChild(el);
  let id: string | null = null;
  let pinned = false;
  let composing = false;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let returnFocus: HTMLElement | null = null;
  const drafts = new Map<string, string>();
  function remember() { const ta = el.querySelector('textarea'); if (id && ta) drafts.set(id, ta.value); }
  function place() {
    if (!id || el.hidden) return;
    const r = options.rect(id);
    if (!r || r.bottom < 56 || r.top > innerHeight) { if (!pinned) close(); return; }
    const width = Math.min(350, innerWidth - 24);
    el.style.width = `${width}px`;
    el.style.left = `${Math.max(12, Math.min(r.left, innerWidth - width - 12))}px`;
    const below = r.bottom + 9;
    const height = el.offsetHeight;
    el.style.top = `${Math.max(64, Math.min(below + height <= innerHeight - 12 ? below : r.top - height - 9, innerHeight - height - 12))}px`;
  }
  function render() {
    const c = id && options.get(id); if (!c) return close();
    remember();
    const focused = el.querySelector('textarea') === document.activeElement;
    const cursor = el.querySelector('textarea')?.selectionStart;
    el.setAttribute('role', pinned ? 'dialog' : 'tooltip');
    el.classList.toggle('preview', !pinned);
    el.innerHTML = `<header><strong>${esc(c.author)}</strong><span class="mdr-thread-state">${esc(c.status)}</span>${pinned ? '<button data-thread-action="close" aria-label="Close comment" title="Close comment"></button>' : ''}</header>
      <blockquote>${esc(c.anchor.quote)}</blockquote><div class="mdr-thread-copy">${esc(c.body)}</div>
      ${pinned && c.replies.length ? `<div class="mdr-thread-replies">${c.replies.map(r => `<div><strong>${esc(r.author)}</strong><p>${esc(r.body)}</p></div>`).join('')}</div>` : ''}
      ${pinned ? `<div class="mdr-thread-actions"><button data-thread-action="reply">Reply</button><button data-thread-action="resolve">${c.status === 'resolved' ? 'Reopen' : 'Resolve'}</button><button data-thread-action="edit">Edit passage</button></div>
      ${composing ? `<textarea aria-label="Reply to comment" placeholder="Write a reply…">${esc(drafts.get(c.id) || '')}</textarea><button class="mdr-primary" data-thread-action="send">Save reply</button>` : ''}
      <footer><button data-thread-action="sidebar">Open in review pane</button></footer>` : '<footer>Click the passage to open this thread</footer>'}`;
    el.hidden = false;
    if (focused) { const ta = el.querySelector('textarea'); ta?.focus({ preventScroll: true }); if (cursor !== undefined) ta?.setSelectionRange(cursor, cursor); }
    place();
  }
  function close(focus = false) {
    clearTimeout(hoverTimer); clearTimeout(leaveTimer); remember();
    el.hidden = true; id = null; pinned = false; composing = false;
    if (focus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function show(next: string, pin: boolean, keyboard = false) {
    clearTimeout(hoverTimer); clearTimeout(leaveTimer);
    if (pinned && !pin) return;
    if (id !== next) { remember(); composing = false; }
    if (pin && !pinned) returnFocus = document.activeElement as HTMLElement;
    id = next; pinned = pin; render();
    if (keyboard) el.querySelector<HTMLButtonElement>('[data-thread-action="close"]')?.focus({ preventScroll: true });
  }
  function send() {
    const ta = el.querySelector('textarea'); const body = ta?.value.trim();
    if (!id || !body) return;
    drafts.delete(id); if (ta) ta.value = ''; composing = false;
    options.reply(id, body); render();
  }
  el.addEventListener('click', e => {
    const action = (e.target as Element).closest('[data-thread-action]')?.getAttribute('data-thread-action');
    if (!id) return;
    if (action === 'close') close(true);
    if (action === 'reply') { composing = true; render(); el.querySelector('textarea')?.focus({ preventScroll: true }); }
    if (action === 'send') send();
    if (action === 'resolve') options.resolve(id, options.get(id)?.status === 'resolved' ? 'submitted' : 'resolved');
    if (action === 'sidebar') { const next = id; close(); options.sidebar(next); }
    if (action === 'edit') { const next = id; close(); options.edit(next); }
  });
  el.addEventListener('mouseenter', () => clearTimeout(leaveTimer));
  el.addEventListener('mouseleave', () => { if (!pinned) leaveTimer = setTimeout(() => close(), 180); });
  el.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
  });
  document.addEventListener('keydown', e => {
    if (el.hidden || e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation(); close(true);
  }, true);
  document.addEventListener('pointerdown', e => {
    if (!el.hidden && !el.contains(e.target as Node) && !(e.target as Element).closest('[data-thread], .mdr-hl')) close();
  });
  window.addEventListener('scroll', place, { passive: true });
  window.addEventListener('resize', place);
  return {
    show, close,
    refresh() { if (id) render(); },
    hover(next: string | null) {
      clearTimeout(hoverTimer); clearTimeout(leaveTimer);
      if (pinned) return;
      if (next) hoverTimer = setTimeout(() => show(next, false), 300);
      else leaveTimer = setTimeout(() => close(), 180);
    },
  };
}
