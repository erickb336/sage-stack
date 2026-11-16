# The design format

Every design page that an agent makes for the owner has this form: a designer's page, an arena candidate's page and the arena judge's final page. The owner reviews results and experiences, not code. The owner reads a design in one scroll and judges it, so a page with tabs, hidden panels or check output fails. This is the same text in Claude and in Codex.

## The page

- One HTML file, self-contained, with no network and no script.
- One column. Scroll only: every part reads with no click, no tab, no switch and no hidden panel.
- About 1,200 words of text or fewer. Pictures do the work: a diagram first, then a table, then text.
- A short label (1 or 2 words) above each full sentence.
- 80% Simplified Technical English and the project's dictionary words.
- No raw ids in the text. Task and run ids go only in a small "Ref" line at the end.
- Mark every number: "real" (measured, with its source in the rationale) or "sample" (invented to show a screen).
- Check it at 1440 px and 390 px wide: nothing overflows, and every picture reads.

## The ten parts, in this order

The page's `<h1>` is part 1. Each other part starts with an `<h2>` heading that starts with the part's name, after an optional number: for example `<h2>4 How it works</h2>`.

1. **Title**, and one sentence: what changes for the owner.
2. **The problem**: the real story as a picture (a timeline, a chart). Only real, checked numbers.
3. **After**: the same story with the design in place, as a second picture. Mark where the design steps in. Label it sample.
4. **How it works**: one diagram, at most 6 boxes, with one plain sentence under each box. No code. Name the prior art in one line under it.
5. **What you will see**: realistic mockups in the product's real style.
   - A design with screens: the screens, each with its states side by side (normal, asking, empty, failure, success).
   - A process design: only the surfaces the owner meets (for example a board page, a "Needs you" row, a chat message), each with its states side by side.
   - Never put a state behind a button. Label all data sample.
6. **What the agents do**: one short plain line per role or step. No command output and no file names.
7. **Rules**: a plain list of the rules and the edge cases.
8. **Your choices**: each open question with its options side by side. The recommendation is first and marked. Each option says what happens next and its cost in plain words, and the question says the default.
9. **Cost and plan**: the pull requests as a simple picture with their order. The total cost with its basis and range: agent time with tokens, and human time apart.
10. **Under the hood**: for engineers only. One short paragraph and links to the rationale and the engineering check. Nothing technical goes above this part.

## Diagrams

Each design has the diagrams that fit it, before the text that explains them:

- **A state chart** when a thing moves between states, such as a task, a question or a page.
- **An architecture diagram** for the parts and the links between them.
- **A flow chart** for the steps and the decisions, with a label on each branch.

Draw each one in the picture rules of the presentation skill: a title and a key, at most 6 boxes at one zoom, and one-way arrows that each have a label. Each diagram reads with no click, no hover and no switch. Mark it for readers and for the check in one of these forms:

- an `<svg>` with shapes in it, with any role or none;
- an `<img>` with alt text;
- a `<figure>` with content;
- an element with `role="img"` and a name for the picture;
- a `<div>` with no role, a name for the picture, and the boxes of the picture in it as `<div>` elements.

A name is an `aria-label`, or an `aria-labelledby` whose ids point to elements with text, as ARIA reads it. A name on another element does not make a diagram: for example a `<section>`, a `<nav>`, a heading, a paragraph or a `<pre>`. A `<div>` that holds only text (paragraphs, spans, headings or lists) is not a diagram. An element with no close tag, such as a self-closed `<svg/>`, has nothing in it.

## The check

Run the design check on the page before you report, and fix each problem that it names:

```
node <the sage plugin's folder>/core/design-page.mjs <page.html>
```

It reads only the HTML, so it works for a design of any project and any language. It fails when:

- a part is missing or out of order (it names the part);
- the page has no diagram in one of the forms above;
- the page has a script, in any part: a `<script>`, an HTML or SVG event handler attribute such as `onclick` or `onload`, or a `javascript:` URL;
- a switch is above "Under the hood": a `<button>`, `<input>` (not `type="hidden"`), `<select>` or `<textarea>`, a `<label for>`, an element with `role="button"`, `"switch"`, `"radio"` or `"checkbox"` (each word of `role` counts), or an element with `aria-pressed`, `aria-expanded`, `aria-controls` or `aria-selected`;
- a tab, a `<details>` block, a `<template>`, a `<dialog>` with no `open`, a `hidden` element, or an inline `style` with `display: none` or `visibility: hidden` is above "Under the hood";
- `<pre>`, `<code>` or `<samp>` is above "Under the hood" (a text picture with `role="img"` and a name is a diagram, not code; a name alone does not make it one);
- "After" or "What you will see" does not say "sample" (or "samples").

The check does not read style rules, because they also hide decoration (for example an arrow on a small screen). So a style rule that hides a part, or that shows it on hover or on a link to its anchor (`:hover`, `:target`), passes the check, and so does `aria-hidden`. You and the owner catch these, and you judge the words, the pictures and the 1440 px and 390 px widths.

## Files beside the page

- `shots/`: a full-page screenshot at 1440 px and at 390 px.
- The rationale and the engineering check stay in their own files; part 10 links to them.
