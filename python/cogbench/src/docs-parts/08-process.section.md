## process.py

`process.py` computes the process layer: four signals derived from commit
history and run records, never from scores. It takes frozen dataclasses in
(`Commit`, `Run`) and returns findings out, with no I/O of any kind, which is
why its tests run on plain fixtures. Nothing else in the Python package
imports it yet; the live consumer is the portal, below.

Two rules hold across every function here, and tests enforce them rather than
trust convention. `tests/test_process.py::NoPerPersonTotals` introspects every
output dataclass with `dataclasses.fields()` and fails the build the moment a
field could report a per-person count or a line count, so a future
`commits_by_author` field cannot slip in quietly. The never-interpolate tests
(`test_bulk_upload_never_fabricates_a_zero`, `test_none_first_light_returns_empty`,
`test_bulk_upload_returns_empty_dict_not_empty_lists`) pin the other half: a
signal that cannot be computed returns `None`, `{}`, `[]`, or an explicit
`unavailable_reason`, never a zero standing in for missing data.

Three of the four signals share one gate, `classify_history_quality`. Two of
five real capstone teams pushed their whole project as a single commit, and
for those repositories per-commit attribution would be fiction. The gate
classifies a history as `empty` or `bulk_upload` (one commit, or one commit
holding more than 60% of all changed files), and the signals that call it
refuse to compute, saying why in `unavailable_reason`.

- **`stage_footprint`** attributes commits to capstone stages by the files
  they touch, and counts a multi-stage commit for every stage it belongs to,
  because cross-stage integration work is the interesting case, not noise.
  When the history is usable, a stage with zero commits is a real finding, so
  its zeros are computed, not placeholders: `None` means "we could not look",
  `0` means "we looked and nothing is there".
- **`first_light`** reports the timestamp of a team's earliest scored run and
  the total number of scored runs. Runs are the portal's own observation
  rather than supplementary evidence, so this is the one signal that never
  consults the history gate; a bulk-uploaded repository still gets credit for
  its run history (`test_ignores_commit_history_quality_entirely`).
- **`boundary_churn`** lists commits that touched a contract file after first
  light. Before the first scored run, a signature change is ordinary design
  work; after it, the pieces have proven to fit, so a change is a breaking
  event worth naming. With no first light there is nothing to measure
  against, so the answer is an empty list, not "everything counts".
- **`ownership_breadth`** maps each stage to a sorted list of the distinct
  people who have touched it: a bus-factor map, not a leaderboard. Names
  only, no counts, on purpose; "how much did each person do" is the question
  this module refuses to answer, here and everywhere else.

`finding_sentences` renders the bundled signals as fixed template sentences,
one observation each, and never generates prose; a stage with ordinary,
spread-out activity earns no sentence at all.

`apps/portal/worker/services/process-signals.ts` is a TypeScript port of this
module, disclosed as such in its header along with each deliberate
difference (epoch-millisecond timestamps instead of ISO strings, and a fourth
`HISTORY_FETCH_FAILED` state the Python module cannot have because it never
talks to GitHub). This module is the reference; when the two could disagree,
this one decides.

`DEFAULT_STAGE_MAPS` bundles the three per-week stage maps (`WEEK1_STAGE_MAP`,
`WEEK2_STAGE_MAP`, `WEEK3_STAGE_MAP`) under the labels `week1`, `week2`, and
`week3`, matching the `benchmarks/week*` directory names. Each maps a stage
name to a list of patterns, and `_matches_any` tests every pattern as a
case-insensitive substring of the full path (a pattern holding `*`, `?`, or
`[` is matched as a glob against the path and its basename). The maps are
bare word roots for that reason: `"peak"` matches `find_peaks.py`,
`PeakFinding.ipynb`, and `test_peak_params.py` alike. The patterns were
chosen against the course's own stage names in
`docs/capstones/week{1,2,3}-*-capstone.md`, and the comment above the maps
records how they were checked against file names in real team repositories.
Read them as vocabulary to keep current, not logic to refactor.
