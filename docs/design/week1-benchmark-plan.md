# Making one capstone week actually run

Supersedes `08-16-audit.md`, which was written before the repository audit and
gets two things wrong: it counts seven student repos (there are thirteen across
five groups) and it says none has a `requirements.txt` (KrazeeCoder's week 1 repo
has one, pinned). Both errors mattered, which is why the audit ran.

## Context

Nothing executes today. `EXECUTION_PROVIDER` is `"fixture"` in both wrangler
environments, so every score a student would see is simulated. The Modal runner
is written and tested and has never been switched on.

Thirteen real student repositories were read end to end, along with the course's
own capstone pages (now captured verbatim under `docs/capstones/`) and nineteen
days of instructor transcripts. Three findings changed the design. Each was
verified by execution, not by reading.

**1. The runner's Python is not the course's Python.** The week 2 image carries
numpy, Pillow, torch, torchvision, facenet-pytorch, opencv, platformdirs,
datasets (`modal_app.py:59-68`). The week 3 student venv carries numpy, gensim,
platformdirs (`modal_app.py:108`). The course tells students to install
`mygrad mynn noggin gensim cogworks-data` for week 3 and
`scikit-image scikit-learn matplotlib` for week 2
(`docs/capstones/environment.md:168,244`). Ten of seventeen week 2 modules fail
at import under the real image closure; `skimage`, `matplotlib`, `mygrad`, and
`mynn` are the usual cause. Three of four week 3 repos build their image
embedder on mygrad/mynn, and `adapt_search` raises without `embed_images`, so
those repos score nothing.

This is worse than a missing package. A dependency failure today surfaces in
`_prepare` as `dependency_install` in phase `installing`, which is excluded from
`CONSUMING_FAILURES` and is retryable at no cost. Move student imports past the
snapshot and the same failure lands inside evaluate as `student_runtime`, which
consumes one of three official attempts and shows "Submission stopped during
evaluation". We would be spending a student's attempt on our own packaging gap
and telling them it was their code.

**2. Clean-clip accuracy measures nothing in week 1, and the students proved
it.** Two teams built their own evaluation harnesses and independently reached
the same conclusion from opposite directions. carti4ce swept 1,275 committed
trials across 35 songs, three clip lengths, five SNRs, and five real noise types:
overall accuracy 0.996, and 0.97 at the worst SNR. Noise is saturated.
KrazeeCoder swept pitch shift and found clean recall of 97-100% collapsing to
10-25% at one or two semitones, with their own summary line: "Pitch shift breaks
ranking, not retrieval." Their three-way outcome split (`top_k`,
`ranking_failure`, `retrieval_failure`) is the diagnostic the run page should
adopt wholesale, and it costs nothing because their query already returns every
candidate with at least one hash hit.

**3. Two probe designs that sounded good do not work, measured.** The Fable
instrument brief proposed a permuted-twin probe to catch a matcher that sums
votes without aligning offsets, with an acceptance gate asserting a 0.5 gap.
Two independent reviewers built it against real student fingerprint code and
swept it. The maximum gap at any block size is 0.18, and at one setting the
bag-of-hashes ablation *beats* the correct matcher. The cause is structural:
these hashes are `(f1, f2, dt)`, already a local-ordering feature, so permuting
notes changes the hash multiset rather than only the order. Ablating offsets
entirely moves the primary metric by 0.030, inside noise. The probe and its
`offset_discipline` metric are cut; "not measured" is the honest state.

## Focus: week 1

The owner chose one week done properly over three scaffolded. Week 1 is the
right one despite being the only week with nothing built, because the audit says
so: it has the only discriminating axis anyone has measured, the two best
student evaluation harnesses to calibrate against, and the smallest dependency
surface (numpy, scipy, matplotlib, numba, librosa) versus week 2's torch and
FaceNet weights or week 3's GloVe and COCO artifacts.

Two open questions belong to the owner and are stated here rather than assumed.
Reynaldo said "nah, we couldn't get that to happen" about week 1 on 07-10, and
the course sets no fixed evaluation target for it: students record their own
clips and choose their own database size. Building this means inventing a
reference corpus the course never specified. And nothing in the assignment asks
students to handle pitch shift; KrazeeCoder chose that themselves. Scoring on
pitch means scoring the frontier rather than the assignment.

## The design

### Discovery: one file, loaded by path

The adapter is `submission.py` at the repo root, loaded with
`importlib.util.spec_from_file_location` inside the network-blocked evaluate
sandbox, with the repo root on `sys.path` and the working directory set to a
fresh per-run scratch directory.

The mapping between a student repo and a contract is almost never a rename. It
is a small transformation: `identify_clip` returns a 3-tuple needing `[0]`;
`recognize` returns the literal string `'Unknown'` where `None` is meant;
`find_match` and `identify_face` swap argument order inside one repo;
`whispers(images, iterations=10)` silently reads a positional seed as an
iteration count and returns N singleton clusters with no error. A manifest
cannot express "take element 0" without becoming a small language. Python
already is that language, and it is the only one every student here reads.

Entry points go away for submissions and stay for benchmarks, which we ship. The
mechanism solves multi-distribution name collision, which does not exist here:
one repo, one adapter, one run, and we own `sys.path`. It has already cost a
Python 3.8 dual-metadata workaround (`plugins.py:18`). It is also a live trust
hole: `PREPARE_SCRIPT` runs `pip install -e` on student code inside the
network-enabled prepare sandbox, so a `setup.py` executes arbitrary code with
network access before `block_network=True` applies. File-path loading moves all
student code execution behind the network block and lets prepare run none.

For the thirteen historical repos, `cogworks adapt` generates the file offline
from the audit's alias ladder and the owner opens a PR whose body is the mapping
report. Ratification is merging. The generator never runs in the scoring path,
so a wrong guess cannot become a score.

### Dependencies: fix the image, keep a bounded escape hatch

Add to the week 2 image: `scikit-image`, `scikit-learn`, `matplotlib`,
`imageio`, `networkx` explicitly rather than via torch's transitive pull. Add to
the week 3 image and its 3.8.20 venv: `mygrad==2.2.0` (2.3.0 requires 3.9),
`mynn`, `noggin`, `cogworks-data`. Build a week 1 image at all: numpy, scipy,
matplotlib, numba, librosa, soundfile. The list is
`docs/capstones/environment.md` minus the interactive-only packages, and that
file should be the single source both the image and the validators read.

Keep a dependency gate in prepare, before the snapshot, running zero student
code: AST-walk `submission.py` and the repo modules it imports, resolve each
top-level import against `importlib.util.find_spec`, and on a miss raise the
existing non-consuming `dependency_install` failure naming the module, file, and
line. This preserves today's zero-attempt-cost categorization and produces the
message that makes CoggurtFilter a one-line fix: its `import skimage.io` at
`matching.py:3` is dead, used only inside a docstring, and deleting it makes
seven working functions reachable.

If a repo has a `requirements.txt`, install it in prepare under a budget with
failures downgraded to a warning, and record what was installed in the result.

### Python 3.8, with the mismatch reported

The course pins `python=3.8` in every `conda create` and CI runs 3.8. One repo
genuinely cannot import there: carti4ce's `match.py` uses PEP 585 generics and
raises `TypeError: 'type' object is not subscriptable` on 3.8.20, clean on 3.11.
The answer is a named diagnostic, not a second interpreter: an AST scan for
builtin generics turns that opaque TypeError into a sentence naming the line and
the `typing.List` fix they already use in `database.py`. Choosing 3.8 means
telling a team their working code does not run in the course environment, which
is true and useful.

### The instrument

Contract, registered as a new benchmark version rather than an edit to the
inactive `audio-recognition` row:

```
enroll(song_id: str, samples: np.ndarray, sample_rate: int) -> None
identify(samples: np.ndarray, sample_rate: int) -> list[tuple[str, float]]
```

Ranked candidates, best first, `[]` for no match. Bare id lists and a single
id-or-`None` are accepted at one normalizer, with the metrics they cannot
support reported as not measured rather than as zero.

Metrics, with the primary deferred until calibration:

- Per-query taxonomy adopted from KrazeeCoder verbatim: `top_k`,
  `ranking_failure`, `retrieval_failure`. This is the highest-leverage
  diagnostic in the design. Both silent wrong-answer paths the audit found (a
  16 kHz database queried at 44.1 kHz collapsing from 118 votes to 4; a
  `spectrogram_conversion` that takes a sample rate and never resamples) present
  as 100% retrieval failure, which the run page can name in one sentence.
- Accuracy across a clip-length by pitch-shift grid, since pitch is the axis
  that separates and noise is the axis that saturates.
- Score-margin separation on out-of-database queries, computed from the
  student's own relative margins, never a cross-repo threshold. Reported as a
  separate labeled column: most teams cannot abstain at all, and scoring them on
  it would penalize work they were never assigned.
- `chance_top1`, and a trivial-baseline floor. A whole-clip spectrum
  nearest-neighbour matcher with no peaks, fingerprints, or offsets scores 0.222
  on a synthetic grid and 0.700 on the clean 10s cell, against a 1/30 chance
  baseline of 0.033. "Beats chance" is not evidence a student built a Shazam
  pipeline; that number is the real floor.

Corpus: procedurally synthesized music from a seeded generator plus a manifest,
rendered identically on the laptop and on Modal and hash-verified before use,
with a small bed of CC-licensed recorded noise. Gold never enters the payload;
the controller re-attaches it, following `week3_payload.attach_gold`.

Two measured cautions on the corpus. Cross-song hash overlap is 3.6% mean on the
synthetic corpus and 1.5% on real student music, so top-1 over 30 songs
saturates for any working pipeline from 5s clean onward and does not stress
offset voting on any corpus. And the generator's determinism claim needs testing
rather than asserting: float32 `np.sin` differs from scalar libm in 10,239 of
65,536 elements, so the render must do its arithmetic in float64 and cast once
at the end, as an explicit commented constraint.

### Containment by construction

Single import surface, so import-time hazards belong to the student's own graph
and fail in their sandboxed process. Phase-scoped isolation, so a failed
enrollment marks one song rather than the run. One normalizer that every scoring
path reads. Fresh array copies per call, so in-place mutation cannot contaminate
later queries. A `chdir` into per-run scratch, so carti4ce's module-global
relative `db.pkl` lands somewhere private instead of two runs corrupting each
other. Enrollment exactly once and asserted, because re-enrolling doubles a
song's votes (measured: 118 to 236). `matplotlib.use("Agg")` before any student
import, stdin closed, and the existing head-and-tail output buffer with room
reserved for our own trailing summary.

## Verification

1. Every acceptance threshold gets measured before it is written. The Fable
   brief asserted ">0.9", "at least 0.25", "~0.5" for runs that do not exist,
   and one of those gates can never go green. Run the ablations, then write the
   numbers at the change site with the run behind them.
2. Required ablations: detuned parameters must score visibly below tuned; a
   sample-rate-mismatch ablation must produce ~100% retrieval failure and the
   hash-space diagnostic; the trivial spectrum baseline must be reported next to
   chance.
3. Local first, on real repos: score KrazeeCoder and carti4ce end to end on a
   laptop with a generated `submission.py` and no packaging added, and compare
   against their own committed CSVs. Their numbers are the calibration.
4. Then hosted: same manifest, same corpus hashes, same scorer version, and the
   metric values must agree with the local run.
5. Import-feasibility regression: import every discovery-relevant module from
   all thirteen repos under the real image closure and assert that a missing
   package produces a non-consuming, platform-owned failure naming the package.

## Build status, measured

The benchmark is built and runs. `benchmarks/week1/` is a working
`cogworks.benchmarks.v2` plugin (95 tests green on 3.8.20, ruff clean),
`python/cogbench/src/cogbench/apploader.py` loads `submission.py` by path, and
both scoreable student repos run end to end against real synthesized audio:

    KrazeeCoder/week1-capstone-team4   identification_score 0.5938
    carti4ce/week1_capstone            identification_score 0.6562

Both were scored through instructor-written adapters in `benchmarks/adapters/`,
and both runs carry a diagnostic naming what wiring we supplied.

**The catalog row ships `active = 0`, and that is the headline result.**
Calibration measured that the shipped 8-cell grid does not rank. Four cells
saturate at 1.000 for any fingerprint pipeline, four sit at chance, and the
spread across a 17x change in peak neighborhood and a 15x change in fanout is
inside seed noise. A peak-picker that is 4.7x worse at real retrieval (0.200 vs
0.933 top-1 on half-second clips) scores *higher* on the primary. The
instrument is sound; the stimulus set does not grade. A grid built from the
measured discriminating band (sub-second clips, sub-semitone pitch, negative
SNR) is `benchmark_version` 2, not an edit to version 1.

Four defects were found by adversarial review after the build and are fixed:

- The trivial baseline centred its two sides differently, collapsing onto one
  song and reporting exactly 1/N. That looked like a plausible "the floor is at
  chance" result, which is why it survived a calibration run. Corrected, the
  floor is 0.242 on the evaluation tier against chance 0.033, and the
  "at or below the trivial baseline" diagnostic can now fire.
- `metrics.py` asserted the baseline "was measured at 0.222 and 0.700". Those
  numbers came from a different corpus and implementation and never described
  this code. Replaced with the measured value.
- A student `sys.exit()` escaped the drivers and ended the run, because four
  handlers caught `Exception` rather than `BaseException`. The warm-up call was
  the worst of them: it runs before any case is scored. Now contained at every
  site, with a diagnostic naming the song or query.
- The ordering test's "degraded" comparator returned `[]` for every clip, so
  `tuned > degraded` reduced to `x > 0.0` and could not fail. Replaced, and the
  tuned-above-detuned claim is now explicitly *not* asserted, because the
  instrument cannot presently deliver it. Asserting it would only invite
  loosening the bound until it passed.

## Hosted: verified 2026-08-17

Week 1 now runs on Modal end to end, on a real student repository, with no
edit to that repository. `KrazeeCoder/week1-capstone-team4` fetches, prepares,
evaluates under Python 3.8.20, and scores `identification_score 0.5375` over
282 cases, carrying the provenance line that says our adapter supplied the
wiring. Reproduce with:

    python apps/runner-modal/tools/smoke_modal.py \
        --benchmark audio-identification --repo <owner>/<name>

Four things had to change before that was true. Each was invisible to the
local path and to every unit test.

**The corpus did not render the same on both machines.** `np.sin`, `np.exp`,
`np.power`, `np.convolve`, `np.interp`, and `Generator.uniform` all return
different bits under numpy 1.24 on Linux/x86 than under numpy 2.4 on
macOS/arm64, so every sha256 pin failed hosted while passing locally. The RNG
bit stream was identical throughout — the problem was never the seeds.
`exactmath.py` replaces all six with implementations built only from
IEEE-754-exact operations. Full measurement in
`docs/decisions/week1-corpus-determinism.md`.

**The hosted discovery path still required packaging.** `PREPARE_SCRIPT` did
`pip install -e` plus an entry-point lookup, which no audited repository can
satisfy; the local path had been fixed months earlier and the sandbox had not.
It now tries packaging first, then a root `submission.py`, and reports which
rung resolved. The file rung is also the safer one: `pip install -e` runs the
repository's own `setup.py` in the prepare sandbox, which still has network.

**Instructor adapters could not reach the sandbox.** Teams that finished
before the benchmark existed cannot have written an adapter, so the images
carry `benchmarks/adapters/` at `/opt/adapters` and prepare copies one in when
a repository has none of its own. A repository's own adapter always wins.

**A timeout was reported as a crash.** Modal enforces its budget with a kill,
which is indistinguishable from a crash by return code, so
`carti4ce/week1_capstone` — 999 s against a 900 s budget, because its database
rewrites a pickle per song and reloads it per query — was charged an official
attempt and told "Evaluation failed." Now detected by elapsed time and signal,
with a message naming the budget and the shape of database that cannot fit it.

Metrics also gained `metric_help`: one or two sentences per number, in the
course's vocabulary, naming which part of the capstone it corresponds to.
`tests/test_explainability.py` fails the build if a metric ships unexplained,
if an explanation uses our vocabulary instead of theirs, or if the pitch-shift
metric stops saying it is outside the assignment. The text reaches the run
page through the protocol, `run_metrics.help`, and a disclosure on each
supporting-metric row; the primary metric shows its explanation unfolded,
since that is the number a team will argue about.

### The same two repositories, both paths

Local, 8-song test tier, through the same instructor adapters:

    KrazeeCoder/week1-capstone-team4   0.5938   clean 1.000  pitch 0.188   2 s
    carti4ce/week1_capstone            0.6562   clean 1.000  pitch 0.312   7 s

Hosted, 30-song evaluation tier, both passing:

    KrazeeCoder/week1-capstone-team4   0.5375   clean 1.000  pitch 0.08    75 s
    carti4ce/week1_capstone            0.5292   clean 1.000  pitch 0.06   875 s

The ordering and the shape hold across both paths and both tiers: clean,
noisy, and short clips all saturate at 1.000 while pitch collapses, which is
the design the course teaches behaving exactly as it must. It is also the
evidence for the grid problem above — three of four scored axes do not
discriminate between these two submissions at all, and on the evaluation tier
the two land 0.008 apart, well inside seed noise. The instrument runs; it
still does not rank.

`carti4ce` clears the 900 s budget by 25 seconds, and that margin is a coin
flip rather than a pass: the same submission timed out at 999 s on the run
before. It is slow structurally — `database.add` reloads and rewrites the
whole pickle per song, `query_details` reloads it per query — so its cost
grows with the catalog, and its median identify is 3.03 s against
KrazeeCoder's 0.046 s. The budget is deliberately not being raised: one wide
enough for an O(N²) database no longer means anything. What changed is that
the failure is now legible when it happens.

The laptop timings that set that budget were badly optimistic — 381 s
predicted against 875 s measured, and 16 s against 75 s. `runner.ts` now
carries the hosted numbers, since those are the ones the budget is checked
against.

## Owner decisions still open

- Is week 1 in scope, given the course sets no evaluation target for it and
  Reynaldo declined it in July?
- Does the headline metric measure the assignment (clean accuracy, which
  saturates) or the frontier (pitch shift, which nobody was asked to handle)?
- When the platform supplies missing wiring, how does that appear on a public
  leaderboard? Asterisk's week 1 would need us to supply the database, the
  enroll loop, and the unwrap, then publish a number next to their name.
- Do we send the one-line fixes to teams whose repos are one edit from
  scoreable, and in whose voice? Several are genuinely tiny: define
  `DatabaseKey`, commit `camera.py`, return `valid_paths`, use `typing.List`.
