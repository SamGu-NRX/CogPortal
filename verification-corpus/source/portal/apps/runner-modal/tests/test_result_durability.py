"""A run that scored keeps its result, and a later attempt sends it again.

Delivery already retries three times inside `_post_event`. When those are
exhausted the completed event existed only in the local frame of `execute_job`,
so a run that had really scored became unrecoverable: the portal never heard,
the stale sweep eventually failed it, and in official mode that spent an
attempt against a result that existed.

Storing the result is half of it. The other half is something that tries
again, and that is Modal's own retry policy on `execute_job` rather than a
retry loop written here. `_finish` raises when, and only when, a terminal event
did not land, so a retry is always a redelivery: the guard at the top of
`execute_job` returns before any scoring can start.

These tests run the real `execute_job` body. Every global it needs for scoring
is replaced with a sentinel that fails the test if it is called, so "did not
score again" is observed rather than argued from the order of lines.
"""

from __future__ import annotations

import ast
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_callback_delivery import (  # noqa: E402
    MODAL_APP,
    POST_EVENT,
    RecordingPortal,
    SECRET,
    job_for,
)

#: Everything `execute_job` reaches for once it decides to do the work. A test
#: that touches any of these has scored, which is the thing a replay must not
#: do. Collected from the function's own globals, so a new call site cannot
#: quietly escape the net.
SCORING_GLOBALS = (
    "_prepare",
    "_load_benchmark",
    "_cases",
    "_v2_cases",
    "_week1_cases",
    "_week3_cases",
    "_week1_manifest",
    "_check_predictions",
    "_evaluate",
    "_evaluate_v2",
    "_evaluate_week1",
    "_evaluate_week3",
    "_v2_metrics",
    "_sweep_wire",
    "StatusHeartbeat",
)


def durable_job(url: str) -> dict:
    """A job carrying the id `job_store` keys on, which `job_for` omits."""

    return {
        **job_for(url),
        "jobId": "job_durability_test",
        # Enough of a job to reach the first scoring call and no further.
        "preparedArtifactId": None,
        "mode": "practice",
    }


class Scored(AssertionError):
    """Raised by a sentinel, so scoring a second time fails loudly."""


class FakeDict(dict):
    """A stand-in for `modal.Dict`, with the one method that is not a dict's.

    `put(key, value, skip_if_exists=True)` returns False when the key is
    already there, which is how a job is claimed without a read and a write
    that another invocation can slip between. Signature checked against the
    installed modal 1.5.4.
    """

    def put(self, key, value, *, skip_if_exists: bool = False) -> bool:
        if skip_if_exists and key in self:
            return False
        self[key] = value
        return True


def _execute_job(store: dict) -> tuple:
    """The shipped `execute_job`, with its scoring dependencies replaced.

    `modal_app` imports modal and fastapi at module scope, so the function is
    taken from source and its decorator dropped. Its real state helpers, real
    reporter, and real delivery are kept: those are what is under test.
    """

    text = MODAL_APP.read_text(encoding="utf-8")
    module = ast.parse(text)
    wanted = ("_outcome_key", "_finish", "_deliver_terminal", "_event", "LiveReporter", "execute_job")
    nodes = []
    for node in module.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in wanted:
            if node.name == "execute_job":
                node.decorator_list = []
            nodes.append(node)
    assert len(nodes) == len(wanted), "modal_app no longer defines the durability pieces"

    calls: list = []

    def sentinel(name):
        def _scored(*_args, **_kwargs):
            calls.append(name)
            raise Scored("execute_job ran {} on a job that had already finished".format(name))

        return _scored

    namespace = {
        "time": time,
        "threading": threading,
        "sys": sys,
        "os": os,
        "json": __import__("json"),
        "hashlib": __import__("hashlib"),
        "Dict": dict,
        "Any": object,
        "job_store": store,
        "_post_event": POST_EVENT,
        "validate_job": lambda job: job,
        "RunnerFailure": type("RunnerFailure", (Exception,), {}),
        "_WIRING": None,
        "modal": None,
        "app": None,
        "controller_image": None,
        "runner_secret": None,
        "hidden_datasets": None,
    }
    for name in SCORING_GLOBALS:
        namespace[name] = sentinel(name)
    exec(compile(ast.Module(nodes, []), "<modal_app>", "exec"), namespace)
    return namespace, calls


def _store_outcome(namespace, store, job, kind="completed", delivered=False):
    """Put a finished job in the store the way `_finish` leaves it."""

    reporter = namespace["LiveReporter"](job)
    event = reporter.build(kind, result={"metrics": []})
    outcome = {"status": kind, "event": event, "delivered": delivered}
    store[namespace["_outcome_key"](job["jobId"])] = outcome
    store[job["jobId"]] = kind
    return outcome


class AFinishedJobIsNeverScoredAgain(unittest.TestCase):
    def setUp(self):
        os.environ["RUNNER_SIGNING_SECRET"] = SECRET
        self.store = FakeDict()

    def test_a_result_that_never_landed_is_sent_again_by_the_next_attempt(self):
        with RecordingPortal([200]) as portal:
            space, scored = _execute_job(self.store)
            job = durable_job(portal.url)
            _store_outcome(space, self.store, job)

            space["execute_job"](job)

            bodies = [request["body"] for request in portal.requests]

        self.assertEqual(scored, [], "the replay scored nothing")
        self.assertEqual(len(bodies), 1, "the stored result was sent once")
        self.assertIn(b'"type":"completed"', bodies[0])
        self.assertTrue(self.store[space["_outcome_key"](job["jobId"])]["delivered"])

    def test_the_replay_carries_the_same_event_the_first_attempt_built(self):
        with RecordingPortal([500, 500, 500, 200]) as portal:
            space, scored = _execute_job(self.store)
            job = durable_job(portal.url)
            _store_outcome(space, self.store, job)
            key = space["_outcome_key"](job["jobId"])

            # Delivery exhausts, so this attempt raises. That raise is what
            # asks Modal for another attempt.
            with self.assertRaises(urllib.error.HTTPError):
                space["execute_job"](job)
            self.assertFalse(self.store[key]["delivered"])

            space["execute_job"](job)
            bodies = [request["body"] for request in portal.requests]

        self.assertEqual(scored, [])
        self.assertEqual(len(bodies), 4, "three attempts, then the next invocation")
        self.assertEqual(len(set(bodies)), 1, "every one of them the same result")

    def test_a_delivered_result_does_nothing_at_all(self):
        with RecordingPortal([200]) as portal:
            space, scored = _execute_job(self.store)
            job = durable_job(portal.url)
            _store_outcome(space, self.store, job, delivered=True)

            space["execute_job"](job)

            self.assertEqual(portal.requests, [], "nothing was sent")
        self.assertEqual(scored, [], "and nothing was scored")

    def test_a_failed_outcome_replays_like_a_completed_one(self):
        """Both are terminal records. Replaying one and rescoring the other
        was an inconsistency with nothing behind it."""

        with RecordingPortal([200]) as portal:
            space, scored = _execute_job(self.store)
            job = durable_job(portal.url)
            _store_outcome(space, self.store, job, kind="failed")

            space["execute_job"](job)
            bodies = [request["body"] for request in portal.requests]

        self.assertEqual(scored, [], "a stored failure is not scored again")
        self.assertEqual(len(bodies), 1)
        self.assertIn(b'"type":"failed"', bodies[0])

    def test_a_job_that_never_ran_still_reaches_the_work(self):
        """The guard has to let a first attempt through, or nothing would ever
        be scored at all."""

        with RecordingPortal([200]) as portal:
            space, scored = _execute_job(self.store)
            job = durable_job(portal.url)
            # The sentinel raises inside the work, which `execute_job` catches
            # and reports as a run failure. What matters here is that it was
            # called at all: the guard let a first attempt through.
            space["execute_job"](job)
            bodies = [request["body"] for request in portal.requests]

        self.assertEqual(scored, ["_prepare"], "the first attempt reached the work")
        self.assertEqual(len(bodies), 1, "and reported the outcome once")
        self.assertIn(b'"type":"failed"', bodies[0])

    def test_an_invocation_stands_down_while_another_holds_the_job(self):
        with RecordingPortal([200]) as portal:
            space, scored = _execute_job(self.store)
            job = durable_job(portal.url)
            self.store[job["jobId"]] = {"status": "running"}

            space["execute_job"](job)

            self.assertEqual(portal.requests, [])
        self.assertEqual(scored, [])

    def test_a_job_finished_by_an_older_deploy_is_not_scored_again(self):
        """The regression this shape exists to avoid.

        An older build wrote the bare word and kept no event, so there is
        nothing to replay. Reading the status out of a dict would have found
        no event, fallen through, and scored a completed job a second time.
        """

        with RecordingPortal([200]) as portal:
            space, scored = _execute_job(self.store)
            job = durable_job(portal.url)
            self.store[job["jobId"]] = "completed"

            space["execute_job"](job)

            self.assertEqual(portal.requests, [], "nothing to send")
        self.assertEqual(scored, [], "and nothing to score")

    def test_two_invocations_cannot_both_claim_one_job(self):
        """The claim is one operation. A read and then a write let two
        invocations both see nothing and both do the work."""

        with RecordingPortal([200]) as portal:
            space, scored = _execute_job(self.store)
            job = durable_job(portal.url)
            self.assertTrue(
                self.store.put(job["jobId"], "running", skip_if_exists=True)
            )

            space["execute_job"](job)

            self.assertEqual(portal.requests, [])
        self.assertEqual(scored, [], "the second invocation stood down")


class TheRetryPolicyIsBoundedAndDeclared(unittest.TestCase):
    """Modal owns the retrying, so what is checkable here is the policy the
    function declares, not its execution."""

    def test_execute_job_declares_a_bounded_retry_policy(self):
        text = MODAL_APP.read_text(encoding="utf-8")
        module = ast.parse(text)
        fn = next(
            node
            for node in module.body
            if isinstance(node, ast.FunctionDef) and node.name == "execute_job"
        )
        call = next(
            decorator
            for decorator in fn.decorator_list
            if isinstance(decorator, ast.Call)
        )
        retries = next(kw.value for kw in call.keywords if kw.arg == "retries")
        maximum = next(kw.value for kw in retries.keywords if kw.arg == "max_retries")
        self.assertIsInstance(maximum.value, int)
        self.assertGreater(maximum.value, 0)
        # The schedule has to finish inside the portal's stale sweep, or the
        # run is already terminal and the replay is ignored.
        delay = next(kw.value for kw in retries.keywords if kw.arg == "max_delay")
        self.assertLessEqual(maximum.value * delay.value, 600)


if __name__ == "__main__":
    unittest.main()
