// CriticMarkup: {++added++}, {--deleted--}, {~~old~>new~~}, {==highlight==}
// and {>>comment<<}. Parsed inline so markdown-it-attrs never sees the braces
// (it used to swallow {--deleted--} as an attribute list, hiding the text).
import type MarkdownIt from 'markdown-it';

const MARKS: Record<string, { close: string; tag: string; cls: string }> = {
  '++': { close: '++}', tag: 'ins', cls: 'mdr-critic-add' },
  '--': { close: '--}', tag: 'del', cls: 'mdr-critic-del' },
  '~~': { close: '~~}', tag: 'span', cls: 'mdr-critic-sub' },
  '==': { close: '==}', tag: 'mark', cls: 'mdr-critic-mark' },
  '>>': { close: '<<}', tag: 'span', cls: 'mdr-critic-note' },
};

export function criticPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('emphasis', 'mdr_critic', (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x7b /* { */) return false;
    const kind = src.slice(pos + 1, pos + 3);
    const spec = MARKS[kind];
    if (!spec) return false;
    const start = pos + 3;
    const end = src.indexOf(spec.close, start);
    if (end < 0 || end === start) return false;
    const body = src.slice(start, end);
    if (kind === '~~' && !body.includes('~>')) return false;
    if (silent) return true;
    const push = (tag: string, cls: string, text: string) => {
      const open = state.push('mdr_critic_open', tag, 1);
      open.attrSet('class', cls);
      // Parse the inside as Markdown so emphasis, links and math still render.
      const children: any[] = [];
      md.inline.parse(text, md, state.env, children);
      state.tokens.push(...children);
      state.push('mdr_critic_close', tag, -1);
    };
    if (kind === '~~') {
      const arrow = body.indexOf('~>');
      push('del', 'mdr-critic-del', body.slice(0, arrow));
      push('ins', 'mdr-critic-add', body.slice(arrow + 2));
    } else {
      push(spec.tag, spec.cls, body);
    }
    state.pos = end + spec.close.length;
    return true;
  });
}
