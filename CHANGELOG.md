# Changelog

## Unreleased

- The viewer no longer drops sidecar fields it doesn't know. Fields an agent, the CLI, or a newer version adds to the file, a comment, its anchor, or a reply now survive every write.
- Keyboard shortcuts on both Windows/Linux and macOS, with native keys on each (⌘, ⌥, ⇧⌘Z for redo). New: comment on the selection (Ctrl+Alt+M / ⌥⌘M, or `c`), Submit review (Ctrl+Shift+Enter / ⇧⌘↩), Send to Claude (Ctrl+Alt+Enter / ⌥⌘↩), toggle the comments pane (Ctrl+Alt+P / ⌥⌘P), and `e` for edit mode. Tooltips show the keys for your platform, and `?` (or the keyboard icon) opens a shortcuts sheet.
- **Send Open Reviews in Folder to Claude** (Explorer right-click on a folder, or the Command Palette): one Claude Code session works through every file with open threads.
- **Add Claude Code Skill to Workspace** (and `mdreview.mjs init-claude`): installs `.claude/skills/md-review/` so Claude Code knows the review loop in that project.
- CLI: `summary`, `next`, and `context`; `list`, `summary`, and `next` accept folders. `next`/`context` locate each quote in the source (through markup and stale line hints) and print those lines. `next` skips threads already answered by the agent.
- Reopening a resolved thread stamps `reopenedAt`, so agents pick it up again even though their reply was the last one.
- `list` now sorts by line, scans the current folder when given no path, and fails on a path that doesn't exist.
- The single-file Send to Claude prompt points the agent at `context` for finding the text.
- Undo and redo (Ctrl+Z / Ctrl+Y) for edits made in the view, byte-exact and refused if the file changed elsewhere in between (the buttons grey out as soon as that happens).
- Outline pane with the current section tracked and open-thread counts per heading.
- Find in document (Ctrl+F) with all matches highlighted.
- Keyboard navigation between comments (`j`/`k`, Alt+↓/↑) and `r` to reply.
- Thread filters by status and author.
- Reading view: zoom the document (Ctrl+wheel, Ctrl+= / Ctrl+−, Ctrl+0), a theme for the reading column that follows VS Code by default (plus Paper, Sepia, Dusk, Night), and a Sans/Serif choice, remembered across files.
- **Send to Claude**: submit drafts and start Claude Code on the open threads, or send a single thread with **Ask Claude**. The prompt is also copied to the clipboard.
- Keyboard access for the outline (arrows, Enter, Esc) and the reading panel (arrow keys pick a theme or font, Esc returns focus to the toolbar).
- Esc inside an editor or comment box no longer also closes the find bar.
- Windows narrower than 620px keep a single column with the outline open, and the floating outline closes after a jump.
- High-contrast themes get a visible border on the active thread, its highlight, and the current outline entry.

## 0.1.0 — 2026-09-25

First public release.

- Rendered Markdown view with pipe tables, footnotes, sub/superscript, KaTeX math, and pandoc image widths.
- Select-and-comment with drafts, **Submit review**, replies, resolve/reopen, and orphan detection when quoted text disappears.
- Comments stored in a sidecar `<file>.md.comments.json` with a documented schema, an agent protocol, and a zero-dependency CLI (`cli/mdreview.mjs`).
- Live reload when an agent edits the Markdown or the sidecar.
- Seamless editing in the rendered view that writes only the changed bytes, verified by re-rendering; raw-source fallback for blocks that can't be mapped safely.
- Collapsible comments pane.
- Browser mode (`npm run harness`) that runs the same viewer without VS Code.
