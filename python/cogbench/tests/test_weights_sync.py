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
        self.assertEqual(mock_sync.call_args[0][2]["weightsUploaded"], [])
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
        self.assertEqual(mock_sync.call_args[0][2]["weightsUploaded"], [{
            "path": "trained_weights.npz", "sha256": hashlib.sha256(b"fake numpy data").hexdigest(),
        }])
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
        mock_sync.assert_not_called()
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
        # Git diff can hide this modification; provenance must compare the actual bytes.
        subprocess.run(["git", "update-index", "--assume-unchanged", "model.pkl"],
                       cwd=str(self.tmp), check=True, capture_output=True)
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


class WeightProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.git("init")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.com",
                 "commit", "--allow-empty", "-m", "Initial")
        self.sha = self.git("rev-parse", "HEAD").stdout.strip()

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=str(self.root), check=True,
                              capture_output=True, text=True)

    def report(self):
        return LocalReport.create(
            benchmark_id="language-search", benchmark_version=1,
            contract_version="cogworks.submissions.v2", sdk_version="0.1.0",
            plugin_version="0.1.0",
            repository=RepositoryState(None, "test/repo", self.sha, False),
            started_at=1, finished_at=2, metrics=[], diagnostics=[], predictions=[],
            weights_used=["model.pkl"],
        )

    def test_newly_staged_file_requires_upload_before_upload_loop_starts(self):
        (self.root / "model.pkl").write_bytes(b"newly staged")
        self.git("add", "model.pkl")
        report_file = self.root / "report.json"
        report_file.write_text(self.report().to_json(), encoding="utf-8")
        events = []

        def post(_portal, _token, payload):
            self.assertEqual(payload["weightsUploaded"], [{
                "path": "model.pkl", "sha256": hashlib.sha256(b"newly staged").hexdigest(),
            }])
            events.append("post")

        def upload(*_args, expected_sha256):
            self.assertEqual(expected_sha256, hashlib.sha256(b"newly staged").hexdigest())
            self.assertEqual(events, ["post"])
            events.append("upload")
            return "weights/test/repo/model.pkl"

        with patch("cogbench.cli.sync_report", side_effect=post), patch(
            "cogbench.cli.upload_weight", side_effect=upload
        ), patch("cogbench.cli.token_for", return_value="token"), patch(
            "cogbench.cli._resolve_report", return_value=report_file
        ), patch("cogbench.cli._portal", return_value="http://example.com"), patch(
            "cogbench.cli.Path.cwd", return_value=self.root
        ), redirect_stdout(io.StringIO()):
            self.assertEqual(main(["sync", str(report_file)]), 0)
        self.assertEqual(events, ["post", "upload"])

    def test_sync_without_report_sha_fails_before_post(self):
        payload = json.loads(self.report().to_json())
        payload["sha"] = None
        report_file = self.root / "report.json"
        report_file.write_text(json.dumps(payload), encoding="utf-8")
        stderr = io.StringIO()
        with patch("cogbench.cli.sync_report") as post, patch(
            "cogbench.cli.token_for", return_value="token"
        ), patch("cogbench.cli._resolve_report", return_value=report_file), patch(
            "cogbench.cli._portal", return_value="http://example.com"
        ), patch("cogbench.cli.Path.cwd", return_value=self.root), redirect_stderr(stderr):
            self.assertEqual(main(["sync", str(report_file)]), 2)
        post.assert_not_called()
        self.assertIn("no repository revision for its weights", stderr.getvalue())

    def test_provenance_round_trip_preserves_unknown_and_explicit_empty(self):
        payload = json.loads(self.report().to_json())
        payload.pop("weightsUploaded")
        self.assertIsNone(LocalReport.from_json(json.dumps(payload)).weights_uploaded)
        for provenance in [None, [], [{"path": "model.pkl", "sha256": "a" * 64}]]:
            payload["weightsUploaded"] = provenance
            restored = LocalReport.from_json(json.dumps(payload))
            self.assertEqual(restored.weights_uploaded, provenance)
            self.assertEqual(restored.to_wire()["weightsUploaded"], provenance)

    def test_malformed_provenance_fails_without_coercion(self):
        payload = json.loads(self.report().to_json())
        for provenance in ["model.pkl", [1], ["other.pkl"], {},
                           [{"path": "model.pkl"}], [{"path": "model.pkl", "sha256": "invalid"}],
                           [{"path": "other.pkl", "sha256": "a" * 64}]]:
            with self.subTest(provenance=provenance):
                payload["weightsUploaded"] = provenance
                with self.assertRaisesRegex(ValueError, "weightsUploaded"):
                    LocalReport.from_json(json.dumps(payload))


class UploadWeightDigestHeaderTest(unittest.TestCase):
    def test_upload_keeps_the_report_digest_when_the_file_changes_after_post(self):
        with tempfile.TemporaryDirectory() as directory:
            weight_path = Path(directory) / "model.pkl"
            weight_path.write_bytes(b"changed after POST")
            expected = hashlib.sha256(b"bytes in report").hexdigest()
            response = MagicMock()
            response.__enter__.return_value.read.return_value = b'{"destination":"weights/model.pkl"}'
            with patch("cogbench.client.urllib.request.urlopen", return_value=response) as request:
                upload_weight("http://example.com", "token", "local_digest", "model.pkl",
                              weight_path, expected_sha256=expected)
            headers = {key.lower(): value for key, value in request.call_args[0][0].header_items()}
            self.assertEqual(headers["x-cogworks-weight-sha256"], expected)

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
