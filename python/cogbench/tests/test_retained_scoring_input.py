"""What a report says about a weight has to stay true after the file changes.

The defect these cover: `cogworks sync` used to read the weight file again,
long after scoring, and upload whatever it held then. A team that rewrote or
deleted their projection between `run` and `sync` published a digest for one
set of bytes and uploaded another, or lost the upload entirely.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cogbench import storage  # noqa: E402
from cogbench.models import LocalReport, Metric, RepositoryState  # noqa: E402
from cogbench.resolve import _accepts_capture  # noqa: E402

ORIGINAL = b"the bytes that were scored"
REPLACEMENT = b"something else entirely"


def _report(weights_used, weights_uploaded):
    return LocalReport.create(
        benchmark_id="language-search",
        benchmark_version=1,
        contract_version="cogworks.submissions.v2",
        sdk_version="0.2.0",
        plugin_version="0.1.0",
        repository=RepositoryState(
            repository_id=None, full_name="team/project", sha="a" * 40, dirty=False
        ),
        started_at=1,
        finished_at=2,
        metrics=[
            Metric(
                key="search_mrr", label="Search MRR", value=0.5, unit=None,
                higher_is_better=True, primary=True, precision=4,
            )
        ],
        diagnostics=[],
        predictions=[],
        weights_used=weights_used,
        weights_uploaded=weights_uploaded,
    )


class RetainedInputSurvivesTheOriginal(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.source = self.root / "models" / "W_embed.npy"
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(ORIGINAL)

    def test_the_copy_keeps_the_name_the_loader_routes_on(self):
        """`load_weight_file` picks np.load off the suffix, so it must survive."""

        retained = storage.retain_input(self.root, self.source)
        self.assertEqual(retained.path, "models/W_embed.npy")
        self.assertEqual(retained.retained.name, "W_embed.npy")
        self.assertEqual(retained.retained.suffix, ".npy")
        self.assertEqual(retained.size, len(ORIGINAL))
        self.assertEqual(retained.retained.read_bytes(), ORIGINAL)

    def test_a_replaced_source_does_not_change_what_was_retained(self):
        retained = storage.retain_input(self.root, self.source)
        self.source.write_bytes(REPLACEMENT)
        found = storage.retained_input(
            self.root, retained.path, retained.sha256, retained.size
        )
        self.assertEqual(found.read_bytes(), ORIGINAL)

    def test_a_deleted_source_does_not_change_what_was_retained(self):
        retained = storage.retain_input(self.root, self.source)
        self.source.unlink()
        found = storage.retained_input(
            self.root, retained.path, retained.sha256, retained.size
        )
        self.assertEqual(found.read_bytes(), ORIGINAL)

    def test_two_runs_over_the_same_bytes_share_one_retained_copy(self):
        first = storage.retain_input(self.root, self.source)
        second = storage.retain_input(self.root, self.source)
        self.assertEqual(first.retained, second.retained)
        self.assertEqual(first.sha256, second.sha256)

    def test_a_corrupted_retained_copy_fails_instead_of_being_adopted(self):
        retained = storage.retain_input(self.root, self.source)
        retained.retained.write_bytes(REPLACEMENT)
        with self.assertRaises(storage.RetentionError):
            storage.retained_input(
                self.root, retained.path, retained.sha256, retained.size
            )

    def test_a_missing_retained_copy_says_to_run_again(self):
        retained = storage.retain_input(self.root, self.source)
        retained.retained.unlink()
        with self.assertRaisesRegex(storage.RetentionError, "run the benchmark again"):
            storage.retained_input(
                self.root, retained.path, retained.sha256, retained.size
            )

    def test_capture_refuses_a_symlinked_source(self):
        link = self.root / "linked.npy"
        try:
            link.symlink_to(self.source)
        except (OSError, NotImplementedError):
            self.skipTest("this platform does not create symlinks here")
        with self.assertRaises(storage.RetentionError):
            storage.retain_input(self.root, link)

    def test_capture_refuses_a_source_outside_the_project(self):
        with TemporaryDirectory() as elsewhere:
            outside = Path(elsewhere) / "W.npy"
            outside.write_bytes(ORIGINAL)
            with self.assertRaises(storage.RetentionError):
                storage.retain_input(self.root, outside)

    def test_an_incomplete_write_leaves_nothing_behind(self):
        storage.retain_input(self.root, self.source)
        staging = list(storage.weights_dir(self.root).glob(".incomplete-*"))
        self.assertEqual(staging, [])


class WhatTheReportCallsAScoredWeight(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_the_name_is_relative_to_the_project_not_the_searched_directory(self):
        """Discovery may search below the root; the report names the project."""

        nested = self.root / "src" / "team"
        nested.mkdir(parents=True)
        source = nested / "W.npy"
        source.write_bytes(ORIGINAL)
        record = storage.retain_input(self.root, source)
        self.assertEqual(record.path, "src/team/W.npy")
        self.assertEqual(record.size, len(ORIGINAL))

    def test_a_relative_name_is_refused_rather_than_resolved_from_the_scratch_cwd(self):
        with self.assertRaisesRegex(storage.RetentionError, "absolute path"):
            storage.retain_input(self.root, Path("models/W.npy"))

    def test_an_existing_address_is_rewritten_from_the_bytes_just_read(self):
        """A cached file nothing verified must not be served as this run's."""

        source = self.root / "W.npy"
        source.write_bytes(ORIGINAL)
        first = storage.retain_input(self.root, source)
        first.retained.write_bytes(b"stale bytes at the same address")
        second = storage.retain_input(self.root, source)
        self.assertEqual(second.retained.read_bytes(), ORIGINAL)
        self.assertEqual(second.sha256, first.sha256)


class TheWorkspaceIsCheckedBeforeItIsWrittenThrough(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.elsewhere = TemporaryDirectory()
        self.addCleanup(self.elsewhere.cleanup)
        self.source = self.root / "W.npy"
        self.source.write_bytes(ORIGINAL)

    def _link(self, at: Path):
        at.parent.mkdir(parents=True, exist_ok=True)
        try:
            at.symlink_to(Path(self.elsewhere.name))
        except (OSError, NotImplementedError):
            self.skipTest("this platform does not create symlinks here")

    def test_a_planted_cogbench_link_is_refused_before_any_write(self):
        self._link(self.root / ".cogbench")
        with self.assertRaises(storage.RetentionError):
            storage.retain_input(self.root, self.source)
        self.assertEqual(list(Path(self.elsewhere.name).iterdir()), [])

    def test_a_planted_weights_link_is_refused_before_any_write(self):
        (self.root / ".cogbench").mkdir()
        self._link(self.root / ".cogbench" / "weights")
        with self.assertRaises(storage.RetentionError):
            storage.retain_input(self.root, self.source)
        self.assertEqual(list(Path(self.elsewhere.name).iterdir()), [])


class ASavedReceiptIsNotTrustedBlindly(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_a_traversing_receipt_path_is_refused(self):
        for name in ("../escape.npy", "/etc/passwd", "a\\b.npy", "a\x7fb.npy", ""):
            with self.subTest(name=name):
                with self.assertRaises(storage.RetentionError):
                    storage.retained_input(self.root, name, "a" * 64, 1)

    def test_a_receipt_digest_that_is_not_a_sha256_is_refused(self):
        with self.assertRaises(storage.RetentionError):
            storage.retained_input(self.root, "W.npy", "../../etc", 1)

    def test_del_is_rejected_in_a_saved_name(self):
        with self.assertRaises(storage.RetentionError):
            storage.check_weight_path("models/W\x7f.npy")


class OptingIntoCaptureIsExplicit(unittest.TestCase):
    def test_a_hook_that_names_the_parameter_is_offered_one(self):
        def newer(root, modules=(), capture=None):
            return {}

        self.assertTrue(_accepts_capture(newer))

    def test_a_hook_without_it_is_called_exactly_as_before(self):
        def older(root, modules=()):
            return {}

        self.assertFalse(_accepts_capture(older))

    def test_a_kwargs_hook_does_not_count_as_opting_in(self):
        """It would swallow the callback without ever loading through it."""

        def greedy(root, modules=(), **rest):
            return {}

        self.assertFalse(_accepts_capture(greedy))

    def test_a_star_args_named_capture_cannot_receive_a_keyword(self):
        def varargs(root, modules=(), *capture):
            return {}

        self.assertFalse(_accepts_capture(varargs))

    def test_a_keyword_only_parameter_counts(self):
        def keyword_only(root, modules=(), *, capture=None):
            return {}

        self.assertTrue(_accepts_capture(keyword_only))


class TheReportCarriesTheReceipts(unittest.TestCase):
    def test_no_weight_runs_still_say_so_explicitly(self):
        report = _report([], [])
        self.assertEqual(report.to_wire()["weightsUsed"], [])
        self.assertEqual(report.to_wire()["weightsUploaded"], [])

    def test_receipts_survive_the_saved_report(self):
        receipts = [{"path": "models/W.npy", "sha256": "b" * 64, "size": 12}]
        restored = LocalReport.from_json(_report(["models/W.npy"], receipts).to_json())
        self.assertEqual(restored.weights_uploaded, receipts)

    def test_a_receipt_for_an_unscored_path_is_refused(self):
        raw = _report(["models/W.npy"], []).to_json()
        value = json.loads(raw)
        value["weightsUploaded"] = [{"path": "other.npy", "sha256": "b" * 64, "size": 1}]
        with self.assertRaisesRegex(ValueError, "did not score"):
            LocalReport.from_json(json.dumps(value))

    def test_a_receipt_without_a_length_is_refused(self):
        raw = _report(["models/W.npy"], []).to_json()
        value = json.loads(raw)
        value["weightsUploaded"] = [{"path": "models/W.npy", "sha256": "b" * 64}]
        with self.assertRaisesRegex(ValueError, "byte length"):
            LocalReport.from_json(json.dumps(value))

    def test_a_repeated_scored_path_is_refused(self):
        """Two receipts would have to satisfy one name, with no way to say
        which bytes the second meant."""

        raw = _report(["models/W.npy"], []).to_json()
        value = json.loads(raw)
        value["weightsUsed"] = ["models/W.npy", "models/W.npy"]
        with self.assertRaisesRegex(ValueError, "more than once"):
            LocalReport.from_json(json.dumps(value))

    def test_a_scored_weight_with_no_receipt_is_refused(self):
        """Otherwise it syncs as though there were nothing to upload."""

        raw = _report(["models/W.npy"], []).to_json()
        value = json.loads(raw)
        value["weightsUploaded"] = []
        with self.assertRaisesRegex(ValueError, "missing models/W.npy"):
            LocalReport.from_json(json.dumps(value))

    def test_a_report_predating_capture_stays_unknown_rather_than_empty(self):
        raw = _report(["models/W.npy"], []).to_json()
        value = json.loads(raw)
        value["weightsUploaded"] = None
        self.assertIsNone(LocalReport.from_json(json.dumps(value)).weights_uploaded)


if __name__ == "__main__":
    unittest.main()
