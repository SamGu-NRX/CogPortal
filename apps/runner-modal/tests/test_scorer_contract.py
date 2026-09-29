"""Unit-test the controller's scorer guard, without dispatching or dequeuing jobs."""

import ast
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / "src/cogworks_runner/modal_app.py"


def controller_contract():
    # Compile the actual guard without importing Modal or constructing its images.
    module = ast.parse(SOURCE.read_text(encoding="utf-8"))
    names = {"RunnerFailure", "_load_benchmark"}
    definitions = [
        node for node in module.body
        if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names
    ]
    assert {node.name for node in definitions} == names
    namespace = {}
    future = ast.parse("from __future__ import annotations").body
    source = ast.Module(body=future + definitions, type_ignores=[])
    exec(compile(source, str(SOURCE), "exec"), namespace)
    return namespace["_load_benchmark"], namespace["RunnerFailure"]


class ScorerContractTests(unittest.TestCase):
    def check_versions(self, job_version, runner_version):
        load, failure = controller_contract()
        benchmark = types.SimpleNamespace(
            benchmark_id="vision-recognition",
            benchmark_version=2,
            contract_version="cogworks.submissions.v2",
            plugin_version="test-plugin",
            scorer_version=runner_version,
        )
        plugins = types.ModuleType("cogbench.plugins")
        plugins.load_benchmark = lambda _name: benchmark
        job = {"benchmark": {
            "id": benchmark.benchmark_id,
            "version": benchmark.benchmark_version,
            "contractVersion": benchmark.contract_version,
            "pluginVersion": benchmark.plugin_version,
            "scorerVersion": job_version,
        }}
        with patch.dict(sys.modules, {"cogbench.plugins": plugins}):
            if job_version == runner_version:
                self.assertIs(load(job), benchmark)
            else:
                with self.assertRaises(failure) as caught:
                    load(job)
                self.assertEqual(caught.exception.phase, "contract_check")
                self.assertTrue(caught.exception.infrastructure)

    def test_queued_v1_job_is_rejected_by_v2_runner(self):
        self.check_versions("recognition-v1", "recognition-v2")

    def test_v2_job_is_rejected_by_v1_runner(self):
        self.check_versions("recognition-v2", "recognition-v1")

    def test_matching_scorer_is_accepted(self):
        self.check_versions("recognition-v2", "recognition-v2")


if __name__ == "__main__":
    unittest.main()
