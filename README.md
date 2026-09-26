# MD Review

**Review Markdown the way you review a Word draft, then let an AI agent do the revisions.**

MD Review is a VS Code extension that opens any `.md` file in a clean, rendered view. You select text and leave comments. When you press **Submit review**, the comments are written to a small JSON file next to your document, where Claude, Codex, or any script can read them, edit the Markdown, reply in the thread, and mark it resolved. The view updates live while the agent works.

![MD Review: the outline, a rendered document with highlighted comments, and the comments pane with filters, Send to Claude, and a thread Claude replied to](docs/screenshot.png)

```
paper.md                   ← your document; comments never touch it
paper.md.comments.json     ← the comment threads (schema below)
```

**What you get**

- A reading view with tables, footnotes, KaTeX math, and images (including pandoc `{width=…}` sizes).
- Comments on any selection, with drafts, one-click **Submit review**, replies, and resolve/reopen.
- An agent protocol and a zero-dependency CLI, so any agent can find submitted comments and answer them.
- Light editing directly in the rendered view that **never re-serializes the file**. Only the bytes you changed are written, and line endings, spacing, and markup elsewhere stay exactly as they were.
- **Send to Claude**: one click hands the open threads to Claude Code in a terminal (or copies the prompt for any other agent).
- An outline pane, find in document, `j`/`k` jumps between comments, and status and author filters.
- Reading themes (Paper, Sepia, Dusk, Night), a serif option, and zoom for the document column.
- Byte-exact undo and redo of edits made in the view.
- A collapsible comments pane, keyboard access to the outline, reading panel, and threads, and a browser mode that runs without VS Code.

It was built for academic manuscripts, but works for any Markdown: docs, specs, notes, or READMEs.

## Install

**From a release (easiest).** Download `md-review-<version>.vsix` from the [Releases page](https://github.com/mustafaakben/md-review/releases), then either run

```bash
code --install-extension md-review-0.1.0.vsix
```

or, in VS Code, open the Extensions view, click **⋯** → **Install from VSIX…**, and pick the file. Reload the window afterwards. The same file works on Windows, macOS, and Linux, and in VS Code forks that accept `.vsix` files (Cursor, Windsurf, VSCodium).

**From source.** Requires Node.js 20 or newer.

```bash
git clone https://github.com/mustafaakben/md-review.git
cd md-review
npm install
npm run package          # builds md-review-<version>.vsix
code --install-extension md-review-*.vsix
```

## Use

**Opening a file.** MD Review never takes over `.md` files. Open it one of these ways:
- Right-click the file → **Open in MD Review**
- Use the comment icon in the editor title bar
- Run **Reopen Editor With… → MD Review**

Once open, the title-bar icon **Open Markdown Source** shows the raw file beside it.

To make MD Review the default for one project, add this to that folder's `.vscode/settings.json`:

```json
"workbench.editorAssociations": { "*.md": "mdReview.editor" }
```

**Commenting.**
- Select text, click **Comment**, type, and press **Save draft** (Ctrl+Enter).
- The sidebar lists threads in document order. Click a quote to jump to its text.
- Each thread has Reply, Resolve/Reopen, and (for drafts) Delete.
- **Submit review (n)** flips every draft to `submitted` and stamps them all with one `submittedAt` time.
- The panel icon at the right end of the toolbar hides the comments pane, and **Comments** in the same spot brings it back. The choice is remembered, and clicking a highlighted comment in the text reopens the pane.

**Editing: seamless, no boxes.**
- Turn on **Edit** in the toolbar, then click anywhere in a paragraph, heading, list item, or table row and type. You can also double-click text, or use the pencil that appears in the left margin on hover.
- **Enter** or clicking away saves. **Esc** cancels.
- Bold/italic/link markup around your change is kept. For example, retyping a word inside `**Station function**` keeps the `**`.
- How it works: the host diffs the rendered text before and after your edit and maps the change onto the Markdown source. It re-renders the candidate and **writes only if the result shows exactly what you typed**. Only that block's source lines are rewritten, and every other byte (including CRLF/LF endings) is left alone.
- If a change can't be mapped with certainty (blocks with math, images, or code, or typing Markdown syntax), nothing is written. The raw Markdown for that block opens instead.
- **Alt+double-click** always opens the raw Markdown of a block.
- If the file changed on disk since it was rendered (say, Claude edited it), the edit is refused and the view refreshes.
- Ctrl+B/I/U are disabled while editing, since formatting isn't a text change. Use Alt+double-click to add markup.

**Undo.** Ctrl+Z undoes your last edit in the view and Ctrl+Y (or Ctrl+Shift+Z) redoes it; the undo and redo arrows in the toolbar do the same. They grey out as soon as there is nothing to undo, including right after another program changes the file. Undo restores the exact bytes that were there before. If something else changed the file since (say, Claude), undo is refused rather than overwriting that change.

**Getting around.**
- **Outline** (the list icon at the left of the toolbar, or Ctrl+Shift+O) lists the headings, follows your reading position, and shows how many open threads each section has. In narrow windows it slides over the document and closes after a jump.
- **Find** (Ctrl+F, or `/`) highlights every match in the document. Enter and Shift+Enter step through them; Esc closes.
- **Jump between comments** with `j` / `k` (or Alt+↓ / Alt+↑). `r` opens a reply on the current thread.
- **Filter threads** above the comment list by status (All, Drafts, Open, Resolved) and by author. An author filter also matches threads they replied to.

**Reading view.** The **Aa** icon in the toolbar picks a theme for the document column (Match VS Code, which is the default, plus Paper, Sepia, Dusk, and Night), a Sans or Serif font, and the zoom. Zoom with Ctrl+mouse wheel (or a trackpad pinch), Ctrl+= and Ctrl+−, and reset with Ctrl+0. Zoom scales only the document, not the panels. Your choices are remembered across files and sessions.

**Send to Claude.**
- **Send to Claude** at the top of the comments pane submits your drafts and starts [Claude Code](https://claude.com/claude-code) in a new terminal with a prompt that tells it how to work through the open threads. **Ask Claude** on a card sends just that thread.
- The prompt is always copied to the clipboard too, so you can paste it into any other agent.
- `mdReview.agent.command` sets the program (default `claude`; extra arguments allowed, e.g. `claude --permission-mode acceptEdits`). Set `mdReview.agent.mode` to `clipboard` to only copy the prompt.
- In browser mode the button copies the prompt.
- **Send a whole folder.** Right-click a folder in the Explorer → **Send Open Reviews in Folder to Claude** (or run it from the Command Palette for the workspace). Claude gets the list of files with open threads and works through them one at a time with the CLI's `next` command, which shows each comment with the source lines its quote is on.
- **Claude Code skill.** Run **MD Review: Add Claude Code Skill to Workspace** once per project. It writes `.claude/skills/md-review/` (a short `SKILL.md` plus a copy of the CLI), so a Claude Code session in that folder knows the review loop when you just say "go through my review comments". From a terminal, `node cli/mdreview.mjs init-claude <folder>` does the same.

**Keyboard.** Tab reaches the toolbar, the outline, and the comments. (Starting a new comment still needs a text selection with the mouse.) In the outline, ↑/↓ move between headings, Enter jumps (and moves focus to that heading), and Esc closes it. In the reading panel, the arrow keys pick a theme or font and Esc closes it. Esc inside a text box or editor only closes that box.

**Live reload.** When Claude edits the `.md` or the sidecar, the view updates on its own.

**Settings.**
- `mdReview.author`: the name on your comments. If empty (the default), your system user name is used.
- `mdReview.showResolved`: whether resolved threads show in the sidebar.
- `mdReview.agent.command`, `mdReview.agent.mode`: what **Send to Claude** runs (see above).

## Browser mode (no VS Code)

The same viewer and editor also run in a browser, using the same host code:

```bash
npm run harness -- path/to/file.md [port]      # → http://127.0.0.1:4417/
```

It serves **only the file you pass**, and it edits that file for real, so point it at the file you want to review. By default it listens on localhost only. `--host <ip>` exposes it to other machines (for example over a VPN such as Tailscale). **There is no authentication:** anyone who can reach that address can read and edit the file, so never bind it to a public network.

## Sidecar schema (v1) — for agents

File: `<name>.md.comments.json`, UTF-8, 2-space JSON.

```jsonc
{
  "schemaVersion": 1,
  "file": "paper.md",                      // basename of the Markdown file (paths are relative; synced across machines)
  "comments": [
    {
      "id": "c_mf3k2x9a1b2c3",               // unique; keep as-is
      "author": "Reviewer",
      "createdAt": "2026-09-25T20:17:07.445Z",
      "anchor": {                            // W3C TextQuoteSelector-style anchor on the RENDERED text
        "quote": "a dock will be free at the end of a trip",
        "prefix": "riders must trust that ",   // up to 32 chars of rendered text before the quote
        "suffix": " (Rivera & Chen, 2021). Plan",// up to 32 chars after
        "lineStart": 11,                     // 1-based, inclusive: source lines of the block(s) containing the quote
        "lineEnd": 11                        //   (a hint for finding the source; may be stale after edits)
      },
      "body": "Add the page number for Rivera & Chen.",
      "status": "submitted",                 // "draft" | "submitted" | "resolved"
      "submittedAt": "2026-09-25T20:17:31.002Z",  // batch time of the Submit that sent it, else null
      "resolvedAt": null,                    // set when resolved, else null
      "replies": [
        { "id": "r_…", "author": "Claude", "createdAt": "…", "body": "Added p. 52." }
      ]
    }
  ]
}
```

### Agent protocol

1. **Find work.** Look for comments with `"status": "submitted"` in any `**/*.md.comments.json`.
2. **Locate the text.**
   - `quote` is the rendered text, so Markdown markup is stripped. It won't grep-match source that has `**bold**`, link syntax, or `*italics*` inside the quote.
   - Start with `lineStart`–`lineEnd`, then search that area for the quote's words.
3. **Act.**
   - Edit the `.md` directly with minimal, targeted edits.
   - Add a reply with `"author": "Claude"`.
   - Set `"status": "resolved"` and `resolvedAt` when done. Or leave the comment `submitted` and ask a question in a reply.
4. **Write safely.**
   - Re-read the sidecar right before writing.
   - Change only the comments you touch, and keep every other field and comment as it is.
   - Never change `id`s. Don't delete other people's comments.
   - The viewer merges by re-reading on every write, so a quick read-modify-write is safe.
5. **Anchoring.** If your edit changes the quoted text itself, the comment may show as *orphaned* in the viewer. That's fine once it's resolved; the thread is kept.

### CLI (zero dependencies)

Paths can be `.md` files or folders; folders are searched recursively (skipping `node_modules` and hidden folders), and the default is the current folder.

```bash
node cli/mdreview.mjs summary [paths…]                       # open / draft / resolved counts per file
node cli/mdreview.mjs next    [paths…] [--all] [--json]      # the next open comment + the source lines its quote is on
node cli/mdreview.mjs context path/to/file.md <id> [--lines 2] [--json]
node cli/mdreview.mjs list    [paths…] [--status submitted] [--json]
node cli/mdreview.mjs show    path/to/file.md <id>
node cli/mdreview.mjs reply   path/to/file.md <id> "text" [--author Claude]
node cli/mdreview.mjs resolve path/to/file.md <id> ["closing reply"] [--author Claude]
node cli/mdreview.mjs reopen  path/to/file.md <id>
node cli/mdreview.mjs init-claude [folder] [--force]         # install the Claude Code skill
```

- `next` and `context` find the quote in the Markdown source even when the source has `**bold**`, links, footnote markers, or HTML inside it, and even when the stored line hint is stale. If a quote appears more than once, the prefix and suffix pick the right one. The quoted lines are marked with `>`.
- `next` goes file by file in document order and skips threads whose last reply is from `--author` (default `Claude`), since those are waiting on the reviewer. `--all` includes them. So an agent can loop: `next`, edit, `resolve` (or `reply` with a question), `next`, until it prints `No open comments.`
- `list --json` adds a `file` field to each comment.

## Rendering

- markdown-it (CommonMark and GFM pipe tables, with `:---` alignment)
- footnotes, `^sup^`, `~sub~`
- `$…$` / `$$…$$` math via KaTeX
- pandoc image attributes `{width="6.5in"}`, turned into CSS
- relative images resolved from the file's folder

Every block carries `data-ls`/`data-le` attributes: its 0-based source line range, end exclusive. Block editing uses these.

## Layout

| Path | What |
|---|---|
| `src/extension.ts`, `src/editorProvider.ts` | VS Code custom editor (`priority: option`), watchers |
| `src/core.ts` | host message handling (VS Code-independent; shared with the harness) |
| `src/blockEdit.ts` | byte-exact line splice + stale-edit guard |
| `src/inlineEdit.ts` | seamless edit: rendered-text diff → verified Markdown splice |
| `src/commentStore.ts` | sidecar read-merge-write |
| `src/editHistory.ts` | byte-exact undo/redo of in-view edits |
| `src/agentPrompt.ts`, `src/agentCommands.ts` | the prompts Send to Claude hands to the agent; the folder and skill commands |
| `src/render.ts` | Markdown → HTML with source-line tags |
| `webview/` | UI: selection → comment, highlights, threads, block editor; `outline.ts`, `search.ts`, `filters.ts`, `reading.ts` |
| `cli/mdreview.mjs`, `cli/SKILL.md` | agent CLI and the Claude Code skill `init-claude` installs |
| `test/` | `node --test` suites, browser harness (`npm run harness -- <file.md>`), fixtures (`test/make-fixtures.mjs`) |

## Known limits

- Block editing works on disk bytes. If the same file has unsaved edits in a text editor, save or revert them first.
- The quote is anchored on rendered text. A selection that crosses math or UI elements anchors on the visible text only.
- Undo history lives in the open view and covers edits made there. It's cleared if another program changes the file in between, so an agent's edits are never overwritten by an undo.
- Inline `<!-- COMMENT -->` storage is not implemented. By design the `.md` stays clean.

## Development

```bash
npm install
npm test            # builds, then runs the node --test suites
npm run typecheck
npm run watch       # rebuild on change; press F5 in VS Code to launch an Extension Development Host
npm run harness -- path/to/file.md   # browser mode on http://127.0.0.1:4417/
```

The fixtures in `test/fixtures/` are a fictional paper generated by `node test/make-fixtures.mjs`: one copy with CRLF line endings and one with LF. The tests check that every edit leaves all bytes outside the edited block identical, and that each file keeps its own line-ending style. `.gitattributes` keeps git from converting the fixtures.

Issues and pull requests are welcome.

## License

[MIT](LICENSE) © 2026 Mustafa Akben
