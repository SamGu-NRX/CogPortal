from __future__ import annotations

import sys
import unittest
from importlib.util import find_spec
from pathlib import Path

try:
    import numpy as np
except ImportError:
    np = None

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))
sys.path.insert(0, str(ROOT / "benchmarks" / "week2" / "src"))


def _has(module: str) -> bool:
    """Whether `module` can actually be imported. Naming the submodule the
    tests import matters: a leftover `week2/src/facial_recognition_benchmark`
    directory with no `__init__.py` makes the parent resolve as a namespace
    package while every real module under it is missing."""

    try:
        return find_spec(module) is not None
    except (ImportError, ValueError):
        return False


@unittest.skipIf(
    np is None
    or find_spec("PIL") is None
    or not _has("facial_recognition_benchmark.drivers"),
    "Week 2 dependency lane only",
)
class Week2PayloadTests(unittest.TestCase):
    def test_clustering_payload_excludes_expected_labels(self):
        from cogworks_runner.week2_payload import decode_cases, encode_cases
        from facial_recognition_benchmark.drivers import ClusteringScenario

        case = ClusteringScenario(
            images=[np.zeros((2, 2, 3), dtype=np.uint8)],
            expected_labels=["secret-person"],
            seed=7,
        )
        encoded = encode_cases("vision-clustering", [case])
        self.assertNotIn(b"secret-person", encoded)
        benchmark_id, decoded = decode_cases(encoded)
        self.assertEqual(benchmark_id, "vision-clustering")
        self.assertEqual(decoded[0].expected_labels, [])
        self.assertEqual(decoded[0].seed, 7)


if __name__ == "__main__":
    unittest.main()
