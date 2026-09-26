// The instructions handed to a coding agent (Claude Code by default) when the
// reviewer presses "Send to Claude". Self-contained: the agent needs nothing
// but this text and the files it names.
import * as path from 'path';
import type { Comment } from './commentStore';

export interface PromptOptions {
  mdPath: string;
  /** Directory the agent runs in; paths in the prompt are relative to it. */
  cwd: string;
  /** Comments to address (already submitted). */
  comments: Comment[];
  /** Absolute path to cli/mdreview.mjs, when it ships with the extension. */
  cliPath?: string;
  /** Propose replacements for the reviewer to apply instead of editing the file. */
  suggest?: boolean;
}

export interface FolderPromptOptions {
  /** Folder whose reviews are sent. */
  folder: string;
  cwd: string;
  /** Files with open comments and how many each has. */
  files: { mdPath: string; open: number }[];
  cliPath: string;
  suggest?: boolean;
}

function rel(cwd: string, p: string): string {
  const r = path.relative(cwd, p);
  return !r || r.startsWith('..') || path.isAbsolute(r) ? p : r.split(path.sep).join('/');
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ANCHOR_NOTE =
  'Each comment has an anchor whose "quote" is the RENDERED text (Markdown markup stripped); lineStart-lineEnd are 1-based source lines to start looking from.';

function steps(where: string, suggest = false, cli = 'node mdreview.mjs'): string[] {
  const act = suggest
    ? [
        'For each comment:',
        `1. Don't edit ${where}. Work out the replacement for the quoted text itself (the whole quote, rewritten; empty to delete it).`,
        `2. Propose it with \`${cli} suggest <file.md> <id> "<replacement>" "<one line on why>"\`. It adds your reply with the suggestion; the reviewer applies it with one click. Leave the thread "submitted".`,
        '3. If the comment needs no text change, or can\'t be done by replacing the quote, reply instead (and resolve it if nothing is left to do).',
      ]
    : [
        'For each comment:',
        `1. Find the quoted text in ${where} and make a minimal, targeted edit that addresses the comment. Don't reformat anything else.`,
        '2. Add a reply to the thread with author "Claude" saying what you changed.',
        '3. Set its status to "resolved". If the request is unclear, leave it "submitted" and ask your question in the reply instead.',
      ];
  return [
    ...act,
    'A comment with a "suggestion" already says what the quote should become: use that text unless the comment says otherwise.',
    '',
    'Re-read the sidecar right before each write, change only the comments you touch, and never change ids.',
    '',
    'Some comments carry a "kind", "severity" or "scope":',
    '- kind "question": answer it in a reply and leave the document alone; resolve it only if the answer needs no change.',
    '- kind "praise": nothing to change; reply briefly if useful and resolve it.',
    '- severity "major", "minor" or "nit": work major first; nits are optional polish.',
    '- scope "section": the quote is a heading and the comment is about that whole section. Scope "document": no quote; it is about the whole file.',
  ];
}

const SEVERITY_RANK: Record<string, number> = { major: 0, minor: 1, nit: 2 };
const rank = (c: Comment) => SEVERITY_RANK[c.severity || ''] ?? 3;

function tags(c: Comment): string {
  const t = [c.scope === 'document' ? 'whole document' : c.scope === 'section' ? 'whole section' : '', c.kind && c.kind !== 'comment' ? c.kind : '', c.severity || ''].filter(Boolean);
  return t.length ? ` [${t.join(', ')}]` : '';
}

export function buildAgentPrompt(o: PromptOptions): string {
  const md = rel(o.cwd, o.mdPath);
  const side = md + '.comments.json';
  const one = o.comments.length === 1 ? o.comments[0] : null;
  const scope = one ? `the review comment with id ${one.id}` : `the ${plural(o.comments.length, 'submitted review comment')}`;
  const cli = o.cliPath ? `node "${o.cliPath}"` : undefined;
  const lines = [`Please address ${scope} on ${md}.`, '', `The comments live in ${side} (MD Review sidecar, schema v1). ${ANCHOR_NOTE}`, '', ...steps(md, o.suggest, cli)];
  if (cli) {
    lines.push(
      '',
      'A helper CLI does the sidecar writes safely:',
      `  ${cli} context "${md}" <id>    # the comment plus the source lines its quote is on`,
      `  ${cli} reply "${md}" <id> "what you changed"`,
      `  ${cli} resolve "${md}" <id>`,
      ...(o.suggest ? [`  ${cli} suggest "${md}" <id> "replacement for the quote" "why"`] : []),
    );
  }
  lines.push('', one ? 'The comment:' : 'The comments:');
  // Major first; otherwise the order they came in (document order).
  for (const c of [...o.comments].sort((a, b) => rank(a) - rank(b))) {
    const where = c.anchor.lineStart ? ` (lines ${c.anchor.lineStart}-${c.anchor.lineEnd || c.anchor.lineStart})` : '';
    const what = c.scope === 'document' ? 'the whole document' : `"${c.anchor.quote.replace(/\s+/g, ' ').slice(0, 200)}"`;
    lines.push(`- ${c.id}${tags(c)}${c.scope === 'document' ? '' : where}: ${what} -> ${c.body.replace(/\s+/g, ' ')}`);
    if (c.suggestion && !c.suggestion.appliedAt) lines.push(`    suggestion: replace the quote with "${c.suggestion.text.replace(/\s+/g, ' ')}"`);
    for (const r of c.replies) lines.push(`    ${r.author}: ${r.body.replace(/\s+/g, ' ')}${r.suggestion ? ` [suggested: "${r.suggestion.text.replace(/\s+/g, ' ')}"${r.suggestion.appliedAt ? ', applied' : r.suggestion.dismissedAt ? ', dismissed' : ''}]` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Every open review under a folder. The comments themselves aren't inlined:
 * the agent pulls them one at a time with `next`, which also shows the source
 * lines each quote is on.
 */
export function buildFolderPrompt(o: FolderPromptOptions): string {
  const here = path.relative(o.cwd, o.folder) === '';
  const folder = here ? '.' : rel(o.cwd, o.folder);
  const total = o.files.reduce((n, f) => n + f.open, 0);
  const cli = `node "${o.cliPath}"`;
  return [
    `Please address the ${plural(total, 'open MD Review comment')} in ${plural(o.files.length, 'file')} ${here ? 'in this folder' : `under ${folder}`}:`,
    ...o.files.map((f) => `- ${rel(o.cwd, f.mdPath)} (${f.open} open)`),
    '',
    `Each file's comments live beside it in <name>.md.comments.json (MD Review sidecar, schema v1). ${ANCHOR_NOTE}`,
    '',
    ...steps('that file', o.suggest, cli),
    '',
    'Work through them with the helper CLI, which does the sidecar writes safely:',
    `  ${cli} next "${folder}"    # the next open comment, with the source lines its quote is on`,
    `  ${cli} reply <file.md> <id> "your question"`,
    `  ${cli} resolve <file.md> <id> "what you changed"`,
    ...(o.suggest ? [`  ${cli} suggest <file.md> <id> "replacement for the quote" "why"`] : []),
    `Repeat \`next\` until it says there are no open comments (it skips threads whose last reply is yours), then summarize what you changed and which threads you left open.`,
  ].join('\n');
}
