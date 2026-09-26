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
}

export interface FolderPromptOptions {
  /** Folder whose reviews are sent. */
  folder: string;
  cwd: string;
  /** Files with open comments and how many each has. */
  files: { mdPath: string; open: number }[];
  cliPath: string;
}

function rel(cwd: string, p: string): string {
  const r = path.relative(cwd, p);
  return !r || r.startsWith('..') || path.isAbsolute(r) ? p : r.split(path.sep).join('/');
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ANCHOR_NOTE =
  'Each comment has an anchor whose "quote" is the RENDERED text (Markdown markup stripped); lineStart-lineEnd are 1-based source lines to start looking from.';

function steps(where: string): string[] {
  return [
    'For each comment:',
    `1. Find the quoted text in ${where} and make a minimal, targeted edit that addresses the comment. Don't reformat anything else.`,
    '2. Add a reply to the thread with author "Claude" saying what you changed.',
    '3. Set its status to "resolved". If the request is unclear, leave it "submitted" and ask your question in the reply instead.',
    '',
    'Re-read the sidecar right before each write, change only the comments you touch, and never change ids.',
  ];
}

export function buildAgentPrompt(o: PromptOptions): string {
  const md = rel(o.cwd, o.mdPath);
  const side = md + '.comments.json';
  const one = o.comments.length === 1 ? o.comments[0] : null;
  const scope = one ? `the review comment with id ${one.id}` : `the ${plural(o.comments.length, 'submitted review comment')}`;
  const lines = [`Please address ${scope} on ${md}.`, '', `The comments live in ${side} (MD Review sidecar, schema v1). ${ANCHOR_NOTE}`, '', ...steps(md)];
  if (o.cliPath) {
    const cli = `node "${o.cliPath}"`;
    lines.push(
      '',
      'A helper CLI does the sidecar writes safely:',
      `  ${cli} context "${md}" <id>    # the comment plus the source lines its quote is on`,
      `  ${cli} reply "${md}" <id> "what you changed"`,
      `  ${cli} resolve "${md}" <id>`,
    );
  }
  lines.push('', one ? 'The comment:' : 'The comments:');
  for (const c of o.comments) {
    const where = c.anchor.lineStart ? ` (lines ${c.anchor.lineStart}-${c.anchor.lineEnd || c.anchor.lineStart})` : '';
    lines.push(`- ${c.id}${where}: "${c.anchor.quote.replace(/\s+/g, ' ').slice(0, 200)}" -> ${c.body.replace(/\s+/g, ' ')}`);
    for (const r of c.replies) lines.push(`    ${r.author}: ${r.body.replace(/\s+/g, ' ')}`);
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
    ...steps('that file'),
    '',
    'Work through them with the helper CLI, which does the sidecar writes safely:',
    `  ${cli} next "${folder}"    # the next open comment, with the source lines its quote is on`,
    `  ${cli} reply <file.md> <id> "your question"`,
    `  ${cli} resolve <file.md> <id> "what you changed"`,
    `Repeat \`next\` until it says there are no open comments (it skips threads whose last reply is yours), then summarize what you changed and which threads you left open.`,
  ].join('\n');
}
