# M3 browser exercise — committed evidence views (2026-10-11)

Offline exercise of the committed run-comparison evidence, loaded over
file:// (no network in the tool path). Machine readings live in
`m3-browser-record.json`; the raw screenshots are committed alongside.

## Environment

- Playwright headless Chromium (chromium-headless-shell v1243, Chrome 153.0.8010.12) in the sandbox.
- Views loaded from the committed evidence directories themselves, not rebuilt copies.

## Checked (measured in the browser, not asserted from source)

- Canonical view `evidence/view-01-run-a-vs-02-run-b.html` loads offline;
  document title "Run comparison — offline workbench". Desktop screenshot at
  1440x900: `m3-view-desktop-1440x900.png`.
- Narrow viewport 390x844 (canonical): the page renders with measured
  horizontal overflow (documentElement scrollWidth 877 vs clientWidth 390) —
  the fixed-width condition/metric tables exceed the viewport and the page
  pans horizontally. Recorded as measured behavior of this print-oriented
  evidence document, not changed in M3. Screenshot: `m3-view-narrow-390x844.png`.
- Keyboard access: zero focusable elements (`a, button, input, select,
  textarea, [tabindex]` -> 0). A 6-step Tab walk stays on BODY with computed
  outline-style "none": the view is intentionally inert — a static evidence
  artifact, not an interactive UI. This matches the inherited tc-5
  keyboard-walk reading and is now re-measured directly.
- Reduced motion: under prefers-reduced-motion: reduce emulation,
  `document.getAnimations()` = 0; the view CSS declares no
  prefers-reduced-motion rule (nothing animates regardless).
- Stress view `evidence-stress/view-s10-accepted-test-command-vs-
  s11-accepted-weight-receipts.html` (the comparable=False pair from the M3
  stress corpus) loads and renders at 390x844 with the same measured
  horizontal panning (scrollWidth 888 vs 390). Screenshot:
  `m3-stress-view-narrow-390x844.png`.

## Deferred (recorded, not substituted with source assertions)

- axe-core rule sweep: the repository has no vendored axe build and the
  offline rule forbids fetching one; the keyboard and reduced-motion
  measurements above are direct browser observations instead. The inherited
  records mention an axe run from the original writer's environment; nothing
  here re-verifies or supersedes that claim.
- Touch-input and screen-reader passes (headless Chromium covers neither).

## Inherited-files observation (measurement only)

- The inherited `tc-4-desktop-reduced-motion.png` and `tc-5-desktop-1440.png` are byte-identical (sha256 2eaa733ab6d5f060333ce52434c15322bcc57dcf1fadaf90965d25e5242cc08b, 302831 bytes): two recorded checks share one screenshot. Their records are left untouched; the m3-* files above are this exercise's own captures.
