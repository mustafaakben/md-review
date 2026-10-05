import type { FromWebview } from '../src/protocol';
// Document health: word counts against the front matter's targets, and a
// panel listing what needs fixing (broken links and images, unknown citation
// keys and cross-refs, orphaned comments, duplicate headings).
//
// Everything here reads the painted DOM after each paint, only when the view
// is idle and a slice at a time, so neither opening a file nor an edit waits
// for it. Blocks a repaint kept aren't counted again. Link targets are checked
// by the host, and only while the panel is open.

import { BlockCount, DocumentCount, fmtCount, fmtWords, readingMinutes, WordCounts } from './words';

export interface WordTargets {
  total?: number;
  /** Heading text as written in the front matter -> words. */
  sections: Record<string, number>;
}
export interface Orphan {
  id: string;
  quote: string;
  body: string;
}

export interface Health {
  /** The document was painted (in full or in part): recount when idle. */
  painted(targets: WordTargets | null): void;
  /** The outline's word count for a heading (HTML, may be empty). */
  sectionWords(h: HTMLElement): string;
  setOrphans(list: Orphan[]): void;
  /** The host's answer to link check `seq`: hrefs whose file is missing. */
  linkResult(missing: string[], seq?: number): void;
  toggle(focus?: boolean): void;
}

interface Options {
  doc: HTMLElement;
  button: HTMLElement;
  panel: HTMLElement;
  /** Toolbar text: total words and reading time. */
  wordsEl: HTMLElement;
  post(m: FromWebview): void;
  /** Counts changed (the outline shows them). */
  onCounted(): void;
  /** Move an orphaned thread to the current selection. */
  reanchor(id: string): void;
  showThread(id: string): void;
}

interface Item {
  text: string;
  /** Stays the same across re-renders, so focus can come back to the same row. */
  key: string;
  title?: string;
  els?: () => HTMLElement[];
  orphan?: string;
}

interface ThreadLike {
  id: string;
  status: string;
  body: string;
  anchor: { quote: string };
  suggestion?: { appliedAt?: string };
  replies: { suggestion?: { appliedAt?: string } }[];
}

/**
 * Threads to list under Orphaned comments: those whose passage is gone, but
 * not resolved ones or ones whose suggested edit was applied (applying it is
 * what took the passage away).
 */
export function orphanRows(comments: ThreadLike[], isOrphan: (id: string) => boolean): Orphan[] {
  return comments
    .filter((c) => isOrphan(c.id) && c.status !== 'resolved' && !c.suggestion?.appliedAt && !c.replies.some((r) => r.suggestion?.appliedAt))
    .map((c) => ({ id: c.id, quote: c.anchor.quote, body: c.body }));
}

const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Run `fn` when the view is idle, in a slice of at most 8 ms: `more()` says whether this one has time left. */
function idle(fn: (more: () => boolean) => void): number {
  const run = (d?: IdleDeadline) => {
    const end = performance.now() + 8;
    fn(() => performance.now() < end && (!d || d.didTimeout || d.timeRemaining() > 1));
  };
  return typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 1000 }) : window.setTimeout(run, 0);
}
const cancelIdle = (h: number) => (typeof cancelIdleCallback === 'function' ? cancelIdleCallback(h) : clearTimeout(h));

/**
 * Relative link or image source that names a file: not a URL, `//host`, or an
 * in-page anchor. The host's linkPath decides the same way; a Windows drive
 * (`C:/x.md`) is a file, since a URL scheme has two or more letters.
 */
const isFileRef = (h: string | null): h is string => !!h && !/^[a-z][a-z0-9+.-]+:/i.test(h) && !/^(\/\/|#)/.test(h) && !!h.split(/[#?]/)[0];

export function createHealth(o: Options): Health {
  const { doc, button, panel } = o;
  let targets: WordTargets | null = null;
  // The targets by heading key, with the heading as the front matter spells it.
  let sectionTargets = new Map<string, { words: number; name: string }>();
  let counts: WordCounts | null = null;
  let byLine = new Map<string, number>(); // last counts by source line, until the recount lands
  let pending = 0;
  let counting: DocumentCount | null = null;
  // Kept across paints: a repaint that keeps a block keeps its element, so it isn't counted again.
  const blockCounts = new WeakMap<Node, BlockCount>();
  let found: { group: string; items: Item[] }[] = [];
  let orphans: Orphan[] = [];
  // null: not checked since the last paint; 'checking': asked the host.
  let links: string[] | null | 'checking' = null;
  let linkSeq = 0;
  let domCount = 0;

  const over = (h: HTMLElement, n: number) => {
    const t = sectionTargets.get(key(h.textContent || ''))?.words;
    return t && n > t ? t : 0;
  };

  // After the count, each of these runs in an idle slice of its own.
  const after: (() => void)[] = [
    () => {
      counts = counting!.result();
      counting = null;
      byLine = new Map();
      for (const [h, n] of counts.sections) if (h.dataset.ls) byLine.set(h.dataset.ls, n);
    },
    scan,
    () => {
      showWords();
      o.onCounted();
    },
    () => {
      if (panel.hidden) return;
      render();
      checkLinks();
    },
  ];

  /** Count a slice of the document; once it's all counted, update what shows the counts, a slice each. */
  function run(more: () => boolean) {
    pending = 0;
    counting ??= new DocumentCount(doc, blockCounts);
    if (!counting.step(more)) {
      pending = idle(run);
      return;
    }
    let i = 0;
    const next = () => {
      pending = 0;
      after[i++]();
      if (i < after.length) pending = idle(next);
    };
    pending = idle(next);
  }

  function showWords() {
    const n = counts?.total || 0;
    o.wordsEl.hidden = !n;
    const t = targets?.total;
    o.wordsEl.textContent = `${fmtWords(n)} · ${readingMinutes(n)} min`;
    o.wordsEl.classList.toggle('over', !!t && n > t);
    o.wordsEl.title = (t ? `${fmtCount(n)} / ${fmtWords(t)}` : fmtWords(n)) + ` · about ${readingMinutes(n)} min to read`;
  }

  /** Everything the DOM alone can tell. */
  function scan() {
    const group = (sel: string, name: (el: HTMLElement) => string) => {
      const m = new Map<string, HTMLElement[]>();
      doc.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        const k = name(el);
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(el);
      });
      return m;
    };
    const live = (sel: string, name: (el: HTMLElement) => string, k: string) => () => [...group(sel, name).get(k) || []];
    const out: typeof found = [];
    const add = (g: string, items: Item[]) => items.length && out.push({ group: g, items });

    const citeName = (el: HTMLElement) => (el.textContent || '').replace(/\?$/, '');
    add('Unknown citation keys', [...group('.mdr-cite-missing', citeName)].map(([k, els]) => ({
      text: `@${k}${els.length > 1 ? ` (${els.length}×)` : ''}`, key: `cite:${k}`, title: els[0].title, els: live('.mdr-cite-missing', citeName, k),
    })));
    add('Bibliography', Array.from(doc.querySelectorAll<HTMLElement>('.mdr-refs-warn')).filter((el) => /^Couldn't read/.test(el.textContent || '')).map((el) => ({
      text: el.textContent || '', key: `bib:${el.textContent}`, els: () => Array.from(doc.querySelectorAll<HTMLElement>('.mdr-refs-warn')).slice(0, 1),
    })));
    const xrefName = (el: HTMLElement) => (el.textContent || '').replace(/^¿|\?$/g, '');
    add('Unresolved cross-references', [...group('.mdr-xref-missing', xrefName)].map(([k, els]) => ({
      text: `@${k}${els.length > 1 ? ` (${els.length}×)` : ''}`, key: `xref:${k}`, title: els[0].title, els: live('.mdr-xref-missing', xrefName, k),
    })));
    const headName = (h: HTMLElement) => key(h.textContent || '');
    const docHeads = () => Array.from(doc.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).filter((h) => !h.closest('.mdr-ui') && headName(h));
    const heads = docHeads();
    const byName = new Map<string, HTMLElement[]>();
    for (const h of heads) byName.set(headName(h), [...(byName.get(headName(h)) || []), h]);
    add('Duplicate headings', [...byName].filter(([, els]) => els.length > 1).map(([k, els]) => ({
      text: `${clip((els[0].textContent || '').trim(), 60)} (${els.length}×)`, key: `dup:${k}`,
      els: () => docHeads().filter((h) => headName(h) === k),
    })));
    // Word targets: sections over theirs, and targets naming no heading.
    const words: Item[] = [];
    const total = targets?.total;
    if (counts && total && counts.total > total) words.push({ text: `Whole document: ${fmtCount(counts.total)} / ${fmtWords(total)}`, key: 'words:' });
    if (counts) {
      for (const [h, n] of counts.sections) {
        const t = over(h, n);
        if (t) words.push({ text: `${clip((h.textContent || '').trim(), 40)}: ${fmtCount(n)} / ${fmtWords(t)}`, key: `words:${headName(h)}`, els: () => (h.isConnected ? [h] : []) });
      }
      const named = new Set(heads.map(headName));
      for (const [k, t] of sectionTargets) if (!named.has(k)) words.push({ text: `No heading "${t.name}" for its word target`, key: `nohead:${k}` });
    }
    add('Over word target', words);
    found = out;
    domCount = out.reduce((n, g) => n + g.items.length, 0);
    badge();
  }

  function badge() {
    const n = domCount + orphans.length + (Array.isArray(links) ? links.length : 0);
    let b = button.querySelector('.mdr-health-n') as HTMLElement | null;
    if (!b) {
      b = document.createElement('span');
      b.className = 'mdr-health-n';
      b.setAttribute('aria-hidden', 'true');
      button.appendChild(b);
    }
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = !n;
    const label = `Document health${n ? `: ${plural(n, 'problem')}` : ''}`;
    button.setAttribute('aria-label', label);
    button.title = label + ' (links, citations, orphaned comments, word targets)';
  }

  /** Ask the host which linked files and images are missing. */
  function checkLinks() {
    if (links !== null) return;
    const hrefs = new Set<string>();
    doc.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href');
      if (isFileRef(h) && !a.closest('.mdr-ui')) hrefs.add(h);
    });
    doc.querySelectorAll('img[data-mdr-src]').forEach((i) => hrefs.add(i.getAttribute('data-mdr-src')!));
    if (!hrefs.size) links = [];
    else {
      links = 'checking';
      o.post({ type: 'checkLinks', hrefs: [...hrefs], seq: ++linkSeq });
    }
    render();
  }

  const linkEls = (h: string) => () =>
    Array.from(doc.querySelectorAll<HTMLElement>('a[href], img[data-mdr-src]')).filter((e) => (e.tagName === 'IMG' ? e.dataset.mdrSrc : e.getAttribute('href')) === h);

  // The panel: a heading, the list (redrawn), and a status line read out politely when it changes.
  panel.innerHTML = '<div class="mdr-hp-head"><span>Document health</span><span class="mdr-hp-words"></span></div><div class="mdr-hp-body"></div><div class="mdr-hp-status" role="status" aria-live="polite"></div>';
  const wordsSpan = panel.querySelector('.mdr-hp-words') as HTMLElement;
  const body = panel.querySelector('.mdr-hp-body') as HTMLElement;
  const status = panel.querySelector('.mdr-hp-status') as HTMLElement;

  let items: Item[] = [];
  function render() {
    if (panel.hidden) return;
    const groups = [...found];
    if (Array.isArray(links) && links.length) {
      groups.unshift({ group: 'Broken links and images', items: links.map((h) => ({ text: h, key: `link:${h}`, title: 'No such file', els: linkEls(h) })) });
    }
    if (orphans.length) {
      groups.push({ group: 'Orphaned comments', items: orphans.map((c) => ({ text: `"${clip(c.quote, 80)}"`, key: `orphan:${c.id}`, title: c.body, orphan: c.id })) });
    }
    // Focus comes back to the same row (or its Re-anchor button) after the redraw;
    // when that row is gone, to the one now in its place.
    const act = document.activeElement as HTMLElement | null;
    const had = act && body.contains(act) ? { key: act.closest('li')?.dataset.key, re: act.hasAttribute('data-reanchor'), at: Array.from(body.querySelectorAll('li')).indexOf(act.closest('li')!) } : null;
    items = groups.flatMap((g) => g.items);
    let i = 0;
    const row = (it: Item) => {
      const n = i++;
      const title = it.title ? ` title="${esc(it.title)}"` : '';
      const k = ` data-key="${esc(it.key)}"`;
      // Rows that point at something in the document are buttons; the rest are plain text.
      if (!it.orphan && !it.els) return `<li${k}><span class="mdr-hp-text"${title}>${esc(it.text)}</span></li>`;
      const go = `<button class="mdr-hp-go" data-i="${n}"${title}>${esc(it.text)}</button>`;
      if (!it.orphan) return `<li${k}>${go}</li>`;
      return `<li class="mdr-hp-orphan"${k}>${go}<button class="mdr-hp-reanchor" data-reanchor="${esc(it.orphan)}" title="Select the passage this comment is about, then press this">Re-anchor to selection</button></li>`;
    };
    const n = counts?.total || 0;
    wordsSpan.textContent = n ? `${fmtWords(n)} · ${readingMinutes(n)} min read` : '';
    body.innerHTML = groups
      .map((g, gi) => `<div class="mdr-rp-label" id="mdr-hp-g${gi}">${esc(g.group)}</div><ul class="mdr-hp-list" aria-labelledby="mdr-hp-g${gi}">${g.items.map(row).join('')}</ul>`)
      .join('');
    const note = links === 'checking' ? 'Checking links and images…' : !groups.length ? 'No problems found' : '';
    if (status.textContent !== note) status.textContent = note;
    status.classList.toggle('mdr-hp-ok', note === 'No problems found');

    if (had) {
      const rows = Array.from(body.querySelectorAll<HTMLElement>('li'));
      const same = rows.find((r) => r.dataset.key === had.key);
      // Gone (a re-anchored orphan): the nearest row with a button, the next one first.
      const near = rows.slice(had.at).concat(rows.slice(0, had.at).reverse()).find((r) => r.querySelector('button'));
      const target = same ? same.querySelector(had.re ? '[data-reanchor]' : 'button') : near?.querySelector('button');
      ((target as HTMLElement | null) || panel).focus();
    }
  }

  // Each click on an item shows its next occurrence.
  const turn = new Map<string, number>();
  function show(it: Item) {
    if (it.orphan) return o.showThread(it.orphan);
    const els = it.els?.() || [];
    if (!els.length) return;
    const k = (turn.get(it.key) ?? -1) + 1;
    turn.set(it.key, k);
    const el = els[k % els.length];
    if (!el.dispatchEvent(new CustomEvent('mdr-reveal', { bubbles: true, cancelable: true }))) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('mdr-flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('mdr-flash');
    setTimeout(() => el.classList.remove('mdr-flash'), 1600);
  }

  function close(returnFocus: boolean) {
    if (panel.hidden) return;
    const inside = panel.contains(document.activeElement);
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus || inside) ((button.closest('details:not([open])')?.querySelector('summary') as HTMLElement | null) || button).focus();
  }

  panel.tabIndex = -1; // focusable when it has no buttons
  button.addEventListener('click', () => api.toggle());
  // Keep the document selection alive while pressing a button in the panel.
  panel.addEventListener('mousedown', (e) => {
    if ((e.target as Element).closest('button')) e.preventDefault();
  });
  panel.addEventListener('click', (e) => {
    const t = e.target as Element;
    const re = t.closest('[data-reanchor]')?.getAttribute('data-reanchor');
    if (re) return o.reanchor(re);
    const i = t.closest('[data-i]')?.getAttribute('data-i');
    if (i != null && items[Number(i)]) show(items[Number(i)]);
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  });
  panel.addEventListener('focusout', (e) => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (to && !panel.contains(to) && to !== button) close(false);
  });
  // The document stays usable while the panel is open (select a passage to
  // re-anchor to, read what an item points at); anywhere else closes it.
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as Node;
      if (!panel.hidden && !panel.contains(t) && !button.contains(t) && !doc.contains(t)) close(false);
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Escape' && !panel.hidden && !(t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) close(true);
  });

  const api: Health = {
    painted(t) {
      if (t !== targets) {
        targets = t;
        sectionTargets = new Map();
        for (const [name, words] of Object.entries(t?.sections || {})) sectionTargets.set(key(name), { words, name: name.trim() });
      }
      links = null;
      if (pending) cancelIdle(pending);
      counting = null;
      pending = idle(run);
    },
    sectionWords(h) {
      const n = counts?.sections.get(h) ?? (h.dataset.ls ? byLine.get(h.dataset.ls) : undefined);
      if (n === undefined) return '';
      const t = over(h, n);
      const title = t ? `${fmtCount(n)} / ${fmtWords(t)}` : fmtWords(n);
      const short = n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      return `<span class="mdr-toc-words${t ? ' over' : ''}" title="${title}">${short}</span>`;
    },
    setOrphans(list) {
      const same = list.length === orphans.length && list.every((c, i) => c.id === orphans[i].id && c.quote === orphans[i].quote);
      orphans = list;
      if (same) return;
      badge();
      render();
    },
    linkResult(missing, seq) {
      if (links !== 'checking' || (seq !== undefined && seq !== linkSeq)) return; // a paint, or another question, since
      links = missing;
      badge();
      render();
    },
    toggle(focus = true) {
      if (!panel.hidden) return close(focus);
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      render();
      checkLinks();
      if (focus) ((body.querySelector('button') || panel) as HTMLElement).focus();
    },
  };
  return api;
}
