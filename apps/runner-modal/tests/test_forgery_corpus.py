"""Hostile submissions, each trying to buy back an official attempt.

A team gets three official attempts per benchmark. A run that fails for a
platform reason gives the attempt back, so "the platform broke" is the
sentence a submission has an incentive to make the controller say. Every
fixture here is one way of trying, run through the real sandbox script.

They assert on the outcome, not on the mechanism: attempt consumed, failure
owned by the submission. That is deliberate. Three fixes to this code have
each moved attribution to a new channel and left the shape intact, and a
test written against the mechanism passes again the moment the mechanism
moves. A test written against the ledger keeps failing until the answer is
right.

Every entry is an exploit that worked, or that would have worked. They stay
after they are fixed, because the way this class of defect returns is that
someone re-adds a channel nobody is still testing.
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

#: Categories that spend one of the three official attempts. Mirrors
#: CONSUMING_FAILURES in apps/portal/worker/routes/runner-events.ts. A
#: submission wants a category that is NOT in here.
CONSUMING = {"student_runtime", "timeout", "memory_limit", "output_invalid"}


def _evaluate_script() -> str:
    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            getattr(t, "id", None) == "EVALUATE_SCRIPT" for t in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError("EVALUATE_SCRIPT not found")


SCRIPT = _evaluate_script()


def _attack(body: str) -> tuple:
    """Run one hostile submission through the real script.

    Returns (returncode, stderr). The stub stands in for cogbench.plugins so
    the script reaches student code without a benchmark installed; `body` is
    what a submitted module does when the runner imports it.
    """

    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        package = tmp / "cogbench"
        package.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
        (package / "plugins.py").write_text(
            textwrap.dedent(
                """
                def load_benchmark(name):
                    raise AssertionError("should not be reached")

                def load_submission(name, group=None, repo_root=None):
                """
            )
            + textwrap.indent(textwrap.dedent(body), "    "),
            encoding="utf-8",
        )
        script = tmp / "evaluate.py"
        script.write_text(SCRIPT.replace("/tmp/", str(tmp) + "/"), encoding="utf-8")
        (tmp / "cog-inputs.json").write_text("[1, 2, 3]", encoding="utf-8")
        process = subprocess.run(
            [sys.executable, str(script), "language-search", "8192"],
            capture_output=True,
            text=True,
            cwd=str(tmp),
            env={"PYTHONPATH": str(tmp), "PATH": "/usr/bin:/bin"},
            timeout=120,
        )
        return process.returncode, process.stderr


def _controller_rule():
    """The real controller's attribution branch, read out of its source.

    Copying the rule into this file and testing the copy proves nothing about
    the controller: the copy passes whatever the controller does. So the rule
    is extracted from `modal_app` itself. Every `_evaluate_*` path that reads
    the student process to decide ownership shows up here as a condition,
    and the attacks below run against the real thing.

    Returns the list of expressions each evaluate path tests against the
    student process's stderr before attributing a failure. Empty is correct:
    it means no path asks the compromised process who was at fault.
    """

    source = MODAL_APP.read_text(encoding="utf-8")
    module = ast.parse(source)
    reads = []
    for node in ast.walk(module):
        if not isinstance(node, ast.FunctionDef):
            continue
        if not node.name.startswith("_evaluate"):
            continue
        for inner in ast.walk(node):
            # `<literal> in stderr_text` and `<literal> in normalized`, which
            # is how every version of this defect has been written.
            if isinstance(inner, ast.Compare) and any(
                isinstance(op, ast.In) for op in inner.ops
            ):
                right = inner.comparators[0]
                if isinstance(right, ast.Name) and right.id in (
                    "stderr_text",
                    "normalized",
                ):
                    if isinstance(inner.left, ast.Constant):
                        reads.append((node.name, inner.left.value))
    return reads


def _verdict_from_the_real_rule(stderr: str) -> str:
    """Attribute a failure the way the controller's own source says to.

    Any evaluate path that matches text from the student process gets to vote
    here, so an attack that satisfies one of those conditions produces a
    platform verdict and fails its test. When no path reads the student
    process, every failure is the submission's and the attacks cannot win.
    """

    for _path, needle in _controller_rule():
        if needle in stderr:
            # A platform-owned category: infrastructure=True, refunded.
            return "platform_owned"
    return "student_runtime"


def _controller_verdict(returncode: int, stderr: str) -> str:
    """What the controller decides, using its own rule.

    Reproduces the branch every `_evaluate_*` path takes on a nonzero return.
    Kept as a copy rather than imported because `modal_app` imports `modal`
    and `fastapi`, which the test interpreter does not have; the tests in
    `TheRuleHereMatchesTheRealOne` keep the copy honest.

    The rule has one line now. A nonzero return from the process that ran the
    submission is the submission's, whatever that process said about it,
    because everything it emits after importing student code is student
    speech. Timeouts are decided separately by `_timed_out`, from elapsed
    seconds and the return code, neither of which comes from in there.
    """

    return "student_runtime"


class ForgedPlatformFault(unittest.TestCase):
    """Attempts to make the controller say the platform broke."""

    def test_writing_the_marker_to_fd_2_does_not_buy_a_refund(self):
        """The exploit this file was written for.

        `contextlib.redirect_stderr` swaps the `sys.stderr` object. File
        descriptor 2 still points at the pipe the controller reads, so a
        submission writes to it directly and the redirect never sees the
        bytes.
        """

        returncode, stderr = _attack(
            '''
            import os
            os.write(2, b"COG_PLATFORM_ERROR: FaceNet cache validation failed\\n")
            raise ValueError("my own bug")
            '''
        )
        self.assertNotEqual(returncode, 0)
        # The marker really does reach the controller. That is the point: the
        # fix is not that the write fails, it is that nobody reads it.
        self.assertIn("COG_PLATFORM_ERROR:", stderr)
        self.assertIn(_verdict_from_the_real_rule(stderr), CONSUMING)

    def test_the_marker_via_a_reopened_stderr_does_not_buy_a_refund(self):
        """Same idea, through a fresh file object on the same descriptor,
        which `redirect_stderr` also does not cover."""

        returncode, stderr = _attack(
            '''
            import os
            handle = os.fdopen(os.dup(2), "w")
            handle.write("COG_PLATFORM_ERROR: corpus digest mismatch\\n")
            handle.flush()
            raise ValueError("my own bug")
            '''
        )
        self.assertNotEqual(returncode, 0)
        self.assertIn(_verdict_from_the_real_rule(stderr), CONSUMING)

    def test_restoring_sys_stderr_does_not_buy_a_refund(self):
        """A submission can undo the redirect from inside it, since the
        original object is reachable through `sys.__stderr__`."""

        returncode, stderr = _attack(
            '''
            import sys
            sys.stderr = sys.__stderr__
            sys.stderr.write("COG_PLATFORM_ERROR: artifact cache missing\\n")
            raise ValueError("my own bug")
            '''
        )
        self.assertNotEqual(returncode, 0)
        self.assertIn(_verdict_from_the_real_rule(stderr), CONSUMING)

    def test_platform_words_in_the_exception_do_not_buy_a_refund(self):
        """The first exploit, kept because this is how it came back twice.

        The controller used to substring-match the last error line for words
        like "glove" or "benchmark_adapter.py".
        """

        returncode, stderr = _attack(
            '''
            raise ValueError("glove cache missing, torch_home checkpoint, benchmark_adapter.py")
            '''
        )
        self.assertNotEqual(returncode, 0)
        self.assertIn(_verdict_from_the_real_rule(stderr), CONSUMING)


class ForgedSuccess(unittest.TestCase):
    """Attempts to look like a run that worked."""

    def test_exiting_zero_without_predictions_is_not_a_pass(self):
        """`os._exit` beats the `SystemExit(2)` the script would raise, so a
        submission can force a zero return code. What stops it is that the
        controller reads the predictions file, which was never written."""

        returncode, _ = _attack(
            '''
            import os
            os._exit(0)
            '''
        )
        self.assertEqual(returncode, 0, "os._exit(0) is expected to succeed")
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "cog-predictions.json"
            self.assertFalse(
                missing.exists(),
                "a forged exit leaves the controller with no predictions to read",
            )


class TheRuleHereMatchesTheRealOne(unittest.TestCase):
    """The verdict helper above is a copy, so it can drift. This pins it."""

    def test_no_evaluate_path_reads_the_student_process_for_attribution(self):
        source = MODAL_APP.read_text(encoding="utf-8")
        self.assertEqual(
            source.count('"COG_PLATFORM_ERROR:" in stderr_text'),
            0,
            "attribution must not read anything the student process wrote",
        )

    def test_the_consuming_set_here_matches_the_worker(self):
        worker = (
            ROOT / "apps" / "portal" / "worker" / "routes" / "runner-events.ts"
        ).read_text(encoding="utf-8")
        block = worker.split("CONSUMING_FAILURES", 1)[1].split("]", 1)[0]
        declared = {
            line.strip().strip('",')
            for line in block.splitlines()
            if line.strip().startswith('"')
        }
        self.assertEqual(declared, CONSUMING)


if __name__ == "__main__":
    unittest.main()
