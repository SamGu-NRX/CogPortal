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
showed two noise mechanisms: the harness's own sampler/process scan holds a
transient `/proc/<pid>/stat` descriptor at snapshot time, and descriptor
counts jitter by ±1 with no new target path at all. The detector now judges
by *targets*: a leak is a post-run descriptor onto a real path that was not
open before the run (the contaminated control's `leak-*.txt` files). New
targets under `/proc/`, `/sys/`, `/dev/` and count-only jitter are recorded
in the finding's `transient` list — visible, but not flagged.

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

## Status

- Milestone 1 (supervisor + detector + tests, enforced/observed matrix):
  complete — suite green twice consecutively.
- Milestone 2 (manifest runs through the real runner, recorded counts):
  pending.
- Milestone 3 (replay agreement, witness scripts, handoff PR): pending.
