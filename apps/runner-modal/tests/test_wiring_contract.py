"""The wiring panel must never cost the run that produced it.

The completed event carries the wiring verbatim and the portal validates that
event against WiredStepSchema as one object, so a step longer than the schema
allows loses the score the same event was carrying.
"""

from __future__ import annotations

import ast
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MODAL_APP = ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"

#: WiredStepSchema in packages/contracts/src/protocol.ts.
LIMITS = {"stage": 60, "function": 200, "received": 200, "returned": 200}


def _wiring_namespace() -> dict:
    """`modal_app` imports modal and fastapi at module scope and this
    interpreter has neither, so take the real nodes out of the AST instead, as
    test_prediction_validation.py does."""

    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    body = [
        node
        for node in module.body
        if (isinstance(node, ast.FunctionDef) and node.name == "_collect_wiring")
        or (isinstance(node, ast.AnnAssign) and getattr(node.target, "id", None) == "_WIRING")
    ]
    assert len(body) == 2, "modal_app.py no longer defines _WIRING and _collect_wiring"
    namespace: dict = {"json": json, "Any": object, "Dict": dict, "List": list}
    exec(compile(ast.Module(body=body, type_ignores=[]), "<modal_app>", "exec"), namespace)
    return namespace


NS = _wiring_namespace()


class _Sandbox:
    """Enough of a Modal sandbox for the one file this reads."""

    def __init__(self, text: str) -> None:
        self.filesystem = self
        self._text = text

    def read_text(self, _path: str) -> str:
        return self._text


class WiringStaysInsideTheContract(unittest.TestCase):
    def test_a_step_too_long_for_the_schema_is_clipped_not_forwarded(self):
        deep_module = ".".join(["cogworks_capstone_2026"] * 12)
        NS["_collect_wiring"](
            _Sandbox(
                json.dumps(
                    [
                        {
                            "stage": "descriptors",
                            "function": "team.descriptors.compute",
                            "received": "an array of shape (12, 128)",
                            "returned": "a list of 12, starting 0.41",
                        },
                        {
                            "stage": "match",
                            "function": deep_module + ".find_matches",
                            "received": "x" * 900,
                            "returned": None,
                        },
                        {"stage": "store", "function": None},
                        "not a step at all",
                    ]
                )
            )
        )
        steps = NS["_WIRING"]

        self.assertEqual(len(steps), 2, "only the two usable steps survive")
        self.assertEqual(steps[0]["function"], "team.descriptors.compute")
        self.assertEqual(steps[0]["returned"], "a list of 12, starting 0.41")
        # The long one is kept, because which function ran is the panel's whole
        # content; it is the length that has to go.
        self.assertTrue(steps[1]["function"].startswith("cogworks_capstone_2026."))
        self.assertNotIn("returned", steps[1], "a non-string field is dropped, not coerced")
        for step in steps:
            self.assertTrue(step["stage"] and step["function"])
            for field, limit in LIMITS.items():
                if field in step:
                    self.assertIsInstance(step[field], str)
                    self.assertLessEqual(len(step[field]), limit, field)


if __name__ == "__main__":
    unittest.main()
