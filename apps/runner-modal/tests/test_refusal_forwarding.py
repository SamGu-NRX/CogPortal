"""What the controller carries out of the sandbox when nothing could be scored.

The check writes a whole verdict to /tmp/discovery.json and the controller
picks fields off it. Everything it does not pick is computed and then thrown
away at the sandbox boundary, which is where three real findings were being
lost: the modules that could not be read, the sentence the search wrote about
why, and the lines their own code raised on. A team saw one headline naming a
step, and the reason sat in a file nobody would ever read.

These tests pin the picking, because the boundary is the whole failure mode:
the fields exist upstream and the page renders them, and the only thing that
can drop them is this function.
"""

from __future__ import annotations

import ast
import json
import unittest
from pathlib import Path
from typing import Any, Dict, Optional

ROOT = Path(__file__).resolve().parents[3]
MODAL_APP = ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"
SOURCE = MODAL_APP.read_text(encoding="utf-8")


def _load(name: str):
    """One function out of the AST; modal is not importable in this interpreter."""

    module = ast.parse(SOURCE)
    for node in module.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            namespace = {"json": json, "Dict": Dict, "Any": Any, "Optional": Optional}
            exec(compile(ast.Module([node], []), "<modal_app>", "exec"), namespace)
            return namespace[name]
    raise AssertionError("{} not found".format(name))


REFUSAL_FROM = _load("_refusal_from")


class _Files:
    def __init__(self, text: str) -> None:
        self._text = text

    def read_text(self, _path: str) -> str:
        if self._text is None:
            raise FileNotFoundError(_path)
        return self._text


class _Sandbox:
    def __init__(self, record: object) -> None:
        self.filesystem = _Files(json.dumps(record) if record is not None else None)


VERDICT = {
    "status": "not_wired",
    "headline": "Nothing in your repository accepted the input the descriptors step passes.",
    "nextStep": "",
    "trace": [],
    "notes": [
        "clustering.clusterCreator() reads baseImages/ next to its own file, "
        "which holds your photos rather than the benchmark's."
    ],
    "coverage": {
        "read": ["whispers"],
        "skipped": [
            {"module": "master", "reason": "is empty", "owner": "theirs"},
            {"module": "app", "reason": "imports webcolors", "owner": "environment"},
        ],
        "readEnoughToJudge": True,
    },
    "errors": [
        {
            "file": "whispers.py",
            "line": 66,
            "function": "whispers.create_graph",
            "message": "AttributeError: module 'pyexpat.model' has no attribute 'detect'",
        }
    ],
}


class Forwarding(unittest.TestCase):
    def test_the_whole_finding_leaves_the_sandbox(self):
        refusal = REFUSAL_FROM(_Sandbox({"verdict": VERDICT}))

        self.assertEqual(len(refusal["notes"]), 1)
        self.assertEqual(
            [entry["module"] for entry in refusal["skipped"]], ["master", "app"]
        )
        self.assertEqual(refusal["errors"][0]["file"], "whispers.py")
        self.assertEqual(refusal["errors"][0]["line"], 66)

    def test_the_owner_of_a_skip_survives(self):
        # A module skipped because this machine lacks a package the graded run
        # installs is our absence. Dropping the owner would let it read on the
        # run page as one more thing the team got wrong.
        refusal = REFUSAL_FROM(_Sandbox({"verdict": VERDICT}))

        self.assertEqual(refusal["skipped"][1]["owner"], "environment")

    def test_a_verdict_written_before_these_fields_existed_still_forwards(self):
        older = {
            key: value
            for key, value in VERDICT.items()
            if key not in ("notes", "coverage", "errors")
        }

        refusal = REFUSAL_FROM(_Sandbox({"verdict": older}))

        self.assertEqual(refusal["headline"], VERDICT["headline"])
        self.assertEqual(refusal["notes"], [])
        self.assertEqual(refusal["skipped"], [])
        self.assertEqual(refusal["errors"], [])

    def test_no_discovery_file_is_not_a_refusal(self):
        self.assertIsNone(REFUSAL_FROM(_Sandbox(None)))


if __name__ == "__main__":
    unittest.main()
