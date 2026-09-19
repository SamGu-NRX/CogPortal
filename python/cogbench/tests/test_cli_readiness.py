"""`check` and `run` answer the same question, in a process they can lose.

Two failures live here. `check` used to accept an installed entry point that
`run` would then refuse, so a repository passed the readiness report and raised
on the command that report ended with. And reading a repository happened in
this process, so a student module that ends the interpreter rather than raises
took the report down with it and printed nothing about the repository at all.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import cli, isolate  # noqa: E402
from cogbench.isolate import CRASHED, Outcome  # noqa: E402
from cogbench.plugins import PluginError  # noqa: E402


class _NoDiscovery:
    """A benchmark that does not describe its task to the search.

    `vision-recognition` is this shape: it has no `discovery` and no
    `submission_from_discovery`, while the reference `face_recognition_app`
    registers an installed entry point for it.
    """

    contract_version = "cogworks.submissions.v2"


class _Installed(_NoDiscovery):
    """The little of a benchmark `_check` reads before it reads a repository.

    Both cache probes, because the module-level fallback for the model probe
    reads package data from a benchmark distribution, and this test is about
    what the report says when a repository cannot be read.
    """

    def cache_status(self, tier):
        return SimpleNamespace(ready=True, path=Path("/tmp"), message="")

    def model_cache_status(self):
        return {"ready": True, "message": ""}


class _Discoverable:
    contract_version = "cogworks.submissions.v2"

    def submission_from_discovery(self, submission):
        return ("discovered", submission)


class _Ready:
    ready = True

    def to_dict(self):
        return {"root": "."}


class CheckAndRunAgree(unittest.TestCase):
    """The two commands read one decision, so they cannot contradict."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.addCleanup(setattr, cli, "resolve_submission", cli.resolve_submission)
        self.addCleanup(setattr, cli, "_discover", cli._discover)

    def test_an_entry_point_with_no_discovery_is_not_ready_on_either_path(self):
        """Reproduced: check returned ready, then run raised PluginError."""

        cli.resolve_submission = lambda *a, **k: (
            "the reference package",
            "entry_point",
            "cogworks.submissions.v2",
        )
        cli._discover = lambda *a, **k: (None, None, None)

        scoreable = cli._scoreable("b", _NoDiscovery(), self.tmp, as_json=True)

        self.assertIsNone(scoreable.factory, "nothing here is scoreable")
        self.assertIsNone(scoreable.source)
        self.assertEqual(scoreable.declared_source, "entry_point")
        with self.assertRaises(PluginError):
            cli._submission_for("b", _NoDiscovery(), self.tmp, as_json=True)

    def test_a_ready_discovery_without_a_builder_is_not_ready_on_either_path(self):
        """`ready` is about their code. Whether the benchmark can build an
        adapter from it is about ours, and check never asked."""

        cli.resolve_submission = lambda *a, **k: (None, "entry_point", "")
        cli._discover = lambda *a, **k: (_Ready(), None, None)

        scoreable = cli._scoreable("b", _NoDiscovery(), self.tmp, as_json=True)

        self.assertIsNone(scoreable.factory)
        with self.assertRaises(PluginError):
            cli._submission_for("b", _NoDiscovery(), self.tmp, as_json=True)

    def test_what_run_would_score_is_what_check_reports(self):
        cli.resolve_submission = lambda *a, **k: (None, "entry_point", "")
        cli._discover = lambda *a, **k: (_Ready(), None, None)

        scoreable = cli._scoreable("b", _Discoverable(), self.tmp, as_json=True)
        adapter = cli._submission_for("b", _Discoverable(), self.tmp, as_json=True)

        self.assertEqual(scoreable.source, "discovery")
        self.assertIsNotNone(scoreable.factory)
        self.assertEqual(adapter()[0], "discovered")

    def test_a_declared_file_is_scored_without_searching(self):
        cli.resolve_submission = lambda *a, **k: ("theirs", "file", "submission.py")
        cli._discover = lambda *a, **k: self.fail("a declaration ends the question")

        scoreable = cli._scoreable("b", _Discoverable(), self.tmp, as_json=True)

        self.assertEqual(scoreable.source, "file")
        self.assertEqual(scoreable.factory, "theirs")

@unittest.skipUnless(hasattr(os, "fork"), "no fork, so nothing to isolate")
class ReadingCannotTakeTheCommandDown(unittest.TestCase):
    """The boundary `discover.survey` documents, around the whole of check."""

    def setUp(self):
        platform_patch = patch.object(isolate, "_isolation_backend", side_effect=lambda: isolate.run_isolated)
        platform_patch.start()
        self.addCleanup(platform_patch.stop)
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.addCleanup(setattr, cli, "_check_view", cli._check_view)

    def test_a_native_crash_costs_the_report_and_not_the_process(self):
        """Stands in for the measured case: an mp3 helper loads a second copy
        of a native audio backend and aborts the interpreter, which no `except`
        clause can see."""

        def _abort(*_args, **_kwargs):
            os.kill(os.getpid(), signal.SIGSEGV)

        cli._check_view = _abort

        view, status, detail = cli._read_repository("b", self.tmp, True)

        self.assertIsNone(view, "the child reported nothing")
        self.assertNotEqual(status, "completed")
        self.assertIn("segfault", detail.lower())

    def test_the_reading_happens_somewhere_else(self):
        parent = os.getpid()
        cli._check_view = lambda *a, **k: {"pid": os.getpid(), "report": None}

        view, status, _detail = cli._read_repository("b", self.tmp, True)

        self.assertEqual(status, "completed")
        self.assertNotEqual(view["pid"], parent)

    def test_a_crash_still_prints_a_report_and_reports_not_ready(self):
        def _abort(*_args, **_kwargs):
            os.kill(os.getpid(), signal.SIGSEGV)

        # The benchmark has to be installed and loadable, or `_check` reports
        # that instead and never reaches the repository. It is present on a
        # machine set up for a week and absent from the plain CI job, so both
        # the entry-point listing and the loader stand one in.
        cli._check_view = _abort
        self.addCleanup(setattr, cli, "load_benchmark", cli.load_benchmark)
        self.addCleanup(setattr, cli, "plugin_names", cli.plugin_names)
        cli.load_benchmark = lambda *a, **k: _Installed()
        cli.plugin_names = lambda group: (
            ["audio-identification"] if group.endswith(".v2") else []
        )
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = cli._check("audio-identification", False, self.tmp)

        self.assertEqual(code, 2)
        self.assertIn("ended the process before it finished", stdout.getvalue())


@unittest.skipUnless(hasattr(os, "fork"), "no fork, so nothing to isolate")
class ScoredRunIsolation(unittest.TestCase):
    def setUp(self):
        platform_patch = patch.object(isolate, "_isolation_backend", side_effect=lambda: isolate.run_isolated)
        platform_patch.start()
        self.addCleanup(platform_patch.stop)
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _main(self, command="run", *flags):
        stdout = io.StringIO()
        with patch.object(cli.Path, "cwd", return_value=self.tmp), redirect_stdout(stdout):
            code = cli.main([command, "--benchmark", "fixture", *flags])
        return code, stdout.getvalue()

    def _report(self, **kwargs):
        from cogbench.models import LocalReport, RepositoryState

        return LocalReport.create(
            benchmark_id="fixture", benchmark_version=1,
            contract_version="cogworks.submissions.v2", sdk_version="0.2.0",
            plugin_version="0.2.0", repository=RepositoryState(None, None, None, False),
            started_at=1, finished_at=2, metrics=[], predictions=[],
            diagnostics=["child pid: {}".format(os.getpid())], **kwargs,
        )

    def test_resolve_and_execute_stay_in_child_and_parent_saves_the_report(self):
        parent = os.getpid()

        def resolve(*args, **kwargs):
            self.assertNotEqual(os.getpid(), parent)
            self.assertEqual(args[2], self.tmp)
            return lambda: "unpicklable adapter"

        def execute(benchmark, adapter, root, **kwargs):
            self.assertNotEqual(os.getpid(), parent)
            self.assertEqual(adapter(), "unpicklable adapter")
            self.assertEqual(root, self.tmp)
            self.assertEqual(kwargs["smoke"], command == "test")
            return self._report()

        def save(report, root):
            self.assertEqual(os.getpid(), parent)
            self.assertEqual(root, self.tmp)
            self.assertNotEqual(report.diagnostics, ["child pid: {}".format(parent)])
            return self.tmp / "report.json"

        for command in ("run", "test"):
            with self.subTest(command=command), patch.object(cli, "load_benchmark", return_value=object()), \
                    patch.object(cli, "_submission_for", side_effect=resolve), \
                    patch.object(cli, "execute", side_effect=execute), \
                    patch.object(cli, "save_report", side_effect=save) as saved:
                code, text = self._main(command, "--json")
                self.assertEqual(code, 0, text)
                saved.assert_called_once()

    def test_a_crash_in_resolution_or_execution_reports_no_result(self):
        def abort(*args, **kwargs):
            os.kill(os.getpid(), signal.SIGSEGV)

        for command in ("run", "test"):
            for stage in ("_submission_for", "execute"):
                with self.subTest(command=command, stage=stage), \
                        patch.object(cli, "load_benchmark", return_value=object()), \
                        patch.object(cli, "_submission_for", return_value=lambda: None), \
                        patch.object(cli, stage, side_effect=abort), \
                        patch.object(cli, "save_report") as saved:
                    code, text = self._main(command, "--json")
                    value = json.loads(text)
                    self.assertEqual(code, 2)
                    self.assertEqual(value["status"], "crashed")
                    self.assertIn("segfault", value["detail"])
                    self.assertNotIn("metrics", value)
                    saved.assert_not_called()

    def test_the_scored_run_is_given_no_budget_of_its_own(self):
        """The boundary is here to contain a crash, not to time the benchmark.

        Its defaults are discovery's: 300 seconds of CPU and 3 GiB, sized for
        reading a repository. The hosted runner allows a scored run 900 seconds
        and 4 GiB, and two hosted runs of one 2026 week 1 repository took 875
        and 898 seconds, so inheriting the default would have ended a working
        submission at 300 and called it a timeout.
        """

        seen = {}

        def record(work, **kwargs):
            # Captured, then stopped. What this pins is the budget the caller
            # asks for, not what a completed run would print.
            seen.update(kwargs)
            return Outcome(CRASHED, detail="stopped by the test")

        with patch.object(cli, "_run_view", return_value="{}"), \
                patch.object(isolate, "run_isolated", side_effect=record), \
                patch.object(cli, "save_report"):
            self._main()

        self.assertIsNone(seen["timeout_seconds"], "no wall clock on a scored run")
        self.assertIsNone(seen["memory_bytes"], "no ceiling on a scored run")

    def test_live_worker_sends_progress_and_a_terminal_event_from_the_child(self):
        parent = os.getpid()
        events = self.tmp / "live-events.json"

        def deliver_batch(portal, token, session_id, history):
            events.write_text(json.dumps({"pid": os.getpid(), "events": history}))

        def execute(*args, **kwargs):
            kwargs["progress"]("evaluating", 1, 1)
            if fail:
                raise cli.ContractError("adapter returned the wrong shape")
            return self._report()

        for fail in (False, True):
            with self.subTest(fail=fail), \
                    patch.object(cli, "load_benchmark", return_value=object()), \
                    patch.object(cli, "_submission_for", return_value=lambda: None), \
                    patch.object(cli, "_start_live_run", side_effect=lambda *args:
                                 cli._LiveRun("https://fixture.invalid", "token", "session")), \
                    patch.object(cli, "send_local_run_event"), \
                    patch.object(cli, "send_local_run_event_batch", side_effect=deliver_batch), \
                    patch.object(cli, "execute", side_effect=execute):
                code, text = self._main("run", "--live", "--json")
                self.assertEqual(code, 2 if fail else 0, text)
                sent = json.loads(events.read_text())
                self.assertNotEqual(sent["pid"], parent)
                self.assertEqual([event["type"] for event in sent["events"]],
                                 ["progress", "progress", "failed" if fail else "completed"])
                self.assertEqual(sent["events"][1]["progress"]["current"], 1)
                if fail:
                    self.assertEqual(sent["events"][-1]["code"], "run.failed.contract")
                else:
                    self.assertEqual(sent["events"][-1]["report"]["benchmarkId"], "fixture")

    def test_json_redirects_python_and_native_output_through_execution(self):
        script = r'''
import os
import sys
from pathlib import Path
from cogbench import cli
from cogbench.models import LocalReport, RepositoryState

def resolve(*args, **kwargs):
    for i in range(1000):
        print("student import", i)
    os.write(1, b"native import\n")
    return lambda: None, []

def execute(*args, **kwargs):
    print("student execution")
    os.write(1, b"native execution\n")
    return LocalReport.create(
        benchmark_id="fixture", benchmark_version=1,
        contract_version="cogworks.submissions.v2", sdk_version="0.2.0",
        plugin_version="0.2.0", repository=RepositoryState(None, None, None, False),
        started_at=1, finished_at=2, metrics=[], diagnostics=[], predictions=[],
    )
cli.load_benchmark = lambda *args: object()
cli._submission_for = resolve
cli.execute = execute
from cogbench import isolate
isolate._isolation_backend = lambda: isolate.run_isolated
raise SystemExit(cli.main(["run", "--benchmark", "fixture"] + sys.argv[1:]))
'''
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1",
                           PYTHONPATH=str(ROOT / "python/cogbench/src"))
        for flags in (["--json"], []):
            with self.subTest(flags=flags):
                result = subprocess.run([sys.executable, "-c", script, *flags], cwd=self.tmp,
                                        env=environment, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                student_output = result.stderr if flags else result.stdout
                if flags:
                    self.assertEqual(json.loads(result.stdout)["benchmarkId"], "fixture")
                    self.assertNotIn("student import", result.stdout)
                else:
                    self.assertIn("saved:", result.stdout)
                self.assertEqual(student_output.count("student import"), 1000)
                for line in ("native import", "student execution", "native execution"):
                    self.assertIn(line, student_output)



if __name__ == "__main__":
    unittest.main()
