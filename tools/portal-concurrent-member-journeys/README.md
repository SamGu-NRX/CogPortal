# CogPortal concurrent-member and result journeys

Playwright journeys for the local CogPortal portal (Vite + Workers + D1), covering the
real-user readiness plan's adversarial areas A5 (concurrent team membership) and A8
(clock-skewed run results), plus the narrow-screen removal-and-rejoin recovery path.
Everything is driven through the real app: the dev sign-in form, the cohort join form,
the team chooser, the roster's arm-then-confirm remove, and the rename control. The
local database is touched only to set up the world the journeys read — never in place
of driving the app.

## Layout

```
stack/boot.sh                 local stack command: fresh D1, migrations + local seed, vite on :5199
playwright.config.ts          serial config pointed at http://localhost:5199
tests/helpers.ts              sign-in, cohort join, team chooser, roster reads, wrangler d1 helper, fixture reset
tests/concurrency.spec.ts     A5: six concurrent-membership journeys
tests/mobile-leave-recovery.spec.ts  320 px removal → chooser recovery → rejoin → no overflow
tests/results-clock-skew.spec.ts     A8: a finished run with future timestamps, and the signed-out board
```

## Run it

```sh
cd apps/portal
SUITE=../../tools/portal-concurrent-member-journeys bash "$SUITE/stack/boot.sh" &
cd ../../tools/portal-concurrent-member-journeys
npx playwright test
```

## How the world is set up

- `stack/boot.sh` mirrors alpha's `pnpm dev` predev: fresh D1, all migrations, then
  `scripts/seed-local.sql` — the seed restores the local join code (`VISION26`) and the
  fixture teams. The dev sign-in (`POST /api/dev/login`, `demo: true`) then provisions
  users into the active cohort and onto the fixture-repository demo team, created on
  first use with a generated id, so the journeys target it by name (`Demo Team`) and
  read its id through the cohort-teams API when a stable handle is needed.
- The chooser opens collapsed behind "Join a team someone already started"; its cards
  name their buttons `Join <team>`. The roster's arm-then-confirm remove confirms with
  "Confirm, they leave (@login)", and the rename control saves with "Save name".
- Demo memberships carry the `write` role (the local fixture has no GitHub to ask), so
  journeys that need an admin promote their actor in local D1 before any browser work.
- The mid-flight rename journey captures the team id before renaming, because a name
  lookup cannot survive a rename.
- Local D1 survives between suite runs while the journeys rename teams and create
  members, so each describe resets the mutable fixture parts (team name, synthetic
  people, their memberships, the skewed run) before provisioning anything.

## Findings

1. **On main, a losing concurrent join answered 500 instead of 409.** Two joins from
   one person at the same instant usually produced one success and one refusal — but on
   main's truly-concurrent interleaving the refusal was a 500 (an unhandled
   UNIQUE-constraint error) rather than a 409 (documented with repro in
   [PR #122](https://github.com/SamGu-NRX/CogPortal/pull/122)). On alpha the contract
   holds: the strict 409 test runs active here and passed six consecutive runs, so the
   port carries it as the regression guard for that fix.
2. **The remove control targets members by `github_login`, which dev sign-ins clear.**
   Dev-provisioned users have no `github_login`, and the roster falls back to showing
   their email prefix — so the arm-then-confirm remove answers 404 for them while the
   UI still names them. Real members always carry a GitHub login; the recovery journey
   gives its removed member theirs after sign-ins to walk the real path.
