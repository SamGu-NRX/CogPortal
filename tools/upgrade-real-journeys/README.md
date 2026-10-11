# CogPortal upgrade-path suite (`tools/upgrade-real-journeys`)

Proves the alpha Worker is a safe upgrade from beta **using beta's own data and installed
clients**, and puts course-size numbers on every alpha route. Companion to the plan of
record (`docs/plan/real-user-readiness.md`, PR #108) - this suite executes the upgrade-path
slice of that plan.

## What it answers

1. After alpha's migrations run on a beta-shaped database, does every existing user see
   their existing data truthfully? (stages 1-2)
2. Does the CLI students already installed keep working against alpha's Worker - and does
   alpha's CLI work against beta's during an out-of-step deploy window? (stage 3)
3. What happens when the deployment sequence goes wrong - interrupted runs, double runs,
   Worker ahead of migrations, rollback to beta? (stage 4)
4. Which routes exceed per-invocation budgets (50 D1 queries / 10 ms CPU) at course size?
   (stage 5)

## Run

```
node bin/upgrade-suite.mjs            # all stages
node bin/upgrade-suite.mjs journeys   # one stage
```

Stages run in order and stop at the first failure. Every stage writes a receipt under
`receipts/` and prints a per-step summary. **Stages never retry themselves: a flake is a
failure** (plan metric M1 - no fabricated passes).

## Stages and pass bars

| Stage | Script | Does | Pass bar |
|---|---|---|---|
| 1 `generate` | `suites/generate.mjs` | Builds a beta-shaped local D1 (beta's migrations + seed) and creates realistic course state **only through beta's real paths** - its SPA/API as dev-auth users and the pinned CLI (`064400e`): cohorts, teams, joins/leaves, forks, device links, synced local reports, hosted fixture runs, published official attempts, staff/TA assignments. Snapshots to `state/beta-snapshot/`. | Fresh-clone run exits 0; `receipts/generate.json` lists every entity class with counts; zero real student data. |
| 2 `journeys` | `suites/journeys.mjs` | Restores the snapshot, applies **alpha's** migrations in deployment order, starts alpha's built Worker+SPA, drives every existing user's journey with Playwright and asserts the data shown matches the snapshot's rows (nothing lost, duplicated, or misattributed). | Every journey x role passes, zero retries, `receipts/journeys.json` written. |
| 3 `clients` | `suites/clients.mjs` | Pinned CLI vs **alpha** Worker (link, sync, status, `run --live`) and **alpha** CLI vs beta Worker (out-of-step deploy window). Wire defects get a committed witness with repro command; the fix belongs to the CLI task (PR #110). | Per-direction, per-command results in `receipts/clients.json`; exit code reflects pass. |
| 4 `failures` | `suites/failures.mjs` | (1) migration interrupted halfway then re-run; (2) migrations applied twice (incl. the deployed duplicate `0039`/`0040` pairs - never renumber); (3) alpha Worker started before `0047`-`0049` apply; (4) beta Worker against a post-alpha database (rollback). | Every scenario has a witness + outcome: passes / fixed by an additive migration / handed to the owning task. |
| 5 `volume` | `suites/volume.mjs` | Scales the snapshot to course size (generated accounts only), then records D1 queries/request and CPU per alpha route via the measurement shim; flags over-budget routes with the exact request. | `receipts/volume.md` covers every route; zero unflagged over-limit routes. |

## Layout

```
bin/upgrade-suite.mjs   orchestrator (one command)
lib/node24.mjs          Node 24 bootstrap (portal tests + node:sqlite need it)
lib/beta-worktree.mjs   beta checkout (17d26d9) as a git worktree + deps
lib/d1.mjs              local D1 lifecycle: find / migrate / snapshot / restore / inspect
lib/servers.mjs         .dev.vars (fixture provider + dev-auth) + build + vite preview
lib/measure.mjs         generated worker-entry shim + counting D1 proxy (stage 5)
suites/*.mjs            one file per stage (see each file's header contract)
receipts/               committed evidence: JSON receipts, volume.md, witnesses/
state/                  NEVER COMMITTED: sqlite snapshots, scaled databases
.cache/                 NEVER COMMITTED: worktree, node cache, logs
```

## Honesty rules (from the plan's benchmark checklist)

- Every number in a receipt is measured this run, with the method and its limits stated
  next to it. Nothing estimated, nothing carried over from a previous run unlabeled.
- The CPU metric is labeled for what workerd actually reported; the shim counts
  binding-level D1 calls (prepare/batch/exec statements). Anything unmeasurable is
  recorded as unmeasured with the reason.
- Generated test accounts only. No real student handles or submissions anywhere.
- Local doubles only: no discord.com, no real GitHub OAuth, no Modal, no dev/prod
  Workers/D1/R2. `EXECUTION_PROVIDER=fixture` is not a suggestion.

## Commit / push discipline

- Commits: author **Sam Gu** `<127461594+SamGu-NRX@users.noreply.github.com>`, ending with
  `Co-authored-by: obvious-autobuild[bot] <262744130+obvious-autobuild[bot]@users.noreply.github.com>`.
- Portal typecheck + test suite (Node 24) green before every push.
- Push only verified steps to the task branch; never force-push, rebase, or amend.
- Route/worker defects found here are witnesses, not fixes (they belong to the web e2e
  task); data-shape defects get additive migrations in `apps/portal/migrations/` (stage 4
  owns that path; never edit an existing migration file).
