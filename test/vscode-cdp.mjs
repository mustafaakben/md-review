// Drive the MD Review webview inside a real VS Code (started with
// --remote-debugging-port=9339) over CDP. Usage: node test/vscode-cdp.mjs <step>
import fs from 'node:fs';

const port = 9339;
const step = process.argv[2] || 'inspect';
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m);
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { send, close: () => ws.close() };
}

const pageT = targets.find((t) => t.type === 'page');
// Several webviews may exist (chat, etc.); pick the one hosting MD Review.
let f;
for (const t of targets.filter((t) => t.type === 'iframe' && t.url.startsWith('vscode-webview://'))) {
  const c = await connect(t);
  const r = await c.send('Runtime.evaluate', { expression: "!!document.querySelector('iframe#active-frame')?.contentDocument?.querySelector('.mdr-doc')", returnByValue: true });
  if (r.result?.result?.value) { f = c; break; }
  c.close();
}
if (!f) throw new Error('MD Review webview not found');

// The extension's document lives in the webview's inner #active-frame (same origin).
async function run(fnSrc) {
  const expr = `(async () => { const d = document.querySelector('iframe#active-frame')?.contentDocument; if (!d) return 'no active-frame'; const w = d.defaultView; return await (${fnSrc})(d, w); })()`;
  const r = await f.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result;
}

async function shot(name) {
  const p = await connect(pageT);
  const r = await p.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(new URL('./screens/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL(`./screens/${name}.png`, import.meta.url), Buffer.from(r.result.data, 'base64'));
  p.close();
}

const steps = {
  inspect: `(d) => ({ blocks: d.querySelectorAll('.mdr-doc [data-ls]').length, tables: d.querySelectorAll('.mdr-doc table').length,
      imgs: [...d.querySelectorAll('.mdr-doc img')].map(i => i.naturalWidth + ' ' + i.getAttribute('style')), file: d.querySelector('.mdr-file')?.textContent,
      katexCss: [...d.styleSheets].some(s => (s.href||'').includes('katex')) })`,
  comment: `async (d, w) => {
      const doc = d.querySelector('.mdr-doc');
      const tw = d.createTreeWalker(doc, 4);
      const needle = 'Diagnostic content evaluation drew on 199';
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) {
        const r = d.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length);
        const s = w.getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
      d.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      d.querySelector('[data-act="new-comment"]').click();
      d.querySelector('.mdr-pop textarea').value = 'Say which panel the 199 records came from.';
      d.querySelector('[data-act="save-comment"]').click();
      await new Promise(r => setTimeout(r, 800));
      d.querySelector('#mdr-submit').click();
      await new Promise(r => setTimeout(r, 800));
      return [...d.querySelectorAll('.mdr-card')].map(c => c.className + ' :: ' + c.querySelector('.mdr-body')?.textContent);
    }`,
  edit: `async (d, w) => {
      const p = [...d.querySelectorAll('.mdr-doc p')].find(p => p.textContent.startsWith('These decisions require more than enthusiasm'));
      p.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true, altKey: true })); // Alt+double-click = raw source
      const visible = true;
      await new Promise(r => setTimeout(r, 600));
      const ta = d.querySelector('.mdr-block-editor textarea');
      const before = ta.value;
      ta.value = before.replace('require more than enthusiasm', 'demand more than enthusiasm');
      d.querySelector('[data-act="save-block"]').click();
      await new Promise(r => setTimeout(r, 1500));
      return { rawEditorOpened: visible, editedShown: !![...d.querySelectorAll('.mdr-doc p')].find(p => p.textContent.startsWith('These decisions demand')), toast: d.querySelector('#mdr-toast').textContent };
    }`,
  inline: `async (d, w) => {
      d.querySelector('#mdr-edit-mode').click();
      const p = [...d.querySelectorAll('.mdr-doc p')].find(p => p.textContent.startsWith('Keywords:'));
      p.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
      const r = d.createRange(); r.selectNodeContents(p); r.collapse(false);
      const s = w.getSelection(); s.removeAllRanges(); s.addRange(r);
      d.execCommand('insertText', false, ' invariance');
      const editable = p.isContentEditable, boxes = d.querySelectorAll('.mdr-block-editor').length;
      p.blur();
      await new Promise(r => setTimeout(r, 1500));
      return { editable, boxes, shown: [...d.querySelectorAll('.mdr-doc p')].find(p => p.textContent.startsWith('Keywords:')).textContent.slice(-25), toast: d.querySelector('#mdr-toast').textContent };
    }`,
  state: `(d) => ({ cards: [...d.querySelectorAll('.mdr-card')].map(c => c.className + ' :: replies=' + c.querySelectorAll('.mdr-reply').length), counts: d.querySelector('.mdr-counts').textContent })`,
};

if (step === 'shot') await shot(process.argv[3] || 'vscode');
else console.log(JSON.stringify(await run(steps[step]), null, 2));
f.close();
