from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import memo  # noqa: E402
from cogbench.pipeline import Role, Stage  # noqa: E402
from cogbench.resolve import resolve  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_resolve import REPO, ROLE, FIXTURE, _accepts, _arrangements  # noqa: E402


class KeyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.file = self.tmp / "theirs.py"
        self.file.write_text("def a():\n    return 1\n")

    def test_editing_a_file_changes_the_key(self):
        """This is the whole safety property. A cache that survived an edit
        would score code the student has already replaced."""

        before = memo.fingerprint([self.file], benchmark="w1")
        self.file.write_text("def a():\n    return 2\n")

        self.assertNotEqual(before, memo.fingerprint([self.file], benchmark="w1"))

    def test_touching_a_file_without_editing_it_does_not(self):
        """A checkout, a branch switch, and a stash all rewrite timestamps
        without changing code, and all three happen constantly."""

        before = memo.fingerprint([self.file], benchmark="w1")
        self.file.write_text(self.file.read_text())  # new mtime, same bytes

        self.assertEqual(before, memo.fingerprint([self.file], benchmark="w1"))

    def test_renaming_a_file_changes_the_key(self):
        before = memo.fingerprint([self.file], benchmark="w1")
        moved = self.tmp / "renamed.py"
        self.file.rename(moved)

        self.assertNotEqual(before, memo.fingerprint([moved], benchmark="w1"))

    def test_two_benchmarks_do_not_share_an_entry(self):
        self.assertNotEqual(
            memo.fingerprint([self.file], benchmark="week1"),
            memo.fingerprint([self.file], benchmark="week3"),
        )

    def test_a_file_that_could_not_be_read_still_makes_a_key(self):
        missing = self.tmp / "gone.py"
        self.assertTrue(memo.fingerprint([self.file, missing], benchmark="w1"))


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_binding_survives_a_round_trip(self):
        memo.write(self.tmp, "k", {"enroll": "a.b"})
        self.assertEqual(memo.read(self.tmp, "k"), {"enroll": "a.b"})

    def test_a_different_key_reads_nothing(self):
        memo.write(self.tmp, "k", {"enroll": "a.b"})
        self.assertIsNone(memo.read(self.tmp, "other"))

    def test_a_corrupt_file_is_a_slow_check_not_a_broken_one(self):
        path = memo.cache_path(self.tmp)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json")

        self.assertIsNone(memo.read(self.tmp, "k"))

    def test_a_read_only_checkout_does_not_fail_the_run(self):
        """The Modal sandbox mounts one. Failing over a cache write would turn
        a speed feature into an outage."""

        (self.tmp / ".cogbench").mkdir()
        (self.tmp / ".cogbench").chmod(0o500)
        self.addCleanup(lambda: (self.tmp / ".cogbench").chmod(0o700))

        memo.write(self.tmp, "k", {"enroll": "a.b"})  # must not raise


class ReuseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)

    def _resolve(self, **kwargs):
        return resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
            remember=True,
            benchmark="mini",
            **kwargs,
        )

    def test_the_second_check_reuses_the_first(self):
        first = self._resolve()
        second = self._resolve()

        self.assertFalse(first.recalled)
        self.assertTrue(second.recalled)
        self.assertEqual(first.attempt, second.attempt)

    def test_a_reused_binding_still_runs_their_code(self):
        """A recalled entry is names, not functions. What comes back has to be
        callable and has to be theirs."""

        self._resolve()
        second = self._resolve()

        second.enroll("alpha", [(14, 44100)])
        self.assertEqual(second.query([(14, 44100)]), "alpha")

    def test_editing_their_code_forces_a_new_search(self):
        self._resolve()
        (self.tmp / "theirs.py").write_text(REPO.replace("value * 2", "value * 3"))
        again = self._resolve()

        self.assertFalse(again.recalled)

    def test_a_binding_naming_a_function_that_no_longer_exists_is_discarded(self):
        """Their code moved. The honest response is to search again, not to
        report a binding that does not exist."""

        self._resolve()
        memo.write(
            self.tmp,
            memo.read.__module__ and _key(self.tmp),
            {"chain": ["theirs.gone"], "enroll": "theirs.remember", "query": "theirs.whose", "arrangement": 0},
        )
        again = self._resolve()

        self.assertFalse(again.recalled)
        self.assertTrue(again.ready)

    def test_remembering_is_off_unless_asked_for(self):
        """A graded run should search. The point of an official score is that
        it was computed, not recalled."""

        resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
        )

        self.assertFalse(memo.cache_path(self.tmp).exists())


def _key(repository: Path) -> str:
    from cogbench.discover import discover

    return memo.fingerprint(memo.source_paths(discover(repository)), benchmark="mini")


if __name__ == "__main__":
    unittest.main()
