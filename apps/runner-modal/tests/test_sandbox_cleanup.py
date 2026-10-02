"""Cleanup failures cannot replace an evaluation, preparation, or interruption.

Run the production function bodies with controlled Modal processes and files.
Payload encoding is supplied at its boundary; failure classification, prediction
validation, and terminal outcome storage still run their shipped code.
"""

from __future__ import annotations

import ast
import contextlib
import io
import json
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_prepared_restore import (
    SOURCE, LazyImage, Reporter, Store, Stream, functions, job, shape_valid_observation,
)
from test_result_durability import InputCancellation
from cogworks_runner.failure import RunnerFailure
from cogworks_runner.week2_payload import RecognitionQueryPlan


LANES = ("_evaluate", "_evaluate_v2", "_evaluate_week3", "_evaluate_week1")


class Sandbox:
    def __init__(self, *, cleanup_error=None, errors=None, returncode=0,
                 stderr="", predictions="[1]"):
        self.cleanup_error = cleanup_error
        self.errors = errors or {}
        self.returncode = returncode
        self.stderr = stderr
        self.predictions = predictions
        self.events = []
        self.filesystem = self

    def step(self, name):
        self.events.append(name)
        if name in self.errors:
            raise self.errors[name]

    def write_text(self, text, path):
        self.step(("write", path))

    def write_bytes(self, data, path):
        self.step(("write", path))

    def read_text(self, path):
        self.step(("read", path))
        return {
            "/tmp/cog-predictions.json": self.predictions,
            "/tmp/cog-student.log": "student output",
            "/tmp/cog-wiring.json": "[]",
            "/tmp/discovery.json": "{}",
        }[path]

    def exec(self, *args, text=True):
        self.events.append(("exec", args))
        stage = "probe" if "-m" in args else "process"
        self.step(stage)
        return types.SimpleNamespace(
            returncode=0 if stage == "probe" else self.returncode,
            stdout=Stream(json.dumps(shape_valid_observation()), text),
            stderr=Stream(self.stderr, text),
            wait=lambda: self.step(stage + "-wait"),
        )

    def snapshot_filesystem(self):
        self.step("snapshot")
        return types.SimpleNamespace(object_id="im-saved")

    def terminate(self):
        self.step("terminate")
        if self.cleanup_error is not None:
            raise self.cleanup_error


def lifecycle(sandbox, create_error=None, preparation=None):
    def create(**options):
        owned = preparation if preparation is not None and isinstance(options["image"], LazyImage) else sandbox
        owned.step("create")
        if create_error is not None:
            raise create_error
        if isinstance(options["image"], LazyImage):
            options["image"].resolve()
        return owned

    return functions(
        "_prepare", *LANES, "_collect_wiring", "_evaluation_failure", "_timed_out",
        "_last_error_line", "_refusal_from", "_fit", "_take_units", "_receiver_units",
        app=object(), LiveReporter=Reporter, PREPARE_SCRIPT="prepare fixture",
        EVALUATE_SCRIPT="evaluate fixture", WEEK1_STUDENT_PYTHON="week1-python",
        WEEK3_STUDENT_PYTHON="week3-python", _WIRING=[],
        _sandbox_image=lambda value: LazyImage(preparation.events if preparation is not None else sandbox.events),
        _student_python=lambda value: "student-python",
        StatusHeartbeat=lambda *args: contextlib.nullcontext(),
        modal=types.SimpleNamespace(
            Image=types.SimpleNamespace(from_id=lambda value: value),
            Sandbox=types.SimpleNamespace(create=create),
            exception=types.SimpleNamespace(InputCancellation=InputCancellation),
        ),
    )


class SandboxCleanup(unittest.TestCase):
    def setUp(self):
        self.encoders = {}
        for module, name, result in (
            ("week1_payload", "encode_payload", b"week1"),
            ("week2_payload", "encode_cases", (b"week2", [])),
            ("week3_payload", "encode_payload", b"week3"),
        ):
            patch = mock.patch("cogworks_runner.{}.{}".format(module, name), return_value=result)
            self.encoders[module] = patch.start()
            self.addCleanup(patch.stop)

    def call(self, space, lane):
        value = job()
        if lane == "_prepare":
            return space[lane](value, Reporter(value))
        return space[lane](value, "im-saved", [])

    def assert_cleanup_reported(self, sandbox, output, phase):
        self.assertEqual(sandbox.events.count("terminate"), 1)
        self.assertIn("sandbox cleanup failed during " + phase, output.getvalue())
        self.assertIn("RuntimeError: termination RPC failed", output.getvalue())
        self.assertIn("Termination is unconfirmed", output.getvalue())

    def test_primary_failure_keeps_identity_cause_and_refusal_in_every_lifecycle(self):
        for lane in ("_prepare", *LANES):
            with self.subTest(lane=lane):
                refusal = {"status": "not_read", "nextStep": "Inspect student.py."}
                failure = RunnerFailure("output_invalid", "contract_check", "Original detail", False, refusal)
                failure.__cause__ = ValueError("original cause")
                point = "probe-wait" if lane == "_prepare" else "process-wait"
                sandbox = Sandbox(errors={point: failure}, cleanup_error=RuntimeError("termination RPC failed"))
                space = lifecycle(sandbox)
                with contextlib.redirect_stderr(io.StringIO()) as output:
                    with self.assertRaises(RunnerFailure) as caught:
                        self.call(space, lane)
                self.assertIs(caught.exception, failure)
                self.assertIs(caught.exception.refusal, refusal)
                self.assertEqual(str(caught.exception.__cause__), "original cause")
                self.assertEqual((failure.category, failure.phase, str(failure), failure.infrastructure),
                                 ("output_invalid", "contract_check", "Original detail", False))
                self.assert_cleanup_reported(sandbox, output, "preparing" if lane == "_prepare" else "evaluating")

    def test_real_student_process_failure_survives_cleanup_in_every_evaluator(self):
        for lane in LANES:
            with self.subTest(lane=lane):
                sandbox = Sandbox(returncode=1, stderr="TypeError: original student failure\n",
                                  cleanup_error=RuntimeError("termination RPC failed"))
                with contextlib.redirect_stderr(io.StringIO()) as output:
                    with self.assertRaises(RunnerFailure) as caught:
                        self.call(lifecycle(sandbox), lane)
                failure = caught.exception
                self.assertEqual((failure.category, failure.phase, str(failure), failure.infrastructure),
                                 ("student_runtime", "evaluating", "original student failure", False))
                self.assert_cleanup_reported(sandbox, output, "evaluating")

    def test_prediction_parse_and_v2_restore_errors_survive_cleanup(self):
        for lane in LANES:
            with self.subTest(lane=lane):
                sandbox = Sandbox(predictions="null", cleanup_error=RuntimeError("termination RPC failed"))
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(RunnerFailure) as caught:
                        self.call(lifecycle(sandbox), lane)
                self.assertEqual(caught.exception.category, "output_invalid")
                self.assertFalse(caught.exception.infrastructure)
                self.assertIn("None", str(caught.exception))
                self.assertEqual(sandbox.events.count("terminate"), 1)

        plan = RecognitionQueryPlan((1,), 1, 1, (1, 0), (2,))
        self.encoders["week2_payload"].return_value = (b"week2", [plan])
        sandbox = Sandbox(cleanup_error=RuntimeError("termination RPC failed"))
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(RunnerFailure) as caught:
                self.call(lifecycle(sandbox), "_evaluate_v2")
        self.assertEqual(caught.exception.category, "output_invalid")
        self.assertFalse(caught.exception.infrastructure)
        self.assertEqual(sandbox.events.count("terminate"), 1)

    def test_v2_success_keeps_restored_recognition_results_after_cleanup_failure(self):
        plan = RecognitionQueryPlan((1,), 1, 1, (1, 0), (2,))
        self.encoders["week2_payload"].return_value = (b"week2", [plan])
        predictions = {"before_enrollment": [None, "known"], "after_enrollment": ["new"]}
        sandbox = Sandbox(predictions=json.dumps([predictions]),
                          cleanup_error=RuntimeError("termination RPC failed"))
        with contextlib.redirect_stderr(io.StringIO()) as output:
            result, log = self.call(lifecycle(sandbox), "_evaluate_v2")
        self.assertEqual(result, [{"known": ["known"], "unknown_before": [None], "post_enrollment": ["new"]}])
        self.assertEqual(log, "student output")
        self.assert_cleanup_reported(sandbox, output, "evaluating")

    def test_prepare_install_and_snapshot_failures_keep_attribution(self):
        for errors, code, stderr, category, phase, infrastructure in (
            ({}, 1, "ERROR: dependency unavailable", "dependency_install", "installing", False),
            ({"snapshot": RuntimeError("snapshot unavailable")}, 0, "", "provider", "preparing", True),
            ({"probe-wait": RuntimeError("probe unavailable")}, 0, "", "provider", "preparing", True),
        ):
            with self.subTest(category=category, errors=errors):
                sandbox = Sandbox(errors=errors, returncode=code, stderr=stderr,
                                  cleanup_error=RuntimeError("termination RPC failed"))
                with contextlib.redirect_stderr(io.StringIO()) as output:
                    with self.assertRaises(RunnerFailure) as caught:
                        self.call(lifecycle(sandbox), "_prepare")
                self.assertEqual((caught.exception.category, caught.exception.phase, caught.exception.infrastructure),
                                 (category, phase, infrastructure))
                self.assertNotIn("termination RPC", str(caught.exception))
                self.assert_cleanup_reported(sandbox, output, "preparing")

    def test_success_keeps_results_and_reports_failed_cleanup(self):
        for lane in ("_prepare", *LANES):
            with self.subTest(lane=lane):
                sandbox = Sandbox(cleanup_error=RuntimeError("termination RPC failed"))
                with contextlib.redirect_stderr(io.StringIO()) as output:
                    result = self.call(lifecycle(sandbox), lane)
                if lane == "_prepare":
                    snapshot, environment = result
                    self.assertEqual(snapshot, "im-saved")
                    self.assertEqual(environment["artifactId"], snapshot)
                    self.assertIn("snapshot", sandbox.events)
                else:
                    self.assertEqual(result, ([1], "student output"))
                    command = next(event[1] for event in sandbox.events if isinstance(event, tuple) and event[0] == "exec")
                    python = {"_evaluate_week1": "week1-python", "_evaluate_week3": "week3-python"}.get(lane, "python")
                    self.assertEqual(command[0], python)
                    payload = {"_evaluate": "/tmp/cog-inputs.json", "_evaluate_v2": "/tmp/cog-v2-payload.zip",
                               "_evaluate_week1": "/tmp/cog-week1-payload.zip", "_evaluate_week3": "/tmp/cog-week3-payload.zip"}[lane]
                    self.assertIn(("write", payload), sandbox.events)
                self.assert_cleanup_reported(sandbox, output, "preparing" if lane == "_prepare" else "evaluating")

    def test_successful_cleanup_is_attempted_once_and_stays_quiet(self):
        for lane in ("_prepare", *LANES):
            with self.subTest(lane=lane):
                sandbox = Sandbox()
                with contextlib.redirect_stderr(io.StringIO()) as output:
                    self.call(lifecycle(sandbox), lane)
                self.assertEqual(sandbox.events.count("terminate"), 1)
                self.assertEqual(output.getvalue(), "")

    def test_interruption_survives_cleanup_in_every_lifecycle(self):
        for lane in ("_prepare", *LANES):
            for stop in (KeyboardInterrupt(), InputCancellation(), SystemExit(7)):
                with self.subTest(lane=lane, stop=type(stop).__name__):
                    point = "probe-wait" if lane == "_prepare" else "process-wait"
                    sandbox = Sandbox(errors={point: stop}, cleanup_error=RuntimeError("termination RPC failed"))
                    with contextlib.redirect_stderr(io.StringIO()) as output:
                        with self.assertRaises(type(stop)) as caught:
                            self.call(lifecycle(sandbox), lane)
                    self.assertIs(caught.exception, stop)
                    self.assert_cleanup_reported(sandbox, output, "preparing" if lane == "_prepare" else "evaluating")

    def test_interruption_during_cleanup_still_stops_the_input(self):
        for lane in ("_prepare", *LANES):
            for stop in (KeyboardInterrupt(), InputCancellation()):
                with self.subTest(lane=lane, stop=type(stop).__name__):
                    sandbox = Sandbox(cleanup_error=stop)
                    with self.assertRaises(type(stop)) as caught:
                        self.call(lifecycle(sandbox), lane)
                    self.assertIs(caught.exception, stop)
                    self.assertEqual(sandbox.events.count("terminate"), 1)

    def test_creation_failure_does_not_terminate_an_unowned_sandbox(self):
        for lane in ("_prepare", *LANES):
            with self.subTest(lane=lane):
                sandbox = Sandbox()
                with self.assertRaises(RunnerFailure) as caught:
                    self.call(lifecycle(sandbox, RuntimeError("creation failed")), lane)
                self.assertEqual(caught.exception.category, "provider")
                self.assertNotIn("terminate", sandbox.events)

    def controller(self, evaluation, preparation):
        space = lifecycle(evaluation, preparation=preparation)
        events, scored = [], []

        def score(predictions, expected):
            scored.append(predictions)
            return [], []

        interrupted_detail = next(
            ast.literal_eval(node.value) for node in ast.parse(SOURCE.read_text()).body
            if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", None) == "INTERRUPTED_DETAIL"
        )
        benchmark = types.SimpleNamespace(
            contract_version="cogworks.submissions.v1", plugin_version="1",
            scorer_version="test-v1", score=score,
        )
        space = functions(
            "execute_job", "_run_claimed", "_settle_interrupted", "LiveReporter",
            "_event", "_finish", "_deliver_terminal", "_outcome_key", "_failure_detail", "_wire_log",
            **{**space, "job_store": Store(), "validate_job": lambda value: value,
               "threading": threading, "INTERRUPTED_DETAIL": interrupted_detail,
               "_load_benchmark": lambda value: benchmark, "_cases": lambda *args: ([1], [1]),
               "_sweep_wire": lambda value: None, "_post_event": lambda value, event: events.append(event)},
        )
        return space, events, scored

    def test_controller_stores_original_failure_and_replays_it_without_another_sandbox(self):
        evaluation = Sandbox(returncode=1, stderr="TypeError: original student failure\n",
                             cleanup_error=RuntimeError("termination RPC failed"))
        preparation = Sandbox(cleanup_error=RuntimeError("termination RPC failed"))
        space, events, scored = self.controller(evaluation, preparation)
        value = job()
        with contextlib.redirect_stderr(io.StringIO()) as output:
            space["execute_job"](value)
            outcome = space["job_store"][space["_outcome_key"](value["jobId"])]
            self.assertEqual(outcome["status"], "failed")
            self.assertEqual(outcome["event"]["failure"], {
                "category": "student_runtime", "phase": "evaluating",
                "detail": "original student failure", "infrastructure": False,
            })
            space["execute_job"](value)
        self.assertTrue(outcome["delivered"])
        self.assertEqual(scored, [])
        self.assertEqual(sum(event["type"] == "failed" for event in events), 1)
        self.assert_cleanup_reported(evaluation, output, "evaluating")
        self.assert_cleanup_reported(preparation, output, "preparing")

    def test_controller_stores_success_after_both_cleanup_calls_fail(self):
        evaluation = Sandbox(cleanup_error=RuntimeError("termination RPC failed"))
        preparation = Sandbox(cleanup_error=RuntimeError("termination RPC failed"))
        space, events, scored = self.controller(evaluation, preparation)
        value = job()
        with contextlib.redirect_stderr(io.StringIO()) as output:
            space["execute_job"](value)
            space["execute_job"](value)
        outcome = space["job_store"][space["_outcome_key"](value["jobId"])]
        self.assertEqual(outcome["status"], "completed")
        self.assertTrue(outcome["delivered"])
        self.assertEqual(outcome["event"]["sanitizedLog"], "student output")
        self.assertEqual(scored, [[1]])
        self.assertEqual(sum(event["type"] == "completed" for event in events), 1)
        self.assert_cleanup_reported(evaluation, output, "evaluating")
        self.assert_cleanup_reported(preparation, output, "preparing")

    def test_controller_settles_the_original_interruption_after_cleanup_failure(self):
        for phase in ("preparing", "evaluating"):
            for stop in (KeyboardInterrupt(), InputCancellation()):
                with self.subTest(phase=phase, stop=type(stop).__name__):
                    preparation = Sandbox(cleanup_error=RuntimeError("termination RPC failed"),
                                          errors={"probe-wait": stop} if phase == "preparing" else {})
                    evaluation = Sandbox(cleanup_error=RuntimeError("termination RPC failed"),
                                         errors={"process-wait": stop} if phase == "evaluating" else {})
                    space, events, scored = self.controller(evaluation, preparation)
                    value = job()
                    with contextlib.redirect_stderr(io.StringIO()) as output:
                        with self.assertRaises(type(stop)) as caught:
                            space["execute_job"](value)
                    self.assertIs(caught.exception, stop)
                    outcome = space["job_store"][space["_outcome_key"](value["jobId"])]
                    self.assertEqual(outcome["status"], "failed")
                    self.assertTrue(outcome["delivered"])
                    self.assertEqual(outcome["event"]["failure"], {
                        "category": "provider", "phase": phase,
                        "detail": space["INTERRUPTED_DETAIL"], "infrastructure": True,
                    })
                    self.assertEqual(scored, [])
                    self.assert_cleanup_reported(preparation, output, "preparing")
                    if phase == "evaluating":
                        self.assert_cleanup_reported(evaluation, output, "evaluating")
                    else:
                        self.assertEqual(evaluation.events, [])


if __name__ == "__main__":
    unittest.main()
