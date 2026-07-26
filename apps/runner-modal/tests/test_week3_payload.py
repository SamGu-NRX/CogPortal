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
