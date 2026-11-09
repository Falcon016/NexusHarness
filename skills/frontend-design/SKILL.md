---
name: frontend-design
description: Design and build web UI that looks deliberate rather than generic, with a clear visual direction, real typography, a considered palette and solid basics (responsive, accessible, both themes). Use when asked to build or restyle a page, component, landing page or dashboard, or to make a UI "look better".
---

A UI looks generated when every choice is the default one. Make a few deliberate choices that fit what the thing
is for, keep everything else quiet, and get the basics right.

## 1. Know what it is for

Before any code, write down in two or three lines: what this is, who uses it, and the one thing they must be
able to do on it. If the user gave no direction, propose one in those terms and go with it. Reuse the project's
existing design system, tokens and components when there are any: consistency beats novelty inside an app.

## 2. Plan a small token set

- **Colour:** 4–6 named values (background, surface, text, muted text, one accent, one status colour), each
  checked for contrast (text at least 4.5:1). Pick the accent from the subject, not from habit.
- **Type:** one or two families with distinct jobs, and a clear scale (for example 14/16/20/28/40). Set line
  height (about 1.5 for body) and keep lines under about 80 characters.
- **Space:** one spacing scale (4 or 8 based) used everywhere.
- **Shape:** corner radius and borders that vary with hierarchy, not one radius on everything.

Put them in CSS variables (or the project's theme file) and use only those.

## 3. Avoid the generic tells

- Identical rounded cards with the same grey shadow for every piece of content.
- An all-caps label above every heading; one word of a headline in a different colour.
- Numbered markers (01, 02, 03) on things that are not a sequence.
- Gradients and glows as decoration, and a fade-in on every section.
- Placeholder copy ("Lorem ipsum", "Unlock the power of…"). Write real, specific text: say what something does,
  in the user's words. Buttons say exactly what happens ("Save changes", not "Submit").

Spend boldness in one place (a striking headline treatment, an unusual layout, one strong colour) and keep the
rest restrained.

## 4. Build it properly

- Semantic HTML (`button`, `nav`, `main`, labels tied to inputs), so it works with a keyboard and screen readers.
- Visible focus styles; nothing that only works on hover.
- Responsive from about 360 px wide up; no horizontal scrolling on a phone.
- Light and dark themes via `prefers-color-scheme` when the project supports themes.
- Respect `prefers-reduced-motion`.
- Empty, loading and error states, written to tell the user what to do next.

## 5. Look at it

Check the result in the browser (see the `webapp-testing` skill): at phone and desktop widths, in both themes,
with the keyboard. Fix what looks off before you report. If you can take screenshots and see them, compare
against your plan from step 2.

## Report

The direction you chose and why, in two or three sentences; what you built; and what you checked.
