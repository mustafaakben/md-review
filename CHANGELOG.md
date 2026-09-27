# Changelog

## Unreleased

### Continuous writing and contextual review

- Replace paragraph-by-paragraph editing with a continuous Markdown canvas. Headings, emphasis, inline code, and links format as you write; Enter continues paragraphs, lists, and quotes without an Edit/Done switch.
- Save source transactions automatically after a short pause or on blur. Untouched bytes, BOM, and existing line endings are preserved. Queued saves keep later typing intact, and conflicting external changes stop autosave while retaining the local draft for recovery.
- Render tables, math, images, citations, and code outside the active source region. Edit their Markdown in the same canvas. Writing has its own continuous undo/redo history, separate from review-action history.
- Introduce a Bear-inspired interface with a charcoal outline, white writing canvas, muted red accents, a quieter toolbar, and a more legible review pane. Secondary controls live under **More tools**, and word counts appear in the document footer.
- Replace the large selection action with a compact **Add comment** icon and tooltip. It sits beside the selection when space permits, falls below when necessary, preserves the selected quote, and opens the existing comment composer.
- With the review pane closed, clicking a highlighted passage opens a compact thread popup with Reply, Resolve/Reopen, Edit passage, and Open in review pane. With the pane open, it reveals the corresponding thread. Clicking a sidebar quote highlights and scrolls to its passage without moving the writing cursor.
- Preserve the active passage's screen position when opening or closing the review pane. Dragging across a highlight still selects text. Alt+Enter (Option+Return on macOS) opens a comment at the cursor.
- Show hover previews only while Command is held on macOS or Control is held on Windows/Linux. Releasing the modifier dismisses the transient preview; normal clicks continue to open the thread popup.
- Style Find/Replace controls, focus states, checkboxes, and match highlights to match the rest of the interface, with a compact layout for narrow windows.
- Fix table header/body column alignment and extra whitespace in rendered table widgets. Correct invisible caret-buffer margins around formatted text and allow wide table content to scroll without stretching the writing canvas.
- Preserve keyboard focus when dismissing document tools opened from the overflow menu. Include the selection action's Tabler icon and its MIT license in the extension package.

### Review features

- See what Claude changed: Send to Claude saves a copy of the file, and the **Changes** toggle in the toolbar paints a word-level redline against it (underlined insertions, struck-through deletions). Math, code, diagrams and tables show a block-level mark with a before view. Each change has **Keep** and **Revert** (byte-exact, with Undo, refused if the file changed underneath), and **Accept all** drops the copy. Threads Claude resolved or answered get **Show change**, and the round summary says how many blocks changed, with **Review changes**. Edits you make in the view after sending (outside Claude's changes) count as yours and don't show. Only changed blocks are diffed, and the saved copy isn't read or parsed until you turn the view on or edit the file in the view. The copy is a file in the extension's storage, at most 50 files and 64 MB per workspace.
- Suggested edits: **Suggest edit** in the comment box proposes replacement text for the selection, and the card shows it as a redline with **Apply** (a checked, byte-exact rewrite of just that text, with Undo) that resolves the thread. With `mdReview.agent.editMode` set to `suggest`, Claude proposes changes with the CLI's new `suggest` command instead of editing, and you apply or dismiss each one.
- **Review with Claude**: a reviewer menu in the review pane (Copy edit, Clarity and flow, Methods reviewer, Claims need citations, Reviewer 2, or a custom one-liner, plus your own in `.mdreview/reviewers/*.md`) starts Claude as first reviewer. Claude leaves up to 12 draft comments with the CLI's new `comment` command, which anchors a quote through the source's markup. They wait under **From Claude** with **Keep**, **Do it** and **Discard**, and Submit review and Send to Claude skip them until you've triaged them. **Do it** keeps a draft and queues it for Claude rather than starting Claude for each one: the next Send to Claude hands over everything queued. The comments pane shows "Claude is reviewing · 3 comments so far", then how many are left to triage once Claude runs the CLI's new `review-done` (or reaches the limit, or goes quiet); a Send to Claude round started meanwhile keeps its own row. Also in the Command Palette as **MD Review: Review with Claude**. Workspace briefs are read only when picked (the first 64 KB of a plain file, never a symlink) and reach Claude as quoted material under its rules.
- Review inbox: an **MD Review** view in the Explorer lists threads across the workspace under **Needs you**, **From Claude, to triage** (drafts Review with Claude left), **Waiting on Claude** (including threads Claude is working on right now), **Drafts**, and **Resolved**, grouped by file. Clicking a thread opens the file in MD Review at that thread. The view title has **Send All to Claude** (in trusted folders; one terminal per workspace folder with open threads) and Refresh, and the status bar shows "4 need you". Nothing runs at start-up: the workspace is searched only when the view is first expanded, after that a changed sidecar is read on its own, and the view appears only when a folder is open.
- Live agent status: after **Send to Claude**, the comments pane shows "Claude is working · 2 of 5" with a progress bar, and the thread Claude is on pulses. When it's done you get one summary (resolved, and questions for you) with **Show questions**; a background panel shows it as a notification. The CLI's `next` and `context` mark the thread they hand out, and `reply` and `resolve` clear the mark.
- Comment kinds and severity: mark a thread as a Question (answer, don't edit) or Praise (no action), and as Major, Minor or Nit (Alt+1/2/3 in the comment box). Cards show small tags, severity chips filter the list, and Send to Claude and the CLI's `next` work major first.
- Comment on a whole section (the icon beside a heading) or the whole document (**Comment on document** in the comments pane). The CLI's `context` shows the whole section.
- Selections snap to whole words, so quotes no longer end mid-word.
- Word round-trip: **Export to Word (with comments)** writes a `.docx` next to the file, with each thread as a real Word comment on its quote, its kind, severity and suggested edit noted under it (replies, as Word replies, and resolved threads optional; lost quotes listed at the end). **Import Comments from Word…** turns a reviewer's Word comments, replies, and tracked changes back into draft threads on the same text, with suggested edits for the tracked changes; an exported file comes back with its kinds, severities, suggested edits and resolved threads. Built in, no pandoc needed, and loaded only when first used (a separate 47 KB file; the extension itself grows by about 1 KB). Import refuses ZIP bombs, oversized or encrypted files and XML with a DTD, and ignores entry names that point outside the archive. In Restricted Mode, export reads images only from the document's folder and the workspace and doesn't offer to open the file in another program.
- Word counts and document health: the document footer shows words and reading time, and the outline shows each section's words, its heading and subsections included. Only prose counts: not code blocks, footnotes, the front matter, generated references or text CriticMarkup deletes; inline code does, and a formula or a web address is one word. Counting happens while the view is idle, and after an edit only the changed paragraphs are counted again. `mdreview: { words: { total: 8000, Abstract: 250 } }` in the front matter sets targets, and a section or document over its target turns amber. A new **Document health** panel lists missing linked files and images (including `C:/…` and `C:\…` paths), unknown citation keys, unresolved cross-references, duplicate headings, sections over target, and orphaned open comments; select a passage and press **Re-anchor to selection** to move an orphaned comment there.
- Undo and redo (Ctrl+Z / Ctrl+Y) for edits made in the view, byte-exact and refused if the file changed elsewhere in between (the buttons grey out as soon as that happens).
- Outline pane with the current section tracked and open-thread counts per heading.
- Find in document (Ctrl+F) with all matches highlighted.
- Thread filters by status and author.
- Reopening a resolved thread stamps `reopenedAt`, so agents pick it up again even though their reply was the last one.

### Rendering

- YAML front matter (pandoc, Quarto, Jekyll, Hugo, Obsidian) shows as a title card with the title, subtitle, authors, date and keywords, instead of a horizontal rule and a heading full of YAML. The raw YAML is one click away, and Alt+double-click edits it.
- CriticMarkup renders: {++added++}, {--deleted--}, {~~old~>new~~}, {==highlight==} and {>>note<<}. Deletions used to disappear.
- Pandoc citations: with `bibliography:` in the front matter (a .bib or CSL-JSON file), `[@key, p. 4]`, `[see @a; -@b]` and `@key` render author-date, link to a References list the viewer adds at the end (or under your closing References heading), and show the full entry on hover. Keys missing from the file get a red squiggle and are listed above the references. Without a bibliography, `@name` stays plain text.
- pandoc-crossref: `{#fig:x}` on an image, `{#tbl:x}` on a table caption, `$$…$$ {#eq:x}` and `{#sec:x}` on a heading are numbered, `@fig:x` becomes a link ("fig. 1"), and broken references are flagged. Numbered equations show their number beside the equation.
- GitHub-flavored extras: task lists with checkboxes you can tick (the file changes by one character, and Undo reverts it), GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), `==highlight==`, and syntax colours for code in 19 common languages. Mermaid fences draw as diagrams; Mermaid loads only when a file has one.

### Agent workflow and CLI

- **Send to Claude**: submit drafts and start Claude Code on the open threads, or send a single thread with **Ask Claude**. The prompt is also copied to the clipboard.
- **Send Open Reviews in Folder to Claude** (Explorer right-click on a folder, or the Command Palette): one Claude Code session works through every file with open threads.
- **Add Claude Code Skill to Workspace** (and `mdreview.mjs init-claude`): installs `.claude/skills/md-review/` so Claude Code knows the review loop in that project.
- CLI: `summary`, `next`, and `context`; `list`, `summary`, and `next` accept folders. `next`/`context` locate each quote in the source (through markup and stale line hints) and print those lines. `next` skips threads already answered by the agent.
- `list` now sorts by line, scans the current folder when given no path, and fails on a path that doesn't exist.
- The single-file Send to Claude prompt points the agent at `context` for finding the text.

### Speed

The measurements below were recorded during development of the earlier rendered-block editor. They have not been re-measured for the continuous canvas.

- Opening a document paints once, already in your reading theme, font and zoom, with its comments highlighted: no flash of the default look. The text itself shows up a little later, but the finished page arrives about a third sooner on long documents. The extension package is a quarter smaller (2.2 MB instead of 2.9 MB; the extension code itself 607 KB instead of 1.3 MB) and starts in half the time; KaTeX loads with the first formula.
- Long documents open and repaint several times faster: blocks outside the view skip layout until you scroll to them. Your place in the document is kept by block (not pixel offset) across repaints and reopening, and jumps to a far comment, heading, or find match land on target. Zoom and the comment box keep their place too. (The scrollbar thumb can shift after a repaint, because off-screen blocks go back to estimated heights.)
- Rendering is about 2–4× faster on long documents: formulas are rendered once and reused while you edit, and documents with many footnotes no longer slow down quadratically (a workaround for a markdown-it-footnote bug).
- An edit in the view renders the document once instead of up to four times (the edit, a timer, the file watcher, and VS Code reloading the file each triggered a full render), cutting the extension's work per edit by about 70%.
- Saving an edit made in the view takes a few milliseconds instead of up to two seconds on long documents: a changed paragraph or heading is checked on its own rather than by re-reading the whole file (list items, table cells and quotes still check the whole file, once instead of twice).
- After a change to the file, the view replaces only the paragraphs, lists and tables that changed, instead of rebuilding the whole document: editing a sentence repaints in about 110 ms instead of 340 ms on a medium document and 510 ms instead of 1.3 s on a long one, and adding a paragraph in about 220 ms instead of 370 ms and 730 ms instead of 1.3 s (the footnotes are rebuilt, the rest is kept). Blocks below the change keep their place, drawn diagrams stay drawn, and an open details section stays open.
- Find no longer slows the view down: a repaint after searching a long document took up to 9 seconds and now takes under half a second (matches are static ranges the browser doesn't have to keep updating). Rendering is also about twice as fast: re-rendering a long document after a change takes 40 ms instead of 70 ms (160 ms instead of 280 ms on a very long one), and saving an edit made in the view 50 ms instead of 115 ms (200 ms instead of 390 ms), because the `{.class}` attributes step now runs only when the document has a `{` outside math and code.
- The view keeps up with long reviews: resolving or replying to a thread with 250 comments now takes about 40 ms instead of 180 ms on a medium document (90 ms instead of 350–400 ms on a long one), adding a comment 130 ms instead of 210 ms (200 ms instead of 360 ms), and selecting text or typing in Find about half the time (select 36 ms instead of 67 ms, and 170 ms instead of 380 ms on a long document). Repainting after an edit is also 35–45% faster. Only the thread cards that changed are redrawn, so a reply you're typing in one card stays as it is while others update.
- Adding, replying to or resolving a comment updates only the highlights that changed instead of repainting the document, and quotes are located with one pass over the text.

### Platforms

- Send to Claude works the same on Windows, macOS and Linux: the agent command understands quoted paths and arguments, Claude Code is found in its usual install folders even when VS Code's PATH doesn't have it yet (a real claude.exe is preferred over the npm .cmd shim), and when it can't be found you get the prompt on the clipboard and a button to the setting instead of a dead terminal. New `mdReview.agent.launch: shell` runs it in your own shell, which stays open afterwards. Prompt files live in the extension's storage and are cleaned up after a day.
- MD Review now works in Restricted Mode (untrusted folders): viewing, commenting and editing work; Send to Claude copies the prompt instead of starting Claude Code there, and Add Claude Code Skill waits for trust. A document there can only point its bibliography at files in its own folder or the workspace, and only web and mail links open outside VS Code. Anywhere, a bibliography that is a device, a pipe, a network path on Windows or over 20 MB is skipped instead of freezing the view, and `file:` links open in VS Code rather than the system's default app. It also works in dev containers and CI images whose user has no passwd entry (the author name falls back to USER/USERNAME), and it runs on the remote side of SSH, WSL and container windows.
- Live reload is more reliable: the view now notices files replaced by a save-and-rename (as many editors, Dropbox, OneDrive and agents do), comment files whose name differs only in case on Windows and macOS, and comment files caught half-written (it waits briefly and reads again instead of showing "Could not parse"). On network paths on Windows, including `\\wsl$`, it checks for changes every 2 seconds while the view is showing; turn on the new `mdReview.pollFiles` setting to do the same on other folders that don't report changes. Panels showing files in the same folder share one file watcher.
- Windows paths with a drive letter work: a link to `C:/notes/other.md` or `C:\notes\other.md` opens the file in VS Code, and an image at `C:\figs\a.png` shows up, instead of both being taken for web addresses. In a trusted folder, images outside the document's folder and the workspace (such as `../figures/a.png` next to a file opened on its own) now show too, sent to the view inline (image files up to 8 MB; never from a network share). The serif reading font looks closer to macOS and Windows on Linux, using Source Serif, Noto Serif or Liberation Serif when installed instead of the much wider DejaVu Serif.
- Every pull request is checked on Windows, macOS and Linux (Node 20 and 22), and main is also tested in a real VS Code on all three.

### Interface and keyboard

- Reading view: zoom the document (Ctrl+wheel, Ctrl+= / Ctrl+−, Ctrl+0), the MD Review reading palette by default (plus Paper, Sepia, Dusk, Night), and a Sans/Serif choice, remembered across files.
- Keyboard shortcuts on both Windows/Linux and macOS, with native keys on each (⌘, ⌥, ⇧⌘Z for redo). New: comment on the selection (Ctrl+Alt+M / ⌥⌘M, or `c`), Submit review (Ctrl+Shift+Enter / ⇧⌘↩), Send to Claude (Ctrl+Alt+Enter / ⌥⌘↩), toggle the comments pane (Ctrl+Alt+P / ⌥⌘P). Tooltips show the keys for your platform, and `?` (or **More tools → Keyboard shortcuts**) opens a shortcuts sheet.
- Keyboard navigation between comments (`j`/`k`, Alt+↓/↑) and `r` to reply.
- Keyboard access for the outline (arrows, Enter, Esc) and the reading panel (arrow keys pick a theme or font, Esc returns focus to the toolbar).
- Windows narrower than 680px keep a single column with the outline open, and the floating outline closes after a jump.
- High-contrast themes get a visible border on the active thread, its highlight, and the current outline entry.
- A calmer look: VS Code codicons instead of emoji and text glyphs (visible in high-contrast too), a quieter toolbar, flat comment cards, a 68-character reading column, and short transitions that turn off when reduced motion is on.

### Fixes

- The viewer no longer drops sidecar fields it doesn't know. Fields an agent, the CLI, or a newer version adds to the file, a comment, its anchor, or a reply now survive every write.
- The last item of a list followed by a blank line can be edited in the view again (it used to fail with "The file changed on disk").
- Esc inside an editor or comment box no longer also closes the find bar.

## 0.1.0 — 2026-09-25

First public release.

- Rendered Markdown view with pipe tables, footnotes, sub/superscript, KaTeX math, and pandoc image widths.
- Select-and-comment with drafts, **Submit review**, replies, resolve/reopen, and orphan detection when quoted text disappears.
- Comments stored in a sidecar `<file>.md.comments.json` with a documented schema, an agent protocol, and a zero-dependency CLI (`cli/mdreview.mjs`).
- Live reload when an agent edits the Markdown or the sidecar.
- Seamless editing in the rendered view that writes only the changed bytes, verified by re-rendering; raw-source fallback for blocks that can't be mapped safely.
- Collapsible comments pane.
- Browser mode (`npm run harness`) that runs the same viewer without VS Code.
