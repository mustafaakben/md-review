// The Changes view: paints the hunks the host found against the baseline over
// the rendered document. In a changed block, inserted words are underlined and
// deleted ones struck through; blocks with math, code, diagrams or tables get
// a block-level mark and a before/after view instead. Only blocks the host
// reports as changed are word-diffed, and each diff is cached, so a repaint
// after an edit only diffs the block that changed. Nothing here runs, and the
// baseline isn't even sent, until the toggle is used.
import { diffWords, Edit } from '../src/wordDiff';

export interface Block { ls: number; le: number; type: string }
export interface Hunk { kind: 'changed' | 'inserted' | 'deleted'; moved?: boolean; cur?: Block; base?: Block; c: [number, number]; b: [number, number] }
export interface Changes { v: string; at: string; baseHtml?: string; baseId: string; hunks: Hunk[] }

const SKIP = '.katex-mathml, .mdr-ui, .mdr-front-raw, script, style';
/** Blocks shown before/after instead of word by word. */
const WHOLE = 'table, pre, .mdr-wrap, hr';
const HAS_WHOLE = '.katex, img, svg, table, pre, .mdr-wrap';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Elements by their first source line, in document order (outermost first). */
function indexOf(root: ParentNode): Map<number, HTMLElement[]> {
  const m = new Map<number, HTMLElement[]>();
  root.querySelectorAll<HTMLElement>('[data-ls]').forEach((el) => {
    if (el.closest('.mdr-ui')) return;
    const k = Number(el.dataset.ls);
    (m.get(k) || m.set(k, []).get(k)!).push(el);
  });
  return m;
}

/** The element that shows a block: the innermost one starting on its line (a table's <table>, a code block's <pre>). */
function find(idx: Map<number, HTMLElement[]>, b: Block): HTMLElement | null {
  const list = idx.get(b.ls);
  if (!list) return null;
  const el = b.type === 'table' ? list.find((e) => e.tagName === 'TABLE') : list[list.length - 1];
  if (!el) return null;
  return el.tagName === 'CODE' ? el.closest('pre') || el : el;
}

/** The block's own text nodes: not math source, UI, or nested blocks (a list item's sub-list). */
function textNodes(el: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const e = n as Element;
      return e.matches(SKIP) || e.hasAttribute('data-ls') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

const textOf = (el: HTMLElement) => textNodes(el).map((t) => t.data).join('');
const whole = (el: HTMLElement) => el.matches(WHOLE) || !!el.querySelector(HAS_WHOLE);

/** A copy of a baseline block for display: no source lines, ids or live controls. */
function copyOf(el: HTMLElement): HTMLElement {
  const c = document.importNode(el, true) as HTMLElement;
  for (const e of [c, ...Array.from(c.querySelectorAll<HTMLElement>('*'))]) {
    e.removeAttribute('data-ls');
    e.removeAttribute('data-le');
    e.removeAttribute('id');
    if (e instanceof HTMLInputElement) e.disabled = true;
  }
  return c;
}

/**
 * Paint word runs over the block's own text: underline insertions, and put
 * each deletion back in as struck-through text the text map skips (.mdr-ui),
 * so comment anchoring and find see only the current text. Works right to
 * left, so splitting a node never moves an offset still to be painted.
 */
function paintWords(el: HTMLElement, runs: [Edit, string][]): void {
  const nodes = textNodes(el);
  const starts: number[] = [];
  let total = 0;
  for (const n of nodes) {
    starts.push(total);
    total += n.length;
  }
  const ops: { at: number; end: number; del?: string }[] = [];
  let off = 0;
  for (const [e, t] of runs) {
    if (e === -1) ops.push({ at: off, end: off, del: t });
    else {
      if (e === 1) ops.push({ at: off, end: off + t.length });
      off += t.length;
    }
  }
  for (let k = ops.length - 1; k >= 0; k--) {
    const op = ops[k];
    if (op.del !== undefined) {
      const d = document.createElement('del');
      d.className = 'mdr-rl-del mdr-ui mdr-rl-ui';
      d.innerHTML = `<span class="mdr-sr">deleted: </span>${esc(op.del)}`;
      let i = nodes.length - 1;
      while (i > 0 && starts[i] > op.at) i--;
      const n = nodes[i];
      if (!n) el.appendChild(d);
      else if (op.at >= starts[i] + n.length) n.after(d);
      else {
        let ref: Node = op.at > starts[i] ? n.splitText(op.at - starts[i]) : n;
        // Before an insertion that starts here, not inside it.
        const lead = (r: Node) => !r.previousSibling || (r.previousSibling as Element).classList?.contains('mdr-sr');
        while (ref.parentElement?.classList.contains('mdr-rl-ins') && lead(ref)) ref = ref.parentElement;
        ref.parentNode!.insertBefore(d, ref);
      }
      continue;
    }
    let first: HTMLElement | null = null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const ns = starts[i];
      const n = nodes[i];
      if (ns >= op.end || ns + n.length <= op.at) continue;
      const s = Math.max(op.at, ns) - ns;
      const e = Math.min(op.end, ns + n.length) - ns;
      if (!n.data.slice(s, e).trim()) continue; // structural whitespace
      if (e < n.length) n.splitText(e);
      const target = s > 0 ? n.splitText(s) : n;
      const ins = document.createElement('ins');
      ins.className = 'mdr-rl-ins';
      target.parentNode!.insertBefore(ins, target);
      ins.appendChild(target);
      first = ins;
    }
    if (first) first.insertAdjacentHTML('afterbegin', '<span class="mdr-sr mdr-ui">inserted: </span>');
  }
}

export interface Redlines {
  isOn(): boolean;
  setOn(on: boolean): void;
  /** New hunks from the host (null: no baseline). `paint` false when a full repaint follows anyway. */
  set(ch: Changes | null, paint?: boolean): void;
  /** Paint the current hunks over the document (after every full paint). */
  apply(): void;
  /** Remove the redline from one block, before it's edited. */
  clearIn(el: HTMLElement): void;
  step(d: 1 | -1): void;
  /** Scroll to the changes inside a thread's text; turns the view on first if needed. */
  showThread(id: string, lineStart: number, lineEnd: number): void;
}

interface Painted { i: number; el: HTMLElement | null; extras: HTMLElement[] }

export function createRedlines(
  doc: HTMLElement,
  bar: HTMLElement,
  btn: HTMLElement,
  opts: { post(m: unknown): void; canPaint(): boolean; painted(): void; toast(msg: string): void },
): Redlines {
  let on = false;
  let data: Changes | null | undefined; // undefined: not loaded yet
  let base: { id: string; idx: Map<number, HTMLElement[]> } | null = null;
  let cache = new Map<string, [Edit, string][]>();
  let shown: Painted[] = [];
  let current = -1;
  let pending: (() => void) | null = null;
  const before = new Set<number>(); // hunks showing their before view

  bar.innerHTML = `<span class="mdr-rl-status" role="status" aria-live="polite"></span>
    <button data-rlbar="prev" aria-label="Previous change">Previous</button>
    <button data-rlbar="next" aria-label="Next change">Next</button>
    <button data-rlbar="accept" title="Drop the saved copy: everything shown here is accepted">Accept all</button>
    <button data-rlbar="close" class="mdr-rl-close" title="Hide changes" aria-label="Hide changes"></button>`;
  const status = bar.querySelector('.mdr-rl-status') as HTMLElement;

  const when = (iso: string) => {
    const d = new Date(iso);
    return isNaN(+d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const count = () => (data ? data.hunks.filter((h) => !(h.moved && h.kind === 'deleted')).length : 0);

  function renderBar() {
    bar.hidden = !on;
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
    const n = count();
    status.textContent =
      data === undefined ? 'Loading changes…'
      : !data ? 'Nothing to compare yet. Send to Claude saves a copy of the file to compare against.'
      : n ? `${n} changed block${n === 1 ? '' : 's'} since ${when(data.at)}`
      : `No changes since ${when(data.at)}`;
    bar.querySelectorAll<HTMLButtonElement>('[data-rlbar="prev"], [data-rlbar="next"]').forEach((b) => (b.disabled = !n));
    (bar.querySelector('[data-rlbar="accept"]') as HTMLButtonElement).disabled = !data;
  }

  function unpaint(p: Painted) {
    p.extras.forEach((x) => x.remove());
    const el = p.el;
    if (!el) return;
    el.classList.remove('mdr-rl', 'mdr-rl-mod', 'mdr-rl-add', 'mdr-rl-block', 'mdr-rl-moved', 'mdr-rl-current', 'mdr-rl-flash');
    el.querySelectorAll('.mdr-rl-del, .mdr-rl-ins > .mdr-sr').forEach((x) => x.remove());
    const ins = el.querySelectorAll('ins.mdr-rl-ins');
    ins.forEach((x) => x.replaceWith(...Array.from(x.childNodes)));
    if (ins.length) el.normalize();
  }

  function clear() {
    shown.forEach(unpaint);
    shown = [];
  }

  function chip(i: number, what: string, withBefore: boolean): HTMLElement {
    const c = document.createElement('span');
    c.className = 'mdr-rl-acts mdr-ui mdr-rl-ui';
    c.setAttribute('role', 'group');
    c.setAttribute('aria-label', `Change ${i + 1}: ${what}`);
    c.dataset.rlI = String(i);
    const open = before.has(i);
    c.innerHTML = `<span class="mdr-rl-what" aria-hidden="true">${esc(what)}</span>${
      withBefore ? `<button data-rl="before" aria-expanded="${open}">${open ? 'Hide before' : 'Show before'}</button>` : ''
    }<button data-rl="keep" title="Keep this change">Keep</button><button data-rl="revert" title="Put back the text from before">Revert</button>`;
    return c;
  }

  /** Put the actions inside a text block (after its own text), or after a table, code block or diagram. */
  function attach(el: HTMLElement, c: HTMLElement) {
    if (el.matches(WHOLE)) {
      c.classList.add('mdr-rl-after');
      el.after(c);
    } else {
      const nested = Array.from(el.children).find((x) => x.hasAttribute('data-ls'));
      el.insertBefore(c, nested || null);
    }
  }

  function paintHunk(i: number, h: Hunk, cur: Map<number, HTMLElement[]>): Painted {
    const p: Painted = { i, el: null, extras: [] };
    const old = h.base && base ? find(base.idx, h.base) : null;
    if (h.kind === 'deleted') {
      if (!old) return p;
      const box = document.createElement('div');
      box.className = `mdr-ui mdr-rl-ui mdr-rl-gone${h.moved ? ' mdr-rl-moved' : ''}`;
      box.dataset.rlI = String(i);
      const what = h.moved ? 'Moved from here' : 'Deleted';
      const body = document.createElement(h.moved ? 'div' : 'del');
      body.className = 'mdr-rl-old';
      body.innerHTML = h.moved ? '' : '<span class="mdr-sr">deleted: </span>';
      body.appendChild(copyOf(old));
      box.appendChild(body);
      box.appendChild(chip(i, what, false));
      // Before the first block at or after where it was.
      let next: HTMLElement | null = null;
      for (const [ls, list] of cur) if (ls >= h.c[0] && (!next || ls < Number(next.dataset.ls))) next = list[0];
      const ref = next?.tagName === 'CODE' ? next.closest('pre') || next : next;
      if (ref) ref.before(box);
      else doc.appendChild(box);
      p.extras.push(box);
      return p;
    }
    const el = h.cur ? find(cur, h.cur) : null;
    if (!el) return p;
    p.el = el;
    el.classList.add('mdr-rl');
    let what = h.kind === 'inserted' ? (h.moved ? 'Moved here' : 'Added') : 'Changed';
    let runs: [Edit, string][] | null = null;
    if (!h.moved && !whole(el) && (h.kind === 'inserted' || (old && !whole(old)))) {
      const a = h.kind === 'inserted' ? '' : textOf(old!);
      const b = textOf(el);
      const key = a + '\u0001' + b;
      runs = cache.get(key) ?? null;
      if (!runs) cache.set(key, (runs = diffWords(a, b)));
      if (!runs.some(([e]) => e !== 0)) runs = null; // only markup changed
    }
    if (runs) {
      el.classList.add(h.kind === 'inserted' ? 'mdr-rl-add' : 'mdr-rl-mod');
      paintWords(el, runs);
    } else {
      el.classList.add('mdr-rl-block', h.moved ? 'mdr-rl-moved' : h.kind === 'inserted' ? 'mdr-rl-add' : 'mdr-rl-mod');
      if (h.kind === 'changed' && !whole(el) && old && !whole(old)) what = 'Formatting changed';
    }
    const withBefore = h.kind === 'changed' && !runs && !!old;
    const c = chip(i, what, withBefore);
    attach(el, c);
    p.extras.push(c);
    if (withBefore && before.has(i)) {
      const box = document.createElement('div');
      box.className = 'mdr-ui mdr-rl-ui mdr-rl-before';
      box.innerHTML = '<div class="mdr-rl-cap">Before</div>';
      box.appendChild(copyOf(old!));
      el.before(box);
      p.extras.push(box);
    }
    return p;
  }

  const api: Redlines = {
    isOn: () => on,
    setOn(v) {
      if (v === on) return;
      on = v;
      if (!on) {
        clear();
        pending = null;
      } else data = undefined;
      renderBar();
      opts.post({ type: 'showChanges', on });
    },
    set(ch, paint = true) {
      // The baseline comes once per version; parse it once, inert (no images load).
      if (ch?.baseHtml !== undefined && ch.baseId !== base?.id) {
        const tpl = document.createElement('template');
        tpl.innerHTML = ch.baseHtml;
        base = { id: ch.baseId, idx: indexOf(tpl.content) };
        cache = new Map();
      }
      if (data?.v !== ch?.v) before.clear();
      data = ch;
      renderBar();
      if (paint) api.apply();
    },
    apply() {
      clear();
      if (data === null) pending = null; // no baseline: nothing to go to
      if (!on || !data || !opts.canPaint()) return;
      const cur = indexOf(doc);
      shown = data.hunks.map((h, i) => paintHunk(i, h, cur));
      if (current >= data.hunks.length) current = -1;
      opts.painted();
      const run = pending;
      pending = null;
      run?.();
    },
    clearIn(el) {
      shown.filter((p) => p.el && (p.el === el || el.contains(p.el))).forEach(unpaint);
    },
    step(d) {
      if (!on) {
        pending = () => api.step(d);
        return api.setOn(true);
      }
      const n = shown.length;
      if (!n) return;
      current = current < 0 ? (d > 0 ? 0 : n - 1) : (current + d + n) % n;
      focusHunk([current]);
    },
    showThread(id, lineStart, lineEnd) {
      const go = () => {
        const lo = lineStart - 1;
        const hits: number[] = [];
        shown.forEach((p, i) => {
          const h = data!.hunks[i];
          const marked = !!p.el && (p.el.querySelector(`mark.mdr-hl[data-cid="${CSS.escape(id)}"]`) || p.el.closest(`mark.mdr-hl[data-cid="${CSS.escape(id)}"]`));
          // Thread lines were taken before the agent's edit, so they are baseline lines.
          const [bs, be] = h.b;
          const overlaps = lineStart > 0 && (bs === be ? bs >= lo && bs <= lineEnd : bs < lineEnd && be > lo);
          if (marked || overlaps) hits.push(i);
        });
        if (!hits.length) return opts.toast("No changed blocks in this thread's text.");
        focusHunk(hits);
      };
      if (on && data !== undefined) return go();
      pending = go;
      api.setOn(true);
    },
  };

  function targetOf(p: Painted): HTMLElement | null {
    return p.el || p.extras[0] || null;
  }

  function focusHunk(list: number[]) {
    doc.querySelectorAll('.mdr-rl-current, .mdr-rl-flash').forEach((x) => x.classList.remove('mdr-rl-current', 'mdr-rl-flash'));
    const els = list.map((i) => targetOf(shown[i])).filter((x): x is HTMLElement => !!x);
    if (!els.length) return;
    current = list[0];
    els.forEach((x) => x.classList.add('mdr-rl-current', 'mdr-rl-flash'));
    setTimeout(() => els.forEach((x) => x.classList.remove('mdr-rl-flash')), 2500);
    els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    const acts = shown[list[0]].extras.find((x) => x.classList.contains('mdr-rl-acts')) || shown[list[0]].extras[0]?.querySelector('.mdr-rl-acts');
    (acts?.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  doc.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-rl]');
    if (!b || !data) return;
    e.preventDefault();
    const i = Number(b.closest<HTMLElement>('[data-rl-i]')!.dataset.rlI);
    const act = b.dataset.rl;
    if (act === 'before') {
      if (before.has(i)) before.delete(i);
      else before.add(i);
      api.apply();
      (doc.querySelector(`.mdr-rl-acts[data-rl-i="${i}"] [data-rl="before"]`) as HTMLElement | null)?.focus({ preventScroll: true });
      return;
    }
    // Once this one goes away, move to the change that takes its place.
    pending = () => (shown.length ? focusHunk([Math.min(i, shown.length - 1)]) : btn.focus());
    opts.post({ type: act === 'revert' ? 'revertChange' : 'keepChange', v: data.v, i });
  });

  bar.addEventListener('click', (e) => {
    const act = (e.target as Element).closest<HTMLElement>('[data-rlbar]')?.dataset.rlbar;
    if (act === 'prev' || act === 'next') api.step(act === 'next' ? 1 : -1);
    else if (act === 'accept') opts.post({ type: 'acceptChanges' });
    else if (act === 'close') {
      api.setOn(false);
      btn.focus();
    }
  });
  btn.addEventListener('click', () => api.setOn(!on));
  renderBar();
  return api;
}
