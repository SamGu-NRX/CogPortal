"""What happens to a run event when the portal does not answer the first time.

Gate 1 asks whether a retry duplicates a metric or spends an attempt twice.
Three mechanisms answer that, and none of them had a test. Job dedupe and event
dedupe both need a Modal Dict or a D1 database, so they stay runbook steps. The
third is `_post_event`, which is ordinary Python over HTTP and can be driven
here against a loopback server that misbehaves on purpose.

Two properties matter, for different reasons.

Retry has to happen, because without it a single 503 from a Worker cold start
loses a completed event permanently. The run then sits in whatever phase it
reached until the stale reaper fails it an hour later, and a run that really
succeeded is reported as a provider failure.

Retry has to be safe, because the portal cannot tell a retry from a new event
except by its `eventId`. Every attempt has to carry the same body, so
`onConflictDoNothing` on that id collapses them into one. A retry that rebuilt
the event with a new id would be inserted again, and `applyEvent` would apply
the same metrics twice.

The signature is the part that is easy to get wrong in the other direction: the
body is fixed but the timestamp is not, because a retry after a delay carries a
new timestamp and must be re-signed over it. A retry that reused the first
signature would be refused as a stale timestamp by exactly the check that
exists to stop replay.
"""

from __future__ import annotations

import ast
import http.server
import os
import socketserver
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))

from cogworks_runner.protocol import (  # noqa: E402
    MAX_CLOCK_SKEW_SECONDS,
    canonical_json,
    signature,
    verify_signature,
)

MODAL_APP = ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"
SECRET = "callback-test-secret"


def _post_event_function():
    """Load `_post_event` from source, without importing modal.

    Same approach as the other tests here: modal_app imports modal and fastapi
    at module scope. Taking the real function node means this tests the shipped
    retry loop rather than a description of it.
    """

    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.FunctionDef) and node.name == "_post_event":
            namespace = {
                "os": os,
                "time": time,
                "urllib": urllib,
                "canonical_json": canonical_json,
                "signature": signature,
                "RUNNER_USER_AGENT": "cogworks-runner",
                "Dict": dict,
                "Any": object,
            }
            exec(compile(ast.Module([node], []), "<modal_app>", "exec"), namespace)
            return namespace["_post_event"]
    raise AssertionError("_post_event not found")


POST_EVENT = _post_event_function()


class RecordingPortal:
    """A portal that answers with whatever status the test asked for.

    `statuses` is consumed one per request; once it runs out every further
    request gets 200. Each request is recorded whole, headers and body, because
    what the retries carry is the thing under test.
    """

    def __init__(self, statuses, retry_after=None):
        self.statuses = list(statuses)
        self.retry_after = retry_after
        self.requests = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler's name
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                outer.requests.append(
                    {
                        "body": body,
                        "signature": self.headers.get("X-Cogworks-Signature", ""),
                        "timestamp": self.headers.get("X-Cogworks-Timestamp", ""),
                        "keyId": self.headers.get("X-Cogworks-Key-Id", ""),
                        "userAgent": self.headers.get("User-Agent", ""),
                    }
                )
                index = len(outer.requests) - 1
                status = outer.statuses[index] if index < len(outer.statuses) else 200
                self.send_response(status)
                if outer.retry_after is not None and status in (429, 503):
                    self.send_header("Retry-After", str(outer.retry_after))
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        self.server.allow_reuse_address = True

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    @property
    def url(self):
        return "http://127.0.0.1:{}/api/internal/v1/runner/events".format(
            self.server.server_address[1]
        )


def job_for(url: str) -> dict:
    return {"callback": {"url": url, "keyId": "runner-v1"}, "runId": "run_callback_test"}


def completed_event() -> dict:
    """A completed event, because that is the one whose loss actually costs.

    A dropped status event only means a stale progress bar. A dropped completed
    event means a run that succeeded is reported as a provider failure an hour
    later, and in official mode that refunds an attempt the team already spent
    successfully.
    """

    return {
        "protocolVersion": "1",
        "eventId": "event_run_callback_test_2",
        "runId": "run_callback_test",
        "sequence": 2,
        "occurredAt": 1_700_000_000_000,
        "type": "completed",
        "preparedArtifactId": "im-testsnapshot",
        "environmentDigest": "a" * 64,
        "sanitizedLog": None,
        "result": {
            "protocolVersion": "1",
            "benchmarkId": "language-search",
            "benchmarkVersion": 1,
            "metrics": [{"key": "overall", "label": "Overall", "value": 0.5}],
            "diagnostics": [],
            "outputDigest": "b" * 64,
        },
    }


class RetryHappens(unittest.TestCase):
    def setUp(self):
        os.environ["RUNNER_SIGNING_SECRET"] = SECRET

    def test_a_transient_server_error_is_retried_rather_than_dropped(self):
        with RecordingPortal([500, 503]) as portal:
            POST_EVENT(job_for(portal.url), completed_event())
        self.assertEqual(len(portal.requests), 3)

    def test_rate_limiting_is_retried(self):
        with RecordingPortal([429]) as portal:
            POST_EVENT(job_for(portal.url), completed_event())
        self.assertEqual(len(portal.requests), 2)

    def test_a_client_error_is_not_retried(self):
        """A 400 means the portal rejected this event's shape.

        Sending it again produces the same 400. Retrying would turn one bad
        event into three identical rejections and delay the failure by a second
        for no gain.
        """

        with RecordingPortal([400, 400, 400]) as portal:
            with self.assertRaises(urllib.error.HTTPError):
                POST_EVENT(job_for(portal.url), completed_event())
        self.assertEqual(len(portal.requests), 1)

    def test_a_401_is_not_retried(self):
        """A signing mismatch is permanent, so retrying only hides it.

        This is the drift `preflight_dispatch.py` and `verify_dispatch.py`
        exist to catch. Three attempts would make the same wrong answer look
        like a flaky network.
        """

        with RecordingPortal([401, 401, 401]) as portal:
            with self.assertRaises(urllib.error.HTTPError):
                POST_EVENT(job_for(portal.url), completed_event())
        self.assertEqual(len(portal.requests), 1)

    def test_giving_up_raises_rather_than_returning_quietly(self):
        """Three 500s must not look like a delivered event.

        `execute_job` lets this propagate. A silent return here would mark the
        job completed in the Modal Dict while the portal never heard about it,
        and the dedupe check would then refuse to run it again.
        """

        with RecordingPortal([500, 500, 500, 500]) as portal:
            with self.assertRaises(Exception):
                POST_EVENT(job_for(portal.url), completed_event())
        self.assertEqual(len(portal.requests), 3)


class RetryIsSafe(unittest.TestCase):
    """The half that decides whether a retry duplicates anything."""

    def setUp(self):
        os.environ["RUNNER_SIGNING_SECRET"] = SECRET

    def test_every_attempt_carries_the_same_bytes(self):
        """Byte equality, not equality after parsing.

        The Worker verifies the signature against the raw request text before
        parsing it, so two bodies that parse the same but differ in key order
        are two different messages to the signature check.
        """

        with RecordingPortal([500, 500]) as portal:
            POST_EVENT(job_for(portal.url), completed_event())
        bodies = {request["body"] for request in portal.requests}
        self.assertEqual(len(bodies), 1, "a retry rebuilt the body")

    def test_every_attempt_carries_the_same_event_id(self):
        """The id is the only thing stopping a double-apply.

        runner-events.ts inserts on eventId with onConflictDoNothing and
        returns early when nothing changed. A retry with a fresh id would be
        inserted as a new event and applied a second time, which for a
        completed event means the metrics land twice.
        """

        import json

        with RecordingPortal([500, 503]) as portal:
            POST_EVENT(job_for(portal.url), completed_event())
        ids = {json.loads(request["body"])["eventId"] for request in portal.requests}
        self.assertEqual(ids, {completed_event()["eventId"]})

    def test_the_body_is_canonical_json(self):
        """Sorted keys and no spaces, which is what both sides sign over."""

        with RecordingPortal([]) as portal:
            POST_EVENT(job_for(portal.url), completed_event())
        self.assertEqual(portal.requests[0]["body"], canonical_json(completed_event()))

    def test_each_attempt_is_signed_over_its_own_timestamp(self):
        """The subtle one, and it cuts both ways.

        A retry has to re-sign, because the portal rejects a timestamp more
        than five minutes old and a reused signature is bound to the first
        attempt's timestamp. So this checks the stronger property: every
        attempt verifies against its own headers, using the same verifier the
        Worker uses.
        """

        with RecordingPortal([500, 503]) as portal:
            POST_EVENT(job_for(portal.url), completed_event())
        for index, request in enumerate(portal.requests):
            self.assertTrue(
                verify_signature(
                    SECRET,
                    request["timestamp"],
                    request["body"],
                    request["signature"],
                    now_seconds=int(request["timestamp"]),
                ),
                "attempt {} would be refused by the portal".format(index),
            )

    def test_a_signature_is_not_reused_across_a_changed_timestamp(self):
        """If two attempts share a timestamp they may share a signature; if the
        timestamp moved, the signature must have moved with it. Pinning the
        implication rather than "the signatures differ" keeps this from failing
        on a fast retry that lands in the same second."""

        with RecordingPortal([500, 503]) as portal:
            POST_EVENT(job_for(portal.url), completed_event())
        for earlier, later in zip(portal.requests, portal.requests[1:]):
            if earlier["timestamp"] != later["timestamp"]:
                self.assertNotEqual(
                    earlier["signature"],
                    later["signature"],
                    "a retry reused a signature bound to an older timestamp",
                )

    def test_the_key_id_is_the_one_the_job_named(self):
        """The portal compares this before the signature and answers a bare
        401 on a mismatch, with nothing in the message to work from."""

        with RecordingPortal([]) as portal:
            POST_EVENT(job_for(portal.url), completed_event())
        self.assertEqual(portal.requests[0]["keyId"], "runner-v1")

    def test_the_user_agent_is_not_urllib_s_default(self):
        """Cloudflare's managed rules in front of the portal answer
        "Python-urllib/3.11" with a 403 before the worker sees the request, so
        a runner that sends urllib's default cannot report a single event and
        the run sits in "queued" until the stale sweep fails it. Observed on
        the 2026-09-04 audio run; this pins the header that fixed it."""

        with RecordingPortal([]) as portal:
            POST_EVENT(job_for(portal.url), completed_event())
        self.assertEqual(portal.requests[0]["userAgent"], "cogworks-runner")

    def test_retries_are_spread_out_rather_than_immediate(self):
        """Three requests in the same millisecond are not a retry policy.

        A Worker that answered 500 because it was cold needs a moment to become
        warm. The exact delays are not pinned here (the shipped backoff is
        0.25s doubling), only that the loop waits at all, because pinning the
        constants would make tuning them a test failure rather than a decision.
        """

        with RecordingPortal([500, 500]) as portal:
            started = time.time()
            POST_EVENT(job_for(portal.url), completed_event())
            elapsed = time.time() - started
        self.assertGreater(elapsed, 0.2)
        # And not so long that a run's final event waits on arithmetic. The
        # ceiling is generous on purpose: this is here to catch a backoff that
        # accidentally became minutes, not to police the exact schedule.
        self.assertLess(elapsed, 30)

    def test_a_retry_after_header_is_respected(self):
        with RecordingPortal([429], retry_after=1) as portal:
            started = time.time()
            POST_EVENT(job_for(portal.url), completed_event())
            elapsed = time.time() - started
        self.assertGreaterEqual(elapsed, 1.0)

    def test_a_slow_retry_would_still_be_inside_the_skew_window(self):
        """The retry budget has to fit inside the replay window.

        The portal refuses a timestamp more than five minutes from its own
        clock. Because each attempt is re-signed with a fresh timestamp this is
        not currently reachable, but a future change to either number could
        make the last retry arrive already expired, and that would present as
        an unexplained 401 on the final event of a run that worked.
        """

        with RecordingPortal([500, 500]) as portal:
            started = time.time()
            POST_EVENT(job_for(portal.url), completed_event())
            elapsed = time.time() - started
        self.assertLess(
            elapsed,
            MAX_CLOCK_SKEW_SECONDS,
            "the retry budget exceeds the portal's clock-skew window",
        )


def _execute_job_source() -> str:
    """`execute_job`'s body as source, without importing modal."""

    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.FunctionDef) and node.name == "execute_job":
            return ast.get_source_segment(MODAL_APP.read_text(encoding="utf-8"), node) or ""
    raise AssertionError("execute_job not found")


class ADeliveryFailureIsNotAScoringFailure(unittest.TestCase):
    """Producing a result and delivering it are different problems.

    They shared one `except`, whose handler maps anything raised while the
    phase is `scoring` to `category: "scorer"`. So a portal that would not
    answer turned a run that scored into a scorer failure: the team's real
    number was replaced by a claim that our scorer broke, and in official mode
    that refunds an attempt against a result that exists.
    """

    def setUp(self):
        os.environ["RUNNER_SIGNING_SECRET"] = SECRET

    def test_a_completed_event_that_cannot_land_raises_rather_than_reporting_a_scorer(self):
        # Three 500s exhaust `_post_event`. The caller has to see the failure
        # as a delivery failure, which means it leaves the try that would have
        # relabelled it, so nothing about the score is rewritten on the way out.
        with RecordingPortal([500, 500, 500]) as portal:
            with self.assertRaises(urllib.error.HTTPError):
                POST_EVENT(job_for(portal.url), completed_event())
            bodies = [request["body"] for request in portal.requests]

        self.assertEqual(len(bodies), 3)
        for body in bodies:
            self.assertIn(b'"type":"completed"', body)
            self.assertNotIn(b'"scorer"', body)

    def test_the_completed_callback_is_sent_after_the_scoring_boundary(self):
        """The behavioral proof needs Modal and a sandbox, so this reads the
        one structural fact behind it: the handler that writes a `failed`
        event can no longer see the completed callback raise."""

        source = _execute_job_source()
        boundary = source.index("except Exception as error:")
        sends = [
            index
            for index in range(len(source))
            if source.startswith("reporter.event(", index)
        ]
        after = [index for index in sends if index > boundary]
        self.assertTrue(after, "no callback is sent after the scoring boundary")
        # The one after the boundary is the completed event; the one inside it
        # is the failed event the handler writes.
        self.assertIn('"completed"', source[after[-1] : after[-1] + 200])


if __name__ == "__main__":
    unittest.main()
