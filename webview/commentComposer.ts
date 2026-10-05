import { metaPicker } from './commentMeta';
import { keyLabel } from './keys';
interface Anchor { quote: string; scope?: 'document' | 'section' }
const esc = (s: string) => s.replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export function popupPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number, top = 64) {
  return { left: Math.max(12, Math.min(x, viewportWidth - width - 12)), top: Math.max(top, Math.min(y, viewportHeight - height - 12)) };
}
/** Render and position the composer independently of selection and thread state. */
export function createCommentComposer(root: HTMLElement, agentName: () => string) {
  function fit() {
    if (root.hidden || !root.querySelector('.mdr-comment-text')) return;
    root.style.maxWidth = `${Math.max(0, document.documentElement.clientWidth - 24)}px`;
    const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-h')) || 56) + 8;
    root.style.maxHeight = `${Math.max(100, innerHeight - top - 12)}px`;
    root.style.overflowY = 'auto';
    const r = root.getBoundingClientRect();
    const pos = popupPosition(r.left, r.top, r.width, r.height, document.documentElement.clientWidth, innerHeight, top);
    root.style.left = `${pos.left + scrollX}px`; root.style.top = `${pos.top + scrollY}px`;
  }
  new ResizeObserver(fit).observe(root);
  window.addEventListener('resize', fit);
  return {
    open(anchor: Anchor, top: number) {
      root.classList.remove('mdr-selection-action');
      const what = anchor.scope === 'document' ? 'The whole document' : `${anchor.scope === 'section' ? 'Section: ' : ''}${esc(anchor.quote.slice(0, 140))}${anchor.quote.length > 140 ? '…' : ''}`;
      const suggestion = anchor.scope ? '' : `<div class="mdr-sugg-edit" hidden><label class="mdr-sugg-label" for="mdr-sugg-text">Replace with</label><textarea id="mdr-sugg-text" class="mdr-sugg-text" spellcheck="true">${esc(anchor.quote)}</textarea></div>`;
      root.innerHTML = `<div class="mdr-quote small">${what}</div>${metaPicker({}, n => keyLabel(`Alt+${n}`))}
        <textarea class="mdr-comment-text" placeholder="Add a comment…  (${keyLabel('Mod+Enter')} to save)"></textarea>${suggestion}
        <div class="mdr-row mdr-compose-actions"><button class="mdr-primary" data-act="send-comment" title="Save and send only this comment (${keyLabel('Mod+Shift+Enter')})">Send to ${esc(agentName())}</button><button data-act="save-comment">Save draft</button><button data-act="cancel">Cancel</button>${anchor.scope ? '' : '<button class="mdr-sugg-toggle" data-act="toggle-sugg" aria-pressed="false" title="Propose replacement text for the selection">Suggest edit</button>'}</div><div class="mdr-compose-error" role="alert" hidden></div>`;
      root.style.top = `${top}px`; fit();
      root.querySelector('textarea')?.focus({ preventScroll: true });
    },
    busy(on: boolean) {
      root.setAttribute('aria-busy', String(on));
      root.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button,textarea').forEach(el => el.disabled = on);
    },
    updateAgent() {
      const button = root.querySelector<HTMLButtonElement>('[data-act="send-comment"]');
      if (button) button.textContent = `Send to ${agentName()}`;
    },
    error(message: string) {
      const el = root.querySelector<HTMLElement>('.mdr-compose-error');
      if (el) { el.textContent = message; el.hidden = !message; fit(); }
    },
    toggleSuggestion() {
      const box = root.querySelector<HTMLElement>('.mdr-sugg-edit'); if (!box) return;
      box.hidden = !box.hidden;
      root.querySelector('.mdr-sugg-toggle')?.setAttribute('aria-pressed', String(!box.hidden)); fit();
      if (!box.hidden) { const ta = box.querySelector('textarea'); ta?.focus({ preventScroll: true }); ta?.select(); }
    },
    fit,
  };
}
