import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))
sys.path.insert(0, str(ROOT / "benchmarks" / "vision-recognition" / "src"))

from cogbench.models import LocalReport, Metric, RepositoryState
from cogbench.runner import execute
from cogworks_vision_benchmark import VisionRecognitionBenchmark


class ReferenceAdapter:
    def predict(self, inputs):
        predictions = []
        for item in inputs:
            vector = item["embedding"]
            references = item["references"]
            scores = {
                name: sum(left * right for left, right in zip(vector, reference))
                for name, reference in references.items()
            }
            name, score = max(scores.items(), key=lambda entry: entry[1])
            predictions.append(name if score >= 0.75 else "unknown")
        return predictions


class LocalReportTests(unittest.TestCase):
    def test_wire_payload_omits_local_paths_and_output_digest(self):
        report = LocalReport.create(
            benchmark_id="vision-recognition",
            benchmark_version=1,
            contract_version="cogworks.submissions.v1",
            sdk_version="0.1.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "course/team", "a" * 40, False),
            started_at=1,
            finished_at=2,
            metrics=[Metric("accuracy", "Accuracy", 1.0, None, True, True, 3)],
            diagnostics=[],
            predictions=["ada"],
        )
        payload = report.to_wire()
        self.assertNotIn("outputDigest", payload)
        self.assertNotIn("path", json.dumps(payload).lower())
        self.assertEqual(payload["sha"], "a" * 40)

    def test_wrapping_reserves_a_line_for_each_retained_diagnostic(self):
        diagnostics = ["Early detail. " * 100] + ["Cause {}".format(i) for i in range(1, 32)]
        report = self._with_diagnostics(diagnostics + ["Outside the record limit"])
        self.assertEqual(len(report.diagnostics), 32)
        self.assertEqual(report.diagnostics[1:], diagnostics[1:])
        self.assertTrue(all(len(line) <= 240 for line in report.diagnostics))

    def test_spare_wire_lines_preserve_long_notes_without_displacing_later_records(self):
        report = self._with_diagnostics(["Early detail. " * 1000, "Later cause"])
        self.assertEqual(len(report.diagnostics), 32)
        self.assertEqual(report.diagnostics[-1], "Later cause")
        self.assertTrue(all(len(line) <= 240 for line in report.diagnostics))

    def _with_diagnostics(self, diagnostics):
        return LocalReport.create(
            benchmark_id="vision-recognition", benchmark_version=1,
            contract_version="cogworks.submissions.v1", sdk_version="0.1.0",
            plugin_version="0.1.0", repository=RepositoryState(None, None, None, False),
            started_at=1, finished_at=2, metrics=[], diagnostics=diagnostics, predictions=[],
        )

    def test_report_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            report = execute(
                VisionRecognitionBenchmark(),
                ReferenceAdapter(),
                Path(directory),
            )
            restored = LocalReport.from_json(report.to_json())
        self.assertEqual(restored.report_id, report.report_id)
        self.assertEqual(restored.metrics[0].value, 1.0)
        self.assertEqual(len(restored.output_digest), 64)


if __name__ == "__main__":
    unittest.main()
