"""`check` and `run` answer the same question, in a process they can lose.

Two failures live here. `check` used to accept an installed entry point that
`run` would then refuse, so a repository passed the readiness report and raised
on the command that report ended with. And reading a repository happened in
this process, so a student module that ends the interpreter rather than raises
took the report down with it and printed nothing about the repository at all.
"""

from __future__ import annotations

import io
import os
import shutil
import signal
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import cli  # noqa: E402
from cogbench.plugins import PluginError  # noqa: E402


class _NoDiscovery:
    """A benchmark that does not describe its task to the search.

    `vision-recognition` is this shape: it has no `discovery` and no
    `submission_from_discovery`, while the reference `face_recognition_app`
    registers an installed entry point for it.
    """

    contract_version = "cogworks.submissions.v2"


class _Discoverable:
    contract_version = "cogworks.submissions.v2"

    def submission_from_discovery(self, submission):
        return ("discovered", submission)


class _Ready:
    ready = True
    weights_used = ()

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
        adapter, weights = cli._submission_for("b", _Discoverable(), self.tmp, as_json=True)

        self.assertEqual(scoreable.source, "discovery")
        self.assertIsNotNone(scoreable.factory)
        self.assertEqual(adapter()[0], "discovered")
        self.assertEqual(weights, [])

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
        cli._check_view = lambda *a, **k: {"pid": os.getpid()}

        view, status, _detail = cli._read_repository("b", self.tmp, True)

        self.assertEqual(status, "completed")
        self.assertNotEqual(view["pid"], parent)

    def test_a_crash_still_prints_a_report_and_reports_not_ready(self):
        def _abort(*_args, **_kwargs):
            os.kill(os.getpid(), signal.SIGSEGV)

        cli._check_view = _abort
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = cli._check("audio-identification", False, self.tmp)

        self.assertEqual(code, 2)
        self.assertIn("ended the process before it finished", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
