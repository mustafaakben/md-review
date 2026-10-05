import MarkdownIt from 'markdown-it';

export const escapeMessage = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const md = new MarkdownIt({ html: false, breaks: true, linkify: true });
// Comments can come from other people or agents. Do not fetch embedded images.
md.renderer.rules.image = (tokens, i) => escapeMessage(tokens[i].content);
const cache = new Map<string, string>();
export function renderMessageMarkdown(body: string): string {
  const hit = cache.get(body);
  if (hit !== undefined) return hit;
  const html = md.render(body);
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(body, html);
  return html;
}

export interface Message { id: string; author: string; body: string; parentId?: string }
export interface Conversation extends Message { replies: Message[] }
/** Stable depth-first display; stored replies stay in arrival order for agent turn-taking. */
export function orderedReplies<T extends Message>(root: string, replies: T[]): { message: T; depth: number; parentId: string }[] {
  const ids = new Set(replies.map(r => r.id));
  const children = new Map<string, T[]>();
  for (const r of replies) {
    const parent = r.parentId && r.parentId !== r.id && ids.has(r.parentId) ? r.parentId : root;
    const group = children.get(parent) || []; group.push(r); children.set(parent, group);
  }
  const result: { message: T; depth: number; parentId: string }[] = [], seen = new Set<string>();
  const visit = (first: T, depth: number, parentId: string) => {
    const stack = [{ message: first, depth, parentId }];
    while (stack.length) {
      const row = stack.pop()!;
      if (seen.has(row.message.id)) continue;
      seen.add(row.message.id); result.push(row);
      const next = children.get(row.message.id) || [];
      for (let i = next.length - 1; i >= 0; i--) stack.push({ message: next[i], depth: row.depth + 1, parentId: row.message.id });
    }
  };
  for (const r of children.get(root) || []) visit(r, 1, root);
  // Malformed imported cycles must neither disappear nor recurse forever.
  for (const r of replies) if (!seen.has(r.id)) visit(r, 1, root);
  return result;
}

export function messageActions(message: Message, author: string, attr: string, root = false): string {
  return `<div class="mdr-message-actions"><button ${attr}="reply" data-parent="${escapeMessage(message.id)}" aria-label="Reply to ${escapeMessage(message.author)}">Reply</button>${message.author === author ? `<button ${attr}="${root ? 'edit-body' : 'edit-reply'}" data-message="${escapeMessage(message.id)}">Edit</button>` : ''}</div>`;
}
export function replyComposer(c: Conversation, target: string | undefined, attr: string, draft = ''): string {
  if (!target) return '';
  const parent = target === c.id ? c : c.replies.find(r => r.id === target);
  if (!parent) return '';
  return `<div class="mdr-replybox" data-reply-to="${escapeMessage(target)}"><div class="mdr-reply-context">Replying to <b>${escapeMessage(parent.author)}</b><span>${escapeMessage(parent.body.replace(/\s+/g, ' ').slice(0, 100))}</span></div><textarea data-parent="${escapeMessage(target)}" aria-label="Reply to ${escapeMessage(parent.author)}" placeholder="Write a reply…">${escapeMessage(draft)}</textarea><div class="mdr-row"><button ${attr}="send" class="mdr-primary">Save reply</button><button ${attr}="cancel-reply">Cancel</button></div></div>`;
}

export function editMessageComposer(message: Message, attr: string): string {
  return `<div class="mdr-replybox"><label>Edit message (Markdown)<textarea class="mdr-message-edit" data-message="${escapeMessage(message.id)}">${escapeMessage(message.body)}</textarea></label><div class="mdr-row"><button ${attr}="save-message" class="mdr-primary">Save</button><button ${attr}="cancel-message">Cancel</button></div></div>`;
}

export function parentLabel(c: Conversation, parentId: string): string {
  const p = parentId === c.id ? c : c.replies.find(r => r.id === parentId);
  return p ? `<div class="mdr-message-parent" title="${escapeMessage(p.body.replace(/\s+/g, ' ').slice(0, 160))}">↳ Reply to ${escapeMessage(p.author)}</div>` : '';
}

/** Scroll only the review surface, never the surrounding document. */
export function revealComposer(container: HTMLElement, selector = '.mdr-replybox textarea') {
  const ta = container.querySelector<HTMLTextAreaElement>(selector);
  if (!ta) return;
  ta.focus({ preventScroll: true });
  let scroller: HTMLElement | null = ta.parentElement;
  while (scroller && scroller !== document.body) {
    if (/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
      const box = scroller.getBoundingClientRect(), r = ta.getBoundingClientRect();
      if (r.bottom > box.bottom - 40) scroller.scrollTop += r.bottom - box.bottom + 40;
      else if (r.top < box.top + 12) scroller.scrollTop += r.top - box.top - 12;
      break;
    }
    scroller = scroller.parentElement;
  }
}
