from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from cogbench.models import Metric
from cogbench.runner import execute


class _Benchmark:
    benchmark_id = "vision-recognition"
    benchmark_version = 1
    contract_version = "cogworks.submissions.v1"
    plugin_version = "0.1.0"

    def public_cases(self):
        return [{"input": "face", "expected": "ada"}]

    def score(self, predictions, expected):
        self.assertions = (predictions, expected)
        return [Metric("f1", "F1", 1.0, None, True, True, 3)], []


class _Submission:
    def predict(self, inputs):
        return ["ada" for _ in inputs]


class RunnerProgressTests(unittest.TestCase):
    def test_progress_reports_only_stable_public_phases(self):
        phases = []
        with tempfile.TemporaryDirectory() as directory:
            report = execute(
                _Benchmark(),
                _Submission(),
                Path(directory),
                progress=phases.append,
            )
        self.assertEqual(phases, ["contract_check", "evaluating", "scoring"])
        self.assertEqual(report.metrics[0].value, 1.0)


if __name__ == "__main__":
    unittest.main()
