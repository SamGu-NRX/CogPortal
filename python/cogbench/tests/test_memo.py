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


class ARememberedTuningIsReplayed(unittest.TestCase):
    """A stored binding says how to call each step, not only which one."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(
            "def feats(value, rate, cutoff):\n    return [(value * cutoff, rate)]\n"
        )

    def _resolve(self):
        role = Role(
            "fingerprint",
            (Stage("features", produces=lambda v: isinstance(v, list), arity=2, tunings=(2,)),),
        )
        return resolve(
            self.tmp,
            chain_role=role,
            fixture=FIXTURE,
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
            remember=True,
        )

    def test_the_entry_records_the_tuning_and_the_replay_restores_it(self):
        first = self._resolve()
        self.assertTrue(first.ready)
        self.assertEqual(first.chain[0].tuning, 2)

        stored = memo.read(self.tmp, memo.fingerprint([self.tmp / "theirs.py"], benchmark=""))
        self.assertEqual(stored["tunings"], [2])

        second = self._resolve()
        self.assertTrue(second.recalled)
        self.assertEqual(second.chain[0].tuning, 2)
        self.assertEqual(second.chain[0].bound(7, 44100), [(14, 44100)])

    def test_an_entry_without_tunings_is_searched_again_rather_than_replayed_bare(self):
        first = self._resolve()
        path = memo.cache_path(self.tmp)
        import json

        record = json.loads(path.read_text())
        del record["binding"]["tunings"]
        path.write_text(json.dumps(record))

        second = self._resolve()
        self.assertFalse(second.recalled)
        self.assertEqual(second.chain[0].tuning, 2)


class ARememberedFormIsReplayed(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # Not `theirs.py`: the class above writes one, discovery registers a
        # module under its bare file name, and a second `theirs` in the same
        # process resolved to the first one's function. ints have no
        # rsplit(), so only the paths form can bind.
        (self.tmp / "pathfeats.py").write_text(
            "def feats(paths, rate):\n    return [(p.rsplit('.', 1)[1], rate) for p in paths]\n"
        )

    def _resolve(self):
        from cogbench.pipeline import Fixtures

        role = Role(
            "fingerprint",
            (Stage("features", produces=lambda v: isinstance(v, list), arity=2),),
        )
        forms = Fixtures((([1, 2], 44100), (["a.png", "b.png"], 44100)))
        return resolve(
            self.tmp,
            chain_role=role,
            fixture=forms,
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
            remember=True,
        )

    def test_the_form_survives_a_replay(self):
        first = self._resolve()
        self.assertTrue(first.ready)
        # ints have no rsplit(), so the paths form is the one that bound.
        self.assertEqual(first.chain[0].form, 1)

        second = self._resolve()
        self.assertTrue(second.recalled)
        self.assertEqual(second.chain[0].form, 1)


class ARememberedHandoffIsReplayed(unittest.TestCase):
    """Which part of a fused step's return the next step was handed is part
    of the binding, not something a replay may work out again. rutvim's week
    1 `spectrogram_conversion` returns `(log_spectrogram, peaks)` and their
    `generate_fingerprints` accepts either, at 0.547 and 0.094."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # Not `theirs.py`: another class in this file writes one, discovery
        # registers a module under its bare file name, and a second `theirs`
        # in the same process resolves to the first one's functions.
        (self.tmp / "fused.py").write_text(
            "def two(value, rate):\n    return ('grid', [(value, rate)])\n"
            "def prints(peaks):\n    return [((a, b), 0) for a, b in peaks]\n"
        )

    def _resolve(self):
        role = Role(
            "fingerprint",
            (
                Stage("fused", produces=lambda v: isinstance(v, tuple), arity=2),
                Stage(
                    "prints",
                    produces=lambda v: isinstance(v, list)
                    and bool(v)
                    and isinstance(v[0], tuple),
                ),
            ),
        )
        return resolve(
            self.tmp,
            chain_role=role,
            fixture=FIXTURE,
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
            remember=True,
        )

    def test_the_entry_records_the_handoff_and_the_replay_restores_it(self):
        first = self._resolve()
        self.assertTrue(first.ready)
        self.assertEqual(first.chain[1].handoff, "element:1")

        stored = memo.read(
            self.tmp, memo.fingerprint([self.tmp / "fused.py"], benchmark="")
        )
        self.assertEqual(stored["handoffs"], [None, "element:1"])

        second = self._resolve()
        self.assertTrue(second.recalled)
        self.assertEqual(second.chain[1].handoff, "element:1")
        self.assertEqual(
            second.chain[1].bound(("grid", [(7, 44100)])), [((7, 44100), 0)]
        )

    def test_an_entry_that_does_not_say_which_part_bound_is_searched_again(self):
        self._resolve()
        path = memo.cache_path(self.tmp)
        import json

        record = json.loads(path.read_text())
        del record["binding"]["handoffs"]
        path.write_text(json.dumps(record))

        second = self._resolve()

        self.assertFalse(second.recalled)
        self.assertEqual(second.chain[1].handoff, "element:1")
