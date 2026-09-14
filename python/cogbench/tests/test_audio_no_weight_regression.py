"""A real no-weight Audio report must survive the capture change untouched.

`fixtures/audio_no_weight_report.json` is a genuine `cogworks run` result for
audio-identification, captured from the accepted SDK before capture existed:
score 0.5375, eleven metrics, two floors and two reported metrics, and no
weights at all. Three of the four benchmark tracks look like this, so it is
the shape most likely to be broken by work aimed at the fourth.

It also predates `weightsUploaded`, which is why it is worth keeping: a saved
report from before this change still has to load, save and sync.
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

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.cli import main  # noqa: E402
from cogbench.models import LocalReport  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "audio_no_weight_report.json"


class TheRealAudioReportStillRoundTrips(unittest.TestCase):
    def setUp(self):
        self.raw = FIXTURE.read_text(encoding="utf-8")
        self.report = LocalReport.from_json(self.raw)

    def test_it_loads_without_capture_provenance(self):
        self.assertEqual(self.report.benchmark_id, "audio-identification")
        self.assertEqual(len(self.report.metrics), 11)
        self.assertEqual(self.report.weights_used, [])
        # Absent, not empty: this report is from before capture existed and
        # cannot claim it had nothing to upload.
        self.assertIsNone(self.report.weights_uploaded)

    def test_the_score_and_its_floors_are_unchanged(self):
        by_key = {metric.key: metric for metric in self.report.metrics}
        self.assertAlmostEqual(by_key["identification_score"].value, 0.5375, places=4)
        self.assertTrue(by_key["identification_score"].primary)
        self.assertIsNone(by_key["identification_score"].role)
        self.assertEqual(by_key["chance_top1"].role, "floor")
        self.assertEqual(by_key["chance_top1"].relates_to, "identification_score")
        self.assertEqual(by_key["trivial_baseline_top1"].role, "floor")
        self.assertEqual(by_key["margin_separation"].role, "reported")
        self.assertEqual(by_key["median_identify_seconds"].role, "reported")

    def test_saving_it_again_changes_nothing_a_reader_depends_on(self):
        before = json.loads(self.raw)
        after = json.loads(self.report.to_json())
        # The one added key is the provenance field, which stays null here.
        self.assertEqual(set(after) - set(before), {"weightsUploaded"})
        self.assertIsNone(after["weightsUploaded"])
        for key in before:
            self.assertEqual(after[key], before[key], key)


class SyncingItUploadsNothing(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.report_file = self.tmp / "report.json"
        self.report_file.write_text(FIXTURE.read_text(encoding="utf-8"), encoding="utf-8")

    def test_a_no_weight_report_syncs_with_no_uploads(self):
        with patch("cogbench.cli.sync_report") as sync, \
                patch("cogbench.cli.upload_weight") as upload, \
                patch("cogbench.cli.token_for", return_value="test_token"), \
                patch("cogbench.cli._resolve_report", return_value=self.report_file), \
                patch("cogbench.cli._portal", return_value="http://example.com"), \
                patch("cogbench.cli.Path.cwd", return_value=self.tmp):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = main(["sync", str(self.report_file)])

        self.assertEqual(code, 0, err.getvalue())
        upload.assert_not_called()
        self.assertIn("LOCAL · SELF-REPORTED", out.getvalue())
        # The eleven metrics and their roles reach the portal unchanged.
        sent = sync.call_args[0][2]
        self.assertEqual(len(sent["metrics"]), 11)
        self.assertEqual(sent["weightsUsed"], [])
        roles = {m["key"]: m.get("role") for m in sent["metrics"] if m.get("role")}
        self.assertEqual(roles["chance_top1"], "floor")
        self.assertEqual(roles["margin_separation"], "reported")

    def test_no_workspace_is_created_for_a_run_with_no_weights(self):
        with patch("cogbench.cli.sync_report"), \
                patch("cogbench.cli.upload_weight"), \
                patch("cogbench.cli.token_for", return_value="test_token"), \
                patch("cogbench.cli._resolve_report", return_value=self.report_file), \
                patch("cogbench.cli._portal", return_value="http://example.com"), \
                patch("cogbench.cli.Path.cwd", return_value=self.tmp):
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                main(["sync", str(self.report_file)])
        self.assertFalse((self.tmp / ".cogbench" / "weights").exists())


if __name__ == "__main__":
    unittest.main()
