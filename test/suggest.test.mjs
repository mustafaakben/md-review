// Suggested edits: stored on the comment or on the agent's reply, applied
// through the verified inline-edit path, and asked for by suggest mode.
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
const tmp = path.join(here, 'tmp', 'suggest');
const cli = path.join(here, '..', 'cli', 'mdreview.mjs');
const run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const anchor = (quote, line) => ({ quote, prefix: '', suffix: '', lineStart: line, lineEnd: line });

function session(name, text) {
  fs.mkdirSync(tmp, { recursive: true });
  const md = path.join(tmp, name);
  fs.writeFileSync(md, text);
  fs.rmSync(md + '.comments.json', { force: true });
  const posted = [];
  const s = new lib.ReviewSession({
    mdPath: md, author: () => 'R', showResolved: () => true, post: (m) => posted.push(m), resolveImage: (x) => x,
    getText: () => fs.readFileSync(md, 'utf8'), isDirty: () => false, openLink: () => {},
  });
  s.handle({ type: 'ready' });
  return { md, s, posted, side: () => store.readSidecar(md) };
}

test('a suggestion is stored with the comment, but not on a section or document comment', () => {
  const { s, side } = session('store.md', '# T\n\nThe cat sat on the mat.\n');
  s.handle({ type: 'addComment', anchor: anchor('cat', 3), body: 'Dog?', suggestion: 'dog' });
  s.handle({ type: 'addComment', anchor: anchor('T', 1), body: 'x', meta: { scope: 'section' }, suggestion: 'nope' });
  const [a, b] = side().comments;
  assert.deepEqual(a.suggestion, { text: 'dog' });
  assert.equal(b.suggestion, undefined);
});

test('applying rewrites only the quote, resolves the thread, and undo reverts the text', () => {
  const { md, s, side, posted } = session('apply.md', '# T\n\nThe **cat** sat on the mat.\n');
  s.handle({ type: 'addComment', anchor: anchor('cat sat', 3), body: 'Dog.', suggestion: 'dog sat' });
  const id = side().comments[0].id;
  s.handle({ type: 'applySuggestion', id, ls: 2, le: 3, kind: 'paragraph', oldText: 'The cat sat on the mat.', newText: 'The dog sat on the mat.' });
  assert.equal(fs.readFileSync(md, 'utf8'), '# T\n\nThe **dog** sat on the mat.\n');
  const c = side().comments[0];
  assert.equal(c.status, 'resolved');
  assert.ok(c.suggestion.appliedAt);
  s.handle({ type: 'undo' });
  assert.equal(fs.readFileSync(md, 'utf8'), '# T\n\nThe **cat** sat on the mat.\n');
  // Undo also reopens the thread and the suggestion, so Apply is offered again.
  const back = side().comments[0];
  assert.equal(back.status, 'draft'); // as it was before Apply
  assert.equal(back.suggestion.appliedAt, undefined);
  // A change that can't be mapped safely writes nothing and opens the source instead.
  posted.length = 0;
  s.handle({ type: 'applySuggestion', id, ls: 2, le: 3, kind: 'paragraph', oldText: 'The cat sat on the mat.', newText: '' });
  assert.equal(fs.readFileSync(md, 'utf8'), '# T\n\nThe **cat** sat on the mat.\n');
  assert.ok(posted.some((m) => m.type === 'inlineFailed'));
});

test('undo and redo move each applied suggestion with its text, however many were applied', () => {
  const { md, s, side } = session('apply2.md', '# T\n\nThe cat sat.\n\nThe mat was red.\n');
  s.handle({ type: 'addComment', anchor: anchor('cat', 3), body: 'a', suggestion: 'dog' });
  s.handle({ type: 'addComment', anchor: anchor('red', 5), body: 'b', suggestion: 'blue' });
  s.handle({ type: 'submitReview' });
  const [a, b] = side().comments.map((c) => c.id);
  s.handle({ type: 'applySuggestion', id: a, ls: 2, le: 3, kind: 'paragraph', oldText: 'The cat sat.', newText: 'The dog sat.' });
  s.handle({ type: 'applySuggestion', id: b, ls: 4, le: 5, kind: 'paragraph', oldText: 'The mat was red.', newText: 'The mat was blue.' });
  const state = () => side().comments.map((c) => [c.status, !!c.suggestion.appliedAt]);
  assert.deepEqual(state(), [['resolved', true], ['resolved', true]]);
  s.handle({ type: 'undo' });
  s.handle({ type: 'undo' });
  assert.equal(fs.readFileSync(md, 'utf8'), '# T\n\nThe cat sat.\n\nThe mat was red.\n');
  assert.deepEqual(state(), [['submitted', false], ['submitted', false]]);
  s.handle({ type: 'redo' });
  assert.equal(fs.readFileSync(md, 'utf8'), '# T\n\nThe dog sat.\n\nThe mat was red.\n');
  assert.deepEqual(state(), [['resolved', true], ['submitted', false]]);
});

test('the CLI suggests on a reply; dismissing marks it; document threads refuse', () => {
  const { md, s, side } = session('cli.md', '# T\n\nThe cat sat.\n');
  s.handle({ type: 'addComment', anchor: anchor('cat', 3), body: 'Better word?' });
  s.handle({ type: 'addComment', anchor: anchor('', 0), body: 'Overall', meta: { scope: 'document' } });
  const [c, d] = side().comments;
  s.handle({ type: 'submitReview' });
  assert.match(run('suggest', md, c.id, 'feline', 'More formal.'), /Suggested an edit/);
  const r = side().comments[0].replies[0];
  assert.deepEqual([r.author, r.body, r.suggestion], ['Claude', 'More formal.', { text: 'feline' }]);
  assert.match(run('context', md, c.id), /suggests "feline"/);
  s.handle({ type: 'dismissSuggestion', id: c.id, from: r.id });
  assert.ok(side().comments[0].replies[0].suggestion.dismissedAt);
  assert.throws(() => run('suggest', md, d.id, 'x'), /no quote to replace/);
});

test('suggest mode asks the agent for suggestions, and a reviewer suggestion is in the prompt', () => {
  const c = { id: 'c1', author: 'R', createdAt: '', anchor: anchor('cat', 3), body: 'Dog?', status: 'submitted', submittedAt: null, resolvedAt: null, replies: [], suggestion: { text: 'dog' } };
  const edit = lib.buildAgentPrompt({ mdPath: '/w/a.md', cwd: '/w', comments: [c], cliPath: '/x/mdreview.mjs' });
  assert.match(edit, /suggestion: replace the quote with "dog"/);
  assert.doesNotMatch(edit, /mdreview\.mjs" suggest/);
  const sug = lib.buildAgentPrompt({ mdPath: '/w/a.md', cwd: '/w', comments: [c], cliPath: '/x/mdreview.mjs', suggest: true });
  assert.match(sug, /Don't edit a\.md/);
  assert.match(sug, /mdreview\.mjs" suggest "a\.md" <id>/);
});

test('an agent suggestion is one line of text, and the round counts it apart from questions', () => {
  const { md, s, side, posted } = session('round.md', '# T\n\nThe cat sat.\n\nA dog ran.\n');
  s.handle({ type: 'addComment', anchor: anchor('cat', 3), body: 'Better word?' });
  s.handle({ type: 'addComment', anchor: anchor('dog', 5), body: 'Which dog?' });
  s.handle({ type: 'sendToAgent' });
  const [a, b] = side().comments;
  run('suggest', md, a.id, 'fe\n\n  line');
  assert.equal(side().comments[0].replies[0].suggestion.text, 'fe line');
  run('reply', md, b.id, 'A terrier?');
  s.onSidecarChanged();
  const r = posted.filter((m) => m.type === 'round').at(-1).round;
  assert.deepEqual([r.finished, r.suggestions, r.questions, r.questionIds.length], [true, 1, 1, 2]);
  assert.equal(lib.roundSummary(r), '0 resolved, 1 suggested edit and 1 question for you');
});

test('suggest mode gives the agent the whole quote and asks for plain text', () => {
  const long = 'word '.repeat(80).trim();
  const c = { id: 'c1', author: 'R', createdAt: '', anchor: anchor(long, 3), body: 'Shorter', status: 'submitted', submittedAt: null, resolvedAt: null, replies: [] };
  const sug = lib.buildAgentPrompt({ mdPath: '/w/a.md', cwd: '/w', comments: [c], suggest: true });
  assert.ok(sug.includes(long));
  assert.match(sug, /no Markdown and no line breaks/);
});
