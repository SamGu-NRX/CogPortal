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
import time
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


def _timed_out_function():
    """Load `_timed_out` from source, without importing modal.

    `modal_app` imports `modal` and `fastapi` at module scope, and the CI
    interpreter has neither. The existing tests in this file read the sandbox
    script out of the AST for the same reason; this reads one function.
    """

    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.FunctionDef) and node.name == "_timed_out":
            namespace = {"time": time}
            exec(compile(ast.Module([node], []), "<modal_app>", "exec"), namespace)
            return namespace["_timed_out"]
    raise AssertionError("_timed_out not found")


TIMED_OUT = _timed_out_function()


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
        # This assertion used to read the other way: every payload path MUST
        # read the owner tag. That was the previous fix, and it was wrong for
        # a reason no amount of reading the controller would show, because the
        # defect was in the sandbox. `redirect_stderr` rebinds `sys.stderr`
        # and leaves file descriptor 2 alone, so `os.write(2, ...)` from any
        # student module put the platform marker on the pipe the controller
        # reads, and bought an unlimited supply of refunded official attempts.
        #
        # So no evaluate path may read it. The conditions it reported are
        # verified controller-side before the sandbox starts; see
        # `_platform_owned_evaluation_failure` in modal_app.
        self.assertEqual(
            source.count('"COG_PLATFORM_ERROR:" in stderr_text'),
            0,
            "attribution must not read anything the student process wrote",
        )


if __name__ == "__main__":
    unittest.main()


class TimeoutAttribution(unittest.TestCase):
    """A sandbox-killed process must not be reported as a crash.

    Modal enforces its timeout with a kill, so the process returns nonzero with
    no traceback -- from the controller's side, identical to a crash. Read as a
    crash it becomes `student_runtime` with the message "Evaluation failed.",
    which tells a team nothing and hides the one fact they can act on: the run
    exceeded its wall-clock budget.

    Measured: carti4ce/week1_capstone reached 999 s against a 900 s budget,
    because its database rewrites a pickle per song and reloads it per query.
    """

    def _job(self, seconds=900):
        return {"runtime": {"timeoutSeconds": seconds}}

    def test_elapsed_at_the_budget_is_a_timeout(self):
        job = self._job(900)
        started = time.time() - 999
        self.assertTrue(TIMED_OUT(job, started, 1, ""))

    def test_sigkill_is_a_timeout_even_slightly_early(self):
        job = self._job(900)
        started = time.time() - 500
        self.assertTrue(TIMED_OUT(job, started, -9, ""))
        self.assertTrue(TIMED_OUT(job, started, 137, ""))

    def test_a_fast_crash_is_not_a_timeout(self):
        """The case this must never swallow: a real student exception."""

        job = self._job(900)
        started = time.time() - 12
        self.assertFalse(
            TIMED_OUT(job, started, 1, "ValueError: bad shape\n")
        )

    def test_a_submission_cannot_claim_a_timeout_by_printing_one(self):
        """`killed` in stderr is checked last and only near the end.

        A team that raises RuntimeError("killed") early must still be charged
        for a crash, or the word becomes a way to relabel a bug.
        """

        job = self._job(900)
        started = time.time() - 5
        self.assertFalse(
            TIMED_OUT(job, started, 1, "RuntimeError: killed\n" + "x" * 400)
        )


def _last_error_line_function():
    """Load `_last_error_line` from source; see `_timed_out_function`."""

    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.FunctionDef) and node.name == "_last_error_line":
            namespace = {}
            exec(compile(ast.Module([node], []), "<modal_app>", "exec"), namespace)
            return namespace["_last_error_line"]
    raise AssertionError("_last_error_line not found")


LAST_ERROR_LINE = _last_error_line_function()


class ErrorLineExtraction(unittest.TestCase):
    """The detail a student reads has to be the message, not the traceback.

    The prepare sandbox raises rather than marking its failures, so its stderr
    is a plain Python traceback. Slicing the last N characters off that yields
    `line 144, in <module>` -- our sandbox script's own last frame -- which was
    what a real Week 3 run reported for a repository that simply had no
    adapter. The one sentence naming the fix was three lines above it.
    """

    def test_a_traceback_yields_its_message_not_its_last_frame(self):
        stderr = (
            'Traceback (most recent call last):\n'
            '  File "/tmp/cog-prepare.py", line 144, in <module>\n'
            "    raise RuntimeError(message)\n"
            "RuntimeError: No adapter found in week3_capstone-abc. Add submission.py "
            "at the repository root defining create_submission().\n"
        )
        detail = LAST_ERROR_LINE(stderr)
        self.assertIn("No adapter found", detail)
        self.assertNotIn("line 144", detail)
        self.assertNotIn("<module>", detail)

    def test_the_exception_class_is_dropped(self):
        """`RuntimeError:` is our vocabulary; the message was written to read."""

        self.assertFalse(
            LAST_ERROR_LINE("RuntimeError: the archive is larger than 100 MiB.\n")
            .startswith("RuntimeError")
        )

    def test_the_evaluate_marker_still_wins(self):
        stderr = "noise\nCOG_ERROR: returned 3 predictions for 5 cases\n"
        self.assertEqual(LAST_ERROR_LINE(stderr), "returned 3 predictions for 5 cases")

    def test_empty_stderr_says_so_plainly(self):
        self.assertIn("failed", LAST_ERROR_LINE("").lower())

    def test_a_message_with_a_colon_is_not_truncated_at_it(self):
        """`pip install: failed` must not lose its left half to class-stripping.

        The class prefix is only dropped when the text before the colon is a
        bare identifier, which `pip install` is not.
        """

        self.assertEqual(
            LAST_ERROR_LINE("pip install: could not resolve numpy==1.24.4\n"),
            "pip install: could not resolve numpy==1.24.4",
        )
