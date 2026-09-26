// markdown-it-footnote's `footnote_tail` core rule, with one change: it appends
// each footnote's tokens in place instead of `state.tokens = state.tokens.concat(tokens)`,
// which copied the whole token list once per footnote (quadratic: a book with
// 800 footnotes spent ~70% of its render there). Output is identical.
//
// From markdown-it-footnote 4.0.0, MIT License,
// Copyright (c) 2014-2015 Vitaly Puzrin, Alex Kocharin.
import type MarkdownIt from 'markdown-it';

type CoreRule = Parameters<MarkdownIt['core']['ruler']['at']>[1];
type StateCore = Parameters<CoreRule>[0];
type Token = StateCore['tokens'][number];

function footnoteTail(state: StateCore): void {
  let tokens: Token[] | undefined;
  let current: Token[] = [];
  let currentLabel = '';
  let insideRef = false;
  const refTokens: Record<string, Token[]> = {};

  if (!state.env.footnotes) return;

  state.tokens = state.tokens.filter((tok) => {
    if (tok.type === 'footnote_reference_open') {
      insideRef = true;
      current = [];
      currentLabel = tok.meta.label;
      return false;
    }
    if (tok.type === 'footnote_reference_close') {
      insideRef = false;
      // prepend ':' to avoid conflict with Object.prototype members
      refTokens[':' + currentLabel] = current;
      return false;
    }
    if (insideRef) current.push(tok);
    return !insideRef;
  });

  if (!state.env.footnotes.list) return;
  const list = state.env.footnotes.list;
  const out = state.tokens;

  out.push(new state.Token('footnote_block_open', '', 1));

  for (let i = 0, l = list.length; i < l; i++) {
    const tokenFo = new state.Token('footnote_open', '', 1);
    tokenFo.meta = { id: i, label: list[i].label };
    out.push(tokenFo);

    if (list[i].tokens) {
      tokens = [];
      const tokenPo = new state.Token('paragraph_open', 'p', 1);
      tokenPo.block = true;
      tokens.push(tokenPo);
      const tokenI = new state.Token('inline', '', 0);
      tokenI.children = list[i].tokens;
      tokenI.content = list[i].content;
      tokens.push(tokenI);
      const tokenPc = new state.Token('paragraph_close', 'p', -1);
      tokenPc.block = true;
      tokens.push(tokenPc);
    } else if (list[i].label) {
      tokens = refTokens[`:${list[i].label}`];
    }

    if (tokens) for (const t of tokens) out.push(t); // was: state.tokens = state.tokens.concat(tokens)

    const lastParagraph = out[out.length - 1].type === 'paragraph_close' ? out.pop()! : null;

    const t = list[i].count > 0 ? list[i].count : 1;
    for (let j = 0; j < t; j++) {
      const tokenA = new state.Token('footnote_anchor', '', 0);
      tokenA.meta = { id: i, subId: j, label: list[i].label };
      out.push(tokenA);
    }

    if (lastParagraph) out.push(lastParagraph);
    out.push(new state.Token('footnote_close', '', -1));
  }

  out.push(new state.Token('footnote_block_close', '', -1));
}

/** Use after markdown-it-footnote: swaps its tail rule for the linear one above. */
export function linearFootnoteTail(md: MarkdownIt): void {
  md.core.ruler.at('footnote_tail', footnoteTail);
}
