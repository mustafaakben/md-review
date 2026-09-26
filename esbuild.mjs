import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';

const watch = process.argv.includes('--watch');

// KaTeX stylesheet + fonts for the webview. The webview is Chromium, which
// takes the first format each @font-face lists (woff2), so the woff and ttf
// copies would only add weight to the package.
rmSync('media/katex', { recursive: true, force: true });
mkdirSync('media/katex', { recursive: true });
writeFileSync(
  'media/katex/katex.min.css',
  readFileSync('node_modules/katex/dist/katex.min.css', 'utf8').replace(/,url\(fonts\/[^)]+\.(woff|ttf)\) format\("(woff|truetype)"\)/g, ''),
);
cpSync('node_modules/katex/dist/fonts', 'media/katex/fonts', { recursive: true, filter: (f) => !/\.(woff|ttf)$/.test(f) });
cpSync('webview/style.css', 'media/style.css');
cpSync('webview/features.css', 'media/features.css');
// Mermaid, loaded by the webview only for documents with a diagram. The ES
// module build splits each diagram type into its own chunk, so a flowchart
// loads a fraction of the library. Source maps are left out.
rmSync('media/mermaid', { recursive: true, force: true });
cpSync('node_modules/mermaid/dist/mermaid.esm.min.mjs', 'media/mermaid/mermaid.esm.min.mjs');
cpSync('node_modules/mermaid/dist/chunks/mermaid.esm.min', 'media/mermaid/chunks/mermaid.esm.min', {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});

const builds = [
  // Extension host. Minified: less to read from disk (and scan, on Windows) at start-up.
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], minify: true, keepNames: true },
  // Host core for tests / harness / CLI (no vscode dependency).
  { entryPoints: ['src/lib.ts'], outfile: 'dist/lib.cjs', platform: 'node', format: 'cjs' },
  // Webview.
  { entryPoints: ['webview/main.ts'], outfile: 'media/webview.js', platform: 'browser', format: 'iife', minify: true, keepNames: true },
];

for (const b of builds) {
  const opts = { bundle: true, target: 'es2022', sourcemap: false, logLevel: 'info', ...b };
  if (watch) await (await esbuild.context(opts)).watch();
  else await esbuild.build(opts);
}
