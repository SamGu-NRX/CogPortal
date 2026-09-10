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
        from cogworks_runner.week3_payload import (
            attach_gold,
            decode_payload,
            encode_payload,
            extract_gold,
        )

        original = _cases()
        gold = extract_gold(original)
        _, _, stripped = decode_payload(
            encode_payload("language-search", original, showcase=False)
        )
        restored = attach_gold(stripped, gold)
        self.assertEqual(restored[0].group_rows, [0, 0, 1])
        self.assertEqual(restored[1].gold_rows, [0, 2])
        self.assertEqual(restored[2].gold_image_ids, [10, 30])

    def test_attach_gold_count_mismatch_fails(self):
        from cogworks_runner.week3_payload import (
            attach_gold,
            decode_payload,
            encode_payload,
        )

        _, _, stripped = decode_payload(
            encode_payload("language-search", _cases(), showcase=False)
        )
        with self.assertRaises(ValueError):
            attach_gold(
                stripped,
                {
                    "text_group_rows": [0],
                    "retrieval_gold_rows": [0, 2],
                    "search_gold_image_ids": [10, 30],
                },
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
        from language_search_benchmark.datasets import SearchCase, TextCase, RetrievalCase

        descriptors = np.zeros((3, 512), dtype=np.float32)
        queries = ["A man riding a horse", "Two cats on a bed", "A red bus downtown"]
        base = [
            TextCase(kind="text", captions=list(queries), group_rows=[0, 1, 2], tie_break_seed=7),
            RetrievalCase(
                kind="retrieval", queries=list(queries), descriptors=descriptors,
                gold_rows=[0, 1, 2], tie_break_seed=7,
            ),
            SearchCase(
                kind="search", queries=list(queries), image_ids=[10, 11, 12],
                descriptors=descriptors, gold_image_ids=[10, 11, 12], k=3, tie_break_seed=7,
            ),
        ]
        from language_search_benchmark import perturb

        base += [
            SearchCase(
                kind="search", queries=perturb.rewrite_all(queries, rung),
                image_ids=[10, 11, 12], descriptors=descriptors,
                gold_image_ids=[10, 11, 12], k=3, tie_break_seed=7, rung=rung,
            )
            for rung in perturb.RUNGS
            if rung != "verbatim"
        ]
        return base

    def test_the_sandbox_derives_the_same_queries_the_controller_built(self):
        from cogworks_runner.week3_payload import decode_payload, encode_payload

        cases = self._cases()
        _id, _showcase, rebuilt = decode_payload(
            encode_payload("language-search", cases, showcase=False)
        )
        controller = {c.rung: c.queries for c in cases if c.kind == "search"}
        sandbox = {c.rung: c.queries for c in rebuilt if c.kind == "search"}
        self.assertEqual(controller, sandbox)

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

    def test_attach_gold_gives_every_rung_the_same_answers(self):
        """The rewrites change the query text, never which image is correct."""

        from cogworks_runner.week3_payload import (
            attach_gold, decode_payload, encode_payload, extract_gold,
        )

        cases = self._cases()
        _id, _showcase, rebuilt = decode_payload(
            encode_payload("language-search", cases, showcase=False)
        )
        restored = attach_gold(rebuilt, extract_gold(cases))
        searches = [c for c in restored if c.kind == "search"]
        self.assertEqual(len(searches), 4)
        for case in searches:
            self.assertEqual(case.gold_image_ids, [10, 11, 12])
