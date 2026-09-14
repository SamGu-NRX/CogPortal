"""Saved reports must retain metric meaning when sync serializes them again."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cogbench.models import LocalReport, Metric, RepositoryState


class SavedMetricRoles(unittest.TestCase):
    def report(self, weights):
        return LocalReport.create(
            benchmark_id="audio-identification",
            benchmark_version=1,
            contract_version="cogworks.submissions.v2",
            sdk_version="0.2.0",
            plugin_version="0.1.0",
            repository=RepositoryState(42, "course/team", "a" * 40, False),
            started_at=1,
            finished_at=2,
            metrics=[
                Metric("score", "Score", 0.5, None, True, True, 3),
                Metric("chance", "Chance", 0.03, None, True, False, 3,
                       help="The dataset's chance floor.", role="floor", relates_to="score"),
                Metric("duration", "Duration", 0.1, "s", False, False, 3,
                       role="reported"),
                Metric("coverage", "Coverage", 1.0, None, True, False, 3,
                       role="diagnostic", relates_to="score"),
                Metric("explicit", "Explicit score", 0.5, None, True, False, 3,
                       role="scored"),
            ],
            diagnostics=["Synthetic report; no benchmark was scored."],
            predictions=[],
            weights_used=weights,
        )

    def test_saved_report_reserialization_preserves_roles_and_weights(self):
        # sync loads LocalReport.from_json, then sends its serialized wire fields.
        for weights in ([], ["models/fingerprints.pkl", "models/projection.npy"]):
            with self.subTest(weights=weights):
                report = self.report(weights)
                saved = report.to_json()
                restored = LocalReport.from_json(saved)
                self.assertEqual(restored.metrics, report.metrics)
                self.assertEqual(restored.weights_used, weights)
                self.assertEqual(json.loads(restored.to_json()), json.loads(saved))
                self.assertEqual(restored.to_wire(), report.to_wire())
                self.assertIn("weightsUsed", restored.to_wire())

    def test_older_reports_without_optional_metadata_still_load(self):
        wire = json.loads(self.report([]).to_json())
        for metric in wire["metrics"]:
            metric.pop("role", None)
            metric.pop("relatesTo", None)
        restored = LocalReport.from_json(json.dumps(wire))
        self.assertTrue(all(metric.role is None for metric in restored.metrics))
        self.assertTrue(all(metric.relates_to is None for metric in restored.metrics))
        self.assertEqual(json.loads(restored.to_json()), wire)

    def test_null_optional_metadata_is_not_converted_to_a_string(self):
        wire = json.loads(self.report([]).to_json())
        for metric in wire["metrics"]:
            metric["role"] = None
            metric["relatesTo"] = None
        restored = LocalReport.from_json(json.dumps(wire))
        for metric in restored.metrics:
            self.assertIsNone(metric.role)
            self.assertIsNone(metric.relates_to)
            self.assertNotIn("role", metric.to_wire())
            self.assertNotIn("relatesTo", metric.to_wire())


if __name__ == "__main__":
    unittest.main()
