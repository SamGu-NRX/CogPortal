"""Regression tests for failures observed while preparing a submission."""

from __future__ import annotations

import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[3]
SOURCE_PATH = ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)


def function(name: str) -> ast.FunctionDef:
    for node in TREE.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} not found")


def runner_failure_categories(node: ast.AST) -> set[str]:
    categories = set()
    for call in ast.walk(node):
        if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "RunnerFailure":
            if call.args and isinstance(call.args[0], ast.Constant):
                categories.add(call.args[0].value)
    return categories


class PrepareFailureClassificationTests(unittest.TestCase):
    def test_benchmark_version_mismatch_is_a_provider_failure(self):
        load_benchmark = function("_load_benchmark")
        self.assertIn("provider", runner_failure_categories(load_benchmark))
        self.assertNotIn("contract_invalid", runner_failure_categories(load_benchmark))
        failures = (ROOT / "packages/contracts/src/failures.ts").read_text(encoding="utf-8")
        provider_copy = failures.split("  provider: {", 1)[1].split("  },", 1)[0]
        self.assertIn('remedy: "retry"', provider_copy)
        self.assertNotIn("push a new commit", provider_copy)

    def test_prepare_classifies_timeout_and_provider_failures(self):
        prepare = function("_prepare")
        categories = runner_failure_categories(prepare)
        self.assertIn("timeout", categories)
        self.assertIn("provider", categories)

    def test_prepare_uses_the_evaluation_timeout_threshold(self):
        prepare = function("_prepare")
        source = ast.get_source_segment(SOURCE, prepare)  # ast.unparse needs 3.9; week CI runs 3.8
        self.assertIn('_timed_out(job, started)', source)


if __name__ == "__main__":
    unittest.main()
