import { createThreadPopover } from './threadPopover';
import { createLiveEditor, LiveSelection } from './liveEditor';
import { textMap, capture, locate, wrapRanges, unwrap, Captured } from './anchor';
import { createSearch } from './search';
import { createOutline } from './outline';
import { createDiagrams } from './diagrams';
import { createReading, ReadingPrefs } from './reading';
import { createHealth, orphanRows, WordTargets } from './health';
import { passes, authorsOf, filterBar, FilterState, StatusFilter, isAgentDraft } from './filters';
import { Round, ReviewRun, roundBanner, reviewBanner, isWorking, nextExpiry, reviewLeft } from './round';
import { createReviewMenu } from './review';
import { Suggestion, suggestionBlock, suggestionEdit } from './suggest';
import { isMac, hasMod, keyLabel, tip, altName, createShortcutSheet } from './keys';
import { blockAtY, reveal, settle, viewTop } from './reveal';
import { createRedlines, Changes } from './redlines';
import { Meta, metaPicker, pickerClick, pickerKey, pickerValue, readPicker, toggleSeverity, metaBadges, severityRank, snapToWords, sectionLines } from './commentMeta';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();

type Status = 'draft' | 'submitted' | 'resolved';
interface Reply { id: string; author: string; createdAt: string; body: string; suggestion?: Suggestion }
interface Comment extends Meta {
  id: string; author: string; createdAt: string; body: string; status: Status;
  submittedAt: string | null; resolvedAt: string | null; replies: Reply[];
  suggestion?: Suggestion;
  /** Set by the CLI while an agent is on this thread. */
  workingAt?: string; workingBy?: string;
  /** "agent": Claude's draft from Review with Claude, not yet triaged. */
  origin?: 'agent' | 'word'; suggestedBy?: string;
  anchor: { quote: string; prefix: string; suffix: string; lineStart: number; lineEnd: number };
}

// ---------------------------------------------------------------- state
let blocks: string[] = []; // the document's HTML, one string per top-level block (see renderBlocks)
let fileName = '';
let comments: Comment[] = [];
let author = '';
let showResolved = true;
/** A thread the review inbox jumped to: shown whatever the filters say, until they change. Never saved. */
let revealed: string | null = null;
let activeId: string | null = null;
let liveReady = false;
let pendingAnchor: (Omit<Captured, 'start' | 'end'> & { lineStart: number; lineEnd: number; scope?: 'section' | 'document' }) | null = null;
let editing: { ls: number; le: number; original: string; el: HTMLElement; box: HTMLElement } | null = null;
let deferredPaint = false;
// What the document currently shows, so comment changes can patch highlights
// instead of re-rendering: the text of the painted HTML, and the highlighted
// comments in wrap order with their status. `docStale` means the DOM may no
// longer match `blocks` (an in-view edit touched it); `touched` holds the
// top-level blocks such an edit changed, which the next paint replaces.
let painted: Map<string, { cls: string; start: number; end: number }> | null = null;
let paintedText = '';
let docStale = false;
/** The task checkbox to refocus after the repaint its click causes. */
let focusTask: string | null = null;
let round: Round | null = null;
/** A Review with Claude run; shown beside the Send round, not instead of it. */
let review: ReviewRun | null = null;
/** After Keep, Do it or Discard on Claude's draft `from`: the card to focus next (null: none left). */
let triageFocus: { from: string; to: string | null } | null = null;
let targets: WordTargets | null = null;
/** The Changes baseline, if any: when it was taken and which threads went out with it. */
let baseInfo: { at: string; threads: string[]; changed: boolean; touched?: string[] } | null = null;
let workingTimer: ReturnType<typeof setTimeout> | undefined;
let lastBanner = '';
const touched = new Set<Element>();
// The blocks on screen, when each is exactly one element of #mdr-doc (the
// footnotes are two), so a repaint can replace only the ones that changed.
let paintedBlocks: string[] | null = null;
let paintedKeys: (string | undefined)[] = [];
// The sidebar list as last rendered: one key and one HTML string per top-level element.
let sidebarKeys: string[] = [];
let sidebarParts: string[] = [];
const anchorCache = new Map<string, [number, number] | null>(); // valid for paintedText
const positions = new Map<string, number>(); // comment id -> text offset (for ordering)
const orphans = new Set<string>();
const openReplies = new Set<string>();
const editingBodies = new Set<string>();
const saved = vscode.getState() || {};
const filter: FilterState = { status: saved.filterStatus || 'all', author: saved.filterAuthor || '', severity: saved.filterSeverity || '' };
/** False until the first comments arrive (a remembered filter is checked against them once). */
let commentsSeen = false;
let navOrder: string[] = []; // visible, anchored thread ids in document order
// The browser harness has no VS Code keybindings, so the view handles those keys itself.
const standalone = !!(window as any).__mdrStandalone;

// ---------------------------------------------------------------- DOM
const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="mdr-toolbar mdr-ui">
    <div class="mdr-brand"><span class="mdr-brand-icon" aria-hidden="true"></span>MD Review</div>
    <div class="mdr-title"><button id="mdr-outline-toggle" class="mdr-icon-btn" title="${tip('Outline', 'Mod+Shift+O')}" aria-label="Toggle outline" aria-controls="mdr-outline" aria-expanded="false"></button><span class="mdr-file"></span><span id="mdr-save-status" class="mdr-save-status" role="status" aria-live="polite"></span></div>
    <div class="mdr-tools">
      <button id="mdr-find-btn" class="mdr-icon-btn" title="${tip('Find in document', 'Mod+F')}" aria-label="Find in document"></button>
      <button id="mdr-reading-btn" class="mdr-icon-btn mdr-reading-btn" title="Reading view: theme, font, and zoom" aria-label="Reading view: theme, font, and zoom" aria-haspopup="dialog" aria-controls="mdr-reading" aria-expanded="false"></button>
      <button id="mdr-changes-btn" class="mdr-icon-btn" title="${tip('Changes since you sent to Claude', ']')}" aria-label="Show changes" aria-pressed="false" aria-controls="mdr-changes"></button>
      <details class="mdr-more" id="mdr-more"><summary aria-label="More tools" title="More tools"><span class="mdr-more-icon" aria-hidden="true"></span></summary>
        <div class="mdr-more-panel">
          <span class="mdr-menu-label">Document tools</span>
          <button id="mdr-undo" title="${tip('Undo edit', 'Mod+Z')}" aria-label="Undo edit" disabled>Undo<span>${keyLabel('Mod+Z')}</span></button>
          <button id="mdr-redo" title="${tip('Redo edit', isMac ? 'Mod+Shift+Z' : 'Mod+Y')}" aria-label="Redo edit" disabled>Redo<span>${keyLabel(isMac ? 'Mod+Shift+Z' : 'Mod+Y')}</span></button>
          <button id="mdr-health-btn" title="Document health" aria-label="Document health" aria-haspopup="dialog" aria-controls="mdr-health" aria-expanded="false">Document health</button>
          <button id="mdr-keys-btn" title="${tip('Keyboard shortcuts', '?')}" aria-label="Keyboard shortcuts" aria-haspopup="dialog" aria-controls="mdr-keys" aria-expanded="false">Keyboard shortcuts</button>
        </div>
      </details>
      <button id="mdr-side-toggle" class="mdr-side-toggle" title="Hide the comments pane"></button>
    </div>
  </header>
  <div id="mdr-find" class="mdr-find mdr-ui" hidden></div>
  <div id="mdr-changes" class="mdr-changes mdr-ui" role="region" aria-label="Changes" hidden></div>
  <div id="mdr-reading" class="mdr-reading-panel mdr-ui" role="dialog" aria-label="Reading view" hidden></div>
  <div id="mdr-review" class="mdr-review-panel mdr-ui" hidden></div>
  <div id="mdr-health" class="mdr-reading-panel mdr-health-panel mdr-ui" role="dialog" aria-label="Document health" hidden></div>
  <div class="mdr-layout">
    <nav id="mdr-outline" class="mdr-outline mdr-ui" aria-label="Outline"></nav>
    <main class="mdr-writing"><div id="mdr-conflict" class="mdr-conflict mdr-ui" hidden><span>Your writing is preserved. Copy it before loading the updated file.</span><button id="mdr-copy-draft">Copy my writing</button><button id="mdr-load-disk">Load updated file</button></div><div id="mdr-canvas" class="mdr-doc"></div><div id="mdr-doc" class="mdr-doc" hidden></div><footer class="mdr-document-footer"><span>Markdown</span><span class="mdr-words" hidden></span></footer></main>
    <aside class="mdr-sidebar mdr-ui">
      <div class="mdr-side-head">
        <div class="mdr-review-heading"><h2>Review</h2><button id="mdr-doc-comment" class="mdr-doc-comment" title="A comment about the whole document, not a passage" aria-label="Comment on document">Add note</button></div>
        <div class="mdr-filters"></div>
        <span class="mdr-counts mdr-sr"></span>
        <div class="mdr-review-actions"><button id="mdr-submit" class="mdr-primary" title="${tip('Submit every draft', 'Mod+Shift+Enter')}" disabled>Submit review</button><button id="mdr-send" class="mdr-send" title="${tip('Submit drafts and hand the open threads to Claude Code', 'Mod+Alt+Enter')}">Send to Claude</button></div>
        <div class="mdr-review-options"><button id="mdr-review-btn" class="mdr-review-btn" title="Review with Claude: Claude reads the document and leaves draft comments for you" aria-haspopup="menu" aria-expanded="false" aria-controls="mdr-review-menu"><span>Review with Claude</span></button><label class="mdr-toggle" title="Show resolved threads"><input type="checkbox" id="mdr-show-resolved"> Resolved</label></div>
      </div>
      <div id="mdr-round" class="mdr-round" role="status" aria-live="polite" hidden></div>
      <div id="mdr-threads"></div>
    </aside>
  </div>
  <div id="mdr-pop" class="mdr-pop mdr-ui" hidden></div>
  <div id="mdr-toast" class="mdr-toast mdr-ui" hidden></div>
  <div id="mdr-keys" class="mdr-keys mdr-ui" hidden></div>
  <button id="mdr-edit-btn" class="mdr-edit-btn mdr-ui" title="Edit this text. ${altName}+double-click edits the raw Markdown." aria-label="Edit" hidden></button>
  <button id="mdr-sec-btn" class="mdr-sec-btn mdr-ui" title="Comment on this whole section" aria-label="Comment on this section" hidden></button>`;
const doc = document.getElementById('mdr-doc')!;
const sidebar = document.getElementById('mdr-threads')!;
const pop = document.getElementById('mdr-pop')!;
const toastEl = document.getElementById('mdr-toast')!;
const submitBtn = document.getElementById('mdr-submit') as HTMLButtonElement;
const showResolvedBox = document.getElementById('mdr-show-resolved') as HTMLInputElement;
const sideToggle = document.getElementById('mdr-side-toggle') as HTMLButtonElement;
const filtersEl = document.querySelector('.mdr-filters') as HTMLElement;
const roundEl = document.getElementById('mdr-round')!;
const sendBtn = document.getElementById('mdr-send') as HTMLButtonElement;
const undoBtn = document.getElementById('mdr-undo') as HTMLButtonElement;
const redoBtn = document.getElementById('mdr-redo') as HTMLButtonElement;
const keySheet = createShortcutSheet(document.getElementById('mdr-keys')!);
const search = createSearch(doc, document.getElementById('mdr-find')!);
const diagrams = createDiagrams(doc);
const redlines = createRedlines(doc, document.getElementById('mdr-changes')!, document.getElementById('mdr-changes-btn')!, {
  post: (m) => post(m),
  canPaint: () => !editing && !inline,
  painted: () => void diagrams.refresh(), // a before view can hold a diagram
  toast: (msg) => toast(msg),
});
// VS Code's own theme switch changes the body class; diagrams follow it.
new MutationObserver(() => void diagrams.refresh()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
const reading = createReading(
  doc,
  document.getElementById('mdr-reading-btn')!,
  document.getElementById('mdr-reading')!,
  (prefs: ReadingPrefs) => {
    post({ type: 'setPrefs', prefs });
    void diagrams.refresh(); // a reading theme can switch light/dark
  },
  (msg) => toast(msg),
);
const reviewMenu = createReviewMenu(document.getElementById('mdr-review-btn')!, document.getElementById('mdr-review')!, (m) => post(m), () => setSidebarOpen(true));
// The host puts the stored reading look into the page (see shell()).
try {
  reading.apply(JSON.parse(document.body.dataset.prefs || '{}'));
} catch {
  /* keep the defaults */
}
const health = createHealth({
  doc,
  button: document.getElementById('mdr-health-btn')!,
  panel: document.getElementById('mdr-health')!,
  wordsEl: document.querySelector('.mdr-words') as HTMLElement,
  post: (m) => post(m),
  onCounted: () => outline.refreshWords(),
  reanchor: (id) => reanchorTo(id),
  showThread: (id) => {
    setSidebarOpen(true);
    activate(id, false, true);
  },
});
const outlineBtn = document.getElementById('mdr-outline-toggle')!;
const outline = createOutline(
  doc,
  document.getElementById('mdr-outline')!,
  (open) => vscode.setState({ ...(vscode.getState() || {}), outlineOpen: open }),
  outlineBtn,
  (h) => health.sectionWords(h),
  (h) => doc.hidden ? live.lineTop(Number(h.dataset.ls || 0) + 1) : h.getBoundingClientRect().top,
);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// One formatter for every date: toLocaleString builds a new one per call.
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmt = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? iso : dateFmt.format(d);
};
const post = (m: unknown) => {
  const type = (m as { type: string }).type;
  if (['sendToAgent', 'startReview', 'submitReview', 'applySuggestion', 'revertChange'].includes(type) && live.dirty) {
    live.whenSaved(() => vscode.postMessage(m));
  } else vscode.postMessage(m);
};

function toast(msg: string, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'mdr-toast mdr-ui' + (isError ? ' error' : '');
  toastEl.hidden = false;
  clearTimeout((toastEl as any)._t);
  (toastEl as any)._t = setTimeout(() => (toastEl.hidden = true), isError ? 7000 : 2500);
}

const moreTools = document.getElementById('mdr-more') as HTMLDetailsElement;
document.addEventListener('pointerdown', event => {
  if (!moreTools.contains(event.target as Node)) moreTools.open = false;
});
moreTools.addEventListener('click', event => {
  if ((event.target as Element).closest('button')) moreTools.open = false;
});
moreTools.addEventListener('keydown', event => {
  if (event.key === 'Escape') { moreTools.open = false; moreTools.querySelector('summary')!.focus(); event.stopPropagation(); }
});

// ---------------------------------------------------------------- painting
function paint() {
  if (editing || inline) {
    deferredPaint = true;
    return;
  }
  deferredPaint = false;
  docStale = false;
  editBtn.hidden = true;
  secBtn.hidden = true;
  hoverEl = null;
  const at = readingPosition();
  // Bare blocks first (a no-op with the Changes view off): a patch compares the
  // document with the blocks last painted, and the redlines' extra elements
  // would stop it matching.
  redlines.clear();
  if (!patchDoc()) {
    doc.innerHTML = blocks.join('') + END;
    // Patching needs every block to be its own element(s), with nothing left open.
    paintedBlocks = closedOff(doc) && doc.children.length === elementCount(blocks, 0, blocks.length) ? blocks : null;
    paintedKeys = [];
  }
  touched.clear();
  const map = textMap(doc);
  if (map.text !== paintedText) anchorCache.clear();
  paintedText = map.text;
  const located = layout();
  painted = new Map();
  const specs = [];
  for (const [c, s, e] of located) {
    painted.set(c.id, { cls: markClass(c), start: s, end: e });
    specs.push({ start: s, end: e, make: () => mark(c) });
  }
  wrapRanges(doc, specs, map);
  // Over the patched blocks too: the marks were taken off before the patch, so every hunk is painted again.
  redlines.apply();
  renderSidebar();
  afterPaint();
  health.painted(targets); // word counts and checks, when idle
  restorePosition(at);
  if (focusTask !== null) {
    (doc.querySelector(`input.mdr-task[data-task-line="${focusTask}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
    focusTask = null;
  }
}

const isFootnotes = (b: string) => b.startsWith('<hr class="footnotes-sep"');
/** Elements that blocks [from, to) make: one each, two for the footnotes (a rule and the list). */
const elementCount = (bs: string[], from: number, to: number) => {
  let n = to - from;
  for (let i = from; i < to; i++) if (isFootnotes(bs[i])) n++;
  return n;
};
const firstLine = (b: string) => Number(/data-ls="(\d+)"/.exec(b)?.[1] ?? NaN);
/** A block's HTML with its line numbers (ranges, task lines) made relative to its first line: equal keys differ only by a move. */
const moveKey = (b: string) => {
  const base = firstLine(b);
  return b.replace(/data-(l[se]|task-line)="(\d+)"/g, (_, k, v) => `data-${k}="${Number(v) - base}"`);
};

/** Appended to HTML before parsing: it lands at the top level only if the HTML closed every element it opened. */
const END = '<i data-mdr-end></i>';
/** Whether the END marker is the last top-level element of `root`; removes it either way. */
function closedOff(root: Element | DocumentFragment): boolean {
  const last = root.lastElementChild;
  const ok = !!last && last.hasAttribute('data-mdr-end');
  root.querySelector('[data-mdr-end]')?.remove();
  return ok;
}

/** Remove `count` elements of #mdr-doc from `from`, each with the text (newline) after it. */
function removeEls(from: number, count: number) {
  for (let k = 0; k < count; k++) {
    const el = doc.children[from];
    while (el.nextSibling && el.nextSibling.nodeType !== Node.ELEMENT_NODE) el.nextSibling.remove();
    el.remove();
  }
}

/**
 * Replace only the blocks that changed since the last paint. Blocks after the
 * change that only moved keep their elements, with their line numbers shifted.
 * The footnotes, last, are compared on their own: they hold lines from all over
 * the file, so they change with almost any edit, but that shouldn't stop the
 * blocks before them from being kept. The result is the DOM a full paint would
 * build, apart from highlights, which the caller wraps again, and state the
 * reader gave kept elements (an open <details>). Returns false when it can't be
 * sure of that.
 */
function patchDoc(): boolean {
  const prev = paintedBlocks;
  if (!prev || doc.querySelector('.mdr-block-editor')) return false;
  const next = blocks;
  if (doc.children.length !== elementCount(prev, 0, prev.length)) return false;
  const notesPrev = !!prev.length && isFootnotes(prev[prev.length - 1]);
  const notesNext = !!next.length && isFootnotes(next[next.length - 1]);
  // The body: every block but the footnotes, one element each.
  const n = prev.length - (notesPrev ? 1 : 0);
  const m = next.length - (notesNext ? 1 : 0);
  // Blocks an in-view edit touched no longer show `prev`: they must be replaced.
  let lo = n;
  let hi = -1;
  let notesTouched = false;
  for (const el of touched) {
    const i = Array.prototype.indexOf.call(doc.children, el);
    if (i < 0) continue;
    if (i >= n) notesTouched = true;
    else {
      lo = Math.min(lo, i);
      hi = Math.max(hi, i);
    }
  }
  let p = 0;
  while (p < n && p < m && p < lo && prev[p] === next[p]) p++;
  const keyOf = (i: number) => (paintedKeys[i] ??= moveKey(prev[i]));
  let s = 0;
  while (s < n - p && s < m - p && n - 1 - s > hi) {
    const was = prev[n - 1 - s];
    const now = next[m - 1 - s];
    if (was === now || keyOf(n - 1 - s) === moveKey(now)) s++;
    else break;
  }
  const keepNotes = notesPrev && notesNext && !notesTouched && prev[n] === next[m];
  const tpl = document.createElement('template');
  tpl.innerHTML = next.slice(p, m - s).join('') + END;
  // A block that leaves an element open (a raw `<div align="center">`) holds the
  // blocks after it in a full paint: only a full paint gets that right.
  if (!closedOff(tpl.content) || tpl.content.children.length !== m - s - p) return false;
  const notes = document.createElement('template');
  if (notesNext && !keepNotes) {
    notes.innerHTML = next[m] + END;
    if (!closedOff(notes.content) || notes.content.children.length !== 2) return false;
  }
  // Unwrap highlights first: a highlight can span blocks, and a full paint
  // starts from bare HTML too.
  unwrap(Array.from(doc.querySelectorAll('mark.mdr-hl')));
  doc.querySelectorAll('.mdr-pending').forEach((x) => x.classList.remove('mdr-pending'));
  const kids = doc.children;
  // Footnotes first, while the body's element positions still hold.
  if (!keepNotes) {
    if (notesPrev) removeEls(n, 2);
    if (notesNext) doc.append(notes.content);
  }
  const oldCount = n - s - p;
  removeEls(p, oldCount);
  doc.insertBefore(tpl.content, kids[p] ?? null);
  // Moved blocks: shift their line numbers.
  const firstKept = m - s;
  for (let k = 0; k < s; k++) {
    const was = prev[n - s + k];
    const now = next[m - s + k];
    if (was === now) continue;
    const d = firstLine(now) - firstLine(was);
    if (!d) continue;
    const el = kids[firstKept + k];
    for (const x of [el, ...Array.from(el.querySelectorAll('[data-ls], [data-task-line]'))]) {
      for (const attr of ['data-ls', 'data-le', 'data-task-line']) {
        const v = x.getAttribute(attr);
        if (v !== null) x.setAttribute(attr, String(Number(v) + d));
      }
    }
  }
  // Moved blocks keep their keys: those don't depend on where the block is.
  const keys = Array.from({ length: n }, (_, i) => paintedKeys[i]);
  keys.splice(p, n - s - p, ...new Array<undefined>(m - s - p));
  paintedKeys = keys; // the footnotes, if any, have none
  paintedBlocks = next;
  return true;
}

// Off-screen blocks use an estimated height until they are first shown (see
// content-visibility in style.css), so a pixel offset does not survive a repaint
// or a reopen. Remember the block at the top of the view and where it sat instead.
type BlockRef = { i: number; key?: string };
type Position = (BlockRef & { dy: number }) | null;

const blockKey = (el: Element) => (el.textContent || '').slice(0, 80);
const refOf = (el: Element): BlockRef => ({ i: Array.prototype.indexOf.call(doc.children, el), key: blockKey(el) });

/** The block `ref` points at: by its text near its old index, else by index. */
function findBlock(ref: BlockRef): Element | undefined {
  const kids = doc.children;
  if (!kids.length) return undefined;
  const i = Math.min(ref.i, kids.length - 1);
  if (ref.key !== undefined) {
    for (let d = 0; d <= 20; d++) {
      for (const j of d ? [i - d, i + d] : [i]) if (kids[j] && blockKey(kids[j]) === ref.key) return kids[j];
    }
  }
  return kids[i];
}

// While a restore is still correcting, the layout is not yet where it is going,
// so another repaint (or a save of the position) uses the restore's target.
let restoring: Position | undefined;

function readingPosition(): Position {
  if (restoring !== undefined) return restoring;
  if (window.scrollY <= 0) return null;
  const top = viewTop();
  const el = blockAtY(doc.children, top);
  return el ? { ...refOf(el), dy: el.getBoundingClientRect().top - top } : null;
}

function restorePosition(at: Position) {
  if (doc.hidden) return;
  const el = at && findBlock(at);
  if (!el) {
    restoring = undefined;
    return window.scrollTo(0, 0);
  }
  restoring = at;
  settle(
    () => (el.isConnected ? el.getBoundingClientRect().top - viewTop() - at!.dy : null),
    8,
    () => restoring === at && (restoring = undefined),
  );
  syncPop();
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
    if (painted.get(c.id)!.cls !== markClass(c)) for (const m of marks.get(c.id) || []) m.className = markClass(c);
    next.set(c.id, { cls: markClass(c), start, end });
  }
  const added = want.slice(kept.length);
  for (const [c, start, end] of added) next.set(c.id, { cls: markClass(c), start, end });
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
    if (c.scope === 'document') {
      positions.set(c.id, -1); // listed first, never highlighted
      continue;
    }
    const key = `${c.anchor.quote}\u0000${c.anchor.prefix}\u0000${c.anchor.suffix}`;
    let r = anchorCache.get(key);
    if (r === undefined) anchorCache.set(key, (r = locate(paintedText, c.anchor)));
    if (!r) {
      orphans.add(c.id);
      continue;
    }
    positions.set(c.id, r[0]);
    if (c.status === 'resolved' && !showResolved && c.id !== revealed) continue;
    out.push([c, r[0], r[1]]);
  }
  return out;
}

const markClass = (c: Comment) => `mdr-hl mdr-${c.status}` + (isAgentDraft(c) ? ' mdr-agent' : '') + (c.id === activeId ? ' active' : '');
function mark(c: Comment): HTMLElement {
  const m = document.createElement('mark');
  m.className = markClass(c);
  m.dataset.cid = c.id;
  return m;
}

/** Claude's untriaged drafts count on their own, not as your drafts. */
function counts() {
  const n = { draft: 0, submitted: 0, resolved: 0, agent: 0 };
  for (const c of comments) n[isAgentDraft(c) ? 'agent' : c.status]++;
  return n;
}

function renderSidebar() {
  const n = counts();
  (document.querySelector('.mdr-file') as HTMLElement).textContent = fileName;
  (document.querySelector('.mdr-counts') as HTMLElement).innerHTML =
    `<span class="mdr-pill draft">${n.draft} draft</span><span class="mdr-pill submitted">${n.submitted} open</span><span class="mdr-pill resolved">${n.resolved} resolved</span>` +
    (n.agent ? `<span class="mdr-pill agent">${n.agent} from Claude</span>` : '');
  submitBtn.disabled = n.draft === 0;
  submitBtn.textContent = n.draft ? `Submit review (${n.draft})` : 'Submit review';
  showResolvedBox.checked = showResolved;

  const byAuthor = comments.filter((c) => passes(c, { status: 'all', author: filter.author, severity: filter.severity, ids: filter.ids }, true));
  const fc = { all: 0, draft: 0, submitted: 0, resolved: 0, agent: 0 } as Record<StatusFilter, number>;
  for (const c of byAuthor) fc[isAgentDraft(c) ? 'agent' : c.status]++;
  fc.all = byAuthor.filter((c) => showResolved || c.status !== 'resolved').length;
  const sevCount: Record<string, number> = {};
  for (const c of comments) if (c.severity && passes(c, { ...filter, severity: '' }, showResolved)) sevCount[c.severity] = (sevCount[c.severity] || 0) + 1;
  filtersEl.innerHTML = filterBar(filter, authorsOf(comments), fc, sevCount);
  const sendable = n.draft + n.submitted;
  sendBtn.disabled = sendable === 0;
  sendBtn.textContent = sendable ? `Send to Claude (${sendable})` : 'Send to Claude';

  const visible = comments.filter((c) => c.id === revealed || passes(c, filter, showResolved));
  const byPos = (a: Comment, b: Comment) => positions.get(a.id)! - positions.get(b.id)!;
  navOrder = visible.filter((c) => c.scope !== 'document' && !orphans.has(c.id)).sort(byPos).map((c) => c.id);
  // Claude's drafts wait at the top until they're triaged: document notes, then in text order.
  const fromClaude = visible.filter((c) => isAgentDraft(c) && !orphans.has(c.id)).sort((a, b) => byPos(a, b) || severityRank(a) - severityRank(b));
  const rest = visible.filter((c) => !isAgentDraft(c));
  const whole = rest.filter((c) => c.scope === 'document').sort((a, b) => severityRank(a) - severityRank(b));
  const anchored = rest.filter((c) => c.scope !== 'document' && !orphans.has(c.id)).sort(byPos);
  const orphaned = visible.filter((c) => orphans.has(c.id));
  // The list as keyed parts (one element each), so a repaint replaces only the cards that changed.
  const keys: string[] = [];
  const parts: string[] = [];
  const add = (key: string, html: string) => {
    keys.push(key);
    parts.push(html);
  };
  if (!visible.length && comments.length) {
    add('e:filter', `<div class="mdr-empty">No threads match this filter. <button data-act="clear-filter">Show all</button></div>`);
  } else if (!visible.length) {
    add('e:none', `<div class="mdr-empty"><strong>A little room for feedback.</strong><p>Select a passage to leave a comment, or add a note about the whole document.</p><span>Your writing saves automatically.</span></div>`);
  }
  const now = Date.now(); // one clock for every card's working state
  const cards = (cs: Comment[]) => cs.forEach((c) => add('c:' + c.id, card(c, now)));
  if (fromClaude.length) {
    add('s:agent', `<div class="mdr-section mdr-section-agent">From Claude · keep, do, or discard</div>`);
    cards(fromClaude);
  }
  if (whole.length) {
    add('s:whole', `<div class="mdr-section">Whole document</div>`);
    cards(whole);
  }
  if ((whole.length || fromClaude.length) && anchored.length) add('s:text', `<div class="mdr-section">In the text</div>`);
  cards(anchored);
  if (orphaned.length) {
    add('s:orphan', `<div class="mdr-section">Orphaned (quoted text no longer found)</div>`);
    cards(orphaned);
  }
  const full = keys.length !== sidebarKeys.length || keys.some((k, i) => k !== sidebarKeys[i]) || sidebar.children.length !== keys.length;
  const changed: number[] = [];
  if (!full) for (let i = 0; i < parts.length; i++) if (parts[i] !== sidebarParts[i]) changed.push(i);
  sidebarKeys = keys;
  sidebarParts = parts;
  // Rebuild in full when the list of keys changed; otherwise replace only the cards whose HTML changed.
  const olds = full ? null : changed.map((i) => sidebar.children[i]);
  // Keep what's being typed in a card (a reply, an edit) when the list repaints under it.
  const typed = (full ? [sidebar] : olds!).flatMap((root) => Array.from(root.querySelectorAll<HTMLTextAreaElement>('.mdr-card textarea'))).map((t) => ({
    id: t.closest<HTMLElement>('.mdr-card')!.dataset.id!,
    cls: t.className,
    value: t.value,
    focus: t === document.activeElement ? [t.selectionStart, t.selectionEnd] : null,
  }));
  if (full) sidebar.innerHTML = parts.join('');
  else if (changed.length) {
    const tpl = document.createElement('template');
    changed.forEach((i, j) => {
      tpl.innerHTML = parts[i];
      olds![j].replaceWith(tpl.content.firstElementChild!);
    });
  }
  for (const d of typed) {
    const t = sidebar.querySelector<HTMLTextAreaElement>(`.mdr-card[data-id="${CSS.escape(d.id)}"] textarea${d.cls ? '.' + d.cls.split(' ')[0] : ':not([class])'}`);
    if (!t) continue;
    t.value = d.value;
    if (d.focus) {
      t.focus({ preventScroll: true });
      t.setSelectionRange(d.focus[0], d.focus[1]);
    }
  }
  health.setOrphans(orphanRows(comments, (id) => orphans.has(id)));
  showWorking();
  applyTriageFocus();
}

/** The review and round banners, and a pulse on the threads Claude is on right now. */
function showWorking() {
  const now = Date.now();
  const on = new Set(comments.filter((c) => isWorking(c, now)).map((c) => c.id));
  const reviewing = review ? reviewLeft(review, comments, now) : null;
  const banner = [reviewBanner(review, reviewing !== null), roundBanner(round, on.size > 0)]
    .filter(Boolean)
    .map((b) => `<div class="mdr-round-part">${b}</div>`)
    .join('');
  if (banner !== lastBanner) roundEl.innerHTML = lastBanner = banner; // unchanged text isn't re-announced
  roundEl.hidden = !banner;
  doc.querySelectorAll<HTMLElement>('mark.mdr-hl').forEach((m) => m.classList.toggle('mdr-working', on.has(m.dataset.cid!)));
  // Cards change in place, so a reply being typed survives a claim expiring.
  sidebar.querySelectorAll<HTMLElement>('.mdr-card').forEach((el) => {
    const w = on.has(el.dataset.id!);
    el.classList.toggle('mdr-working', w);
    const line = w ? null : el.querySelector('.mdr-working-line');
    if (line) {
      line.remove();
      // The card no longer matches its stored HTML: repaint it next time.
      const i = sidebarKeys.indexOf('c:' + el.dataset.id);
      if (i >= 0) sidebarParts[i] = '';
    }
  });
  clearTimeout(workingTimer);
  const left = [nextExpiry(comments, now), reviewing].filter((x): x is number => x !== null);
  if (left.length) workingTimer = setTimeout(showWorking, Math.max(0, Math.min(...left)) + 50);
}

/** The suggestion still waiting on the reviewer: '' for the comment's own, else the reply id. */
function openSuggestion(c: Comment): string | null {
  if (c.status === 'resolved') return null;
  for (let i = c.replies.length - 1; i >= 0; i--) {
    const s = c.replies[i].suggestion;
    if (s && !s.appliedAt && !s.dismissedAt) return c.replies[i].id;
  }
  return c.suggestion && !c.suggestion.appliedAt && !c.suggestion.dismissedAt ? '' : null;
}

/** Sent with the current baseline, and the agent has resolved or replied since: its edit can be shown. */
function answered(c: Comment): boolean {
  if (!baseInfo?.changed || c.scope === 'document' || !baseInfo.threads.includes(c.id)) return false;
  if (baseInfo.touched && !baseInfo.touched.includes(c.id)) return false; // compared, and nothing changed in its text
  const since = baseInfo.at;
  return (c.status === 'resolved' && (c.resolvedAt || '') > since) || c.replies.some((r) => r.author !== author && r.createdAt > since);
}

function card(c: Comment, now = Date.now()): string {
  const open = orphans.has(c.id) ? null : openSuggestion(c); // no text to apply it to
  const replies = c.replies
    .map((r) => `<div class="mdr-reply"><div class="mdr-meta"><b>${esc(r.author)}</b> · ${fmt(r.createdAt)}</div><div class="mdr-body">${esc(r.body)}</div>${r.suggestion ? suggestionBlock(c.anchor.quote, r.suggestion, r.id, r.author, open === r.id) : ''}</div>`)
    .join('');
  const mine = c.author === author;
  const agent = isAgentDraft(c);
  const actions = agent
    ? [
        `<button data-act="keep" title="Make this your draft; it goes out with your review">Keep</button>`,
        `<button data-act="do-it" title="Keep it and queue it for Claude; Send to Claude hands over everything queued" aria-label="Do it: keep and queue for Claude">Do it</button>`,
        `<button data-act="dismiss-agent" class="danger" title="Delete this comment from ${esc(c.author)}" aria-label="Discard ${esc(c.author)}'s comment">Discard</button>`,
      ].join('')
    : [
    `<button data-act="reply">Reply</button>`,
    mine && c.status !== 'resolved' ? `<button data-act="edit-body">Edit</button>` : '',
    c.status === 'resolved' ? `<button data-act="reopen">Reopen</button>` : `<button data-act="resolve">Resolve</button>`,
    c.status !== 'resolved' ? `<button data-act="ask-claude" title="Send just this thread to Claude">Ask Claude</button>` : '',
    answered(c) ? `<button data-act="show-change" title="Show what changed in this thread's text since you sent it">Show change</button>` : '',
    `<button data-act="delete" class="danger" title="${c.status === 'draft' ? 'Delete this draft' : 'Delete this thread and its replies'}">Delete</button>`,
  ].join('');
  const replyBox = openReplies.has(c.id)
    ? `<div class="mdr-replybox"><textarea placeholder="Reply…  (${keyLabel('Mod+Enter')} to send)"></textarea><div class="mdr-row"><button data-act="send" class="mdr-primary">Reply</button><button data-act="cancel-reply">Cancel</button></div></div>`
    : '';
  const lines = c.anchor.lineStart ? `L${c.anchor.lineStart}${c.anchor.lineEnd > c.anchor.lineStart ? '–' + c.anchor.lineEnd : ''}` : '';
  const working = isWorking(c, now);
  const by = c.suggestedBy ? ` <span class="mdr-by">· raised by ${esc(c.suggestedBy)}</span>` : '';
  return `<div class="mdr-card ${c.status}${agent ? ' mdr-agent' : ''}${c.id === activeId ? ' active' : ''}${orphans.has(c.id) ? ' orphan' : ''}${working ? ' mdr-working' : ''}" data-id="${c.id}">
    <div class="mdr-meta"><span class="mdr-badge ${agent ? 'agent' : c.status}">${agent ? 'suggested' : c.status}</span><b>${esc(c.author)}</b>${by} · ${fmt(c.createdAt)}<span class="mdr-lines">${c.scope === 'document' ? '' : lines}</span></div>
    ${metaBadges(c) ? `<div class="mdr-tags">${metaBadges(c)}</div>` : ''}
    ${c.scope === 'document' ? '' : `<blockquote class="mdr-quote" data-act="goto" title="Go to text">${esc(c.anchor.quote.length > 180 ? c.anchor.quote.slice(0, 180) + '…' : c.anchor.quote)}</blockquote>`}
    ${editingBodies.has(c.id)
      ? `<div class="mdr-replybox">${metaPicker(c, altDigit)}<textarea class="mdr-body-edit">${esc(c.body)}</textarea><div class="mdr-row"><button data-act="save-body" class="mdr-primary">Save</button><button data-act="cancel-body">Cancel</button></div></div>`
      : `<div class="mdr-body">${esc(c.body)}</div>`}
    ${c.suggestion ? suggestionBlock(c.anchor.quote, c.suggestion, '', c.suggestedBy || (c.author === author ? 'You' : c.author), open === '') : ''}
    ${replies ? `<div class="mdr-replies">${replies}</div>` : ''}
    ${working ? `<div class="mdr-working-line"><span class="mdr-round-dot live" aria-hidden="true"></span>${esc(c.workingBy || 'Claude')} is working on this…</div>` : ''}
    <div class="mdr-actions">${actions}</div>
    ${replyBox}
  </div>`;
}

function activate(id: string | null, scrollDoc: boolean, scrollCard: boolean) {
  activeId = id;
  if (liveReady) live.activateThread(id, scrollDoc && !redlines.isOn());
  document.querySelectorAll('.mdr-hl.active, .mdr-card.active').forEach((e) => e.classList.remove('active'));
  if (!id) return;
  if (scrollCard) setSidebarOpen(true, !scrollDoc); // explicit passage jumps may intentionally change the reading position
  const marks = doc.querySelectorAll(`.mdr-hl[data-cid="${id}"]`);
  marks.forEach((m) => m.classList.add('active'));
  const cardEl = sidebar.querySelector(`.mdr-card[data-id="${id}"]`);
  cardEl?.classList.add('active');
  if (scrollDoc) {
    if (redlines.isOn()) reveal(marks[0], 'center');
  }
  // In one column the thread list is below the document, in the same scroll:
  // there the highlight wins.
  if (scrollCard && cardEl && !(scrollDoc && matchMedia('(max-width: 620px)').matches)) {
    cardEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/** Jump to a thread picked in the review inbox, showing it even if the filters hide it (without changing them). */
function focusThread(id: string) {
  const c = comments.find((x) => x.id === id);
  if (!c) return toast('That thread is no longer in this file.', true);
  const was = revealed;
  revealed = passes(c, filter, showResolved) ? null : id;
  if (revealed !== was) paintComments();
  activate(id, true, true);
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
  popAnchor = null;
  returnFocus = null;
}

/** Where focus goes when a comment box opened from a button or heading closes. */
let returnFocus: HTMLElement | null = null;

/** Close the comment box after Save, Cancel or Escape. */
function closeBox() {
  const back = returnFocus;
  hidePop();
  back?.focus({ preventScroll: true });
}

// The comment box sits in page coordinates, but blocks above it change height
// (off-screen blocks take their real size when shown, and a repaint resets
// them), so it follows the block holding the selection instead.
let popAnchor: { ref: BlockRef; el: Element; dy: number } | null = null;

function placePop(at: Range | Element) {
  const rect = at.getBoundingClientRect();
  pop.hidden = false;
  const w = pop.offsetWidth || 320;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${rect.bottom + window.scrollY + 8}px`;
  let el: Node | null = at instanceof Range ? at.startContainer : at;
  while (el && el.parentNode !== doc) el = el.parentNode;
  popAnchor = el instanceof Element ? { ref: refOf(el), el, dy: rect.bottom + 8 - el.getBoundingClientRect().top } : null;
}

function syncPop() {
  if (pop.hidden || !popAnchor) return;
  if (!popAnchor.el.isConnected) {
    const el = findBlock(popAnchor.ref);
    if (!el) return;
    popAnchor.el = el;
  }
  pop.style.top = `${popAnchor.el.getBoundingClientRect().top + window.scrollY + popAnchor.dy}px`;
}

/** Anchor the current document selection, or return null when there is none to comment on. */
function selectionRange(): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || editing || (inline && (inline.saving || inline.el.textContent !== inline.oldText))) return null;
  const range = snapToWords(sel.getRangeAt(0));
  if (!doc.contains(range.commonAncestorContainer)) return null;
  // Show the snapped range, so what's highlighted is what gets quoted.
  const cur = sel.getRangeAt(0);
  if (range.compareBoundaryPoints(Range.START_TO_START, cur) || range.compareBoundaryPoints(Range.END_TO_END, cur)) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const cap = capture(textMap(doc), range);
  if (!cap) return null;
  const a = blockRange(range.startContainer);
  const b = blockRange(range.endContainer) || a;
  pendingAnchor = {
    quote: cap.quote,
    prefix: cap.prefix,
    suffix: cap.suffix,
    lineStart: a ? a[0] + 1 : 0,
    lineEnd: b ? b[1] : a ? a[1] : 0,
  };
  return range;
}

document.addEventListener('mouseup', (ev) => {
  if ((ev.target as Element).closest?.('.mdr-pop, #mdr-canvas')) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || editing || inline?.saving) {
      if (!pop.querySelector('textarea')) hidePop();
      return;
    }
    const range = inline && !inline.saving && inline.el.textContent !== inline.oldText ? sel.getRangeAt(0) : selectionRange();
    if (!range) return;
    pop.innerHTML = `<button class="mdr-primary" data-act="new-comment" title="${tip('Comment', 'Mod+Alt+M', 'C')}">Comment</button>`;
    placePop(range);
  }, 0);
});

const altDigit = (n: number) => keyLabel(`Alt+${n}`);

// VS Code binds Alt+1/2/3 to severity only while a comment box has focus (they
// otherwise switch editor tabs), so tell the host when that changes.
let inPickerBox = false;
const trackComposing = () =>
  queueMicrotask(() => {
    const on = !!document.activeElement?.closest('.mdr-pop, .mdr-card')?.querySelector('.mdr-meta-pick');
    if (on !== inPickerBox && !standalone) post({ type: 'composing', on });
    inPickerBox = on;
  });
document.addEventListener('focusin', trackComposing);
document.addEventListener('focusout', trackComposing);

function openCommentBox(top: number) {
  const a = pendingAnchor!;
  const what =
    a.scope === 'document'
      ? `<div class="mdr-quote small mdr-scope-note">The whole document</div>`
      : `<div class="mdr-quote small">${a.scope === 'section' ? 'Section: ' : ''}${esc(a.quote.slice(0, 140))}${a.quote.length > 140 ? '…' : ''}</div>`;
  // A passage can carry a suggested replacement; a section or the document can't.
  const suggest = a.scope
    ? ''
    : `<div class="mdr-sugg-edit" hidden><label class="mdr-sugg-label" for="mdr-sugg-text">Replace with</label><textarea id="mdr-sugg-text" class="mdr-sugg-text" spellcheck="true">${esc(a.quote)}</textarea></div>`;
  pop.innerHTML = `${what}
      ${metaPicker({}, altDigit)}
      <textarea class="mdr-comment-text" placeholder="Add a comment…  (${keyLabel('Mod+Enter')} to save)"></textarea>
      ${suggest}
      <div class="mdr-row"><button class="mdr-primary" data-act="save-comment">Save draft</button><button data-act="cancel">Cancel</button>${a.scope ? '' : `<button class="mdr-sugg-toggle" data-act="toggle-sugg" aria-pressed="false" title="Propose replacement text for the selection">Suggest edit</button>`}</div>`;
  pop.style.top = `${top}px`;
  (pop.querySelector('textarea') as HTMLTextAreaElement).focus();
}

/** Keyboard route to a new comment: open the comment box on the current selection. */
function commentOnSelection() {
  if (!redlines.isOn()) return liveComment();
  const box = pop.querySelector('textarea') as HTMLTextAreaElement | null;
  if (box) return box.focus();
  if (saveSelection()) return;
  // AltGr is Ctrl+Alt on Windows, so AltGr+M (µ) typed in a text box can arrive here: stay quiet.
  if ((isTyping(document.activeElement) && !inline) || editing || inline?.saving) return;
  const range = selectionRange();
  // A heading focused from the outline (Enter) gets a comment on its whole section.
  const h = document.activeElement as HTMLElement | null;
  if (!range && h && doc.contains(h) && /^H[1-6]$/.test(h.tagName)) {
    commentOnSection(h);
    returnFocus = h;
    return;
  }
  if (!range) return toast('Select some text first, then press ' + keyLabel('Mod+Alt+M') + ' to comment on it.');
  pop.innerHTML = '';
  placePop(range);
  openCommentBox(parseFloat(pop.style.top));
}

pop.addEventListener('mousedown', (e) => {
  // keep the selection alive while clicking the popup button
  if ((e.target as Element).closest('button')) e.preventDefault();
});

pop.addEventListener('click', (e) => {
  if (pickerClick(e.target as Element)) return;
  const act = (e.target as Element).closest('[data-act]')?.getAttribute('data-act');
  if (act === 'live-comment') return liveComment();
  if (act === 'new-comment' && saveSelection()) return;
  if (act === 'new-comment' && pendingAnchor) {
    openCommentBox(pop.getBoundingClientRect().top + window.scrollY);
  } else if (act === 'toggle-sugg') {
    const box = pop.querySelector('.mdr-sugg-edit') as HTMLElement;
    const btn = pop.querySelector('.mdr-sugg-toggle') as HTMLElement;
    box.hidden = !box.hidden;
    btn.setAttribute('aria-pressed', String(!box.hidden));
    if (!box.hidden) {
      const ta = box.querySelector('textarea') as HTMLTextAreaElement;
      ta.focus();
      ta.select();
    }
  } else if (act === 'save-comment') {
    saveComment();
  } else if (act === 'cancel') {
    closeBox();
  }
});

pop.addEventListener('keydown', (e) => {
  if (standalone && pickerKey(e, pop)) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) saveComment();
  if (e.key === 'Escape') closeBox();
});

/** Health panel: move an orphaned thread onto the selected passage, captured as for a new comment. */
function reanchorTo(id: string) {
  if (!redlines.isOn()) {
    const selected = live.selection();
    if (!selected) return toast('Select the passage this comment is about first.');
    if (live.conflicted) return toast('Resolve the file conflict before moving the comment.', true);
    live.whenSaved(() => post({ type: 'reanchor', id, anchor: { quote: selected.quote, prefix: '', suffix: '', lineStart: selected.lineStart, lineEnd: selected.lineEnd } }));
    hidePop();
    return;
  }
  // The open comment box owns pendingAnchor: don't take it from a comment being written.
  if (composing()) return toast('Save or cancel the comment you are writing first.');
  if (!selectionRange() || !pendingAnchor || !pendingAnchor.lineStart) return toast('Select the passage this comment is about, then press Re-anchor to selection.');
  const { quote, prefix, suffix, lineStart, lineEnd } = pendingAnchor;
  post({ type: 'reanchor', id, anchor: { quote, prefix, suffix, lineStart, lineEnd } });
  hidePop(); // the Comment button, or an empty comment box
  window.getSelection()?.removeAllRanges();
}

function saveComment() {
  const ta = pop.querySelector('.mdr-comment-text') as HTMLTextAreaElement | null;
  if (!ta || !pendingAnchor) return;
  const { quote, prefix, suffix, lineStart, lineEnd, scope } = pendingAnchor;
  // A suggestion speaks for itself, so the comment text is optional with one.
  const suggestion = typedSuggestion();
  const body = ta.value.trim() || (suggestion !== undefined ? (suggestion ? 'Suggested edit.' : 'Suggest deleting this.') : '');
  if (!body) return ta.focus();
  const { kind, severity } = readPicker(pop);
  post({ type: 'addComment', anchor: { quote, prefix, suffix, lineStart, lineEnd }, body, meta: { kind, severity, scope }, suggestion });
  closeBox();
  window.getSelection()?.removeAllRanges();
}

// ---------------------------------------------------------------- sidebar actions
roundEl.addEventListener('click', (e) => {
  const act = (e.target as Element).closest('[data-round]')?.getAttribute('data-round');
  if (act === 'questions' && round) setFilter({ status: 'all', author: '', severity: '', ids: round.questionIds });
  // This run's drafts only; it also replaces an earlier "Waiting on you".
  else if (act === 'from-claude') setFilter({ status: 'agent', author: '', severity: '', ids: review ? review.ids : undefined });
  else if (act === 'changes') redlines.setOn(true);
  else if (act === 'dismiss-round' || act === 'dismiss-review') {
    post({ type: 'dismissRound', which: act === 'dismiss-round' ? 'round' : 'review' });
    // The row is about to go; keep focus somewhere useful.
    if (roundEl.contains(document.activeElement)) (sendBtn.disabled ? docCommentBtn : sendBtn).focus();
  }
});

sidebar.addEventListener('click', (e) => {
  const t = e.target as Element;
  if (pickerClick(t)) return;
  if (t.closest('[data-act="clear-filter"]')) return setFilter({ status: 'all', author: '', severity: '', ids: undefined });
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
      const { kind, severity } = readPicker(cardEl);
      const c = comments.find((x) => x.id === id);
      editingBodies.delete(id);
      // Send only what changed, so a kind or severity this version doesn't know survives a body edit.
      const was = pickerValue(c || {});
      const meta: { kind?: string; severity?: string | null } = {};
      if (kind !== was.kind) meta.kind = kind;
      if (severity !== was.severity) meta.severity = severity;
      if (c && Object.keys(meta).length) post({ type: 'setMeta', id, meta });
      if (body && body !== c?.body) post({ type: 'editBody', id, body });
      else renderSidebar();
      return;
    }
    case 'delete': {
      // A draft goes at once; a sent thread (and its replies) takes a second click, since there's no undo.
      const btn = t.closest('[data-act="delete"]') as HTMLButtonElement;
      if (comments.find((x) => x.id === id)?.status !== 'draft' && !btn.dataset.armed) {
        btn.dataset.armed = '1';
        btn.textContent = 'Delete thread?';
        setTimeout(() => {
          delete btn.dataset.armed;
          btn.textContent = 'Delete';
        }, 4000);
        return;
      }
      return post({ type: 'deleteComment', id });
    }
    case 'apply-sugg': {
      const c = comments.find((x) => x.id === id);
      const from = (t.closest('[data-from]') as HTMLElement).dataset.from || '';
      const s = from ? c?.replies.find((r) => r.id === from)?.suggestion : c?.suggestion;
      if (!c || !s) return;
      if (editing || inline) return toast('Finish the edit you have open first.', true);
      const blk = doc.querySelector(`mark.mdr-hl[data-cid="${CSS.escape(id)}"]`)?.closest<HTMLElement>('[data-ls]');
      if (blk) redlines.clearIn(blk); // struck-out words aren't part of the text
      const edit = suggestionEdit(doc, id, s.text, (el) => (canInline(el) ? INLINE_KIND[el.tagName] : null));
      if (typeof edit === 'string') {
        // Can't map it in place: open the source so the reviewer can make it by hand.
        const block = doc.querySelector(`mark.mdr-hl[data-cid="${id}"]`)?.closest<HTMLElement>('[data-ls]');
        toast(`${edit} Make the change in the source.`, true);
        if (block) startEdit(block, true);
        return;
      }
      docStale = true;
      return post({ type: 'applySuggestion', id, from: from || undefined, ...edit });
    }
    case 'dismiss-sugg':
      return post({ type: 'dismissSuggestion', id, from: (t.closest('[data-from]') as HTMLElement).dataset.from || undefined });
    case 'ask-claude':
      return post({ type: 'sendToAgent', id });
    case 'keep':
      nextTriageFocus(cardEl);
      return post({ type: 'triage', id, action: 'keep' });
    case 'do-it':
      nextTriageFocus(cardEl);
      return post({ type: 'triage', id, action: 'do' });
    case 'dismiss-agent':
      nextTriageFocus(cardEl);
      return post({ type: 'deleteComment', id });
    case 'show-change': {
      const c = comments.find((x) => x.id === id);
      if (c) redlines.showThread(id, c.anchor.lineStart, c.anchor.lineEnd);
      return;
    }
    default:
      if (!t.closest('textarea')) activate(id, true, false);
  }
});

/** Triage takes a card out of Claude's list: focus moves to the next one (or the one before the last). */
function nextTriageFocus(cardEl: HTMLElement) {
  if (!cardEl.contains(document.activeElement)) return;
  const cards = Array.from(sidebar.querySelectorAll<HTMLElement>('.mdr-card.mdr-agent'));
  const i = cards.indexOf(cardEl);
  const to = cards[i + 1] ?? cards[i - 1];
  triageFocus = { from: cardEl.dataset.id!, to: to ? to.dataset.id! : null };
}

/** Once the triaged card has left Claude's list, put focus where nextTriageFocus said. */
function applyTriageFocus() {
  if (!triageFocus || comments.some((c) => c.id === triageFocus!.from && isAgentDraft(c))) return;
  const { to } = triageFocus;
  triageFocus = null;
  const next = to && sidebar.querySelector<HTMLElement>(`.mdr-card.mdr-agent[data-id="${CSS.escape(to)}"] [data-act="keep"]`);
  if (next) return next.focus();
  // None left: Send to Claude hands over what was kept and queued; else the filter's All chip.
  const all = filtersEl.querySelector<HTMLElement>('[data-filter-status="all"]');
  (sendBtn.disabled ? all || docCommentBtn : sendBtn).focus();
}

sidebar.addEventListener('keydown', (e) => {
  const cardEl = (e.target as Element).closest('.mdr-card') as HTMLElement | null;
  if (cardEl && standalone && pickerKey(e, cardEl)) return;
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
    touched.add(topBlock(t));
    focusTask = t.dataset.taskLine ?? null;
    post({ type: 'toggleTask', line: Number(t.dataset.taskLine), checked: t.checked, key: t.dataset.taskKey });
    return;
  }
  const a = t.closest('a');
  if (a) {
    e.preventDefault();
    if (inline) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {} // a citation key may hold a bare %
      reveal(document.getElementById(id), 'center', false);
    } else if (href) post({ type: 'openLink', href });
    return;
  }
  const m = t.closest('.mdr-hl') as HTMLElement | null;
  if (m && window.getSelection()?.isCollapsed) openThread(m.dataset.cid!);
});

submitBtn.addEventListener('click', () => post({ type: 'submitReview' }));
document.getElementById('mdr-keys-btn')!.addEventListener('click', () => keySheet.toggle());
sendBtn.addEventListener('click', () => post({ type: 'sendToAgent' }));
undoBtn.addEventListener('click', () => post({ type: 'undo' }));
redoBtn.addEventListener('click', () => post({ type: 'redo' }));
document.getElementById('mdr-find-btn')!.addEventListener('click', () => redlines.isOn() ? search.open() : live.find());
// A keyboard press (detail 0) moves focus into the outline; a mouse click leaves it alone.
outlineBtn.addEventListener('click', (e) => outline.setOpen(!outline.isOpen(), e.detail === 0));
outline.setOpen((vscode.getState() || {}).outlineOpen ?? window.innerWidth > 1100);

// ---------------------------------------------------------------- filters & navigation
function setFilter(f: Partial<FilterState>, repaint = true) {
  Object.assign(filter, f);
  const was = revealed;
  revealed = null;
  vscode.setState({ ...(vscode.getState() || {}), filterStatus: filter.status, filterAuthor: filter.author, filterSeverity: filter.severity });
  // A revealed resolved thread has a highlight to take down too.
  if (repaint) was ? paintComments() : renderSidebar();
}
filtersEl.addEventListener('click', (e) => {
  const st = (e.target as Element).closest('[data-filter-status]')?.getAttribute('data-filter-status') as StatusFilter | undefined;
  if (st) setFilter({ status: st, ids: undefined });
  const sv = (e.target as Element).closest('[data-filter-severity]')?.getAttribute('data-filter-severity') as FilterState['severity'] | undefined;
  if (sv) setFilter({ severity: filter.severity === sv ? '' : sv });
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
  if (!redlines.isOn()) { live[which](); return; }
  if (isTyping(document.activeElement)) document.execCommand(which);
  else post({ type: which });
}

/** The replacement in the new-comment box's Suggest edit field, unless it's unchanged from the quote. */
function typedSuggestion(): string | undefined {
  const sugg = pop.querySelector('.mdr-sugg-edit:not([hidden]) textarea') as HTMLTextAreaElement | null;
  const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
  if (!sugg || !pendingAnchor || flat(sugg.value) === flat(pendingAnchor.quote)) return undefined;
  return sugg.value.replace(/\s*\n\s*/g, ' ');
}

/** The new-comment box has something to save: text, or a changed suggestion. */
const composing = () => !!(pop.querySelector('.mdr-comment-text') as HTMLTextAreaElement | null)?.value.trim() || typedSuggestion() !== undefined;

/** Save a half-typed new comment or reply, so Submit and Send don't leave it behind. */
function flushTyping() {
  if (composing()) saveComment();
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
      return redlines.isOn() ? search.open() : live.find();
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
      const typed = composing();
      flushTyping();
      if (submitBtn.disabled && !typed) return toast('No drafts to submit.');
      return post({ type: 'submitReview' });
    }
    case 'comments':
      return setSidebarOpen(document.body.classList.contains('mdr-side-collapsed'));
    case 'review':
      return reviewMenu.open();
    case 'shortcuts':
      return keySheet.toggle();
    case 'severity1':
    case 'severity2':
    case 'severity3': {
      const root = document.activeElement?.closest('.mdr-pop, .mdr-card');
      if (root) toggleSeverity(root, Number(cmd.slice(-1)));
      return;
    }
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.target as Element).closest('#mdr-canvas')) return;
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
  // `]` and `[` are typed with AltGr (or Option on a Mac) on many layouts.
  const composed = (e.key === ']' || e.key === '[') && (e.getModifierState('AltGraph') || (isMac && e.altKey && !e.ctrlKey && !e.metaKey));
  if (((e.ctrlKey || e.metaKey || e.altKey) && !composed) || isTyping(e.target) || editing || inline) return;
  if (e.key === '?') {
    e.preventDefault();
    keySheet.toggle();
  } else if (keySheet.isOpen()) return;
  else if (k === 'c' && !e.shiftKey) {
    const sel = window.getSelection();
    const onHeading = /^H[1-6]$/.test((e.target as Element).tagName) && doc.contains(e.target as Node);
    if (onHeading || (sel && !sel.isCollapsed && sel.rangeCount && doc.contains(sel.getRangeAt(0).commonAncestorContainer))) {
      e.preventDefault();
      commentOnSelection();
    }

  } else if (e.key === ']' || e.key === '[') redlines.step(e.key === ']' ? 1 : -1);
  else if (k === 'j' || k === 'n') navigate(1);
  else if (k === 'k' || k === 'p') navigate(-1);
  else if (e.key === '/') {
    e.preventDefault();
    search.open();
  } else if (k === 'r' && activeId) {
    e.preventDefault();
    // Claude's untriaged drafts have no thread yet: Keep, Do it or Discard comes first.
    if (comments.some((c) => c.id === activeId && isAgentDraft(c))) return toast('Keep this comment first, then reply to it.');
    setSidebarOpen(true);
    openReplies.add(activeId);
    renderSidebar();
    (sidebar.querySelector(`.mdr-card[data-id="${activeId}"] textarea`) as HTMLTextAreaElement)?.focus();
  }
});
showResolvedBox.addEventListener('change', () => {
  showResolved = showResolvedBox.checked;
  revealed = null;
  vscode.setState({ ...(vscode.getState() || {}), showResolved });
  paintComments();
});

// Collapsible comments pane; the choice is remembered per editor.
function setSidebarOpen(open: boolean, preserve = true) {
  const changed = open === document.body.classList.contains('mdr-side-collapsed');
  const restore = liveReady && changed && preserve ? live.keepReadingPlace(activeId) : null;
  if (liveReady) threadPopover.close();
  document.body.classList.toggle('mdr-side-collapsed', !open);
  sideToggle.textContent = open ? '' : 'Comments';
  sideToggle.setAttribute('aria-label', open ? 'Hide comments' : 'Show comments');
  sideToggle.title = tip(open ? 'Hide the comments pane' : 'Show the comments pane', 'Mod+Alt+P');
  sideToggle.setAttribute('aria-expanded', String(open));
  vscode.setState({ ...(vscode.getState() || {}), sidebarOpen: open });
  restore?.();
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
let inline: { el: HTMLElement; ls: number; le: number; kind: string; oldText: string; oldHtml: string; saving: boolean } | null = null;
let nextInline: { ls: string; tag: string; offset: number } | null = null;
let nextSelection: { ls: string; tag: string; start: number; end: number } | null = null;

/** Save newly typed words before anchoring a comment to them. */
function saveSelection(): boolean {
  if (!inline || inline.el.textContent === inline.oldText) return false;
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!inline.el.contains(range.commonAncestorContainer)) return false;
  const before = range.cloneRange();
  before.selectNodeContents(inline.el);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  nextSelection = { ls: String(inline.ls), tag: inline.el.tagName, start, end: start + range.toString().length };
  commitInline();
  return true;
}

/** Capture a caret as a text offset, so a saved block can be rendered again. */
function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !el.contains(sel.focusNode)) return 0;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.setEnd(sel.focusNode!, sel.focusOffset);
  return range.toString().length;
}
function placeCaret(el: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const n = node.textContent!.length;
    if (offset <= n) {
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    offset -= n;
  }
}

function canInline(el: HTMLElement): boolean {
  if (!INLINE_KIND[el.tagName]) return false;
  // Citations and cross-refs show generated text, so those blocks edit as source.
  return !el.querySelector('img, .katex, pre, .mdr-wrap, ul, ol, table, input, .mdr-ui');
}

function startEdit(el: HTMLElement, raw = false) {
  if (editing || inline) return;
  hidePop();
  editBtn.hidden = true;
  secBtn.hidden = true;
  redlines.clearIn(el);
  if (!raw && canInline(el)) return startInline(el);
  window.getSelection()?.removeAllRanges();
  post({ type: 'getBlock', ls: Number(el.dataset.ls), le: Number(el.dataset.le) });
  el.classList.add('mdr-pending');
}

/** The top-level block holding `el`. */
function topBlock(el: Element): Element {
  while (el.parentElement && el.parentElement !== doc) el = el.parentElement;
  return el;
}

const sameBlocks = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function startInline(el: HTMLElement, caretAtEnd = false) {
  if (editing || inline) return;
  editBtn.hidden = true;
  secBtn.hidden = true;
  redlines.clearIn(el);
  docStale = true;
  touched.add(topBlock(el));
  inline = { el, ls: Number(el.dataset.ls), le: Number(el.dataset.le), kind: INLINE_KIND[el.tagName], oldText: el.textContent || '', oldHtml: el.innerHTML, saving: false };
  el.contentEditable = 'true';
  el.spellcheck = true;
  el.classList.add('mdr-inline-editing');
  const offset = caretOffset(el);
  el.focus();
  placeCaret(el, offset);
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
  else if (restore) redlines.apply();
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
  if (e.isComposing) return;
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
doc.addEventListener('input', () => { if (inline) hidePop(); });
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
  const leaving = inline;
  if (leaving && e.target === leaving.el) setTimeout(() => {
    if (inline === leaving) commitInline();
  }, 0);
});

// A single click edits; a drag or double-click remains a normal text selection.
// Wait for the click's selection before enabling contenteditable, so reading and
// commenting do not require a separate mode.
doc.addEventListener('click', (e) => {
  if (editing || e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
  if ((e.target as Element).closest('a, button, input, .mdr-ui, .mdr-rl-ui, .mdr-hl')) return;
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed) return;
  const el = (e.target as Element).closest(EDITABLE) as HTMLElement | null;
  if (!el || !canInline(el) || inline?.el === el) return;
  const offset = caretOffset(el);
  if (inline) {
    nextInline = { ls: el.dataset.ls!, tag: el.tagName, offset };
    commitInline();
    if (inline) return;
    nextInline = null;
  }
  hidePop();
  startInline(el);
  placeCaret(el, offset);
});

doc.addEventListener('dblclick', (e) => {
  if (!e.altKey) return; // native word selection
  if ((e.target as Element).closest('.mdr-task, .mdr-rl-ui')) return;
  const el = (e.target as Element).closest(EDITABLE) as HTMLElement | null;
  if (!el || !doc.contains(el)) return;
  if (inline) {
    if (inline.el.textContent !== inline.oldText) return;
    endInline(false);
  }
  startEdit(el, true);
});

// Hover edit (pencil) button in the left gutter of the block under the pointer.
const editBtn = document.getElementById('mdr-edit-btn') as HTMLButtonElement;
let hoverEl: HTMLElement | null = null;
doc.addEventListener('mousemove', (e) => {
  if (editing || inline) return;
  const el = (e.target as Element).closest(EDITABLE) as HTMLElement | null;
  if (!el || !doc.contains(el) || el === hoverEl) return;
  hoverEl = el;
  const r = el.getBoundingClientRect();
  const d = doc.getBoundingClientRect();
  editBtn.hidden = false;
  editBtn.style.top = `${r.top + window.scrollY + 2}px`;
  editBtn.style.left = `${Math.max(4, Math.min(r.left, d.left + 48) - 58)}px`;
  secBtn.hidden = !/^H[1-6]$/.test(el.tagName);
  if (!secBtn.hidden) {
    secBtn.style.top = `${r.top + window.scrollY + Math.max(0, r.height / 2 - 13)}px`;
    secBtn.style.left = `${Math.min(window.innerWidth - 34, d.right + 6)}px`;
  }
});
doc.addEventListener('mouseleave', (e) => {
  const to = (e as MouseEvent).relatedTarget;
  if (to !== editBtn && to !== secBtn) {
    editBtn.hidden = true;
    secBtn.hidden = true;
    hoverEl = null;
  }
});

/** Open the comment box on a heading, for a thread about its whole section. */
function commentOnSection(h: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(h);
  const cap = capture(textMap(doc), range);
  if (!cap || !cap.quote.trim()) return toast('This heading has no text to anchor a comment to.');
  const [lineStart, lineEnd] = sectionLines(h, doc);
  pendingAnchor = { quote: cap.quote, prefix: cap.prefix, suffix: cap.suffix, lineStart, lineEnd, scope: 'section' };
  window.getSelection()?.removeAllRanges();
  placePop(range);
  openCommentBox(parseFloat(pop.style.top));
}

function commentOnDocument() {
  if (editing || inline) return;
  pendingAnchor = { quote: '', prefix: '', suffix: '', lineStart: 0, lineEnd: 0, scope: 'document' };
  window.getSelection()?.removeAllRanges();
  placePop(docCommentBtn);
  openCommentBox(parseFloat(pop.style.top));
  returnFocus = docCommentBtn;
}

const secBtn = document.getElementById('mdr-sec-btn') as HTMLButtonElement;
secBtn.addEventListener('click', () => {
  if (!hoverEl || editing || inline) return;
  secBtn.hidden = true;
  editBtn.hidden = true;
  commentOnSection(hoverEl);
});
secBtn.addEventListener('mouseleave', (e) => {
  if (!doc.contains(e.relatedTarget as Node)) {
    secBtn.hidden = true;
    editBtn.hidden = true;
    hoverEl = null;
  }
});
const docCommentBtn = document.getElementById('mdr-doc-comment') as HTMLButtonElement;
docCommentBtn.addEventListener('click', commentOnDocument);

editBtn.addEventListener('click', () => {
  if (!hoverEl || editing || inline) return;
  const el = hoverEl;
  editBtn.hidden = true;
  secBtn.hidden = true;
  if (canInline(el)) startInline(el, true);
  else startEdit(el, true);
});


function openEditor(ls: number, le: number, text: string) {
  const el = doc.querySelector(`.mdr-pending[data-ls="${ls}"][data-le="${le}"]`) as HTMLElement | null
    || (doc.querySelector(`[data-ls="${ls}"][data-le="${le}"]`) as HTMLElement | null);
  doc.querySelectorAll('.mdr-pending').forEach((x) => x.classList.remove('mdr-pending'));
  if (!el) return;
  docStale = true;
  touched.add(topBlock(el));
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
  else redlines.apply();
}

// ---------------------------------------------------------------- host messages
const canvas = document.getElementById('mdr-canvas')!;
let liveSelection: LiveSelection | null = null;
const live = createLiveEditor(canvas, {
  recovery: saved.liveDraft,
  draft: (value) => vscode.setState({ ...(vscode.getState() || {}), liveDraft: value }),
  send: post,
  status: (message, conflict = false) => {
    const status = document.getElementById('mdr-save-status')!;
    status.textContent = message;
    status.title = message;
    status.classList.toggle('error', conflict);
    document.getElementById('mdr-conflict')!.hidden = !conflict;
  },
  selection: (selection) => {
    liveSelection = selection;
    if (pop.querySelector('textarea')) return;
    if (!selection) return hidePop();
    popAnchor = null;
    pop.innerHTML = `<button class="mdr-primary" data-act="live-comment">Comment</button>`;
    pop.hidden = false;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 330, selection.rect.left))}px`;
    pop.style.top = `${selection.rect.bottom + window.scrollY + 8}px`;
  },
  comment: () => liveComment(),
  thread: (id, keyboard) => openThread(id, keyboard),
  hoverThread: (id, immediate) => threadPopover.hover(id, immediate),
  link: (href) => {
    if (href.startsWith('#')) {
      let id = href.slice(1); try { id = decodeURIComponent(id); } catch {}
      const target = doc.querySelector(`[id="${CSS.escape(id)}"]`);
      if (target) reveal(target, 'center');
    } else if (href) post({ type: 'openLink', href });
  },
  history: (canUndo, canRedo) => { undoBtn.disabled = !canUndo; redoBtn.disabled = !canRedo; },
});
const threadPopover = createThreadPopover({
  get: id => comments.find(c => c.id === id),
  rect: id => live.threadRect(id) || doc.querySelector<HTMLElement>(`.mdr-hl[data-cid="${CSS.escape(id)}"]`)?.getBoundingClientRect() || null,
  reply: (id, body) => post({ type: 'reply', id, body }),
  resolve: (id, status) => post({ type: 'setStatus', id, status }),
  sidebar: id => activate(id, false, true),
  edit: id => live.editThread(id),
});
liveReady = true;
function openThread(id: string, keyboard = false) {
  hidePop();
  // A filtered-out thread must still be reachable from its passage.
  const c = comments.find(c => c.id === id);
  if (c && !passes(c, filter, showResolved)) { revealed = id; renderSidebar(); }
  if (document.body.classList.contains('mdr-side-collapsed')) {
    activate(id, false, false);
    threadPopover.show(id, true, keyboard);
  } else {
    threadPopover.close();
    activate(id, false, true);
  }
}
function liveComment() {
  const selected = live.selection() || liveSelection;
  if (!selected) return toast('Select a passage to comment on it.');
  if (live.conflicted) return toast('Copy your writing and resolve the file conflict before commenting.', true);
  live.whenSaved(() => {
    pendingAnchor = { quote: selected.quote, prefix: '', suffix: '', lineStart: selected.lineStart, lineEnd: selected.lineEnd };
    // Context from the rendered source disambiguates repeated quotations.
    const map = textMap(doc);
    const block = doc.querySelector(`[data-ls="${selected.lineStart - 1}"]`);
    const nodeIndex = block ? map.nodes.findIndex(node => block.contains(node)) : -1;
    const start = nodeIndex < 0 ? 0 : map.starts[nodeIndex];
    const at = map.text.indexOf(selected.quote, start);
    if (at >= 0) {
      pendingAnchor.prefix = map.text.slice(Math.max(0, at - 32), at);
      pendingAnchor.suffix = map.text.slice(at + selected.quote.length, at + selected.quote.length + 32);
    }
    popAnchor = null;
    pop.hidden = false;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 330, selected.rect.left))}px`;
    openCommentBox(selected.rect.bottom + window.scrollY + 8);
  });
}
const conflictCopy = document.getElementById('mdr-copy-draft')!;
conflictCopy.addEventListener('click', () => copyText(live.text()).then(ok => toast(ok ? 'Your writing is on the clipboard.' : 'Could not copy your writing.', !ok)));
document.getElementById('mdr-load-disk')!.addEventListener('click', () => {
  // Keep a local recovery copy even when the user chooses the external version.
  vscode.setState({ ...(vscode.getState() || {}), recoveredWriting: live.text() });
  live.reload();
});
function showCanvas() {
  const reviewing = redlines.isOn();
  canvas.hidden = reviewing;
  doc.hidden = !reviewing;
}
new MutationObserver(showCanvas).observe(document.getElementById('mdr-changes-btn')!, { attributes: true, attributeFilter: ['aria-pressed'] });
// Existing navigation/health controls identify rendered source lines. Route
// those jumps into the persistent editor instead of the rendering mirror.
doc.addEventListener('mdr-reveal', (event) => {
  if (!doc.hidden) return;
  const target = event.target as HTMLElement;
  const line = target.closest('[data-ls]')?.getAttribute('data-ls');
  if (line !== null && line !== undefined) { event.preventDefault(); live.jump(Number(line) + 1); }
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  switch (m?.type) {
    case 'render':
      live.receive(m.source ?? '', m.blocks);
      targets = m.targets || null;
      if (m.changes !== undefined) redlines.set(m.changes as Changes | null, false, !!m.changesFailed);
      // The host re-sends identical HTML often (e.g. twice after a block save);
      // skip the re-render when the view already shows it.
      if (sameBlocks(m.blocks, blocks) && painted && !docStale && !deferredPaint) {
        if (m.changes !== undefined) redlines.apply();
        if (m.fileName !== fileName) {
          fileName = m.fileName;
          renderSidebar();
        }
      } else {
        blocks = m.blocks;
        fileName = m.fileName;
        paint();
      }
      if (nextSelection && !inline && !editing) {
        const next = nextSelection;
        nextSelection = null;
        const el = doc.querySelector(`${next.tag}[data-ls="${next.ls}"]`) as HTMLElement | null;
        if (el) {
          placeCaret(el, next.start);
          const begin = window.getSelection()!.getRangeAt(0).cloneRange();
          placeCaret(el, next.end);
          const sel = window.getSelection()!;
          begin.setEnd(sel.focusNode!, sel.focusOffset);
          sel.removeAllRanges();
          sel.addRange(begin);
          commentOnSelection();
        }
      }
      if (nextInline && !inline && !editing) {
        const next = nextInline;
        nextInline = null;
        const el = doc.querySelector(`${next.tag}[data-ls="${next.ls}"]`) as HTMLElement | null;
        if (el && canInline(el)) {
          startInline(el);
          placeCaret(el, next.offset);
        }
      }
      if (!(saved as any)._restored) {
        (saved as any)._restored = true;
        if (saved.position) restorePosition(saved.position);
        else if (saved.scrollY) window.scrollTo(0, saved.scrollY);
      }
      break;
    case 'sourceSaved':
      live.saved(m.seq, m.source);
      break;
    case 'sourceConflict':
      live.failed(m.seq, m.message);
      break;
    case 'comments':
      comments = m.data.comments || [];
      live.setThreads(comments);
      threadPopover.refresh();
      author = m.author;
      // A remembered From Claude filter with nothing left to triage opens on All instead.
      if (!commentsSeen && filter.status === 'agent' && !comments.some(isAgentDraft)) setFilter({ status: 'all' }, false);
      commentsSeen = true;
      showResolved = (vscode.getState() || {}).showResolved ?? m.showResolved;
      paintComments();
      break;
    case 'block':
      if (doc.hidden) live.jump(m.ls + 1);
      else openEditor(m.ls, m.le, m.text);
      break;
    case 'blockSaved':
      endInline(false);
      closeEditor();
      // Saving is automatic; keep the reading surface quiet.
      break;
    case 'error':
      nextInline = null;
      nextSelection = null;
      doc.querySelectorAll('.mdr-pending').forEach((x) => x.classList.remove('mdr-pending'));
      toast(m.message, true);
      endInline(true);
      if (/changed on disk/.test(m.message)) closeEditor();
      break;
    case 'history':
      if (redlines.isOn()) { undoBtn.disabled = !m.canUndo; redoBtn.disabled = !m.canRedo; }
      break;
    case 'toast':
      toast(m.message);
      break;
    case 'linkCheck':
      health.linkResult(m.missing || [], m.seq);
      break;
    case 'round':
      round = m.round;
      showWorking();
      break;
    case 'review':
      review = m.review;
      showWorking();
      break;
    case 'changes':
      redlines.set(m.changes, true, !!m.failed);
      break;
    case 'baseline': {
      const key = (b: typeof baseInfo) => (b?.changed ? b.at + b.threads.join() + '|' + (b.touched?.join() ?? '*') : '');
      const had = key(baseInfo);
      baseInfo = m.info;
      // Cards only change when Show change can appear or go.
      if (key(baseInfo) !== had) renderSidebar();
      break;
    }
    case 'agentPrompt':
      copyText(m.prompt).then((ok) =>
        toast(
          !ok ? 'Could not copy the prompt.'
          : m.review ? `Review prompt (${m.review}) copied. Paste it into Claude Code.`
          : `Prompt for ${m.count} thread${m.count > 1 ? 's' : ''} copied. Paste it into Claude Code.`,
          !ok,
        ),
      );
      break;
    case 'reviewers':
      reviewMenu.setReviewers(m.presets || []);
      break;
    case 'prefs':
      reading.apply(m.prefs || {});
      live.refreshTheme();
      void diagrams.refresh(); // a reading theme can switch light/dark
      break;
    case 'command':
      runCommand(m.command);
      break;
    case 'focusThread':
      focusThread(m.id);
      break;
    case 'inlineFailed': {
      if (doc.hidden) { live.jump(m.ls + 1); toast('This change needs a Markdown edit. Edit the text here in the canvas.', true); break; }
      nextInline = null;
      nextSelection = null;
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
  syncPop();
  clearTimeout(scrollT);
  scrollT = setTimeout(() => vscode.setState({ ...(vscode.getState() || {}), scrollY: window.scrollY, position: readingPosition() }), 200);
});

void author;
post({ type: 'ready' });
