# Checkpoint: candidate `edf4de3`, 2026-10-03

The feature documents still describe `2ff32fa`, and [`checkpoint-17d26d9.md`](checkpoint-17d26d9.md) records the accepted beta. This page covers the current candidate, `edf4de3`. It answers three questions an instructor asks: what the candidate does that the documents don't yet say, what was seen running, and what nobody has shown on this build. Labels for every earlier build stay as they were.

## How it ran

`edf4de3`, with the CLI built from `ecae617`, was deployed to a separate, owned Modal environment, which was deleted afterwards. The beta runner stayed at v48 and was not changed. A local Worker and local D1 dispatched to that environment. Callbacks came back through a tunnel that carried only callbacks. The synthetic student connected a public test repository with a GitHub token placed in local D1, not through GitHub sign-in. Dispatch was direct; no Cloudflare Queue was bound.

## What was seen

- **A malformed submission.** Practice run `run_558299445b` at `4c6d54d` succeeded at Overall 0.003438. Its run page leads with the benchmark's specific note that `embed_text` returned a 1-D array where a 2-D matrix was expected.
- **A working submission.** Practice run `run_3c844cb2a1` at `bb08255` succeeded at Overall 0.154000, and its page leads with the benchmark's finding.
- **Callbacks.** All were answered `200`: seven for the malformed run, eight for the working one.
- **Phases.** In both runs' raw receipts, every phase after `queued` closed in order with an `ended_at`. `queued` was not stamped under this direct dispatch ([the run](../foundations/the-run.md#edge-cases)).
- **The CLI on Python 3.8.** The real `ecae617` CLI was installed and linked through the local approval API. It ran a live local run and synced one report, which made one session and one console with eight stored events. The console's toggle read "Show all 7": the label is `Show all {n}` over the collapsed timeline (`apps/portal/src/components/RunConsole.tsx:234`), and `collapseRepeatedRunEvents` (`:185`) folded two identical progress rows into one.

The approval URL the CLI printed pointed at the callback-only tunnel. So a student opening that link in a browser and approving there was not tested.

## Changed in source since `93dfa5e`, read from code

Each of these has suite coverage. None was exercised by the runs above unless the list says so.

- **Local runs.** Two separate D1 batches. Starting a local run writes its console and session together. Accepting an event writes the event and advances the session together. The CLI path above exercised ordinary start and event handling. The simultaneous first-save race is covered by the suite, not that runtime pass: both saves succeed and leave one report (`2e88571`, `166624a`; `apps/portal/test/local-reports.test.ts:615-630`).
- **Weights.**
  - A report's weights attach to a hosted run only when they belong to that run (`d1ab349`).
  - A refusal states only what the refused report establishes (`1b5864f`).
  - The pinned `ecae617` CLI refuses to sync a saved report that never recorded its weights (`f66402b`, `ecae617`); Setup now pins that CLI (`39dd90e`). An older installed CLI turns the missing field into `[]` and sends it, so the portal can accept it as a known-empty record. The portal can't tell where that value came from. Those students update the CLI and run again. The limitation is stated in migration 0047 and in code comments, not on the Setup page. See [the weights record](../cross-cutting/what-the-benchmark-supplied.md#the-second-kind-weights-from-the-teams-own-local-run).
- **Retry.** A failure whose remedy is a code fix has no Retry action. That policy alone does not populate `retryRefusal`, so the page does not display its refusal sentence; a direct Retry API call receives it (`4389759`, `01827f6`; `apps/portal/worker/services/run-surfaces.ts:413-435`, `apps/portal/worker/services/run-actions.ts:584-587`).
- **The stale-run sweep.** It judges a silent reporting execution by its last accepted callback. Legacy reporting executions with no accepted callback recorded get one grace window when a sweep first finds them past the inactivity limit. A `queued` run is still failed ten minutes after creation, with no grace (`f8358de`; `apps/portal/worker/execution/maintenance.ts:16`, `:34`, `:62-69`, `:85-88`).
- **Recognition quota.** Migration 0048 releases used quota left charged after 0044 for older Recognition v2 executions recorded under `recognition-v1`, while old active executions keep their reservations until they finish and then incur no charge (`c81878b`; `apps/portal/migrations/0048_recognition_v1_capacity_release.sql:23-29`, `apps/portal/worker/services/run-accounting.ts:15-16`, `:29-38`).
- **The admin page.** It tells a team whose hosted runs failed apart from one that never ran (`d068212`).
- **Stored-link notice.** When the browser denies storage, only the dropped-link notice is lost, not onboarding (`d304897`).
- **Discord consent.** It discloses hosted runs before a team binds its channel, and no longer promises one post per run (`9984b31`, `b19959c`).

## Not shown on this build

- GitHub OAuth sign-in
- hosted Cloudflare bindings, D1 and Queues
- Discord delivery
- an official run with hidden data
- a weights upload carried through to a hosted run
- Windows and physical phones

Earlier builds' receipts, recorded in [`../bug-triage.md`](../bug-triage.md) and the other checkpoint, may cover some of these on those builds.

The digest contract gated in PR #80 (`2f69bd1`) is a separate change. It is not in `edf4de3` and was not deployed.
