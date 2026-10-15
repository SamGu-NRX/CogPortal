# Handoff — CogPortal reliability hardening (`obv/products-cogportal-hardening-20261009`)

Draft PR: SamGu-NRX/CogPortal#95 into `fix/device-link-recovery-20261004`. Nothing merged, nothing deployed.

## What this branch contains

Six hardening commits on top of the base (commit `84d5c93`, the audio validity study's freeze, was removed again by `a2d13a0` — see the Audio handoff section):

- `fa18e1c` — leaderboard resolves a benchmark's active version before the highest version.
- `ab956ce` — regression test pinning the active-first ordering (both halves: active-older wins; all-archived resolves to newest).
- `787fe00` — member-add verifies the person's GitHub permission on the team's repository before storing a role; no-permission is 403 `repo_access_required` with no row; GitHub outage/429 is retryable 503 `github_unreachable` with no row. Join flow and dev-auth deployments unchanged.
- `1ca2daa` — Discord quota copy and the evaluation time limit single-sourced from `OFFICIAL_LIMIT` / `EVALUATION_TIME_LIMIT_SECONDS` in contracts.
- `960739a` — Connections empty-poll bounded (brisk first minute, 30 s after, stops at 11 minutes past the device-code TTL, re-arms on focus).
- `e546392` — local-run event batches commit all-or-nothing in one `db.batch`, per-event admission semantics and refusal responses preserved (failing-first witness recorded in the commit).

## Runtime / check receipt (actual outputs, run 2026-10-11 on tree `a2d13a0`)

| check | command (from repo root) | result |
| --- | --- | --- |
| typecheck/lint all packages | `pnpm check` | exit 0, all 5 packages Done |
| portal suite | `TSX_TSCONFIG_PATH=tsconfig.app.json pnpm --filter @cogworks/portal test` | tests 1254, pass 1254, fail 0 |
| discord-bot suite | `pnpm --filter @cogworks/discord-bot test` | tests 38, pass 38, fail 0 |
| contracts suite | `pnpm --filter @cogworks/contracts test` | tests 13, pass 13, fail 0 |
| build | `pnpm build` | Done (portal built in 1.57 s) |
| runner-modal suite | `python3 -m unittest discover -s tests -p "test_*.py"` (in `apps/runner-modal`) | Ran 628 tests, OK (skipped=46) |
| cogbench suite | `python3 -m unittest discover -s tests -p "test_*.py"` (in `python/cogbench`) | Ran 1279 tests, OK (skipped=5) |

Node 24 (`/home/user/.local/opt/node-v24.11.0-linux-x64/bin`) is required — the sandbox default Node 20 cannot run the repository's `node:sqlite` tests.

## Audio validity study — handoff record

The freeze commit `84d5c93` accidentally carried the study's four validity files (`PROTOCOL.md`, `analyze_results.py`, `run_study.py`, `study_pipeline.py`) in this PR's diff. Revert `a2d13a0` removes them from the diff only (no history rewritten), after verifying by content hash that everything here was preserved on the study's own branch:

- `origin/obv/products-audio-validity-20261009-r1` at `c05f42e` holds the study's cherry-picked freeze (`ebdb309`, identical tree to `84d5c93`, recorded in its `BASELINE.md`) plus newer study work (baseline receipt, metadata audit, call-order oracle, real-audio provenance).
- The study thread's live worktree `/home/user/work/CogPortal-study` is ahead of this checkout and holds its newest measurement results (`results/ambiguity/`, the call-order run, an in-flight `run_study.py` edit). That worktree was left completely untouched.
- A tarball backup of the study's working files taken at revert time: `/home/user/work/audio-validity-worktree-backup-20261011.tar.gz`.
- Stale duplicate copies (BASELINE.md, audit/, results/, `__pycache__`) remain untracked in this checkout, deliberately not deleted. The authoritative copies are the study worktree and the r1 branch.

## Remaining limits — what is NOT done

1. **Diagnostic-sync redaction contract** — research defined it (repository-relative path rewriting for known roots, more precise privacy claims; `diagnose_corpus.py` has no upload path, so no redaction pipeline to build). Not implemented.
2. **CLI producer wire conformance** — audit recorded producer/schema mismatches; deliberately unaddressed because tightening server validation risks breaking installed CLI clients. Needs its own design pass.
3. **Four setup-pin discrepancies** — the emitted `run --live` command omits `--benchmark`; stale Modal version floor in the Modal docs; a stale design-doc pin; a stale product-description pin. Recorded with file:line evidence in the setup-pin research thread; not fixed.
4. **No React-hook test for the polling change** — this repo's `node --test` harness has no React hook harness; covered by typecheck and the documented reasoning against the worker's device-code TTL.
5. **Review and merge of PR #95** — human action; this workspace never merges.

## Exact resume command

From a fresh sandbox with this repo:

```sh
git fetch origin && git checkout obv/products-cogportal-hardening-20261009 && git pull --ff-only
export PATH="$HOME/.local/opt/node-v24.11.0-linux-x64/bin:$PATH"
pnpm install --frozen-lockfile
pnpm check
TSX_TSCONFIG_PATH=tsconfig.app.json pnpm --filter @cogworks/portal test
```

For the Python suites: `cd apps/runner-modal && python3 -m unittest discover -s tests -p "test_*.py"`, then the same in `python/cogbench` (Python 3.8 venv as documented in the audio study's BASELINE.md for benchmark work; the suites here ran on system Python 3).
