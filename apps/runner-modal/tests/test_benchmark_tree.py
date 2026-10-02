"""`scripts/benchmark_tree.py` against real git repositories made here.

The submodule validators trusted HEAD alone, so an edited tracked manifest
passed them while the images baked and scored it. These run git itself on a
synthetic repository; no benchmark checkout is touched.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))

from benchmark_tree import differences, require_reviewed_tree  # noqa: E402

GIT = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "fixture",
    "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
    "GIT_COMMITTER_NAME": "fixture",
    "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
}


class ReviewedTree(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name) / "week2"
        package = self.repo / "facial_recognition_benchmark" / "manifests"
        package.mkdir(parents=True)
        (package / "public-evaluation.json").write_text('{"labels": [0, 0, 1, 1]}\n')
        (self.repo / "facial_recognition_benchmark" / "drivers.py").write_text("x = 1\n")
        (self.repo / ".gitignore").write_text("*.log\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "reviewed")
        # `differences` runs git with the inherited environment; keep this
        # machine's global git configuration out of what it reports.
        patcher = mock.patch.dict(os.environ, GIT)
        patcher.start()
        self.addCleanup(patcher.stop)

    def git(self, *args):
        subprocess.run(
            ["git", "-C", str(self.repo)] + list(args),
            check=True, env=dict(os.environ, **GIT), capture_output=True,
        )

    def test_the_committed_tree_passes(self):
        self.assertEqual(differences(self.repo), [])
        require_reviewed_tree(self.repo, "benchmarks/week2")

    def test_an_edited_tracked_manifest_is_refused(self):
        # The audit's edit: labels only.
        manifest = self.repo / "facial_recognition_benchmark/manifests/public-evaluation.json"
        manifest.write_text('{"labels": [0, 1, 0, 1]}\n')
        self.assertEqual(
            differences(self.repo), ["facial_recognition_benchmark/manifests/public-evaluation.json"]
        )
        with self.assertRaises(SystemExit) as caught:
            require_reviewed_tree(self.repo, "benchmarks/week2")
        message = str(caught.exception)
        self.assertIn("benchmarks/week2 differs from its reviewed commit", message)
        self.assertIn("public-evaluation.json", message)

    def test_staged_deleted_and_renamed_files_are_refused(self):
        self.git("mv", "facial_recognition_benchmark/drivers.py", "facial_recognition_benchmark/moved.py")
        os.remove(str(self.repo / ".gitignore"))
        found = differences(self.repo)
        self.assertIn(".gitignore", found)
        self.assertIn(
            "facial_recognition_benchmark/moved.py (from facial_recognition_benchmark/drivers.py)", found
        )

    def test_untracked_files_are_refused_because_the_image_copies_them(self):
        (self.repo / "setup.cfg").write_text("[options]\n")
        (self.repo / "facial_recognition_benchmark/manifests/extra case.json").write_text("{}")
        self.assertEqual(
            differences(self.repo),
            ["facial_recognition_benchmark/manifests/extra case.json", "setup.cfg"],
        )

    def test_build_output_is_not_a_difference_even_when_ignored(self):
        (self.repo / ".git/info/exclude").write_text("*.egg-info/\n__pycache__/\n")
        for relative in (
            "facial_recognition_benchmark/__pycache__/drivers.cpython-38.pyc",
            "facial_recognition_benchmark.egg-info/PKG-INFO",
            ".pytest_cache/v/cache/lastfailed",
            "build/lib/facial_recognition_benchmark/drivers.py",
        ):
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("generated")
        self.assertEqual(differences(self.repo), [])

    def test_ignored_files_the_image_would_copy_are_refused(self):
        # The image copy does not read .gitignore, so ignoring a file does
        # not keep it out of /opt/weekN or out of pip's view.
        (self.repo / ".git/info/exclude").write_text("setup.cfg\n")
        (self.repo / "setup.cfg").write_text("[options]\n")
        (self.repo / "run.log").write_text("ignored by .gitignore")
        self.assertEqual(differences(self.repo), ["run.log", "setup.cfg"])

    def test_an_unstaged_rename_keeps_both_names_aligned(self):
        source = self.repo / "facial_recognition_benchmark/file with spaces.py"
        source.write_text("y = 2\n")
        self.git("add", ".")
        self.git("commit", "-q", "-m", "spaced")
        source.rename(self.repo / "facial_recognition_benchmark/renamed with spaces.py")
        self.git("add", "-N", "facial_recognition_benchmark/renamed with spaces.py")
        self.assertEqual(differences(self.repo), [
            "facial_recognition_benchmark/renamed with spaces.py "
            "(from facial_recognition_benchmark/file with spaces.py)",
        ])

    def test_lists_at_most_ten_paths(self):
        for index in range(12):
            (self.repo / "stray-{:02d}.txt".format(index)).write_text("x")
        with self.assertRaises(SystemExit) as caught:
            require_reviewed_tree(self.repo, "benchmarks/week2")
        self.assertIn("stray-09.txt, and 2 more", str(caught.exception))
        self.assertNotIn("stray-10.txt", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
