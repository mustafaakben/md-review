// Comment kinds, severity, and section/document threads: the store, the
// agent prompt, and the CLI's `context` / `next`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');
const { store } = lib;
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, 'tmp', 'kinds');
const cli = path.join(here, '..', 'cli', 'mdreview.mjs');
const anchor = (quote, lineStart = 1, lineEnd = lineStart) => ({ quote, prefix: '', suffix: '', lineStart, lineEnd });

test('kind, severity and scope are stored only when meaningful, and can be changed', () => {
  const data = { schemaVersion: 1, file: 'x.md', comments: [] };
  const a = store.addComment(data, 'R', anchor('q'), 'b', { kind: 'question', severity: 'major', scope: 'section' });
  assert.deepEqual([a.kind, a.severity, a.scope], ['question', 'major', 'section']);
  const b = store.addComment(data, 'R', anchor('q'), 'b', { kind: 'comment', severity: null, scope: 'bogus' });
  assert.deepEqual(['kind', 'severity', 'scope'].filter((k) => k in b), [], 'defaults and junk are not written');
  store.setMeta(data, a.id, { kind: 'comment', severity: 'nit' });
  assert.deepEqual([a.kind, a.severity, a.scope], [undefined, 'nit', 'section']);
  assert.ok(!('kind' in a));
});

test('the prompt tags kinds and severities, lists major first, and explains them', () => {
  const c = (id, extra) => ({ id, author: 'R', createdAt: '', anchor: anchor('text ' + id, 3), body: 'fix ' + id, status: 'submitted', submittedAt: null, resolvedAt: null, replies: [], ...extra });
  const p = lib.buildAgentPrompt({
    mdPath: '/w/a.md',
    cwd: '/w',
    comments: [c('c_nit', { severity: 'nit' }), c('c_q', { kind: 'question' }), c('c_major', { severity: 'major' }), c('c_doc', { scope: 'document' })],
  });
  const order = [...p.matchAll(/^- (c_\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(order, ['c_major', 'c_nit', 'c_q', 'c_doc']);
  assert.match(p, /- c_q \[question\] \(lines 3-3\): "text c_q" -> fix c_q/);
  assert.match(p, /- c_doc \[whole document\]: the whole document -> fix c_doc/);
  assert.match(p, /kind "question": answer it in a reply/);
});

test('CLI: a section thread shows the whole section; a document thread has no lines; next goes major first', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const md = ['# Paper', '', '## Methods', '', 'We sampled riders.', '', '```', '# not a heading', '```', '', '### Data', '', 'Six cities.', '', '## Results', '', 'Use rose.', ''].join('\n');
  fs.writeFileSync(path.join(tmp, 'p.md'), md);
  const c = (id, quote, extra) => ({ id, author: 'R', createdAt: '2026-09-26T10:00:00.000Z', anchor: anchor(quote, 1), body: 'b', status: 'submitted', submittedAt: null, resolvedAt: null, replies: [], ...extra });
  fs.writeFileSync(
    path.join(tmp, 'p.md.comments.json'),
    JSON.stringify({
      schemaVersion: 1,
      file: 'p.md',
      comments: [c('c_text', 'Use rose', {}), c('c_sec', 'Methods', { scope: 'section', kind: 'question' }), c('c_doc', '', { scope: 'document', severity: 'major' })],
    }),
  );
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { cwd: tmp, encoding: 'utf8' });
  const sec = JSON.parse(run('context', 'p.md', 'c_sec', '--json'));
  assert.deepEqual([sec.found, sec.lineStart, sec.lineEnd], [true, 3, 14], 'through ### Data, up to ## Results; the fenced # is not a heading');
  const text = run('context', 'p.md', 'c_sec');
  assert.match(text, /tags="whole section, question"/);
  assert.match(text, /<user_selected_text section="true">Methods<\/user_selected_text>/);
  assert.match(text, /answer it in a reply/);
  const doc = JSON.parse(run('context', 'p.md', 'c_doc', '--json'));
  assert.deepEqual([doc.found, doc.lineStart, doc.source.length], [true, 0, 0]);
  assert.match(run('context', 'p.md', 'c_doc'), /<about>the whole document<\/about>/);
  assert.match(run('next', 'p.md'), /^<thread id="c_doc" file="p\.md" where="p\.md" status="submitted" tags="whole document, major">$/m);
});

test('CLI: a section ends at the next heading, not at fences, rules or deeper headings', () => {
  const dir = path.join(tmp, 'ends');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const end = (lines, quote) => {
    fs.writeFileSync(path.join(dir, 'e.md'), lines.join('\n'));
    const c = { id: 'c1', author: 'R', createdAt: '2026-09-26T10:00:00.000Z', anchor: anchor(quote, 1), body: 'b', status: 'submitted', scope: 'section', replies: [] };
    fs.writeFileSync(path.join(dir, 'e.md.comments.json'), JSON.stringify({ schemaVersion: 1, file: 'e.md', comments: [c] }));
    const out = JSON.parse(execFileSync(process.execPath, [cli, 'context', 'e.md', 'c1', '--json'], { cwd: dir, encoding: 'utf8' }));
    return out.lineEnd;
  };
  // A --- after a closing fence or an ATX heading is a rule, not a setext underline.
  assert.equal(end(['## S', '', '```', 'code', '```', '---', '', 'after', '', '## T', ''], 'S'), 9);
  assert.equal(end(['## S', '', '### Sub', '---', '', 'x', '', '## T'], 'S'), 7);
  // A longer fence isn't closed by a shorter one inside it.
  assert.equal(end(['## S', '', '````', '```', '# inside', '```', '````', '', '## T'], 'S'), 8);
  // Indented ### is level 3, so it stays inside a level-2 section.
  assert.equal(end(['## S', '', '  ### Ind', '', 'x', '', '## T'], 'S'), 6);
  // A setext heading ends the section at the line before its text.
  assert.equal(end(['## S', '', 'x', '', 'Next', '----', '', 'y'], 'S'), 4);
  // Heading-like lines inside raw HTML blocks and comments are not headings.
  assert.equal(end(['## S', '', '<div>', '## example', '</div>', '', 'x', '', '## T'], 'S'), 8);
  assert.equal(end(['## S', '', '<!--', '## hidden', '-->', '', '## T'], 'S'), 6);
  assert.equal(end(['## S', '', '<pre>', '', '## code', '</pre>', '', '## T'], 'S'), 7);
  // The last section ends at the last non-blank line.
  assert.equal(end(['## S', '', 'x', '', ''], 'S'), 3);
});

test('CLI: describe prints no empty quote for a document thread', () => {
  const dir = path.join(tmp, 'desc');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'd.md'), '# T\n');
  const c = { id: 'c1', author: 'R', createdAt: '2026-09-26T10:00:00.000Z', anchor: anchor('', 0, 0), body: 'b', status: 'submitted', scope: 'document', replies: [] };
  fs.writeFileSync(path.join(dir, 'd.md.comments.json'), JSON.stringify({ schemaVersion: 1, file: 'd.md', comments: [c] }));
  const out = execFileSync(process.execPath, [cli, 'list', 'd.md'], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(out, /quote: ""/);
});
