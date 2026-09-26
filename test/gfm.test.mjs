// GitHub-flavored extras: task lists (and their byte-exact toggle), alerts,
// ==mark==, highlighted code, and Mermaid fences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const render = (s) => lib.renderMarkdown(s, (x) => x);
const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp', 'gfm');

test('task list items get a checkbox carrying their source line', () => {
  const html = render('Intro\n\n- [ ] todo\n- [x] done\n- plain\n  1. [X] nested\n');
  assert.match(html, /<ul class="mdr-task-list"/);
  // The box is named by its task, so a screen reader says what it ticks.
  assert.match(html, /<input type="checkbox" class="mdr-task" data-task-line="2" aria-label="todo">todo/);
  assert.match(html, /data-task-line="3" checked aria-label="done">done/);
  assert.match(html, /<li data-ls="4"[^>]*>plain/); // not a task
  assert.match(html, /data-task-line="5" checked/);
  assert.doesNotMatch(render('- [ ]no space\n'), /mdr-task/);
  assert.doesNotMatch(render('- `[ ] code`\n'), /mdr-task/);
  // A reference definition doesn't turn the marker into a link.
  assert.match(render('- [x] foo\n\n[x]: http://x\n'), /checked aria-label="foo">foo<\/li>/);
});

test('a checkbox whose line toggleTask cannot rewrite is disabled', () => {
  assert.match(render('- - [ ] double\n'), /data-task-line="0" disabled/);
  assert.match(render('x[^1]\n\n[^1]: - [ ] in a footnote\n'), /class="mdr-task"[^>]* disabled/);
  assert.doesNotMatch(render('> - [ ] quoted\n'), /disabled/);
});

test('toggling a task rewrites one byte and keeps CRLF and BOM', () => {
  fs.mkdirSync(tmp, { recursive: true });
  const md = path.join(tmp, 'tasks.md');
  const src = '﻿# T\r\n\r\n- [ ] one\r\n> * [x] quoted\r\n10. [ ] numbered\r\n';
  fs.writeFileSync(md, src);
  const before = fs.readFileSync(md);
  lib.toggleTask(md, 2, true);
  lib.toggleTask(md, 3, false);
  lib.toggleTask(md, 4, true);
  lib.toggleTask(md, 4, true); // already checked: no change
  const after = fs.readFileSync(md);
  assert.equal(after.length, before.length);
  const changed = [...after].map((b, i) => (b !== before[i] ? i : -1)).filter((i) => i >= 0);
  assert.equal(changed.length, 3);
  assert.equal(after.toString('utf8'), '﻿# T\r\n\r\n- [x] one\r\n> * [ ] quoted\r\n10. [x] numbered\r\n');
  assert.throws(() => lib.toggleTask(md, 0, true), /changed on disk/);
});

test('toggleTask through the session is undoable', () => {
  fs.mkdirSync(tmp, { recursive: true });
  const md = path.join(tmp, 'undo.md');
  fs.writeFileSync(md, '- [ ] a\n');
  const posted = [];
  const s = new lib.ReviewSession({
    mdPath: md, author: () => 'R', showResolved: () => true, post: (m) => posted.push(m), resolveImage: (x) => x,
    getText: () => fs.readFileSync(md, 'utf8'), isDirty: () => false, openLink: () => {},
  });
  s.handle({ type: 'ready' });
  s.handle({ type: 'toggleTask', line: 0, checked: true });
  assert.equal(fs.readFileSync(md, 'utf8'), '- [x] a\n');
  s.handle({ type: 'undo' });
  assert.equal(fs.readFileSync(md, 'utf8'), '- [ ] a\n');
});

test('GitHub alerts', () => {
  const html = render('> [!WARNING]\n> Careful here.\n\n> [!tip]\n> Lowercase tip.\n\n> [!NOPE] stays\n');
  assert.match(html, /<blockquote class="mdr-alert mdr-alert-warning" data-ls="0" data-le="2">\n<div class="mdr-alert-title mdr-ui">Warning<\/div>\n<p data-ls="0" data-le="2">Careful here.<\/p>/);
  assert.match(html, /mdr-alert-tip[\s\S]*?<p[^>]*>Lowercase tip.<\/p>/);
  assert.match(html, /<blockquote data-ls="6"[^>]*>\n<p[^>]*>\[!NOPE\] stays/);
  // Like GitHub: the marker alone on the first line, in a top-level quote.
  assert.doesNotMatch(render('> [!NOTE] Same line.\n'), /mdr-alert/);
  assert.doesNotMatch(render('> > [!NOTE]\n> > nested\n'), /mdr-alert/);
});

test('==mark==, highlighted code, unknown languages, Mermaid fences', () => {
  assert.match(render('a ==b== c\n'), /<mark>b<\/mark>/);
  assert.match(render('```python\nx = 1\n```\n'), /<code data-ls="0" data-le="3" class="language-python">x = <span class="hljs-number">1<\/span>/);
  assert.match(render('```nosuchlang\n<x>\n```\n'), /class="language-nosuchlang">&lt;x&gt;/);
  assert.match(render('```\nplain\n```\n'), /<code data-ls="0" data-le="3">plain/);
  const m = render('```mermaid\ngraph TD; A-->B\n```\n');
  assert.equal(m, '<div class="mdr-wrap mdr-mermaid" data-ls="0" data-le="3"><pre class="mdr-mermaid-src mdr-ui">graph TD; A--&gt;B\n</pre></div>\n');
});
