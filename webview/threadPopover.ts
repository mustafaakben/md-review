// A movable conversation beside its passage, without changing document layout.
import { isSaveReply, isSendThread } from './commands';
import { isMac } from './keys';
import { popupPosition } from './commentComposer';
import { clampPopup, resizePopup, type PopupBox } from './popupGeometry';
import { escapeMessage as esc, renderMessageMarkdown, orderedReplies, messageActions, replyComposer, editMessageComposer, parentLabel, revealComposer, type Conversation } from './messageContent';
interface Thread extends Conversation {
  status: string;
  anchor: { quote: string };
}
interface Options {
  get(id: string): Thread | undefined;
  rect(id: string): DOMRect | null;
  reply(id: string, body: string, parentId?: string): void;
  editMessage(id: string, messageId: string, body: string): void;
  author(): string;
  openLink(href: string): void;
  resolve(id: string, status: 'resolved' | 'submitted'): void;
  sidebar(id: string): void;
  edit(id: string): void;
  delete(id: string, button: HTMLButtonElement): void;
  status(id: string): string;
  agentName(): string;
  sendThread(id: string): void;
}
export function createThreadPopover(options: Options) {
  const el = document.createElement('aside');
  el.className = 'mdr-thread-popover mdr-ui'; el.hidden = true;
  el.setAttribute('aria-label', 'Comment thread');
  document.body.appendChild(el);
  let id: string | null = null, composing: string | undefined, editing: string | undefined;
  let pinned = false;
  let customBox: PopupBox | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined, leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let returnFocus: HTMLElement | null = null;
  const drafts = new Map<string, string>();
  const draftKey = (ta: HTMLTextAreaElement) => `${id}:${ta.dataset.parent ? 'reply:' + ta.dataset.parent : 'edit:' + ta.dataset.message}`;
  function remember() { const ta = el.querySelector('textarea'); if (id && ta) drafts.set(draftKey(ta), ta.value); }
  function useBox(box: PopupBox) {
    Object.assign(el.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' });
  }
  function place() {
    if (!id || el.hidden) return;
    if (pinned && customBox) { customBox = clampPopup(customBox, document.documentElement.clientWidth, innerHeight); useBox(customBox); return; }
    const r = options.rect(id);
    if (!r || r.bottom < 56 || r.top > innerHeight) { close(); return; }
    const available = document.documentElement.clientWidth;
    const width = Math.min(380, available - 24);
    el.style.width = `${width}px`; el.style.height = '';
    const height = el.offsetHeight, below = r.bottom + 9;
    const pos = popupPosition(r.left, below + height <= innerHeight - 12 ? below : r.top - height - 9, width, height, available, innerHeight);
    el.style.left = `${pos.left}px`; el.style.top = `${pos.top}px`;
  }
  function render() {
    const c = id && options.get(id); if (!c) return close();
    remember();
    const oldTa = el.querySelector('textarea');
    const focused = oldTa === document.activeElement;
    const oldKey = oldTa && draftKey(oldTa), start = oldTa?.selectionStart, end = oldTa?.selectionEnd;
    const scrollTop = el.querySelector('.mdr-thread-scroll')?.scrollTop || 0;
    const wasOpen = !el.hidden;
    el.setAttribute('role', pinned ? 'dialog' : 'tooltip');
    el.classList.toggle('preview', !pinned);
    const composer = replyComposer(c, composing, 'data-thread-action', drafts.get(`${id}:reply:${composing}`));
    const content = (message: Conversation | Conversation['replies'][number]) => editing === message.id
      ? editMessageComposer({ ...message, body: drafts.get(`${id}:edit:${message.id}`) ?? message.body }, 'data-thread-action')
      : `<div class="mdr-thread-copy mdr-message-markdown">${renderMessageMarkdown(message.body)}</div>`;
    el.innerHTML = `<header title="Drag to move this comment window"><strong>${esc(c.author)}</strong><span class="mdr-thread-state">${esc(options.status(c.id))}</span>${pinned ? '<button data-thread-action="close" aria-label="Close comment" title="Close comment"></button>' : ''}</header><div class="mdr-thread-scroll">
      <blockquote class="mdr-thread-anchor">${esc(c.anchor.quote)}</blockquote><div data-message-id="${esc(c.id)}">${content(c)}${pinned ? messageActions(c, options.author(), 'data-thread-action', true) : ''}${composing === c.id ? composer : ''}</div>
      ${pinned && c.replies.length ? `<div class="mdr-thread-replies">${orderedReplies(c.id, c.replies).map(({ message: r, depth, parentId }) => `<div class="mdr-message" data-message-id="${esc(r.id)}" data-parent-id="${esc(parentId)}" style="--reply-depth:${Math.min(depth - 1, 3)}">${parentLabel(c, parentId)}<strong>${esc(r.author)}</strong>${content(r)}${messageActions(r, options.author(), 'data-thread-action')}${composing === r.id ? composer : ''}</div>`).join('')}</div>` : ''}
      ${pinned ? `<div class="mdr-thread-actions">${c.status !== 'resolved' ? `<button class="mdr-primary" data-thread-action="send-thread" title="Send this thread only">Send to ${esc(options.agentName())}</button>` : ''}<button data-thread-action="resolve">${c.status === 'resolved' ? 'Reopen' : 'Resolve'}</button><button data-thread-action="edit">Edit passage</button></div>
      <footer><button data-thread-action="sidebar">Open in review pane</button><button data-thread-action="reset-window">Reset window</button><button class="danger" data-thread-action="delete" title="Delete this thread and its replies">Delete thread</button></footer>` : '<footer>Click the passage to open this thread</footer>'}</div>
      ${pinned ? ['n','e','s','w','ne','se','sw','nw'].map(edge => `<div class="mdr-resize-handle mdr-resize-${edge}" data-resize="${edge}" role="separator" tabindex="0" aria-label="Resize comment ${edge}" title="Drag to resize"></div>`).join('') : ''}`;
    el.hidden = false;
    const scroll = el.querySelector('.mdr-thread-scroll'); if (scroll) scroll.scrollTop = scrollTop;
    const ta = el.querySelector('textarea');
    if (focused && ta && draftKey(ta) === oldKey) { ta.focus({ preventScroll: true }); ta.setSelectionRange(start ?? 0, end ?? 0); }
    // A new message or composer must not reposition an open floating window.
    if (!wasOpen || customBox) place();
  }
  function close(focus = false) {
    clearTimeout(hoverTimer); clearTimeout(leaveTimer); remember();
    el.hidden = true; id = null; pinned = false; composing = undefined; editing = undefined;
    if (focus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function show(next: string, pin: boolean, keyboard = false) {
    clearTimeout(hoverTimer); clearTimeout(leaveTimer);
    if (pinned && !pin) return;
    if (id !== next) { remember(); composing = undefined; editing = undefined; el.replaceChildren(); el.hidden = true; }
    if (pin && !pinned) returnFocus = document.activeElement as HTMLElement;
    id = next; pinned = pin; render();
    if (keyboard) el.querySelector<HTMLButtonElement>('[data-thread-action="close"]')?.focus({ preventScroll: true });
  }
  function send() {
    const ta = el.querySelector<HTMLTextAreaElement>('textarea[data-parent]'), body = ta?.value.trim();
    if (!id || !body || !ta) return;
    const parent = ta.dataset.parent;
    drafts.delete(draftKey(ta)); ta.value = ''; composing = undefined;
    options.reply(id, body, parent); render();
  }
  function saveEdit() {
    const ta = el.querySelector<HTMLTextAreaElement>('.mdr-message-edit'), body = ta?.value.trim();
    if (!id || !body || !ta?.dataset.message) return;
    drafts.delete(draftKey(ta)); const target = ta.dataset.message; ta.remove(); editing = undefined;
    options.editMessage(id, target, body); render();
  }
  el.addEventListener('input', remember);
  el.addEventListener('click', e => {
    const target = e.target as Element, button = target.closest<HTMLElement>('[data-thread-action]'), action = button?.dataset.threadAction;
    if (!id) return;
    const link = target.closest<HTMLAnchorElement>('.mdr-message-markdown a');
    if (link) { e.preventDefault(); options.openLink(link.getAttribute('href') || ''); return; }
    if (action === 'send-thread') { const threadId = id; close(); options.sendThread(threadId); return; }
    if (action === 'close') close(true);
    if (action === 'reply') { remember(); composing = button?.dataset.parent || id; editing = undefined; render(); revealComposer(el); }
    if (action === 'cancel-reply') { remember(); composing = undefined; render(); }
    if (action === 'edit-body' || action === 'edit-reply') { remember(); editing = button?.dataset.message || id; composing = undefined; render(); revealComposer(el, '.mdr-message-edit'); }
    if (action === 'cancel-message') { editing = undefined; render(); }
    if (action === 'save-message') saveEdit();
    if (action === 'send') send();
    if (action === 'delete') options.delete(id, target.closest('button')!);
    if (action === 'resolve') options.resolve(id, options.get(id)?.status === 'resolved' ? 'submitted' : 'resolved');
    if (action === 'sidebar') { const next = id; close(); options.sidebar(next); }
    if (action === 'edit') { const next = id; close(); options.edit(next); }
    if (action === 'reset-window') { customBox = null; place(); }
  });
  el.addEventListener('pointerdown', e => {
    const target = e.target as Element, edge = target.closest<HTMLElement>('[data-resize]')?.dataset.resize;
    if (!pinned || e.button !== 0 || (!edge && (!target.closest('header') || target.closest('button')))) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(), original = { left: r.left, top: r.top, width: r.width, height: r.height };
    const x = e.clientX, y = e.clientY;
    el.setPointerCapture(e.pointerId); el.classList.add('mdr-window-moving');
    const move = (event: PointerEvent) => {
      customBox = edge ? resizePopup(original, edge, event.clientX - x, event.clientY - y, document.documentElement.clientWidth, innerHeight)
        : clampPopup({ ...original, left: original.left + event.clientX - x, top: original.top + event.clientY - y }, document.documentElement.clientWidth, innerHeight);
      useBox(customBox);
    };
    const end = () => { el.classList.remove('mdr-window-moving'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  });
  el.addEventListener('mouseenter', () => clearTimeout(leaveTimer));
  el.addEventListener('mouseleave', () => { if (!pinned) leaveTimer = setTimeout(() => close(), 180); });
  el.addEventListener('keydown', e => {
    const edge = (e.target as HTMLElement).dataset.resize;
    if (edge && /^Arrow/.test(e.key)) {
      e.preventDefault(); const r = el.getBoundingClientRect();
      customBox = resizePopup({ left: r.left, top: r.top, width: r.width, height: r.height }, edge, e.key === 'ArrowRight' ? 10 : e.key === 'ArrowLeft' ? -10 : 0, e.key === 'ArrowDown' ? 10 : e.key === 'ArrowUp' ? -10 : 0, document.documentElement.clientWidth, innerHeight); useBox(customBox);
    }
    if (isSaveReply(e, isMac)) { e.preventDefault(); e.stopPropagation(); if (editing) saveEdit(); else send(); }
    // Send the thread, with whatever is being written in it saved first (the reply or the edit).
    // Stopping it here keeps VS Code's Cmd+Shift+Enter (Submit review) from also running.
    if (isSendThread(e, isMac) && id && pinned) {
      e.preventDefault(); e.stopPropagation();
      if (editing) saveEdit(); else send();
      if (options.get(id)?.status === 'resolved') return;
      const threadId = id; close(); options.sendThread(threadId);
    }
  });
  document.addEventListener('keydown', e => { if (el.hidden || e.key !== 'Escape') return; e.preventDefault(); e.stopPropagation(); close(true); }, true);
  // An open thread takes Cmd+Shift+Enter even when focus stayed in the document (a click on a
  // highlight doesn't move it). Inside the window the handler above runs; another text box keeps its own.
  document.addEventListener('keydown', e => {
    if (el.hidden || !pinned || !id || !isSendThread(e, isMac)) return;
    const t = e.target as HTMLElement;
    if (el.contains(t) || (/^(INPUT|TEXTAREA)$/.test(t.tagName) && !t.closest('#mdr-canvas'))) return;
    if (options.get(id)?.status === 'resolved') return;
    e.preventDefault(); e.stopPropagation();
    const threadId = id; close(); options.sendThread(threadId);
  }, true);
  document.addEventListener('pointerdown', e => { if (!el.hidden && !el.contains(e.target as Node) && !(e.target as Element).closest('[data-thread], .mdr-hl')) close(); });
  window.addEventListener('scroll', place, { passive: true }); window.addEventListener('resize', place);
  return { show, close, refresh() { if (id) render(); }, hover(next: string | null, immediate = false) {
    clearTimeout(hoverTimer); clearTimeout(leaveTimer); if (pinned) return;
    if (!next && immediate) return close();
    if (next) hoverTimer = setTimeout(() => show(next, false), 300); else leaveTimer = setTimeout(() => close(), 180);
  } };
}
