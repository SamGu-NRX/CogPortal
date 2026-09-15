"""The curve is labelled with the metric it draws.

`_sweep_wire` used to label every curve with the run's primary metric. That is
right for Week 1, whose curve is its primary score against catalog size, and
wrong for Week 3, whose curve is search MRR per rewrite rung while its primary
is `overall`. A hosted Language run drew a chart captioned "overall against how
far the query is from the caption" and plotted something else.

Week 3 now declares `sweep_metric`. The fallback has to survive that, because
Week 1 declares none and is correct without one, so both halves are asserted
here against what the producers actually say rather than against a description
of them.

`modal_app` imports modal and fastapi at module scope, so the function is taken
from its own source the way the other tests in this directory do.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MODAL_APP = ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"
WEEK1_PLUGINS = ROOT / "benchmarks" / "week1" / "audio_identification_benchmark" / "plugins.py"


def _sweep_wire_function():
    """The shipped `_sweep_wire`, with the one helper it calls."""

    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    wanted = {"_sweep_wire", "_primary_for_run"}
    namespace: dict = {}
    for node in module.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted:
            exec(compile(ast.Module([node], []), "<modal_app>", "exec"), namespace)
    if "_sweep_wire" not in namespace:
        raise AssertionError("_sweep_wire not found")
    return namespace["_sweep_wire"]


SWEEP_WIRE = _sweep_wire_function()


class Plugin:
    """The attributes `_sweep_wire` reads, and nothing else."""

    def __init__(self, **declared):
        self.sweep_axis_label = "difficulty"
        self.sweep_x_key = "x"
        self.sweep_y_key = "y"
        self.primary_metric = "primary_score"
        self.last_sweep = [{"x": 0, "y": 0.4}, {"x": 1, "y": 0.2}]
        for name, value in declared.items():
            setattr(self, name, value)


class SweepIsLabelledWithWhatItDraws(unittest.TestCase):
    def test_a_declared_sweep_metric_is_used(self):
        wire = SWEEP_WIRE(Plugin(sweep_metric="search_mrr"))
        self.assertEqual(wire["metric"], "search_mrr")

    def test_without_one_the_primary_metric_is_kept(self):
        wire = SWEEP_WIRE(Plugin())
        self.assertEqual(wire["metric"], "primary_score")

    def test_a_per_run_primary_still_wins_the_fallback(self):
        # Week 3 withholds `overall` when the image side was never measured.
        # That override has to keep reaching an undeclared sweep.
        wire = SWEEP_WIRE(Plugin(primary_metric_for_run="text_mrr"))
        self.assertEqual(wire["metric"], "text_mrr")

    def test_an_empty_declaration_does_not_blank_the_label(self):
        wire = SWEEP_WIRE(Plugin(sweep_metric=""))
        self.assertEqual(wire["metric"], "primary_score")


@unittest.skipIf(not WEEK1_PLUGINS.exists(), "needs the week 1 benchmark checkout")
class Week1ReliesOnTheFallback(unittest.TestCase):
    """Read from the producer, so this fails if Week 1's own declaration moves.

    Parsed rather than imported: the package needs numpy and librosa, which the
    suite does not require.
    """

    def _class_attributes(self):
        module = ast.parse(WEEK1_PLUGINS.read_text(encoding="utf-8"))
        names = set()
        for node in ast.walk(module):
            if isinstance(node, ast.ClassDef):
                for statement in node.body:
                    for target in getattr(statement, "targets", []):
                        if isinstance(target, ast.Name):
                            names.add(target.id)
        return names

    def test_week1_declares_no_sweep_metric(self):
        names = self._class_attributes()
        self.assertIn("primary_metric", names)
        self.assertNotIn("sweep_metric", names)


if __name__ == "__main__":
    unittest.main()
