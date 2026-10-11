# CogPortal: real-user readiness plan

Owner: the CogPortal lead (focus/gushi fleet), 2026-10-11. Task prompts quote this file by section.

## Goal

Every surface a student, TA, instructor or visitor touches works for a real user on the real stack: the built
portal SPA, the portal Worker with D1, the `cogworks` CLI on the course's own data, the Discord Activity and
CogBot. "Works" means the user can finish the job, sees a truthful state when something goes wrong, keeps their
data, and can recover without help.

"Real users, not synthetic data" means real paths: real setup as the course documents it, the course's own data,
the CLI on Python 3.8 in the course's conda environments, phones, keyboards and assistive-technology semantics, and
the failure modes students actually hit. It does not mean real students' data. BWSI students may be minors, so no
real student handle or submission (for example under `benchmarks/adapters/`) appears in a test, fixture or commit.
Where a real path needs an account or credential the agents don't have, the task names it under "What Sam must
provide" instead of faking it and calling it real.

Proof comes from one adversarial end-to-end suite that drives the real stack. A test that answers the app's own
API requests from a fixture (for example `tools/portal-journey-e2e/fixture-server.mjs`) does not count.

## The harness (the eval)

The suite is the scoring harness for every round. It lives in two owned directories:

- `tools/portal-real-journeys/`: Playwright (`@playwright/test`) against the Worker run through the repo's own
  wrangler/Vite dev path, a fresh local D1 per journey with all migrations, and the production SPA build.
- `tools/cli-real-journeys/`: the CLI installed the way the course docs say, run on the bundled public week
  data, linked and synced against the same local Worker; CogBot driven with signed interactions.

What may be replaced by a double: GitHub OAuth and REST, Discord's API, and the Modal runner. Each double is an
HTTP server that speaks the provider's protocol and is named as a double in every receipt. Sign-in uses the
existing development auth, which the Worker only enables when GitHub OAuth is not configured
(`apps/portal/worker/routes/session.ts`), with a test that production config refuses it.

Data: the repo's seeded VISION26 cohort, its benchmarks and examples, and reports produced by actually running
`cogworks` on public week data. Captured artifacts are allowed only when permitted and only through the real
result contract. No hand-written scores, no private submissions.

### Surfaces in the catalog

| # | Surface | Entry points |
|---|---------|--------------|
| S1 | Signed-out public | `/`, `/leaderboard`, deep links, unknown routes |
| S2 | Onboarding and setup | `/signin`, `/join`, `/connect`, `/connections`, `/setup`, device-code link |
| S3 | Runs and results | `/dashboard`, `/team`, `/runs/:runId`, `/run-surfaces/:surfaceId`, local reports |
| S4 | Staff | `/admin`, staff desk (worker routes in #106, no page yet) |
| S5 | Authorization | every route above, for each role and for revoked, changed-team and expired users |
| S6 | Discord Activity | the Activity frontend (`apps/portal/src/activity-main.tsx`), team/link gating, live console |
| S7 | CLI | `cogworks check/test/run/report` offline; `link/sync/status/--live` against the Worker |
| S8 | CogBot | `/cog` through signed interactions to Portal RPC |
| S9 | Saved-report comparison | `tools/run-comparison/` (#101) |
| S10 | Runner and scorer | `apps/runner-modal/` controller, sandbox, scorer and callbacks, run locally without Modal |

### Adversarial classes (every surface where they apply)

A1 delayed, lost, duplicated and reordered responses through a network-shaping proxy in front of the real Worker;
A2 two tabs or two devices; A3 stale cache after a role or team change; A4 double submit; A5 concurrent team
members; A6 malformed and oversized results; A7 Unicode, RTL and emoji names and very long input; A8 clock skew;
A9 Worker or CLI killed mid-operation; A10 revoked or expired credentials mid-journey.

S10 adds the agenda in the repo's CLAUDE.md ("What we test for"): student code that raises, returns None or ragged
lists, mutates inputs, prints thousands of lines or hangs gets a scored result or a categorized failure and never
kills the runner, controller or scorer; a failed run never stays in `evaluating`; one team's bad run never affects
another's; the public leaderboard renders signed out when a run, benchmark row or metric is missing.

### Metrics and pass bars

| Metric | Bar |
|--------|-----|
| M1 journeys | each surface has at least one complete journey; 3 consecutive fresh-database runs pass, zero retries |
| M2 adversarial | each applicable class per surface: data kept, truthful state, a recovery path |
| M3 authorization | every role × route cell matches policy at the API and in the UI |
| M4 accessibility | axe 0 violations after content loads at 1440x900, 390x844 and 320 wide; text contrast at least 4.5:1 by computed colour; each journey completes by keyboard; reduced motion honoured |
| M5 CLI | the documented install (the pinned `COGBENCH_SOURCE` students get, and the branch's CLI) works on Python 3.8 and each other supported version; every command runs on real public data |
| M6 defects | P0 (data loss, wrong access, false success) is 0; every other defect has a witness and a fix or an open decision |
| M7 UX review | a council review of the integrated app on `alpha` finds no blocking issue per surface |

Flakes count as failures. Results are reported per metric and per surface, in the PR's Proof section.

### Rules every task follows

- Nothing touches `main`, `beta`, the dev or production Workers, D1, R2 or Modal apps. `beta` is the dev/staging
  environment (`cogportal-dev.sillion.app`); student setup installs the SDK from its commit `064400e` and the runner
  images bake it, so it is never rewritten or moved. Installing from that pinned URL to test it is fine.
- Never call discord.com or post to the course guild: dev and prod share one Discord application, guild and bot.
  Discord is always a local double. Never use real GitHub OAuth; the GitHub App serves both environments.
- Load and stress tests run only against the local stack. Production has hit the Workers Free CPU and D1 query limits.
- Node 24 is required for the portal tests (`node:sqlite`).
- Staff visibility is undecided. Two rules await Sam: what a TA may see about assigned teams, and whether "no
  per-person numbers" stands. Implement both as one switchable policy, default to the current rule (no scores,
  metrics, findings, logs, person names or per-person totals for TAs), and test both settings.

### What Sam must provide for the remaining real paths

Each task appends to this list with the exact command it attempted. Starting entries: a test GitHub account and an
OAuth app or callback for an isolated environment; a private Discord test guild and bot not bound to production; a
Windows machine or runner for PowerShell setup; a physical phone and a screen reader session; hidden course data
and Modal access for scored hosted runs.

## Steps

1. **Round 0, harness and first fix pass (running).**
   - #102 continuation (`apps-cogportal-local-setup-e2e-f1`): `tools/portal-real-journeys/`, S1–S6, fixes in
     portal app/Worker/contract files, #106's staff desk routes plus a client page.
   - CLI and CogBot (`cogportal-cli-real-journeys-f1`): `tools/cli-real-journeys/`, S7–S8, fixes in
     `python/cogbench/` and `apps/discord-bot/`.
   - Runner and scorer (`cogportal-runner-broken-code-f1`): `tools/runner-real-journeys/`, S10, fixes in
     `apps/runner-modal/`.
   - #101 rework (`apps-cogportal-comparison-rework-f1`): S9.
2. **Integrate on `alpha`.** `alpha` is the integration branch for running and critiquing the product, not a
   release. It starts at #95's head `e9c9a1ff` (the hardening base, which carries the beta lineage and #79-#95;
   `main` is 958 commits behind it). After the lead's accept and the caretaker's pass, Round 0 branches merge into
   `alpha` with `--no-ff`. Merge order into `main` stays Sam's decision.
3. **Council on `alpha`** (on the task branches until the first merge). Run the full suite on `alpha` in an Obvious sandbox; Fable, Opus, Sol and Astra review
   screenshots and receipts against M1–M7.
4. **Round 1, variants.** For the surfaces with the worst M2/M7 results, two tasks try distinct directions
   (see below), both scored by the same suite and reviewed by the council. The winner merges; good ideas from the
   other are grafted.
5. **Round 2 and later** target what remains, until the stop rule fires.

## Directions worth trying in Round 1

- Staff desk: a team table sorted by "needs help" versus per-team cards with the next action.
- Setup: the current progress rail versus a single checklist that reads state from the portal and the CLI.
- Failure states: inline recovery per action versus one recovery panel per page.
- CLI output: current prose versus a terse status line plus `--explain`.

## Stop rule

Stop when M1–M6 meet their bars on `alpha` for 3 consecutive fresh runs and M7 has no blocking issue, or when two
rounds in a row move none of M1–M7. Record which one fired and why in this file.

## Out of scope

Live GitHub OAuth, Discord and Modal runs, hidden course datasets and model-weight equivalence. Each stays a named
gate with the command a task attempted. Merges to `main`, deploys and production data.
