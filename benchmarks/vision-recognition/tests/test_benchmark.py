import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))
sys.path.insert(0, str(ROOT / "benchmarks" / "vision-recognition" / "src"))

from cogworks_vision_benchmark import VisionRecognitionBenchmark


class BenchmarkTests(unittest.TestCase):
    def test_public_cases_and_scorer_are_deterministic(self):
        benchmark = VisionRecognitionBenchmark()
        cases = benchmark.public_cases()
        expected = [case["expected"] for case in cases]
        metrics, diagnostics = benchmark.score(expected, expected)
        self.assertEqual(len(cases), 3)
        self.assertEqual(metrics[0].value, 1.0)
        self.assertTrue(metrics[0].primary)
        self.assertEqual(diagnostics, [])


if __name__ == "__main__":
    unittest.main()
