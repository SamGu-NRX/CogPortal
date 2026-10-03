"""A week's real `discovery()` has to build a spec the SDK accepts.

This exists because it did not. `plugins.discovery()` was passing
`weights_consumed=` before `DiscoverySpec` had the field, so constructing the
real spec raised TypeError while every test still passed: they all built their
own fixture and called `resolve` directly, so none of them ever ran the
constructor a student's run goes through.

Nothing here needs the benchmark installed. The check is that every name the
spec is constructed with is a field the dataclass declares, and that the
forwarding table in `from_spec` carries them to `resolve`.
"""

from __future__ import annotations

import ast
import inspect
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import resolve as resolve_module  # noqa: E402
from cogbench.discovery_spec import DiscoverySpec  # noqa: E402

WEEKS = ROOT / "benchmarks"


def _spec_keywords(source: Path):
    """Every keyword a `DiscoverySpec(...)` call in this file is built with."""

    tree = ast.parse(source.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            if name == "DiscoverySpec":
                yield {word.arg for word in node.keywords if word.arg}


class EveryWeekBuildsASpecTheSdkAccepts(unittest.TestCase):
    def test_no_plugin_names_a_field_the_spec_does_not_have(self):
        fields = set(DiscoverySpec.__dataclass_fields__)
        seen = 0
        for plugin in sorted(WEEKS.glob("*/*/plugins.py")):
            for keywords in _spec_keywords(plugin):
                seen += 1
                unknown = keywords - fields
                self.assertEqual(
                    unknown,
                    set(),
                    "{} builds DiscoverySpec with {}, which it does not declare".format(
                        plugin.relative_to(ROOT), sorted(unknown)
                    ),
                )
        self.assertGreater(seen, 0, "no DiscoverySpec construction was found to check")

    def test_the_spec_declares_the_consumption_hook(self):
        self.assertIn("weights_consumed", DiscoverySpec.__dataclass_fields__)
        self.assertIsNone(DiscoverySpec.__dataclass_fields__["weights_consumed"].default)

    def test_from_spec_forwards_every_field_resolve_accepts(self):
        """A field the spec declares and `resolve` takes must be forwarded, or
        it silently stops being passed, which is what the table exists for."""

        forwarded = set()
        tree = ast.parse(Path(resolve_module.__file__).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "from_spec":
                for inner in ast.walk(node):
                    if isinstance(inner, ast.Dict):
                        forwarded |= {
                            key.value
                            for key in inner.keys
                            if isinstance(key, ast.Constant) and isinstance(key.value, str)
                        }
        accepted = set(inspect.signature(resolve_module.resolve).parameters)
        shared = set(DiscoverySpec.__dataclass_fields__) & accepted
        self.assertIn("weights_consumed", shared)
        self.assertEqual(
            shared - forwarded,
            set(),
            "from_spec does not forward {}".format(sorted(shared - forwarded)),
        )


if __name__ == "__main__":
    unittest.main()
