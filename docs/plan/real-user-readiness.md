# CogPortal: real-user readiness plan

Owner: the CogPortal lead (focus/gushi fleet), 2026-10-11. Task prompts quote this file by section.

## Goal

Every surface a student, TA, instructor or visitor touches works for a real user on the real stack: the built
portal SPA, the portal Worker with D1, the `cogworks` CLI on the course's own data, the Discord Activity and
CogBot. "Works" means the user can finish the job, sees a truthful state when something goes wrong, keeps their
data, and can recover without help.

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

### Adversarial classes (every surface where they apply)

A1 delayed, lost, duplicated and reordered responses through a network-shaping proxy in front of the real Worker;
A2 two tabs or two devices; A3 stale cache after a role or team change; A4 double submit; A5 concurrent team
members; A6 malformed and oversized results; A7 Unicode, RTL and emoji names and very long input; A8 clock skew;
A9 Worker or CLI killed mid-operation; A10 revoked or expired credentials mid-journey.

### Metrics and pass bars

| Metric | Bar |
|--------|-----|
| M1 journeys | each surface has at least one complete journey; 3 consecutive fresh-database runs pass, zero retries |
| M2 adversarial | each applicable class per surface: data kept, truthful state, a recovery path |
| M3 authorization | every role × route cell matches policy at the API and in the UI |
| M4 accessibility | axe 0 violations after content loads at 1440x900, 390x844 and 320 wide; text contrast at least 4.5:1 by computed colour; each journey completes by keyboard; reduced motion honoured |
| M5 CLI | the documented install works on each supported Python; every command runs on real public data |
| M6 defects | P0 (data loss, wrong access, false success) is 0; every other defect has a witness and a fix or an open decision |
| M7 UX review | a council review of the integrated app on `alpha` finds no blocking issue per surface |

Flakes count as failures. Results are reported per metric and per surface, in the PR's Proof section.

## Steps

1. **Round 0, harness and first fix pass (running).**
   - #102 continuation (`apps-cogportal-local-setup-e2e-f1`): `tools/portal-real-journeys/`, S1–S6, fixes in
     portal app/Worker/contract files, #106's staff desk routes plus a client page.
   - CLI and CogBot (`cogportal-cli-real-journeys-f1`): `tools/cli-real-journeys/`, S7–S8, fixes in
     `python/cogbench/` and `apps/discord-bot/`.
   - #101 rework (`apps-cogportal-comparison-rework-f1`): S9.
2. **Integrate on `alpha`.** After the lead's accept and the caretaker's pass, merge with `--no-ff` into `alpha`
   (cut from main). Every Round 0 branch stacks on #95's hardening base, so the first merge brings #95's 17
   commits; the lead reviews #95's current head as an input before that merge. `beta` is live course
   infrastructure and is never touched.
3. **Council on `alpha`.** Run the full suite on `alpha` in an Obvious sandbox; Fable, Opus, Sol and Astra review
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
