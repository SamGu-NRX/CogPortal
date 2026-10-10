# Handoff — diagnostic-causality study

## Status: COMPLETE (offline, unmerged)

Draft PR into `fix/device-link-recovery-20261004`. Nothing merged, deployed, or
run against any paid service or live model.

## What this study answers

Can the CLI's shipped diagnostic output actually identify the *cause class* of
a behavioral failure — not just a symptom — on a real runner? Seven defects of
seven distinct true cause classes were injected one at a time into a frozen
miniature of the Week 1 audio-identification submission, measured through the
real `cogbench` CLI, diagnosed by the CLI's own printed diagnostic lines, and
repaired by the oracle loop. Three compound variants (two defects each) ran
the same loop with up to 3 rounds. A deliberately wrong repair probed whether
the oracle rejects plausible-but-wrong fixes.

## Results (frozen run, this directory's `results/`)

- **Control score 0.671875** over 64 scored queries; outcome split
  43 top_1 / 17 top_k / 4 retrieval_failure.
- **Single defects: 3/7 correctly diagnosed** (`name_error`, `signature`,
  `shape_pairs` — the three whose symptoms are literal text in the bundle).
- **The other 4 were all misdiagnosed as `hash_space`** (`empty_result`,
  `fp_freq_sign`, `fp_swap`, `wrong_order`), each with a plausible-sounding
  evidence line ("in different hash spaces", "Retrieval, not ranking, is
  what is failing") and a non-actionable repair (`diagnosis_correct=False`,
  `non_actionable=True` in `tables/cause_classes.csv`). The catch-all
  witness absorbs every non-textual failure mode: a ranking bug reads the
  same as a dead fingerprint space.
- **Compound defects: 0/3 ever restored.** Even when round 1 correctly fixed
  `name_error` or `signature`, the remaining defect pushed round 2 into
  `hash_space` or `undiagnosed` (`tables/multi_defect.md`).
- **Oracle honesty checks pass**: every true repair restored the control
  outcome exactly (timing excluded, see PROTOCOL), and the wrong-repair
  probe (numpy import applied to `fp_freq_sign`) was correctly rejected
  (`wrong_repair_probe_oracle_agrees: true` in `summary.json`).
- **Replay witness**: `run.py --replay results` recomputes every derived
  artifact from the committed raw captures — `agrees: true`, zero problems.

## Environment deviations (PROTOCOL.md has the details)

- NumPy 2.5.3 installed `--no-deps` (pinned `numpy<2` has no wheel for the
  available CPython 3.13.14); driver/scorer verified end to end.
- The pilot run exposed three apparatus defects (oracle timing comparison,
  outcome-neutral fingerprint defects, shape-rule over-firing); all were
  fixed before the frozen run, which was produced from scratch afterward.
  The pilot was never committed.

## Not run / not verified

- Week 2 (vision) and Week 3 (language) tracks: unmeasured — need the
  `[data]` extra, model weights/datasets, and Python <3.13
  (`summary.json:unmeasured_tracks` records per-track reasons).
- No CI run; the host venv (`/home/user/work/venvs/diag-causality`) is the
  only verified interpreter.

## Resume command

```bash
cd /home/user/work/cogportal-diag && \
/home/user/work/venvs/diag-causality/bin/python experiments/diagnostic-causality/run.py \
  --replay experiments/diagnostic-causality/results
```

(exits 0, `agrees: true`). Re-measure from scratch with
`run.py --manifest experiments/diagnostic-causality/manifest.json` (~35 min).

## Tests

`python -m pytest experiments/diagnostic-causality/tests` — **16 passed**,
including the results-dependent replay-agreement and wrong-repair tests.
