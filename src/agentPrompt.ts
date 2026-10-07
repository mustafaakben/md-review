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
  /** The Markdown as it is now: each comment's source lines go into the prompt, so the agent needn't look them up. */
  source?: string;
  /** The session already has the full instructions from an earlier send: repeat only a one-line reminder. */
  primed?: boolean;
  /** What the session was already sent, per thread id (from the thread's last delivery to it). */
  known?: Record<string, Known>;
  /** Author name of the session's own replies ("Claude"), which it has seen by writing them. */
  agentName?: string;
}

/** A thread as the session last received it: the message ids it saw and a hash of the source lines. */
export interface Known {
  seen: string[];
  lines?: string;
}

export interface FolderPromptOptions {
  /** Folder whose reviews are sent. */
  folder: string;
  cwd: string;
  /** Files with open comments and how many each has. */
  files: { mdPath: string; open: number }[];
  cliPath: string;
  suggest?: boolean;
  /** The bound session's id: `next --session <id>` then shortens what that session was shown before. */
  session?: string;
  /** The session already has the full instructions: a short reminder instead. */
  primed?: boolean;
}

/** Agent sessions ("claude:<id>") that have had the full MD Review instructions in this window. */
export const primedSessions = new Set<string>();

function rel(cwd: string, p: string): string {
  const r = path.relative(cwd, p);
  return !r || r.startsWith('..') || path.isAbsolute(r) ? p : r.split(path.sep).join('/');
}

/**
 * `node <cli>` as the agent should type it. Inside the working folder it is a
 * bare relative path (`node .claude/skills/md-review/mdreview.mjs`), which a
 * permission rule like `Bash(node .claude/skills/md-review/mdreview.mjs:*)`
 * matches; elsewhere the full path in quotes.
 */
export function cliCommand(cwd: string, cliPath: string, quote = (p: string) => `"${p}"`): string {
  const r = rel(cwd, cliPath);
  return r !== cliPath && /^[\w./-]+$/.test(r) ? `node ${r}` : `node ${quote(cliPath)}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ANCHOR_NOTE =
  'Each comment has an anchor whose "quote" is the RENDERED text (Markdown markup stripped); lineStart-lineEnd are 1-based source lines to start looking from.';

function steps(where: string, suggest = false, cli = 'node mdreview.mjs'): string[] {
  const act = suggest
    ? [
        'For each comment:',
        `1. Don't edit ${where}. Work out the replacement for the quoted text itself (the whole quote, rewritten; empty to delete it). Write it as the text reads on screen, on one line: no Markdown and no line breaks.`,
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
    `Replies may have parentId pointing to the original comment or another reply. Preserve these relationships; use ${cli} reply <file.md> <thread-id> "answer" --parent <message-id> when answering a particular message.`,
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

/** Plain words of rendered text, for finding a quote in source that has markup in it. */
const words = (s: string) => s.replace(/[*_`~\[\]()<>#^=+{}|\\]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The source lines a comment's quote is on, numbered: the anchor's lines when
 * the quote's opening words are there, else the first line that has them.
 * Empty when it can't be found (the agent looks it up then).
 */
export function quoteLines(source: string, c: Pick<Comment, 'anchor' | 'scope'>, max = 6): string[] {
  if (c.scope === 'document' || !c.anchor.quote) return [];
  const lines = source.split(/\r?\n/);
  const head = words(c.anchor.quote).split(' ').slice(0, 6).join(' ');
  if (!head) return [];
  const has = (i: number) => words(lines[i] ?? '').includes(head);
  let from = Math.max(0, (c.anchor.lineStart || 1) - 1);
  let to = Math.max(from, (c.anchor.lineEnd || c.anchor.lineStart || 1) - 1);
  let hit = -1;
  for (let i = from; i <= to && i < lines.length; i++) if (has(i)) hit = hit < 0 ? i : hit;
  if (hit < 0) {
    hit = lines.findIndex((_, i) => has(i));
    if (hit < 0) return [];
    from = to = hit;
  }
  from = Math.min(from, hit);
  to = Math.min(Math.max(to, hit), from + max - 1, lines.length - 1);
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${String(i + 1).padStart(5)} | ${lines[i]}`);
  return out;
}

/** A short, stable fingerprint (FNV-1a) of the source lines a thread was sent with. */
export function linesHash(lines: string[]): string {
  let h = 0x811c9dc5;
  const s = lines.join('\n');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** What a session holds after receiving `c` with `source`: recorded on delivery, passed back as `known`. */
export function knownAfterSend(c: Comment, source: string): Known {
  return { seen: [c.id, ...c.replies.map(r => r.id)], lines: linesHash(quoteLines(source, c)) };
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
/** The opening words of a message the session already has: enough to recognise it. */
export function preview(s: string, n = 8): string {
  const w = flat(s).split(' ');
  return w.length > n ? w.slice(0, n).join(' ') + ' …' : w.join(' ');
}

/**
 * The short prompt, when the agent has the CLI and the source lines are known:
 * one `apply` command handles every thread, so the agent needs a single step.
 * Everything it needs is inline, in tagged blocks so the request, the exact
 * selection and the surrounding lines can't be confused. The full instructions
 * go to a session once; after that a one-line reminder. A thread the session
 * has seen before carries only what's new: earlier messages shrink to their id
 * and opening words, and the source lines are left out unless they changed.
 */
function fastPrompt(o: PromptOptions, cli: string): string {
  const md = rel(o.cwd, o.mdPath);
  const cs = [...o.comments].sort((a, b) => rank(a) - rank(b));
  const has = (f: (c: Comment) => boolean) => cs.some(f);
  const rules = [
    has((c) => c.kind === 'question') && '- [question]: answer with reply; don\'t edit (resolve instead if the answer needs no change).',
    has((c) => c.kind === 'praise') && '- [praise]: nothing to change; resolve with a short note.',
    has((c) => !!c.severity) && '- major before minor; nit is optional polish.',
    has((c) => c.scope === 'section') && '- [whole section]: the selection is a heading; the comment is about the section under it.',
    has((c) => c.scope === 'document') && '- [whole document]: about the whole file; there is no selection.',
    has((c) => !!c.suggestion && !c.suggestion.appliedAt) && '- <suggestion>: what the selection should become; use it unless the request says otherwise.',
  ].filter(Boolean) as string[];
  const nested = has(c => c.replies.some(r => r.parentId));
  const out = [`<md_review file="${md}" path="${o.mdPath}" cwd="${o.cwd}" threads="${cs.length}">`];
  if (o.primed) {
    out.push(
      '<instructions>',
      `Same MD Review instructions as before. One command, run in ${o.cwd}: ${cli} apply "${md}" then fix <id> "<old>" "<new>" "<note>" | reply <id> "<text>" | resolve <id> "<note>"${nested ? ' | reply-to <thread-id> <message-id> "<text>"' : ''}, repeated. Edit only <user_selected_text>. Don't read the files; no summary.`,
      `Messages shown as "[id] author: opening words …" were sent to you before; if you no longer have one, \`${cli} context "${md}" <thread-id>\` prints the whole thread.`,
      ...rules,
      '</instructions>',
    );
  } else {
    out.push(
      '<instructions>',
      `Handle every thread below with ONE command, run in ${o.cwd} exactly as written:`,
      `  ${cli} apply "${md}" <actions>`,
      'Actions, repeated as needed:',
      '  fix <id> "<old>" "<new>" "<note>"   edit and resolve. old: the exact source text to replace, copied from <context> (markup included, just enough to be unique). new: its replacement. Keep it minimal.',
      '  reply <id> "<text>"                 an answer, or your question if the request is unclear (stays open)',
      '  resolve <id> "<note>"               nothing to change',
      ...(nested ? ['  reply-to <thread-id> <message-id> "<text>"  answer a specific message; keep the reply_to relationships shown below.'] : []),
      '<user_selected_text> is exactly what the reviewer highlighted (no markup): the scope. Change only it unless the <request> asks for more. <context> is the source lines around it, for meaning and for copying <old>.',
      `Later sends shrink messages you've seen to "[id] author: opening words …", drop unchanged <context>, and mark what's new with new="true"; \`${cli} context "${md}" <thread-id>\` prints a thread whole.`,
      ...rules,
      "Don't read the files: everything you need is below. If apply fails, nothing was changed; correct it and run it again, or edit the file yourself and run resolve. Then stop: no summary.",
      '</instructions>',
    );
  }
  for (const c of cs) {
    const k = o.known?.[c.id];
    const seen = new Set(k?.seen ?? []);
    const lines = quoteLines(o.source!, c);
    // Seen: what this session was sent, or wrote itself. A thread with nothing new goes whole (a resend).
    const isSeen = (id: string, author: string) => seen.has(id) || (!!o.agentName && author === o.agentName);
    const follow = !!k && seen.has(c.id) && c.replies.some(r => !isSeen(r.id, r.author));
    const sameLines = follow && k!.lines === linesHash(lines);
    const t = tags(c).slice(2, -1);
    out.push(`<thread id="${c.id}"${t ? ` tags="${t}"` : ''}${follow ? ' follow_up="true"' : ''}>`);
    // The request and the selection define the task, so they always go whole, even in a follow-up.
    out.push(`<request author="${c.author}">${flat(c.body)}</request>`);
    if (c.scope !== 'document' && c.anchor.quote) out.push(`<user_selected_text>${flat(c.anchor.quote)}</user_selected_text>`);
    if (c.suggestion && !c.suggestion.appliedAt) out.push(`<suggestion>${flat(c.suggestion.text)}</suggestion>`);
    if (lines.length) {
      const span = `${lines[0].split('|')[0].trim()}${lines.length > 1 ? `-${lines[lines.length - 1].split('|')[0].trim()}` : ''}`;
      out.push(sameLines ? `<context lines="${span}" unchanged="true"/>` : `<context lines="${span}">\n${lines.join('\n')}\n</context>`);
    }
    for (const r of c.replies) {
      const to = r.parentId ? ` reply_to="${r.parentId}"` : '';
      if (follow && isSeen(r.id, r.author)) out.push(`[${r.id}${r.parentId ? ` reply to ${r.parentId}` : ''}] ${r.author}: ${preview(r.body)}`);
      else out.push(`<message id="${r.id}"${to} author="${r.author}"${follow ? ' new="true"' : ''}>${flat(r.body)}</message>`);
    }
    out.push('</thread>');
  }
  out.push('</md_review>');
  return out.join('\n');
}

export function buildAgentPrompt(o: PromptOptions): string {
  const cliFast = o.cliPath && o.source !== undefined && !o.suggest ? cliCommand(o.cwd, o.cliPath) : undefined;
  if (cliFast) return fastPrompt(o, cliFast);
  const md = rel(o.cwd, o.mdPath);
  const side = md + '.comments.json';
  const one = o.comments.length === 1 ? o.comments[0] : null;
  const scope = one ? `the review comment with id ${one.id}` : `the ${plural(o.comments.length, 'submitted review comment')}`;
  const cli = o.cliPath ? cliCommand(o.cwd, o.cliPath) : undefined;
  const lines = [
    `Please address ${scope} on ${md}.`,
    '',
    `File: ${o.mdPath}`,
    `Comments: ${o.mdPath}.comments.json (MD Review sidecar, schema v1). ${ANCHOR_NOTE}${o.source !== undefined ? ' The source lines each quote is on are shown under it, numbered.' : ''}`,
    '',
    ...steps(md, o.suggest, cli),
  ];
  if (cli) {
    lines.push(
      '',
      'A helper CLI does the sidecar writes safely:',
      `  ${cli} context "${md}" <id>    # the comment plus the source lines its quote is on${o.source !== undefined ? ' (only if the lines below are not enough)' : ''}`,
      `  ${cli} resolve "${md}" <id> "what you changed"    # reply and resolve in one step`,
      `  ${cli} reply "${md}" <id> "your question"    # only when you need the reviewer's answer`,
      ...(o.suggest ? [`  ${cli} suggest "${md}" <id> "replacement for the quote" "why"`] : []),
    );
  }
  lines.push('', one ? 'The comment:' : 'The comments:');
  // Major first; otherwise the order they came in (document order).
  for (const c of [...o.comments].sort((a, b) => rank(a) - rank(b))) {
    const where = c.anchor.lineStart ? ` (lines ${c.anchor.lineStart}-${c.anchor.lineEnd || c.anchor.lineStart})` : '';
    const what = c.scope === 'document' ? 'the whole document' : `"${c.anchor.quote.replace(/\s+/g, ' ').slice(0, o.suggest ? undefined : 200)}"`;
    lines.push(`- ${c.id}${tags(c)}${c.scope === 'document' ? '' : where}: ${what} -> ${c.body.replace(/\s+/g, ' ')}`);
    if (c.suggestion && !c.suggestion.appliedAt) lines.push(`    suggestion: replace the quote with "${c.suggestion.text.replace(/\s+/g, ' ')}"`);
    if (o.source !== undefined) lines.push(...quoteLines(o.source, c));
    for (const r of c.replies) lines.push(`    [${r.id}${r.parentId ? ` reply to ${r.parentId}` : ''}] ${r.author}: ${r.body.replace(/\s+/g, ' ')}${r.suggestion ? ` [suggested: "${r.suggestion.text.replace(/\s+/g, ' ')}"${r.suggestion.appliedAt ? ', applied' : r.suggestion.dismissedAt ? ', dismissed' : ''}]` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Every open review under a folder. The comments themselves aren't inlined:
 * the agent pulls them one at a time with `next`, which prints each as the same
 * tagged <thread> block a Send puts inline. With the session's id, `next`
 * shortens what that session was shown before; a primed session gets a
 * reminder instead of the instructions.
 */
export function buildFolderPrompt(o: FolderPromptOptions): string {
  const here = path.relative(o.cwd, o.folder) === '';
  const folder = here ? '.' : rel(o.cwd, o.folder);
  const total = o.files.reduce((n, f) => n + f.open, 0);
  const cli = cliCommand(o.cwd, o.cliPath);
  const next = `${cli} next "${folder}"${o.session ? ` --session ${o.session}` : ''}`;
  const act = o.suggest
    ? `\`${cli} suggest <file.md> <id> "<replacement for the whole selection>" "<why>"\` (plain text on one line; don't edit the file), or reply/resolve when no text change fits`
    : `\`${cli} fix <file.md> <id> "<old>" "<new>" "<note>"\` (old: exact source text copied from <context>, markup included, just enough to be unique; it edits and resolves), \`reply <file.md> <id> "<text>"\` to answer or ask, \`resolve <file.md> <id> "<note>"\` when nothing changes`;
  const out = [
    `<md_review folder="${folder}" cwd="${o.cwd}" threads="${total}">`,
    '<files>',
    ...o.files.map((f) => `${rel(o.cwd, f.mdPath)} (${f.open} open)`),
    '</files>',
    '<instructions>',
  ];
  if (o.primed) {
    out.push(
      `Same MD Review instructions as before. In ${o.cwd}, run \`${next}\` for each open thread, act on it with ${o.suggest ? 'suggest' : 'fix, reply or resolve'}, and repeat until it says there are no open comments. Edit only <user_selected_text>. Then summarize in a line or two.`,
      `Messages shown as "[id] author: opening words …" you have seen before; \`${cli} context <file.md> <thread-id>\` prints a thread whole.`,
    );
  } else {
    out.push(
      `Work in ${o.cwd}. Run \`${next}\` to get the next open thread as a <thread> block, act on it, and repeat until it says there are no open comments.`,
      '<user_selected_text> is exactly what the reviewer highlighted (no markup): the scope. Change only it unless the <request> asks for more. <context> is the source lines around it (">" marks the lines the selection is on), for meaning and for copying <old>.',
      `Act with ${act}. To answer one message: \`${cli} reply <file.md> <thread-id> "<text>" --parent <message-id>\`.`,
      '<note> says how to treat questions and praise; tags: major before minor, nit is optional; section means the comment covers the section under the heading; a document thread has no selection.',
      `A thread you were shown before comes back with follow_up="true": messages you have seen shrink to "[id] author: opening words …", and new="true" marks what's new. \`${cli} context <file.md> <thread-id>\` prints a thread whole.`,
      "Don't read the sidecar files; `next` gives you everything. When done, summarize what you changed and which threads you left open, in a line or two.",
    );
  }
  out.push('</instructions>', '</md_review>');
  return out.join('\n');
}
