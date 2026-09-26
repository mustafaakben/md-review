// Mermaid diagrams, drawn in the webview only when a document has one. The
// library (ES module chunks under media/mermaid/) is imported on first use, so
// documents without diagrams load nothing extra. Rendered SVGs are cached by
// source and theme, so repaints after edits or comment changes are instant.
//
// The source <pre> and the SVG holder are both `.mdr-ui`, which the text map
// skips: comment anchoring and find see the same text whether or not the
// diagram has drawn yet.

const script = document.currentScript as HTMLScriptElement | null;
const base = script?.src ? script.src.replace(/[^/]*$/, '') : '';

let loading: Promise<any> | null = null;
let themeInUse = '';
let seq = 0;
const cache = new Map<string, { svg?: string; error?: string }>();

function load(): Promise<any> {
  // A plain string keeps esbuild from trying to bundle the import.
  const url = base + 'mermaid/mermaid.esm.min.mjs';
  return (loading ||= import(/* @vite-ignore */ url).then((m) => m.default));
}

/** Dark when the document text is light. Follows the reading theme, not just VS Code's. */
function theme(doc: HTMLElement): 'dark' | 'default' {
  const m = /(\d+)[, ]+(\d+)[, ]+(\d+)/.exec(getComputedStyle(doc).color);
  if (!m) return 'default';
  const [r, g, b] = m.slice(1).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? 'dark' : 'default';
}

export function createDiagrams(doc: HTMLElement) {
  let pass = 0;

  function place(wrap: HTMLElement, out: { svg?: string; error?: string }, key = '') {
    wrap.dataset.drawn = key;
    let holder = wrap.querySelector<HTMLElement>(':scope > .mdr-mermaid-out');
    if (!holder) {
      holder = document.createElement('div');
      holder.className = 'mdr-mermaid-out mdr-ui';
      wrap.appendChild(holder);
    }
    if (out.svg) {
      holder.innerHTML = out.svg;
      wrap.classList.add('mdr-mermaid-ready');
      wrap.classList.remove('mdr-mermaid-failed');
    } else {
      holder.textContent = `Diagram error: ${out.error}`;
      wrap.classList.add('mdr-mermaid-failed');
      wrap.classList.remove('mdr-mermaid-ready');
    }
  }

  async function refresh() {
    const wraps = Array.from(doc.querySelectorAll<HTMLElement>('.mdr-mermaid'));
    if (!wraps.length) return;
    const my = ++pass;
    const t = theme(doc);
    const todo: [HTMLElement, string, string][] = [];
    for (const w of wraps) {
      const src = w.querySelector('.mdr-mermaid-src')?.textContent || '';
      const key = `${t}\u0000${src}`;
      if (w.dataset.drawn === key) continue; // already showing this
      const hit = cache.get(key);
      if (hit) place(w, hit, key);
      else todo.push([w, src, key]);
    }
    if (!todo.length) return;
    let mermaid: any;
    try {
      mermaid = await load();
    } catch (e: any) {
      loading = null;
      for (const [w] of todo) place(w, { error: `could not load Mermaid (${e?.message || e})` });
      return;
    }
    if (themeInUse !== t) {
      // suppressErrorRendering: no error graphic left in <body> for a bad diagram.
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: t, fontFamily: 'inherit' });
      themeInUse = t;
    }
    for (const [w, src, key] of todo) {
      if (my !== pass) return; // a newer paint took over
      let out: { svg?: string; error?: string };
      const id = `mdr-mermaid-${++seq}`;
      try {
        const { svg } = await mermaid.render(id, src);
        out = { svg };
      } catch (e: any) {
        out = { error: String(e?.message || e).split('\n')[0] };
        document.getElementById('d' + id)?.remove(); // Mermaid's scratch node
      }
      cache.set(key, out);
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      if (w.isConnected) place(w, out, key);
    }
  }

  return { refresh };
}
