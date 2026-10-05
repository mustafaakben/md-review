# Roadmap

Status of every item identified on 2026-10-05. Checked against the current repo state.

## Open

### Security

- [ ] **#36 — npm audit: high-severity findings via Mermaid's dependencies.** Currently on mermaid 12.0.0 → chevrotain 11.1.2 → lodash-es 4.17.23 (2 high: code injection via `_.template`, prototype pollution via `_.unset`/`_.omit`). Also: @vscode/vsce ^3.6.0 → secretlint → globby → fast-glob → micromatch → braces (1 high: stack-exhaustion DoS). **Fix:** upgrade mermaid to 12.1.0 (chevrotain 13.2.0 drops lodash-es entirely) and @vscode/vsce to ^4.0.0 (drops the braces chain). Total: 11 high → 0.

### Known limits (README line 340)

- [ ] **Word export is basic.** Math exports as TeX source, Mermaid diagrams as their code, web images as `[alt text]`, bibliography is unstyled, Word comments on equations land on the whole equation. Real equations (MathML or images), rendered diagrams, and a styled bibliography would make this a proper manuscript export.
- [ ] **Undo is lost on reload.** Reloading the view starts a fresh undo history. Draft recovery is separate and works, but the undo chain doesn't survive.
- [ ] **Agent quoting fragility.** The CLI's `fix` and `apply` take old/new text as shell arguments. Quotes, `$`, and backticks can make an edit fail (safely — nothing is written). Passing the text through stdin or a temp file would fix it. Code comment at `src/agentRun.ts:134` documents this.
- [ ] **Claude Code delivery format undocumented.** The session-inbox message format isn't documented by Anthropic. A future Claude Code update could break it. A health check or version sniff that warns when the format changes would help.
- [ ] **Codex limits.** Sessions started with `--no-daemon`, `--profile`, or most `-c` overrides can't be reached. Replies always show as "Claude" whichever agent answered.

### Testing gaps

- [ ] **Dark mode, high-contrast, screen readers, touch.** design-qa.md line 38: "Native VS Code dark/high-contrast visual states, touch interaction, and exhaustive screen-reader behavior have not received the same manual coverage as Chrome desktop."
- [ ] **Performance figures stale.** design-qa.md line 38: "Historical performance figures in the changelog have not been re-measured for the continuous editor."
- [ ] **Windows test failures.** Two symlink tests need Developer Mode enabled. One redlines test (`state holds details only`) fails because a long Windows path makes a write exceed 400 bytes. Neither affects the extension, but they prevent a fully green run on Windows.

### Dropbox and tests

- [ ] **test/tmp lives inside Dropbox.** Several test files (`features.test.mjs`, `redlines.test.mjs`, `review.test.mjs`) write scratch data to `test/tmp/` inside the repo, which is inside Dropbox. Dropbox file locks and synced `.lock` files from other machines cause random EPERM failures. Fix: use `os.tmpdir()` like the agent tests already do.

### Release

- [ ] **Cut 0.3.0.** Two features sit under "Unreleased" in the changelog: writing themes (5 new themes) and the 14-font picker. Ready to tag.

### Writing productivity ideas

- [ ] **Focus mode.** Dim everything except the current paragraph or sentence, like iA Writer.
- [ ] **Typewriter scrolling.** Keep the line being typed in the vertical center of the screen.
- [ ] **Writing goals.** A daily or per-session word target with a small progress ring and a history of words written. (Word counts per section against front-matter targets already exist in the Document Health panel.)
- [ ] **"Studio" theme.** A Bear-style theme with colors sampled from Bear's official screenshot, paired with Albert Sans.
- [ ] **Custom themes.** Let the user pick page, text, and accent colors in the Aa panel, saved like the built-in ones.
- [ ] **Font size control.** Separate from zoom, so text size changes without scaling everything else.

## Closed

_None yet. Items move here as they're completed, with the date and commit._
