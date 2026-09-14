from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.storage import latest_report, save_report, workspace_dir  # noqa: E402


class CheckoutStorageTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.outside = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.addCleanup(shutil.rmtree, self.outside, ignore_errors=True)

    def report(self, report_id="local_test", value="inside"):
        return SimpleNamespace(report_id=report_id, to_json=lambda: value)

    def symlink(self, path, target, target_is_directory=False):
        try:
            path.symlink_to(target, target_is_directory=target_is_directory)
        except (NotImplementedError, OSError) as error:
            self.skipTest("symbolic links are unavailable: {}".format(error))

    def test_an_ordinary_report_round_trip_stays_in_the_checkout(self):
        path = save_report(self.report(), self.root)

        self.assertEqual(path, self.root / ".cogbench" / "reports" / "local_test.json")
        self.assertEqual(path.read_text(encoding="utf-8"), "inside\n")
        self.assertEqual(latest_report(self.root), path)
        self.assertEqual((self.root / ".cogbench" / ".gitignore").read_text(), "*\n")

    def test_a_linked_workspace_is_refused(self):
        self.symlink(self.root / ".cogbench", self.outside, target_is_directory=True)

        with self.assertRaises(OSError):
            save_report(self.report(), self.root)
        self.assertIsNone(latest_report(self.root))
        self.assertEqual(list(self.outside.iterdir()), [])

    def test_a_linked_ignore_file_is_refused(self):
        workspace = self.root / ".cogbench"
        workspace.mkdir()
        outside_ignore = self.outside / "ignore"
        outside_ignore.write_text("original", encoding="utf-8")
        self.symlink(workspace / ".gitignore", outside_ignore)

        with self.assertRaises(OSError):
            workspace_dir(self.root)
        with self.assertRaises(OSError):
            save_report(self.report(), self.root)
        self.assertEqual(outside_ignore.read_text(encoding="utf-8"), "original")

    def test_a_linked_reports_directory_is_neither_read_nor_written(self):
        workspace_dir(self.root)
        outside_report = self.outside / "local_outside.json"
        outside_report.write_text("outside", encoding="utf-8")
        self.symlink(
            self.root / ".cogbench" / "reports",
            self.outside,
            target_is_directory=True,
        )

        with self.assertRaises(OSError):
            save_report(self.report(), self.root)
        self.assertIsNone(latest_report(self.root))
        self.assertEqual(outside_report.read_text(encoding="utf-8"), "outside")

    def test_a_linked_report_target_is_refused(self):
        reports = workspace_dir(self.root) / "reports"
        reports.mkdir()
        outside_report = self.outside / "report"
        outside_report.write_text("outside", encoding="utf-8")
        self.symlink(reports / "local_test.json", outside_report)

        with self.assertRaises(OSError):
            save_report(self.report(), self.root)
        self.assertEqual(outside_report.read_text(encoding="utf-8"), "outside")

    def test_latest_report_skips_linked_report_files(self):
        reports = workspace_dir(self.root) / "reports"
        reports.mkdir()
        local = reports / "local_inside.json"
        local.write_text("inside", encoding="utf-8")
        outside_report = self.outside / "local_outside.json"
        outside_report.write_text("outside", encoding="utf-8")
        linked = reports / "local_linked.json"
        self.symlink(linked, outside_report)
        os.utime(outside_report, (local.stat().st_mtime + 10, local.stat().st_mtime + 10))

        self.assertEqual(latest_report(self.root), local)

    def test_replacing_a_hardlinked_report_does_not_change_outside_bytes(self):
        reports = workspace_dir(self.root) / "reports"
        reports.mkdir()
        outside_report = self.outside / "report"
        outside_report.write_text("outside", encoding="utf-8")
        target = reports / "local_test.json"
        try:
            os.link(str(outside_report), str(target))
        except OSError as error:
            self.skipTest("hard links are unavailable: {}".format(error))

        self.assertEqual(save_report(self.report(), self.root), target)
        self.assertEqual(target.read_text(encoding="utf-8"), "inside\n")
        self.assertEqual(outside_report.read_text(encoding="utf-8"), "outside")

    def test_report_ids_cannot_select_another_path(self):
        for report_id in (
            "../outside",
            "/absolute",
            r"..\outside",
            r"C:\outside",
            ".",
            "..",
            "bad\0name",
        ):
            with self.subTest(report_id=report_id), self.assertRaises(OSError):
                save_report(self.report(report_id), self.root)
        self.assertFalse((self.root / ".cogbench").exists())


if __name__ == "__main__":
    unittest.main()
