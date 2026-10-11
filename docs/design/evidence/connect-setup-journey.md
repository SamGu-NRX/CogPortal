# Connect -> setup journey evidence

Recorded 2026-10-11 at commit `a8aa493` (fix(portal): tick setup progress when a
device approval lands). Two sources:

- A six-path Playwright walk of the built portal against a local fixture server
  (no real GitHub or Modal calls). The driver, fixture server and raw state
  sequences live outside the repository in scratch; the state log and the key
  screenshots are committed here as receipts.
- axe-core scans (chromium, 1440x900) of the connect choice screen, the setup
  rail, and the connections device list.

## What the walk observed

1. **First run, create + approve.** Choice screen -> start step -> repository
   chosen (name suggestion "Face Finder") -> created, landing on `/setup` with
   the "You've created Face Finder" arrival note -> device approved from the
   deep link -> back on Setup, the rail reads **"1 of 5 done, seen by the
   portal"** with the link step marked "Seen by the portal". On this branch the
   tick is on return from approval: `useApproveDevice` invalidates the
   connections query in its `onSuccess`, so Setup does not wait for the
   empty-list poll (staleTime 30s, poll window lapses).
2. **Choice / join navigation.** Back from the join step returns to the choice
   screen; `?path=start` lands directly on the start step.
3. **Join a cohort team.** Joining Search Squad lands on Setup with the joined
   note and commands naming `cogworks-demo/search-engine`.
4. **Refused device code.** The recovery panel renders with a fresh
   `cogworks link --portal` command (the deliberate 410 is the only HTTP error
   in the whole walk).
5. **Changed team.** Commands switch to the new team's repository.
6. **Existing run.** Completed setup revisited at "5 of 5 done", keeping checked
   (self-checked) and portal-verified evidence distinct.

## Accessibility

Zero axe violations on all three screens (41 rule passes each). Two
`incomplete` categories, neither a failure:

- `color-contrast` x 19 per screen: elements over the page's background
  gradient; axe cannot compute contrast there. Visual confirmation of the
  ink-on-gradient pairings is still owed.
- `aria-valid-attr-value` x 1: the account menu button's
  `aria-controls="user-menu"` cannot be resolved while the menu is closed.
  Verified by hand: opening sets `aria-expanded="true"` and `#user-menu`
  exists with `role="menu"` (Continue setup / Connections / Sign out).

## Machine reports

- `connect-setup-journey-walk-report.json`: per-path state sequences (URL,
  headings, live-region count, focused element, alerts) and console errors.
- `connect-setup-journey-axe-report.json`: full axe results per screen.

Also at this commit: full portal suite 1256/1256 passing (`pnpm test` in
`apps/portal` with `TSX_TSCONFIG_PATH=tsconfig.app.json`), `pnpm check` green.
