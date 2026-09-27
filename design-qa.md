# MD Review verification notes

## Scope

The current interface adapts the approved Bear-inspired visual direction to MD Review's continuous Markdown canvas, outline, and review threads. The approved selection action is a small white icon button with a muted red icon and a compact tooltip. It is integrated into the application rather than remaining only in the local mockup.

The reference was [Bear's official desktop screenshot](https://bear.app/images/home/hero_mac.jpg). Public examples of the implementation are [the workspace](docs/screenshot.png) and [a contextual comment popup](docs/comment-popup.png). The screenshots use a fictional manuscript and synthetic reviewer comments. The outline and review pane intentionally serve different purposes from Bear's note-library panels.

## Automated verification

- `npm run typecheck`: passed.
- `npm test`: 293 passed, zero failed; one optional LibreOffice conversion test skipped because LibreOffice was unavailable.
- `VSCODE_VERSION=1.100.0 npm run test:smoke`: passed in an isolated macOS ARM64 VS Code test host. This checks extension activation, editor opening, registered commands, sidecar writes, checked editing, undo, and command routing; it is not an exhaustive visual test of the VS Code webview.
- `npm run package`: passed. The package includes the new selection-action icon and its license; temporary mockups are excluded.
- `git diff --check`: passed.

## Browser interaction verification

- Continuous writing: live headings and inline formatting, Enter/list continuation, returning from a list to prose, multiline paste, undo/redo, and autosave.
- File protection: queued edits survived a delayed save. Conflicting external changes retained the local draft and exposed recovery controls. External synchronization cleared stale writing undo history.
- Review: exact selected quotes survived opening the composer and were read back from saved sidecars. Replies, resolve/reopen, filters, outline navigation, and re-anchoring were exercised.
- Contextual threads: a highlight click opened a compact popup with the review pane closed. The writing caret remained at the same character offset. Opening the pane preserved the active passage's vertical position in a reflow test. Sidebar quote navigation highlighted and scrolled to the correct passage.
- Hover: ordinary hovering remained silent; Command-hover showed the preview, and releasing Command dismissed it. Option+Return opened a comment at the writing cursor. Dragging across a highlight still selected text.
- Selection action: the 34px icon button had no surrounding card. Its tooltip appeared on focus, Escape dismissed the action, and the existing comment composer saved the exact selected quotation.
- Search and tables: Find/Replace used the application styles and moved between matches. Table header and body widths matched at desktop and compact widths, without blank whitespace gaps.
- Browser console: no reported application warnings or errors during the final interaction checks.

## Visual corrections

The review caught and corrected several problems: invisible editor caret markers inheriting image margins; wide rendered tables stretching the editor's flex content; table row groups sizing independently under block display; default search-field styling; and keyboard focus returning to hidden tools after their dialogs closed.

Typography uses Avenir Next with native system fallbacks. Bear's proprietary font and artwork are not bundled. Existing interface icons use Codicons, and the selection action uses the MIT-licensed Tabler icon included in `media/`. The design uses a charcoal outline, a white canvas, muted red accents, and a quieter review surface.

Compact layout checks included a 391px CSS viewport. Prose wrapped to the available width, the search controls reflowed, and document-level horizontal overflow was absent. Desktop verification used normal browser windows, including a 1091 × 731 CSS viewport.

## Remaining limits

Native VS Code dark/high-contrast visual states, touch interaction, and exhaustive screen-reader behavior have not received the same manual coverage as Chrome desktop. The smoke test runs in an isolated extension host and does not replace the user's installed extension. Historical performance figures in the changelog have not been re-measured for the continuous editor.

Local design experiments live in the ignored `.temp/` directory and are not part of the repository or extension package.
