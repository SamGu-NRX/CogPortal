"""A saved report says which command wrote it, and an old one says it cannot.

`cogworks test` scores the smoke-test cases and `cogworks run` the practice
set. Both save a report and `sync` sends the newest, so without this field a
smoke-test number reached the portal looking exactly like a practice result.
"""

from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cogbench.cli import main
from cogbench.models import LocalReport, Metric, RepositoryState


def _report(command=None) -> LocalReport:
    return LocalReport(
        report_id="local_command",
        benchmark_id="audio",
        benchmark_version=2,
        contract_version="cogworks.submissions.v2",
        sdk_version="0.2.0",
        plugin_version="0.2.0",
        repository=RepositoryState(None, "course/team", "a" * 40, False),
        started_at=1,
        finished_at=2,
        metrics=[Metric("top1", "Top-1", 0.5, None, True, True, 3)],
        diagnostics=[],
        output_digest="b" * 64,
        weights_used=[],
        weights_uploaded=[],
        command=command,
    )


class TheFieldOnDisk(unittest.TestCase):
    def test_each_command_survives_a_round_trip(self):
        for command in ("test", "run"):
            with self.subTest(command=command):
                report = _report(command)
                self.assertEqual(json.loads(report.to_json())["command"], command)
                self.assertEqual(LocalReport.from_json(report.to_json()), report)

    def test_an_old_report_reads_as_unrecorded_and_writes_back_unchanged(self):
        legacy = json.loads(_report().to_json())
        self.assertNotIn("command", legacy)
        restored = LocalReport.from_json(json.dumps(legacy))
        self.assertIsNone(restored.command)
        self.assertEqual(json.loads(restored.to_json()), legacy)

    def test_a_value_that_is_not_a_command_is_refused(self):
        # null is refused too: absence is the one legacy form, so a writer
        # that emits null has a bug worth hearing about.
        for value in ("practice", "RUN", "", None, 1, ["run"]):
            with self.subTest(value=value):
                raw = dict(json.loads(_report().to_json()), command=value)
                with self.assertRaisesRegex(ValueError, "command must be one of"):
                    LocalReport.from_json(json.dumps(raw))


class SyncAndShow(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.path = self.tmp / "report.json"

    def _cli(self, argv, text):
        self.path.write_text(text, encoding="utf-8")
        with patch("cogbench.cli.sync_report") as sync, \
                patch("cogbench.cli.token_for", return_value="token"), \
                patch("cogbench.cli._portal", return_value="http://example.com"), \
                patch("cogbench.cli.Path.cwd", return_value=self.tmp):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = main(argv)
        return code, sync, out.getvalue(), err.getvalue()

    def test_sync_sends_the_command_and_names_it(self):
        for command in ("test", "run"):
            with self.subTest(command=command):
                code, sync, out, err = self._cli(
                    ["sync", str(self.path)], _report(command).to_json()
                )
                self.assertEqual(code, 0, err)
                self.assertEqual(sync.call_args[0][2]["command"], command)
                self.assertIn("as LOCAL {} · SELF-REPORTED".format(command.upper()), out)

    def test_sync_of_an_old_report_sends_no_command_and_claims_none(self):
        code, sync, out, err = self._cli(["sync", str(self.path)], _report().to_json())
        self.assertEqual(code, 0, err)
        self.assertNotIn("command", sync.call_args[0][2])
        self.assertIn("as LOCAL · SELF-REPORTED", out)

    def test_sync_of_a_malformed_command_stops_before_posting(self):
        raw = dict(json.loads(_report().to_json()), command="practice")
        code, sync, _, err = self._cli(["sync", str(self.path)], json.dumps(raw))
        self.assertEqual(code, 2)
        self.assertIn("command must be one of 'test', 'run', not 'practice'", err)
        sync.assert_not_called()

    def test_malformed_saved_reports_exit_two_without_printing_or_posting(self):
        invalid_metric = dict(json.loads(_report().to_json()), metrics=[None])
        for raw in ("{}", "[]", "null", "{", json.dumps(invalid_metric)):
            for command in ("report", "sync"):
                with self.subTest(raw=raw, command=command):
                    code, sync, out, err = self._cli([command, str(self.path)], raw)
                    self.assertEqual(code, 2)
                    self.assertEqual(out, "")
                    self.assertIn("Invalid saved report {}:".format(self.path), err)
                    self.assertNotIn("Traceback", err)
                    sync.assert_not_called()

    def test_showing_a_test_report_says_what_it_measured(self):
        code, _, out, err = self._cli(["report", str(self.path)], _report("test").to_json())
        self.assertEqual(code, 0, err)
        self.assertIn("audio v2 · LOCAL TEST · SELF-REPORTED", out)
        self.assertIn("This smoke test scored only the small test cases.", out)
        self.assertNotIn("end to end", out)

        code, _, out, err = self._cli(["report", str(self.path)], _report().to_json())
        self.assertEqual(code, 0, err)
        self.assertIn("audio v2 · LOCAL · SELF-REPORTED", out)
        self.assertNotIn("smoke test", out)


if __name__ == "__main__":
    unittest.main()
