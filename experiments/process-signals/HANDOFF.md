# Process-signals builder study — handoff (M2 + M3)

Status: **M1–M3 complete on this branch.** Live run and replay both executed
against the real builders; all results are committed under
`experiments/process-signals/results/`. Nothing is merged or deployed.

## What ran

`python3 experiments/process-signals/run.py --manifest experiments/process-signals/manifest.json`

- 17 confusion-table rows (10 paired scenarios + 7 ablations), **zero unexpected verdicts**.
- TypeScript arm exercised via `pnpm exec tsx experiments/process-signals/run-worker.ts` from the
  repo root; Python arm in-process against the real `cogbench.process` module.
- Every arm ran twice per unit; all repeats byte-identical (`results/determinism.json`).
- One fetch-failed scenario is unexercisable in the Python arm by construction
  (`process.py` has no fetch-failure input); it is recorded as such, never as evidence.

## Headline results

- All paired scenarios **agree** on the shared field set, except `week2-coauthors`, which agrees
  **except the documented divergence** (TS resolves `Co-authored-by:` trailers against the roster;
  Python cannot express them — see `FIELDS.md`).
- All three confirmed-delta ablations (filename, scored-flag, timestamp) landed exactly on their
  declared path sets in **both** arms.
- The two null-delta ablations (insertions, run-status) moved nothing in either arm — recorded as
  `confirmed-null`: the zero delta was the expectation, and it remains inconclusive about code
  paths these histories never reach.
- `combined-many-changes` moved the union of three deltas at once and is included precisely to show
  why single-variable ablation is the study's unit of evidence.

## Replay (cached-run guarantee)

`python3 experiments/process-signals/run.py --replay experiments/process-signals/results`

Regenerates `summary.md` from recorded bytes only; `results/regeneration.json` records
`summaryAgrees: true` with equal SHA-256 (`f2822042…`). Scope is stated in the record itself:
replay attests the **aggregate** records (`confusion-table.json`, `determinism.json`); per-run
bytes are attested by the live-run repeats, not by replay.

## Regression evidence (M3)

- `tests/test_replay_agreement.py` — replay regenerates the committed summary byte-identically;
  a tampered verdict record makes replay **refuse** to agree (the check is real, not a rubber
  stamp); the per-run boundary is pinned by its own test so the guarantee is never overstated.
- `tests/test_mutation_regression.py` — adding a second commit to the single-commit bulk-upload
  scenario flips the real builder's classification `bulk_upload → usable`, and the frozen
  observability record **disagrees** with the mutated run — the freeze detects changed histories
  instead of silently reporting the frozen value.

Suite: `python3 -m pytest -q experiments/process-signals/tests` → **35 passed**.

## Fix during this milestone (recorded, not hidden)

The first live run reported the whole TS arm as unexercised because the `tsx` availability probe
ran `run-worker.ts --version` (executing the adapter, which exits nonzero on missing arguments)
instead of probing `tsx` itself. Fixed in `run.py`; the committed results come from a run with the
TS arm genuinely exercised. Two verdict artifacts from an earlier list-diff quirk (indexed list
paths in deltas) were fixed in the same pass; expectations were never edited to make a row pass.

## Standing limits

See `unsupported-interpretations.md` — in particular: an unexercised arm supports no claim; a
zero-delta ablation cannot rule out reading in unreached code paths; absence findings inside a
truncated window are not attributable. No per-person totals or grades exist anywhere in this study.
