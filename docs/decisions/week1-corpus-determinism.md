# The Week 1 corpus must be bit-identical, and float64 was not enough

**Status:** implemented, verified on Modal 2026-08-17.

## The problem

The Week 1 benchmark generates its own audio rather than shipping a corpus:
the course sets no evaluation set (students record their own clips), real
music cannot be redistributed, and a corpus of sustained tones is degenerate
for a fingerprint matcher. So `synth.py` renders seeded synthetic music, and
the manifest pins a sha256 per song. The evaluation sandbox re-renders the
corpus from those seeds and verifies every hash before any student code runs,
which is what keeps ~240 MB of float32 audio out of the job payload.

That design makes cross-machine reproducibility load-bearing. If the laptop
render and the hosted render differ by one bit, every hash check fails.

They differed. The first hosted run of a real student repository failed with
`Rendered song-00 does not match`, from a manifest that verified locally.

## What actually differs

`apps/runner-modal/tools/diagnose_corpus.py` runs the same ladder of
primitives locally and inside the sandbox and prints them side by side. Local
was Python 3.11 / numpy 2.4 / macOS arm64; the sandbox is Python 3.8.20 /
numpy 1.24.4 / Linux x86-64.

| Operation | Same bits? |
|---|---|
| `Generator.standard_normal`, `.integers`, `.random` | yes |
| `cumsum`, `sum`, `mean`, `dot`, `outer`, `ldexp`, `rint`, `frexp` | yes |
| `np.sin`, `np.exp`, `np.power` | **no** |
| `np.convolve`, `np.interp` | **no** |
| `Generator.uniform` | **no** |

Three separate causes, and only the first is the famous one:

1. **libm.** IEEE-754 mandates exactly-rounded `+ - * /` and `sqrt`, and
   specifies nothing about transcendentals. Each platform's libm is free to
   differ in the last bits, and these do.
2. **Kernel dispatch.** `np.convolve` runs a correlate whose blocking and
   accumulation order depend on the numpy build; `np.interp` changed its
   internal slope formulation between 1.24 and 2.x.
3. **A library API that is not a spec.** `Generator.uniform` returns different
   doubles from the same seed on the two versions, while `random()` from the
   same generator returns identical bits. The bit stream is stable; the
   scaling on top of it is not.

`synth.py` had claimed float64 was sufficient for determinism. Float64 fixes
how each operation rounds; it does not fix *which* operation runs, and only
the second question matters here. The comment was wrong in a way that reads as
correct, which is why it survived.

## The fix

`audio_identification_benchmark/exactmath.py` supplies `sin`, `cos`, `exp`,
`exp2`, `log`, `log2`, `power`, `power2`, `box_average`, `interp`, and
`uniform`, built only from multiply, add, subtract, `rint`, `ldexp`, and
`frexp` — every one exactly specified by IEEE-754. `synth.py` and
`datasets.py` call these instead of numpy at all fifteen sites.

The transcendentals use Cody-Waite argument reduction into a small interval
and then a Taylor series with reciprocal-factorial coefficients. Plain Taylor,
not minimax: on the reduced ranges the truncation error is already below
float64 rounding, so a fitted polynomial would buy nothing and would replace
auditable constants with a table nobody can check by hand.

These are *less* accurate than libm, by about an ulp. That is the right trade.
The corpus is defined as whatever this renderer emits; there is no external
signal a better sine would be closer to. What it must be is the same
everywhere, which libm is not. Measured against numpy over the ranges the
renderer uses: sin within 1.2e-15 absolute, exp and log within 2.5e-16
relative, `box_average` and `interp` within 5.1e-15 — nine orders of magnitude
below the float32 cast the corpus ends in, and further below the log-magnitude
spectrogram a fingerprinter actually sees.

## Verification

`diagnose_corpus.py` after the fix, same two machines:

    render_song-00   d6d64e7fed47cf82   d6d64e7fed47cf82
    sum_song-00      7718.328736200871  7718.328736200871

and the full hosted run of `KrazeeCoder/week1-capstone-team4` prepares,
evaluates, and scores: `identification_score 0.5375` over 282 cases.

`tests/test_exactmath.py` covers the layer beneath: accuracy bounds against
numpy, exact results on exact inputs (`exp2(3) == 8.0`, `log2(1024) == 10.0`,
MIDI 69 is exactly 440 Hz), and shape-independence — batched results must
equal scalar results bit for bit, since kernel dispatch on array length and
alignment is the mechanism that makes libm vary in the first place.

## What this does not cover

`log_magnitude_spectrum` in `synth.py` still calls `np.log`, and the FFT
underneath it is not bit-reproducible across builds either. That is fine and
deliberate: nothing on that path is hashed. It feeds corpus statistics and the
trivial baseline, where a last-bit difference changes no decision. Only the
rendered audio is pinned, so only the rendering path needs this treatment.

If a future change adds a hashed artifact computed through an FFT, that
artifact needs its own answer; this module is not it.
