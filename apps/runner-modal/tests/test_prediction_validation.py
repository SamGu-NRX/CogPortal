"""The predictions file is written inside the sandbox, so nothing in it is
trusted on the way back.

Every count and size check in EVALUATE_SCRIPT runs in the student's own
process, before the file is written. A module-level atexit handler rewrites
that file after the script's last write, so the bytes the controller reads are
whatever the handler put there. The controller therefore re-checks what it is
unwilling to be wrong about, on its own side of the boundary, before any of it
reaches score().

Two things go wrong when it does not. A short results list is not a crash:
zip() truncates, and four Week 1 results covering a submission's two correct
queries score identification_score 1.0 where the honest twelve score 0.2. A
wrong element type is an uncaught AttributeError inside score(), and
execute_job labels anything raised during the scoring phase as category
"scorer" with infrastructure=True, whose copy tells the team the platform
broke and refunds the attempt. Both tests below pin the refusal instead.
"""

from __future__ import annotations

import ast
import json
import math
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))

MODAL_APP = ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"
SOURCE = MODAL_APP.read_text(encoding="utf-8")


def _validation_namespace() -> dict:
    """Load the validation helpers from source, without importing modal.

    `modal_app` imports modal and fastapi at module scope and the test
    interpreter has neither, which is why every test in this directory reads
    what it needs out of the AST. Taking the real nodes rather than a copy is
    the point: a test built on a paraphrase of the shipped code stops being
    evidence about the shipped code.
    """

    module = ast.parse(SOURCE)
    wanted_functions = {
        "_reject_constant",
        "_finite_float",
        "_bounded_int",
        "_load_predictions",
        "_type_word",
        "_refuse_output",
        "_check_matrix_field",
        "_check_predictions",
        "_restore_v2_predictions",
    }
    wanted_assignments = {
        "_SAFE_INT",
        "_V2_PREDICTION_SHAPES",
        "_NULLABLE_PREDICTION_FIELDS",
        "_NUMERIC_MATRIX_FIELDS",
        "_EMPTY_ROW_OK",
        "_RECOGNITION_BATCHES",
        "_TYPE_WORDS",
    }
    body = []
    for node in module.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted_functions:
            body.append(node)
        elif isinstance(node, ast.ClassDef) and node.name in ("_NonFiniteNumber", "RunnerFailure"):
            body.append(node)
        elif isinstance(node, ast.AnnAssign) and getattr(node.target, "id", None) in wanted_assignments:
            body.append(node)
        elif isinstance(node, ast.Assign) and any(
            getattr(t, "id", None) in wanted_assignments for t in node.targets
        ):
            body.append(node)

    missing = wanted_functions - {n.name for n in body if isinstance(n, ast.FunctionDef)}
    assert not missing, "modal_app.py is missing {}".format(sorted(missing))
    # Constants are named here too, and a missing one is a NameError raised
    # from inside a json parse hook, which surfaces as an unreadable failure
    # in whichever test happens to parse a number first. Fail here instead.
    found_names = set()
    for node in body:
        if isinstance(node, ast.AnnAssign):
            found_names.add(getattr(node.target, "id", None))
        elif isinstance(node, ast.Assign):
            found_names.update(getattr(t, "id", None) for t in node.targets)
    absent = wanted_assignments - found_names
    assert not absent, "modal_app.py is missing {}".format(sorted(absent))

    namespace: dict = {"json": json, "Any": object, "Dict": dict, "List": list, "Tuple": tuple, "Optional": None}
    exec(compile(ast.Module(body=body, type_ignores=[]), "<modal_app>", "exec"), namespace)
    return namespace


NS = _validation_namespace()
LOAD = NS["_load_predictions"]
CHECK = NS["_check_predictions"]
RESTORE = NS["_restore_v2_predictions"]
FAILURE = NS["RunnerFailure"]
SHAPES = NS["_V2_PREDICTION_SHAPES"]
MATRIX_FIELDS = NS["_NUMERIC_MATRIX_FIELDS"]


def _recognition_plan():
    """One scenario's permutation: three queries before enrollment, one after.

    Two known queries, one unknown, one post-enrollment, which is the smallest
    plan that exercises all three lifecycle slices.
    """

    from cogworks_runner.week2_payload import RecognitionQueryPlan

    return RecognitionQueryPlan(
        known_query_counts=(2,),
        unknown_count=1,
        post_count=1,
        before_slots=(0, 2, 1),
        after_slots=(3,),
    )


def _enclosing_call(source: str, target: ast.Call):
    """The Call node that has `target` as a direct argument, or None.

    ast nodes carry no parent pointer, so the tree is walked once looking for
    the node that holds this one. Used to ask whether a read of the
    predictions file is wrapped in `_load_predictions(...)` without matching
    on source formatting.
    """

    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call) and any(
            isinstance(argument, ast.Call)
            and argument.lineno == target.lineno
            and argument.col_offset == target.col_offset
            for argument in node.args
        ):
            return node
    return None


def _week3_metrics():
    """Score one honest text component and one made of nulls, or None.

    Returns (honest_text_mrr, all_null_text_mrr). This runs the real
    `component_scores` rather than a copy of it, because the claim being
    tested is about what the shipped scorer does with a NaN, and a
    reimplementation here would only be evidence about the reimplementation.

    Returns None when the Week 3 package or numpy is unavailable, which is the
    same fallback the payload tests in this directory use: the suite has to
    stay runnable on an interpreter that cannot import a benchmark submodule.
    """

    sys.path.insert(0, str(ROOT / "benchmarks" / "week3"))
    try:
        from language_search_benchmark.metrics import component_scores
    except Exception:
        return None

    class _TextCase:
        kind = "text"
        tie_break_seed = 11

        def __init__(self, group_rows):
            self.group_rows = group_rows

    # 24 captions, two per image, so every caption has exactly one co-caption
    # to find. Fixed seed, so the honest number below is reproducible.
    count, width = 24, 8
    case = _TextCase([index // 2 for index in range(count)])
    generator = np.random.default_rng(5)
    honest = np.round(generator.normal(size=(count, width)), 5).tolist()

    def text_mrr(embeddings):
        metrics, _ = component_scores(
            [{"ok": True, "kind": "text", "embeddings": embeddings}], [case], 5
        )
        return metrics["text_mrr"]

    return text_mrr(honest), text_mrr([[None] * width for _ in range(count)])


class _Benchmark:
    """The two attributes _check_predictions reads off a plugin."""

    def __init__(self, benchmark_id: str, contract_version: str = "cogworks.submissions.v2"):
        self.benchmark_id = benchmark_id
        self.contract_version = contract_version


def _week1(count: int = 2) -> list:
    """Results shaped the way week1/drivers.py builds them."""

    return [
        {
            "ok": True,
            "kind": "query",
            "query_id": "q{}".format(index),
            "candidates": ["song-a", "song-b"],
            "scores": [0.9, 0.1],
            "shape": "(2,)",
            "seconds": 0.01,
        }
        for index in range(count)
    ]


def _recognition(count: int = 1) -> list:
    return [
        {"known": ["ada"], "unknown_before": [None], "post_enrollment": ["grace"]}
        for _ in range(count)
    ]


class CountTests(unittest.TestCase):
    """The sandbox counts too. It is not trusted, so this counts again."""

    def test_short_results_list_is_refused(self):
        # The inflation case: one perfect scenario standing in for four.
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("vision-clustering"), [[0, 0, 1, 1]], 4)
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("1 results for 4 cases", str(caught.exception))

    def test_long_results_list_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("audio-identification"), _week1(5), 2)
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("5 results for 2 cases", str(caught.exception))

    def test_empty_results_list_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("language-search"), [], 3)
        self.assertIn("0 results for 3 cases", str(caught.exception))

    def test_count_error_does_not_assume_who_built_the_results(self):
        for version in ("cogworks.submissions.v1", "cogworks.submissions.v2"):
            with self.subTest(version=version), self.assertRaises(FAILURE) as caught:
                CHECK(_Benchmark("language-search", version), [], 3)
            message = str(caught.exception)
            self.assertIn("If your adapter builds this list, check its length.", message)
            self.assertIn("Otherwise, tell course staff.", message)
            self.assertNotIn("driver calls", message)
            self.assertLessEqual(len(message), 240)

    def test_count_is_checked_for_v1_too(self):
        # The v1 fixture benchmark has no entry in the shape table and needs
        # none: its score() str()-coerces whatever it is handed. The count is
        # still the difference between scoring 2 of 5 cases and scoring 5.
        v1 = _Benchmark("vision-recognition", contract_version="cogworks.submissions.v1")
        with self.assertRaises(FAILURE) as caught:
            CHECK(v1, ["a", "b"], 5)
        self.assertEqual(caught.exception.category, "output_invalid")
        CHECK(v1, ["a", "b", "c", "d", "e"], 5)


class NonFiniteTests(unittest.TestCase):
    """json.loads accepts NaN and Infinity by default and dumps re-emits them.

    A NaN that survives to a metric reaches the completed event body, where
    JSON.parse in the Worker rejects the literal token and answers 400. The
    run is scored, the event is dropped, and the run never reaches a terminal
    state, which reads to a team as a hung run rather than as a refusal.
    """

    def test_stdlib_still_accepts_the_tokens_this_guards_against(self):
        # If this ever fails, the hooks below are guarding a hole that closed
        # and the comments explaining them are stale.
        self.assertTrue(math.isnan(json.loads("[NaN]")[0]))
        self.assertTrue(math.isinf(json.loads("[Infinity]")[0]))
        self.assertTrue(math.isinf(json.loads("[1e400]")[0]))

    def test_nan_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            LOAD('[{"ok": true, "seconds": NaN}]')
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("NaN", str(caught.exception))
        self.assertIn("not a finite number", str(caught.exception))

    def test_infinity_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            LOAD('[{"scores": [Infinity, 0.1]}]')
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("Infinity", str(caught.exception))

    def test_negative_infinity_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            LOAD("[-Infinity]")
        self.assertEqual(caught.exception.category, "output_invalid")

    def test_non_finite_is_refused_at_any_depth(self):
        # The tokens are caught during the parse, so nesting does not hide
        # them the way a shallow walk over the top level would.
        with self.assertRaises(FAILURE):
            LOAD('[{"ok": true, "text": [[1.0, 2.0], [3.0, NaN]]}]')

    def test_float_overflow_is_refused(self):
        # 1e400 carries no NaN or Infinity token, so parse_constant never sees
        # it. It parses to inf, which is why parse_float reads the text.
        with self.assertRaises(FAILURE) as caught:
            LOAD("[1e400]")
        self.assertEqual(caught.exception.category, "output_invalid")

    def test_integer_too_wide_for_float_is_refused(self):
        # float(2 ** 1024) raises OverflowError, and scoring calls float() on
        # submission numbers (week1 _margin, _v2_metrics). Uncaught, that is
        # the refunded-attempt path.
        with self.assertRaises(FAILURE):
            LOAD("[{}]".format(2 ** 1100))

    def test_the_int_bound_sits_where_float_actually_gives_up(self):
        # Both of these are 1024-bit integers. One converts and one does not,
        # because float() rounds before it range-checks, which is why the
        # check asks float() instead of measuring bit_length.
        self.assertEqual((2 ** 1023).bit_length(), (2 ** 1024 - 1).bit_length())
        self.assertEqual(LOAD("[{}]".format(2 ** 1023)), [2 ** 1023])
        with self.assertRaises(FAILURE):
            LOAD("[{}]".format(2 ** 1024 - 1))

    def test_ordinary_numbers_survive_the_hooks(self):
        parsed = LOAD('[{"scores": [0.5, -2, 1e300, 0], "n": 9007199254740993}]')
        self.assertEqual(parsed[0]["scores"], [0.5, -2, 1e300, 0])
        self.assertEqual(parsed[0]["n"], 9007199254740993)

    def test_malformed_json_is_not_reported_as_a_shape_problem(self):
        # A truncated file is a transport or sandbox fault, not a submission
        # returning the wrong shape, so it must not be dressed up as one.
        with self.assertRaises(ValueError) as caught:
            LOAD("[1, 2")
        self.assertNotIsInstance(caught.exception, FAILURE)


class TopLevelTypeTests(unittest.TestCase):
    """The whole file has to be a JSON array, checked before list() runs.

    Each evaluate lane calls list() on what it returns, and list() coerces
    rather than checks. A top-level object becomes a list of its keys, so
    {"a": 1, "b": 2} arrives at the count check looking like two results.
    """

    def test_stdlib_list_still_launders_the_shapes_this_guards_against(self):
        self.assertEqual(list(json.loads('{"a": 1, "b": 2}')), ["a", "b"])
        self.assertEqual(list(json.loads('"ab"')), ["a", "b"])

    def test_top_level_object_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            LOAD('{"a": 1, "b": 2}')
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("a dictionary", str(caught.exception))

    def test_top_level_string_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            LOAD('"ab"')
        self.assertIn("a string", str(caught.exception))

    def test_top_level_number_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            LOAD("5")
        self.assertIn("a number", str(caught.exception))

    def test_top_level_null_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            LOAD("null")
        self.assertIn("None", str(caught.exception))

    def test_an_empty_array_is_not_refused_here(self):
        # Zero results is a count problem, not a type problem, and the count
        # check names it better ("0 results for N cases").
        self.assertEqual(LOAD("[]"), [])


class ElementTypeTests(unittest.TestCase):
    def test_list_where_a_dict_is_expected_is_refused(self):
        # Uncaught this is AttributeError: 'list' object has no attribute
        # 'get', raised on the first line of week1 metrics.
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("audio-identification"), [["a", "b"], ["c"]], 2)
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("Result 0", str(caught.exception))
        self.assertIn("a list", str(caught.exception))
        self.assertIn("a dictionary", str(caught.exception))

    def test_string_where_a_dict_is_expected_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("language-search"), ["abcd"], 1)
        self.assertIn("a string", str(caught.exception))

    def test_number_where_a_dict_is_expected_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("vision-recognition"), [3], 1)
        self.assertIn("a number", str(caught.exception))

    def test_null_element_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("audio-identification"), [None], 1)
        self.assertIn("None", str(caught.exception))

    def test_dict_where_a_flat_label_list_is_expected_is_refused(self):
        # Week 2 clustering is the one benchmark whose element is a bare
        # sequence. A dict of the right length indexes as actual[left] and
        # raises KeyError: 0 inside pairwise_f1.
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("vision-clustering"), [{"0": "a", "1": "b"}], 1)
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("a list", str(caught.exception))

    def test_string_of_the_right_length_is_refused_for_clustering(self):
        # The reason type() is checked rather than isinstance or len(): a
        # four-character string clears both of score_clustering's length
        # guards and is scored as a partition of four images.
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("vision-clustering"), ["abcd"], 1)
        self.assertIn("a string", str(caught.exception))

    def test_the_offending_index_is_named(self):
        results = _week1(3)
        results[2] = ["oops"]
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("audio-identification"), results, 3)
        self.assertIn("Result 2", str(caught.exception))


class FieldTypeTests(unittest.TestCase):
    def test_null_candidates_is_refused(self):
        # week1 metrics does [str(v) for v in output.get("candidates", [])],
        # so a null here is TypeError: 'NoneType' is not iterable.
        results = _week1(1)
        results[0]["candidates"] = None
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("audio-identification"), results, 1)
        self.assertIn("candidates", str(caught.exception))
        self.assertIn("None", str(caught.exception))

    def test_string_known_labels_are_refused(self):
        # Measured before this check existed: {"known": "ab"} against expected
        # ["a", "b"] cleared the length guard, zip iterated the characters,
        # and the scenario scored as two correct labels.
        results = _recognition(1)
        results[0]["known"] = "ad"
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("vision-recognition"), results, 1)
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("known", str(caught.exception))
        self.assertIn("a string", str(caught.exception))

    def test_number_where_a_length_is_taken_is_refused(self):
        # score_recognition's guard is len(actual) != len(expected), which
        # assumes its operand has a length. An int does not.
        results = _recognition(1)
        results[0]["unknown_before"] = 7
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("vision-recognition"), results, 1)
        self.assertIn("unknown_before", str(caught.exception))

    def test_null_rankings_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            CHECK(
                _Benchmark("language-search"),
                [{"ok": True, "kind": "search", "rankings": None}],
                1,
            )
        self.assertIn("rankings", str(caught.exception))

    def test_string_mappings_is_refused(self):
        # A string iterates per character. Measured: a 2 MB string in
        # "mappings" cost 0.88 s and 135 MB of peak controller memory building
        # format-string objects, all but 32 of which are then discarded.
        results = _week1(1)
        results[0]["mappings"] = "x" * 64
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("audio-identification"), results, 1)
        self.assertIn("mappings", str(caught.exception))

    def test_null_scores_is_allowed(self):
        # The one legitimate null: week1's driver writes "scores": None when
        # the submission returned candidates without them, and _margin reads
        # that None and returns None.
        results = _week1(1)
        results[0]["scores"] = None
        CHECK(_Benchmark("audio-identification"), results, 1)

    def test_unhashable_cluster_labels_are_refused(self):
        # Counter(zip(expected, actual)) in adjusted_rand_index hashes every
        # label. A list label is TypeError: unhashable type: 'list'.
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("vision-clustering"), [[["a"], ["b"]]], 1)
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("label 0", str(caught.exception))

    def test_boolean_cluster_labels_are_allowed(self):
        # The driver refuses these inside the sandbox as a contract matter,
        # but scoring reads True as 1 and False as 0 and returns a correct
        # partition for them. Refusing a payload that scores correctly would
        # cost a team an attempt for nothing.
        CHECK(_Benchmark("vision-clustering"), [[True, True, False]], 1)

    def test_dict_cluster_label_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("vision-clustering"), [["a", {"b": 1}]], 1)
        self.assertIn("label 1", str(caught.exception))

    def test_failed_case_output_is_not_refused(self):
        # A case the submission could not answer writes {"ok": False, ...}
        # with none of the payload fields. Scoring reads that shape on
        # purpose, and refusing it would fail a run for reporting honestly.
        CHECK(
            _Benchmark("audio-identification"),
            [{"ok": False, "kind": "query", "error": "identify raised", "outcome": "error"}],
            1,
        )


class ValidPayloadTests(unittest.TestCase):
    """The case that matters most: an honest submission is untouched."""

    def test_week1_payload_passes(self):
        results = _week1(2)
        before = json.dumps(results, sort_keys=True)
        CHECK(_Benchmark("audio-identification"), results, 2)
        self.assertEqual(json.dumps(results, sort_keys=True), before)

    def test_week2_recognition_payload_passes(self):
        CHECK(_Benchmark("vision-recognition"), _recognition(3), 3)

    def test_week2_clustering_payload_passes(self):
        CHECK(_Benchmark("vision-clustering"), [[0, 0, 1], ["a", "a", "b"]], 2)

    def test_week3_payload_passes(self):
        CHECK(
            _Benchmark("language-search"),
            [
                {"ok": True, "kind": "text", "embeddings": [[0.1, 0.2], [0.3, 0.4]]},
                {"ok": True, "kind": "retrieval", "text": [[0.1]], "images": [[0.2]]},
                {"ok": True, "kind": "search", "rankings": [[3, 1, 2]]},
            ],
            3,
        )

    def test_first_result_may_carry_mappings(self):
        # Both week1 and week3 drivers attach the adapter's mapping log to
        # outputs[0] only, so element 0 is legitimately wider than the rest.
        results = _week1(2)
        results[0]["mappings"] = ["identify -> find_matches"]
        CHECK(_Benchmark("audio-identification"), results, 2)

    def test_load_returns_the_parsed_payload_unchanged(self):
        raw = json.dumps(_week1(2))
        self.assertEqual(LOAD(raw), json.loads(raw))


class NumericLeafTests(unittest.TestCase):
    """The fields handed to numpy are checked down to the leaf.

    JSON `null` is the value neither parse hook can see: `parse_constant`
    fires on the tokens NaN, Infinity and -Infinity, and the number hooks see
    number text. `null` is none of those, so it parses to None, and
    `np.asarray(..., dtype=float)` turns None into NaN without raising.

    A NaN embedding does not produce a wrong number, it produces the best
    possible one. `test_a_null_embedding_scores_better_than_honest_work`
    below measures that against the real scoring module.
    """

    def test_null_inside_embeddings_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            CHECK(
                _Benchmark("language-search"),
                [{"ok": True, "kind": "text", "embeddings": [[1.0, None], [2.0, 3.0]]}],
                1,
            )
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("embeddings", str(caught.exception))
        self.assertIn("row 0, position 1", str(caught.exception))

    def test_null_inside_retrieval_matrices_is_refused(self):
        for field in ("text", "images"):
            payload = {"ok": True, "kind": "retrieval", "text": [[0.1]], "images": [[0.2]]}
            payload[field] = [[None]]
            with self.assertRaises(FAILURE) as caught:
                CHECK(_Benchmark("language-search"), [payload], 1)
            self.assertIn(field, str(caught.exception))

    def test_null_inside_rankings_is_refused(self):
        # int(None) is TypeError inside search_ranks, raised once the phase is
        # "scoring", which is the refunded-attempt path.
        with self.assertRaises(FAILURE) as caught:
            CHECK(
                _Benchmark("language-search"),
                [{"ok": True, "kind": "search", "rankings": [[3, None]]}],
                1,
            )
        self.assertIn("rankings", str(caught.exception))

    def test_a_string_spelling_a_number_is_refused_in_embeddings(self):
        # float("nan") and np.asarray(["nan"], dtype=float) both succeed, so a
        # string leaf is the same hole as null wearing different clothes.
        with self.assertRaises(FAILURE) as caught:
            CHECK(
                _Benchmark("language-search"),
                [{"ok": True, "kind": "text", "embeddings": [["nan", "nan"]]}],
                1,
            )
        self.assertIn("a string", str(caught.exception))

    def test_the_stdlib_still_launders_the_values_this_guards_against(self):
        # Control. If either of these ever raises, the check above is guarding
        # a hole that closed and its comments are stale.
        self.assertTrue(math.isnan(float(np.asarray([[None]], dtype=np.float64)[0][0])))
        self.assertTrue(math.isnan(float(np.asarray(["nan"], dtype=np.float64)[0])))

    def test_a_null_embedding_scores_better_than_honest_work(self):
        # The measurement the refusal exists for, run against the real module
        # rather than asserted from a comment. text_first_relevant_ranks
        # excludes a caption from its own results by writing -inf on the score
        # matrix diagonal and sorting by -score. With an all-NaN matrix the
        # diagonal is the only non-NaN entry, and numpy sorts NaN after every
        # real value including +inf, so each caption ranks itself first and
        # every co-caption lands at rank 1.
        metrics = _week3_metrics()
        if metrics is None:
            self.skipTest("language_search_benchmark is not importable here")
        honest, cheat = metrics
        # The exact honest number depends on the caption count (0.3493 on the
        # 24 used here, 0.0101 on the 500 in the public-evaluation manifest),
        # so what is asserted is the relationship rather than a constant: the
        # null payload takes the maximum the metric can award, and honest work
        # on random embeddings does not come close to it.
        self.assertEqual(cheat, 1.0)
        self.assertLess(honest, 0.5)

    def test_ragged_embedding_rows_are_refused(self):
        # np.asarray raises ValueError on a ragged nested list, and an
        # uncaught raise during the scoring phase is category "scorer" with
        # infrastructure=True, which refunds the attempt.
        with self.assertRaises(FAILURE) as caught:
            CHECK(
                _Benchmark("language-search"),
                [{"ok": True, "kind": "text", "embeddings": [[1.0, 2.0], [3.0]]}],
                1,
            )
        self.assertIn("different lengths", str(caught.exception))

    def test_a_flat_list_where_a_matrix_belongs_is_refused(self):
        # A 1-D list reaches np.std(matrix, axis=0) as one dimension and
        # raises AxisError inside scoring.
        with self.assertRaises(FAILURE) as caught:
            CHECK(
                _Benchmark("language-search"),
                [{"ok": True, "kind": "text", "embeddings": [0.1, 0.2]}],
                1,
            )
        self.assertIn("row 0", str(caught.exception))
        self.assertIn("a number", str(caught.exception))

    def test_zero_width_embedding_rows_are_refused(self):
        # Measured on a 4-caption case: an all-empty text matrix scored
        # text_mrr 0.6667 where honest work scored less, because an empty row
        # makes every pair tie.
        with self.assertRaises(FAILURE) as caught:
            CHECK(
                _Benchmark("language-search"),
                [{"ok": True, "kind": "text", "embeddings": [[], []]}],
                1,
            )
        self.assertIn("is empty", str(caught.exception))

    def test_an_unhashable_leaf_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            CHECK(
                _Benchmark("language-search"),
                [{"ok": True, "kind": "text", "embeddings": [[{"a": 1}]]}],
                1,
            )
        self.assertIn("a dictionary", str(caught.exception))

    def test_week1_scores_are_not_walked(self):
        # Week 1's "scores" is not in the matrix table, and this pins that
        # choice rather than leaving it to be read as an oversight. _margin
        # calls float() on scores[0] and scores[1] only, so a bad leaf there
        # is a two-element blast radius rather than a metric-wide one, and
        # week1's driver writes the list through float() already.
        results = _week1(1)
        results[0]["scores"] = [0.9, 0.1]
        CHECK(_Benchmark("audio-identification"), results, 1)


class NumericLeafValidTests(unittest.TestCase):
    """The half that matters more: honest matrices are not refused.

    A wrongly refused submission costs a team one of three official attempts
    for work that was correct, which is worse than the score inflation the
    checks above exist to stop.
    """

    def test_ranking_rows_may_be_ragged_and_empty(self):
        # Each query returns up to k ids and fewer when the index held fewer,
        # and validate_rankings writes [] for a query that matched nothing.
        # search_ranks scores a short or empty row as a miss on purpose.
        CHECK(
            _Benchmark("language-search"),
            [{"ok": True, "kind": "search", "rankings": [[3, 1, 2], [], [7]]}],
            1,
        )

    def test_string_image_ids_are_allowed_in_rankings(self):
        # search_ranks reads them through int(), and int("3") is 3. Refusing
        # a payload that scores correctly would cost a team an attempt.
        CHECK(
            _Benchmark("language-search"),
            [{"ok": True, "kind": "search", "rankings": [["3", "1"]]}],
            1,
        )

    def test_boolean_embedding_values_are_allowed(self):
        # type(True) is bool, not int, so a bare membership test would refuse
        # these. numpy reads True as 1.0 and an all-True submission scores
        # text_mrr 0.1620 against the 0.1624 chance floor, which is an honest
        # bad score rather than an inflated one.
        CHECK(
            _Benchmark("language-search"),
            [{"ok": True, "kind": "text", "embeddings": [[True, False], [False, True]]}],
            1,
        )

    def test_integer_embedding_values_are_allowed(self):
        CHECK(
            _Benchmark("language-search"),
            [{"ok": True, "kind": "text", "embeddings": [[1, 0], [0, 1]]}],
            1,
        )

    def test_a_failed_component_carries_no_matrix_and_is_allowed(self):
        CHECK(
            _Benchmark("language-search"),
            [{"ok": False, "kind": "text", "error": "embed_text raised"}],
            1,
        )

    def test_the_real_week3_driver_output_passes(self):
        # Built the way drivers.py builds it: _rounded() returns a list of
        # lists of floats, rankings come from validate_rankings as lists of
        # ints, and mappings ride on the first output.
        CHECK(
            _Benchmark("language-search"),
            [
                {
                    "ok": True,
                    "kind": "text",
                    "embeddings": [[0.70711, 0.70711], [0.6, 0.8], [1.0, 0.0]],
                    "mappings": ["embed_text -> encode"],
                },
                {
                    "ok": True,
                    "kind": "retrieval",
                    "text": [[0.6, 0.8], [1.0, 0.0]],
                    "images": [[0.0, 1.0], [0.70711, 0.70711]],
                },
                {"ok": True, "kind": "search", "rankings": [[4, 9, 1], [2]]},
            ],
            3,
        )


class RealDriverPayloadTests(unittest.TestCase):
    """An honest submission is not refused, checked against real driver output.

    Every other valid-payload test in this file uses a literal written by
    hand, which proves the checks agree with what the test author believed the
    drivers produce. These build the payload by running a driver, so they
    disagree loudly if that belief is wrong. A wrongly refused submission
    costs a team one of three official attempts for correct work, and that is
    worse than any score inflation these checks prevent.

    Each skips rather than fails when its benchmark is not checked out, which
    is how the other suites in this directory handle the submodules.
    """

    def _serialized(self, outputs):
        """What the controller actually sees: the payload after a JSON round
        trip, since the sandbox writes the file with json.dumps."""

        return LOAD(json.dumps(outputs))

    def test_week1_driver_output_passes(self):
        sys.path.insert(0, str(ROOT / "benchmarks" / "week1"))
        try:
            from audio_identification_benchmark.checks import coerce_candidates
        except Exception:
            self.skipTest("week1 benchmark is not importable here")

        # The two shapes drivers.py writes: an enroll case and a query case.
        # The scores list is built the same way, through float().
        candidates = coerce_candidates([("song-a", 9.0), ("song-b", 2.0)], "identify")
        outputs = [
            {"ok": True, "kind": "enroll", "song_id": "song-a", "seconds": 0.01},
            {
                "ok": True,
                "kind": "query",
                "query_id": "q0",
                "candidates": list(candidates.ids),
                "scores": [float(value) for value in candidates.scores],
                "shape": candidates.shape,
                "seconds": 0.02,
            },
        ]
        payload = self._serialized(outputs)
        CHECK(_Benchmark("audio-identification"), payload, 2)

    def test_week2_clustering_driver_output_passes(self):
        sys.path.insert(0, str(ROOT / "benchmarks" / "week2"))
        try:
            from facial_recognition_benchmark.drivers import run_clustering_scenario
        except Exception:
            self.skipTest("week2 benchmark is not importable here")

        class _Scenario:
            seed = 7
            images = [object(), object(), object(), object()]

        class _Adapter:
            def __init__(self, model):
                pass

            def cluster(self, images, seed):
                # numpy integers, which the driver unwraps with .item(). This
                # is the realistic case: a student clusterer returns whatever
                # numpy handed it.
                return np.asarray([0, 0, 1, 1], dtype=np.int64)

        labels = run_clustering_scenario(_Adapter, object(), _Scenario())
        payload = self._serialized([labels])
        CHECK(_Benchmark("vision-clustering"), payload, 1)

    def test_week2_recognition_driver_output_survives_restore_and_check(self):
        sys.path.insert(0, str(ROOT / "benchmarks" / "week2"))
        try:
            from facial_recognition_benchmark.drivers import _recognition_labels
        except Exception:
            self.skipTest("week2 benchmark is not importable here")

        plan = _recognition_plan()
        # Exactly what _run_shuffled_queries returns, built by the same
        # normalizer the driver uses, including the None a submission returns
        # when it declines to name anyone.
        outputs = [
            {
                "before_enrollment": _recognition_labels(
                    ["ada", "grace", None], 3, "before"
                ),
                "after_enrollment": _recognition_labels(["grace"], 1, "after"),
            }
        ]
        restored = RESTORE(self._serialized(outputs), [plan])
        CHECK(_Benchmark("vision-recognition"), restored, 1)
        self.assertEqual(sorted(restored[0]), ["known", "post_enrollment", "unknown_before"])

    def test_week3_driver_output_passes(self):
        sys.path.insert(0, str(ROOT / "benchmarks" / "week3"))
        try:
            from language_search_benchmark.checks import (
                l2_normalize_rows,
                validate_rankings,
            )
        except Exception:
            self.skipTest("week3 benchmark is not importable here")

        generator = np.random.default_rng(2)

        def rounded(matrix):
            # drivers._rounded, which is what actually writes these fields.
            return np.round(l2_normalize_rows(matrix), 5).tolist()

        pool = [10, 11, 12, 13]
        outputs = [
            {"ok": True, "kind": "text", "embeddings": rounded(generator.normal(size=(6, 8)))},
            {
                "ok": True,
                "kind": "retrieval",
                "text": rounded(generator.normal(size=(3, 8))),
                "images": rounded(generator.normal(size=(4, 8))),
            },
            {
                "ok": True,
                "kind": "search",
                # validate_rankings truncates at k and turns a None row into
                # [], so the rows it returns are legitimately ragged.
                "rankings": validate_rankings(
                    [[12, 10], None, [11, 13, 10]], 3, pool, 2, "search"
                ),
            },
        ]
        payload = self._serialized(outputs)
        CHECK(_Benchmark("language-search"), payload, 3)
        # The ragged rows really are ragged, so this is not passing because
        # validate_rankings happened to make them uniform.
        widths = {len(row) for row in payload[2]["rankings"]}
        self.assertGreater(len(widths), 1)


class RecognitionBatchTests(unittest.TestCase):
    """The two-batch shape, checked where it is the shape that exists.

    _restore_v2_predictions runs before _check_predictions, because the check
    reads the lifecycle keys and those only exist once the shuffle is undone.
    That means the sandbox's own two-batch output is visible only inside the
    restore, so the restore is where it gets checked.

    restore_recognition_outputs reads its batches through list(), which
    coerces rather than checks: a string of the right length spreads into
    characters and clears the length guard, and the dict-of-lists that comes
    out the other side satisfies the shape table by construction.
    """

    def _plan(self):
        return _recognition_plan()

    def test_string_batches_are_refused(self):
        with self.assertRaises(FAILURE) as caught:
            RESTORE([{"before_enrollment": "abc", "after_enrollment": "d"}], [self._plan()])
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertIn("before_enrollment", str(caught.exception))
        self.assertIn("a string", str(caught.exception))

    def test_dict_batches_are_refused(self):
        with self.assertRaises(FAILURE) as caught:
            RESTORE(
                [{"before_enrollment": {"a": 1, "b": 2, "c": 3}, "after_enrollment": ["d"]}],
                [self._plan()],
            )
        self.assertIn("a dictionary", str(caught.exception))

    def test_the_coercion_this_guards_against_still_happens(self):
        # Control, run against the real function. If restore ever starts
        # checking its own batch types, this test fails and the guard above
        # has become a second opinion rather than the only one.
        from cogworks_runner.week2_payload import restore_recognition_outputs

        restored = restore_recognition_outputs(
            self._plan(), {"before_enrollment": "abc", "after_enrollment": "d"}
        )
        self.assertEqual(
            restored,
            {"known": ["a", "c"], "unknown_before": ["b"], "post_enrollment": ["d"]},
        )
        # And the laundered result satisfies the shape table, which is why the
        # check has to happen before the restore rather than after it.
        CHECK(_Benchmark("vision-recognition"), [restored], 1)

    def test_an_honest_scenario_survives_the_restore(self):
        restored = RESTORE(
            [{"before_enrollment": ["ada", "grace", None], "after_enrollment": ["grace"]}],
            [self._plan()],
        )
        self.assertEqual(
            restored,
            [{"known": ["ada", None], "unknown_before": ["grace"], "post_enrollment": ["grace"]}],
        )

    def test_a_non_dict_scenario_is_refused(self):
        with self.assertRaises(FAILURE) as caught:
            RESTORE([["ada", "grace", None]], [self._plan()])
        self.assertEqual(caught.exception.category, "output_invalid")

    def test_clustering_passes_through_untouched(self):
        # Clustering carries no plans and has nothing to un-permute.
        payload = [[0, 0, 1], ["a", "a", "b"]]
        self.assertEqual(RESTORE(payload, []), payload)

    def test_a_count_mismatch_is_left_to_the_count_check(self):
        # One message for one fault: _check_predictions owns the count and
        # words it for the reader, so the restore returns early rather than
        # raising a second, worse-worded refusal.
        honest = {"before_enrollment": ["ada", "grace", None], "after_enrollment": ["grace"]}
        plan = self._plan()
        self.assertEqual(RESTORE([honest], [plan, plan]), [honest])
        with self.assertRaises(FAILURE) as caught:
            CHECK(_Benchmark("vision-recognition"), [honest], 2)
        self.assertIn("1 results for 2 cases", str(caught.exception))


class WiringTests(unittest.TestCase):
    """Structural guards, so a later change fails here rather than in a run."""

    def test_every_read_of_the_predictions_file_goes_through_the_hooks(self):
        # Four evaluate lanes read this file. A bare json.loads on any of them
        # is a lane where NaN and Infinity get back in.
        #
        # Matched on the AST rather than on source text. The previous version
        # counted a literal string carrying a newline and twelve spaces of
        # indentation, so reformatting one of the four calls onto a single
        # line reddened the test while the code stayed correct. What matters
        # is that every read is an argument to _load_predictions, and that is
        # a shape question, not a whitespace one.
        reads = 0
        wrapped = 0
        for node in ast.walk(ast.parse(SOURCE)):
            if not isinstance(node, ast.Call):
                continue
            if not any(
                isinstance(argument, ast.Constant)
                and argument.value == "/tmp/cog-predictions.json"
                for argument in node.args
            ):
                continue
            reads += 1
            parent = _enclosing_call(SOURCE, node)
            if parent is not None and getattr(parent.func, "id", None) == "_load_predictions":
                wrapped += 1
        self.assertEqual(reads, 4, "expected four reads of the predictions file")
        self.assertEqual(wrapped, reads, "a read bypasses _load_predictions")

    def test_no_validation_lives_inside_the_sandbox_script(self):
        # EVALUATE_SCRIPT is a source string executed inside the sandbox, in
        # the student's own process. Its counts and its 8 MiB cap are advice
        # that produces a better error message sooner; they are not the check.
        # A module-level atexit handler runs after the script's final write,
        # so the bytes the controller reads are whatever that handler left
        # behind. Anything load-bearing that drifted into this string would be
        # a check the submission can delete, so this fails if one does.
        script = None
        for node in ast.parse(SOURCE).body:
            if isinstance(node, ast.Assign) and any(
                getattr(target, "id", None) == "EVALUATE_SCRIPT" for target in node.targets
            ):
                script = node.value.value
        self.assertIsNotNone(script, "EVALUATE_SCRIPT is no longer a plain string constant")
        for name in (
            "_check_predictions",
            "_check_matrix_field",
            "_load_predictions",
            "_refuse_output",
            "_restore_v2_predictions",
            "output_invalid",
            "_V2_PREDICTION_SHAPES",
            "_NUMERIC_MATRIX_FIELDS",
            "_RECOGNITION_BATCHES",
            "parse_constant",
            "parse_float",
            "_NonFiniteNumber",
        ):
            self.assertNotIn(name, script, "{} moved into the sandbox".format(name))

    def test_the_matrix_walk_runs_on_every_field_that_reaches_numpy(self):
        # The shape table lists the fields scoring iterates; the matrix table
        # lists the ones handed to numpy. Every entry in the second has to
        # appear in the first, or the walk is registered for a field the field
        # loop never visits and silently does nothing.
        declared = set()
        for _element_type, fields, _item_types in SHAPES.values():
            declared.update(fields)
        self.assertEqual(set(MATRIX_FIELDS) - declared, set())

    def test_the_batch_check_names_the_keys_the_sandbox_actually_writes(self):
        # _RECOGNITION_BATCHES has to match what run_recognition_scenario
        # returns from the shuffled path, or the check reads keys that are
        # never present and passes everything.
        drivers = (
            ROOT / "benchmarks" / "week2" / "facial_recognition_benchmark" / "drivers.py"
        )
        if not drivers.exists():
            self.skipTest("week2 benchmark is not checked out here")
        text = drivers.read_text(encoding="utf-8")
        self.assertIn(
            '{"before_enrollment": before, "after_enrollment": after}',
            text,
            "the sandbox no longer writes the batch keys this check reads",
        )
        self.assertEqual(
            set(NS["_RECOGNITION_BATCHES"]), {"before_enrollment", "after_enrollment"}
        )

    def test_check_runs_before_the_phase_becomes_scoring(self):
        # Order is what decides who gets blamed. Once phase is "scoring",
        # execute_job's handler turns any non-RunnerFailure into category
        # "scorer" with infrastructure=True, which refunds the attempt.
        check_at = SOURCE.index("_check_predictions(benchmark, predictions, case_count)")
        phase_at = SOURCE.index('phase = "scoring"')
        self.assertLess(check_at, phase_at)

    def test_refusal_consumes_the_attempt(self):
        # output_invalid is in CONSUMING_FAILURES in both runner-events.ts and
        # sync.ts, and infrastructure=False is the other half of that
        # decision. A refusal that refunds the attempt is the free retry this
        # check exists to close.
        failure = NS["_refuse_output"]("anything")
        self.assertEqual(failure.category, "output_invalid")
        self.assertFalse(failure.infrastructure)
        self.assertEqual(failure.phase, "evaluating")

        for path in (
            ROOT / "apps" / "portal" / "worker" / "routes" / "runner-events.ts",
            ROOT / "apps" / "portal" / "worker" / "execution" / "sync.ts",
        ):
            text = path.read_text(encoding="utf-8")
            block = text.split("CONSUMING_FAILURES", 1)[1].split("]", 1)[0]
            self.assertIn("output_invalid", block, path.name)

    def test_every_registered_v2_benchmark_has_a_declared_shape(self):
        # A week added later without an entry still gets the count check, and
        # that is a deliberate fallback rather than a silent one. This test is
        # where the omission surfaces.
        registered = set()
        for pyproject in (ROOT / "benchmarks").glob("*/pyproject.toml"):
            text = pyproject.read_text(encoding="utf-8")
            if '[project.entry-points."cogworks.benchmarks.v2"]' not in text:
                continue
            section = text.split('[project.entry-points."cogworks.benchmarks.v2"]', 1)[1]
            section = section.split("\n[", 1)[0]
            for line in section.splitlines():
                if "=" in line and not line.strip().startswith("#"):
                    registered.add(line.split("=", 1)[0].strip())
        self.assertTrue(registered, "no v2 benchmarks found under benchmarks/")
        self.assertEqual(registered - set(SHAPES), set())

    def test_no_em_dashes_in_the_refusal_copy(self):
        # docs/design/voice.md rules them out of anything a student reads, and
        # the details built here are student-facing. Checked against the real
        # messages rather than the file, so this cannot pass by inspecting
        # code that never runs.
        def search(rankings):
            return [{"ok": True, "kind": "search", "rankings": rankings}]

        def text(embeddings):
            return [{"ok": True, "kind": "text", "embeddings": embeddings}]

        messages = []
        for call in (
            lambda: CHECK(_Benchmark("audio-identification"), _week1(1), 4),
            lambda: CHECK(_Benchmark("audio-identification"), [["a"]], 1),
            lambda: CHECK(_Benchmark("vision-clustering"), [[["a"]]], 1),
            lambda: CHECK(_Benchmark("vision-recognition"), [{"known": "ab"}], 1),
            lambda: LOAD("[NaN]"),
            lambda: LOAD('{"a": 1}'),
            # Every message the leaf walk and the batch check can produce.
            lambda: CHECK(_Benchmark("language-search"), text([[1.0, None]]), 1),
            lambda: CHECK(_Benchmark("language-search"), text([[1.0, 2.0], [3.0]]), 1),
            lambda: CHECK(_Benchmark("language-search"), text([0.1, 0.2]), 1),
            lambda: CHECK(_Benchmark("language-search"), text([[], []]), 1),
            lambda: CHECK(_Benchmark("language-search"), search([[None]]), 1),
            lambda: RESTORE(
                [{"before_enrollment": "abc", "after_enrollment": ["d"]}],
                [_recognition_plan()],
            ),
            lambda: RESTORE([["a", "b"]], [_recognition_plan()]),
        ):
            with self.assertRaises(FAILURE) as caught:
                call()
            messages.append(str(caught.exception))
        self.assertEqual(len(messages), 13)
        for message in messages:
            self.assertNotIn("—", message, message)
            self.assertNotIn("–", message, message)
            # The wire caps detail at 240 characters (protocol.ts), and a
            # refusal truncated mid-sentence loses the half that helps.
            self.assertLessEqual(len(message), 240, message)


if __name__ == "__main__":
    unittest.main()
