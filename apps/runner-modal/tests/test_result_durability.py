"""A run that scored keeps its result, and a later attempt sends it again.

Delivery already retries three times inside `_post_event`. When those are
exhausted the completed event existed only in the local frame of `execute_job`,
so a run that had really scored became unrecoverable: the portal never heard,
and the stale sweep eventually failed it.

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
import types
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
    "check_predictions",
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


class InputCancellation(BaseException):
    """What Modal raises in a sync function whose call is cancelled. A
    BaseException there too, so it also escapes `except Exception`."""


def _execute_job(store: dict, prepare=None) -> tuple:
    """The shipped `execute_job`, with its scoring dependencies replaced.

    `modal_app` imports modal and fastapi at module scope, so the function is
    taken from source and its decorator dropped. Its real state helpers, real
    reporter, and real delivery are kept: those are what is under test.
    """

    text = MODAL_APP.read_text(encoding="utf-8")
    module = ast.parse(text)
    wanted = ("_outcome_key", "_finish", "_deliver_terminal", "_event", "_failure_detail",
              "_fit", "_take_units", "_receiver_units", "_wire_log", "LiveReporter", "execute_job",
              "_run_claimed", "_settle_interrupted", "INTERRUPTED_DETAIL")
    nodes = []
    for node in module.body:
        if isinstance(node, ast.Assign):
            name = getattr(node.targets[0], "id", None)
        else:
            name = getattr(node, "name", None)
        if name in wanted:
            if name == "execute_job":
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
        "modal": types.SimpleNamespace(
            exception=types.SimpleNamespace(InputCancellation=InputCancellation)
        ),
        "app": None,
        "controller_image": None,
        "runner_secret": None,
        "hidden_datasets": None,
        "DETAIL_LIMIT": 240,
        "DIAGNOSTIC_LIMIT": 600,
        "LOG_LIMIT": 8 * 1024,
    }
    for name in SCORING_GLOBALS:
        namespace[name] = sentinel(name)
    if prepare is not None:
        namespace["_prepare"] = prepare
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


def _events(portal) -> list:
    return [__import__("json").loads(request["body"]) for request in portal.requests]


def _interrupted_in(phases, stop):
    """A preparation that reports `phases`, then is stopped the way Modal stops
    a sync function: the exception is raised in the thread running it."""

    calls = []

    def prepare(job, reporter):
        calls.append(job["jobId"])
        for phase in phases:
            reporter.status(phase)
        raise stop

    return prepare, calls


class AnInterruptedRunReportsItself(unittest.TestCase):
    """Modal preempts a controller by interrupting it and restarting the input
    (https://modal.com/docs/guide/preemption). The interrupt is not an
    Exception, so it used to leave the claim with no outcome, and the restarted
    attempt found the claim and stood down: the run sat in its last phase until
    the stale sweep (run_dcf733e51f, 2026-10-01). The interrupted attempt owns
    the claim and its reporter, so it is the one that reports."""

    def setUp(self):
        os.environ["RUNNER_SIGNING_SECRET"] = SECRET
        self.store = FakeDict()

    def test_a_preempted_run_fails_in_the_phase_it_reached_and_is_not_run_again(self):
        prepare, prepared = _interrupted_in(["preparing", "installing"], KeyboardInterrupt())
        with RecordingPortal([]) as portal:
            space, scored = _execute_job(self.store, prepare)
            job = durable_job(portal.url)

            # The interrupt still propagates; it is Modal's, not ours to keep.
            with self.assertRaises(KeyboardInterrupt):
                space["execute_job"](job)
            # The restarted attempt, on the same input.
            space["execute_job"](job)
            events = _events(portal)

        self.assertEqual([event["type"] for event in events], ["status", "status", "failed"])
        failed = events[-1]
        self.assertEqual(failed["failure"], {
            "category": "provider",
            "phase": "installing",
            "detail": space["INTERRUPTED_DETAIL"],
            "infrastructure": True,
        })
        # The portal drops any event numbered at or below the last it applied.
        self.assertGreater(failed["sequence"], max(event["sequence"] for event in events[:-1]))
        self.assertEqual(self.store[job["jobId"]], "failed")
        self.assertTrue(self.store[space["_outcome_key"](job["jobId"])]["delivered"])
        self.assertEqual(prepared, [job["jobId"]], "the restart prepared nothing")
        self.assertEqual(scored, [], "and scored nothing")

    def test_a_failure_the_interrupted_attempt_could_not_send_is_replayed_unchanged(self):
        prepare, prepared = _interrupted_in(["preparing"], KeyboardInterrupt())
        # One status lands; the failure's three sends do not.
        with RecordingPortal([200, 503, 503, 503]) as portal:
            space, scored = _execute_job(self.store, prepare)
            job = durable_job(portal.url)
            key = space["_outcome_key"](job["jobId"])

            # Modal's interrupt still propagates, so a preempted input restarts.
            with self.assertRaises(KeyboardInterrupt):
                space["execute_job"](job)
            self.assertFalse(self.store[key]["delivered"], "stored before it was sent")

            space["execute_job"](job)
            bodies = [request["body"] for request in portal.requests]

        self.assertEqual(len(bodies), 5, "one status, three failed sends, one replay")
        self.assertEqual(len(set(bodies[1:])), 1, "the replay is the same event")
        self.assertTrue(self.store[key]["delivered"])
        self.assertEqual(prepared, [job["jobId"]])
        self.assertEqual(scored, [])

    def test_a_cancelled_call_reports_like_a_preempted_one(self):
        prepare, _ = _interrupted_in([], InputCancellation())
        with RecordingPortal([]) as portal:
            space, _ = _execute_job(self.store, prepare)
            job = durable_job(portal.url)

            with self.assertRaises(InputCancellation):
                space["execute_job"](job)
            events = _events(portal)

        self.assertEqual([event["type"] for event in events], ["failed"])
        self.assertEqual(events[0]["failure"]["phase"], "queued", "nothing was reported yet")

    def test_an_interrupt_after_a_result_was_stored_resends_that_result(self):
        """Interrupted while delivering a completed run: the result exists, and
        replacing it with a failure would discard the team's real number."""

        with RecordingPortal([]) as portal:
            space, _ = _execute_job(self.store)
            job = durable_job(portal.url)
            _store_outcome(space, self.store, job)

            space["_settle_interrupted"](job, space["LiveReporter"](job))
            events = _events(portal)

        self.assertEqual([event["type"] for event in events], ["completed"])
        self.assertEqual(self.store[job["jobId"]], "completed")

    def test_a_duplicate_delivery_stands_down_while_the_owner_runs(self):
        """Two deliveries of one job at once. The second must not run, report
        or settle anything; the owner's interruption is the only terminal."""

        entered = threading.Event()
        release = threading.Event()
        prepared = []

        def prepare(job, reporter):
            prepared.append(job["jobId"])
            reporter.status("preparing")
            entered.set()
            release.wait(5)
            raise KeyboardInterrupt()

        with RecordingPortal([]) as portal:
            space, scored = _execute_job(self.store, prepare)
            job = durable_job(portal.url)
            raised = []

            def owner():
                try:
                    space["execute_job"](job)
                except BaseException as error:  # noqa: B902 - the interrupt is the point
                    raised.append(error)

            thread = threading.Thread(target=owner)
            thread.start()
            self.assertTrue(entered.wait(5))
            space["execute_job"](job)
            sent_while_owner_ran = len(portal.requests)
            release.set()
            thread.join(5)
            events = _events(portal)

        self.assertEqual(sent_while_owner_ran, 1, "the duplicate sent nothing")
        self.assertEqual(prepared, [job["jobId"]], "and prepared nothing")
        self.assertEqual(scored, [])
        self.assertEqual([type(error) for error in raised], [KeyboardInterrupt])
        self.assertEqual([event["type"] for event in events], ["status", "failed"])

    def test_settling_does_not_wait_behind_a_heartbeat_that_is_still_sending(self):
        """A heartbeat retrying its post can outlast the grace Modal gives an
        interrupted attempt. If the failure waited for it, the attempt would
        die with nothing stored and the restart would stand down again."""

        in_flight = threading.Event()
        release = threading.Event()

        with RecordingPortal([]) as portal:
            space, _ = _execute_job(self.store)
            job = durable_job(portal.url)
            send = space["_post_event"]

            def slow_status(job, event):
                if event["type"] == "status":
                    in_flight.set()
                    release.wait(10)
                send(job, event)

            space["_post_event"] = slow_status
            reporter = space["LiveReporter"](job)
            heartbeat = threading.Thread(target=reporter.status, args=("installing",))
            heartbeat.start()
            self.assertTrue(in_flight.wait(5))

            settle = threading.Thread(target=space["_settle_interrupted"], args=(job, reporter))
            settle.start()
            settle.join(2)
            settled_in_time = not settle.is_alive()
            release.set()
            heartbeat.join(5)
            settle.join(5)
            events = _events(portal)

        self.assertTrue(settled_in_time, "the failure waited for the heartbeat's post")
        outcome = self.store[space["_outcome_key"](job["jobId"])]
        self.assertTrue(outcome["delivered"])
        status = next(event for event in events if event["type"] == "status")
        self.assertGreater(outcome["event"]["sequence"], status["sequence"])

    def test_nothing_is_sent_after_the_terminal_event_is_numbered(self):
        """A heartbeat numbered after the terminal and landing first would make
        the portal drop the terminal as stale and leave the run open."""

        with RecordingPortal([]) as portal:
            space, _ = _execute_job(self.store)
            job = durable_job(portal.url)
            reporter = space["LiveReporter"](job)
            reporter.status("evaluating", 0, 2)
            terminal = reporter.build("failed", failure={})
            reporter.status("evaluating", 1, 2)
            events = _events(portal)

        self.assertEqual(len(events), 1, "the late heartbeat was not sent")
        self.assertGreater(terminal["sequence"], events[0]["sequence"])


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
