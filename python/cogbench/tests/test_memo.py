from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import memo  # noqa: E402
from cogbench.discover import discover  # noqa: E402
from cogbench.storage import workspace_dir  # noqa: E402
from cogbench.pipeline import Fixtures, Role, Stage  # noqa: E402
from cogbench.resolve import NoDatabase, resolve  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_resolve import (  # noqa: E402
    COUNTED_BUILD_REPO,
    FACTORY_REPO,
    FIXTURE,
    READING_OBJECT_REPO,
    MANY_CHAINS_REPO,
    REPO,
    ROLE,
    _Recorder,
    _accepts,
    _arrangements,
    _is_factory,
    _module_holding,
    _ranked_accepts,
    _ranked_grades,
)


class _RaisesOnIteration(list):
    def __init__(self, error):
        super().__init__([1])
        self.error = error

    def __iter__(self):
        raise self.error("student iteration failed")


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

    def test_version_12_binding_is_not_reused(self):
        with mock.patch.object(memo, "FORMAT", 12):
            old_key = memo.fingerprint([self.file], benchmark="w1")
        memo.write(self.tmp, old_key, {"enroll": "a.b"})
        self.assertEqual(memo.FORMAT, 13)
        new_key = memo.fingerprint([self.file], benchmark="w1")
        self.assertNotEqual(new_key, old_key)
        self.assertIsNone(memo.read(self.tmp, new_key))

    def test_a_file_that_could_not_be_read_skips_the_memo(self):
        missing = self.tmp / "gone.py"
        self.assertEqual(memo.fingerprint([self.file, missing], benchmark="w1"), "")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_binding_survives_a_round_trip(self):
        memo.write(self.tmp, "k", {"enroll": "a.b"})
        self.assertEqual(memo.read(self.tmp, "k"), {"enroll": "a.b"})

    def test_unsupported_tunings_skip_the_cache_without_creating_a_workspace(self):
        circular = []
        circular.append(circular)
        for tuning in (
            {1, 2}, object(), circular, float("nan"), float("inf"), -float("inf"),
            _RaisesOnIteration(RuntimeError), _RaisesOnIteration(SystemExit),
        ):
            with self.subTest(type=type(tuning).__name__, value=repr(tuning)):
                memo.write(self.tmp, "k", {"tunings": [tuning]})
                self.assertFalse(memo.cache_path(self.tmp).parent.exists())

    def test_serialization_runs_under_the_clock_before_workspace_creation(self):
        binding = {"tunings": [2]}
        events = []

        def clock(call, *args, **kwargs):
            self.assertIs(call, json.dumps)
            self.assertEqual(args, ({"key": "k", "binding": binding},))
            self.assertFalse(kwargs["allow_nan"])
            self.assertFalse(memo.cache_path(self.tmp).parent.exists())
            events.append("serialize")
            return call(*args, **kwargs)

        def workspace(root):
            self.assertEqual(events, ["serialize"])
            events.append("workspace")
            return workspace_dir(root)

        with mock.patch.object(memo, "_under_clock", side_effect=clock) as guarded:
            with mock.patch.object(memo, "workspace_dir", side_effect=workspace):
                memo.write(self.tmp, "k", binding)
        guarded.assert_called_once()
        self.assertEqual(events, ["serialize", "workspace"])
        self.assertEqual(memo.read(self.tmp, "k"), binding)

    def test_clock_failure_skips_workspace_creation(self):
        with mock.patch.object(memo, "_under_clock", side_effect=RuntimeError("clock")):
            with mock.patch.object(memo, "workspace_dir") as workspace:
                memo.write(self.tmp, "k", {"tunings": [2]})
        workspace.assert_not_called()
        self.assertFalse(memo.cache_path(self.tmp).parent.exists())

    def test_serialization_failures_leave_an_existing_entry_untouched(self):
        memo.write(self.tmp, "k", {"tunings": [2]})
        path = memo.cache_path(self.tmp)
        before = path.read_bytes()
        for error in (TypeError, ValueError, OverflowError, RecursionError):
            with self.subTest(error=error.__name__), mock.patch.object(
                memo.json, "dumps", side_effect=error("cannot serialize")
            ):
                memo.write(self.tmp, "other", {"tunings": [object()]})
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(sorted(p.name for p in path.parent.iterdir()), [".gitignore", "resolved.json"])

    def test_symlinked_workspace_is_neither_read_nor_written(self):
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory)
            record = outside / "resolved.json"
            original = '{"key": "k", "binding": {"enroll": "outside"}}'
            record.write_text(original)
            memo.cache_path(self.tmp).parent.symlink_to(outside, target_is_directory=True)
            self.assertIsNone(memo.read(self.tmp, "k"))
            memo.write(self.tmp, "k", {"enroll": "a.b"})
            self.assertEqual(record.read_text(), original)
            self.assertEqual([p.name for p in outside.iterdir()], ["resolved.json"])

    def test_dangling_workspace_symlink_is_left_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory) / "missing"
            memo.cache_path(self.tmp).parent.symlink_to(outside, target_is_directory=True)
            self.assertIsNone(memo.read(self.tmp, "k"))
            memo.write(self.tmp, "k", {"enroll": "a.b"})
            self.assertFalse(outside.exists())

    def test_symlinked_ignore_file_prevents_writes_even_when_dangling(self):
        path = memo.cache_path(self.tmp)
        path.parent.mkdir()
        ignore = path.parent / ".gitignore"
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory) / "ignore"
            for exists in (False, True):
                with self.subTest(target_exists=exists):
                    if exists:
                        outside.write_text("original")
                    ignore.symlink_to(outside)
                    memo.write(self.tmp, "k", {"enroll": "a.b"})
                    self.assertFalse(path.exists())
                    self.assertEqual(outside.exists(), exists)
                    if exists:
                        self.assertEqual(outside.read_text(), "original")
                    ignore.unlink()

    def test_old_predictable_temp_symlink_is_not_used_or_removed(self):
        path = memo.cache_path(self.tmp)
        path.parent.mkdir()
        old_temp = path.with_name("resolved.json.tmp")
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory) / "untouched"
            outside.write_text("original")
            old_temp.symlink_to(outside)
            memo.write(self.tmp, "k", {"enroll": "a.b"})
            self.assertEqual(outside.read_text(), "original")
            self.assertTrue(old_temp.is_symlink())
            self.assertEqual(memo.read(self.tmp, "k"), {"enroll": "a.b"})

    def test_cache_file_symlink_is_a_miss_and_replaced_without_following_it(self):
        path = memo.cache_path(self.tmp)
        path.parent.mkdir()
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory) / "record"
            original = '{"key": "k", "binding": {"enroll": "outside"}}'
            outside.write_text(original)
            path.symlink_to(outside)
            self.assertIsNone(memo.read(self.tmp, "k"))
            memo.write(self.tmp, "k", {"enroll": "a.b"})
            self.assertFalse(path.is_symlink())
            self.assertEqual(outside.read_text(), original)
            self.assertEqual(memo.read(self.tmp, "k"), {"enroll": "a.b"})

    def test_replacing_a_hardlinked_entry_preserves_outside_bytes(self):
        path = memo.cache_path(self.tmp)
        path.parent.mkdir()
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory) / "record"
            outside.write_text("original")
            os.link(str(outside), str(path))
            memo.write(self.tmp, "k", {"enroll": "a.b"})
            self.assertEqual(outside.read_text(), "original")
            self.assertEqual(memo.read(self.tmp, "k"), {"enroll": "a.b"})

    def test_failed_replace_cleans_only_its_own_temporary_file(self):
        memo.write(self.tmp, "k", {"enroll": "original"})
        path = memo.cache_path(self.tmp)
        unrelated = path.with_name("resolved.json.tmp")
        unrelated.write_text("unrelated")
        before = set(path.parent.iterdir())
        with mock.patch.object(Path, "replace", side_effect=OSError("cannot replace")):
            memo.write(self.tmp, "other", {"enroll": "changed"})
        self.assertEqual(set(path.parent.iterdir()), before)
        self.assertEqual(unrelated.read_text(), "unrelated")
        self.assertEqual(memo.read(self.tmp, "k"), {"enroll": "original"})

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


class UsableReplayedSubmissions(unittest.TestCase):
    def test_lazy_constructors_and_factories_keep_resource_files(self):
        resource_read = (
            "from pathlib import Path\n"
            "import os\n"
            "def read_resource():\n"
            "    path = Path(os.environ['COGWORKS_LANGUAGE_DATA']) / 'course.txt'\n"
            "    assert path.read_text() == 'supplied by the benchmark'\n"
        )
        cases = (
            (FACTORY_REPO.replace(
                "def create_database():\n    return {}",
                "def create_database():\n    read_resource()\n    return {}",
            ), _ranked_accepts, _ranked_grades, _is_factory, 2),
            (COUNTED_BUILD_REPO.replace(
                "        BUILDS.append(1)",
                "        read_resource()\n        BUILDS.append(1)",
            ), _accepts, None, None, 0),
        )
        for source, accepts, grades, factories, readers in cases:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                resource = root / 'course.txt'
                resource.write_text('supplied by the benchmark')
                (root / 'theirs.py').write_text(resource_read + source)
                for recalled in (False, True):
                    with self.subTest(factory=factories is not None, recalled=recalled):
                        submission = resolve(
                            root, chain_role=ROLE, fixture=FIXTURE, accepts=accepts,
                            arrangements=_arrangements, grades=grades, factories=factories,
                            readers=readers, remember=True,
                            resource_files={'course.txt': resource},
                        )
                        self.assertTrue(submission.ready, submission.verdict.headline)
                        self.assertEqual(submission.recalled, recalled)
                        for ready in (submission, submission.fresh()):
                            ready.enroll('gamma', [(14, 44100)])
                            expected = ['gamma'] if factories else 'gamma'
                            self.assertEqual(ready.query([(14, 44100)]), expected)

    def test_factory_and_constructor_failures_are_reported_on_first_use(self):
        factory = "FAIL = False\n" + FACTORY_REPO.replace(
            "def create_database():\n    return {}",
            "def create_database():\n    if FAIL:\n        raise ValueError('closed')\n    return {}",
        )
        constructor = "FAIL = False\n" + COUNTED_BUILD_REPO.replace(
            "        BUILDS.append(1)",
            "        if FAIL:\n            raise ValueError('closed')\n        BUILDS.append(1)",
        )
        cases = (
            (factory, _ranked_accepts, _ranked_grades, _is_factory, 2),
            (constructor, _accepts, None, None, 0),
        )
        for source, accepts, grades, factories, readers in cases:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                (root / "theirs.py").write_text(source)
                for recalled in (False, True):
                    submission = resolve(
                        root, chain_role=ROLE, fixture=FIXTURE, accepts=accepts,
                        arrangements=_arrangements, grades=grades, factories=factories,
                        readers=readers, remember=True,
                    )
                    self.assertTrue(submission.ready)
                    self.assertEqual(submission.recalled, recalled)
                    _module_holding(submission, "FAIL").FAIL = True
                    for ready in (submission, submission.fresh()):
                        with self.assertRaises(NoDatabase):
                            ready.enroll("gamma", [(14, 44100)])
                        with self.assertRaises(NoDatabase):
                            ready.query([(14, 44100)])

    def test_cold_and_replayed_submissions_enroll_into_their_own_empty_store(self):
        cases = (
            ("factory", FACTORY_REPO, _ranked_accepts, _ranked_grades, _is_factory, 2),
            ("method-reader", READING_OBJECT_REPO, _ranked_accepts, _ranked_grades, None, 1),
            ("state-method", READING_OBJECT_REPO.replace(
                "def lookup(self, features):", "def lookup(self, features, hashes, names):"
            ), _accepts, None, None, 0),
            ("state-optional", READING_OBJECT_REPO.replace(
                "def lookup(self, features):", "def lookup(self, features, hashes, names=None):"
            ), _accepts, None, None, 0),
        )
        for name, source, accepts, grades, factories, readers in cases:
            with self.subTest(shape=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                (root / "theirs.py").write_text(source)
                submissions = [resolve(
                    root, chain_role=ROLE, fixture=FIXTURE, accepts=accepts,
                    arrangements=_arrangements, grades=grades, factories=factories,
                    readers=readers, remember=True,
                ) for _ in range(2)]
                self.assertFalse(submissions[0].recalled)
                self.assertTrue(submissions[1].recalled)
                for submission in submissions:
                    self.assertTrue(submission.ready, submission.verdict.headline)
                    submission.enroll("gamma", [(14, 44100)])
                    expected = "gamma" if name.startswith("state-") else ["gamma"]
                    self.assertEqual(submission.query([(14, 44100)]), expected)


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
            _key(self.tmp),
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
    return json.loads(memo.cache_path(repository).read_text())["key"]


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

    def test_non_json_tuning_does_not_abort_resolution(self):
        (self.tmp / "theirs.py").write_text(
            "def feats(value, rate, cutoff):\n    return [(value, rate)]\n"
        )
        circular = []
        circular.append(circular)
        for tuning in (
            {1, 2}, object(), circular, float("nan"), float("inf"), -float("inf"),
            _RaisesOnIteration(RuntimeError), _RaisesOnIteration(SystemExit),
        ):
            with self.subTest(type=type(tuning).__name__, value=repr(tuning)):
                role = Role(
                    "fingerprint",
                    (Stage("features", produces=lambda v: isinstance(v, list), arity=2, tunings=(tuning,)),),
                )
                submission = resolve(
                    self.tmp, chain_role=role, fixture=FIXTURE,
                    accepts=lambda chain, *_: (True, ""),
                    arrangements=None, remember=True,
                )
                self.assertTrue(submission.ready, submission.verdict.headline)
                self.assertFalse(submission.recalled)
                self.assertIs(submission.chain[0].tuning, tuning)
                self.assertEqual(submission.chain[0].bound(7, 44100), [(7, 44100)])
                self.assertFalse(memo.cache_path(self.tmp).parent.exists())

    def test_the_entry_records_the_tuning_and_the_replay_restores_it(self):
        first = self._resolve()
        self.assertTrue(first.ready)
        self.assertEqual(first.chain[0].tuning, 2)

        stored = memo.read(self.tmp, _key(self.tmp))
        self.assertEqual(stored["tunings"], [2])

        second = self._resolve()
        self.assertTrue(second.recalled)
        self.assertEqual(second.chain[0].tuning, 2)
        self.assertEqual(second.chain[0].bound(7, 44100), [(14, 44100)])

    def test_an_entry_without_tunings_is_searched_again_rather_than_replayed_bare(self):
        first = self._resolve()
        path = memo.cache_path(self.tmp)
        record = json.loads(path.read_text())
        del record["binding"]["tunings"]
        path.write_text(json.dumps(record))

        second = self._resolve()
        self.assertFalse(second.recalled)
        self.assertEqual(second.chain[0].tuning, 2)


    def test_an_entry_this_version_cannot_read_is_a_miss_and_not_a_crash(self):
        """The key fingerprints their source, not this package.

        A cogbench upgrade that changes what a binding holds meets an entry
        whose key still matches and whose fields no longer parse. Raising
        there reaches the student as "Could not read your repository", which
        blames their code for our cache.
        """

        self._resolve()
        path = memo.cache_path(self.tmp)
        record = json.loads(path.read_text())
        record["binding"]["arrangement"] = []
        path.write_text(json.dumps(record))

        second = self._resolve()

        self.assertFalse(second.recalled)
        self.assertTrue(second.ready)


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

        stored = memo.read(self.tmp, _key(self.tmp))
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
        record = json.loads(path.read_text())
        del record["binding"]["handoffs"]
        path.write_text(json.dumps(record))

        second = self._resolve()

        self.assertFalse(second.recalled)
        self.assertEqual(second.chain[1].handoff, "element:1")


class WhatIsRememberedIsTheWholeSearch(unittest.TestCase):
    """An entry says how much work the search did, and a surface reports that
    without searching again.

    It recorded the accepted chain's own ordinal. A repository whose first
    complete chains cannot be paired -- three of them here, two of which run
    end to end and name nothing back -- remembered a number that left every
    pairing tried before the winning chain out of the count.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(MANY_CHAINS_REPO)

    def test_the_entry_counts_every_pairing_rather_than_the_last_chains(self):
        watcher = _Recorder()

        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
            remember=True,
            benchmark="mini",
            progress=watcher,
        )
        stored = json.loads(memo.cache_path(self.tmp).read_text(encoding="utf-8"))

        tried = max(done for done, _ in watcher.counts)
        self.assertGreater(tried, 0)
        self.assertEqual(submission.attempts_tried, tried)
        self.assertEqual(stored["binding"]["attemptsTried"], tried)


class TheWorkspaceIgnoresItself(unittest.TestCase):
    """A local run must not dirty the checkout it ran in."""

    def test_git_does_not_see_the_cogbench_directory(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        (workspace_dir(root) / "resolved.json").write_text("{}")

        status = subprocess.run(
            ["git", "status", "--porcelain"], cwd=root, check=True, capture_output=True, text=True
        ).stdout
        self.assertEqual(status, "")


if __name__ == "__main__":
    unittest.main()


PACKAGE_INIT = "SCALE = {scale}\n"

PACKAGE_CORE = '''
from . import SCALE

_DB = {}


def make_features(value, rate):
    return [(value * SCALE, rate)]


def remember(features, item_id):
    _DB[tuple(features)] = item_id


def whose(features):
    return _DB.get(tuple(features), "")
'''


class AnInitializerThatDecidesWhatItsPackageReturnsIsPartOfTheKey(unittest.TestCase):
    """Initializer-only edits must invalidate their members' remembered binding."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _write(self, scale: int) -> None:
        package = self.tmp / "theirs"
        package.mkdir(exist_ok=True)
        (package / "__init__.py").write_text(PACKAGE_INIT.format(scale=scale))
        (package / "core.py").write_text(PACKAGE_CORE)

    def _resolve(self):
        return resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
            remember=True,
        )

    def test_the_initializer_is_one_of_the_files_the_key_reads(self):
        self._write(2)

        found = discover(self.tmp)

        self.assertEqual(
            sorted(path.name for path in memo.source_paths(found)),
            ["__init__.py", "core.py"],
        )

    def test_transitively_imported_initializer_beyond_traversal_is_hashed(self):
        package = self.tmp / "a" / "b" / "c"
        package.mkdir(parents=True)
        initializer = package / "__init__.py"
        initializer.write_text("SCALE = 2\n")
        (self.tmp / "main.py").write_text(
            "from a.b.c import SCALE\ndef encode(value):\n    return value * SCALE\n"
        )

        found = discover(self.tmp)
        self.assertNotIn(initializer, [entry.path for entry in found.modules])
        paths = memo.source_paths(found)
        self.assertIn(initializer, paths)
        before = memo.fingerprint(paths, benchmark="transitive-initializer")
        self.assertTrue(before)
        initializer.write_text("SCALE = 3\n")
        self.assertNotEqual(
            before, memo.fingerprint(paths, benchmark="transitive-initializer")
        )

    def test_editing_only_the_initializer_searches_again(self):
        self._write(2)
        self.assertTrue(self._resolve().ready)
        self.assertTrue(self._resolve().recalled)

        self._write(3)

        self.assertFalse(self._resolve().recalled)

    def test_a_repository_nobody_touched_still_replays(self):
        self._write(2)
        self.assertTrue(self._resolve().ready)

        self.assertTrue(self._resolve().recalled)
