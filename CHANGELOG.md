# Changelog

## 0.1.0 — 2026-09-25

First public release.

- Rendered Markdown view with pipe tables, footnotes, sub/superscript, KaTeX math, and pandoc image widths.
- Select-and-comment with drafts, **Submit review**, replies, resolve/reopen, and orphan detection when quoted text disappears.
- Comments stored in a sidecar `<file>.md.comments.json` with a documented schema, an agent protocol, and a zero-dependency CLI (`cli/mdreview.mjs`).
- Live reload when an agent edits the Markdown or the sidecar.
- Seamless editing in the rendered view that writes only the changed bytes, verified by re-rendering; raw-source fallback for blocks that can't be mapped safely.
- Collapsible comments pane.
- Browser mode (`npm run harness`) that runs the same viewer without VS Code.
