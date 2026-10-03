# Checkpoint: candidate `edf4de3`, 2026-10-03

The feature documents still describe `2ff32fa`, and [`checkpoint-17d26d9.md`](checkpoint-17d26d9.md) records the accepted beta. This page covers the current candidate, `edf4de3`. It answers three questions an instructor asks: what the candidate does that the documents don't yet say, what was seen running, and what nobody has shown on this build. Labels for every earlier build stay as they were.

## How it ran

`edf4de3`, with the CLI built from `ecae617`, was deployed to a separate, owned Modal environment, which was deleted afterwards. The beta runner stayed at v48 and was not changed. A local Worker and local D1 dispatched to that environment. Callbacks came back through a tunnel that carried only callbacks. The synthetic student connected a public test repository with a GitHub token placed in local D1, not through GitHub sign-in. Dispatch was direct; no Cloudflare Queue was bound.

## What was seen

- **A malformed submission.** Practice run `run_558299445b` at `4c6d54d` succeeded at Overall 0.003438. Its run page leads with the benchmark's specific note that `embed_text` returned a 1-D array where a 2-D matrix was expected.
- **A working submission.** Practice run `run_3c844cb2a1` at `bb08255` succeeded at Overall 0.154000, and its page leads with the benchmark's finding.
- **Callbacks.** Seven of eight were answered `200`.
- **Phases.** Every phase that reported closed with a recorded end time. `queued` was never stamped, as [the run](../foundations/the-run.md#edge-cases) says it never is.
- **The CLI on Python 3.8.** The real `ecae617` CLI was installed and linked through the local approval API. It ran a live local run and synced one report, which made one session and one console with eight stored events. The console's "Show all 7" deliberately folds two identical progress rows into one.

The approval URL the CLI printed pointed at the callback-only tunnel. So a student opening that link in a browser and approving there was not tested.

## Changed in source since `93dfa5e`, read from code

Each of these has suite coverage. None was exercised by the runs above unless the list says so.

- **Local runs.** A local run's console, session and events are committed together. A report saved twice by a race is stored once (`2e88571`, `166624a`). The CLI path above exercised this once.
- **Weights.**
  - A report's weights attach to a hosted run only when they belong to that run (`d1ab349`).
  - A refusal states only what the refused report establishes (`1b5864f`).
  - The CLI refuses to sync a saved report that never recorded its weights. An older CLI cannot say why, so a team on an older install is refused without the explanation (`f66402b`, `ecae617`; Setup names the limit, `39dd90e`).
- **Retry.** Retry is refused for a failure whose remedy is a fix in the team's code. Where it is unavailable, the page says so instead of predicting the rerun (`4389759`, `01827f6`).
- **The stale-run sweep.** It judges a silent execution by its last accepted callback, with grace for runs that predate the change (`f8358de`).
- **Recognition quota.** Places held by `recognition-v1` runs after migration 0044 are released (`c81878b`).
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
