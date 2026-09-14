"""Provisioning is observed before student execution; reuse never re-prepares."""
from __future__ import annotations

import ast
import contextlib
import copy
import hashlib
import io
import json
import os
import sys
import time
import types
import unittest
from unittest import mock
from pathlib import Path
from urllib.parse import quote, urlsplit
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps/runner-modal/src"))
sys.path.insert(0, str(Path(__file__).parent))
from test_prepared_environment import require_benchmark
from cogworks_runner.prepared_environment import (
    PreparedEnvironmentError, bind_environment, probe,
    validate_observation, validate_prepared_environment,
)
from cogworks_runner.protocol import canonical_json, signature

SOURCE = ROOT / "apps/runner-modal/src/cogworks_runner/modal_app.py"


def job():
    return {
        "protocolVersion": "1", "jobId": "job_test", "runId": "run_test",
        "mode": "practice", "preparedArtifactId": None,
        "source": {"repositoryId": 1, "fullName": "test/project", "sha": "a" * 40,
                   "archiveUrl": "https://api.github.com/repos/test/project/tarball/" + "a" * 40},
        "benchmark": {"id": "vision-recognition", "version": 2,
                      "contractVersion": "cogworks.submissions.v2", "pluginVersion": "1",
                      "scorerVersion": "recognition-v1", "datasetVersion": "practice-v1",
                      "sandboxContract": 1},
        "runtime": {"cpu": 1, "memoryMb": 4096, "timeoutSeconds": 900,
                    "pythonVersion": "3.11", "imageDigest": "requested-new-image",
                    "maxOutputBytes": 8192},
        "callback": {"url": "https://portal.invalid/events", "keyId": "runner-v1"},
        "weights": [],
    }


def functions(*names, **globals_):
    nodes = []
    for node in ast.parse(SOURCE.read_text()).body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names:
            node.decorator_list = []
            nodes.append(node)
    assert len(nodes) == len(names)
    namespace = {"Dict": Dict, "Any": Any, "Tuple": Tuple, "List": List,
                 "Optional": Optional, "time": time, "os": os, "sys": sys,
                 "json": json, "hashlib": hashlib, "urlsplit": urlsplit, "quote": quote,
                 "signature": signature, "canonical_json": canonical_json,
                 "PreparedEnvironmentError": PreparedEnvironmentError,
                 "bind_environment": bind_environment, "validate_observation": validate_observation,
                 "validate_prepared_environment": validate_prepared_environment,
                 **globals_}
    exec(compile(ast.Module(nodes, []), str(SOURCE), "exec"), namespace)
    return namespace


class Store(dict):
    def put(self, key, value, skip_if_exists=False):
        if skip_if_exists and key in self:
            return False
        self[key] = value
        return True


class Reporter:
    def __init__(self, job):
        self.job = job

    def status(self, *args):
        pass

    def build(self, kind, **values):
        return {"type": kind, "runId": self.job["runId"], **values}


class RestoreDependencyGate(unittest.TestCase):
    def test_available_dependency_does_not_hide_a_probe_contract_defect(self):
        with mock.patch(__name__ + ".require_benchmark"):
            with mock.patch(__name__ + ".probe", side_effect=PreparedEnvironmentError("real contract defect")):
                with self.assertRaisesRegex(PreparedEnvironmentError, "real contract defect"):
                    PreparedRestore().observation()


class PreparedRestore(unittest.TestCase):
    def observation(self):
        # These are real installed modules, not paths or package labels supplied
        # by a student-controlled response. The test lane needs Week 2 installed.
        require_benchmark("vision-recognition")
        return probe("vision-recognition")

    def prepare_space(self, observation, fail_probe=False):
        events = []
        image = types.SimpleNamespace(object_id="im-base", hydrate=lambda: events.append("hydrate"))

        class Files:
            def write_text(self, text, path):
                events.append("write-prepare")

        class Sandbox:
            filesystem = Files()

            def exec(self, *args):
                pristine = "-m" in args
                events.append("probe" if pristine else "student-install")
                return types.SimpleNamespace(
                    returncode=1 if pristine and fail_probe else 0,
                    wait=lambda: None,
                    stdout=io.StringIO(json.dumps(observation)), stderr=io.StringIO(""),
                )

            def snapshot_filesystem(self):
                events.append("snapshot")
                return types.SimpleNamespace(object_id="im-saved")

            def terminate(self):
                events.append("terminate")

        space = functions(
            "RunnerFailure", "_prepare",
            modal=types.SimpleNamespace(Sandbox=types.SimpleNamespace(create=lambda **kwargs: Sandbox())),
            app=object(), _sandbox_image=lambda job: image, _student_python=lambda job: sys.executable,
            PREPARE_SCRIPT="student installation", StatusHeartbeat=lambda *args: contextlib.nullcontext(),
            LiveReporter=Reporter,
        )
        return space, events

    def test_pristine_probe_precedes_any_student_files_or_installation(self):
        space, events = self.prepare_space(self.observation())
        snapshot, evidence = space["_prepare"](job(), Reporter(job()))
        self.assertEqual(events, ["hydrate", "probe", "write-prepare", "student-install", "snapshot", "terminate"])
        self.assertEqual(evidence["artifactId"], snapshot)
        self.assertEqual(evidence["baseImageId"], "im-base")
        self.assertTrue(all(Path(module["path"]).is_file() for module in evidence["modules"]))
        self.assertEqual(evidence["source"], {key: job()["source"][key] for key in ("repositoryId", "fullName", "sha")})

    def test_bad_pristine_probe_never_installs_or_snapshots(self):
        for observed, fail in (({}, False), (self.observation(), True)):
            space, events = self.prepare_space(observed, fail)
            with self.assertRaises(space["RunnerFailure"]) as failure:
                space["_prepare"](job(), Reporter(job()))
            self.assertEqual(failure.exception.category, "provider")
            self.assertEqual(failure.exception.phase, "preparing")
            self.assertNotIn("student-install", events)
            self.assertNotIn("snapshot", events)

    def execute_space(self):
        events = []
        forbidden = lambda *args, **kwargs: self.fail("reuse reached preparation or evaluation before compatibility")
        space = functions(
            "RunnerFailure", "execute_job", job_store=Store(), validate_job=lambda value: value,
            _outcome_key=lambda key: key + ":outcome", LiveReporter=Reporter,
            _prepare=forbidden, _load_benchmark=forbidden, _evaluate_v2=forbidden,
            _finish=lambda job, outcome, status: events.append(outcome["event"]),
            _WIRING=[],
        )
        return space, events

    def test_unknown_or_wrong_artifact_fails_before_evaluation(self):
        evidence = bind_environment(job(), self.observation(), "im-saved", "im-base")
        wrong_artifact = copy.deepcopy(evidence)
        wrong_artifact["artifactId"] = "im-other"
        incompatible = copy.deepcopy(evidence)
        incompatible["sandboxContract"] = 999
        for record in (None, wrong_artifact, incompatible):
            space, events = self.execute_space()
            value = job()
            value.update(mode="official", preparedArtifactId="im-saved", preparedEnvironment=record)
            space["execute_job"](value)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["type"], "failed")
            self.assertEqual(events[0]["failure"]["category"], "provider")
            self.assertEqual(events[0]["failure"]["phase"], "contract_check")

    def test_valid_reuse_reaches_current_scorer_without_preparing(self):
        space, events = self.execute_space()
        observed = self.observation()
        evidence = bind_environment(job(), observed, "im-saved", "im-base")
        value = job()
        value.update(mode="official", preparedArtifactId="im-saved", preparedEnvironment=evidence)
        value["benchmark"]["scorerVersion"] = "recognition-v2"
        benchmark = types.SimpleNamespace(contract_version="cogworks.submissions.v2", plugin_version="1", scorer_version="recognition-v2")
        evaluated = []
        space.update(
            _load_benchmark=lambda value: benchmark, _v2_cases=lambda *args: [object()],
            _evaluate_v2=lambda job, snapshot, cases: (evaluated.append(snapshot) or [{"ok": True}], ""),
            _check_predictions=lambda *args: None, _v2_metrics=lambda *args: ([], []),
            _sweep_wire=lambda *args: None, StatusHeartbeat=lambda *args: contextlib.nullcontext(),
            EVALUATE_SCRIPT="current script",
        )
        space["execute_job"](value)
        self.assertEqual(evaluated, ["im-saved"])
        self.assertEqual(events[0]["type"], "completed")
        self.assertEqual(events[0]["preparedEnvironment"], evidence)
        self.assertEqual(events[0]["preparedEnvironment"]["pythonVersion"], observed["pythonVersion"])

    def test_missing_snapshot_keeps_provider_restore_failure(self):
        observed = self.observation()
        evidence = bind_environment(job(), observed, "im-deleted", "im-base")
        value = job()
        value.update(mode="official", preparedArtifactId="im-deleted", preparedEnvironment=evidence)
        self.assertIsNone(validate_prepared_environment(value, evidence))
        touched = []

        def unavailable(**kwargs):
            touched.append("restore")
            raise RuntimeError("Image no longer exists")

        evaluator = functions(
            "RunnerFailure", "_evaluate_v2", app=object(), EVALUATE_SCRIPT="script",
            modal=types.SimpleNamespace(Image=types.SimpleNamespace(from_id=lambda value: object()),
                                        Sandbox=types.SimpleNamespace(create=unavailable)),
        )
        with self.assertRaises(evaluator["RunnerFailure"]) as caught:
            evaluator["_evaluate_v2"](value, "im-deleted", [])
        self.assertEqual(touched, ["restore"])
        self.assertEqual(caught.exception.category, "provider")
        self.assertEqual(caught.exception.phase, "evaluating")
        self.assertTrue(caught.exception.infrastructure)

    def test_student_exception_cannot_request_platform_compatibility_attribution(self):
        self.observation()
        sys.path.insert(0, str(Path(__file__).parent))
        from test_forgery_corpus import _attack
        returncode, stderr = _attack(r'''
import os
os.write(2, b'COG_PLATFORM_ERROR: preparedEnvironment sandboxContract incompatible, refund required\\n')
raise ValueError("my own bug")
''')
        self.assertNotEqual(returncode, 0)
        self.assertIn("sandboxContract incompatible", stderr)
        process = types.SimpleNamespace(returncode=returncode, wait=lambda: None, stderr=io.StringIO(stderr))
        sandbox = types.SimpleNamespace(
            filesystem=types.SimpleNamespace(write_text=lambda *args: None, write_bytes=lambda *args: None),
            exec=lambda *args: process, terminate=lambda: None,
        )
        space = functions(
            "RunnerFailure", "_evaluate_v2", "_last_error_line", app=object(), EVALUATE_SCRIPT="real script tested above",
            modal=types.SimpleNamespace(Image=types.SimpleNamespace(from_id=lambda value: object()),
                                        Sandbox=types.SimpleNamespace(create=lambda **kwargs: sandbox)),
        )
        with self.assertRaises(space["RunnerFailure"]) as caught:
            space["_evaluate_v2"](job(), "im-saved", [])
        self.assertEqual(caught.exception.category, "student_runtime")
        self.assertFalse(caught.exception.infrastructure)


if __name__ == "__main__":
    unittest.main()
