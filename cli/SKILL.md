---
name: md-review
description: Work through MD Review comments on Markdown files (sidecars named *.md.comments.json). Use when the user asks to address, answer, or resolve review comments on a Markdown document, paper, or draft, or says "go through my review".
---

# MD Review comments

The reviewer leaves comments on Markdown files in the MD Review editor. Each
`paper.md` keeps its threads in `paper.md.comments.json` beside it. Comments
with status `submitted` are waiting for you; `draft` ones are not sent yet, so
leave them alone.

The helper CLI next to this file does the sidecar reads and writes safely
(it re-reads before every write, so it never clobbers the reviewer's edits).
Run it from the project root:

```bash
node .claude/skills/md-review/mdreview.mjs summary              # open/draft/resolved counts per file
node .claude/skills/md-review/mdreview.mjs next [file-or-folder] # first open comment + the source lines it's on
node .claude/skills/md-review/mdreview.mjs context <file.md> <id>
node .claude/skills/md-review/mdreview.mjs reply   <file.md> <id> "what you changed"
node .claude/skills/md-review/mdreview.mjs resolve <file.md> <id> ["closing reply"]
node .claude/skills/md-review/mdreview.mjs list    [paths…] --status submitted
```

## Loop

1. Run `next` (on the file or folder the user named, or the project root).
   It prints the comment, its thread, and the source lines its quote is on,
   marked with `>`.
2. Make a minimal, targeted edit to the Markdown that addresses the comment.
   Don't reformat anything else. The quote is the *rendered* text, so the
   source may have `**bold**`, `[links](…)`, or citations inside it.
3. `resolve` it with a one-line reply saying what you changed. If the request
   is unclear or needs the author's judgment, `reply` with your question
   instead and leave it open. `next` skips threads whose last reply is yours,
   so it moves on to the next one.
4. Repeat until `next` says there are no open comments, then summarize what
   you changed and which threads you left open.

Never change comment ids, delete comments, or touch threads you weren't asked
about. If your edit rewrites the quoted text, the comment may show as orphaned
in the viewer; that's fine once it's resolved.
