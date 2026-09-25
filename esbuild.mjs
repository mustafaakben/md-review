import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'fs';

const watch = process.argv.includes('--watch');

// KaTeX stylesheet + fonts for the webview.
mkdirSync('media/katex', { recursive: true });
cpSync('node_modules/katex/dist/katex.min.css', 'media/katex/katex.min.css');
cpSync('node_modules/katex/dist/fonts', 'media/katex/fonts', { recursive: true });
cpSync('webview/style.css', 'media/style.css');

const builds = [
  // Extension host.
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  // Host core for tests / harness / CLI (no vscode dependency).
  { entryPoints: ['src/lib.ts'], outfile: 'dist/lib.cjs', platform: 'node', format: 'cjs' },
  // Webview.
  { entryPoints: ['webview/main.ts'], outfile: 'media/webview.js', platform: 'browser', format: 'iife' },
];

for (const b of builds) {
  const opts = { bundle: true, target: 'es2022', sourcemap: false, logLevel: 'info', ...b };
  if (watch) await (await esbuild.context(opts)).watch();
  else await esbuild.build(opts);
}
