# Protocol — diagnostic causality

## Question

Does a `cogbench` diagnostic point to the defect that caused it — or merely
contain a plausible keyword? The subject is the pinned `python/cogbench` CLI
(cogworks 0.2.0) with the pinned week1 benchmark; the measurement treats the
CLI as an instrument and never repairs it.

## Design

1. **Freeze a correct miniature adapter** (numpy-only, four small stages) that
   the real benchmark scores at 0.671875 identification on the `test` tier.
2. **Inject single defects**, one per cause class, each a one-line textual
   patch of the control (the defect/repair key records every patch).
3. **Measure blind.** Each variant is materialized into a plain project
   directory; the real CLI runs `check`, `test`, `run`, and `report` against
   it in a subprocess with `PYTHONHASHSEED=0`. The diagnose step (a rule
   table authored from pre-study probes) reads only the words the instrument
   printed — never the key.
4. **Oracle.** A diagnosis is correct only when applying its claimed repair
   restores the control outcome: an identical metrics dict and an identical
   `Outcome split` line on the test tier. Multi-defect variants repeat the
   diagnose/repair loop (max 3 rounds).
5. **Wrong-repair probe.** The name_error repair (a numpy import) applied to
   the fp_time_sign variant must NOT restore the control outcome.
6. **Replay.** `run.py --replay results` recomputes every derived artifact
   (bundle texts, diagnoses, counts, tables) from the committed raw captures
   and asserts byte agreement.

## Blindness

`materialize.py` reads `key.json` only to build fixture directories before
any measurement; `grade.py` reads it only after every diagnosis and oracle
verdict is persisted. `measure.py`, `diagnose.py`, and `oracle.py` never
reference the key, and a pytest audit hook aborts if a measurement opens it.
The subject (cogbench) sees only materialized project directories.

## Cause classes (single-defect arm)

| variant | cause class | true site |
|---|---|---|
| name_error | name_error | deleted numpy import |
| signature | signature | identify drops sample_rate |
| wrong_order | ranking_direction | ascending sort |
| empty_result | empty_result | unconditional `return []` |
| fp_time_sign | fingerprint_space | delta sign flip |
| fp_swap | fingerprint_space | swapped fingerprint pair |
| shape_pairs | shape_pairs | ids returned without scores |

Multi-defect arm: `multi_name_order`, `multi_signature_swap`, `multi_empty_sign`.

## Tracks

Measured: `audio-identification` (week1 @ 4e516f39, synth corpora generated
locally, no download). Explicitly unmeasured (missing-data/weights tracks):
`vision-recognition` and `vision-clustering` (week2 @ a3dd948: [data] extra,
dataset and recognition-model weights not fetched; python <3.13 pin) and
`language-search` (week3 @ 4b175543: python <3.13 pin; GloVe data extra not
fetched). Counts: 1 measured, 3 unavailable.

## Deviations from the pinned environment

- week1 pins `numpy>=1.24,<2`; the only host interpreter is CPython 3.13.14,
  which has no numpy<2 wheel. numpy 2.5.3 was installed with `--no-deps` and
  the driver/scorer verified end to end (the week1 audio-validity study on
  this machine ran the same pinned checkout against sandbox numpy 2.x).
- The CLI's check report notes 6 graded-run packages missing locally
  (IPython, librosa, llvmlite, numba, scipy, soundfile). The miniature
  adapters are numpy-only, so no fixture reads a skipped module; the note is
  captured verbatim in every raw bundle.

## Rules of the run

- The CLI, runner, and benchmark are never repaired or edited while measured;
  the study only adds files under `experiments/diagnostic-causality/`.
- Every number in `results/` is recomputable: `run.py --replay results`.
- No live or paid service is called: corpora are generated locally.
