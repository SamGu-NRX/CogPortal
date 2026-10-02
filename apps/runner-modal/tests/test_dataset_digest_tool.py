"""The operator command that turns a published bundle into a catalog approval."""

from __future__ import annotations

import contextlib
import io
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps/runner-modal/tools"))
sys.path.insert(0, str(ROOT / "apps/runner-modal/src"))

import dataset_digest as tool  # noqa: E402
from cogworks_runner.official_bundle import dataset_digest, read_bundle  # noqa: E402

MIGRATIONS = ROOT / "apps/portal/migrations"


def run(*argv):
    with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
        code = tool.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class DatasetDigestTool(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.bundle = Path(temporary.name) / "official-v1"
        self.bundle.mkdir()
        (self.bundle / "payload.zip").write_bytes(b"synthetic payload")
        (self.bundle / "gold.json").write_bytes(b'{"rows":[0,2]}')

    def test_prints_the_controllers_digest_and_a_guarded_update(self):
        code, out, _ = run("--benchmark", "language-search", "--dataset-version", "official-v1", str(self.bundle))
        self.assertEqual(code, 0)
        digest = dataset_digest(read_bundle(self.bundle, "language-search"))
        self.assertEqual(out.splitlines()[0], "Dataset digest for language-search official-v1: " + digest)
        self.assertIn(tool.registration_sql("language-search", "official-v1", digest), out)

    def test_names_files_it_did_not_hash(self):
        (self.bundle / "README.txt").write_text("notes")
        code, out, _ = run("--benchmark", "language-search", "--dataset-version", "official-v1", str(self.bundle))
        self.assertEqual(code, 0)
        self.assertIn("Not part of the digest: README.txt.", out)

    def test_refuses_a_missing_scored_file_or_a_bad_version_name(self):
        for argv, words in (
            (("--benchmark", "vision-clustering", "--dataset-version", "official-v1", str(self.bundle)),
             "expected.json could not be read"),
            (("--benchmark", "language-search", "--dataset-version", "v1'; DROP TABLE runs; --", str(self.bundle)),
             "is not a dataset version name"),
            (("--benchmark", "language-search", "--dataset-version", "official-v1", str(self.bundle / "absent")),
             "is not a directory"),
        ):
            with self.subTest(words=words):
                code, out, err = run(*argv)
                self.assertEqual((code, out), (1, ""))
                self.assertIn(words, err)

    def test_the_update_fills_only_an_empty_approval_under_the_real_schema(self):
        database = sqlite3.connect(":memory:")
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            database.executescript(migration.read_text(encoding="utf-8"))
        rows = lambda: database.execute(  # noqa: E731
            "SELECT id, dataset_version, dataset_digest FROM benchmarks WHERE id = 'language-search'"
        ).fetchall()
        version = rows()[0][1]
        self.assertEqual({row[2] for row in rows()}, {None})
        database.executescript(tool.registration_sql("language-search", version, "a" * 64))
        self.assertEqual({row[2] for row in rows() if row[1] == version}, {"a" * 64})
        # A second approval for the same version changes nothing.
        database.executescript(tool.registration_sql("language-search", version, "b" * 64))
        self.assertEqual({row[2] for row in rows() if row[1] == version}, {"a" * 64})
        with self.assertRaises(sqlite3.IntegrityError):
            database.execute("UPDATE benchmarks SET dataset_digest = 'NOT-HEX' WHERE id = 'language-search'")


if __name__ == "__main__":
    unittest.main()
