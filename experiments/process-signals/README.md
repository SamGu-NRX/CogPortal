# Process-signals builder study

A signal-measurement study for the process layer's two builders on
`fix/device-link-recovery-20261004`:

- **Python arm**: `python/cogbench/src/cogbench/process.py`
- **TypeScript arm**: `apps/portal/worker/services/process-signals.ts`

The question this study answers is not "do the builders pass their tests" but
**what each measurement run can and cannot teach**: which input fields the
builders actually read, what a run's counts mean, which comparisons are
supported, and which interpretations the data does not support. It inherits
the builders' two hard rules — no per-person totals, never interpolate — and
adds a third of its own: an arm that did not run is reported as unexercised,
never as evidence of agreement or divergence.

## Layout

| Path | What it is |
|---|---|
| `FIELDS.md` | Declared fields read (and accepted-but-never-read) by each builder |
| `manifest.json` | The frozen paired synthetic histories: 10 scenarios, 7 ablations |
| `harness.py` | Fixture loader, patch applier, Python arm, canonical normalization |
| `frozen/counts.json` | History-type counts over the frozen scenarios |
| `frozen/observability.json` | Expected per-scenario observability (null-vs-zero semantics included) |
| `frozen/source-hashes.json` | sha256 of both builder sources at freeze time |
| `run.py` | Experiment CLI: `--manifest`, `--replay` |
| `run-worker.ts` | TypeScript-arm adapter, executed via `pnpm exec tsx` |
| `tests/` | pytest regression suite (`python -m pytest -q experiments/process-signals/tests`) |
| `results/` | Committed measurement outputs, confusion table, study notes |

## Commands

```bash
python -m pytest -q experiments/process-signals/tests
python experiments/process-signals/run.py --manifest experiments/process-signals/manifest.json
python experiments/process-signals/run.py --replay experiments/process-signals/results
```

## Status

- [x] M1 — field declarations, frozen histories, counts, observability, source hashes
- [ ] M2 — live run against both arms, ablations, confusion table, interpretation limits
- [ ] M3 — replay regeneration agreement, changed-history mutation regression
