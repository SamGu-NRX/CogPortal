"""When a sandbox dies at a limit, who gets charged for it.

Gate 1 lists memory as one of eight behaviours to verify, and nothing covered
it. What can be covered offline is not "Modal kills a sandbox at 4 GB", which
needs a live sandbox and money, but the decision made about the death after it
happens. That decision has real consequences: a failure the controller marks
infrastructure=True refunds the team's official attempt, and one it marks False
spends it. Deciding wrongly either hands out free attempts or charges a team for
our outage.

The decision is made twice, in two different ways, and the difference matters.

A process killed by the sandbox comes back through `process.wait()` as a
returncode, and `_timed_out` reads it. That path is careful: it reads elapsed
time and signal numbers, both of which a submission cannot forge, and only then
falls back to text.

Everything else arrives as an exception from the Modal client, and there the
classifier is `"memory" in str(error).lower()`. That is the part these tests
pin, including where it does not work: `modal.exception.SandboxTimeoutError()`
has an empty message, so nothing in it matches, and it falls through to
`provider` with infrastructure=True. There is no evidence about which errors
Modal raises with which text at these limits, and this file does not invent
any. It pins what the code does today and names the blind spot so the runbook
can tell an operator what to record from a real limit failure.
"""

from __future__ import annotations

import ast
import sys
import time
import unittest
from pathlib import Path
from typing import Any, Dict

ROOT = Path(__file__).resolve().parents[3]
MODAL_APP = ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"
SOURCE = MODAL_APP.read_text(encoding="utf-8")

#: Every evaluate path except `_evaluate_installed`, which is not one.
EVALUATE_PATHS = tuple(
    node.name
    for node in ast.parse(SOURCE).body
    if isinstance(node, ast.FunctionDef)
    and node.name.startswith("_evaluate")
    and node.name != "_evaluate_installed"
)


def _load(name: str):
    """One function out of the AST; modal is not importable in this interpreter."""

    module = ast.parse(SOURCE)
    for node in module.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            namespace = {"time": time, "Dict": Dict, "Any": Any}
            exec(compile(ast.Module([node], []), "<modal_app>", "exec"), namespace)
            return namespace[name]
    raise AssertionError("{} not found".format(name))


TIMED_OUT = _load("_timed_out")


def classifiers(function_name: str):
    """The `if` tests in one evaluate path's `except Exception` handler, with
    the failure category each one raises.

    Read out of the real function rather than restated. A fifth evaluate path
    added without a classifier shows up here as an empty list, which the tests
    below turn into a failure.
    """

    module = ast.parse(SOURCE)
    for node in module.body:
        if not (isinstance(node, ast.FunctionDef) and node.name == function_name):
            continue
        found = []
        for handler in ast.walk(node):
            if not (
                isinstance(handler, ast.ExceptHandler)
                and isinstance(handler.type, ast.Name)
                and handler.type.id == "Exception"
            ):
                continue
            for statement in handler.body:
                if not isinstance(statement, ast.If):
                    continue
                category = None
                infrastructure = None
                for inner in ast.walk(statement):
                    if isinstance(inner, ast.Call) and getattr(inner.func, "id", None) == "RunnerFailure":
                        category = ast.literal_eval(inner.args[0])
                        if len(inner.args) >= 4 and isinstance(inner.args[3], ast.Constant):
                            infrastructure = inner.args[3].value
                        break
                found.append((category, ast.unparse(statement.test), infrastructure))
        return found
    raise AssertionError("{} not found".format(function_name))


def classify(function_name: str, message: str):
    """What category the real classifier gives this error message.

    Evaluates the shipped `if` tests in order against `normalized`, exactly as
    the handler does, and returns the first match. None means the message fell
    through to the default, which every path writes as `provider` with
    infrastructure=True.
    """

    normalized = str(message).lower()
    for category, expression, _infrastructure in classifiers(function_name):
        if eval(expression, {}, {"normalized": normalized}):  # noqa: S307 - shipped source
            return category
    return None


class EveryEvaluatePathClassifiesLimits(unittest.TestCase):
    """A path that forgot the classifier would report a timeout as a crash.

    Counted against the real list of evaluate paths rather than a literal, so
    adding a fourth benchmark track fails this test by omitting the handler
    instead of by existing.
    """

    def test_there_is_more_than_one_evaluate_path(self):
        self.assertGreaterEqual(len(EVALUATE_PATHS), 4, EVALUATE_PATHS)

    def test_every_path_classifies_both_limits(self):
        for name in EVALUATE_PATHS:
            categories = {category for category, _test, _infra in classifiers(name)}
            self.assertIn("timeout", categories, name)
            self.assertIn("memory_limit", categories, name)

    def test_every_path_charges_a_limit_to_the_submission(self):
        """infrastructure=False, so the attempt is spent.

        A timeout or an OOM is the submission's own resource use. Marking it
        infrastructure would refund the attempt and let a team retry an
        expensive submission without cost.
        """

        for name in EVALUATE_PATHS:
            for category, _test, infrastructure in classifiers(name):
                if category in ("timeout", "memory_limit"):
                    self.assertIs(
                        infrastructure,
                        False,
                        "{} marks {} as infrastructure, which refunds the attempt".format(name, category),
                    )

    def test_the_paths_agree_with_each_other(self):
        """Four copies of the same two-line classifier is four chances to drift.

        Not a request to deduplicate them: each handler builds a different
        message. What must hold is that the same error text is classified the
        same way whichever benchmark the team ran.
        """

        samples = ["sandbox timed out", "container ran out of memory", "oomkilled", "grpc unavailable", ""]
        for message in samples:
            answers = {name: classify(name, message) for name in EVALUATE_PATHS}
            self.assertEqual(
                len(set(answers.values())),
                1,
                "'{}' is classified inconsistently: {}".format(message, answers),
            )


class WhatTheClassifierRecognizes(unittest.TestCase):
    """Pinned so a change to the substrings is visible rather than silent."""

    def test_an_out_of_memory_message_becomes_memory_limit(self):
        for message in ("Sandbox ran out of memory", "OOMKilled", "container oom", "MEMORY LIMIT EXCEEDED"):
            self.assertEqual(classify("_evaluate", message), "memory_limit", message)

    def test_a_timeout_message_becomes_timeout(self):
        for message in ("Sandbox timed out", "operation TIMEOUT", "exec timed out"):
            self.assertEqual(classify("_evaluate", message), "timeout", message)

    def test_timeout_is_checked_before_memory(self):
        """Order decides a message containing both words.

        "timed out waiting for memory" is contrived, but the order is real and
        a reader should not have to infer it from source position.
        """

        self.assertEqual(classify("_evaluate", "timed out waiting for memory"), "timeout")

    def test_an_unrelated_error_falls_through_to_provider(self):
        """And so refunds the attempt, which is the right default.

        A gRPC failure or a dropped connection is ours. Charging a team for it
        would spend one of three attempts on our outage.
        """

        for message in ("grpc: connection reset", "unexpected exit status"):
            self.assertIsNone(classify("_evaluate", message), message)


class TheBlindSpot(unittest.TestCase):
    """Modal's own limit exceptions carry no message, so nothing matches them.

    Measured against modal 1.5.4, the version pinned in
    apps/runner-modal/pyproject.toml (`modal>=1.0,<2`):

        >>> str(modal.exception.SandboxTimeoutError())
        ''

    Every exception class in modal.exception constructs with an empty string.
    An empty message matches neither substring, so it falls through to
    `provider` with infrastructure=True, and an official attempt is refunded
    for what was really the submission exceeding its own budget.

    Two reasons this is a blind spot and not a live bug, and both are worth
    stating precisely because the difference decides whether it needs fixing
    before Gate 1:

    1. The evaluate paths call `process.wait()`, and per
       modal/container_process.py:181-186 that method catches ExecTimeoutError
       internally and sets returncode to -1 rather than raising. So an
       ordinary sandbox timeout reaches `_timed_out`, not this handler.
    2. `_timed_out` recognizes it: at or past 95% of the budget, elapsed time
       alone is sufficient regardless of the returncode.

    So the reachable path is covered and the unreachable one is not. What is
    genuinely unknown is which exception Modal raises on an OOM, and with what
    text, because nothing in this repository has ever observed one. These tests
    do not guess. They pin the empty-message behaviour so that if a real OOM is
    ever recorded, the fix has a place to land and a test that will notice.
    """

    def test_an_empty_message_is_not_recognized_as_either_limit(self):
        self.assertIsNone(classify("_evaluate", ""))

    def test_an_empty_message_is_not_recognized_in_any_path(self):
        for name in EVALUATE_PATHS:
            self.assertIsNone(classify(name, ""), name)

    def test_the_reachable_timeout_path_does_not_depend_on_the_message(self):
        """Why the blind spot is survivable today.

        `_timed_out` reads elapsed time and the returncode, so a killed process
        is a timeout even with empty stderr. Modal's ContainerProcess.wait
        reports its own timeout as returncode -1, and at the budget that is
        recognized.
        """

        job = {"runtime": {"timeoutSeconds": 900}}
        self.assertTrue(TIMED_OUT(job, time.time() - 900, -1, ""))
        self.assertTrue(TIMED_OUT(job, time.time() - 880, 1, ""))
        self.assertTrue(TIMED_OUT(job, time.time() - 5, -9, ""))

    def test_the_timeout_signal_check_does_not_cover_minus_one_early(self):
        """The exact edge, recorded rather than asserted to be correct.

        A process that returns -1 well before the budget is not treated as a
        timeout. That is the right call on the evidence available: -1 is also
        what Modal reports for an unexpected exit status
        (container_process.py:176-179), so treating it as a timeout would let a
        crash be relabelled. Recorded here because it is the one case where the
        two mechanisms leave a gap, and a future OOM report may land in it.
        """

        job = {"runtime": {"timeoutSeconds": 900}}
        self.assertFalse(TIMED_OUT(job, time.time() - 10, -1, ""))

    def test_the_substring_classifier_is_still_the_only_memory_detection(self):
        """A guard, so a real fix removes this test rather than passing beside it.

        If someone adds type-based detection (`isinstance(error,
        modal.exception.SandboxTimeoutError)`), this fails and the reader is
        sent to the docstring above to update what is known.
        """

        self.assertNotIn(
            "SandboxTimeoutError",
            SOURCE,
            "modal_app now names Modal's exception types; update TheBlindSpot's "
            "docstring, which says classification is by substring only",
        )


if __name__ == "__main__":
    unittest.main()
