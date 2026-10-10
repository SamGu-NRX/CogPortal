# Run-interference study — notes

Measures lifecycle contamination in adapter execution: a clean adapter must not
inherit a previous adapter's state. Offline only; everything lives under
`experiments/run-interference/`. Runs go through the repository's real
`cogbench.runner.execute` and `cogbench.isolate.run_isolated`
(`python/cogbench/src/cogbench/`), unmodified.

## Layout

- `supervisor.py` — batch driver (in-process and isolated modes), resource
  observations, baselines, sweeps, interruption handling.
- `detector.py` — five signals: `mutated_arrays`, `module_globals`,
  `unclosed_handles`, `leftover_children`, `output_flooding`.
- `evidence.py` — fd snapshots, process-tree scans, samplers, output capture,
  module fingerprinting.
- `fixtures.py` + `fixtures/adapters/` — the benchmark and the adapter
  controls (`clean_reuse`, `contaminated_all`, `slow_sleeper`, `quick_sleeper`).
- `tests/` — unit tests for the detector and integration tests through the
  real runner (`python -m pytest -q experiments/run-interference/tests`).

## Enforcement matrix (verified, not assumed)

Two batch modes ship, and they enforce different subsets. This is the honest
account of what the harness can currently *enforce* versus what it merely
*observes*; every batch record carries its own matrix under
`limits_enforcement`.

| Limit | in-process | isolated | How the enforced side works |
|---|---|---|---|
| Wall-clock per run | observed | **enforced** | kill + reap on deadline (`cogbench.isolate` timeout path) |
| Child memory (`ulimit -v`) | observed | **enforced** | child pre-exec resource limit |
| Output flood budget | observed | **enforced** | capture caps stored bytes, counts dropped bytes |
| Scratch directory cleanup | **enforced** | **enforced** | supervisor removes per-run scratch after every run |
| Descendant reaping | **enforced** | **enforced** | process-tree sweep, SIGKILL + waitpid |
| Adapter-side state leaks | observed (this is the subject) | contained by construction | fresh process per run destroys in-run state |

In-process mode *observes* wall-clock, memory, and flood limits (the run
record carries the measurements) but cannot enforce them without killing the
host; that is exactly the lifecycle the study measures. The tests assert the
matrix per batch, not just the happy path.

## Evidence discipline: answers are digests, not payloads

Per-run answer evidence is `LocalReport.output_digest` — the real runner's
own sha256 over the predictions. Run records never store prediction payloads.
Drift means "a run answered differently from what a fresh import of the same
adapter answers on identical inputs" (`baseline_output_digest` on each run
record), read from a field the runner itself computes. This keeps the study
payload-free while preserving the full comparison power of exact answers.

## Finding 1 — the measurement apparatus can contaminate itself

`shared_registry` (the fixture adapters' cross-adapter surface) is cached in
`sys.modules` for the life of the host process. Without a reset, batch N+1's
"fresh-import baseline" inherited the contamination batch N wrote there, and
the cross-adapter drift check went silent exactly when earlier batches had
already contaminated the registry. The supervisor now restores the registry
to its pristine import state at the start of every batch
(`_reset_shared_registry`, recorded per batch as `registry_reset`). The
study's own subject — leftover state in a shared module — was leaking into
the measurement; the fix makes every batch start from the same clean import.

## Finding 2 — fd counting needs targets, not totals

Clean concurrent batches were flagged `unclosed_handles` spuriously. Probing
showed four noise mechanisms: the harness's own sampler/process scan holds a
transient `/proc/<pid>/stat` descriptor at snapshot time; descriptor counts
jitter by ±1 with no new target path at all; a descriptor that vanishes
between the snapshot's `listdir` and `readlink` used to be recorded with the
sentinel target `unreadable` (now counted separately by `evidence.fd_snapshot`
as `unreadable`, never emitted as a target); and the kernel sometimes hands
back a bare `/proc` root — no trailing slash — which a `/proc/` prefix test
misses. The detector now judges by *targets* through `_is_pseudo_fs`: a leak
is a post-run descriptor onto a real path that was not open before the run
(the contaminated control's `leak-*.txt` files). Pseudo-fs roots and anything
under them, and count-only jitter, are recorded in the finding's `transient`
list — visible, but not flagged.

## M2 results — manifest through the real runner (run `20261010T210956Z`)

Command: `python experiments/run-interference/run.py --manifest
experiments/run-interference/manifest.json` — 6 batches, 22 runs, 8.3 s wall,
all through `cogbench.runner.execute` / `cogbench.isolate.run_isolated`
unmodified. Every batch's flags agree with its manifest expectations
(`agrees=True` on all six).

| Batch | Mode | Runs | Flags | Expected |
|---|---|---|---|---|
| sequential-mixed | in-process | 4 | all five | flagged (contamination + inheritance) |
| sequential-clean | in-process | 3 | none | clean |
| concurrent-clean | in-process, c=2 | 4 | none | clean |
| isolated-contaminated | isolated | 3 | mutated_arrays, unclosed_handles, output_flooding | flagged (in-run only) |
| timeout-bounded | isolated, 2 s cap | 2 | none (2 timed_out) | clean |
| interrupted-batch | isolated, SIGINT at 0.5 s | 2 of 6 completed | none | clean |

Counts, before → during → after (full series in
`results/20261010T210956Z/summary.json` and `batch-*.json`):

- Processes: 0 descendants before every batch; `during_max` 1 (sleeper child)
  or 2 (contaminated control's `sleep 5`); 0 after every batch, including
  after the timeout kills and the SIGINT interruption.
- Files: per-run scratch peaks at 3 files mid-run; 0 files left in the run
  directory after every batch, 0 after cleanup everywhere; host study-scratch
  dirs 0 → 0 across the whole run.
- fds: batch-level `before`/`after` recorded per batch (jitter like 7 → 10
  and 10 → 7 across batches is the transient noise of Finding 2 — no leaked
  targets accompany it).
- Post-run sweep reaped nothing: `reaped=[]`, `remaining=[]`.

Sequential vs concurrent: verdict `identical` — clean sequential and clean
concurrent batches each produce exactly one output digest, and no clean batch
shows digest spread. The only digest spread anywhere is the contaminated
sequential-mixed batch (2 distinct digests across 4 runs: run 1 matches the
fresh-import baseline, later runs drift — the inheritance signature).

Interruption outcome (interrupted-batch): SIGINT at 0.5 s stopped the batch
after 1 of 6 planned runs; `orphans_found=[]`, `reaped_after_interrupt=[]`,
`remaining_after_sweep=[]` — the in-flight child was reaped with the run's
own cleanup path and the supervisor's post-batch sweep found nothing left.
The interruption point is timing-dependent: an earlier development run
interrupted after 2 of 6 runs with the same zero-orphan result (its artifacts
predate the final manifest and were not retained).

## Controls

- `contaminated_all` — the detector MUST flag it in-process on all five
  signals (and it does, per run, with per-run evidence: mutated inputs, the
  accumulating `_CALL_LOG`, drift from the fresh-import digest, new
  `leak-*.txt` descriptors, the abandoned `sleep 5` child, the 30k-line
  flood).
- `clean_reuse` — the detector MUST NOT flag it in-process: bounded reusable
  state, scoped files, no children, no flood; every run's digest equals the
  fresh-import baseline.
- Isolated mode bounds: in isolated batches the same leaks occur inside the
  child but none survive the boundary (`module_globals` and
  `leftover_children` go silent; the in-run signals still fire from
  child-side evidence).

## M3 — replay agreement and witnesses (run `20261010T210956Z`)

Replay command: `python experiments/run-interference/run.py --replay
experiments/run-interference/results` — resolves the latest recorded run,
verifies every batch artifact against the sha256 the run recorded for it
(integrity: `verified` on all six), then re-runs the detector over the saved
per-run evidence and compares the fresh verdict with the recorded one.

Agreement check, per batch (full per-fixture table in
`results/20261010T210956Z/replay.json`): all six batches match — recorded and
re-derived flagged-signal sets are identical, and both agree with the
manifest expectations. Per-fixture drift, re-derived from each run's own
recorded digests (`predictions_digest` vs `baseline_output_digest`):

- sequential-mixed: `contaminated_all` run 1 is the baseline (no drift — the
  fresh import has not been contaminated yet); every following `clean_reuse`
  run drifts (3/3) — the inheritance signature, reproduced from saved bytes.
- Every clean batch (sequential-clean, concurrent-clean, timeout-bounded,
  interrupted-batch): zero drift on every run.
- isolated-contaminated: zero drift on the host side — the leaks happen
  inside the child and die at the process boundary, while the detector still
  flags the three in-run signals from child-side evidence.

Witnesses (`witnesses/`, one small script per genuine contamination signal,
plus the negative control; each exits 0 on PASS): `mutated_arrays.py`,
`module_globals.py`, `unclosed_handles.py`, `leftover_children.py`,
`output_flooding.py` — each runs the contaminated control through the real
runner in-process and confirms its signal fires; `clean_reuse_negative.py`
runs the clean control and confirms nothing is flagged. All six PASS.

## Status

- Milestone 1 (supervisor + detector + tests, enforced/observed matrix):
  complete — suite green.
- Milestone 2 (manifest runs through the real runner, recorded counts):
  complete — run `20261010T210956Z` recorded under `results/`, all six
  batches agree with their manifest expectations, zero host leftovers.
- Milestone 3 (replay agreement, witness scripts, handoff PR): complete —
  replay ALL MATCH with artifact integrity verified, six witnesses PASS,
  suite green (29 passed). The handoff PR from this branch carries the
  Handoff section; this file records the study itself.
