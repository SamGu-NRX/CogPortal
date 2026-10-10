# Week 1 instrument validity study — protocol

**Status:** frozen 2026-10-09 (see "Freeze" section). Study branch
`obv/products-audio-validity-20261009`, cut from `fix/device-link-recovery-20261004`.
**Instrument under test:** `benchmarks/week1` at the submodule pin of that branch,
`4e516f39ffbeefe579e093260b2865eb354c17a7` — `benchmark_version 1`,
`scorer_version identification-v1`, `dataset_version synth-v1`, shipped manifests
`week1-test-v1` / `week1-evaluation-v1`.

## Question

Week 1's recorded calibration (`examples/week1-audio-submission/CALIBRATION.md`,
measured 2026-08-17 against an earlier state of the same benchmark) found the
shipped grid did not separate fingerprint pipelines: clean and moderate-noise
cells saturated at 1.000 for every working pipeline, integer-semitone pitch
cells sat at chance for every pipeline, and tuned/detuned ordering was inside
seed noise. The current benchmark keeps that eight-cell grid, with the two
defects the calibration named since fixed in the scorer (trivial-baseline
centring, and the examples' percentile knob documented).

This study asks whether the instrument **as it now ships** distinguishes
useful improvements from their ablations, or whether what it measures is
mostly a property of its synthetic corpus — and what, if anything, the
published number means given the metadata a submission can reach.

The study is diagnostic staff tooling. It does **not** change the benchmark,
does not rebuild or ship manifests, does not touch any published or student
result, and does not activate any release. The official scorer identities
(`score_outputs`, `identification-v1`) run unmodified and their outputs are
reported as produced; every alternative aggregation in this study is labeled
diagnostic and none is a grading rule. In particular no interval width,
bootstrap or otherwise, is used as a pass/fail threshold anywhere; intervals
qualify comparisons and nothing else.

## Variants (frozen)

All fingerprint variants share the `reference_shazam` `Fingerprinter` family so
any two differ in exactly the fields named; the two new pipelines are defined
in `study_pipeline.py` and follow the same one-knob discipline.

| name | definition | role |
| --- | --- | --- |
| `tuned` | course parameters: 75th-pct floor, 15×15 neighborhood, fanout 15, offset vote | working reference |
| `fanout40` | `fanout=40` | useful improvement (cheap, students find it) |
| `nfft1024` | identical pipeline, spectrogram NFFT=1024/noverlap=512 | useful improvement (pitch-shift tolerance) |
| `chroma12` | pitch-class fingerprints, transposition search −2..+2 st (`study_pipeline.py`) | useful improvement (integer-semitone invariance) |
| `detuned` | percentile 30, fanout 3 | realistic weaker |
| `nbhd3` | neighborhood 3 | realistic weaker |
| `nbhd51` | neighborhood 51 | realistic weaker |
| `bag_of_hashes` | `offset_vote=False` | realistic weaker |
| `trivial` | mean log spectrum, cosine NN (separate pipeline on purpose) | floor |
| `sample_rate_bug` | enrolls at 16 kHz, queries at 44.1 kHz | known real bug (resampling) |
| `inert` | ignores audio, returns first enrolled id every query | control |
| `guess_uniform` | returns one uniformly random enrolled id per query, seeded per call | always-guess policy |
| `abstain_all` | returns `[]` every query | always-abstain policy |
| `abstain_margin` | tuned pipeline, abstains when top1/top2 vote margin < τ | sometimes-abstain policy |
| `metadata_oracle` | ignores audio; reads the shipped manifest inside the scorer's own process and replays gold by deterministic call order, skipping the driver's warm-up call | metadata audit demonstration |
| `call_order` | ignores audio, files, and packages; counts identify calls and answers `enrollment_order[k mod N]` (enrollment arrives sorted; warm-up skipped) | metadata audit demonstration (strongest channel) |

τ for `abstain_margin` was chosen on tuning manifests only (rule below) and
frozen before measurement. `chroma12` parameters (12 pitch classes, 55 Hz–8 kHz
fold, per-frame peak classes, pair keys, transposition search −2..+2) were
fixed on the test tier before measurement runs and are in code, not in
run-time knobs. No other parameter was selected by looking at measurement
results.

## Corpora and arms

1. **Official grid, shipped manifests.** `materialize_cases(load_manifest(tier))`
   for `test` and `evaluation`, run unmodified through the benchmark's own
   `run_cases` driver and scored by its own `score_outputs`. This is the
   official identity, preserved.
2. **Seed manifests (synthetic, evaluation geometry).** Three fresh master
   seeds built with the benchmark's own `build_manifest` (staff tool, never
   shipped): measurement seeds {801000007, 801000013, 801000031}; tuning seeds
   {800000019, 800000037} at test geometry plus the shipped test tier.
3. **Probe cells (synthetic, evaluation geometry, shipped seeds).** Additional
   QueryCase sets built with `synth.perturb` (and the study's clipping and
   resampling extensions, same order: clip → pitch → noise → clip-stage
   distortion/resample), applied to the same shipped corpus. Cells:
   time-shift (`time_early` offset 1.0 s, `time_late` offset end-of-song),
   clipping (`hardclip_025`, `softclip_025`), resampling roundtrips
   (`resample_16k`, `resample_48k`), fine pitch (+0.05, +0.10, +0.15, +0.25,
   +0.5). Diagnostic only; never the official number.
4. **Ambiguity arm (synthetic, evaluation manifest + constructed twins).**
   Two extra catalog entries `song-30`/`song-31` enroll audio identical to
   `song-00`/`song-01` (same seeds, distinct ids — permitted inputs). Shipped
   queries unchanged, gold unchanged. Measures how the instrument treats
   identical permitted inputs with different compatible answers. Diagnostic.
5. **Real-audio arm.** 10–15 openly reusable real recordings
   (`real_audio/`, PD/CC0/CC-BY/CC-BY-SA only; provenance in
   `real_audio/MANIFEST.json`). Catalog = enrolled tracks; 2 held-out tracks
   supply out-of-set queries. Same cell structure as arm 3 (no official-grid
   arithmetic — this arm has no manifest). If the set cannot be assembled or
   licensed, the arm stays **unmeasured**: it will be reported as not
   measured, never relabeled as synthetic evidence.

## Tuning / measurement split

Any choice made by looking at audio or scores — abstain threshold τ, chroma
parameters, ambiguity-detection thresholds, real-audio cell calibration — was
made on **tuning** manifests only (arm 2 tuning seeds + shipped test tier).
All headline tables come from **measurement** manifests only: shipped
evaluation tier, its three fresh seeds, and the real-audio arm. Tuning-run
predictions are retained under `results/tuning/` and excluded from headline
tables. The freeze commit (this file plus the runner at final settings) lands
in git history before measurement results are computed.

## Retention and hashing

Every run writes, under `results/<arm>/<manifest_id>/`:
- `predictions.jsonl.gz` — one line per query: variant, query_id, study cell,
  official cell, gold (staff side), candidates (≤16), scores, shape, seconds,
  outcome, error;
- `run.json` — variant config hash, manifest sha256, per-song audio sha256s,
  benchmark submodule commit, study runner file hashes, Python/numpy/scipy/
  matplotlib versions, wall times.

Rendered corpora are cached outside the repo keyed by manifest sha256;
every cache hit re-verifies the pinned hashes via `materialize_cases`.

## Uncertainty

Paired, two-level: queries nest in recording×cell, cells in manifest seed.
Headline comparisons are paired differences (variant − `tuned`) on identical
query sets. Resampling: draw manifest seeds with replacement, then within
each (seed, cell) stratum draw recordings with replacement; 10,000
replicates, bootstrap seed 20261009; 95% percentile intervals. Seed-level sd
is reported separately (4 seeds — wide, and stated to be). Real-audio arm:
same scheme over recordings only, with the small-n caveat stated. Single-cell
tables carry Wilson intervals. No interval is a grading threshold.

## Arithmetic independence

The official metrics come from the benchmark's own `score_outputs`. An
independent checker (`check_arithmetic.py`), implemented from the prediction
schema by a separate author who did not read the runner's scoring code,
recomputes identification_score, per-cell top-1, outcome counts, the trivial
baseline, sweep points, and the documented bootstrap from the retained
predictions, and must agree to 1e-9 on deterministic quantities (and exactly
on the bootstrap, same seed and recipe). Hand-computable fixtures pin the
definitions.

## Pre-registered expectations (written before measurement; not fitted)

From the calibration and the generator's structure: clean/noisy cells
saturate for every fingerprint pipeline; integer pitch cells sit at chance
for every exact-hash pipeline while `chroma12` (the only integer-shift-
invariant one) either saturates them or collapses specificity; `nbhd3`/
`nbhd51` are indistinguishable from `tuned` on the official grid despite
0.3–0.5 measured deficits on finer cells; `metadata_oracle` and `call_order`
approach 1.0 in-set on manifest-ordered arms (metadata channels, not audio
ability). If these hold, the instrument's published number is (a) unable to
see the improvements it exists to rank and (b) reachable without audio.
The study's contribution is quantifying all of that on the current pin,
adding the corpus and ambiguity measurements the calibration did not make,
and saying which improvements survive controls.

## Amendment 1 (pre-measurement)

Recorded before any measurement-tier run. Three changes, each made after the
test-tier shakedown but before the frozen measurement:

1. **`StudyQueryCase` now subclasses the benchmark's `QueryCase`.** The
   original study-only class was silently invisible to the driver's
   `isinstance(case, QueryCase)` gate — study rows would have produced no
   outputs at all. Found by code read (a unit check against the real driver
   reproduced it) before any study-arm run was spent. Study rows now travel
   the identical enroll/warm-up/query path as official rows; official runs
   never construct study rows, so official scoring is unchanged.
2. **`call_order` variant added.** The metadata audit (audit/AUDIT.md,
   channel 2) proved the identify-call index alone determines gold:
   `sorted(catalog)[k mod N]` scored 240/240 on the shipped evaluation
   manifest. Unlike `metadata_oracle`, it needs no file access, no package
   import, and no manifest — sandbox hardening cannot remove it. It runs on
   the official and seeds arms only (arms whose query order is the
   manifest's row order); probe, ambiguity, and real-audio arms reorder
   queries and drop it with a printed note.
3. **Reference environment.** CALIBRATION.md's reproduce commands run on
   Python 3.8.20 / numpy 1.24.4 / scipy 1.10.1 / matplotlib 3.7.5. The
   measurement environment is that stack (venv `3.8.20`), matching the
   pinned calibration. Shakedown runs that preceded this amendment used
   Python 3.13 and are labeled shakedown, not measurement.
