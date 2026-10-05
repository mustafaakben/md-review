// Browser harness: serves the real webview bundle with a mock acquireVsCodeApi
// bridged to the real host code (ReviewSession) over HTTP + SSE.
//   node test/harness/server.mjs <file.md> [port] [--host 127.0.0.1]
// Binds to localhost by default: POST /msg can rewrite the served file.
// Pass --host <ip> only if you mean to reach it from another machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lib = require(path.join(root, 'dist', 'lib.cjs'));
const argv = process.argv.slice(2);
const hi = argv.indexOf('--host');
const host = hi >= 0 ? argv.splice(hi, 2)[1] : '127.0.0.1';
process.argv = [process.argv[0], process.argv[1], ...argv];
const md = path.resolve(process.argv[2] || path.join(root, 'test', 'fixtures', 'sample-crlf.md'));
const port = Number(process.argv[3] || 4417);
const dir = path.dirname(md);
const clients = new Set();

let prefs = {}; // reading prefs, kept for the life of the server
// Agent sessions: the binding and delivery mode live as long as the server.
// There's no terminal to open here, so starting a session hands the command
// to the page, which copies it for the user to run.
let binding;
let delivery = 'onSend';
const post = (m) => {
  const line = `data: ${JSON.stringify(m)}\n\n`;
  for (const c of clients) c.write(line);
};
const agents = lib.createAgentHost({
  folder: () => dir,
  fileName: path.basename(md),
  getBinding: () => binding,
  setBinding: (b) => (binding = b),
  getDelivery: () => delivery,
  setDelivery: (d) => (delivery = d),
  command: (agent) => agent,
  handOver: (command) => post({ type: 'handOver', command }),
  // The page's menu is the confirmation here: connect straight away, messages included.
  connect: async () => `Connected ${path.basename(dir)}: ${lib.connectFolder(dir, { cliDir: path.join(root, 'cli'), acceptInbound: true }).join(', ')}.`,
});
const session = new lib.ReviewSession({
  mdPath: md,
  author: () => os.userInfo().username,
  showResolved: () => true,
  post,
  agents,
  runAgent: (prompt) => agents.deliverPrompt(prompt),
  resolveImage: (src) => '/doc/' + src.split('/').map(encodeURIComponent).join('/'),
  getText: () => fs.readFileSync(md, 'utf8').replace(/^﻿/, ''),
  isDirty: () => false,
  openLink: (href) => console.log('openLink', href),
  getPrefs: () => prefs,
  cliPath: path.join(root, 'cli', 'mdreview.mjs'),
  setPrefs: (p) => (prefs = p),
  baselines: lib.memoryBaselines(), // Changes baselines, in memory like prefs
});

let t1, t2;
fs.watch(dir, (_ev, name) => {
  if (name === path.basename(md)) {
    clearTimeout(t1);
    t1 = setTimeout(() => session.render(), 150);
  } else if (name === path.basename(md) + '.comments.json') {
    clearTimeout(t2);
    t2 = setTimeout(() => session.onSidecarChanged(), 30); // fs.watch reports a write more than once; the sidecar re-read is cheap
  }
});

const shell = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MD Review harness</title>
<link rel="stylesheet" href="/media/katex/katex.min.css"><link rel="stylesheet" href="/media/style.css"><link rel="stylesheet" href="/media/features.css"><link rel="stylesheet" href="/media/fonts/fonts.css"></head>
<body><div id="app"></div>
<script>
  window.__mdrStandalone = true;
  let state = {};
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => fetch('/msg', { method: 'POST', body: JSON.stringify(m) }),
    getState: () => state, setState: (s) => { state = s; },
  });
  const es = new EventSource('/events');
  window.__ready = new Promise((r) => es.addEventListener('open', r));
  es.onmessage = (e) => window.postMessage(JSON.parse(e.data), '*');
</script>
<script>window.__ready.then(() => { const s = document.createElement('script'); s.src = '/media/webview.js'; document.body.appendChild(s); });</script>
</body></html>`;

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
function sendFile(res, base, rel) {
  const p = path.resolve(base, decodeURIComponent(rel));
  if (!p.startsWith(base + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(shell);
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/msg' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          session.handle(JSON.parse(body));
          res.writeHead(204).end();
        } catch (e) {
          res.writeHead(400).end(String(e));
        }
      });
      return;
    }
    if (url.pathname.startsWith('/media/')) return sendFile(res, path.join(root, 'media'), url.pathname.slice(7));
    if (url.pathname.startsWith('/doc/')) return sendFile(res, dir, url.pathname.slice(5));
    res.writeHead(404).end();
  })
  .listen(port, host, () => console.log(`MD Review in the browser: http://${host}:${port}/  (${md})`));
