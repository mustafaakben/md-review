// GitHub-flavored extras the reading view was missing: task lists (toggled
// through a byte-exact write), GitHub alerts (> [!NOTE]), ==highlight==,
// syntax-highlighted code, and Mermaid fences (drawn lazily by the webview).
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mark = require('markdown-it-mark');
import { TASK_LINE } from './blockEdit';

// A small, common set keeps the host bundle and render time low. Unknown
// languages render as plain code, as before.
const LANGS: [string, () => unknown, string[]][] = [
  ['bash', () => require('highlight.js/lib/languages/bash'), ['sh', 'shell', 'zsh', 'console']],
  ['c', () => require('highlight.js/lib/languages/c'), ['h']],
  ['cpp', () => require('highlight.js/lib/languages/cpp'), ['c++', 'cc', 'hpp']],
  ['css', () => require('highlight.js/lib/languages/css'), []],
  ['diff', () => require('highlight.js/lib/languages/diff'), ['patch']],
  ['go', () => require('highlight.js/lib/languages/go'), ['golang']],
  ['java', () => require('highlight.js/lib/languages/java'), []],
  ['javascript', () => require('highlight.js/lib/languages/javascript'), ['js', 'jsx', 'mjs', 'cjs']],
  ['json', () => require('highlight.js/lib/languages/json'), ['jsonc']],
  ['julia', () => require('highlight.js/lib/languages/julia'), ['jl']],
  ['latex', () => require('highlight.js/lib/languages/latex'), ['tex']],
  ['markdown', () => require('highlight.js/lib/languages/markdown'), ['md']],
  ['python', () => require('highlight.js/lib/languages/python'), ['py']],
  ['r', () => require('highlight.js/lib/languages/r'), []],
  ['rust', () => require('highlight.js/lib/languages/rust'), ['rs']],
  ['sql', () => require('highlight.js/lib/languages/sql'), []],
  ['typescript', () => require('highlight.js/lib/languages/typescript'), ['ts', 'tsx']],
  ['xml', () => require('highlight.js/lib/languages/xml'), ['html', 'svg']],
  ['yaml', () => require('highlight.js/lib/languages/yaml'), ['yml']],
];
// Loaded on the first fenced block with a language, so files without code
// don't pay for it.
let hljs: any;
function highlighter() {
  if (hljs) return hljs;
  hljs = require('highlight.js/lib/core');
  for (const [name, load, aliases] of LANGS) {
    hljs.registerLanguage(name, load());
    if (aliases.length) hljs.registerAliases(aliases, { languageName: name });
  }
  return hljs;
}

// Highlighting runs on every render; the same fences come back each keystroke.
const highlighted = new Map<string, string>();

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TASK = /^\[( |x|X)\][ \t]/;
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i;
const ALERT_TITLES: Record<string, string> = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };

function addClass(t: Token, cls: string) {
  const cur = t.attrGet('class');
  t.attrSet('class', cur ? `${cur} ${cls}` : cls);
}

/** Drop the first `n` characters of an inline token (content and first text child). */
function stripLead(inline: Token, n: number) {
  inline.content = inline.content.slice(n);
  const kids = inline.children || [];
  // `[x]` was read as a link because the document defines `[x]: url`.
  if (kids[0]?.type === 'link_open' && kids[1]?.type === 'text' && kids[2]?.type === 'link_close') {
    kids.splice(0, 3);
    const next = kids[0] as Token | undefined;
    if (next?.type === 'text') next.content = next.content.replace(/^[ \t]+/, '');
    return;
  }
  const first = kids[0];
  if (first && first.type === 'text') {
    first.content = first.content.slice(n);
    if (!first.content) {
      kids.shift();
      if (kids[0]?.type === 'softbreak') kids.shift();
    }
  }
}

export function gfmPlugin(md: MarkdownIt): void {
  md.use(mark);

  md.set({
    highlight: (code: string, lang: string) => {
      if (!lang) return '';
      const h = highlighter();
      if (!h.getLanguage(lang)) return '';
      const key = `${lang}\0${code}`;
      let out = highlighted.get(key);
      if (out === undefined) {
        try {
          out = h.highlight(code, { language: lang, ignoreIllegals: true }).value as string;
        } catch {
          out = '';
        }
        if (highlighted.size >= 300) highlighted.delete(highlighted.keys().next().value!);
        highlighted.set(key, out);
      }
      return out;
    },
  });

  // Mermaid: keep the source (the webview swaps in the diagram) and the
  // block's line range, so Alt+double-click still edits the raw fence.
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    if (t.info.trim().split(/\s+/)[0].toLowerCase() !== 'mermaid') return fence(tokens, idx, opts, env, self);
    const range = t.map ? ` data-ls="${t.map[0]}" data-le="${t.map[1]}"` : '';
    return `<div class="mdr-wrap mdr-mermaid"${range}><pre class="mdr-mermaid-src mdr-ui">${esc(t.content)}</pre></div>\n`;
  };

  md.core.ruler.after('inline', 'mdr_gfm', (state) => {
    const tokens = state.tokens;
    let lines: string[] | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      // Task list items: `- [ ] text` / `- [x] text`.
      if (t.type === 'list_item_open' && tokens[i + 1]?.type === 'paragraph_open' && tokens[i + 2]?.type === 'inline') {
        const inline = tokens[i + 2];
        const m = TASK.exec(inline.content);
        if (m && t.map) {
          stripLead(inline, m[0].length);
          const box = new state.Token('html_inline', '', 0);
          const checked = m[1] !== ' ';
          // Only a box whose line toggleTask can rewrite is clickable (not one
          // in a footnote or behind a second list marker).
          lines ||= state.src.split('\n');
          const live = TASK_LINE.test(lines[t.map[0]] || '');
          const label = inline.content.split('\n')[0].trim().slice(0, 80);
          box.content = `<input type="checkbox" class="mdr-task" data-task-line="${t.map[0]}"${checked ? ' checked' : ''}${live ? '' : ' disabled'} aria-label="${esc(label || (checked ? 'Done' : 'To do'))}">`;
          (inline.children ||= []).unshift(box);
          addClass(t, 'mdr-task-item');
          for (let j = i - 1; j >= 0; j--) {
            const o = tokens[j];
            if ((o.type === 'bullet_list_open' || o.type === 'ordered_list_open') && o.level === t.level - 1) {
              if (!(o.attrGet('class') || '').includes('mdr-task-list')) addClass(o, 'mdr-task-list');
              break;
            }
          }
        }
      }

      // GitHub alerts: a top-level blockquote whose first line is only [!NOTE] and friends.
      if (t.type === 'blockquote_open' && t.level === 0 && tokens[i + 1]?.type === 'paragraph_open' && tokens[i + 2]?.type === 'inline') {
        const inline = tokens[i + 2];
        const m = ALERT.exec(inline.content);
        if (m && /^[ \t]*(\n|$)/.test(inline.content.slice(m[0].length))) {
          const kind = m[1].toLowerCase();
          let n = m[0].length;
          if (inline.content[n] === '\n') n++;
          const kids = inline.children || [];
          // The marker is its own text token; drop it and the line break after it.
          if (kids[0]?.type === 'text' && ALERT.test(kids[0].content)) {
            kids[0].content = kids[0].content.replace(ALERT, '');
            if (!kids[0].content) {
              kids.shift();
              if ((kids[0] as Token | undefined)?.type === 'softbreak') kids.shift();
            }
          }
          inline.content = inline.content.slice(n);
          addClass(t, `mdr-alert mdr-alert-${kind}`);
          const title = new state.Token('html_block', '', 0);
          title.content = `<div class="mdr-alert-title mdr-ui">${ALERT_TITLES[kind]}</div>\n`;
          tokens.splice(i + 1, 0, title);
        }
      }
    }
  });
}
