import { buildTextMap, capture, locate, wrapRange, Captured } from './anchor';

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
const positions = new Map<string, number>(); // comment id -> text offset (for ordering)
const orphans = new Set<string>();
const openReplies = new Set<string>();
const editingBodies = new Set<string>();
const saved = vscode.getState() || {};

// ---------------------------------------------------------------- DOM
const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="mdr-toolbar mdr-ui">
    <div class="mdr-title"><span class="mdr-file"></span><span class="mdr-counts"></span></div>
    <div class="mdr-tools">
      <span class="mdr-hint">Select text to comment · double-click text to edit</span>
      <button id="mdr-edit-mode" class="mdr-mode" title="Edit mode: click any paragraph, heading, list item, or table row and type">✎ Edit</button>
      <label class="mdr-toggle"><input type="checkbox" id="mdr-show-resolved"> Show resolved</label>
      <button id="mdr-submit" class="mdr-primary" disabled>Submit review</button>
      <button id="mdr-side-toggle" class="mdr-side-toggle" title="Hide the comments pane"></button>
    </div>
  </header>
  <div class="mdr-layout">
    <main id="mdr-doc" class="mdr-doc"></main>
    <aside id="mdr-threads" class="mdr-sidebar mdr-ui"></aside>
  </div>
  <div id="mdr-pop" class="mdr-pop mdr-ui" hidden></div>
  <div id="mdr-toast" class="mdr-toast mdr-ui" hidden></div>
  <button id="mdr-edit-btn" class="mdr-edit-btn mdr-ui" title="Edit this text (or double-click it). Alt+double-click edits the raw Markdown." hidden>✎</button>`;
const doc = document.getElementById('mdr-doc')!;
const sidebar = document.getElementById('mdr-threads')!;
const pop = document.getElementById('mdr-pop')!;
const toastEl = document.getElementById('mdr-toast')!;
const submitBtn = document.getElementById('mdr-submit') as HTMLButtonElement;
const showResolvedBox = document.getElementById('mdr-show-resolved') as HTMLInputElement;
const sideToggle = document.getElementById('mdr-side-toggle') as HTMLButtonElement;

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
  editBtn.hidden = true;
  hoverEl = null;
  const y = window.scrollY;
  doc.innerHTML = html;
  const map = buildTextMap(doc);
  positions.clear();
  orphans.clear();
  const located: [Comment, number, number][] = [];
  for (const c of comments) {
    const r = locate(map.text, c.anchor);
    if (!r) {
      orphans.add(c.id);
      continue;
    }
    positions.set(c.id, r[0]);
    located.push([c, r[0], r[1]]);
  }
  for (const [c, s, e] of located) {
    if (c.status === 'resolved' && !showResolved) continue;
    wrapRange(doc, s, e, () => {
      const m = document.createElement('mark');
      m.className = `mdr-hl mdr-${c.status}` + (c.id === activeId ? ' active' : '');
      m.dataset.cid = c.id;
      return m;
    });
  }
  renderSidebar();
  window.scrollTo(0, y);
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

  const visible = comments.filter((c) => showResolved || c.status !== 'resolved');
  const anchored = visible.filter((c) => !orphans.has(c.id)).sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  const orphaned = visible.filter((c) => orphans.has(c.id));
  let out = '';
  if (!visible.length) {
    out = `<div class="mdr-empty">Select text in the document to add a comment.<br><br>To edit, double-click any text, or turn on <b>✎ Edit</b> in the toolbar and click where you want to type. Enter or clicking away saves; Esc cancels.</div>`;
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
    c.status === 'draft' ? `<button data-act="delete" class="danger">Delete</button>` : '',
  ].join('');
  const replyBox = openReplies.has(c.id)
    ? `<div class="mdr-replybox"><textarea placeholder="Reply…  (Ctrl+Enter to send)"></textarea><div class="mdr-row"><button data-act="send" class="mdr-primary">Reply</button><button data-act="cancel-reply">Cancel</button></div></div>`
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

document.addEventListener('mouseup', (ev) => {
  if ((ev.target as Element).closest?.('.mdr-pop')) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || editing || inline || editMode) {
      if (!pop.querySelector('textarea')) hidePop();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!doc.contains(range.commonAncestorContainer)) return;
    const cap = capture(buildTextMap(doc), range);
    if (!cap) return;
    const a = blockRange(range.startContainer);
    const b = blockRange(range.endContainer) || a;
    pendingAnchor = {
      ...cap,
      lineStart: a ? a[0] + 1 : 0,
      lineEnd: b ? b[1] : a ? a[1] : 0,
    };
    pop.innerHTML = `<button class="mdr-primary" data-act="new-comment">💬 Comment</button>`;
    placePop(range.getBoundingClientRect());
  }, 0);
});

pop.addEventListener('mousedown', (e) => {
  // keep the selection alive while clicking the popup button
  if ((e.target as Element).closest('button')) e.preventDefault();
});

pop.addEventListener('click', (e) => {
  const act = (e.target as Element).closest('[data-act]')?.getAttribute('data-act');
  if (act === 'new-comment' && pendingAnchor) {
    const rect = pop.getBoundingClientRect();
    pop.innerHTML = `<div class="mdr-quote small">${esc(pendingAnchor.quote.slice(0, 140))}${pendingAnchor.quote.length > 140 ? '…' : ''}</div>
      <textarea placeholder="Add a comment…  (Ctrl+Enter to save)"></textarea>
      <div class="mdr-row"><button class="mdr-primary" data-act="save-comment">Save draft</button><button data-act="cancel">Cancel</button></div>`;
    pop.style.top = `${rect.top + window.scrollY}px`;
    (pop.querySelector('textarea') as HTMLTextAreaElement).focus();
  } else if (act === 'save-comment') {
    saveComment();
  } else if (act === 'cancel') {
    hidePop();
  }
});

pop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveComment();
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
    default:
      if (!t.closest('textarea')) activate(id, true, false);
  }
});

sidebar.addEventListener('keydown', (e) => {
  const cardEl = (e.target as Element).closest('.mdr-card') as HTMLElement | null;
  if (!cardEl || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
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
showResolvedBox.addEventListener('change', () => {
  showResolved = showResolvedBox.checked;
  vscode.setState({ ...(vscode.getState() || {}), showResolved });
  paint();
});

// Collapsible comments pane; the choice is remembered per editor.
function setSidebarOpen(open: boolean) {
  document.body.classList.toggle('mdr-side-collapsed', !open);
  sideToggle.textContent = open ? '⟩' : '⟨ Comments';
  sideToggle.title = open ? 'Hide the comments pane' : 'Show the comments pane';
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
  editModeBtn.textContent = on ? '✎ Editing: click text to change it' : '✎ Edit';
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
  const el = (e.target as Element).closest(EDITABLE) as HTMLElement | null;
  if (!el || !doc.contains(el) || (inline && inline.el === el)) return;
  if ((e.target as Element).closest('a')) e.preventDefault();
  if (inline) commitInline();
  if (inline) return; // previous block still saving
  if (canInline(el)) startInline(el);
  else startEdit(el, true);
});

doc.addEventListener('dblclick', (e) => {
  const el = (e.target as Element).closest(EDITABLE) as HTMLElement | null;
  if (!el || !doc.contains(el) || inline) return;
  startEdit(el, e.altKey); // Alt+double-click = raw Markdown source
});

// Hover "✎" button in the left gutter of the block under the pointer.
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
  if (!hoverEl) return;
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
  const box: HTMLElement = document.createElement(el.tagName === 'TR' ? 'tr' : 'div');
  box.className = 'mdr-block-editor';
  const inner = `<div class="mdr-edit-head">Editing source lines ${ls + 1}–${le} · Ctrl+Enter to save · Esc to cancel</div>
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
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
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
      html = m.html;
      fileName = m.fileName;
      paint();
      if (saved.scrollY && !(saved as any)._restored) {
        (saved as any)._restored = true;
        window.scrollTo(0, saved.scrollY);
      }
      break;
    case 'comments':
      comments = m.data.comments || [];
      author = m.author;
      showResolved = (vscode.getState() || {}).showResolved ?? m.showResolved;
      paint();
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
    case 'inlineFailed': {
      endInline(true);
      doc.querySelector(`[data-ls="${m.ls}"][data-le="${m.le}"]`)?.classList.add('mdr-pending');
      openEditor(m.ls, m.le, m.text);
      toast(m.message, true);
      break;
    }
  }
});

let scrollT: any;
window.addEventListener('scroll', () => {
  clearTimeout(scrollT);
  scrollT = setTimeout(() => vscode.setState({ ...(vscode.getState() || {}), scrollY: window.scrollY }), 200);
});

void author;
post({ type: 'ready' });
