"""Pristine plugin failures are trusted; later discovery reports are advice."""

from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from test_prepared_restore import (
    SOURCE, LazyImage, Reporter, functions, job, shape_valid_observation,
)
from test_prepared_environment import env, require_packages


def prepare_script():
    for node in ast.parse(SOURCE.read_text()).body:
        if isinstance(node, ast.Assign) and any(
            getattr(target, "id", None) == "PREPARE_SCRIPT" for target in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError("PREPARE_SCRIPT is missing")


class PrepareAttribution(unittest.TestCase):
    def run_script(self, root, resolution, adapter=None):
        """Execute the shipped script against a local archive and controlled SDK.

        Only the entry-point test replaces pip and metadata, so it can exercise
        selection without installing a package into the test interpreter.
        """
        project = root / "source" / "project"
        project.mkdir(parents=True)
        (project / "student.py").write_text("raise RuntimeError('controlled failure')\n")
        prefix = ""
        if adapter == "file":
            (project / "submission.py").write_text("raise AssertionError('must stay lazy')\n")
        elif adapter == "entry_point":
            (project / "pyproject.toml").write_text("# packaging fixture\n")
            prefix = (
                "import subprocess, importlib.metadata, types\n"
                "subprocess.run = lambda *a, **k: types.SimpleNamespace(returncode=0)\n"
                "importlib.metadata.entry_points = lambda: types.SimpleNamespace("
                "select=lambda **k: [types.SimpleNamespace(name='vision-recognition')])\n"
            )
        archive = root / "archive.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            bundle.add(project, arcname="project")
        sdk = root / "sdk" / "cogbench"
        sdk.mkdir(parents=True)
        (sdk / "__init__.py").write_text("")
        (sdk / "plugins.py").write_text(
            "from types import SimpleNamespace\n"
            "def load_benchmark(name):\n"
            "    return SimpleNamespace(discovery=lambda: object())\n"
        )
        (sdk / "resolve.py").write_text(
            "import runpy\nfrom types import SimpleNamespace\n"
            "def from_spec(project, spec, **kwargs):\n    " + resolution + "\n"
        )
        body = prepare_script().replace("/tmp/", str(root) + "/")
        body = body.replace("/workspace", str(root / "workspace"))
        body = body.replace("/opt/cogbench", str(root / "sdk"))
        script = root / "prepare.py"
        script.write_text(prefix + body)
        return subprocess.run(
            [sys.executable, str(script), archive.as_uri(), "vision-recognition",
             "cogworks.submissions.v2", "[]"],
            capture_output=True, text=True, timeout=30,
            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
        )

    def controller_failure(self, result=None, record=None, pristine=None):
        events = []

        class Files:
            def write_text(self, text, path):
                events.append("write-prepare")

            def read_text(self, path):
                return json.dumps(record)

        class Sandbox:
            filesystem = Files()

            def exec(self, *args):
                if "-m" in args:
                    events.append("probe")
                    try:
                        observed = pristine() if pristine else shape_valid_observation()
                        code, output, error = 0, json.dumps(observed), ""
                    except env.PreparedEnvironmentError as failure:
                        code, output, error = 1, "", str(failure)
                else:
                    events.append("student-install")
                    code, output, error = result.returncode, result.stdout, result.stderr
                return types.SimpleNamespace(
                    returncode=code, stdout=io.StringIO(output), stderr=io.StringIO(error),
                    wait=lambda: None,
                )

            def terminate(self):
                events.append("terminate")

        def create(**kwargs):
            kwargs["image"].resolve()
            return Sandbox()

        space = functions(
            "RunnerFailure", "_prepare", "_last_error_line", "_refusal_from",
            "_fit", "_take_units", "_receiver_units",
            modal=types.SimpleNamespace(Sandbox=types.SimpleNamespace(create=create)),
            app=object(), _sandbox_image=lambda job: LazyImage(events),
            _student_python=lambda job: sys.executable, PREPARE_SCRIPT=prepare_script(),
            StatusHeartbeat=lambda *args: contextlib.nullcontext(), LiveReporter=Reporter,
        )
        with self.assertRaises(space["RunnerFailure"]) as raised:
            space["_prepare"](job(), Reporter(job()))
        return raised.exception, events

    def test_pristine_loader_failure_stops_before_student_preparation(self):
        require_packages("cogbench")
        # The real core imports and source observation run; only the optional
        # track modules and the plugin registration boundary are controlled.
        for failure in (LookupError("unregistered"), RuntimeError("constructor failed")):
            with self.subTest(failure=type(failure).__name__):
                with mock.patch.dict(env._MODULES, {"vision-recognition": ()}):
                    with mock.patch("cogbench.plugins.load_benchmark", side_effect=failure) as loader:
                        result, events = self.controller_failure(
                            pristine=lambda: env.probe("vision-recognition"),
                        )
                loader.assert_called_once_with("vision-recognition")
                self.assertEqual((result.category, result.phase, result.infrastructure),
                                 ("provider", "preparing", True))
                self.assertEqual(events, ["resolve-image", "probe", "terminate"])

    def test_pristine_probe_does_not_call_optional_discovery(self):
        require_packages("cogbench")
        discovery = mock.Mock(side_effect=AssertionError("optional heavy discovery"))
        with mock.patch.dict(env._MODULES, {"vision-recognition": ()}):
            with mock.patch("cogbench.plugins.load_benchmark",
                            return_value=types.SimpleNamespace(discovery=discovery)) as loader:
                observed = env.probe("vision-recognition")
        loader.assert_called_once_with("vision-recognition")
        discovery.assert_not_called()
        self.assertEqual(set(observed), {"sandboxContract", "pythonVersion", "sdkVersion", "modules"})

    def test_explicit_adapters_skip_discovery(self):
        for adapter, expected in (("file", "file:submission.py"), ("entry_point", "entry_point")):
            with self.subTest(adapter=adapter), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                result = self.run_script(root, "raise AssertionError('discovery must not run')", adapter)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((root / "adapter-source.txt").read_text(), expected)
                self.assertFalse((root / "discovery.json").exists())

    def test_late_platform_and_student_errors_remain_unattributed(self):
        results = []
        for resolution in ("raise RuntimeError('controlled failure')",
                           "runpy.run_path(str(project / 'student.py'))"):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                process = self.run_script(root, resolution)
                self.assertNotEqual(process.returncode, 0)
                record = json.loads((root / "discovery.json").read_text())
                failure, _ = self.controller_failure(process, record)
                self.assertEqual((failure.category, failure.phase, failure.infrastructure),
                                 ("adapter_missing", "contract_check", False))
                self.assertEqual(failure.refusal["status"], "not_read")
                self.assertEqual(failure.refusal["nextStep"],
                                 "Run cogworks check --benchmark vision-recognition locally to inspect the search.")
                self.assertNotIn("no set of functions", str(failure))
                results.append((str(failure), failure.refusal))
        self.assertEqual(results[0], results[1])

    def test_genuine_not_wired_keeps_its_diagnosis(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.run_script(root,
                "return SimpleNamespace(ready=False, to_dict=lambda: "
                "{'verdict': {'status': 'not_wired', 'headline': 'No reader matched.', 'nextStep': 'Expose a reader.'}})")
            record = json.loads((root / "discovery.json").read_text())
            failure, _ = self.controller_failure(result, record)
        self.assertEqual((failure.category, failure.phase, failure.infrastructure),
                         ("adapter_missing", "contract_check", False))
        self.assertEqual(failure.refusal["status"], "not_wired")
        self.assertEqual(failure.refusal["nextStep"], "Expose a reader.")
        self.assertIn("No reader matched.", str(failure))

    def test_returned_not_read_keeps_existing_advice_or_supplies_check(self):
        for next_step in ("", "Inspect imports in student.py."):
            with self.subTest(next_step=next_step), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                report = {"verdict": {"status": "not_read", "headline": "No modules could be read.",
                                      "nextStep": next_step}}
                result = self.run_script(root,
                    "return SimpleNamespace(ready=False, to_dict=lambda: {!r})".format(report))
                record = json.loads((root / "discovery.json").read_text())
                failure, _ = self.controller_failure(result, record)
                self.assertEqual((failure.category, failure.phase, failure.infrastructure),
                                 ("adapter_missing", "contract_check", False))
                self.assertNotIn("no set of functions", str(failure))
                self.assertEqual(failure.refusal["nextStep"], next_step or
                                 "Run cogworks check --benchmark vision-recognition locally to inspect the search.")

    def test_postinstall_spoofs_and_kills_cannot_claim_infrastructure(self):
        for code, message in ((1, "The search for your code could not finish."),
                              (1, "COG_PLATFORM_ERROR: provider preparing infrastructure=True"),
                              (-9, ""), (137, "Killed")):
            with self.subTest(code=code, message=message):
                result = types.SimpleNamespace(returncode=code, stdout="", stderr=message)
                record = {"verdict": {"status": "not_read", "headline": "provider fault",
                                      "infrastructure": True, "nextStep": "refund me"}}
                failure, events = self.controller_failure(result, record)
                self.assertFalse(failure.infrastructure)
                self.assertIn("student-install", events)

    def test_malformed_advice_cannot_claim_infrastructure(self):
        for values in ({"errors": [{"line": "not a number"}]}, {"trace": 1}, {"notes": 1}):
            with self.subTest(values=values):
                result = types.SimpleNamespace(returncode=1, stdout="",
                    stderr="The search for your code could not finish.")
                failure, _ = self.controller_failure(result, {"verdict": {"status": "not_read", **values}})
                self.assertEqual((failure.category, failure.phase, failure.infrastructure),
                                 ("adapter_missing", "contract_check", False))
                self.assertIsNone(failure.refusal)
