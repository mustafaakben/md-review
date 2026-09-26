// Comment kinds (comment / question / praise), severity (major / minor / nit),
// section and document threads, and word snapping for selections.

export type Kind = 'comment' | 'question' | 'praise';
export type Severity = 'major' | 'minor' | 'nit';
export type Scope = 'section' | 'document';

export interface Meta {
  kind?: Kind;
  severity?: Severity;
  scope?: Scope;
}

const KIND_LABEL: Record<Kind, string> = { comment: 'Comment', question: 'Question', praise: 'Praise' };
const KIND_TIP: Record<Kind, string> = {
  comment: 'Asks for a change',
  question: 'Asks for an answer, not an edit',
  praise: 'No action needed',
};
export const SEVERITY_LABEL: Record<Severity, string> = { major: 'Major', minor: 'Minor', nit: 'Nit' };
export const SEVERITIES = Object.keys(SEVERITY_LABEL) as Severity[];

const isKind = (k: unknown): k is Kind => k === 'comment' || k === 'question' || k === 'praise';
const isSeverity = (s: unknown): s is Severity => s === 'major' || s === 'minor' || s === 'nit';

/** Kind and severity chips for the comment box. Severity is optional: none pressed means none. */
export function metaPicker(m: Meta, altLabel: (n: number) => string): string {
  const kind = isKind(m.kind) ? m.kind : 'comment';
  const kinds = (Object.keys(KIND_LABEL) as Kind[])
    .map((k) => `<button type="button" class="mdr-chip mdr-kind-${k}${k === kind ? ' on' : ''}" data-kind="${k}" role="radio" aria-checked="${k === kind}" title="${KIND_TIP[k]}">${KIND_LABEL[k]}</button>`)
    .join('');
  const sevs = SEVERITIES.map(
    (s, i) =>
      `<button type="button" class="mdr-chip mdr-sev-${s}${m.severity === s ? ' on' : ''}" data-severity="${s}" aria-pressed="${m.severity === s}" title="${SEVERITY_LABEL[s]} (${altLabel(i + 1)})">${SEVERITY_LABEL[s]}</button>`,
  ).join('');
  return `<div class="mdr-meta-pick"><div class="mdr-chips" role="radiogroup" aria-label="Kind">${kinds}</div><div class="mdr-chips" role="group" aria-label="Severity">${sevs}</div></div>`;
}

/** Handle a click inside a picker; returns true when it was a chip. */
export function pickerClick(t: Element): boolean {
  const chip = t.closest('.mdr-meta-pick button') as HTMLElement | null;
  if (!chip) return false;
  const pick = chip.closest('.mdr-meta-pick')!;
  if (chip.dataset.kind) {
    pick.querySelectorAll('[data-kind]').forEach((b) => {
      const on = b === chip;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  } else if (chip.dataset.severity) setSeverity(pick, chip.classList.contains('on') ? null : (chip.dataset.severity as Severity));
  return true;
}

/** Alt+1/2/3 in a comment box toggles Major/Minor/Nit. */
export function pickerKey(e: KeyboardEvent, root: Element): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  // e.code, not e.key: Alt+digit types other characters on macOS.
  const n = /^Digit([123])$/.exec(e.code)?.[1];
  const pick = root.querySelector('.mdr-meta-pick');
  if (!n || !pick) return false;
  const s = SEVERITIES[Number(n) - 1];
  setSeverity(pick, pick.querySelector(`[data-severity="${s}"]`)?.classList.contains('on') ? null : s);
  e.preventDefault();
  return true;
}

function setSeverity(pick: Element, s: Severity | null) {
  pick.querySelectorAll('[data-severity]').forEach((b) => {
    const on = (b as HTMLElement).dataset.severity === s;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

export function readPicker(root: Element): { kind: Kind; severity: Severity | null } {
  const k = (root.querySelector('.mdr-meta-pick [data-kind].on') as HTMLElement | null)?.dataset.kind;
  const s = (root.querySelector('.mdr-meta-pick [data-severity].on') as HTMLElement | null)?.dataset.severity;
  return { kind: isKind(k) ? k : 'comment', severity: isSeverity(s) ? s : null };
}

/** Badges on a thread card: scope, kind (when not a plain comment) and severity. */
export function metaBadges(m: Meta): string {
  const out: string[] = [];
  if (m.scope === 'document') out.push('<span class="mdr-tag mdr-tag-scope">Document</span>');
  else if (m.scope === 'section') out.push('<span class="mdr-tag mdr-tag-scope">Section</span>');
  if (m.kind === 'question' || m.kind === 'praise') out.push(`<span class="mdr-tag mdr-tag-${m.kind}">${KIND_LABEL[m.kind]}</span>`);
  if (isSeverity(m.severity)) out.push(`<span class="mdr-tag mdr-sev mdr-sev-${m.severity}">${SEVERITY_LABEL[m.severity]}</span>`);
  return out.join('');
}

export const severityRank = (m: Meta) => (isSeverity(m.severity) ? SEVERITIES.indexOf(m.severity) : SEVERITIES.length);

// ---------------------------------------------------------------- word snapping

const WORD = /[\p{L}\p{N}_'’]/u;

/**
 * Grow a selection that starts or ends inside a word to the whole word, so a
 * drag that stops at "choos" quotes "choose". Only within one text node.
 */
export function snapToWords(range: Range): Range {
  const r = range.cloneRange();
  const s = r.startContainer;
  if (s.nodeType === Node.TEXT_NODE) {
    const t = s.textContent || '';
    let i = r.startOffset;
    if (i > 0 && i < t.length && WORD.test(t[i - 1]) && WORD.test(t[i])) {
      while (i > 0 && WORD.test(t[i - 1])) i--;
      r.setStart(s, i);
    }
  }
  const e = r.endContainer;
  if (e.nodeType === Node.TEXT_NODE) {
    const t = e.textContent || '';
    let i = r.endOffset;
    if (i > 0 && i < t.length && WORD.test(t[i - 1]) && WORD.test(t[i])) {
      while (i < t.length && WORD.test(t[i])) i++;
      r.setEnd(e, i);
    }
  }
  return r;
}

// ---------------------------------------------------------------- sections

/** A heading's section: its source lines through the line before the next heading at its level or above. */
export function sectionLines(h: HTMLElement, doc: HTMLElement): [number, number] {
  const level = Number(h.tagName[1]);
  const heads = Array.from(doc.querySelectorAll<HTMLElement>('h1[data-ls], h2[data-ls], h3[data-ls], h4[data-ls], h5[data-ls], h6[data-ls]'));
  const i = heads.indexOf(h);
  const next = heads.slice(i + 1).find((x) => Number(x.tagName[1]) <= level);
  let end: number;
  if (next) end = Number(next.dataset.ls);
  else {
    const blocks = doc.querySelectorAll<HTMLElement>('[data-le]');
    end = blocks.length ? Number(blocks[blocks.length - 1].dataset.le) : Number(h.dataset.le);
  }
  return [Number(h.dataset.ls) + 1, Math.max(Number(h.dataset.ls) + 1, end)];
}
