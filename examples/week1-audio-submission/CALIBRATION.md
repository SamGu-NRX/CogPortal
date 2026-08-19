# Week 1 instrument calibration

Measured 2026-08-17 against `benchmarks/week1` at commit `ce63667`, on
Python 3.8.20 / numpy 1.24.4 / scipy 1.10.1 / matplotlib 3.7.5.

Reproduce:

```
cd examples/week1-audio-submission
/tmp/w1py38/bin/python calibrate.py --tier test       --seeds 3 --json /tmp/w1_final_test.json
/tmp/w1py38/bin/python calibrate.py --tier evaluation --seeds 3 --json /tmp/w1_final_eval.json
/tmp/w1py38/bin/python probe_grid.py --tier evaluation --queries 3
```

| tier | manifest id | corpus | master seed | songs | unseen | queries |
| --- | --- | --- | --- | --- | --- | --- |
| test | `week1-test-v1` | `synth-v1` | 20260817 | 8 | 2 | 68 |
| evaluation | `week1-evaluation-v1` | `synth-v1` | 719241703 | 30 | 6 | 252 |

The `--seeds 3` runs rebuild each tier three more times with fresh master
seeds through the benchmark's own `build_manifest`, which is where the
run-to-run variance numbers come from.

## Headline

**The shipped grid does not grade.** On the evaluation tier every fingerprint
pipeline tried, including two deliberately crippled ones, scores
`identification_score` between 0.475 and 0.525, and seed-to-seed variance is
±0.013. Four of the eight cells saturate at exactly 1.000 for every pipeline;
the other four sit at chance for every pipeline. The primary metric is
therefore close to a constant plus noise, and the ordering the instrument is
supposed to produce (tuned above detuned) does not hold: detuned scores
*higher* than tuned on both tiers, by less than the noise.

Two other things this lane found, both actionable:

- `metrics.trivial_baseline_outcomes` has a centring bug that pins the
  reported floor to exactly chance. Details and the fix are below.
- The peak `percentile` knob never binds at the course's own neighborhood
  size, so `DetunedShazam` was not actually detuned in the way intended. Also
  measured below.

There is a grid that works. Measured numbers for it are in the
recommendation at the end.

---

## 1. Every metric, every variant

### Evaluation tier (30 songs, chance 0.033)

| metric | tuned | detuned | bag_of_hashes | trivial | sample_rate_bug |
| --- | --- | --- | --- | --- | --- |
| `identification_score` | 0.5208 | 0.5250 | 0.4750 | 0.2458 | 0.0292 |
| `clean_top1` | 1.0000 | 1.0000 | 1.0000 | 0.7667 | 0.0667 |
| `short_clip_top1` | 1.0000 | 1.0000 | 1.0000 | 0.6333 | 0.0667 |
| `noisy_top1` | 1.0000 | 1.0000 | 0.7333 | 0.0333 | 0.0000 |
| `pitch_top1` | 0.0417 | 0.0500 | 0.0250 | 0.1250 | 0.0000 |
| `retrieval_failure_rate` | 0.2750 | 0.2708 | 0.3167 | 0.3792 | 0.7333 |
| `ranking_failure_rate` | 0.1000 | 0.1292 | 0.1000 | 0.1208 | 0.1417 |
| `margin_separation` | 0.7946 | 0.7885 | 0.7240 | 0.4104 | 0.5214 |
| `chance_top1` | 0.0333 | 0.0333 | 0.0333 | 0.0333 | 0.0333 |
| `trivial_baseline_top1` | 0.0333 | 0.0333 | 0.0333 | 0.0333 | 0.0333 |
| `median_identify_seconds` | 0.0563 | 0.0265 | 0.0493 | 0.0057 | 0.0346 |

Per grid cell, top-1:

| grid cell | tuned | detuned | bag_of_hashes | trivial | sample_rate_bug |
| --- | --- | --- | --- | --- | --- |
| `clean_10s` | 1.000 | 1.000 | 1.000 | 0.767 | 0.067 |
| `clean_3s` | 1.000 | 1.000 | 1.000 | 0.633 | 0.067 |
| `snr_0` | 1.000 | 1.000 | 0.733 | 0.033 | 0.000 |
| `snr_10` | 1.000 | 1.000 | 0.967 | 0.033 | 0.100 |
| `pitch_-2` | 0.033 | 0.100 | 0.067 | 0.267 | 0.000 |
| `pitch_-1` | 0.033 | 0.033 | 0.033 | 0.133 | 0.000 |
| `pitch_+1` | 0.000 | 0.000 | 0.000 | 0.067 | 0.000 |
| `pitch_+2` | 0.100 | 0.067 | 0.000 | 0.033 | 0.000 |

### Test tier (8 songs, chance 0.125)

| metric | tuned | detuned | bag_of_hashes | trivial | sample_rate_bug |
| --- | --- | --- | --- | --- | --- |
| `identification_score` | 0.5312 | 0.5625 | 0.5312 | 0.3594 | 0.0781 |
| `clean_top1` | 1.0000 | 1.0000 | 1.0000 | 0.7500 | 0.0000 |
| `short_clip_top1` | 1.0000 | 1.0000 | 1.0000 | 0.3750 | 0.0000 |
| `noisy_top1` | 1.0000 | 1.0000 | 1.0000 | 0.1250 | 0.0000 |
| `pitch_top1` | 0.0625 | 0.1250 | 0.0625 | 0.3750 | 0.1250 |
| `retrieval_failure_rate` | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| `ranking_failure_rate` | 0.2031 | 0.1719 | 0.2344 | 0.1094 | 0.4219 |
| `margin_separation` | 0.8750 | 0.6680 | 0.7266 | 0.5156 | 0.3145 |
| `chance_top1` | 0.1250 | 0.1250 | 0.1250 | 0.1250 | 0.1250 |
| `trivial_baseline_top1` | 0.1562 | 0.1562 | 0.1562 | 0.1562 | 0.1562 |
| `median_identify_seconds` | 0.0171 | 0.0114 | 0.0157 | 0.0032 | 0.0140 |

---

## 2. Does tuned > detuned > trivial > chance hold?

**No.** The first inequality is reversed on both tiers, and the reversal is
inside the noise, which means the grid is not measuring the difference at all.

Evaluation tier, `identification_score`, mean over four manifest seeds:

| variant | shipped | seed 720241706 | seed 721241709 | seed 722241712 | mean | sd | range |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tuned` | 0.5208 | 0.5375 | 0.5250 | 0.5500 | 0.5333 | 0.0132 | 0.0292 |
| `detuned` | 0.5250 | 0.5458 | 0.5125 | 0.5167 | 0.5250 | 0.0148 | 0.0333 |
| `bag_of_hashes` | 0.4750 | 0.4667 | 0.4708 | 0.4750 | 0.4719 | 0.0040 | 0.0083 |
| `trivial` | 0.2458 | 0.2542 | 0.2542 | 0.2417 | 0.2490 | 0.0062 | 0.0125 |
| `sample_rate_bug` | 0.0292 | 0.0333 | 0.0250 | 0.0208 | 0.0271 | 0.0054 | 0.0125 |

Test tier:

| variant | shipped | seed 21260820 | seed 22260823 | seed 23260826 | mean | sd | range |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tuned` | 0.5312 | 0.6094 | 0.5156 | 0.5312 | 0.5469 | 0.0423 | 0.0938 |
| `detuned` | 0.5625 | 0.5781 | 0.5938 | 0.5625 | 0.5742 | 0.0150 | 0.0312 |
| `bag_of_hashes` | 0.5312 | 0.5625 | 0.5781 | 0.5469 | 0.5547 | 0.0202 | 0.0469 |
| `trivial` | 0.3594 | 0.4375 | 0.4219 | 0.4375 | 0.4141 | 0.0372 | 0.0781 |
| `sample_rate_bug` | 0.0781 | 0.1250 | 0.1250 | 0.0938 | 0.1055 | 0.0234 | 0.0469 |

Reading the gaps against the noise (evaluation tier, sd ≈ 0.013 to 0.015, so
call anything under about 0.04 indistinguishable):

- **tuned vs detuned: −0.008.** Reversed and far inside noise. No signal.
- **tuned vs bag_of_hashes: +0.061.** Real but small; about 4 sd. Note this is
  twice the 0.030 the audit measured, so the audit's "do not build a probe
  around this" verdict still stands, and offset discipline still is not what
  the primary is measuring.
- **tuned vs trivial: +0.284.** Real, but see the next section: on the test
  tier the same comparison is +0.133 against a variance of 0.042, which is
  only 3 sd, and a 3 sd gap between "a working Shazam pipeline" and "an
  averaged spectrum with no fingerprints" is not a grading instrument.
- **trivial vs chance: +0.216** (0.249 vs 0.033) on evaluation. The trivial
  baseline clears chance by a factor of 7.5, which is the point of shipping
  it: on this corpus "beats chance" is worth nothing.
- **sample_rate_bug: 0.027,** below chance, with 73% retrieval failure. This
  one works exactly as designed (section 5).

So the honest summary is: the grid separates *broken* from *working* and
nothing else. It cannot tell a good pipeline from a mediocre one.

---

## 3. Which cells separate, and which saturate

From the per-cell tables above, on the evaluation tier:

**Saturated at 1.000 for every fingerprint pipeline** (contribute a constant
0.5 to the primary and rank nobody): `clean_10s`, `clean_3s`, `snr_0`,
`snr_10`. The only variant these move on is `bag_of_hashes`, which drops to
0.733 on `snr_0` and 0.967 on `snr_10`, and `sample_rate_bug`, which is at 0.

**At chance for every pipeline** (contribute noise): `pitch_-2`, `pitch_-1`,
`pitch_+1`, `pitch_+2`, all between 0.000 and 0.100 where chance is 0.033.
Note the trivial baseline scores *higher* on three of the four pitch cells
(0.267, 0.133, 0.067) than the tuned fingerprint pipeline does. That is not an
anomaly: an averaged spectrum survives a small frequency shift, while an exact
`(f1, f2, dt)` key does not. Any grid that weights these cells rewards the
submission that did less work.

`probe_grid.py` swept much finer, three clips per song across 30 songs:

| cell | tuned | detuned | fanout1 | nbhd3 | nbhd51 | bag | spread |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `clip_10s` | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0.000 |
| `clip_3s` | 1.000 | 1.000 | 1.000 | 1.000 | 0.978 | 1.000 | 0.022 |
| `clip_1s` | 1.000 | 1.000 | 1.000 | 0.744 | 0.744 | 0.956 | 0.256 |
| `clip_0.5s` | 0.867 | 0.844 | 0.867 | 0.400 | 0.400 | 0.756 | 0.467 |
| `clip_0.25s` | 0.622 | 0.533 | 0.522 | 0.167 | 0.178 | 0.456 | 0.456 |
| `pitch_+0.05` | 1.000 | 1.000 | 1.000 | 1.000 | 0.389 | 0.656 | 0.611 |
| `pitch_+0.1` | 0.967 | 1.000 | 1.000 | 0.911 | 0.156 | 0.300 | 0.844 |
| `pitch_+0.15` | 0.567 | 0.867 | 0.867 | 0.356 | 0.067 | 0.122 | 0.800 |
| `pitch_+0.25` | 0.044 | 0.178 | 0.289 | 0.044 | 0.089 | 0.033 | 0.256 |
| `pitch_+0.5` | 0.022 | 0.011 | 0.011 | 0.000 | 0.033 | 0.033 | 0.033 |
| `pitch_+1` | 0.033 | 0.011 | 0.011 | 0.011 | 0.078 | 0.000 | 0.078 |
| `pitch_+2` | 0.044 | 0.067 | 0.089 | 0.089 | 0.111 | 0.078 | 0.067 |
| `snr_10` | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0.956 | 0.044 |
| `snr_0` | 1.000 | 1.000 | 1.000 | 1.000 | 0.956 | 0.667 | 0.333 |
| `snr_-5` | 1.000 | 1.000 | 1.000 | 1.000 | 0.878 | 0.622 | 0.378 |
| `snr_-10` | 1.000 | 1.000 | 1.000 | 1.000 | 0.611 | 0.489 | 0.511 |
| `snr_-15` | 0.900 | 0.922 | 0.867 | 0.978 | 0.333 | 0.356 | 0.644 |
| `snr_-20` | 0.422 | 0.567 | 0.489 | 0.722 | 0.067 | 0.167 | 0.656 |

The discriminating band is much more aggressive than the shipped grid on every
axis: clips at or below 1 second, pitch shifts of a **tenth to a quarter** of a
semitone, and SNR at −10 dB or below. Everything the shipped grid tests is
either side of that band.

---

## 4. Is the pitch axis doing the discriminating the audit predicted?

**At integer semitones, no.** The audit's `RECALL_STAGE1 = [0.10, 0.20, 0.10,
1.00, 0.20, 0.15, 0.20]` over shifts `[-4,-2,-1,0,1,2,4]` predicted a cliff,
and the cliff is real, but it is far steeper than the audit's grid could see.
By ±1 semitone every pipeline here is already at the bottom of it (0.000 to
0.100 against chance 0.033), so all four shipped pitch cells sit *below* the
cliff and measure nothing.

The arithmetic says why. At NFFT=4096 and 44.1 kHz the bin width is 10.77 Hz,
and a shift of `n` semitones moves a component at frequency `f` by
`f·(2^(n/12) − 1)/10.77` bins:

| shift | 200 Hz | 1000 Hz | 4000 Hz |
| --- | --- | --- | --- |
| 0.05 st | 0.05 bins | 0.27 bins | 1.07 bins |
| 0.10 st | 0.11 | 0.54 | 2.15 |
| 0.15 st | 0.16 | 0.81 | 3.23 |
| 0.25 st | 0.27 | 1.35 | 5.40 |
| 1.00 st | 1.10 | 5.52 | 22.09 |

A `(f1, f2, dt)` key is exact, so a peak needs to stay in its own bin. At one
full semitone a 4 kHz peak has moved 22 bins and nothing above a few hundred
Hz can match; the collapse is complete well before the audit's smallest step.
The measured cliff sits between 0.10 and 0.25 semitones, which is where
mid-band peaks cross one bin:

| shift | tuned | detuned | nbhd51 | bag |
| --- | --- | --- | --- | --- |
| 0.05 | 1.000 | 1.000 | 0.389 | 0.656 |
| 0.10 | 0.967 | 1.000 | 0.156 | 0.300 |
| 0.15 | 0.567 | 0.867 | 0.067 | 0.122 |
| 0.25 | 0.044 | 0.178 | 0.089 | 0.033 |

So the audit's finding is confirmed in substance and wrong in scale: **pitch is
the sharpest discriminator available, but only in a window roughly 0.05 to 0.2
semitones wide.** Outside it the axis is a coin flip.

One caution about weighting it: the cliff is so steep that a cell one step
inside it swings 0.4 in accuracy, which makes the score sensitive to the exact
shift chosen rather than to the submission. Use two or three shifts spanning
the window, not one.

---

## 5. What worked, and two defects found

### `sample_rate_bug` reproduces the real failure

Enrolling at 16 kHz and querying at 44.1 kHz produces exactly the measured
symptom. On the test tier, one clean query for `song-00`:

```
tuned 44.1k  keys  194035 entries   212145  ranked[:3]=[('song-00', 4735.0), ('song-06', 28.0), ('song-03', 22.0)]
db@16k       keys   79426 entries    83730  ranked[:3]=[('song-03', 18.0), ('song-06', 10.0), ('song-01', 9.0)]
```

Gold goes from 4735 votes and rank 1 to absent from the top 3, with a wrong
song returned confidently and nothing raised. On the evaluation tier the
variant lands at 0.029 (below chance) with `retrieval_failure_rate` 0.733, and
the benchmark prints the intended diagnostic. Keep this variant as a
regression test; it is the one thing in this lane that behaved exactly as
designed.

On the test tier its failures land as `ranking_failure` (0.422) rather than
`retrieval_failure` (0.000), because with only 8 songs a handful of accidental
key collisions is enough to keep gold in a 16-deep candidate list. The
benchmark's diagnostic already anticipates this and names both causes; worth
knowing that the tier changes which sentence a student sees.

### Defect A: the trivial baseline is pinned to chance by a centring bug

`metrics.trivial_baseline_outcomes`, `benchmarks/week1/audio_identification_benchmark/metrics.py:159-175`:

```python
reference = np.stack([mean_log_spectrum(catalog[song_id]) for song_id in ids])
reference = reference - reference.mean(axis=0, keepdims=True)   # per-bin mean, a 2049-vector
...
vector = mean_log_spectrum(case.samples)
vector = vector - vector.mean()                                  # scalar mean, one number
```

The reference matrix is centred by the catalog's per-bin mean spectrum; each
query is centred by its own scalar mean. The two live in different spaces, so
the cosine picks whichever catalog song has the largest residual rather than
the nearest one. Measured on the evaluation tier: it returns `song-00` for all
240 in-set queries and reports `trivial_baseline_top1` = 0.0333, which is
exactly 1/30 and therefore looks like a plausible "the floor is at chance"
result rather than a bug.

Centring both sides by the same catalog per-bin mean, same features, same
corpus:

```
scorer: query minus its own scalar mean       -> overall 0.0333  clean_10s 0.033
corrected: query minus catalog per-bin mean   -> overall 0.2417  clean_10s 0.733
```

This matters beyond a wrong column. The diagnostic "The score is at or below
the trivial baseline" fires against 0.033 today, so it fires only for
submissions below chance. Fixed, the floor on the evaluation tier is 0.246,
and the diagnostic would correctly fire for a submission scoring 0.20 that
currently reads as a pass. It also brings the reported number close to the
audit's 0.222 grid figure, which is a second sign the corrected value is the
intended one.

`reference_shazam/trivial.py` does *not* replicate the bug (it centres both
sides by the catalog mean), which is why the `trivial` variant scores 0.246
while the `trivial_baseline_top1` column beside it still reads 0.033. The two
numbers in the tables above disagreeing is the bug being visible, not a
transcription error.

### Defect B: the peak `percentile` knob does not bind

`DetunedShazam` was specified as percentile 30 and fanout 3, but percentile 30
and percentile 75 select the identical peak set. With a 15x15 maximum filter,
a surviving local maximum is already louder than the 75th percentile of the
whole spectrogram, so the amplitude floor removes nothing. Measured per song
on the test tier:

```
song-00  total  1540  above75  1540  above30  1540  minLM  -7.960  thr75  -9.076
song-01  total  1565  above75  1565  above30  1565  minLM  -8.324  thr75  -9.404
song-02  total  1900  above75  1892  above30  1900  minLM  -9.705  thr75  -9.166
song-03  total  1827  above75  1825  above30  1827  minLM -11.315  thr75  -8.680
song-04  total  1870  above75  1869  above30  1870  minLM -10.482  thr75  -9.933
song-05  total  1651  above75  1651  above30  1651  minLM  -8.318  thr75  -9.066
song-06  total  2281  above75  2271  above30  2281  minLM -11.916  thr75  -8.711
song-07  total  1594  above75  1594  above30  1594  minLM  -8.366  thr75  -9.167
```

The floor drops at most 10 of 2281 peaks. So `detuned` differs from `tuned`
only in fanout, 4614 hashes per song against 22980, and a smaller fanout turns
out not to hurt: the primary is flat across fanout 1, 3, and 15.

A sweep over the parameters that *do* change the peak set, on the test tier:

| params | overall | clean6 | clean2 | snr0 | pitch (4 cells) |
| --- | --- | --- | --- | --- | --- |
| nbhd15 pct75 fan15 (tuned) | 0.5312 | 1.000 | 1.000 | 1.000 | 0.062 |
| nbhd15 pct30 fan3 (detuned) | 0.5625 | 1.000 | 1.000 | 1.000 | 0.125 |
| nbhd15 pct75 fan3 | 0.5625 | 1.000 | 1.000 | 1.000 | 0.125 |
| nbhd15 pct30 fan15 | 0.5469 | 1.000 | 1.000 | 1.000 | 0.094 |
| nbhd15 pct99 fan15 | 0.5625 | 1.000 | 1.000 | 1.000 | 0.125 |
| nbhd3 pct75 fan15 | 0.5156 | 1.000 | 1.000 | 1.000 | 0.031 |
| nbhd3 pct30 fan3 | 0.5156 | 1.000 | 1.000 | 1.000 | 0.031 |
| nbhd51 pct75 fan15 | 0.5781 | 1.000 | 1.000 | 0.875 | 0.188 |
| nbhd15 pct75 fan1 | 0.5469 | 1.000 | 1.000 | 1.000 | 0.094 |

Nine settings, spanning a 17x change in neighborhood area and a 15x change in
fanout, all land in 0.5156 to 0.5781 against a test-tier variance of 0.042.
Even `nbhd3`, which is a genuinely bad peak-picker (0.744 at a 1-second clip
where tuned is 1.000, and 0.400 at half a second where tuned is 0.867), is
indistinguishable from tuned on the shipped grid. That is the clearest single
statement of the problem: **the shipped grid cannot see a defect that the
finer probe measures at 0.4 to 0.5 accuracy.**

To make the intended tuned/detuned contrast real, detuning has to change the
peak *neighborhood* (`nbhd3` or `nbhd51`), not the amplitude percentile.

---

## 6. Recommendation: what `identification_score` should be computed over

Nine cells, three per axis, all inside the measured discriminating band. Every
number below is measured, two clips per song over all 30 evaluation songs,
same corpus and same `synth.perturb` the benchmark already uses:

| cell | tuned | detuned | nbhd3 | nbhd51 | bag | trivial |
| --- | --- | --- | --- | --- | --- | --- |
| `clip_1s` | 1.000 | 1.000 | 0.683 | 0.667 | 0.983 | 0.283 |
| `clip_0.5s` | 0.883 | 0.883 | 0.400 | 0.417 | 0.717 | 0.183 |
| `clip_0.25s` | 0.567 | 0.433 | 0.283 | 0.300 | 0.533 | 0.133 |
| `pitch_0.10` | 1.000 | 1.000 | 0.917 | 0.033 | 0.267 | 0.567 |
| `pitch_0.15` | 0.633 | 0.850 | 0.383 | 0.117 | 0.133 | 0.567 |
| `pitch_0.25` | 0.033 | 0.167 | 0.017 | 0.033 | 0.033 | 0.517 |
| `snr_-10` | 0.983 | 0.983 | 1.000 | 0.650 | 0.467 | 0.033 |
| `snr_-15` | 0.950 | 0.933 | 0.967 | 0.333 | 0.400 | 0.033 |
| `snr_-20` | 0.383 | 0.533 | 0.567 | 0.083 | 0.233 | 0.033 |
| **primary over these 9 cells** | **0.715** | **0.754** | **0.580** | **0.293** | **0.419** | **0.261** |

Compared against the shipped grid on the same submissions:

| variant | shipped grid | proposed grid | change |
| --- | --- | --- | --- |
| tuned | 0.521 | 0.715 | +0.194 |
| detuned (fanout only) | 0.525 | 0.754 | +0.229 |
| nbhd3 (bad peak-picker) | not run | 0.580 | separates by 0.135 |
| nbhd51 (bad peak-picker) | not run | 0.293 | separates by 0.422 |
| bag_of_hashes | 0.475 | 0.419 | separates by 0.296 |
| trivial | 0.246 | 0.261 | separates by 0.454 |

The proposed grid separates a working pipeline from a crude one by 0.135 to
0.454, all far outside the 0.013 seed noise, where the shipped grid separated
them by 0.05 or less. Specifically:

- **Drop `clean_10s`, `clean_3s`, `snr_0`, `snr_10`.** All four are 1.000 for
  every fingerprint pipeline measured. Keep one long clean cell as a
  *gate*, reported next to the score and not inside it, so a submission at 0
  there gets the "your hash spaces do not overlap" diagnostic rather than a
  low number.
- **Drop the four integer pitch cells.** They are at chance for every
  pipeline, and the trivial baseline beats the tuned pipeline on three of
  them, so they actively invert the ranking.
- **Clip length: 1 s, 0.5 s, 0.25 s.** Spread 0.256 to 0.467 between good and
  bad peak-pickers, and monotone in difficulty, which is what a student can
  reason about.
- **Pitch: 0.10, 0.15, 0.25 semitones.** The steepest axis available, spread up
  to 0.844. Three points on purpose: the cliff is sharp enough that one point
  would measure the shift, not the submission.
- **SNR: −10, −15, −20 dB.** The audit was right that noise at 0 dB and above
  saturates; the discrimination is 10 to 20 dB lower than anyone swept. Spread
  0.511 to 0.656 there.

Two open items this recommendation does not settle:

- Even in the proposed grid, `tuned` and `detuned` are still within noise
  (0.715 vs 0.754), because the detuning is only a fanout change and the
  measurements above show fanout does not matter. Rebuild `DetunedShazam`
  around `neighborhood=3` or `neighborhood=51`, both of which separate
  cleanly, and re-run before treating the tuned/detuned ordering as verified.
- The proposed cells were measured with the reference pipelines here only. Two
  or three real student repositories from the audit should be run against the
  same nine cells before the grid is locked, since these are synthetic
  pipelines agreeing with each other.

Whatever grid is adopted, changing it is a new `benchmark_version`, not an
edit to version 1.

---

## What each variant is

| variant | what it is |
| --- | --- |
| `tuned` | mlab specgram NFFT=4096/noverlap=2048, 15x15 max filter, 75th-percentile floor, fanout 15, offset-histogram vote |
| `detuned` | identical code, percentile 30 and fanout 3 (see Defect B: the percentile half of this does nothing) |
| `bag_of_hashes` | identical fingerprints, vote counts shared hashes and ignores offsets |
| `trivial` | no peaks, no hashes, no time: mean log-magnitude spectrum per song, cosine nearest neighbour |
| `sample_rate_bug` | tuned, but enrolls at 16 kHz and queries at 44.1 kHz |

All five share one `Fingerprinter` plus one `Params` (except `trivial`, which
is a different pipeline by design), so an ablation differs from tuned in
exactly the field named. Select with `COGWORKS_W1_VARIANT`; the default is
`tuned`.

```
COGWORKS_W1_VARIANT=detuned /tmp/w1py38/bin/python calibrate.py --tier test --variants detuned
```
