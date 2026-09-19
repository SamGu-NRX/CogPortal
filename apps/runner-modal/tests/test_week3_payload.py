from __future__ import annotations

import io
import json
import sys
import unittest
import zipfile
from importlib.util import find_spec
from pathlib import Path

try:
    import numpy as np
except ImportError:
    np = None

# `cogworks_runner` is not a published package; the sandbox image mounts it at
# /opt/runner. Insert it here rather than relying on the week2 payload test
# (which sorts first) to have done it as an import side effect.
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))
# And the benchmark whose payload these tests check. test_week2_payload.py
# already did this for its own week; leaving it out here meant four tests
# reported as ordinary failures on any interpreter without the Week 3 package
# installed, which reads as broken code rather than a missing install. Week 3
# is a flat-layout package (benchmarks/week3/language_search_benchmark), not
# the src layout Week 2 uses.
sys.path.insert(0, str(ROOT / "benchmarks" / "week3"))


def _cases():
    from language_search_benchmark.datasets import RetrievalCase, SearchCase, TextCase

    descriptors = np.arange(12, dtype=np.float32).reshape(3, 4)
    return [
        TextCase(
            kind="text",
            captions=["a dog", "another dog", "a cat"],
            group_rows=[0, 0, 1],
            tie_break_seed=7,
        ),
        RetrievalCase(
            kind="retrieval",
            queries=["a dog", "a cat"],
            descriptors=descriptors,
            gold_rows=[0, 2],
            tie_break_seed=7,
        ),
        SearchCase(
            kind="search",
            queries=["a dog", "a cat"],
            image_ids=[10, 20, 30],
            descriptors=descriptors.copy(),
            gold_image_ids=[10, 30],
            k=2,
            tie_break_seed=7,
        ),
    ]


@unittest.skipIf(
    np is None or find_spec("language_search_benchmark") is None,
    "Week 3 dependency lane only",
)
class Week3PayloadTest(unittest.TestCase):
    def test_gold_never_serialized(self):
        from cogworks_runner.week3_payload import encode_payload

        payload = encode_payload("language-search", _cases(), showcase=False)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            metadata = json.loads(archive.read("metadata.json"))
        flattened = json.dumps(metadata)
        self.assertNotIn("gold", flattened)
        self.assertNotIn("group_rows", flattened)
        # The gold image ids for search are a subset of the (public) pool
        # ids, but no per-query mapping may exist anywhere in the payload.
        self.assertNotIn("gold_image_ids", flattened)

    def test_roundtrip_is_deterministic_and_gold_free(self):
        from cogworks_runner.week3_payload import decode_payload, encode_payload

        first = encode_payload("language-search", _cases(), showcase=True)
        second = encode_payload("language-search", _cases(), showcase=True)
        self.assertEqual(first, second)
        benchmark_id, showcase, cases = decode_payload(first)
        self.assertEqual(benchmark_id, "language-search")
        self.assertTrue(showcase)
        self.assertIsNone(cases[0].group_rows)
        self.assertIsNone(cases[1].gold_rows)
        self.assertIsNone(cases[2].gold_image_ids)
        self.assertEqual(cases[1].descriptors.dtype, np.float32)
        np.testing.assert_array_equal(cases[1].descriptors, _cases()[1].descriptors)

    def test_extract_and_attach_gold_roundtrip(self):
        from language_search_benchmark.datasets import attach_gold
        from cogworks_runner.week3_payload import (
            decode_payload,
            encode_payload,
            extract_gold,
        )

        original = _cases()
        gold = extract_gold(original)
        _, _, stripped = decode_payload(
            encode_payload("language-search", original, showcase=False)
        )
        restored = attach_gold(stripped, **gold)
        self.assertEqual(restored[0].group_rows, [0, 0, 1])
        self.assertEqual(restored[1].gold_rows, [0, 2])
        self.assertEqual(restored[2].gold_image_ids, [10, 30])

    def test_attach_gold_count_mismatch_fails(self):
        from language_search_benchmark.datasets import attach_gold
        from cogworks_runner.week3_payload import decode_payload, encode_payload

        _, _, stripped = decode_payload(
            encode_payload("language-search", _cases(), showcase=False)
        )
        with self.assertRaises(ValueError):
            attach_gold(
                stripped,
                text_group_rows=[0],
                retrieval_gold_rows=[0, 2],
                search_gold_image_ids=[10, 30],
            )


if __name__ == "__main__":
    unittest.main()


class RungCasesSurviveTheBoundary(unittest.TestCase):
    """The query rewrites are regenerated in the sandbox rather than shipped.

    Each rewrite is a pure function of the caption and its position, so the
    sandbox can derive them from the queries it already has. Shipping them
    would grow the payload by one full query list per rung for no gain, and
    would let the two sides disagree.
    """

    def _cases(self):
        """The controller's grid, from the benchmark's constructor.

        Hand-building it here was a third copy of the thing `build_cases`
        exists to hold, and the version that omitted the retrieval rewrites is
        what let these tests agree with a decoder that omitted them too.
        """

        from language_search_benchmark.datasets import attach_gold, build_cases

        queries = ["A man riding a horse", "Two cats on a bed", "A red bus downtown"]
        return attach_gold(
            build_cases(
                text_captions=queries,
                queries=queries,
                pool_image_ids=[10, 11, 12],
                pool_descriptors=np.zeros((3, 512), dtype=np.float32),
                tie_break_seed=7,
                search_k=3,
            ),
            text_group_rows=[0, 1, 2],
            retrieval_gold_rows=[0, 1, 2],
            search_gold_image_ids=[10, 11, 12],
        )

    def test_the_sandbox_runs_the_same_cases_the_controller_scores(self):
        """The zip carries enough to rebuild the grid it was made from.

        Both sides call `build_cases` now, so this no longer guards against two
        builders drifting; the benchmark owns that. What it still catches is a
        metadata field dropped or renamed in `encode_payload`, which would
        rebuild a different grid from the same cases.
        """

        from cogworks_runner.week3_payload import decode_payload, encode_payload

        cases = self._cases()
        _id, _showcase, rebuilt = decode_payload(
            encode_payload("language-search", cases, showcase=False)
        )
        shape = [(c.kind, getattr(c, "rung", "verbatim")) for c in cases]
        self.assertEqual(
            [(c.kind, getattr(c, "rung", "verbatim")) for c in rebuilt], shape
        )


    def test_the_sandbox_derives_the_same_queries_the_controller_built(self):
        from cogworks_runner.week3_payload import decode_payload, encode_payload

        cases = self._cases()
        _id, _showcase, rebuilt = decode_payload(
            encode_payload("language-search", cases, showcase=False)
        )
        # Every kind, not just search: retrieval carries the same rewrites, and
        # checking one kind lets the other be rebuilt with the wrong queries.
        def texts(case):
            return (
                case.kind,
                getattr(case, "rung", "verbatim"),
                list(getattr(case, "queries", None) or case.captions),
            )

        self.assertEqual([texts(c) for c in cases], [texts(c) for c in rebuilt])

    def test_the_scored_component_is_the_verbatim_case_not_the_last_one(self):
        """A plain by-kind dict keeps whichever search case came last, which
        would silently make the typo rung the scored component."""

        from cogworks_runner.week3_payload import decode_payload, encode_payload

        cases = self._cases()
        _id, _showcase, rebuilt = decode_payload(
            encode_payload("language-search", cases, showcase=False)
        )
        verbatim = next(c for c in rebuilt if c.kind == "search" and c.rung == "verbatim")
        self.assertEqual(verbatim.queries, ["A man riding a horse", "Two cats on a bed", "A red bus downtown"])

    def test_no_rung_query_reaches_the_sandbox_carrying_gold(self):
        from cogworks_runner.week3_payload import decode_payload, encode_payload

        cases = self._cases()
        _id, _showcase, rebuilt = decode_payload(
            encode_payload("language-search", cases, showcase=False)
        )
        for case in rebuilt:
            if case.kind == "search":
                self.assertIsNone(case.gold_image_ids, "gold must not cross the boundary")
            if case.kind == "retrieval":
                self.assertIsNone(case.gold_rows, "gold must not cross the boundary")
            if case.kind == "text":
                self.assertIsNone(case.group_rows, "gold must not cross the boundary")


    def test_attach_gold_preserves_the_shared_pool_objects(self):
        """Gold is re-attached with dataclasses.replace, which copies the
        fields it is not changing by reference. If that ever stopped holding,
        the index guard would break after scoring re-attached cases."""

        from language_search_benchmark.datasets import attach_gold
        from cogworks_runner.week3_payload import (
            decode_payload, encode_payload, extract_gold,
        )

        cases = self._cases()
        _id, _showcase, rebuilt = decode_payload(
            encode_payload("language-search", cases, showcase=False)
        )
        restored = attach_gold(rebuilt, **extract_gold(cases))
        searches = [c for c in restored if c.kind == "search"]
        verbatim = next(c for c in searches if c.rung == "verbatim")
        for case in searches:
            self.assertIs(case.image_ids, verbatim.image_ids, case.rung)
            self.assertIs(case.descriptors, verbatim.descriptors, case.rung)

    def test_attach_gold_gives_every_rung_the_same_answers(self):
        """The rewrites change the query text, never which image is correct."""

        from language_search_benchmark.datasets import attach_gold
        from cogworks_runner.week3_payload import (
            decode_payload, encode_payload, extract_gold,
        )

        cases = self._cases()
        _id, _showcase, rebuilt = decode_payload(
            encode_payload("language-search", cases, showcase=False)
        )
        restored = attach_gold(rebuilt, **extract_gold(cases))
        from language_search_benchmark import perturb

        searches = [c for c in restored if c.kind == "search"]
        self.assertEqual(len(searches), len(perturb.RUNGS))
        for case in searches:
            self.assertEqual(case.gold_image_ids, [10, 11, 12])
