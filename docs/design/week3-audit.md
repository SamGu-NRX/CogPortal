# Week 3 measures four of the course's thirteen deliverables

**Status:** audited 2026-08-19 (workflow `wf_6bf7e2ee-7b1`, findings
adversarially re-verified against source). Two defects fixed here; the rest is
a scoped list of what is missing and what it would cost.

The owner's suspicion — "week two and week three's benchmarks were not fully
created, especially week three, maybe" — is correct in a specific, measurable
way, and wrong about which part is missing.

## The headline

`docs/cogweb/pages/Language/SemanticImageSearch.md:519-560` enumerates **13
deliverables** across four task groups. The benchmark's adapter protocol
requires **4**: `embed_text`, `embed_images`, `prepare_database`, `search`.

That is not automatically a flaw — a benchmark that graded the training loop
would force one architecture and forbid the variation the course wants. But it
means the number on a Week 3 run page describes the *inference* half of the
assignment only, and nothing anywhere says so.

**Unmeasured, verified by grep returning hits only inside `metric_help` prose:**
margin ranking loss, triplet/confusor construction, the batch accuracy
function, the 4/5–1/5 train/validation split, weight save/load, the COCO
organizer class and its three mappings, the tokenization rule, the
IDF-over-all-captions definition, and the zero-vector rule for out-of-vocabulary
words. `checks.py:24-25` sets `MIN_DIM=8, MAX_DIM=512`, so the course-canonical
D=200 is not even asserted.

## What is genuinely thin

**No stress axis at all.** Every scored query is a verbatim COCO caption of the
gold image (`datasets.py:474-475`). No paraphrases, no typos, no hard negatives,
no free-form queries. Week 1 sweeps clip length, SNR, and pitch; Week 3 sweeps
nothing. The only free-form captions in the repository are the 10 staff showcase
queries, and those are printed, never scored.

**No calibration record.** `examples/week1-audio-submission/CALIBRATION.md` is
440 measured lines and its headline finding is that Week 1's own grid does not
grade. Week 3 has never been subjected to that test. Its only measurements are
two single-seed report JSONs.

**References are all one quality level.** Week 3 ships perfect / inert /
broken. Every non-degenerate fixture wraps the same `PerfectAdapter` with
different plumbing, so nothing establishes that the benchmark can rank two
*working* submissions differently. Week 1 ships five genuinely different
pipelines including a mis-tuned one and a realistic-bug one.

**`search_mrr` is near-degenerate with `retrieval_mrr`.** On the test tier the
reference scored them identical to 16 significant figures; on evaluation they
differ by 0.00137. Both are handed the same pinned pool over the same query
list (`datasets.py:507-521`), so any cosine-top-k `search` reproduces the
controller's own ranking. The "three components" of `overall` are effectively
two, one double-weighted.

A verifier pushed back usefully here: the two are *not* the same measurement.
`search_mrr` alone exercises the submission's own retrieval plumbing, and a
regression test proves it can diverge. The honest statement is that they are
empirically near-degenerate **on correct submissions** while remaining
diagnostically distinct on broken ones.

**No `test_datasets` module.** `assert_disjoint` is defined at
`datasets.py:535-555` and called only by a staff tool — never by a test. Weeks 1
and 2 both assert tier disjointness in their suites. The manifests are disjoint
today (verified), so this is an unguarded invariant rather than a live defect.

**Smallest suite of the three:** 21 test functions against Week 1's 92 and
Week 2's 25.

## What was NOT missing

The owner may fear Week 3 has no fault coverage. It does:
`apps/runner-modal/tools/probe_student_faults.py` runs 14 fault variants, plus
a real-sandbox smoke test and a local/hosted parity check. That is comparable to
Week 1's.

## Fixed here

**`search_ranks` returned the wrong thing under a docstring that promised
another.** Its signature took `pool_size: int`, never read it, and returned
`len(gold_image_ids)` — the query count — while the docstring promised "the
count of returned ids that were outside the pinned pool." The caller then
recomputed the real foreign count itself and used the wrong value only as a
truthiness guard, which is why nothing broke: a non-empty query list is truthy
in exactly the cases a real foreign count would be.

The parameter is now `pool: Optional[Sequence[int]]`, the function returns what
it documents, and the caller's duplicate loop is gone. The old test discarded
the second return value with `_`, which is how this survived; there are now
three tests, two of which assert on it.

## Not fixed, and why

**`text_chance` is computed and never reported.** `metrics.py:179-181` computes
it, but the metrics dict exposes only `chance_mrr` (the retrieval floor).
`text_chance` survives only interpolated into a diagnostic string, so the
`text_mrr` floor never reaches the portal's metric table. On the evaluation
tier the two floors differ by roughly 4x, so a reader comparing `text_mrr`
against the one published floor is comparing against the wrong number.

This is a real defect and the fix is one line, but it changes the metric set,
which changes `scorer_version`, which invalidates existing runs. It belongs
with the stress-axis work rather than as a drive-by.

## The submodule problem

`benchmarks/week3` has **174 uncommitted insertions**, including the entire
61-line `metric_help` block that `test_metric_explainability.py` depends on.
The committed state of the submodule does not have it. The same is true of
Week 2, where the shared explainability test currently *skips* Week 2 for
lacking `metric_help` — in the committed tree, that skip is correct.

Both submodules are separate GitHub repositories. Their working trees carry
real, tested work that exists nowhere else. This is the largest single risk in
the repository right now and it is not a code problem.
