# Bear-inspired MD Review design QA

Final result: passed.

## Target and scope

The approved reference is Bear's official desktop screenshot, downloaded from https://bear.app/images/home/hero_mac.jpg and inspected at `/tmp/md-review-design-references/bear.jpg`. This is a visual adaptation for MD Review's existing document-and-review workflow: the charcoal rail is an outline, the central area remains a continuous Markdown editor, and the right pane holds review threads. Bear's note list, photographs, proprietary font, and native window frame are not requirements for this adaptation.

The implementation was inspected in Chrome through its browser extension at http://127.0.0.1:4429/ using a fictional manuscript and synthetic review threads. The final desktop screenshot is `/tmp/md-review-bear-qa/desktop.png`. The reference and implementation images were presented together in the same visual comparison call. Their content and outer framing differ deliberately; comparison focused on typography, palette, spacing, and control hierarchy rather than pixel identity.

## Findings and corrections

- P2, typography: CodeMirror's invisible caret-buffer images inherited document image margins, causing excess spacing around hidden Markdown markers and formatted text. Their margins, borders, and padding now reset to zero. Browser readback confirmed zero margins and the final screenshot shows consistent text flow.
- P2, compact layout: the editor's flex content retained a rendered table's intrinsic width, clipping prose at a 391 CSS-pixel viewport. The editor content now shrinks, its containing editor does not inherit block-level content containment, and rich blocks scroll internally when needed. Browser readback confirmed equal content and scroller widths of approximately 329 pixels, with no document-level horizontal overflow.
- P2, keyboard focus: closing Document health or keyboard help after launching it from the new menu could return focus to a hidden menu item. Both return to the More tools disclosure when it is closed. Verified Escape returns focus to More tools.
- P3, outline: narrow navigation labels were truncated too aggressively. Labels now wrap to two lines, keeping the section names readable.

## Fidelity surfaces

- Fonts and typography: Avenir Next with native system fallbacks approximates the reference's geometric reading typography. The body is 16px with 1.7 line spacing, headings have a restrained scale, and comment text is distinct from secondary metadata. Bear's proprietary font is not bundled.
- Spacing and layout: the desktop outline, continuous canvas, and review margin have distinct proportions and consistent padding. The toolbar exposes the primary navigation and reading controls; secondary tools remain available in a native disclosure. On compact screens the outline becomes a drawer and the review pane stacks below the document.
- Colors and tokens: the navigation rail uses charcoal `#2f3235`, the main surface white, the review surface `#fafafa`, text `#3e4143`, and the primary accent `#b64f59`. Status colors retain semantic meaning. The palette includes a dark VS Code variant and forced-colors rules; those host-specific states were not visually exercised in this browser pass.
- Assets and icons: the existing Codicons family remains in use. The added ellipsis is the original Microsoft Codicons asset at `media/ellipsis.svg`. No Bear logo, proprietary artwork, or imitation illustration was added.
- Copy and content: the preview uses an explicitly fictional manuscript and synthetic comments. The product labels identify writing, review, and document tools. Documentation now describes the relocated tools and word count.

## Verification

- Confirmed the correct page, populated document, absence of error overlays, and no reported browser console warnings or errors.
- Desktop verification at the normal browser viewport of 1091 × 731 CSS pixels; no horizontal overflow. A wider viewport was also checked by DOM geometry, but its cropped browser capture was not used as final visual evidence.
- Compact verification at 391 CSS pixels; corrected wrapping and no document-level horizontal overflow. Screenshot capture was affected by browser viewport scaling; DOM dimensions supplied the precise width evidence.
- Exercised More tools, Document health, Escape focus return, review filtering, reply-composer opening, and outline navigation.
- Typed into the continuous editor, waited for Saved, invoked Undo from More tools, and confirmed the test text was removed and the document saved again.
- TypeScript checking and build passed. Existing automated suite: 293 passed, zero failed, one optional LibreOffice test skipped. `git diff --check` passed.

## Remaining scope

The installed VS Code extension was not replaced. Native VS Code dark/high-contrast rendering and exhaustive screen-reader behavior remain outside this browser verification. The local source, compiled preview, and documentation contain the redesign.

## Follow-up: tables and search

User screenshots identified two missed states in the initial visual pass: split table header/body sizing and unthemed CodeMirror search controls. Both are corrected. Tables use native table layout with normal whitespace; header and body widths matched exactly at both desktop (approximately 340/289px) and compact (approximately 176/152px) sizes. The search panel now uses the application font, palette, field borders, focus states, and buttons. At a 391px viewport its search field remained approximately 303px wide with no horizontal page overflow. Consecutive Next actions selected different matching lines. TypeScript, build, and diff checks passed; no browser console warnings or errors were reported. Updated evidence: `/tmp/md-review-bear-qa/table-fixed.png` and `/tmp/md-review-bear-qa/search-fixed.png`.
