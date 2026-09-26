import { Annotation, ChangeSet, EditorSelection, EditorState, StateEffect, StateField, Range, Transaction, Compartment } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, keymap, WidgetType, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
import { markdown, markdownLanguage, insertNewlineContinueMarkupCommand, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import MarkdownIt from 'markdown-it';
import { createDiagrams } from './diagrams';
import type { SourceChange } from '../src/sourceEdit';

const remote = Annotation.define<boolean>();
const refresh = StateEffect.define<null>();
const focused = StateEffect.define<boolean>();
const focusState = StateField.define({ create: () => false, update: (v, tr) => tr.effects.reduce((v, e) => e.is(focused) ? e.value : v, v) });
const parser = new MarkdownIt({ html: false });
interface Rich { from: number; to: number; html: string }
interface Thread { id: string; anchor: { quote: string; lineStart: number; lineEnd: number }; status: string }
export interface LiveSelection { quote: string; lineStart: number; lineEnd: number; rect: { left: number; bottom: number } }
export interface Draft { original: string; text: string; changes: SourceChange[] }
export interface LiveOptions {
  recovery?: Draft;
  draft(value: Draft | null): void;
  send(m: unknown): void;
  status(message: string, conflict?: boolean): void;
  selection(s: LiveSelection | null): void;
  comment(): void;
  thread(id: string): void;
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
  let waiting: (() => void)[] = [];
  let recovery = options.recovery;
  const historySlot = new Compartment();

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
    for (const thread of threads) {
      if (thread.status === 'resolved') continue;
      const start = state.doc.line(Math.max(1, Math.min(state.doc.lines, thread.anchor.lineStart || 1))).from;
      const end = state.doc.line(Math.max(1, Math.min(state.doc.lines, thread.anchor.lineEnd || 1))).to;
      const source = state.doc.toString();
      const matches: number[] = [];
      if (thread.anchor.quote) for (let at = source.indexOf(thread.anchor.quote); at >= 0; at = source.indexOf(thread.anchor.quote, at + 1)) matches.push(at);
      const found = matches.sort((a, b) => Math.abs(a - start) - Math.abs(b - start))[0] ?? -1;
      const from = found < 0 ? start : found;
      const to = found < 0 ? end : from + thread.anchor.quote.length;
      if (from < to && !widgets.some(r => from < r.to && to > r.from)) out.push(Decoration.mark({ class: 'mdr-live-comment', attributes: { 'data-thread': thread.id } }).range(from, to));
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
    return { quote, lineStart: view.state.doc.lineAt(from).number, lineEnd: view.state.doc.lineAt(to).number, rect };
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
  const view = new EditorView({ parent, state: EditorState.create({ extensions: [
    focusState, preview, markdown({ base: markdownLanguage, addKeymap: false }), historySlot.of(history()), drawSelection(), EditorView.lineWrapping,
    search({ top: true }),
    keymap.of([
      { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
      { key: 'Backspace', run: deleteMarkupBackward },
      { key: 'Mod-Alt-m', run: () => { options.comment(); return true; } },
      { key: 'Mod-s', run: () => { flush(); return true; } },
      ...historyKeymap, ...searchKeymap, ...defaultKeymap,
    ]),
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown document', spellcheck: 'true' }),
    EditorView.domEventHandlers({
      focus: () => { view.dispatch({ effects: focused.of(true) }); },
      blur: () => { view.dispatch({ effects: focused.of(false) }); flush(); },
      compositionend: () => { timer = setTimeout(flush, 600); },
      mouseup: () => { setTimeout(() => options.selection(currentSelection()), 0); },
      click: event => {
        const a = (event.target as Element).closest('a');
        if (a) { event.preventDefault(); options.link(a.getAttribute('href') || ''); return true; }
        const id = (event.target as Element).closest('[data-thread]')?.getAttribute('data-thread'); if (id) options.thread(id); },
    }),
    EditorView.updateListener.of(update => {
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
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--doc-accent) 20%, transparent)' },
      '.cm-panels': { backgroundColor: 'var(--doc-bg)', color: 'var(--doc-fg)', border: '1px solid var(--doc-rule)' },
    }),
  ] }) });
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
      newest = source;
      if (source === flight?.source) return; // watcher notification before the acknowledgement
      if (baseline === null || (source !== baseline && !flight && pending.empty && !conflict)) {
        baseline = source; pending = ChangeSet.empty(source.length); rich = [];
        const anchor = Math.min(view.state.selection.main.head, source.length);
        view.dispatch({ effects: historySlot.reconfigure([]) });
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source }, selection: { anchor }, annotations: [remote.of(true), Transaction.addToHistory.of(false)] });
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
    undo: () => undo(view), redo: () => redo(view), find: () => openSearchPanel(view),
    refreshTheme: drawDiagrams,
    setThreads(value: Thread[]) { threads = value; view.dispatch({ effects: refresh.of(null) }); },
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
