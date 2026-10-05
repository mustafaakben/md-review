import { Annotation, ChangeSet, EditorSelection, EditorState, StateEffect, StateField, Range, Transaction, Compartment } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, keymap, WidgetType, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { markdown, markdownLanguage, insertNewlineContinueMarkupCommand, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { externalChanges } from './textChanges';
import { ThreadRangeCache, sameThreadDecorations, needsPreviewParse } from './threadRanges';
import MarkdownIt from 'markdown-it';
import { createDiagrams } from './diagrams';
import { isMac } from './keys';
import type { SourceChange } from '../src/sourceEdit';

const remote = Annotation.define<boolean>();
const refresh = StateEffect.define<null>();
const focused = StateEffect.define<boolean>();
const focusState = StateField.define({ create: () => false, update: (v, tr) => tr.effects.reduce((v, e) => e.is(focused) ? e.value : v, v) });
const parser = new MarkdownIt({ html: false });
interface Rich { from: number; to: number; html: string }
interface Thread { id: string; anchor: { quote: string; lineStart: number; lineEnd: number }; status: string; scope?: string }
export interface LiveSelection { quote: string; lineStart: number; lineEnd: number; rect: { left: number; right: number; top: number; bottom: number }; atLineEnd: boolean }
export interface Draft { original: string; text: string; changes: SourceChange[] }
export interface LiveOptions {
  recovery?: Draft;
  draft(value: Draft | null): void;
  send(m: unknown): void;
  status(message: string, conflict?: boolean): void;
  selection(s: LiveSelection | null): void;
  comment(): void;
  thread(id: string, keyboard?: boolean): void;
  hoverThread(id: string | null, immediate?: boolean): void;
  link(href: string): void;
  history(undo: boolean, redo: boolean): void;
}
class Preview extends WidgetType {
  constructor(readonly html: string, readonly from: number) { super(); }
  eq(other: Preview) { return this.html === other.html && this.from === other.from; }
  toDOM(view: EditorView) {
    const el = document.createElement('div');
    el.className = 'mdr-rich';
    el.innerHTML = this.html;
    el.addEventListener('mousedown', (event) => {
      if ((event.target as Element).closest('a')) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() { return false; }
}

export function createLiveEditor(parent: HTMLElement, options: LiveOptions) {
  const diagrams = createDiagrams(parent);
  let diagramFrame = 0;
  const drawDiagrams = () => { cancelAnimationFrame(diagramFrame); diagramFrame = requestAnimationFrame(() => void diagrams.refresh()); };
  new MutationObserver(drawDiagrams).observe(parent, { childList: true, subtree: true });
  let baseline: string | null = null;
  let pending = ChangeSet.empty(0);
  let flight: { seq: number; source: string; changes: ChangeSet } | null = null;
  let seq = 0;
  let conflict = false;
  let newest = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rich: Rich[] = [];
  let threads: Thread[] = [];
  let activeThread: string | null = null;
  const rangeCache = new ThreadRangeCache();
  let threadRanges: ReadonlyMap<string, { from: number; to: number }> = new Map();
  let commentGesture = false;
  let hoveredThread: string | null = null;
  let waiting: (() => void)[] = [];
  let recovery = options.recovery;
  const historySlot = new Compartment();
  type ReadingPlace = { pos: number; top?: number; scrollY: number; selection: EditorSelection };
  const reflowPlaces = new Set<ReadingPlace>();
  let restoringPlace: ReadingPlace | null = null;
  let restorationToken = 0;
  function cancelRestoration() {
    restorationToken++;
    if (restoringPlace) reflowPlaces.delete(restoringPlace);
    restoringPlace = null;
  }
  let searchReturn: ReadingPlace | null = null;
  let restoreSearchToken = 0;
  function readingPlace(anchorY?: number): ReadingPlace {
    // Consecutive zoom/pinch events share the original anchor until layout settles.
    if (restoringPlace) return { ...restoringPlace, selection: view.state.selection };
    const box = view.contentDOM.getBoundingClientRect();
    const head = view.state.selection.main.head;
    const caret = view.coordsAtPos(head);
    const y = anchorY === undefined ? Math.max(80, box.top + 8) : Math.max(64, Math.min(innerHeight - 16, anchorY));
    // The Aa controls take focus, but a visible writing caret still anchors zoom.
    const pos = anchorY === undefined && caret && caret.top >= 64 && caret.top < innerHeight ? head
      : view.posAtCoords({ x: box.left + 12, y }, false) ?? view.viewport.from;
    return { pos, top: view.coordsAtPos(pos)?.top, scrollY: window.scrollY, selection: view.state.selection };
  }
  function restorePlace(place: ReadingPlace) {
    cancelRestoration();
    restoringPlace = place;
    reflowPlaces.add(place);
    const token = restorationToken;
    const pos = Math.min(place.pos, view.state.doc.length);
    // Bring a virtualized line back before measuring it (a search result or an
    // insertion above the viewport can leave the return point off screen).
    if (!view.coordsAtPos(pos)) view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: place.top ?? 80 }) });
    let remaining = 12, stable = 0;
    const measure = () => {
      if (token !== restorationToken) return;
      view.requestMeasure({
        read: () => place.top === undefined ? place.scrollY - window.scrollY : (view.coordsAtPos(Math.min(place.pos, view.state.doc.length))?.top ?? place.top) - place.top,
        write: delta => {
          if (token !== restorationToken) return;
          if (Math.abs(delta) > 0.5) { window.scrollBy(0, delta); stable = 0; } else stable++;
          if (--remaining && stable < 3) requestAnimationFrame(measure);
          else cancelRestoration();
        },
      });
    };
    requestAnimationFrame(measure);
  }
  function beginSearch(): boolean {
    if (!searchPanelOpen(view.state)) { searchReturn = readingPlace(); restoreSearchToken++; }
    return openSearchPanel(view);
  }

  function decorations(state: EditorState): DecorationSet {
    const out: Range<Decoration>[] = [];
    const sel = state.selection.main;
    const hasFocus = state.field(focusState);
    const active = (from: number, to: number) => hasFocus && sel.from <= to && sel.to >= from;
    const widgets = rich.filter(r => r.to <= state.doc.length && !active(r.from, r.to));
    for (const r of widgets) out.push(Decoration.replace({ widget: new Preview(r.html, r.from), block: true }).range(r.from, r.to));
    const hidden = (from: number, to: number) => widgets.some(r => from >= r.from && to <= r.to);
    const mark = (from: number, to: number, cls: string) => { if (from < to) out.push(Decoration.mark({ class: cls }).range(from, to)); };
    syntaxTree(state).iterate({ enter(node) {
      if (hidden(node.from, node.to)) return false;
      const name = node.name;
      if (/^ATXHeading[1-6]$/.test(name)) {
        out.push(Decoration.line({ class: `mdr-live-h${name.slice(-1)}` }).range(state.doc.lineAt(node.from).from));
      }
      if (name === 'StrongEmphasis') mark(node.from, node.to, 'mdr-live-strong');
      if (name === 'Emphasis') mark(node.from, node.to, 'mdr-live-em');
      if (name === 'Strikethrough') mark(node.from, node.to, 'mdr-live-strike');
      if (name === 'InlineCode') mark(node.from, node.to, 'mdr-live-code');
      if (name === 'Link') mark(node.from, node.to, 'mdr-live-link');
      if (name === 'FencedCode') {
        for (let n = state.doc.lineAt(node.from).number; n <= state.doc.lineAt(node.to).number; n++) out.push(Decoration.line({ class: 'mdr-live-fence' }).range(state.doc.line(n).from));
      }
      if (name === 'Blockquote') {
        for (let n = state.doc.lineAt(node.from).number; n <= state.doc.lineAt(node.to).number; n++) out.push(Decoration.line({ class: 'mdr-live-quote' }).range(state.doc.line(n).from));
      }
      if (['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark', 'URL'].includes(name)) {
        const container = node.node.parent!;
        // URLs in autolinks have no separate label, so leave them visible.
        if (name === 'URL' && container.name !== 'Link') return;
        if (name === 'CodeMark' && container.name === 'FencedCode') return;
        if (active(container.from, container.to)) mark(node.from, node.to, 'mdr-live-syntax');
        else {
          const end = name === 'HeaderMark' && state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
          out.push(Decoration.replace({}).range(node.from, end));
        }
      }
      if (name === 'ListMark') mark(node.from, node.to, 'mdr-live-syntax');
    }});
    threadRanges = rangeCache.resolve(state.doc, threads);
    for (const thread of threads) {
      const range = threadRanges.get(thread.id);
      if (!range) continue;
      const { from, to } = range;
      if (thread.status === 'resolved' && thread.id !== activeThread) continue;
      if (!widgets.some(r => from < r.to && to > r.from)) out.push(Decoration.mark({ class: 'mdr-live-comment' + (activeThread === thread.id ? ' active' : ''), attributes: { 'data-thread': thread.id, role: 'button', 'aria-keyshortcuts': 'Alt+Enter', 'aria-label': 'Read comment on ' + thread.anchor.quote.slice(0, 80) } }).range(from, to));
    }
    return Decoration.set(out, true);
  }
  const preview = StateField.define<DecorationSet>({
    create: decorations,
    update: (value, tr) => {
      if (tr.docChanged) rich = rich.filter(r => !tr.changes.touchesRange(r.from, r.to)).map(r => ({ ...r, from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) }));
      return tr.docChanged || tr.selection || tr.effects.length ? decorations(tr.state) : value;
    },
    provide: f => EditorView.decorations.from(f),
  });
  function currentSelection(): LiveSelection | null {
    const { from, to } = view.state.selection.main;
    if (from === to) return null;
    const holder = document.createElement('div');
    holder.innerHTML = parser.render(view.state.sliceDoc(from, to));
    const quote = holder.textContent?.trim() || '';
    const rect = view.coordsAtPos(to);
    if (!quote || !rect) return null;
    return { quote, lineStart: view.state.doc.lineAt(from).number, lineEnd: view.state.doc.lineAt(to).number, rect, atLineEnd: !view.state.sliceDoc(to, view.state.doc.lineAt(to).to).trim() };
  }
  function remember() {
    if (baseline === null) return;
    const changes: SourceChange[] = [];
    const all = flight ? flight.changes.compose(pending) : pending;
    all.iterChanges((from, to, _f, _t, inserted) => changes.push({ from, to, insert: inserted.toString() }));
    options.draft(changes.length ? { original: baseline, text: view.state.doc.toString(), changes } : null);
  }
  function drain() {
    if (!pending.empty || flight || conflict) return;
    const jobs = waiting; waiting = [];
    jobs.forEach(fn => fn());
  }
  function flush() {
    clearTimeout(timer);
    if (baseline === null || pending.empty || flight || conflict || view.composing) return drain();
    const changes: SourceChange[] = [];
    pending.iterChanges((from, to, _f, _t, inserted) => changes.push({ from, to, insert: inserted.toString() }));
    flight = { seq: ++seq, source: view.state.doc.toString(), changes: pending };
    pending = ChangeSet.empty(view.state.doc.length);
    options.status('Saving…');
    options.send({ type: 'saveSource', seq, original: baseline, changes });
  }
  const view: EditorView = new EditorView({ parent, state: EditorState.create({ extensions: [
    focusState, preview, markdown({ base: markdownLanguage, addKeymap: false }), historySlot.of(history()), drawSelection(), EditorView.lineWrapping,
    search({ top: true }),
    EditorState.phrases.of({ next: 'Next', previous: 'Previous', all: 'Select all', 'match case': 'Match case', regexp: 'Regex', 'by word': 'Whole word', replace: 'Replace', 'replace all': 'Replace all', close: 'Close search' }),
    keymap.of([
      { key: 'Mod-f', run: beginSearch },
      { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
      { key: 'Backspace', run: deleteMarkupBackward },
      { key: 'Alt-Enter', run: () => {
        const pos = view.state.selection.main.head;
        const hit = [...threadRanges].find(([, r]) => pos >= r.from && pos <= r.to);
        if (!hit) return false;
        options.thread(hit[0], true); return true;
      } },
      { key: 'Mod-Alt-m', run: () => { options.comment(); return true; } },
      { key: 'Mod-s', run: () => { flush(); return true; } },
      ...historyKeymap, ...searchKeymap, ...defaultKeymap,
    ].map(binding => ({ ...binding, stopPropagation: true }))),
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown document', spellcheck: 'true' }),
    EditorView.domEventHandlers({
      focus: event => {
        if ((event.target as Element).closest('[data-thread]')) return;
        view.dispatch({ effects: focused.of(true) });
      },
      blur: event => {
        if (view.contentDOM.contains(event.relatedTarget as Node)) return;
        view.dispatch({ effects: focused.of(false) }); flush();
      },
      compositionend: () => { timer = setTimeout(flush, 600); },
      mouseup: () => { if (!commentGesture) setTimeout(() => options.selection(currentSelection()), 0); },
      keyup: event => { if (event.key !== 'Escape') options.selection(currentSelection()); },
      mouseover: event => {
        if (commentGesture) return;
        const mark = (event.target as Element).closest('[data-thread]');
        if (mark && !mark.contains(event.relatedTarget as Node)) {
          hoveredThread = mark.getAttribute('data-thread');
          options.hoverThread((isMac ? event.metaKey : event.ctrlKey) ? hoveredThread : null, true);
        }
      },
      mouseout: event => {
        const mark = (event.target as Element).closest('[data-thread]');
        if (mark && !mark.contains(event.relatedTarget as Node)) { hoveredThread = null; options.hoverThread(null); }
      },
      mousedown: event => {
        cancelRestoration();
        // Clicking a new writing position deliberately leaves the search return point.
        if (searchPanelOpen(view.state)) { searchReturn = null; restoreSearchToken++; }
        const id = (event.target as Element).closest('[data-thread]')?.getAttribute('data-thread');
        if (!id || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        event.preventDefault(); commentGesture = true; options.hoverThread(null);
        const x = event.clientX, y = event.clientY;
        const start = view.posAtCoords({ x, y });
        let dragged = false;
        const move = (e: MouseEvent) => {
          if (!dragged && Math.hypot(e.clientX - x, e.clientY - y) < 5) return;
          dragged = true;
          const to = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (start !== null && to !== null) { view.dispatch({ selection: EditorSelection.range(start, to) }); view.focus(); }
        };
        const up = () => {
          document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
          commentGesture = false;
          if (dragged) options.selection(currentSelection());
          else options.thread(id);
        };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up, { once: true });
        return true;
      },
      click: event => {
        const a = (event.target as Element).closest('a');
        if (a) { event.preventDefault(); options.link(a.getAttribute('href') || ''); return true; }
        const id = (event.target as Element).closest('[data-thread]')?.getAttribute('data-thread');
        if (id && !event.altKey) { event.preventDefault(); if (event.detail === 0) options.thread(id, true); return true; } },
    }),
    EditorView.updateListener.of(update => {
      if (searchReturn && update.docChanged) {
        searchReturn = { ...searchReturn, pos: update.changes.mapPos(searchReturn.pos), selection: searchReturn.selection.map(update.changes) };
      }
      if (update.docChanged) for (const place of reflowPlaces) {
        place.pos = update.changes.mapPos(place.pos); place.selection = place.selection.map(update.changes);
      }
      const searching = searchPanelOpen(update.state);
      const wasSearching = searchPanelOpen(update.startState);
      if (searching && !wasSearching && !searchReturn) {
        searchReturn = { pos: update.startState.selection.main.head, scrollY: window.scrollY, selection: update.startState.selection };
      }
      if (!searching && wasSearching && searchReturn) {
        const place = searchReturn; searchReturn = null;
        const token = ++restoreSearchToken;
        queueMicrotask(() => {
          if (token !== restoreSearchToken || searchPanelOpen(view.state)) return;
          view.dispatch({ selection: place.selection });
          view.focus(); restorePlace(place);
        });
      }
      if (update.docChanged) {
        if (!update.transactions.some(tr => tr.annotation(remote))) {
          pending = pending.compose(update.changes);
          clearTimeout(timer); timer = setTimeout(flush, 600);
          remember();
          options.status(conflict ? 'Unsaved · file changed elsewhere' : 'Unsaved');
        }
        options.selection(null);
      }
      options.history(undoDepth(view.state) > 0, redoDepth(view.state) > 0);
    }),
    EditorView.theme({
      '&': { backgroundColor: 'transparent', color: 'var(--doc-fg)', fontSize: 'inherit' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'var(--doc-leading)', overflow: 'visible' },
      '.cm-content': { padding: '0', caretColor: 'var(--doc-accent)', minHeight: '65vh' },
      '.cm-line': { padding: '0', minHeight: '1.7em' },
      '.cm-cursor': { borderLeftColor: 'var(--doc-accent)' },
      '.cm-panels': { backgroundColor: 'var(--doc-bg)', color: 'var(--doc-fg)', border: '1px solid var(--doc-rule)' },
    }),
  ] }) });
  document.addEventListener('keydown', event => {
    if (event.key === (isMac ? 'Meta' : 'Control') && !event.repeat && hoveredThread && !commentGesture) options.hoverThread(hoveredThread);
  });
  document.addEventListener('keyup', event => {
    if (!(isMac ? event.metaKey : event.ctrlKey)) options.hoverThread(null, true);
  });
  window.addEventListener('blur', () => options.hoverThread(null, true));
  window.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) cancelRestoration();
  }, { passive: true });
  const footer = document.createElement('div');
  footer.className = 'mdr-live-generated';
  parent.appendChild(footer);
  footer.addEventListener('click', event => { const a = (event.target as Element).closest('a'); if (a) { event.preventDefault(); options.link(a.getAttribute('href') || ''); } });
  return {
    view, flush, selection: currentSelection,
    get dirty() { return !!flight || !pending.empty; },
    get conflicted() { return conflict; },
    whenSaved(fn: () => void) { waiting.push(fn); flush(); },
    receive(source: string, blocks: string[]) {
      let restore: ReadingPlace | null = null;
      newest = source;
      if (source === flight?.source) return; // watcher notification before the acknowledgement
      if (baseline === null || (source !== baseline && !flight && pending.empty && !conflict)) {
        const initial = baseline === null && view.state.doc.length === 0;
        const changes = ChangeSet.of(externalChanges(view.state.doc.toString(), source), view.state.doc.length);
        if (!initial) { restore = readingPlace(); restore.pos = changes.mapPos(restore.pos); }
        const selection = initial ? EditorSelection.cursor(0) : view.state.selection.map(changes);
        baseline = source; pending = ChangeSet.empty(source.length); rich = [];
        view.dispatch({ effects: historySlot.reconfigure([]) });
        view.dispatch({ changes, selection, annotations: [remote.of(true), Transaction.addToHistory.of(false)] });
        view.dispatch({ effects: historySlot.reconfigure(history()) });
        options.status('Saved');
        if (recovery) {
          const draft = recovery; recovery = undefined;
          if (draft.text !== source) {
            baseline = draft.original;
            pending = ChangeSet.of(draft.changes, draft.original.length);
            rich = [];
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft.text }, annotations: [remote.of(true), Transaction.addToHistory.of(false)] });
            conflict = draft.original !== source;
            options.status(conflict ? 'Recovered your writing; the file changed elsewhere.' : 'Recovered unsaved writing', conflict);
            if (!conflict) timer = setTimeout(flush, 600);
            return;
          }
          options.draft(null);
        }
      } else if (source !== baseline && !conflict) {
        conflict = true;
        options.status('File changed elsewhere. Your writing is preserved here.', true);
        return;
      }
      if (source !== view.state.doc.toString()) return;
      rich = [];
      const generated: string[] = [];
      for (const html of blocks) {
        if (!needsPreviewParse(html)) continue;
        const holder = document.createElement('div'); holder.innerHTML = html;
        for (const extra of Array.from(holder.querySelectorAll('.mdr-refs, section.footnotes'))) generated.push(extra.outerHTML);
        const block = holder.firstElementChild as HTMLElement | null;
        if (!block || !holder.querySelector('table, pre, .katex, img, .mdr-front, .mdr-cite, .mdr-xref')) continue;
        const ls = Number(block.dataset.ls); const le = Number(block.dataset.le);
        if (!Number.isInteger(ls) || !Number.isInteger(le) || le <= ls || ls >= view.state.doc.lines) continue;
        const from = view.state.doc.line(ls + 1).from;
        const to = view.state.doc.line(Math.min(le, view.state.doc.lines)).to;
        if (to > from) rich.push({ from, to, html });
      }
      const html = generated.join('');
      if (footer.innerHTML !== html) footer.innerHTML = html;
      view.dispatch({ effects: refresh.of(null) });
      if (restore) restorePlace(restore);
    },
    saved(id: number, source: string) {
      if (flight?.seq !== id) return;
      baseline = source; flight = null;
      remember();
      options.status(pending.empty ? 'Saved' : 'Unsaved');
      flush(); drain();
    },
    failed(id: number, message: string) {
      if (flight?.seq !== id) return;
      conflict = true; options.status(message, true); waiting = [];
    },
    reload() {
      conflict = false; flight = null; pending = ChangeSet.empty(view.state.doc.length); baseline = null;
      this.receive(newest, []);
      options.draft(null);
    },
    text: () => view.state.doc.toString(),
    undo: () => undo(view), redo: () => redo(view), find: beginSearch,
    refreshTheme: drawDiagrams,
    activateThread(id: string | null, scroll = false) {
      activeThread = id; view.dispatch({ effects: refresh.of(null) });
      const range = id && threadRanges.get(id);
      if (scroll && range) view.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: 'center' }) });
    },
    threadRect(id: string) {
      const marks = Array.from(parent.querySelectorAll<HTMLElement>('[data-thread]')).filter(el => el.dataset.thread === id);
      const mark = marks.find(el => { const r = el.getBoundingClientRect(); return r.bottom > 56 && r.top < innerHeight; });
      return mark?.getBoundingClientRect() || null;
    },
    editThread(id: string) {
      const range = threadRanges.get(id);
      if (range) { view.dispatch({ selection: { anchor: range.from }, effects: EditorView.scrollIntoView(range.from, { y: 'center' }) }); view.focus(); }
    },
    keepReadingPlace(id?: string | null, anchorY?: number) {
      const place = readingPlace(anchorY);
      const passage = id ? threadRanges.get(id) : null;
      const passageTop = passage ? view.coordsAtPos(passage.from)?.top : undefined;
      if (passage && passageTop !== undefined && passageTop >= 56 && passageTop < innerHeight) { place.pos = passage.from; place.top = passageTop; }
      reflowPlaces.add(place);
      return () => { reflowPlaces.delete(place); restorePlace(place); };
    },
    setThreads(value: Thread[]) {
      const changed = !sameThreadDecorations(threads, value);
      threads = value;
      if (changed) view.dispatch({ effects: refresh.of(null) });
    },
    lineTop(line: number) {
      const pos = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from;
      return view.coordsAtPos(pos)?.top ?? (pos < view.viewport.from ? -Infinity : Infinity);
    },
    jump(line: number) {
      const pos = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); view.focus();
    },
  };
}
