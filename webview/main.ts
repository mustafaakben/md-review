import { buildTextMap, capture, locate, wrapRanges, unwrap, Captured } from './anchor';
import { createSearch } from './search';
import { createOutline } from './outline';
import { createDiagrams } from './diagrams';
import { createReading, ReadingPrefs } from './reading';
import { passes, authorsOf, filterBar, FilterState, StatusFilter } from './filters';
import { isMac, hasMod, keyLabel, tip, altName, createShortcutSheet } from './keys';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();

type Status = 'draft' | 'submitted' | 'resolved';
interface Reply { id: string; author: string; createdAt: string; body: string }
interface Comment {
  id: string; author: string; createdAt: string; body: string; status: Status;
  submittedAt: string | null; resolvedAt: string | null; replies: Reply[];
  anchor: { quote: string; prefix: string; suffix: string; lineStart: number; lineEnd: number };
}

// ---------------------------------------------------------------- state
let html = '';
let fileName = '';
let comments: Comment[] = [];
let author = '';
let showResolved = true;
let activeId: string | null = null;
let pendingAnchor: (Captured & { lineStart: number; lineEnd: number }) | null = null;
let editing: { ls: number; le: number; original: string; el: HTMLElement; box: HTMLElement } | null = null;
let deferredPaint = false;
// What the document currently shows, so comment changes can patch highlights
// instead of re-rendering: the text of the painted HTML, and the highlighted
// comments in wrap order with their status. `docStale` means the DOM may no
// longer match `html` (an in-view edit touched it); the next paint is full.
let painted: Map<string, { status: Status; start: number; end: number }> | null = null;
let paintedText = '';
let docStale = false;
/** The task checkbox to refocus after the repaint its click causes. */
let focusTask: string | null = null;
const anchorCache = new Map<string, [number, number] | null>(); // valid for paintedText
const positions = new Map<string, number>(); // comment id -> text offset (for ordering)
const orphans = new Set<string>();
const openReplies = new Set<string>();
const editingBodies = new Set<string>();
const saved = vscode.getState() || {};
const filter: FilterState = { status: saved.filterStatus || 'all', author: saved.filterAuthor || '' };
let navOrder: string[] = []; // visible, anchored thread ids in document order
// The browser harness has no VS Code keybindings, so the view handles those keys itself.
const standalone = !!(window as any).__mdrStandalone;

// ---------------------------------------------------------------- DOM
const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="mdr-toolbar mdr-ui">
    <div class="mdr-title"><button id="mdr-outline-toggle" class="mdr-icon-btn" title="${tip('Outline', 'Mod+Shift+O')}" aria-label="Toggle outline" aria-controls="mdr-outline" aria-expanded="false"></button><span class="mdr-file"></span><span class="mdr-counts"></span></div>
    <div class="mdr-tools">
      <span class="mdr-history"><button id="mdr-undo" class="mdr-icon-btn" title="${tip('Undo edit', 'Mod+Z')}" aria-label="Undo edit" disabled></button><button id="mdr-redo" class="mdr-icon-btn" title="${tip('Redo edit', isMac ? 'Mod+Shift+Z' : 'Mod+Y')}" aria-label="Redo edit" disabled></button></span>
      <button id="mdr-reading-btn" class="mdr-icon-btn mdr-reading-btn" title="Reading view: theme, font, and zoom" aria-label="Reading view: theme, font, and zoom" aria-haspopup="dialog" aria-expanded="false"></button>
      <button id="mdr-find-btn" class="mdr-icon-btn" title="${tip('Find in document', 'Mod+F')}" aria-label="Find in document"></button>
      <button id="mdr-keys-btn" class="mdr-icon-btn" title="${tip('Keyboard shortcuts', '?')}" aria-label="Keyboard shortcuts" aria-haspopup="dialog" aria-controls="mdr-keys" aria-expanded="false"></button>
      <span class="mdr-hint">Select text to comment · double-click text to edit</span>
      <button id="mdr-edit-mode" class="mdr-mode" title="${tip('Edit mode: click any paragraph, heading, list item, or table row and type', 'E')}">Edit</button>
      <label class="mdr-toggle" title="Show resolved threads"><input type="checkbox" id="mdr-show-resolved"> Resolved</label>
      <button id="mdr-submit" class="mdr-primary" title="${tip('Submit every draft', 'Mod+Shift+Enter')}" disabled>Submit review</button>
      <button id="mdr-side-toggle" class="mdr-side-toggle" title="Hide the comments pane"></button>
    </div>
  </header>
  <div id="mdr-find" class="mdr-find mdr-ui" hidden></div>
  <div id="mdr-reading" class="mdr-reading-panel mdr-ui" role="dialog" aria-label="Reading view" hidden></div>
  <div class="mdr-layout">
    <nav id="mdr-outline" class="mdr-outline mdr-ui" aria-label="Outline"></nav>
    <main id="mdr-doc" class="mdr-doc"></main>
    <aside class="mdr-sidebar mdr-ui">
      <div class="mdr-side-head">
        <div class="mdr-filters"></div>
        <button id="mdr-send" class="mdr-send" title="${tip('Submit drafts and hand the open threads to Claude Code', 'Mod+Alt+Enter')}">Send to Claude</button>
      </div>
      <div id="mdr-threads"></div>
    </aside>
  </div>
  <div id="mdr-pop" class="mdr-pop mdr-ui" hidden></div>
  <div id="mdr-toast" class="mdr-toast mdr-ui" hidden></div>
  <div id="mdr-keys" class="mdr-keys mdr-ui" hidden></div>
  <button id="mdr-edit-btn" class="mdr-edit-btn mdr-ui" title="Edit this text (or double-click it). ${altName}+double-click edits the raw Markdown." aria-label="Edit" hidden></button>`;
const doc = document.getElementById('mdr-doc')!;
const sidebar = document.getElementById('mdr-threads')!;
const pop = document.getElementById('mdr-pop')!;
const toastEl = document.getElementById('mdr-toast')!;
const submitBtn = document.getElementById('mdr-submit') as HTMLButtonElement;
const showResolvedBox = document.getElementById('mdr-show-resolved') as HTMLInputElement;
const sideToggle = document.getElementById('mdr-side-toggle') as HTMLButtonElement;
const filtersEl = document.querySelector('.mdr-filters') as HTMLElement;
const sendBtn = document.getElementById('mdr-send') as HTMLButtonElement;
const undoBtn = document.getElementById('mdr-undo') as HTMLButtonElement;
const redoBtn = document.getElementById('mdr-redo') as HTMLButtonElement;
const keySheet = createShortcutSheet(document.getElementById('mdr-keys')!);
const search = createSearch(doc, document.getElementById('mdr-find')!);
const diagrams = createDiagrams(doc);
const reading = createReading(
  doc,
  document.getElementById('mdr-reading-btn')!,
  document.getElementById('mdr-reading')!,
  (prefs: ReadingPrefs) => post({ type: 'setPrefs', prefs }),
  (msg) => toast(msg),
);
const outlineBtn = document.getElementById('mdr-outline-toggle')!;
const outline = createOutline(
  doc,
  document.getElementById('mdr-outline')!,
  (open) => vscode.setState({ ...(vscode.getState() || {}), outlineOpen: open }),
  outlineBtn,
);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const post = (m: unknown) => vscode.postMessage(m);

function toast(msg: string, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'mdr-toast mdr-ui' + (isError ? ' error' : '');
  toastEl.hidden = false;
  clearTimeout((toastEl as any)._t);
  (toastEl as any)._t = setTimeout(() => (toastEl.hidden = true), isError ? 7000 : 2500);
}

// ---------------------------------------------------------------- painting
function paint() {
  if (editing || inline) {
    deferredPaint = true;
    return;
  }
  deferredPaint = false;
  docStale = false;
  editBtn.hidden = true;
  hoverEl = null;
  const y = window.scrollY;
  doc.innerHTML = html;
  const text = buildTextMap(doc).text;
  if (text !== paintedText) anchorCache.clear();
  paintedText = text;
  const located = layout();
  painted = new Map();
  const specs = [];
  for (const [c, s, e] of located) {
    painted.set(c.id, { status: c.status, start: s, end: e });
    specs.push({ start: s, end: e, make: () => mark(c) });
  }
  wrapRanges(doc, specs);
  renderSidebar();
  afterPaint();
  window.scrollTo(0, y);
  if (focusTask !== null) {
    (doc.querySelector(`input.mdr-task[data-task-line="${focusTask}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
    focusTask = null;
  }
}

/**
 * Comments changed but the document didn't: unwrap highlights that went away,
 * restyle ones whose status changed, and wrap new ones. The result is the same
 * DOM a full paint() would produce; when it can't be, fall back to paint().
 */
function paintComments() {
  if (editing || inline) {
    deferredPaint = true;
    return;
  }
  if (!painted || deferredPaint || docStale) return paint();
  const want = layout();
  const wanted = new Set(want.map(([c]) => c.id));
  const was = [...painted];
  const kept = was.filter(([id]) => wanted.has(id));
  // Wrap order decides nesting where highlights overlap, so new highlights can
  // only go on top of the ones already there, which must not have moved.
  if (kept.some(([id, r], i) => want[i][0].id !== id || want[i][1] !== r.start || want[i][2] !== r.end)) return paint();
  // A highlight wrapped after (inside) one that is now removed was split at the
  // removed one's edges; only a full paint gives it one clean mark again.
  for (let i = 0; i < was.length; i++) {
    const [id, r] = was[i];
    if (wanted.has(id)) continue;
    for (let j = i + 1; j < was.length; j++) {
      const [kid, k] = was[j];
      if (wanted.has(kid) && k.start < r.end && r.start < k.end) return paint();
    }
  }
  const marks = new Map<string, HTMLElement[]>();
  doc.querySelectorAll<HTMLElement>('mark.mdr-hl').forEach((m) => {
    const id = m.dataset.cid!;
    if (!marks.has(id)) marks.set(id, []);
    marks.get(id)!.push(m);
  });
  const gone: HTMLElement[] = [];
  for (const [id] of was) if (!wanted.has(id)) gone.push(...(marks.get(id) || []));
  unwrap(gone);
  const next: typeof painted = new Map();
  for (const [c, start, end] of want.slice(0, kept.length)) {
    if (painted.get(c.id)!.status !== c.status) for (const m of marks.get(c.id) || []) m.className = markClass(c);
    next.set(c.id, { status: c.status, start, end });
  }
  const added = want.slice(kept.length);
  for (const [c, start, end] of added) next.set(c.id, { status: c.status, start, end });
  wrapRanges(doc, added.map(([c, s, e]) => ({ start: s, end: e, make: () => mark(c) })));
  painted = next;
  renderSidebar();
  afterPaint();
}

/** Outline counts and find matches depend on the painted marks and text nodes. */
function afterPaint() {
  outline.rebuild();
  search.refresh();
  void diagrams.refresh();
}

/** Locate every comment in the painted text; returns the visible highlights in wrap order. */
function layout(): [Comment, number, number][] {
  positions.clear();
  orphans.clear();
  const out: [Comment, number, number][] = [];
  for (const c of comments) {
    const key = `${c.anchor.quote}\u0000${c.anchor.prefix}\u0000${c.anchor.suffix}`;
    let r = anchorCache.get(key);
    if (r === undefined) anchorCache.set(key, (r = locate(paintedText, c.anchor)));
    if (!r) {
      orphans.add(c.id);
      continue;
    }
    positions.set(c.id, r[0]);
    if (c.status === 'resolved' && !showResolved) continue;
    out.push([c, r[0], r[1]]);
  }
  return out;
}

const markClass = (c: Comment) => `mdr-hl mdr-${c.status}` + (c.id === activeId ? ' active' : '');
function mark(c: Comment): HTMLElement {
  const m = document.createElement('mark');
  m.className = markClass(c);
  m.dataset.cid = c.id;
  return m;
}

function counts() {
  const n = { draft: 0, submitted: 0, resolved: 0 };
  for (const c of comments) n[c.status]++;
  return n;
}

function renderSidebar() {
  const n = counts();
  (document.querySelector('.mdr-file') as HTMLElement).textContent = fileName;
  (document.querySelector('.mdr-counts') as HTMLElement).innerHTML =
    `<span class="mdr-pill draft">${n.draft} draft</span><span class="mdr-pill submitted">${n.submitted} open</span><span class="mdr-pill resolved">${n.resolved} resolved</span>`;
  submitBtn.disabled = n.draft === 0;
  submitBtn.textContent = n.draft ? `Submit review (${n.draft})` : 'Submit review';
  showResolvedBox.checked = showResolved;

  const byAuthor = comments.filter((c) => passes(c, { status: 'all', author: filter.author }, true));
  const fc = { all: 0, draft: 0, submitted: 0, resolved: 0 } as Record<StatusFilter, number>;
  for (const c of byAuthor) fc[c.status]++;
  fc.all = byAuthor.filter((c) => showResolved || c.status !== 'resolved').length;
  filtersEl.innerHTML = filterBar(filter, authorsOf(comments), fc);
  const sendable = n.draft + n.submitted;
  sendBtn.disabled = sendable === 0;
  sendBtn.textContent = sendable ? `Send to Claude (${sendable})` : 'Send to Claude';

  const visible = comments.filter((c) => passes(c, filter, showResolved));
  const anchored = visible.filter((c) => !orphans.has(c.id)).sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  const orphaned = visible.filter((c) => orphans.has(c.id));
  navOrder = anchored.map((c) => c.id);
  let out = '';
  if (!visible.length && comments.length) {
    out = `<div class="mdr-empty">No threads match this filter. <button data-act="clear-filter">Show all</button></div>`;
  } else if (!visible.length) {
    out = `<div class="mdr-empty">Select text in the document to add a comment.<br><br>To edit, double-click any text, or turn on <b>Edit</b> in the toolbar and click where you want to type. Enter or clicking away saves; Esc cancels.</div>`;
  }
  out += anchored.map(card).join('');
  if (orphaned.length) {
    out += `<div class="mdr-section">Orphaned (quoted text no longer found)</div>` + orphaned.map(card).join('');
  }
  sidebar.innerHTML = out;
}

function card(c: Comment): string {
  const replies = c.replies
    .map((r) => `<div class="mdr-reply"><div class="mdr-meta"><b>${esc(r.author)}</b> · ${fmt(r.createdAt)}</div><div class="mdr-body">${esc(r.body)}</div></div>`)
    .join('');
  const mine = c.author === author;
  const actions = [
    `<button data-act="reply">Reply</button>`,
    mine && c.status !== 'resolved' ? `<button data-act="edit-body">Edit</button>` : '',
    c.status === 'resolved' ? `<button data-act="reopen">Reopen</button>` : `<button data-act="resolve">Resolve</button>`,
    c.status !== 'resolved' ? `<button data-act="ask-claude" title="Send just this thread to Claude">Ask Claude</button>` : '',
    c.status === 'draft' ? `<button data-act="delete" class="danger">Delete</button>` : '',
  ].join('');
  const replyBox = openReplies.has(c.id)
    ? `<div class="mdr-replybox"><textarea placeholder="Reply…  (${keyLabel('Mod+Enter')} to send)"></textarea><div class="mdr-row"><button data-act="send" class="mdr-primary">Reply</button><button data-act="cancel-reply">Cancel</button></div></div>`
    : '';
  const lines = c.anchor.lineStart ? `L${c.anchor.lineStart}${c.anchor.lineEnd > c.anchor.lineStart ? '–' + c.anchor.lineEnd : ''}` : '';
  return `<div class="mdr-card ${c.status}${c.id === activeId ? ' active' : ''}${orphans.has(c.id) ? ' orphan' : ''}" data-id="${c.id}">
    <div class="mdr-meta"><span class="mdr-badge ${c.status}">${c.status}</span><b>${esc(c.author)}</b> · ${fmt(c.createdAt)}<span class="mdr-lines">${lines}</span></div>
    <blockquote class="mdr-quote" data-act="goto" title="Go to text">${esc(c.anchor.quote.length > 180 ? c.anchor.quote.slice(0, 180) + '…' : c.anchor.quote)}</blockquote>
    ${editingBodies.has(c.id)
      ? `<div class="mdr-replybox"><textarea class="mdr-body-edit">${esc(c.body)}</textarea><div class="mdr-row"><button data-act="save-body" class="mdr-primary">Save</button><button data-act="cancel-body">Cancel</button></div></div>`
      : `<div class="mdr-body">${esc(c.body)}</div>`}
    ${replies ? `<div class="mdr-replies">${replies}</div>` : ''}
    <div class="mdr-actions">${actions}</div>
    ${replyBox}
  </div>`;
}

function activate(id: string | null, scrollDoc: boolean, scrollCard: boolean) {
  activeId = id;
  document.querySelectorAll('.mdr-hl.active, .mdr-card.active').forEach((e) => e.classList.remove('active'));
  if (!id) return;
  if (scrollCard) setSidebarOpen(true); // clicking a highlight brings its thread into view
  const marks = doc.querySelectorAll(`.mdr-hl[data-cid="${id}"]`);
  marks.forEach((m) => m.classList.add('active'));
  const cardEl = sidebar.querySelector(`.mdr-card[data-id="${id}"]`);
  cardEl?.classList.add('active');
  if (scrollDoc && marks[0]) marks[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (scrollCard && cardEl) cardEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------------------------------------------------------------- selection -> comment
function blockRange(node: Node): [number, number] | null {
  const el = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest('[data-ls]');
  return el ? [Number(el.getAttribute('data-ls')), Number(el.getAttribute('data-le'))] : null;
}

function hidePop() {
  pop.hidden = true;
  pop.innerHTML = '';
  pendingAnchor = null;
}

function placePop(rect: DOMRect) {
  pop.hidden = false;
  const w = pop.offsetWidth || 320;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${rect.bottom + window.scrollY + 8}px`;
}

/** Anchor the current document selection, or return null when there is none to comment on. */
function selectionRange(): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || editing || inline || editMode) return null;
  const range = sel.getRangeAt(0);
  if (!doc.contains(range.commonAncestorContainer)) return null;
  const cap = capture(buildTextMap(doc), range);
  if (!cap) return null;
  const a = blockRange(range.startContainer);
  const b = blockRange(range.endContainer) || a;
  pendingAnchor = {
    ...cap,
    lineStart: a ? a[0] + 1 : 0,
    lineEnd: b ? b[1] : a ? a[1] : 0,
  };
  return range;
}

document.addEventListener('mouseup', (ev) => {
  if ((ev.target as Element).closest?.('.mdr-pop')) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || editing || inline || editMode) {
      if (!pop.querySelector('textarea')) hidePop();
      return;
    }
    const range = selectionRange();
    if (!range) return;
    pop.innerHTML = `<button class="mdr-primary" data-act="new-comment" title="${tip('Comment', 'Mod+Alt+M', 'C')}">Comment</button>`;
    placePop(range.getBoundingClientRect());
  }, 0);
});

function openCommentBox(top: number) {
  pop.innerHTML = `<div class="mdr-quote small">${esc(pendingAnchor!.quote.slice(0, 140))}${pendingAnchor!.quote.length > 140 ? '…' : ''}</div>
      <textarea placeholder="Add a comment…  (${keyLabel('Mod+Enter')} to save)"></textarea>
      <div class="mdr-row"><button class="mdr-primary" data-act="save-comment">Save draft</button><button data-act="cancel">Cancel</button></div>`;
  pop.style.top = `${top}px`;
  (pop.querySelector('textarea') as HTMLTextAreaElement).focus();
}

/** Keyboard route to a new comment: open the comment box on the current selection. */
function commentOnSelection() {
  const box = pop.querySelector('textarea') as HTMLTextAreaElement | null;
  if (box) return box.focus();
  // AltGr is Ctrl+Alt on Windows, so AltGr+M (µ) typed in a text box can arrive here: stay quiet.
  if (isTyping(document.activeElement) || editing || inline) return;
  if (editMode) return toast('Turn off edit mode to comment.');
  const range = selectionRange();
  if (!range) return toast('Select some text first, then press ' + keyLabel('Mod+Alt+M') + ' to comment on it.');
  pop.innerHTML = '';
  placePop(range.getBoundingClientRect());
  openCommentBox(parseFloat(pop.style.top));
}

pop.addEventListener('mousedown', (e) => {
  // keep the selection alive while clicking the popup button
  if ((e.target as Element).closest('button')) e.preventDefault();
});

pop.addEventListener('click', (e) => {
  const act = (e.target as Element).closest('[data-act]')?.getAttribute('data-act');
  if (act === 'new-comment' && pendingAnchor) {
    openCommentBox(pop.getBoundingClientRect().top + window.scrollY);
  } else if (act === 'save-comment') {
    saveComment();
  } else if (act === 'cancel') {
    hidePop();
  }
});

pop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) saveComment();
  if (e.key === 'Escape') hidePop();
});

function saveComment() {
  const ta = pop.querySelector('textarea') as HTMLTextAreaElement | null;
  if (!ta || !pendingAnchor) return;
  const body = ta.value.trim();
  if (!body) return ta.focus();
  const { quote, prefix, suffix, lineStart, lineEnd } = pendingAnchor;
  post({ type: 'addComment', anchor: { quote, prefix, suffix, lineStart, lineEnd }, body });
  hidePop();
  window.getSelection()?.removeAllRanges();
}

// ---------------------------------------------------------------- sidebar actions
sidebar.addEventListener('click', (e) => {
  const t = e.target as Element;
  if (t.closest('[data-act="clear-filter"]')) return setFilter({ status: 'all', author: '' });
  const cardEl = t.closest('.mdr-card') as HTMLElement | null;
  if (!cardEl) return;
  const id = cardEl.dataset.id!;
  const act = t.closest('[data-act]')?.getAttribute('data-act');
  switch (act) {
    case 'goto':
      return activate(id, true, false);
    case 'reply':
      openReplies.add(id);
      renderSidebar();
      (sidebar.querySelector(`.mdr-card[data-id="${id}"] textarea`) as HTMLTextAreaElement)?.focus();
      return;
    case 'cancel-reply':
      openReplies.delete(id);
      return renderSidebar();
    case 'send':
      return sendReply(id, cardEl);
    case 'resolve':
      return post({ type: 'setStatus', id, status: 'resolved' });
    case 'reopen':
      return post({ type: 'setStatus', id, status: 'submitted' });
    case 'edit-body':
      editingBodies.add(id);
      renderSidebar();
      (sidebar.querySelector(`.mdr-card[data-id="${id}"] .mdr-body-edit`) as HTMLTextAreaElement)?.focus();
      return;
    case 'cancel-body':
      editingBodies.delete(id);
      return renderSidebar();
    case 'save-body': {
      const body = (cardEl.querySelector('.mdr-body-edit') as HTMLTextAreaElement).value.trim();
      editingBodies.delete(id);
      if (body) post({ type: 'editBody', id, body });
      else renderSidebar();
      return;
    }
    case 'delete':
      return post({ type: 'deleteComment', id });
    case 'ask-claude':
      return post({ type: 'sendToAgent', id });
    default:
      if (!t.closest('textarea')) activate(id, true, false);
  }
});

sidebar.addEventListener('keydown', (e) => {
  const cardEl = (e.target as Element).closest('.mdr-card') as HTMLElement | null;
  // Shift or Alt with Ctrl/Cmd+Enter is Submit review / Send to Claude, not "save".
  if (!cardEl || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if ((e.target as Element).classList.contains('mdr-body-edit')) {
    (cardEl.querySelector('[data-act="save-body"]') as HTMLButtonElement).click();
  } else sendReply(cardEl.dataset.id!, cardEl);
});

function sendReply(id: string, cardEl: HTMLElement) {
  const ta = cardEl.querySelector('textarea') as HTMLTextAreaElement | null;
  const body = ta?.value.trim();
  if (!body) return;
  openReplies.delete(id);
  post({ type: 'reply', id, body });
}

doc.addEventListener('click', (e) => {
  const t = e.target as Element;
  // Task list checkbox: the host flips `[ ]`/`[x]` on that source line and re-renders.
  if (t instanceof HTMLInputElement && t.classList.contains('mdr-task')) {
    if (editing || inline) return e.preventDefault();
    // Repaint whatever comes back, so a refused write unticks the box again.
    docStale = true;
    focusTask = t.dataset.taskLine ?? null;
    post({ type: 'toggleTask', line: Number(t.dataset.taskLine), checked: t.checked });
    return;
  }
  const a = t.closest('a');
  if (a) {
    e.preventDefault();
    if (editMode || inline) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'center' });
    } else if (href) post({ type: 'openLink', href });
    return;
  }
  const m = t.closest('.mdr-hl') as HTMLElement | null;
  if (m && window.getSelection()?.isCollapsed) activate(m.dataset.cid!, false, true);
});

submitBtn.addEventListener('click', () => post({ type: 'submitReview' }));
document.getElementById('mdr-keys-btn')!.addEventListener('click', () => keySheet.toggle());
sendBtn.addEventListener('click', () => post({ type: 'sendToAgent' }));
undoBtn.addEventListener('click', () => post({ type: 'undo' }));
redoBtn.addEventListener('click', () => post({ type: 'redo' }));
document.getElementById('mdr-find-btn')!.addEventListener('click', () => search.open());
// A keyboard press (detail 0) moves focus into the outline; a mouse click leaves it alone.
outlineBtn.addEventListener('click', (e) => outline.setOpen(!outline.isOpen(), e.detail === 0));
outline.setOpen((vscode.getState() || {}).outlineOpen ?? false);

// ---------------------------------------------------------------- filters & navigation
function setFilter(f: Partial<FilterState>) {
  Object.assign(filter, f);
  vscode.setState({ ...(vscode.getState() || {}), filterStatus: filter.status, filterAuthor: filter.author });
  renderSidebar();
}
filtersEl.addEventListener('click', (e) => {
  const st = (e.target as Element).closest('[data-filter-status]')?.getAttribute('data-filter-status') as StatusFilter | undefined;
  if (st) setFilter({ status: st });
});
filtersEl.addEventListener('change', (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.classList.contains('mdr-author-filter')) setFilter({ author: t.value });
});

/** Jump to the next (d = 1) or previous (d = -1) visible thread in document order. */
function navigate(d: 1 | -1) {
  if (!navOrder.length) return toast('No comments to jump to.');
  let i = activeId ? navOrder.indexOf(activeId) : -1;
  if (i < 0) {
    // Start from the reading position rather than the top of the document.
    const marks = navOrder.map((id) => doc.querySelector(`.mdr-hl[data-cid="${id}"]`)?.getBoundingClientRect().top ?? 0);
    i = d > 0 ? marks.findIndex((top) => top > 80) : marks.map((top) => top < 60).lastIndexOf(true);
    if (i < 0) i = d > 0 ? 0 : navOrder.length - 1;
  } else i = (i + d + navOrder.length) % navOrder.length;
  activate(navOrder[i], true, true);
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** Undo/redo: native inside a text field, otherwise the last file edit. */
function undoRedo(which: 'undo' | 'redo') {
  if (isTyping(document.activeElement)) document.execCommand(which);
  else post({ type: which });
}

/** Save a half-typed new comment or reply, so Submit and Send don't leave it behind. */
function flushTyping() {
  if ((pop.querySelector('textarea') as HTMLTextAreaElement | null)?.value.trim()) saveComment();
  const ta = document.activeElement as HTMLElement | null;
  const cardEl = ta?.closest('.mdr-card') as HTMLElement | null;
  if (cardEl && ta!.tagName === 'TEXTAREA' && !ta!.classList.contains('mdr-body-edit') && (ta as HTMLTextAreaElement).value.trim()) {
    sendReply(cardEl.dataset.id!, cardEl);
  }
}

function runCommand(cmd: string) {
  // The shortcuts sheet is modal: any other command closes it first.
  if (cmd !== 'shortcuts' && keySheet.isOpen()) keySheet.toggle();
  switch (cmd) {
    case 'undo':
    case 'redo':
      return undoRedo(cmd);
    case 'find':
      return search.open();
    case 'next':
    case 'prev':
      // Alt+Up/Down reach here even while typing a comment or editing text.
      if (isTyping(document.activeElement)) return;
      return navigate(cmd === 'next' ? 1 : -1);
    case 'outline':
      // Never pull focus out of a text box or editor: that would commit a half-typed edit.
      return outline.setOpen(!outline.isOpen(), !isTyping(document.activeElement) && !editing && !inline);
    case 'send':
      flushTyping();
      return post({ type: 'sendToAgent' });
    case 'zoomIn':
      return reading.zoomBy(1);
    case 'zoomOut':
      return reading.zoomBy(-1);
    case 'zoomReset':
      return reading.resetZoom();
    case 'reading':
      return reading.togglePanel(!isTyping(document.activeElement) && !editing && !inline);
    case 'comment':
      return commentOnSelection();
    case 'submit': {
      const typed = !!(pop.querySelector('textarea') as HTMLTextAreaElement | null)?.value.trim();
      flushTyping();
      if (submitBtn.disabled && !typed) return toast('No drafts to submit.');
      return post({ type: 'submitReview' });
    }
    case 'comments':
      return setSidebarOpen(document.body.classList.contains('mdr-side-collapsed'));
    case 'shortcuts':
      return keySheet.toggle();
  }
}

document.addEventListener('keydown', (e) => {
  const mod = hasMod(e);
  const k = e.key.toLowerCase();
  const code = e.code; // Option on macOS changes e.key (⌥M types µ), so match letters by key position
  if (standalone) {
    // In VS Code these arrive as commands via package.json keybindings.
    const cmd =
      mod && e.altKey && code === 'KeyM' && !e.getModifierState('AltGraph') ? 'comment'
      : mod && e.altKey && code === 'KeyP' && !e.getModifierState('AltGraph') ? 'comments'
      : mod && e.altKey && e.key === 'Enter' ? 'send'
      : mod && e.shiftKey && e.key === 'Enter' ? 'submit'
      : mod && !e.shiftKey && k === 'z' ? 'undo'
      : mod && ((k === 'y' && !isMac) || (e.shiftKey && k === 'z')) ? 'redo'
      : mod && k === 'f' ? 'find'
      : mod && e.shiftKey && k === 'o' ? 'outline'
      : mod && (e.key === '=' || e.key === '+') ? 'zoomIn'
      : mod && (e.key === '-' || e.key === '_') ? 'zoomOut'
      : mod && e.key === '0' ? 'zoomReset'
      : e.altKey && !mod && e.key === 'ArrowDown' ? 'next'
      : e.altKey && !mod && e.key === 'ArrowUp' ? 'prev'
      : '';
    if (cmd) {
      e.preventDefault();
      return runCommand(cmd);
    }
  }
  // Escape inside an editor or a comment box belongs to that box, not the find bar.
  if (e.key === 'Escape' && search.isOpen() && !editing && !inline && !isTyping(e.target)) return search.close();
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || editing || inline) return;
  if (e.key === '?') {
    e.preventDefault();
    keySheet.toggle();
  } else if (keySheet.isOpen()) return;
  else if (k === 'c' && !e.shiftKey) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && doc.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      e.preventDefault();
      commentOnSelection();
    }
  } else if (k === 'e' && !e.shiftKey) {
    e.preventDefault();
    setEditMode(!editMode);
  } else if (k === 'j' || k === 'n') navigate(1);
  else if (k === 'k' || k === 'p') navigate(-1);
  else if (e.key === '/') {
    e.preventDefault();
    search.open();
  } else if (k === 'r' && activeId) {
    e.preventDefault();
    setSidebarOpen(true);
    openReplies.add(activeId);
    renderSidebar();
    (sidebar.querySelector(`.mdr-card[data-id="${activeId}"] textarea`) as HTMLTextAreaElement)?.focus();
  }
});
showResolvedBox.addEventListener('change', () => {
  showResolved = showResolvedBox.checked;
  vscode.setState({ ...(vscode.getState() || {}), showResolved });
  paintComments();
});

// Collapsible comments pane; the choice is remembered per editor.
function setSidebarOpen(open: boolean) {
  document.body.classList.toggle('mdr-side-collapsed', !open);
  sideToggle.textContent = open ? '' : 'Comments';
  sideToggle.setAttribute('aria-label', open ? 'Hide comments' : 'Show comments');
  sideToggle.title = tip(open ? 'Hide the comments pane' : 'Show the comments pane', 'Mod+Alt+P');
  sideToggle.setAttribute('aria-expanded', String(open));
  vscode.setState({ ...(vscode.getState() || {}), sidebarOpen: open });
}
sideToggle.addEventListener('click', () => setSidebarOpen(document.body.classList.contains('mdr-side-collapsed')));
setSidebarOpen((vscode.getState() || {}).sidebarOpen ?? true);

// ---------------------------------------------------------------- editing
// Seamless editing: the rendered block itself becomes editable (no box). On
// commit the host maps the text change back onto the Markdown source and
// verifies it before writing. Raw-source editing (a textarea) is only used
// when a block can't be edited inline (math, images, code) or on Alt+double-click.
const INLINE_KIND: Record<string, string> = { P: 'paragraph', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', LI: 'list_item', TR: 'tr' };
const EDITABLE = 'p[data-ls], h1[data-ls], h2[data-ls], h3[data-ls], h4[data-ls], h5[data-ls], h6[data-ls], li[data-ls], tr[data-ls], .mdr-wrap[data-ls], pre[data-ls], hr[data-ls]';
let editMode = false;
let inline: { el: HTMLElement; ls: number; le: number; kind: string; oldText: string; oldHtml: string; saving: boolean } | null = null;
const editModeBtn = document.getElementById('mdr-edit-mode') as HTMLButtonElement;

function setEditMode(on: boolean) {
  editMode = on;
  document.body.classList.toggle('mdr-edit-mode', on);
  editModeBtn.classList.toggle('on', on);
  editModeBtn.textContent = on ? 'Done editing' : 'Edit';
  vscode.setState({ ...(vscode.getState() || {}), editMode: on });
  if (!on) commitInline();
  hidePop();
}
editModeBtn.addEventListener('click', () => setEditMode(!editMode));

function canInline(el: HTMLElement): boolean {
  if (!INLINE_KIND[el.tagName]) return false;
  return !el.querySelector('img, .katex, pre, .mdr-wrap, ul, ol, table, input');
}

function startEdit(el: HTMLElement, raw = false) {
  if (editing || inline) return;
  hidePop();
  editBtn.hidden = true;
  if (!raw && canInline(el)) return startInline(el);
  window.getSelection()?.removeAllRanges();
  post({ type: 'getBlock', ls: Number(el.dataset.ls), le: Number(el.dataset.le) });
  el.classList.add('mdr-pending');
}

function startInline(el: HTMLElement, caretAtEnd = false) {
  if (editing || inline) return;
  docStale = true;
  inline = { el, ls: Number(el.dataset.ls), le: Number(el.dataset.le), kind: INLINE_KIND[el.tagName], oldText: el.textContent || '', oldHtml: el.innerHTML, saving: false };
  el.contentEditable = 'true';
  el.spellcheck = true;
  el.classList.add('mdr-inline-editing');
  el.focus();
  if (caretAtEnd) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

function endInline(restore: boolean) {
  if (!inline) return;
  const { el, oldHtml } = inline;
  el.removeAttribute('contenteditable');
  el.classList.remove('mdr-inline-editing', 'mdr-saving');
  if (restore) el.innerHTML = oldHtml;
  inline = null;
  if (deferredPaint) paint();
}

function commitInline() {
  if (!inline || inline.saving) return;
  const newText = inline.el.textContent || '';
  if (newText === inline.oldText) return endInline(false);
  inline.saving = true;
  inline.el.classList.add('mdr-saving');
  inline.el.removeAttribute('contenteditable');
  post({ type: 'saveInline', ls: inline.ls, le: inline.le, kind: inline.kind, oldText: inline.oldText, newText });
}

doc.addEventListener('keydown', (e) => {
  if (!inline || !inline.el.contains(e.target as Node)) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    commitInline();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    endInline(true);
  } else if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
    e.preventDefault(); // formatting can't be expressed as a plain-text change
  }
});
doc.addEventListener('beforeinput', (e) => {
  if (inline && /^(insertParagraph|insertLineBreak|format)/.test((e as InputEvent).inputType)) e.preventDefault();
});
doc.addEventListener('paste', (e) => {
  if (!inline) return;
  e.preventDefault();
  const text = (e.clipboardData?.getData('text/plain') || '').replace(/\s*\n\s*/g, ' ');
  document.execCommand('insertText', false, text);
});
doc.addEventListener('focusout', (e) => {
  if (inline && e.target === inline.el) setTimeout(() => commitInline(), 0);
});

// Edit mode: clicking a block places the caret in it directly.
doc.addEventListener('mousedown', (e) => {
  if (!editMode || editing || e.button !== 0) return;
  if ((e.target as Element).closest('.mdr-task')) return;
  const el = (e.target as Element).closest(EDITABLE) as HTMLElement | null;
  if (!el || !doc.contains(el) || (inline && inline.el === el)) return;
  if ((e.target as Element).closest('a')) e.preventDefault();
  if (inline) commitInline();
  if (inline) return; // previous block still saving
  if (canInline(el)) startInline(el);
  else startEdit(el, true);
});

doc.addEventListener('dblclick', (e) => {
  if ((e.target as Element).closest('.mdr-task')) return;
  const el = (e.target as Element).closest(EDITABLE) as HTMLElement | null;
  if (!el || !doc.contains(el) || inline) return;
  startEdit(el, e.altKey); // Alt+double-click = raw Markdown source
});

// Hover edit (pencil) button in the left gutter of the block under the pointer.
const editBtn = document.getElementById('mdr-edit-btn') as HTMLButtonElement;
let hoverEl: HTMLElement | null = null;
doc.addEventListener('mousemove', (e) => {
  if (editing || inline || editMode) return;
  const el = (e.target as Element).closest(EDITABLE) as HTMLElement | null;
  if (!el || !doc.contains(el) || el === hoverEl) return;
  hoverEl = el;
  const r = el.getBoundingClientRect();
  const d = doc.getBoundingClientRect();
  editBtn.hidden = false;
  editBtn.style.top = `${r.top + window.scrollY + 2}px`;
  editBtn.style.left = `${Math.max(4, Math.min(r.left, d.left + 48) - 58)}px`;
});
doc.addEventListener('mouseleave', (e) => {
  if ((e as MouseEvent).relatedTarget !== editBtn) {
    editBtn.hidden = true;
    hoverEl = null;
  }
});
editBtn.addEventListener('click', () => {
  if (!hoverEl || editing || inline) return;
  const el = hoverEl;
  editBtn.hidden = true;
  if (canInline(el)) startInline(el, true);
  else startEdit(el, true);
});
setEditMode(!!(vscode.getState() || {}).editMode);

function openEditor(ls: number, le: number, text: string) {
  const el = doc.querySelector(`.mdr-pending[data-ls="${ls}"][data-le="${le}"]`) as HTMLElement | null
    || (doc.querySelector(`[data-ls="${ls}"][data-le="${le}"]`) as HTMLElement | null);
  doc.querySelectorAll('.mdr-pending').forEach((x) => x.classList.remove('mdr-pending'));
  if (!el) return;
  docStale = true;
  const box: HTMLElement = document.createElement(el.tagName === 'TR' ? 'tr' : 'div');
  box.className = 'mdr-block-editor';
  const inner = `<div class="mdr-edit-head">Editing source lines ${ls + 1}–${le} · ${keyLabel('Mod+Enter')} to save · Esc to cancel</div>
    <textarea spellcheck="true"></textarea>
    <div class="mdr-row"><button class="mdr-primary" data-act="save-block">Save</button><button data-act="cancel-block">Cancel</button></div>`;
  box.innerHTML = el.tagName === 'TR' ? `<td colspan="99">${inner}</td>` : inner;
  el.after(box);
  el.style.display = 'none';
  const ta = box.querySelector('textarea') as HTMLTextAreaElement;
  ta.value = text;
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 4}px`;
  };
  ta.addEventListener('input', fit);
  editing = { ls, le, original: text, el, box };
  fit();
  ta.focus();
  box.addEventListener('click', (e) => {
    const act = (e.target as Element).closest('[data-act]')?.getAttribute('data-act');
    if (act === 'save-block') saveBlock();
    if (act === 'cancel-block') closeEditor();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      saveBlock();
    }
    if (e.key === 'Escape') closeEditor();
  });
}

function saveBlock() {
  if (!editing) return;
  const newText = (editing.box.querySelector('textarea') as HTMLTextAreaElement).value;
  if (newText === editing.original) return closeEditor();
  post({ type: 'saveBlock', ls: editing.ls, le: editing.le, original: editing.original, newText });
}

function closeEditor() {
  if (!editing) return;
  editing.box.remove();
  editing.el.style.display = '';
  editing = null;
  if (deferredPaint) paint();
}

// ---------------------------------------------------------------- host messages
window.addEventListener('message', (ev) => {
  const m = ev.data;
  switch (m?.type) {
    case 'render':
      // The host re-sends identical HTML often (e.g. twice after a block save);
      // skip the re-render when the view already shows it.
      if (m.html === html && painted && !docStale && !deferredPaint) {
        if (m.fileName !== fileName) {
          fileName = m.fileName;
          renderSidebar();
        }
      } else {
        html = m.html;
        fileName = m.fileName;
        paint();
      }
      if (saved.scrollY && !(saved as any)._restored) {
        (saved as any)._restored = true;
        window.scrollTo(0, saved.scrollY);
      }
      break;
    case 'comments':
      comments = m.data.comments || [];
      author = m.author;
      showResolved = (vscode.getState() || {}).showResolved ?? m.showResolved;
      paintComments();
      break;
    case 'block':
      openEditor(m.ls, m.le, m.text);
      break;
    case 'blockSaved':
      endInline(false);
      closeEditor();
      toast('Saved — only the edited lines were written.');
      break;
    case 'error':
      doc.querySelectorAll('.mdr-pending').forEach((x) => x.classList.remove('mdr-pending'));
      toast(m.message, true);
      endInline(true);
      if (/changed on disk/.test(m.message)) closeEditor();
      break;
    case 'history':
      undoBtn.disabled = !m.canUndo;
      redoBtn.disabled = !m.canRedo;
      break;
    case 'toast':
      toast(m.message);
      break;
    case 'agentPrompt':
      copyText(m.prompt).then(
        (ok) => toast(ok ? `Prompt for ${m.count} thread${m.count > 1 ? 's' : ''} copied. Paste it into Claude Code.` : 'Could not copy the prompt.', !ok),
      );
      break;
    case 'prefs':
      reading.apply(m.prefs || {});
      void diagrams.refresh(); // a reading theme can switch light/dark
      break;
    case 'command':
      runCommand(m.command);
      break;
    case 'inlineFailed': {
      endInline(true);
      doc.querySelector(`[data-ls="${m.ls}"][data-le="${m.le}"]`)?.classList.add('mdr-pending');
      openEditor(m.ls, m.le, m.text);
      toast(m.message, true);
      break;
    }
  }
});

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.className = 'mdr-ui';
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

let scrollT: any;
window.addEventListener('scroll', () => {
  clearTimeout(scrollT);
  scrollT = setTimeout(() => vscode.setState({ ...(vscode.getState() || {}), scrollY: window.scrollY }), 200);
});

void author;
post({ type: 'ready' });
