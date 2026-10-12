# Rework browser exercise — committed evidence views (2026-10-12)

Offline exercise of the committed run-comparison evidence at the rework head,
loaded over file:// (no network in the tool path). Machine readings live in
`rework-browser-record.json`; the raw screenshots are committed alongside.
`before` is the pre-rework generator at 92a5f0e1 rendering the same canonical
fixture pair, for the before/after comparison in the PR.

## Environment

- Playwright headless Chromium (chromium-headless-shell) in the sandbox.
- axe-core from an npm package install (build-time only; the sweep runs offline over file://).

## canonical view

- 390px fit: documentElement scrollWidth 390 vs clientWidth 390 — no horizontal overflow.

- axe-core after content load: 0 violation(s), 23 passes, 0 incomplete.

- Layout shift entries: []. Reduced motion: 0 animations. Focusable elements: 0 (intentionally inert — a static evidence artifact, not an interactive UI; nothing to keyboard-operate).

- Semantics: lang='en'; headings H1+H2+H2+H2+H2+H2+H3+H3+H2+H2+H2+H3; landmarks main,footer; th scope=row x16, scope=col x14; verdict chips carry text (changed; unknown; same) so they do not rely on color alone.

## stress view

- 390px fit: documentElement scrollWidth 390 vs clientWidth 390 — no horizontal overflow.

- axe-core after content load: 0 violation(s), 23 passes, 0 incomplete.

- Layout shift entries: []. Reduced motion: 0 animations. Focusable elements: 0 (intentionally inert — a static evidence artifact, not an interactive UI; nothing to keyboard-operate).

- Semantics: lang='en'; headings H1+H2+H2+H2+H2+H2+H3+H3+H2+H2+H2+H3; landmarks main,footer; th scope=row x16, scope=col x14; verdict chips carry text (changed; unknown; same) so they do not rely on color alone.

## before view

- 390px fit (pre-rework generator): scrollWidth 877 vs clientWidth 390 — measured for the before/after comparison.

- axe-core after content load: 0 violation(s), 23 passes, 1 incomplete.

- Layout shift entries: []. Reduced motion: 0 animations. Focusable elements: 0 (intentionally inert — a static evidence artifact, not an interactive UI; nothing to keyboard-operate).

- Semantics: lang='en'; headings H1+H2+H2+H2+H2+H2+H3+H3+H2+H2+H2+H3; landmarks main,footer; th scope=row x13, scope=col x14; verdict chips carry text (changed; same) so they do not rely on color alone.

## Deferred (recorded, not substituted with source assertions)

- Touch-input and screen-reader passes (headless Chromium covers neither).
