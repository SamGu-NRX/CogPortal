"""Who gets blamed for a failed evaluation decides whether an official attempt
is spent, so a submission must not be able to influence it.

The controller used to classify a failure as a platform fault by substring
matching the sandbox's last error line, and that line is the submission's own
exception message. `raise ValueError("glove")` was therefore enough to have a
failed official run refunded, as many times as a team liked. The sandbox now
tags the owner of the failing step and the controller reads only that tag.
"""

from __future__ import annotations

import ast
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MODAL_APP = ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"


def _evaluate_script() -> str:
    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            getattr(t, "id", None) == "EVALUATE_SCRIPT" for t in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError("EVALUATE_SCRIPT not found")


SCRIPT = _evaluate_script()


def _run(tmp: Path, stub: str, payload: bytes | None, inputs: str | None) -> str:
    """Run the real sandbox script with a stubbed cogbench, return stderr."""

    pkg = tmp / "cogbench"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "plugins.py").write_text(textwrap.dedent(stub), encoding="utf-8")

    script = tmp / "evaluate.py"
    # The script hardcodes /tmp paths; point them at this test's directory so
    # concurrent runs and the real runner cannot collide.
    body = SCRIPT.replace("/tmp/", str(tmp) + "/")
    script.write_text(body, encoding="utf-8")

    if payload is not None:
        (tmp / "cog-week3-payload.zip").write_bytes(payload)
    if inputs is not None:
        (tmp / "cog-inputs.json").write_text(inputs, encoding="utf-8")

    proc = subprocess.run(
        [sys.executable, str(script), "language-search", "8192"],
        capture_output=True,
        text=True,
        cwd=str(tmp),
        env={"PYTHONPATH": str(tmp), "PATH": "/usr/bin:/bin"},
        timeout=120,
    )
    return proc.stderr


NOOP_STUB = """
    def load_benchmark(name):
        raise AssertionError("should not be reached")

    def load_submission(name, group=None):
        raise AssertionError("should not be reached")
"""

STUDENT_RAISES_PLATFORM_WORDS = """
    def load_benchmark(name):
        raise AssertionError("should not be reached")

    def load_submission(name, group=None):
        # Exactly the exploit: the submission names a platform artifact so the
        # old substring match would refund the attempt.
        raise ValueError("glove cache missing, torch_home checkpoint")
"""


class FailureAttributionTests(unittest.TestCase):
    def test_platform_owned_step_is_tagged_platform(self):
        # A corrupt staged payload fails while the platform still owns the run.
        with tempfile.TemporaryDirectory() as d:
            stderr = _run(Path(d), NOOP_STUB, payload=b"not a zip", inputs=None)
        self.assertIn("COG_PLATFORM_ERROR:", stderr)
        self.assertNotIn("COG_ERROR:", stderr)

    def test_submission_cannot_claim_a_platform_fault(self):
        # Student code raises a message full of platform words. It must still
        # be tagged as the student's failure.
        with tempfile.TemporaryDirectory() as d:
            stderr = _run(
                Path(d),
                STUDENT_RAISES_PLATFORM_WORDS,
                payload=None,
                inputs="[1, 2, 3]",
            )
        self.assertIn("COG_ERROR:", stderr)
        self.assertNotIn("COG_PLATFORM_ERROR:", stderr)

    def test_controller_does_not_read_student_words_for_attribution(self):
        # Guard against the old pattern coming back in either evaluate path.
        source = MODAL_APP.read_text(encoding="utf-8")
        self.assertNotIn(
            "token in detail.lower()",
            source,
            "attribution must not substring-match the student's error text",
        )
        # `contract_invalid` is not in CONSUMING_FAILURES, so choosing it from
        # the student's own message refunded the attempt.
        self.assertNotIn(
            '"contract_invalid" if "benchmark_adapter.py" in detail',
            source,
            "failure category must not be chosen from student-controlled text",
        )
        self.assertEqual(source.count('"COG_PLATFORM_ERROR:" in stderr_text'), 2)


if __name__ == "__main__":
    unittest.main()
