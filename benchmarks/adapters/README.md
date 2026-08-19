# Instructor-supplied adapters

A `submission.py` here is wiring **we** wrote for a student repository that
predates the benchmark. Each of these teams finished a working capstone before
there was anything to submit to, so none of them could have written an adapter.
These files exist so their code can be scored without anyone editing their
repository.

## How one gets used

The directory name is the repository's `owner/name` with the slash written as
`__`. The runner images carry this directory at `/opt/adapters`, and the
prepare step copies `<slug>/submission.py` into the checkout **only when the
repository has none of its own** (`modal_app.PREPARE_SCRIPT`). A team that
writes an adapter is always scored by theirs; ours can never shadow it.

The run records which happened: `resolved_by` is `instructor_adapter:<slug>`
rather than `file:submission.py`, and the driver surfaces `PROVENANCE` in the
run result, so a leaderboard row reads "scored through an instructor-supplied
adapter" and lists the wiring we added.

Nothing in this directory is a student's work, and nothing here is signal
processing. Every adapter calls the team's own spectrogram, peak picker,
fingerprinter, and matcher with the team's own default parameters, passes no
keyword arguments, and overrides no default. If a number changes, it is
because their code changed.

## Why the labeling matters

A leaderboard row is a claim about a team. If we supply the wiring and the
row does not say so, the row overstates what they built. So every adapter
carries a module-level `PROVENANCE` dict with four keys:

| key | what it holds |
| --- | --- |
| `source` | always `"instructor-supplied"` |
| `student_wrote` | the algorithm, module by module, with the parameters we called it with |
| `we_supplied` | every line of wiring we added, including each place we chose one of their functions over another |
| `not_used` | their code we deliberately did not run (file loaders, demos, saved databases) |

The `carti4ce` adapter adds `known_issues` for two things a reader should
know before trusting the number.

The driver reads `PROVENANCE` and emits a diagnostic naming everything under
`we_supplied`, which reaches the run page alongside the mapping log. A row
built from one of these should read as "scored by an instructor-supplied
adapter", never as the team's own submission.

## How one of these reaches a run

A directory here is named `<owner>__<name>`, matching the repository it
adapts. The three sandbox images carry this whole directory at
`/opt/adapters`, and the prepare step copies `<slug>/submission.py` into the
checkout when — and only when — the repository has none of its own.

The ordering matters and is enforced in `PREPARE_SCRIPT`: a repository's own
`submission.py` or `benchmark_adapter.py` always wins. An instructor adapter
that could shadow a student's would silently score our wiring instead of their
work, which is the one failure mode this directory must not have.

Adding an adapter therefore requires a redeploy
(`apps/runner-modal/tools/deploy.py`) before the sandbox can see it.

This is a bridge for work that predates the benchmark, not a substitute for
the template. A team that writes its own adapter needs nothing from here.

## The rule these adapters follow

Use the team's own function whenever one exists, and when two of their
functions could serve, take the one that gives the scorer more information
without changing rank 1.

Both repositories return only a winner from their top-level entry point, and
both compute a full ranked list one layer down. The adapters read the deeper
one. In both cases rank 1 is provably unchanged:

- `KrazeeCoder`'s `identify_clip` takes the argmax of `best_matches`, which
  is `ranked[:3]` divided by its own sum. Dividing by a positive constant
  does not move an argmax, so `ranked[0]` is the same song.
- `carti4ce`'s `query` takes `max(counts, key=counts.get)`, the song owning
  the single largest `(song, offset)` cell. Folding that Counter to each
  song's best offset bucket and sorting puts the same song first.

Everything below rank 1 feeds the outcome taxonomy (`top_k` versus
`ranking_failure` versus `retrieval_failure`) and the margin metric. It does
not enter `identification_score`, which is top-1 only.

## What each adapter is

### `KrazeeCoder__week1-capstone-team4/`

Their `final_checker.identify_clip(samples, sample_rate, database)` takes the
database as a third argument, so it cannot be bound as the contract's
two-argument `identify`. The adapter holds one `AudioDatabase` and calls
their four modules in the order `identify_clip` calls them, then reads
`query()["ranked"]` instead of the top-3 display percentages. Their own
docstring says `ranked` is there "for retrieval-vs-ranking evaluation
(recall@k for any k)", so this is the use they intended.

Results are returned as `(song_id, artist, score)` triples, the shape
`identify_clip` already returns, with the raw offset-aligned vote count as
the score. The shipped `data.pkl` is never opened; the database is built
fresh from the benchmark catalog on every run.

### `carti4ce__week1_capstone/`

`match.query` returns a bare song name, so the adapter calls `query_details`,
which hands back the same winner plus the full `(song_id, offset)` Counter.
`database.add` is given the benchmark's song id as both `song_ID` and
`song_name`, so the name table needs no inverting.

`database.DB_PATH` is the module-global relative string `"db.pkl"`, rewritten
on every add and reloaded on every query. The benchmark driver makes a
private scratch directory the working directory before the factory runs, so
that file lands in the run's own directory and two runs cannot corrupt each
other. The adapter does not override the path; it relies on the working
directory the driver established, which is what their code has always
assumed.

**This repository does not import on Python 3.8.** `match.py` annotates its
two functions with `list[tuple[tuple[int, int, int], int]]`, PEP 585 syntax
that arrived in 3.9. On 3.8 the annotation is evaluated when the function is
defined and raises:

```
File "/tmp/audit/carti4ce_week1_capstone/match.py", line 6, in <module>
    def query(fingerprints: list[tuple[tuple[int, int, int], int]]):
TypeError: 'type' object is not subscriptable
```

The adapter imports `match` normally first. Only on that exact error (a
`TypeError` whose text contains "not subscriptable") does it re-execute the
same source with the `__future__.annotations` compiler flag, which is what a
`from __future__ import annotations` line at the top of their file would do:
annotations stop being evaluated, and nothing else changes. The `except`
clause is narrow on purpose, so a genuine bug in their code is never retried
under a flag that cannot fix it.

When the fallback fires it is recorded on the adapter instance as
`compatibility_notes`, and that must be shown with the score. "This scored on
3.8" and "this scored on 3.8 under a compatibility flag" are different
claims, and only one of them is true here.

## Verified results

Both repositories, benchmark `audio-identification` v1, `test` tier (8 songs,
68 queries, 76 cases). Identical metrics on both interpreters, so the
compatibility flag changes nothing about the score.

| metric | KrazeeCoder | carti4ce |
| --- | --- | --- |
| `identification_score` | 0.5938 | 0.6562 |
| `clean_top1` | 1.0 | 1.0 |
| `noisy_top1` | 1.0 | 1.0 |
| `short_clip_top1` | 1.0 | 1.0 |
| `pitch_top1` | 0.1875 | 0.3125 |
| `retrieval_failure_rate` | 0.0 | 0.0 |
| `ranking_failure_rate` | 0.1406 | 0.0625 |
| `margin_separation` | 0.5957 | 0.6855 |
| `median_identify_seconds` | 0.0103 | 0.0739 |
| failed cases | 0 of 76 | 0 of 76 |

Baselines, identical for both because they are properties of the corpus:
`chance_top1` 0.125, `trivial_baseline_top1` 0.1562.

Reproduce. `COGWORKS_STUDENT_REPO` is what lets an adapter run from this
directory without a copy sitting in the student's tree; run from an empty
directory, because the driver's scratch dir is where a relative `db.pkl`
lands.

```
mkdir -p /tmp/scratch && cd /tmp/scratch
COGWORKS_STUDENT_REPO=/path/to/carti4ce_week1_capstone \
PYTHONPATH=/path/to/CogPortal/benchmarks/adapters/carti4ce__week1_capstone \
python -c "
from audio_identification_benchmark.plugins import AudioIdentificationBenchmark
from submission import create_submission
b = AudioIdentificationBenchmark()
cases = b.load_cases('test')
print(b.score(b.run(create_submission, b.model_factory(), cases), cases)['identification_score'])
"
# 0.65625
```

## Adding another one

Directory name is `owner__repo`. The file is `submission.py` with a
`create_submission(resources)` factory, which is what
`cogbench.apploader.resolve_submission_file` looks for.

- Deferred imports. The loader imports this file before it decides to run
  anything, and numba, scipy, librosa, and matplotlib together cost seconds.
- No `chdir`. The driver has already made a scratch directory the working
  directory; fighting it is how a relative `db.pkl` escapes its run.
- Guard double enrollment if their store appends without checking. Both of
  these do, and a second enroll leaves the key count unchanged while doubling
  that song's votes (measured on KrazeeCoder: 118 to 236). The driver enrolls
  each song exactly once, so the guard is a backstop, not a workaround.
- Fill in `PROVENANCE` honestly, including anything you chose on the team's
  behalf.

### `LashikaKapoor28__Language_Module_Capstone/` (Week 3)

Their `embedder.embed_captions_batch` and `database.ImageDatabase` already
match the contract's shape; the adapter mostly renames. Two things needed a
decision.

`database.py` does `import streamlit as st` at module scope for one method
that displays images. The evaluation sandbox has no streamlit and no network,
so importing their database would fail on a line unrelated to search. The
adapter installs a stub under that name for the duration of the import and
removes it afterwards. `display_images` is never called.

Their encoder is `data/W_embed.npy`, a genuine trained 512x200 float32 matrix
written by their own `train.py:115` from `model.parameters[0].data`. The
adapter loads it rather than re-training, and refuses to run if it is missing
rather than substituting random weights, which would report a chance score as
if it were a trained one. The IDF table is rebuilt at run time from the
captions the benchmark supplies, using their `compute_idfs`, which is what
their `train.py:33` does.

Measured: **0.7413** on the public test tier against chance 0.0519, and
**0.4438** on the evaluation tier against chance 0.0102. Hosted and local
agree to four decimals.

### `LashikaKapoor28__Vision_Module_Capstone/` (Week 2)

Their `core/whispers.py` builds a `FacenetModel()` at module scope and their
`get_descriptor` reads images off disk. The benchmark supplies its own model
and passes decoded arrays, so the adapter imports only the graph half of that
module (`Node`, `propagate_label`, `connected_comps`, `whispers`) with
`facenet_models` stubbed during the import, and rebuilds the descriptor step
from the benchmark's model. Their `adj_list` computes descriptors and builds
the graph in one pass, so only its graph half is reproduced -- the threshold
comparison and the `1 / max(dist, 1e-8) ** 2` edge weight are theirs
verbatim. Their `whispers` calls `random.choice` unseeded, so the adapter
seeds `random` before the loop; the contract passes a seed and their
algorithm is otherwise not reproducible.

**Their recognition cutoff does not transfer, and the score says so.**
`RECOGNITION_THRESHOLD = 0.2846` came from a real FAR/FRR sweep in
`tuning/recognition_threshold.ipynb`, which reports both error rates at
0.0000 -- on their own photographs. On CelebA their nearest-profile ranking
is correct on every post-enrollment query, but the winning cosine distance is
0.58 to 0.63, so their own cutoff rejects the right answer:

    known_identification       0.8333
    unknown_rejection_recall   1.0000
    post_enrollment_accuracy   0.0000
    recognition_score          0.6667

That pattern -- perfect rejection, zero post-enrollment -- is exactly what the
`unknown_rejection_recall` help text warns about ("too strict and nobody is
ever recognized"). The cutoff is theirs and is left alone. Changing it would
score our tuning, not their submission.
