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

## Replay gate

`build.py --replay` is a validate-before-write gate. It derives the view,
the receipt and the replay receipt fresh from the fixtures, and only when
the artifacts already in the output directory match that derivation —
byte for byte for the view, field for field for the receipts — does it
rewrite them. On any disagreement it prints `replay disagreement: ...`
lines, exits nonzero, and changes nothing: evidence that disagrees with
the generator is preserved, never overwritten. `--force` is the single
deliberate path around the gate, for regenerating evidence after a
fixture or tool change.

Every receipt binds the artifacts to their provenance: the SHA-256 of
every fixture input, the SHA-256 of the generator sources (`build.py`,
`report_reader.py`), and — in the replay receipt — the digests of the
exact view and receipt bytes it attests. Tools or inputs change and the
committed evidence stops verifying: staleness is detectable, never
silent. `verify.py` checks the committed evidence exactly as it checks a
fresh build, replay record included; a tampered or mismatched evidence
file fails with a `misrendered:` line.

## Files

| file | role |
| --- | --- |
| `report_reader.py` | reads one saved report; refuses with named reasons |
| `reader_checks.py` | hashes the fixture matrix, records exact accepted/refused counts |
| `build.py` | builds the static comparison view from fixtures (milestone 2) |
| `verify.py` | independent cross-check of built evidence (milestone 2) |
| `tests/` | pytest suite |
| `fixtures/` | synthetic reports: accepted-with-unknowns and refused cases |
| `evidence/` | committed outputs: reader-checks, the example view with its receipt and replay record, browser walk evidence |
| `fixtures-stress/` | the M3 stress corpus: schema variants, stale/missing fields and refusal outcomes (synthetic only) |
| `evidence-stress/` | committed stress evidence: its own view, receipt, replay record and reader-checks record |

## Running

```
python -m pytest -q tools/run-comparison/tests
python tools/run-comparison/reader_checks.py \
  --fixtures tools/run-comparison/fixtures \
  --out tools/run-comparison/evidence/reader-checks.json
# replay gate: validates the committed evidence against a fresh build
# before writing anything; refuses and preserves it on any disagreement
python tools/run-comparison/build.py \
  --fixtures tools/run-comparison/fixtures \
  --out tools/run-comparison/evidence --replay
python tools/run-comparison/verify.py \
  --fixtures tools/run-comparison/fixtures \
  --out tools/run-comparison/evidence

# the stress corpus builds and verifies against its own evidence
# directory the same way (the compared pair is always the first two
# accepted reports in sorted order across all --fixtures roots, so the
# canonical and stress roots are never mixed in one committed build)
python tools/run-comparison/build.py \
  --fixtures tools/run-comparison/fixtures-stress \
  --out tools/run-comparison/evidence-stress --replay
python tools/run-comparison/verify.py \
  --fixtures tools/run-comparison/fixtures-stress \
  --out tools/run-comparison/evidence-stress

# only to regenerate evidence after a deliberate fixture or tool change
python tools/run-comparison/build.py \
  --fixtures tools/run-comparison/fixtures \
  --out tools/run-comparison/evidence --replay --force
```

## Milestone record

1. Reader, identities, refusal rules; pytest over synthetic reports
   including incompatible contracts and missing provenance; committed
   `evidence/reader-checks.json` with per-file SHA-256 hashes and exact
   counts (6 accepted, 5 refused of 11 fixtures).
2. Static comparison view via `build.py --fixtures ... --out ...`,
   committed examples, independent verifier. Done: the committed view,
   receipt and byte-identical replay record regenerate from the
   fixtures, and `verify.py` re-derives dispositions, values, deltas
   and the HTML from raw JSON (a tampered receipt fails it).
3. `--replay` plus a browser walk. Done: the view has zero focusable
   elements and zero CSS animations (nothing to keyboard-operate, no
   motion to reduce); the inherited records describe an axe-core run
   (zero WCAG 2.x A/AA violations, 10 passes) from the original
   writer's environment — not re-run here; the m3 browser notes record
   why (no vendored axe build, offline rule); cold-load layout shift
   is 0.000 (no entries);
   1440x900 and 390x844 screenshots plus the reduced-motion capture
   are committed under `evidence/browser/` with the measurement record
   `m3-browser-evidence.json`.
4. Replay gate and immutable evidence. Done: `build.py --replay`
   validates the existing evidence against a fresh derivation before
   writing anything and preserves disagreeing evidence (`--force` is the
   deliberate regeneration path); the replay receipt binds the view and
   receipt bytes to the fixture digests and generator sources;
   `verify.py` requires and checks the replay receipt, so tampered or
   stale evidence fails with a `misrendered:` line; scoped failure-path
   tests cover replay mismatch, evidence tampering and preservation.
5. Stress corpus and measured refusals. Done: an 18-file synthetic
   stress corpus under `fixtures-stress/` (both supported commands,
   weight receipts, version drift, unknown extra fields, dirty sources
   and 13 named refusal outcomes), committed evidence under
   `evidence-stress/` that builds, replays byte-identically and
   verifies green, and scoped pins in `tests/test_stress_corpus.py`.
   Measured: canonical 11 fixtures — 6 accepted, 5 refused; stress 18 —
   5 accepted, 13 refused; full corpus 29 — 11 accepted, 18 refused.
   No comparability thresholds are invented anywhere.
