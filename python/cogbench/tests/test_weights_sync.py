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
from cogbench.client import upload_weight


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

    def test_weights_restored_as_empty_list_when_absent(self):
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
        self.assertEqual(report.weights_used, [])


class CliTrackedWeightSkipTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_sync_skips_tracked_weight_files(self):
        # Create a git repo with a tracked weight file
        subprocess.run(["git", "init"], cwd=str(self.tmp), check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=str(self.tmp),
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test User"],
            cwd=str(self.tmp),
            check=True,
            capture_output=True,
        )

        # Create and track a weight file
        weight_path = self.tmp / "model.pkl"
        weight_path.write_bytes(b"fake pickle data")
        subprocess.run(["git", "add", "model.pkl"], cwd=str(self.tmp), check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "Add model"], cwd=str(self.tmp), check=True, capture_output=True)
        report_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(self.tmp),
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

        # Create a report with the tracked weight
        report = LocalReport(
            report_id="local_test123",
            benchmark_id="language-search",
            benchmark_version=1,
            contract_version="cogworks.submissions.v2",
            sdk_version="0.1.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "test/repo", report_sha, False),
            started_at=1,
            finished_at=2,
            metrics=[Metric("mrr", "MRR", 0.75, None, True, True, 3)],
            diagnostics=[],
            output_digest="x" * 64,
            weights_used=["model.pkl"],
        )

        # Save report
        report_file = self.tmp / "report.json"
        report_file.write_text(report.to_json(), encoding="utf-8")

        # Mock the sync_report and upload_weight calls
        with patch("cogbench.cli.sync_report") as mock_sync:
            with patch("cogbench.cli.upload_weight") as mock_upload:
                with patch("cogbench.cli.token_for", return_value="test_token"):
                    with patch("cogbench.cli._resolve_report", return_value=report_file):
                        with patch("cogbench.cli._portal", return_value="http://example.com"):
                            # Mock Path.cwd to return our temp directory
                            with patch("cogbench.cli.Path.cwd", return_value=self.tmp):
                                stdout = io.StringIO()
                                with redirect_stdout(stdout):
                                    result = main(["sync", str(report_file)])

        self.assertEqual(result, 0)
        mock_sync.assert_called_once()
        # Verify upload was NOT called for tracked file
        mock_upload.assert_not_called()
        # Verify output mentions the tracked file
        self.assertIn("is committed and travels with the repository", stdout.getvalue())


class CliUntrackedWeightUploadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_sync_uploads_untracked_weight_files(self):
        # Create a git repo
        subprocess.run(["git", "init"], cwd=str(self.tmp), check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=str(self.tmp),
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test User"],
            cwd=str(self.tmp),
            check=True,
            capture_output=True,
        )

        # Create an untracked weight file
        weight_path = self.tmp / "trained_weights.npz"
        weight_path.write_bytes(b"fake numpy data")

        # Create a report with the untracked weight
        report = LocalReport(
            report_id="local_test456",
            benchmark_id="language-search",
            benchmark_version=1,
            contract_version="cogworks.submissions.v2",
            sdk_version="0.1.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "test/repo", "a" * 40, False),
            started_at=1,
            finished_at=2,
            metrics=[Metric("mrr", "MRR", 0.75, None, True, True, 3)],
            diagnostics=[],
            output_digest="x" * 64,
            weights_used=["trained_weights.npz"],
        )

        # Save report
        report_file = self.tmp / "report.json"
        report_file.write_text(report.to_json(), encoding="utf-8")

        # Mock the sync_report and upload_weight calls
        with patch("cogbench.cli.sync_report") as mock_sync:
            with patch("cogbench.cli.upload_weight") as mock_upload:
                with patch("cogbench.cli.token_for", return_value="test_token"):
                    with patch("cogbench.cli._resolve_report", return_value=report_file):
                        with patch("cogbench.cli._portal", return_value="http://example.com"):
                            # Mock Path.cwd to return our temp directory
                            with patch("cogbench.cli.Path.cwd", return_value=self.tmp):
                                stdout = io.StringIO()
                                with redirect_stdout(stdout):
                                    result = main(["sync", str(report_file)])

        self.assertEqual(result, 0)
        mock_sync.assert_called_once()
        # Verify upload WAS called for untracked file
        mock_upload.assert_called_once()
        # Check the arguments to upload_weight
        call_args = mock_upload.call_args
        self.assertEqual(call_args[0][0], "http://example.com")  # portal
        self.assertEqual(call_args[0][1], "test_token")  # token
        self.assertEqual(call_args[0][2], "local_test456")  # report_id
        self.assertEqual(call_args[0][3], "trained_weights.npz")  # rel_path
        # Verify output mentions upload
        self.assertIn("uploaded to", stdout.getvalue())
        self.assertIn("15 bytes", stdout.getvalue())


class CliMissingWeightFileFailsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_sync_fails_on_missing_untracked_weight_file(self):
        # Create a git repo
        subprocess.run(["git", "init"], cwd=str(self.tmp), check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=str(self.tmp),
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test User"],
            cwd=str(self.tmp),
            check=True,
            capture_output=True,
        )

        # Create a report referencing a weight file that does not exist
        report = LocalReport(
            report_id="local_test789",
            benchmark_id="language-search",
            benchmark_version=1,
            contract_version="cogworks.submissions.v2",
            sdk_version="0.1.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "test/repo", "a" * 40, False),
            started_at=1,
            finished_at=2,
            metrics=[Metric("mrr", "MRR", 0.75, None, True, True, 3)],
            diagnostics=[],
            output_digest="x" * 64,
            weights_used=["missing_weights.pkl"],
        )

        # Save report
        report_file = self.tmp / "report.json"
        report_file.write_text(report.to_json(), encoding="utf-8")

        # Mock the sync_report call
        with patch("cogbench.cli.sync_report") as mock_sync:
            with patch("cogbench.cli.token_for", return_value="test_token"):
                with patch("cogbench.cli._resolve_report", return_value=report_file):
                    with patch("cogbench.cli._portal", return_value="http://example.com"):
                        # Mock Path.cwd to return our temp directory
                        with patch("cogbench.cli.Path.cwd", return_value=self.tmp):
                            stderr = io.StringIO()
                            with redirect_stderr(stderr):
                                result = main(["sync", str(report_file)])

        self.assertEqual(result, 2)
        mock_sync.assert_called_once()
        self.assertIn("does not exist", stderr.getvalue())


class CliTrackedModifiedWeightUploadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        subprocess.run(["git", "init"], cwd=str(self.tmp), check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=str(self.tmp),
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test User"],
            cwd=str(self.tmp),
            check=True,
            capture_output=True,
        )

    def test_sync_uploads_a_tracked_weight_that_differs_from_the_report_commit(self):
        weight_path = self.tmp / "model.pkl"
        weight_path.write_bytes(b"committed")
        subprocess.run(["git", "add", "model.pkl"], cwd=str(self.tmp), check=True)
        subprocess.run(["git", "commit", "-m", "Add model"], cwd=str(self.tmp), check=True, capture_output=True)
        report_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(self.tmp),
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        weight_path.write_bytes(b"modified after report")
        report = LocalReport(
            report_id="local_modified",
            benchmark_id="language-search",
            benchmark_version=1,
            contract_version="cogworks.submissions.v2",
            sdk_version="0.1.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "test/repo", report_sha, False),
            started_at=1,
            finished_at=2,
            metrics=[Metric("mrr", "MRR", 0.75, None, True, True, 3)],
            diagnostics=[],
            output_digest="x" * 64,
            weights_used=["model.pkl"],
        )
        report_file = self.tmp / "report.json"
        report_file.write_text(report.to_json(), encoding="utf-8")

        with patch("cogbench.cli.sync_report"), patch(
            "cogbench.cli.upload_weight", return_value="weights/test/repo/model.pkl"
        ) as mock_upload, patch(
            "cogbench.cli.token_for", return_value="test_token"
        ), patch(
            "cogbench.cli._resolve_report", return_value=report_file
        ), patch(
            "cogbench.cli._portal", return_value="http://example.com"
        ), patch(
            "cogbench.cli.Path.cwd", return_value=self.tmp
        ):
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                result = main(["sync", str(report_file)])

        self.assertEqual(result, 0)
        mock_upload.assert_called_once()
        self.assertIn("differs from the report commit", stdout.getvalue())


class CliUnsafeWeightPathTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.outside = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.addCleanup(shutil.rmtree, self.outside, ignore_errors=True)
        subprocess.run(["git", "init"], cwd=str(self.tmp), check=True, capture_output=True)

    def test_sync_refuses_a_symlink_to_a_file_outside_the_repository(self):
        outside_weight = self.outside / "secret.pkl"
        outside_weight.write_bytes(b"outside")
        (self.tmp / "model.pkl").symlink_to(outside_weight)
        report = LocalReport(
            report_id="local_symlink",
            benchmark_id="language-search",
            benchmark_version=1,
            contract_version="cogworks.submissions.v2",
            sdk_version="0.1.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "test/repo", "a" * 40, False),
            started_at=1,
            finished_at=2,
            metrics=[Metric("mrr", "MRR", 0.75, None, True, True, 3)],
            diagnostics=[],
            output_digest="x" * 64,
            weights_used=["model.pkl"],
        )
        report_file = self.tmp / "report.json"
        report_file.write_text(report.to_json(), encoding="utf-8")

        with patch("cogbench.cli.sync_report"), patch(
            "cogbench.cli.upload_weight"
        ) as mock_upload, patch(
            "cogbench.cli.token_for", return_value="test_token"
        ), patch(
            "cogbench.cli._resolve_report", return_value=report_file
        ), patch(
            "cogbench.cli._portal", return_value="http://example.com"
        ), patch(
            "cogbench.cli.Path.cwd", return_value=self.tmp
        ):
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                result = main(["sync", str(report_file)])

        self.assertEqual(result, 2)
        mock_upload.assert_not_called()
        self.assertIn("regular file inside the repository", stderr.getvalue())


class UploadWeightDigestHeaderTest(unittest.TestCase):
    def test_upload_sends_the_sha256_header(self):
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

            def open_request(request):
                captured.update({key.lower(): value for key, value in request.header_items()})
                return Response()

            with patch("cogbench.client.urllib.request.urlopen", side_effect=open_request):
                destination = upload_weight(
                    "http://example.com",
                    "token",
                    "local_digest",
                    "model.pkl",
                    weight_path,
                )

        self.assertEqual(destination, "weights/test/repo/model.pkl")
        self.assertEqual(
            captured["x-cogworks-weight-sha256"],
            hashlib.sha256(b"trained weights").hexdigest(),
        )
        self.assertEqual(captured["content-length"], str(len(b"trained weights")))


if __name__ == "__main__":
    unittest.main()
