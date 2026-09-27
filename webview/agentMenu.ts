// The agent chip in the review pane and its session menu: which Claude Code
// or Codex session this document's comments go to, starting or resuming one,
// and whether comments go on Send or live as each is saved. The host sends the
// session list when the menu opens, so nothing is scanned until someone asks.

export type AgentKind = 'claude' | 'codex';
export interface Session { agent: AgentKind; id: string; name?: string; live: boolean; status?: string; updatedAt: number; connected?: boolean }
export interface AgentState {
  bound: { agent: AgentKind; id: string; name?: string; live?: boolean; status?: string } | null;
  delivery: 'onSend' | 'live';
  sessions?: Session[];
  ask?: boolean;
  starting?: string;
}

export interface AgentMenu {
  set(state: AgentState): void;
  open(): void;
  /** "Claude" or "Codex": who Send goes to. */
  name(): string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const agentLabel = (a: AgentKind) => (a === 'codex' ? 'Codex' : 'Claude');

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

const short = (s: { id: string; name?: string }) => s.name || s.id.slice(0, 8);

export function createAgentMenu(button: HTMLButtonElement, panel: HTMLElement, post: (m: unknown) => void, changed: () => void): AgentMenu {
  let state: AgentState = { bound: null, delivery: 'onSend' };
  let focusFirst = false;

  const items = () => Array.from(panel.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'));

  function chip() {
    const b = state.bound;
    const dot = state.starting ? 'starting' : !b ? 'none' : !b.live ? 'off' : b.status === 'busy' ? 'busy' : 'idle';
    const text = state.starting || (b ? `${agentLabel(b.agent)} · ${short(b)}` : 'Connect an agent');
    const live = b && state.delivery === 'live' ? '<span class="mdr-agent-live">Live</span>' : '';
    button.innerHTML = `<span class="mdr-agent-dot" data-state="${dot}"></span><span class="mdr-agent-name">${esc(text)}</span>${live}`;
    button.title = b
      ? `Comments go to ${agentLabel(b.agent)} session ${b.id}${b.live ? ` (${b.status || 'running'})` : ' (not running)'}. Click to change.`
      : 'Pick the Claude Code or Codex session your comments go to';
  }

  function row(s: Session) {
    const bound = state.bound?.id === s.id;
    const meta = s.live ? (s.status || 'running') : ago(s.updatedAt);
    return `<button role="menuitemradio" aria-checked="${bound}" tabindex="-1" data-bind="${esc(s.id)}" data-agent="${s.agent}"${s.name ? ` data-name="${esc(s.name)}"` : ''} title="${esc(s.id)}">
      <span class="mdr-agent-tag" data-agent="${s.agent}">${agentLabel(s.agent)}</span><span class="mdr-agent-title">${esc(short(s))}</span><span class="mdr-agent-meta">${s.live ? '<span class="mdr-agent-dot" data-state="' + (s.status === 'busy' ? 'busy' : 'idle') + '"></span>' : ''}${esc(meta)}</span></button>`;
  }

  function render() {
    const list = state.sessions;
    const running = (list || []).filter((s) => s.live);
    const past = (list || []).filter((s) => !s.live).slice(0, 6);
    const radio = (v: AgentState['delivery'], text: string, hint: string) =>
      `<button role="menuitemradio" tabindex="-1" aria-checked="${state.delivery === v}" data-delivery="${v}" title="${esc(hint)}">${esc(text)}</button>`;
    panel.innerHTML = `
      <div class="mdr-rv-note">${state.ask ? 'Pick the session your comments go to.' : 'Comments go into a running Claude Code or Codex session, with its context. No new process each time.'}</div>
      <div id="mdr-agent-menu" class="mdr-rv-list" role="menu" aria-label="Agent sessions">${
        list
          ? `<div class="mdr-rv-label" role="presentation">Running in this folder</div>${running.length ? running.map(row).join('') : '<div class="mdr-agent-empty" role="presentation">None running</div>'}
            <div class="mdr-rv-label" role="presentation">Start</div>
            <button role="menuitem" tabindex="-1" data-start="claude">New Claude session</button>
            <button role="menuitem" tabindex="-1" data-start="codex">New Codex session</button>
            ${past.length ? `<div class="mdr-rv-label" role="presentation">Resume</div>${past.map((s) => row(s).replace('data-bind=', 'data-resume=')).join('')}` : ''}`
          : '<div class="mdr-rv-label" role="presentation">Looking for sessions…</div>'
      }
        <div class="mdr-rv-label" role="presentation">Send comments</div>
        ${radio('onSend', 'When I press Send', 'Comments wait as drafts until Send (or Ask on one thread)')}
        ${radio('live', 'Live, as I save each one', 'Each comment, and each reply on an open thread, goes to the session when you save it')}
        <div class="mdr-agent-sep" role="separator"></div>
        <button role="menuitem" tabindex="-1" data-act="copy" title="Submit drafts and copy the prompt, to paste into any other agent">Copy prompt instead</button>
        ${state.bound ? '<button role="menuitem" tabindex="-1" data-act="unbind">Disconnect</button>' : ''}
      </div>`;
    const first = items()[0];
    if (first) first.tabIndex = 0;
    if (focusFirst && list && first) {
      focusFirst = false;
      (panel.querySelector<HTMLButtonElement>('[aria-checked="true"][data-bind]') || first).focus();
    }
  }

  function place() {
    const r = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.min(r.bottom + 6, window.innerHeight - panel.offsetHeight - 8)}px`;
  }

  function open(focus: boolean) {
    state = { ...state, sessions: undefined };
    render();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    place();
    focusFirst = focus;
    post({ type: 'listSessions' });
  }

  function close(returnFocus: boolean) {
    if (panel.hidden) return;
    state.ask = undefined;
    const inside = panel.contains(document.activeElement);
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus || inside) button.focus();
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.hidden) open(e.detail === 0);
    else close(true);
  });
  panel.addEventListener('click', (e) => {
    e.stopPropagation();
    const b = (e.target as Element).closest<HTMLElement>('button');
    if (!b) return;
    const d = b.dataset;
    if (d.bind) post({ type: 'bindSession', agent: d.agent, id: d.bind, name: d.name });
    else if (d.resume) post({ type: 'startSession', agent: d.agent, resume: d.resume });
    else if (d.start) post({ type: 'startSession', agent: d.start });
    else if (d.delivery) {
      post({ type: 'setDelivery', delivery: d.delivery });
      return; // keep the menu open: it's a setting
    } else if (d.act === 'copy') post({ type: 'copyPrompt' });
    else if (d.act === 'unbind') post({ type: 'unbindSession' });
    close(true);
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return close(true);
    }
    if (e.key === 'Tab') return close(true);
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || !/^(ArrowUp|ArrowDown|Home|End)$/.test(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list.forEach((b, k) => (b.tabIndex = k === next ? 0 : -1));
    list[next].focus();
  });
  panel.addEventListener('focusout', (e) => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (to && !panel.contains(to) && to !== button) close(false);
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node)) close(false);
  });

  chip();
  render();
  return {
    set(next) {
      const keep = state.sessions;
      // "Pick a session" stays up while the menu that asked is open.
      state = { ...next, sessions: next.sessions ?? (panel.hidden ? undefined : keep), ask: next.ask || (!panel.hidden && state.ask) || undefined };
      chip();
      changed();
      if (next.ask && panel.hidden) return open(true);
      if (!panel.hidden) {
        const at = document.activeElement as HTMLElement | null;
        const key = at && panel.contains(at) ? at.dataset.delivery || at.dataset.bind || at.dataset.start : undefined;
        render();
        if (key) panel.querySelector<HTMLElement>(`[data-delivery="${key}"],[data-bind="${key}"],[data-start="${key}"]`)?.focus();
        place();
      }
    },
    open: () => open(true),
    name: () => agentLabel(state.bound?.agent ?? 'claude'),
  };
}
