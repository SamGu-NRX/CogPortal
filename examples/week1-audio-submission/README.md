# Week 1 reference and ablation submissions

Staff-only. These exist to calibrate the audio-identification benchmark: to
check that a good pipeline outscores a crude one, that both outscore a
baseline with no fingerprints at all, and that a known real bug lands in the
failure category that names it. Students never see this directory.

**Read [CALIBRATION.md](CALIBRATION.md) first.** The measurement found that
the shipped query grid does not separate a tuned pipeline from a detuned one,
and it recommends a grid that does. It also names two defects: a centring bug
that pins `trivial_baseline_top1` to exactly chance, and a peak-threshold knob
that never binds.

## The five variants

One `Fingerprinter` class plus one `Params` dataclass, so any two variants
differ in exactly the field named. `trivial` is a separate pipeline on purpose:
it is the floor, not an ablation.

| `COGWORKS_W1_VARIANT` | what it is |
| --- | --- |
| `tuned` (default) | course parameters: mlab specgram 4096/2048, 15x15 max filter, 75th-percentile floor, fanout 15, offset-histogram vote |
| `detuned` | identical code, percentile 30 and fanout 3 |
| `bag_of_hashes` | identical fingerprints, vote ignores time offsets |
| `trivial` | no peaks, no hashes, no time: mean log spectrum, cosine nearest neighbour |
| `sample_rate_bug` | tuned, but enrolls at 16 kHz and queries at 44.1 kHz |

`submission.py` at the root is the shape a student repository uses; `cogbench`
calls its `create_submission(resources)`, which reads the environment variable.

## Running it

```
cd examples/week1-audio-submission
/tmp/w1py38/bin/python calibrate.py --tier test --seeds 3
/tmp/w1py38/bin/python calibrate.py --tier evaluation --seeds 3 --json /tmp/eval.json
/tmp/w1py38/bin/python probe_grid.py --tier evaluation --queries 3
```

`calibrate.py` runs every variant against a tier and prints every metric, the
per-cell breakdown, the diagnostics, and (with `--seeds N`) run-to-run variance
across alternate manifest seeds. `probe_grid.py` bypasses the manifest grid and
sweeps perturbation cells that do not exist yet, which is how the
recommendation in CALIBRATION.md was measured.

Requires numpy, scipy, and matplotlib. These are our reference code, not the
scorer, so scipy is fine here; the benchmark package itself stays pure numpy.

## Layout

| file | what it does |
| --- | --- |
| `CALIBRATION.md` | the measurement, the findings, and the grid recommendation |
| `submission.py` | repository-root factory, selects a variant by environment |
| `reference_shazam/pipeline.py` | the one parameterized fingerprint pipeline |
| `reference_shazam/trivial.py` | the floor: mean log spectrum, cosine nearest neighbour |
| `reference_shazam/variants.py` | the five factories and the environment switch |
| `calibrate.py` | run every variant, print every metric, estimate seed variance |
| `probe_grid.py` | sweep candidate grid cells for discrimination |
