# Run comparison workbench (offline)

Two saved runs are not necessarily a valid comparison. This directory is
an offline workbench for saying exactly what can be honestly compared
between two saved CogPortal run reports, and what cannot: it reads the
reports, separates their source, dataset, scorer and metric identities,
and renders a static view that leads with what the benchmark found and
which conditions changed — never with a grade or a per-person number.

Everything here is offline and synthetic. No network access, no portal
sync, no student data: the inputs under `fixtures/` are generated
reports with clearly synthetic content, not real runs.

## What it reads

A saved local run report is the JSON file the `cogworks` CLI writes for
one local scoring run: the `LocalReport.to_wire` payload, serialized by
`to_json` with sorted keys — see `python/cogbench/src/cogbench/
models.py`, and the reference specimen at
`python/cogbench/tests/fixtures/audio_no_weight_report.json`.

The report builders and scoring are read-only inputs. Nothing in this
directory writes reports, computes scores, or modifies those files.

## Provenance rules

The reader mirrors the writer's provenance doctrine and adds nothing:

- A field the writer omits to say "not recorded" (`weightsUsed` on a
  report that predates the field, `command` on a pre-0045 report) reads
  back as unknown. It is never replaced with a default: unknown weight
  provenance does not become "used no weights", and an unrecorded case
  set does not become `run`.
- `weightsUploaded` null or absent means the report predates weight
  capture — a statement about the writer, never read as "nothing to
  upload".
- A receipt that fails the writer's own validation rules (digest, byte
  length, naming a weight the report did not score) refuses the report
  with the reason named. A receipt that exists but is invalid is one
  problem; the weight it names is only "missing" when no entry names it
  at all.
- Any `contractVersion` other than the one the writer emits today
  (`cogworks.submissions.v2`) is refused as incompatible: what a
  metric's role and direction mean cannot be trusted under a contract
  this reader cannot read.
- A refused report is recorded with its reasons and never compared.
- A dirty tree means the `sha` cannot pin the bytes that ran; the
  source identity is recorded but unusable for comparison.

Unknown provenance blocks comparison downstream. It never becomes
comparable through a guessed default.

## Identity axes

- **source** — repository full name, commit `sha`, `dirty` flag.
- **dataset** — benchmark id and version, the producing `command`
  (`test` smoke cases vs `run` practice set), recorded weights and
  capture receipts.
- **scorer** — contract, sdk and plugin versions.
- **metric** — per metric: key, unit, direction, role, precision and
  floor reference. Labels and help prose are not identity.

## Files

| file | role |
| --- | --- |
| `report_reader.py` | reads one saved report; refuses with named reasons |
| `reader_checks.py` | hashes the fixture matrix, records exact accepted/refused counts |
| `build.py` | builds the static comparison view from fixtures (milestone 2) |
| `verify.py` | independent cross-check of built evidence (milestone 2) |
| `tests/` | pytest suite |
| `fixtures/` | synthetic reports: accepted-with-unknowns and refused cases |
| `evidence/` | committed outputs (reader-checks now; view and replay receipts as milestones land) |

## Running

```
python -m pytest -q tools/run-comparison/tests
python tools/run-comparison/reader_checks.py \
  --fixtures tools/run-comparison/fixtures \
  --out tools/run-comparison/evidence/reader-checks.json
```

## Milestone record

1. Reader, identities, refusal rules; pytest over synthetic reports
   including incompatible contracts and missing provenance; committed
   `evidence/reader-checks.json` with per-file SHA-256 hashes and exact
   counts (6 accepted, 5 refused of 11 fixtures).
2. Static comparison view via `build.py --fixtures ... --out ...`,
   committed examples, independent verifier. (pending)
3. `build.py --replay`, browser keyboard/reduced-motion walk with
   1440x900 and 390x844 screenshots, axe and cold-load shift
   measurements. (pending)
