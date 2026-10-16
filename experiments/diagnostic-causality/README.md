# Diagnostic-causality study

Does the pinned `cogworks` CLI's diagnostic point at the defect that caused
it? See `PROTOCOL.md` for the design; `key.json` is the defect/repair ground
truth (grading only — the measurement never reads it); `manifest.json` pins
sources, tracks, and commands.

```sh
# in the owned venv (/home/user/work/venvs/diag-causality)
python -m pytest -q experiments/diagnostic-causality/tests
python experiments/diagnostic-causality/run.py --manifest experiments/diagnostic-causality/manifest.json
python experiments/diagnostic-causality/run.py --replay experiments/diagnostic-causality/results
```

Layout: `fixtures/control` is the frozen miniature adapter; `run.py`
materializes variants from `key.json` patches, measures through the real CLI,
oracles each diagnosis by repair-restores-control (round 1 acts on the
diagnosis recorded from the pristine measurement; post-repair bundles are
retained as raw captures), grades against the key,
and writes `results/` (raw bundles, diagnoses, oracle verdicts, tables,
summary). `--replay` recomputes everything derived from the raw captures and
asserts agreement.
