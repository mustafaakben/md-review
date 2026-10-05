import type { Comment } from './commentTypes';
import { isAgentDraft } from './filters';
import { isWorking } from './round';
import { suggestionBlock } from './suggest';
import { metaPicker, metaBadges } from './commentMeta';
import { keyLabel } from './keys';
import { renderMessageMarkdown, orderedReplies, messageActions, replyComposer, editMessageComposer, parentLabel } from './messageContent';
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const altDigit = (n: number) => keyLabel(`Alt+${n}`);
export interface CardContext {
  author: string; activeId: string | null; orphan: boolean; openSuggestion: string | null;
  answered: boolean; replyTarget?: string; replyDraft?: string; editingReply?: string; editing: boolean; agentName: string; statusLabel: string;
  fmt(iso: string): string;
}
export function renderThreadCard(c: Comment, ctx: CardContext, now = Date.now()): string {
  const { author, activeId, fmt, agentName } = ctx;
  const open = ctx.orphan ? null : ctx.openSuggestion; // no text to apply it to
  const replyBox = replyComposer(c, ctx.replyTarget, 'data-act', ctx.replyDraft);
  const replies = orderedReplies(c.id, c.replies)
    .map(({ message: r, depth, parentId }) => `<div class="mdr-reply mdr-message" data-message-id="${esc(r.id)}" data-parent-id="${esc(parentId)}" style="--reply-depth:${Math.min(depth - 1, 3)}">${parentLabel(c, parentId)}<div class="mdr-meta"><b>${esc(r.author)}</b> · ${fmt(r.createdAt)}</div>${ctx.editingReply === r.id ? editMessageComposer(r, 'data-act') : `<div class="mdr-body mdr-message-markdown">${renderMessageMarkdown(r.body)}</div>`}${r.suggestion ? suggestionBlock(c.anchor.quote, r.suggestion, r.id, r.author, open === r.id) : ''}${messageActions(r, author, 'data-act')}${ctx.replyTarget === r.id ? replyBox : ''}</div>`)
    .join('');
  const agent = isAgentDraft(c);
  const actions = agent
    ? [
        `<button data-act="keep" title="Make this your draft; it goes out with your review">Keep</button>`,
        `<button data-act="do-it" title="Keep it and queue it for ${esc(agentName)}; Send to ${esc(agentName)} hands over everything queued" aria-label="Do it: keep and queue for ${esc(agentName)}">Do it</button>`,
        `<button data-act="dismiss-agent" class="danger" title="Delete this comment from ${esc(c.author)}" aria-label="Discard ${esc(c.author)}'s comment">Discard</button>`,
      ].join('')
    : [
    c.status === 'resolved' ? `<button data-act="reopen">Reopen</button>` : `<button data-act="resolve">Resolve</button>`,
    c.status !== 'resolved' ? `<button data-act="ask-claude" title="Send just this thread to ${esc(agentName)}">Ask ${esc(agentName)}</button>` : '',
    ctx.answered ? `<button data-act="show-change" title="Show what changed in this thread's text since you sent it">Show change</button>` : '',
    `<button data-act="delete" class="danger" title="${c.status === 'draft' ? 'Delete this draft' : 'Delete this thread and its replies'}">Delete</button>`,
  ].join('');
  const lines = c.anchor.lineStart ? `L${c.anchor.lineStart}${c.anchor.lineEnd > c.anchor.lineStart ? '–' + c.anchor.lineEnd : ''}` : '';
  const working = isWorking(c, now);
  const by = c.suggestedBy ? ` <span class="mdr-by">· raised by ${esc(c.suggestedBy)}</span>` : '';
  return `<div class="mdr-card ${c.status}${agent ? ' mdr-agent' : ''}${c.id === activeId ? ' active' : ''}${ctx.orphan ? ' orphan' : ''}${working ? ' mdr-working' : ''}" data-id="${c.id}">
    <div class="mdr-meta"><span class="mdr-badge ${agent ? 'agent' : c.status}">${agent ? 'suggested' : ctx.statusLabel}</span><b>${esc(c.author)}</b>${by} · ${fmt(c.createdAt)}<span class="mdr-lines">${c.scope === 'document' ? '' : lines}</span></div>
    ${metaBadges(c) ? `<div class="mdr-tags">${metaBadges(c)}</div>` : ''}
    ${c.scope === 'document' ? '' : `<blockquote class="mdr-quote" data-act="goto" title="Go to text">${esc(c.anchor.quote.length > 180 ? c.anchor.quote.slice(0, 180) + '…' : c.anchor.quote)}</blockquote>`}
    ${ctx.editing
      ? `<div class="mdr-replybox">${metaPicker(c, altDigit)}<textarea class="mdr-body-edit">${esc(c.body)}</textarea><div class="mdr-row"><button data-act="save-body" class="mdr-primary">Save</button><button data-act="cancel-body">Cancel</button></div></div>`
      : `<div class="mdr-body mdr-message-markdown" data-message-id="${esc(c.id)}">${renderMessageMarkdown(c.body)}</div>`}
    ${c.suggestion ? suggestionBlock(c.anchor.quote, c.suggestion, '', c.suggestedBy || (c.author === author ? 'You' : c.author), open === '') : ''}
    ${agent ? '' : messageActions(c, author, 'data-act', true)}
    ${ctx.replyTarget === c.id ? replyBox : ''}
    ${replies ? `<div class="mdr-replies">${replies}</div>` : ''}
    ${working ? `<div class="mdr-working-line"><span class="mdr-round-dot live" aria-hidden="true"></span>${esc(ctx.statusLabel)} on this…</div>` : ''}
    <div class="mdr-actions">${actions}</div>
  </div>`;
}
