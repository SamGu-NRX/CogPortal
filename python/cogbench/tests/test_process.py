"""Tests for cogbench.process: the four commit/run signals and their honesty rules.

Three things get extra scrutiny here beyond ordinary correctness, because
they are the reason this module exists rather than a simpler one:

- Bulk-upload detection. Two of five real capstone teams pushed their whole
  project as a single commit; that is the common case, not an edge case, so
  every commit-derived signal must degrade to "unavailable" for it rather
  than reporting a one-commit history as if it were real development.
- No per-person totals, anywhere, in any field, on any dataclass in the
  module. `NoPerPersonTotals` below introspects every dataclass with
  `dataclasses.fields()` so a future field named e.g. `commits_by_author`
  fails the suite immediately instead of being caught in review.
- Never interpolate. An unavailable signal is `None`, `{}`, or `[]`, never a
  fabricated `0` standing in for "we didn't compute this."
"""

from __future__ import annotations

import dataclasses
import unittest

from cogbench.process import (
    Commit,
    Run,
    HISTORY_USABLE,
    HISTORY_BULK_UPLOAD,
    HISTORY_EMPTY,
    WEEK1_STAGE_MAP,
    WEEK2_STAGE_MAP,
    WEEK3_STAGE_MAP,
    DEFAULT_STAGE_MAPS,
    ProcessSignals,
    boundary_churn,
    classify_history_quality,
    finding_sentences,
    first_light,
    ownership_breadth,
    stage_footprint,
)


def _commit(sha, author, at, files, insertions=1, deletions=0):
    return Commit(
        sha=sha,
        author_login=author,
        authored_at=at,
        files_changed=list(files),
        insertions=insertions,
        deletions=deletions,
    )


def _run(run_id, at, status="completed", scored=True):
    return Run(run_id=run_id, created_at=at, status=status, scored=scored)


class ClassifyHistoryQualityTests(unittest.TestCase):
    def test_empty_history_is_empty(self):
        self.assertEqual(classify_history_quality([]), HISTORY_EMPTY)

    def test_single_commit_is_bulk_upload(self):
        commits = [_commit("a", "ada", "2026-06-01T00:00:00Z", ["a.py", "b.py"])]
        self.assertEqual(classify_history_quality(commits), HISTORY_BULK_UPLOAD)

    def test_one_commit_holding_most_files_is_bulk_upload(self):
        commits = [
            _commit("a", "ada", "2026-06-01T00:00:00Z", ["a{}.py".format(i) for i in range(10)]),
            _commit("b", "grace", "2026-06-02T00:00:00Z", ["b.py"]),
            _commit("c", "grace", "2026-06-03T00:00:00Z", ["c.py"]),
        ]
        # 10 of 12 total file-touches (83%) landed in one commit.
        self.assertEqual(classify_history_quality(commits), HISTORY_BULK_UPLOAD)

    def test_spread_out_history_is_usable(self):
        commits = [
            _commit("a", "ada", "2026-06-01T00:00:00Z", ["a.py"]),
            _commit("b", "grace", "2026-06-02T00:00:00Z", ["b.py"]),
            _commit("c", "grace", "2026-06-03T00:00:00Z", ["c.py"]),
            _commit("d", "ada", "2026-06-04T00:00:00Z", ["d.py"]),
        ]
        self.assertEqual(classify_history_quality(commits), HISTORY_USABLE)

    def test_commits_with_no_files_default_to_usable(self):
        commits = [
            _commit("a", "ada", "2026-06-01T00:00:00Z", []),
            _commit("b", "grace", "2026-06-02T00:00:00Z", []),
        ]
        self.assertEqual(classify_history_quality(commits), HISTORY_USABLE)


class StageFootprintTests(unittest.TestCase):
    STAGE_MAP = {
        "peaks": ["peak", "find_peaks"],
        "database": ["database"],
    }

    def test_multi_stage_commit_counts_for_each_stage(self):
        commits = [
            _commit("a", "ada", "2026-06-01T00:00:00Z", ["find_peaks.py", "database.py"]),
            _commit("b", "grace", "2026-06-02T00:00:00Z", ["find_peaks.py"]),
            _commit("c", "hedy", "2026-06-03T00:00:00Z", ["unrelated.py"]),
        ]
        result = stage_footprint(commits, self.STAGE_MAP)
        self.assertTrue(result["peaks"].available)
        self.assertEqual(result["peaks"].commit_count, 2)
        self.assertEqual(result["peaks"].distinct_author_count, 2)
        self.assertEqual(result["peaks"].first_touch_at, "2026-06-01T00:00:00Z")
        self.assertEqual(result["peaks"].last_touch_at, "2026-06-02T00:00:00Z")

        self.assertTrue(result["database"].available)
        self.assertEqual(result["database"].commit_count, 1)
        self.assertEqual(result["database"].distinct_author_count, 1)

    def test_zero_touch_stage_reports_real_zero_not_unavailable(self):
        commits = [
            _commit("a", "ada", "2026-06-01T00:00:00Z", ["find_peaks.py"]),
            _commit("b", "grace", "2026-06-02T00:00:00Z", ["find_peaks.py"]),
        ]
        result = stage_footprint(commits, self.STAGE_MAP)
        self.assertTrue(result["database"].available)
        self.assertEqual(result["database"].commit_count, 0)
        self.assertEqual(result["database"].distinct_author_count, 0)
        self.assertIsNone(result["database"].first_touch_at)

    def test_bulk_upload_marks_every_stage_unavailable_with_reason(self):
        commits = [_commit("a", "ada", "2026-06-01T00:00:00Z", ["find_peaks.py", "database.py"])]
        result = stage_footprint(commits, self.STAGE_MAP)
        for stage in self.STAGE_MAP:
            self.assertFalse(result[stage].available)
            self.assertIsNone(result[stage].commit_count)
            self.assertIsNone(result[stage].distinct_author_count)
            self.assertIsNotNone(result[stage].unavailable_reason)

    def test_bulk_upload_never_fabricates_a_zero(self):
        # Even a stage the single bulk commit did NOT touch must stay
        # unavailable, never reported as a computed 0.
        commits = [_commit("a", "ada", "2026-06-01T00:00:00Z", ["find_peaks.py"])]
        result = stage_footprint(commits, self.STAGE_MAP)
        self.assertFalse(result["database"].available)
        self.assertIsNone(result["database"].commit_count)

    def test_empty_history_marks_every_stage_unavailable(self):
        result = stage_footprint([], self.STAGE_MAP)
        for stage in self.STAGE_MAP:
            self.assertFalse(result[stage].available)


class FirstLightTests(unittest.TestCase):
    def test_never_scored_returns_none(self):
        runs = [_run("1", "2026-06-01T00:00:00Z", scored=False), _run("2", "2026-06-02T00:00:00Z", scored=False)]
        result = first_light(runs)
        self.assertIsNone(result.first_scored_at)
        self.assertEqual(result.scored_run_count, 0)

    def test_no_runs_at_all_returns_none(self):
        result = first_light([])
        self.assertIsNone(result.first_scored_at)
        self.assertEqual(result.scored_run_count, 0)

    def test_finds_earliest_scored_run_regardless_of_input_order(self):
        runs = [
            _run("3", "2026-06-05T00:00:00Z", scored=True),
            _run("1", "2026-06-01T00:00:00Z", scored=False),
            _run("2", "2026-06-03T00:00:00Z", scored=True),
        ]
        result = first_light(runs)
        self.assertEqual(result.first_scored_at, "2026-06-03T00:00:00Z")
        self.assertEqual(result.scored_run_count, 2)

    def test_ignores_commit_history_quality_entirely(self):
        # Runs are the portal's own observation; a bulk-uploaded commit
        # history must not suppress first_light.
        runs = [_run("1", "2026-06-01T00:00:00Z", scored=True)]
        result = first_light(runs)
        self.assertEqual(result.first_scored_at, "2026-06-01T00:00:00Z")


class BoundaryChurnTests(unittest.TestCase):
    BOUNDARY_FILES = ["contract.py"]

    def test_touch_before_first_light_is_not_reported(self):
        commits = [
            _commit("a", "ada", "2026-06-01T00:00:00Z", ["contract.py"]),
            _commit("b", "grace", "2026-06-05T00:00:00Z", ["other.py"]),
        ]
        events = boundary_churn(commits, self.BOUNDARY_FILES, first_light_at="2026-06-03T00:00:00Z")
        self.assertEqual(events, [])

    def test_touch_after_first_light_is_reported(self):
        commits = [
            _commit("a", "ada", "2026-06-01T00:00:00Z", ["contract.py"]),
            _commit("b", "grace", "2026-06-10T00:00:00Z", ["contract.py"]),
        ]
        events = boundary_churn(commits, self.BOUNDARY_FILES, first_light_at="2026-06-03T00:00:00Z")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].sha, "b")
        self.assertEqual(events[0].author_login, "grace")
        self.assertEqual(events[0].files, ["contract.py"])

    def test_none_first_light_returns_empty(self):
        commits = [_commit("a", "ada", "2026-06-01T00:00:00Z", ["contract.py"])]
        events = boundary_churn(commits, self.BOUNDARY_FILES, first_light_at=None)
        self.assertEqual(events, [])

    def test_bulk_upload_history_returns_empty(self):
        commits = [_commit("a", "ada", "2026-06-10T00:00:00Z", ["contract.py"])]
        events = boundary_churn(commits, self.BOUNDARY_FILES, first_light_at="2026-06-03T00:00:00Z")
        self.assertEqual(events, [])


class OwnershipBreadthTests(unittest.TestCase):
    STAGE_MAP = {
        "peaks": ["peak"],
        "database": ["database"],
    }

    def test_dedupes_and_sorts_authors_per_stage(self):
        commits = [
            _commit("a", "grace", "2026-06-01T00:00:00Z", ["find_peaks.py"]),
            _commit("b", "ada", "2026-06-02T00:00:00Z", ["find_peaks.py"]),
            _commit("c", "ada", "2026-06-03T00:00:00Z", ["find_peaks.py"]),
            _commit("d", "hedy", "2026-06-04T00:00:00Z", ["database.py"]),
        ]
        result = ownership_breadth(commits, self.STAGE_MAP)
        self.assertEqual(result["peaks"], ["ada", "grace"])
        self.assertEqual(result["database"], ["hedy"])

    def test_bulk_upload_returns_empty_dict_not_empty_lists(self):
        commits = [_commit("a", "ada", "2026-06-01T00:00:00Z", ["find_peaks.py"])]
        result = ownership_breadth(commits, self.STAGE_MAP)
        self.assertEqual(result, {})


class NoPerPersonTotals(unittest.TestCase):
    """Guardrail: no *output* dataclass field in cogbench.process may report
    a per-person count or a line count. This is a regression test, not a
    one-time review note; it will fail the moment someone adds a field like
    `commits_by_author` or `lines_changed` to a signal's output, before that
    field ever reaches a page.

    Scoped to the dataclasses the four signal functions (plus
    ProcessSignals, which bundles them) actually return, not to `Commit` or
    `Run`. Those two are input shapes matching the GitHub/portal APIs
    verbatim -- `Commit.insertions`/`Commit.deletions` are raw per-commit
    fields the API hands over, not a per-person total this module computed,
    and the module never reads them (see the module docstring). The spec's
    rule is about what this module reports, not what it accepts.
    """

    OUTPUT_DATACLASSES = ("StageActivity", "FirstLight", "ChurnEvent", "ProcessSignals")

    FORBIDDEN_SUBSTRINGS = (
        "by_author",
        "per_author",
        "author_commit",
        "commits_by",
        "author_count",  # distinct_author_count is a stage-wide bus-factor
                          # count, not a per-author count; excluded explicitly
                          # below rather than by loosening this pattern.
        "lines",
        "line_count",
        "insertions",
        "deletions",
    )
    ALLOWED_EXCEPTIONS = ("distinct_author_count",)

    def test_no_forbidden_field_names_on_output_dataclasses(self):
        import cogbench.process as process_module

        offenders = []
        for name in self.OUTPUT_DATACLASSES:
            obj = getattr(process_module, name)
            self.assertTrue(dataclasses.is_dataclass(obj), "{} is not a dataclass".format(name))
            for field in dataclasses.fields(obj):
                if field.name in self.ALLOWED_EXCEPTIONS:
                    continue
                for pattern in self.FORBIDDEN_SUBSTRINGS:
                    if pattern in field.name:
                        offenders.append("{}.{}".format(obj.__name__, field.name))
        self.assertEqual(
            offenders,
            [],
            "found per-person-total or line-count-shaped field(s): {}".format(offenders),
        )

    def test_commit_input_shape_is_not_scanned_but_is_documented(self):
        # Commit legitimately carries insertions/deletions as raw input data
        # (that's what the GitHub API hands over); this test only records
        # that assumption so a future reader knows the exclusion above is
        # deliberate, not an oversight.
        self.assertIn("insertions", [f.name for f in dataclasses.fields(Commit)])
        self.assertIn("deletions", [f.name for f in dataclasses.fields(Commit)])


class FindingSentencesTests(unittest.TestCase):
    def test_no_scored_run_yet_sentence_matches_exactly(self):
        signals = ProcessSignals(
            history_quality=HISTORY_USABLE,
            stage_footprint={},
            first_light=first_light([]),
            boundary_churn=[],
            ownership_breadth={},
        )
        sentences = finding_sentences(signals)
        self.assertIn(
            "No end-to-end run yet. Integration is the part the course says "
            "is hardest, and it usually takes longer than teams expect.",
            sentences,
        )

    def test_single_owner_stage_sentence_matches_exactly(self):
        signals = ProcessSignals(
            history_quality=HISTORY_USABLE,
            stage_footprint={},
            first_light=first_light([_run("1", "2026-06-01T00:00:00Z", scored=True)]),
            boundary_churn=[],
            ownership_breadth={"database": ["ada"]},
        )
        sentences = finding_sentences(signals)
        self.assertIn("Only one person has touched the database stage.", sentences)

    def test_boundary_churn_sentence_matches_exactly(self):
        commits = [
            _commit("a", "ada", "2026-06-01T00:00:00Z", ["database.py"]),
            _commit("b", "grace", "2026-06-10T00:00:00Z", ["find_peaks.py"]),
        ]
        signals = ProcessSignals(
            history_quality=HISTORY_USABLE,
            stage_footprint={},
            first_light=first_light([_run("1", "2026-06-01T00:00:00Z", scored=True)]),
            boundary_churn=boundary_churn(commits, ["find_peaks.py"], "2026-06-03T00:00:00Z"),
            ownership_breadth={},
        )
        sentences = finding_sentences(signals)
        self.assertIn("The find_peaks signature changed after your pipeline first worked.", sentences)

    def test_two_person_stage_gets_no_single_owner_sentence(self):
        signals = ProcessSignals(
            history_quality=HISTORY_USABLE,
            stage_footprint={},
            first_light=first_light([_run("1", "2026-06-01T00:00:00Z", scored=True)]),
            boundary_churn=[],
            ownership_breadth={"database": ["ada", "grace"]},
        )
        sentences = finding_sentences(signals)
        self.assertEqual([s for s in sentences if "database" in s], [])


class DefaultStageMapTests(unittest.TestCase):
    def test_week_labels_match_default_stage_maps(self):
        self.assertEqual(set(DEFAULT_STAGE_MAPS.keys()), {"week1", "week2", "week3"})
        self.assertIs(DEFAULT_STAGE_MAPS["week1"], WEEK1_STAGE_MAP)
        self.assertIs(DEFAULT_STAGE_MAPS["week2"], WEEK2_STAGE_MAP)
        self.assertIs(DEFAULT_STAGE_MAPS["week3"], WEEK3_STAGE_MAP)

    def test_week1_stage_names(self):
        self.assertEqual(set(WEEK1_STAGE_MAP.keys()), {"spectrogram", "peaks", "fanout", "database", "query"})

    def test_week2_stage_names(self):
        self.assertEqual(set(WEEK2_STAGE_MAP.keys()), {"descriptors", "profiles", "matching", "whispers"})

    def test_week3_stage_names(self):
        self.assertEqual(set(WEEK3_STAGE_MAP.keys()), {"organizer", "embedding", "training", "search"})

    def test_peaks_stage_matches_course_synonyms(self):
        commits = [
            _commit("a", "ada", "2026-06-01T00:00:00Z", ["peak_detection.py"]),
            _commit("b", "grace", "2026-06-02T00:00:00Z", ["local_max.py"]),
            _commit("c", "hedy", "2026-06-03T00:00:00Z", ["find_peaks.py"]),
        ]
        result = stage_footprint(commits, WEEK1_STAGE_MAP)
        self.assertEqual(result["peaks"].commit_count, 3)

    def test_query_stage_matches_plural_queries(self):
        commits = [
            _commit("a", "ada", "2026-06-01T00:00:00Z", ["test_noisy_queries.py"]),
            _commit("b", "grace", "2026-06-02T00:00:00Z", ["spectrogram.py"]),
        ]
        result = stage_footprint(commits, WEEK1_STAGE_MAP)
        self.assertEqual(result["query"].commit_count, 1)


if __name__ == "__main__":
    unittest.main()
