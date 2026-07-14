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
