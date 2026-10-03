"""Test weight file syncing functionality."""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.models import LocalReport, Metric, RepositoryState
from cogbench.cli import main
from cogbench.client import UPLOAD_TIMEOUT_SECONDS, upload_weight
from cogbench import storage


class LocalReportWithWeightsTests(unittest.TestCase):
    def test_weights_used_in_wire_payload(self):
        report = LocalReport.create(
            benchmark_id="vision-recognition",
            benchmark_version=1,
            contract_version="cogworks.submissions.v1",
            sdk_version="0.1.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "course/team", "a" * 40, False),
            started_at=1,
            finished_at=2,
            metrics=[Metric("accuracy", "Accuracy", 1.0, None, True, True, 3)],
            diagnostics=[],
            predictions=["ada"],
            weights_used=["weights.pkl", "idf_table.pkl"],
        )
        payload = report.to_wire()
        self.assertIn("weightsUsed", payload)
        self.assertEqual(payload["weightsUsed"], ["weights.pkl", "idf_table.pkl"])

    def test_empty_weights_in_wire_payload(self):
        report = LocalReport.create(
            benchmark_id="vision-recognition",
            benchmark_version=1,
            contract_version="cogworks.submissions.v1",
            sdk_version="0.1.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "course/team", "a" * 40, False),
            started_at=1,
            finished_at=2,
            metrics=[Metric("accuracy", "Accuracy", 1.0, None, True, True, 3)],
            diagnostics=[],
            predictions=["ada"],
            weights_used=[],
        )
        payload = report.to_wire()
        self.assertIn("weightsUsed", payload)
        self.assertEqual(payload["weightsUsed"], [])

    def test_weights_round_trip_through_json(self):
        report = LocalReport.create(
            benchmark_id="language-search",
            benchmark_version=1,
            contract_version="cogworks.submissions.v2",
            sdk_version="0.1.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "course/team", "b" * 40, False),
            started_at=1,
            finished_at=2,
            metrics=[Metric("mrr", "MRR", 0.75, None, True, True, 3)],
            diagnostics=[],
            predictions=[],
            weights_used=["models/encoder.pkl", "data/idf.json"],
        )
        json_str = report.to_json()
        restored = LocalReport.from_json(json_str)
        self.assertEqual(restored.weights_used, ["models/encoder.pkl", "data/idf.json"])

    def test_an_absent_weights_field_stays_unrecorded(self):
        """A report saved before the field existed never said which weights it
        used. Reading that as [] would turn "unknown" into "none"."""

        json_str = json.dumps({
            "reportId": "local_test",
            "benchmarkId": "language-search",
            "benchmarkVersion": 1,
            "contractVersion": "cogworks.submissions.v2",
            "sdkVersion": "0.1.0",
            "pluginVersion": "0.1.0",
            "repositoryId": None,
            "repositoryFullName": "course/team",
            "sha": "a" * 40,
            "dirty": False,
            "startedAt": 1,
            "finishedAt": 2,
            "metrics": [{"key": "mrr", "label": "MRR", "value": 0.75, "unit": None,
                        "higherIsBetter": True, "primary": True, "precision": 3}],
            "diagnostics": [],
            "outputDigest": "x" * 64,
        })
        report = LocalReport.from_json(json_str)
        self.assertIsNone(report.weights_used)
        self.assertNotIn("weightsUsed", report.to_wire())


class SyncUploadsEveryScoredWeight(unittest.TestCase):
    """Sync reads the retained copy, never the file in the working tree.

    The old contract asked Git whether a weight had changed since the report
    commit and skipped the ones that had not. That question is about the
    working tree, not about what was scored, so it is gone: every declared
    weight is captured at load time and uploaded from that capture.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.source = self.tmp / "trained_weights.npz"
        self.source.write_bytes(b"fake numpy data")
        self.receipt = storage.retain_input(self.tmp, self.source)

    def _report(self, weights_used, weights_uploaded):
        return LocalReport(
            report_id="local_test456",
            benchmark_id="language-search",
            benchmark_version=1,
            contract_version="cogworks.submissions.v2",
            sdk_version="0.2.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "test/repo", "a" * 40, False),
            started_at=1,
            finished_at=2,
            metrics=[Metric("mrr", "MRR", 0.75, None, True, True, 3)],
            diagnostics=[],
            output_digest="x" * 64,
            weights_used=weights_used,
            weights_uploaded=weights_uploaded,
        )

    def _sync(self, report, drop=()):
        report_file = self.tmp / "report.json"
        saved = json.loads(report.to_json())
        for key in drop:
            del saved[key]
        report_file.write_text(json.dumps(saved), encoding="utf-8")
        with patch("cogbench.cli.sync_report") as sync, \
                patch("cogbench.cli.upload_weight") as upload, \
                patch("cogbench.cli.token_for", return_value="test_token"), \
                patch("cogbench.cli._resolve_report", return_value=report_file), \
                patch("cogbench.cli._portal", return_value="http://example.com"), \
                patch("cogbench.cli.Path.cwd", return_value=self.tmp):
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = main(["sync", str(report_file)])
        return code, sync, upload, out.getvalue(), err.getvalue()

    def _receipts(self):
        return [{
            "path": self.receipt.path,
            "sha256": self.receipt.sha256,
            "size": self.receipt.size,
        }]

    def test_a_scored_weight_is_uploaded_from_its_capture(self):
        code, sync, upload, out, _ = self._sync(
            self._report([self.receipt.path], self._receipts())
        )
        self.assertEqual(code, 0)
        sync.assert_called_once()
        self.assertEqual(sync.call_args[0][2]["weightsUsed"], ["trained_weights.npz"])
        upload.assert_called_once()
        arguments = upload.call_args
        self.assertEqual(arguments[0][3], "trained_weights.npz")
        # The bytes come from the retained copy, not from the project file.
        self.assertEqual(arguments[0][4], self.receipt.retained)
        self.assertEqual(arguments[1]["expected_sha256"], self.receipt.sha256)
        self.assertEqual(arguments[1]["size"], self.receipt.size)
        self.assertIn("uploaded to", out)
        self.assertIn("15 bytes", out)

    def test_a_replaced_source_still_uploads_what_was_scored(self):
        self.source.write_bytes(b"completely different bytes")
        code, _, upload, _, _ = self._sync(
            self._report([self.receipt.path], self._receipts())
        )
        self.assertEqual(code, 0)
        self.assertEqual(upload.call_args[1]["expected_sha256"], self.receipt.sha256)
        self.assertEqual(
            upload.call_args[0][4].read_bytes(), b"fake numpy data"
        )

    def test_a_deleted_source_still_uploads_what_was_scored(self):
        self.source.unlink()
        code, _, upload, _, _ = self._sync(
            self._report([self.receipt.path], self._receipts())
        )
        self.assertEqual(code, 0)
        self.assertEqual(upload.call_args[1]["expected_sha256"], self.receipt.sha256)

    def test_a_run_with_no_weights_uploads_nothing_and_succeeds(self):
        code, sync, upload, _, _ = self._sync(self._report([], []))
        self.assertEqual(code, 0)
        sync.assert_called_once()
        self.assertEqual(sync.call_args[0][2]["weightsUsed"], [])
        upload.assert_not_called()

    def test_a_report_that_never_recorded_its_weights_is_not_synced(self):
        """An old file without weightsUsed must not reach the portal as [],
        which would claim the run used no weights."""

        for uploaded in (None, []):
            with self.subTest(weightsUploaded=uploaded):
                code, sync, upload, _, err = self._sync(
                    self._report([], uploaded), drop=("weightsUsed",)
                )
                self.assertEqual(code, 2)
                sync.assert_not_called()
                upload.assert_not_called()
                self.assertIn(
                    "Run `cogworks run --benchmark language-search` again, "
                    "then `cogworks sync`.",
                    err,
                )

    def test_a_report_that_never_recorded_its_weights_still_displays(self):
        report_file = self.tmp / "old-report.json"
        saved = json.loads(self._report([], None).to_json())
        del saved["weightsUsed"]
        report_file.write_text(json.dumps(saved), encoding="utf-8")
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(["report", str(report_file)])
        self.assertEqual(code, 0, err.getvalue())
        self.assertIn("MRR: 0.750", out.getvalue())

    def test_a_missing_capture_stops_the_sync(self):
        self.receipt.retained.unlink()
        code, sync, upload, _, err = self._sync(
            self._report([self.receipt.path], self._receipts())
        )
        self.assertEqual(code, 2)
        upload.assert_not_called()
        # Nothing reaches the portal before every local check has passed.
        sync.assert_not_called()
        self.assertIn("run the benchmark again", err)

    def test_a_corrupted_capture_stops_the_sync(self):
        self.receipt.retained.write_bytes(b"tampered")
        code, sync, upload, _, err = self._sync(
            self._report([self.receipt.path], self._receipts())
        )
        self.assertEqual(code, 2)
        upload.assert_not_called()
        # Nothing reaches the portal before every local check has passed.
        sync.assert_not_called()
        self.assertIn("no longer matches the report", err)

    def test_a_report_that_cannot_say_which_bytes_is_refused(self):
        code, sync, upload, _, err = self._sync(
            self._report([self.receipt.path], None)
        )
        self.assertEqual(code, 2)
        upload.assert_not_called()
        # Nothing reaches the portal before every local check has passed.
        sync.assert_not_called()
        self.assertIn("doesn't establish which weight bytes", err)


class UploadWeightDigestHeaderTest(unittest.TestCase):
    """The headers come from the report's receipt, not from the file on disk.

    The portal checks the stream against the digest the report published, so
    sending a freshly measured one would let a changed file upload cleanly
    under a report that describes different bytes.
    """

    def test_upload_sends_the_receipts_digest_and_length(self):
        with tempfile.TemporaryDirectory() as directory:
            weight_path = Path(directory) / "model.pkl"
            weight_path.write_bytes(b"trained weights")
            captured = {}

            class Response:
                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    return None

                def read(self):
                    return b'{"destination":"weights/test/repo/model.pkl"}'

            def open_request(request, timeout=None):
                captured.update({key.lower(): value for key, value in request.header_items()})
                captured["timeout"] = timeout
                return Response()

            with patch("cogbench.client.urllib.request.urlopen", side_effect=open_request):
                destination = upload_weight(
                    "http://example.com",
                    "token",
                    "local_digest",
                    "model.pkl",
                    weight_path,
                    expected_sha256=hashlib.sha256(b"trained weights").hexdigest(),
                    size=len(b"trained weights"),
                )

        self.assertEqual(destination, "weights/test/repo/model.pkl")
        self.assertEqual(
            captured["x-cogworks-weight-sha256"],
            hashlib.sha256(b"trained weights").hexdigest(),
        )
        self.assertEqual(captured["content-length"], str(len(b"trained weights")))
        # A stalled connection must end in an error the student can retry.
        self.assertEqual(captured["timeout"], UPLOAD_TIMEOUT_SECONDS)


if __name__ == "__main__":
    unittest.main()
