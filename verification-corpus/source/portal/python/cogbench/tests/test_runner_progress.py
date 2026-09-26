from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cogbench.cli import _LiveRun, _live_progress_payload
from cogbench.models import Metric
from cogbench.runner import ContractError, _execute_v2, execute


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


class _V2Benchmark:
    benchmark_id = "vision-recognition"
    benchmark_version = 2
    contract_version = "cogworks.submissions.v2"
    plugin_version = "0.1.0"
    primary_metric = "recognition_score"

    def load_cases(self, tier):
        self.tier = tier
        return ["case"]

    def run(self, factory, model, cases):
        self.factory = factory
        self.model = model
        return [{"known": ["person"]}]

    def score(self, outputs, cases):
        return {
            "known_identification": 1.0,
            "unknown_lifecycle": 0.5,
            "recognition_score": 0.75,
        }


class RunnerProgressTests(unittest.TestCase):
    def test_evaluation_heartbeat_does_not_claim_progress_before_it_advances(self):
        self.assertEqual(
            _live_progress_payload("evaluating", 0, 3),
            {
                "type": "progress",
                "phase": "evaluating",
                "code": "evaluation.started",
                "progress": {"current": 0, "total": 3, "unit": "cases"},
            },
        )
        self.assertEqual(
            _live_progress_payload("evaluating", 3, 3)["code"],
            "evaluation.progress",
        )

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

    def test_terminal_batch_survives_a_saturated_progress_history(self):
        with patch("cogbench.cli.send_local_run_event", return_value={"ok": True}):
            with patch(
                "cogbench.cli.send_local_run_event_batch", return_value={"ok": True}
            ) as batch:
                live = _LiveRun("https://portal.example", "device-token", "localrun_test")
                for current in range(40):
                    live.progress("evaluating", current, 40)
                live.failed(RuntimeError("private terminal detail"))
                live._sender.join(timeout=1)
                live._heartbeat.join(timeout=1)

        events = batch.call_args.args[3]
        self.assertLessEqual(len(events), 32)
        self.assertEqual([event["sequence"] for event in events], sorted(event["sequence"] for event in events))
        self.assertEqual(events[-1]["type"], "failed")
        self.assertEqual(events[-1]["code"], "run.failed.runtime")
        self.assertNotIn("detail", events[-1])

    def test_v2_runner_uses_raw_factory_and_benchmark_driver(self):
        benchmark = _V2Benchmark()
        factory = object()
        model = object()
        with tempfile.TemporaryDirectory() as directory:
            report = _execute_v2(
                benchmark,
                factory,
                Path(directory),
                smoke=True,
                progress=None,
                model_factory=lambda: model,
            )
        self.assertEqual(benchmark.tier, "test")
        self.assertIs(benchmark.factory, factory)
        self.assertIs(benchmark.model, model)
        self.assertEqual(report.benchmark_version, 2)
        self.assertEqual(
            [metric.key for metric in report.metrics if metric.primary],
            ["recognition_score"],
        )

    def test_v2_runner_rejects_missing_scenario_outputs(self):
        benchmark = _V2Benchmark()
        benchmark.run = lambda _factory, _model, _cases: []
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ContractError, "1 cases"):
                _execute_v2(
                    benchmark,
                    object(),
                    Path(directory),
                    smoke=True,
                    progress=None,
                    model_factory=object,
                )


if __name__ == "__main__":
    unittest.main()
