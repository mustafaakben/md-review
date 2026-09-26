// Markdown -> HTML. Every block element carries data-ls / data-le (0-based
// source line range, end exclusive) so the webview can map a double-clicked
// block back to its exact source lines.
import MarkdownIt from 'markdown-it';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const footnote = require('markdown-it-footnote');
const sup = require('markdown-it-sup');
const sub = require('markdown-it-sub');
const attrs = require('markdown-it-attrs');
const texmath = require('markdown-it-texmath');
const katex = require('katex');
import { frontMatterPlugin } from './frontMatter';
import { criticPlugin } from './critic';
import { gfmPlugin } from './gfm';
import { citationsPlugin } from './citations';
import { linearFootnoteTail } from './footnoteTail';

/**
 * KaTeX, memoized. Between two renders the reader changes a paragraph or two,
 * so nearly every formula is the same as last time, and KaTeX is 40-45% of a
 * math-heavy render. KaTeX output depends only on the source and the options,
 * which are fixed here apart from displayMode. markdown-it-texmath keeps the
 * engine from its first use, so every renderer has to share this one.
 */
const MATH_CACHE_LIMIT = 5000;
// Two generations: a full one is kept as the older one while a new one fills,
// and a hit in the older one moves up. A render walks its formulas in the same
// order each time, so a plain oldest-first cache would evict each formula just
// before it is needed again once a file has more formulas than the limit.
let mathCache = new Map<string, string>();
let olderMath = new Map<string, string>();
const mathEngine = {
  renderToString(tex: string, options: { displayMode?: boolean }): string {
    const key = (options.displayMode ? 'D' : 'I') + tex;
    let html = mathCache.get(key) ?? olderMath.get(key);
    if (html === undefined) html = katex.renderToString(tex, options) as string; // throws are handled by texmath; nothing is cached
    if (!mathCache.has(key)) {
      if (mathCache.size >= MATH_CACHE_LIMIT) {
        olderMath = mathCache;
        mathCache = new Map();
      }
      mathCache.set(key, html!);
    }
    return html!;
  },
};

export type ResolveImage = (src: string) => string;

const WRAPPED = ['html_block', 'math_block', 'math_block_eqno', 'code_block'];

function isRelative(src: string): boolean {
  return !!src && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src);
}

function cssLength(v: string): string {
  return /^\d+(\.\d+)?$/.test(v) ? `${v}px` : v;
}

export function createRenderer(resolveImage: ResolveImage): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  md.use(frontMatterPlugin).use(criticPlugin);
  md.use(footnote).use(linearFootnoteTail).use(sup).use(sub).use(gfmPlugin);
  md.use(texmath, { engine: mathEngine, delimiters: ['dollars', 'brackets'], katexOptions: { throwOnError: false } });
  md.use(attrs, { allowedAttributes: ['id', 'class', 'width', 'height', 'style'] });
  md.use(citationsPlugin);

  // Tag block tokens with their source line range.
  md.core.ruler.push('mdr_lines', (state) => {
    for (const t of state.tokens) {
      if (t.map && t.nesting !== -1 && t.type !== 'inline') {
        t.attrSet('data-ls', String(t.map[0]));
        t.attrSet('data-le', String(t.map[1]));
      }
    }
  });

  // Renderers that ignore token attrs: wrap them in a div carrying the range.
  for (const type of WRAPPED) {
    const orig = md.renderer.rules[type];
    if (!orig) continue;
    md.renderer.rules[type] = (tokens, idx, opts, env, self) => {
      const t = tokens[idx];
      const inner = orig(tokens, idx, opts, env, self);
      if (!t.map) return inner;
      return `<div class="mdr-wrap" data-ls="${t.map[0]}" data-le="${t.map[1]}">${inner}</div>\n`;
    };
  }

  // Images: resolve relative paths; pandoc-style width/height -> CSS.
  const origImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet('src') || '';
    if (isRelative(src)) t.attrSet('src', resolveImage(decodeURIComponent(src)));
    const style: string[] = [];
    for (const k of ['width', 'height']) {
      const v = t.attrGet(k);
      if (v) {
        if (k === 'width') style.push(`width:${cssLength(v)}`);
        const i = t.attrIndex(k);
        t.attrs!.splice(i, 1);
      }
    }
    if (style.length) t.attrSet('style', [t.attrGet('style'), ...style].filter(Boolean).join(';'));
    return origImage(tokens, idx, opts, env, self);
  };

  return md;
}

/** `docDir`: the file's folder, for reading its `bibliography:`. */
export interface RenderEnv {
  docDir?: string;
  /** Filled in by the render: the bibliography files it read, to watch. */
  bibFiles?: string[];
}

// One renderer per image resolver (a session keeps the same one), so plugin
// setup happens once rather than on every render.
const renderers = new WeakMap<ResolveImage, MarkdownIt>();

export function rendererFor(resolveImage: ResolveImage): MarkdownIt {
  let md = renderers.get(resolveImage);
  if (!md) renderers.set(resolveImage, (md = createRenderer(resolveImage)));
  return md;
}

type Token = ReturnType<MarkdownIt['parse']>[number];
export interface Parse {
  tokens: Token[];
  env: Record<string, any>;
}

/** Render, keeping the parse so an in-view edit can find its block in it. */
export function renderParsed(text: string, resolveImage: ResolveImage, env: RenderEnv = {}): { html: string; parse: Parse } {
  const md = rendererFor(resolveImage);
  const tokens = md.parse(text, env);
  return { html: md.renderer.render(tokens, md.options, env), parse: { tokens, env } };
}

export function renderMarkdown(text: string, resolveImage: ResolveImage, env: RenderEnv = {}): string {
  return renderParsed(text, resolveImage, env).html;
}
