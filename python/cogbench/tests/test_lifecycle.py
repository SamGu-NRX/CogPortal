"""When a reading ends, and what their model loader gets told about it.

A week that loads its own models declares `construct`, a context manager that
yields them. It is a context manager because only the week knows how to shut
its loader down, and it runs in every namespace that needs models: the search's
own, and each trial's, and each run of a returned binding. None of those models
is ever copied from another namespace, because a model belongs to the code that
built it.

These are the lifetime rules, which nothing else tests: that the block exits
once per owner, that it exits while the namespace it was built in still
answers, and that a reading nobody owns any more refuses rather than answering
out of one.
"""
from __future__ import annotations

import contextlib
import gc
import os
import shutil
import sys
import tempfile
import unittest
import weakref
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from unittest.mock import patch  # noqa: E402

from cogbench._namespace import (  # noqa: E402
    CleanupFailed, Closed, Project, Unmapped,
)
from cogbench import storage  # noqa: E402
from cogbench.discover import discover  # noqa: E402
from cogbench.discovery_spec import DiscoverySpec  # noqa: E402
from cogbench.pipeline import Role, Stage  # noqa: E402
from cogbench.progress import Progress  # noqa: E402
from cogbench.resolve import from_spec, resolve  # noqa: E402

#: Their code, and a model their own loader builds out of it.
REPO = '''
SCALE = 3


def scale(rows):
    return [r * SCALE for r in rows]
'''


def _week(log, *, fails_on_exit=False, yields=None):
    """A week whose `construct` records every time it opens and closes."""

    @contextlib.contextmanager
    def construct(root, namespace, inputs):
        log.append("enter")
        try:
            yield dict(yields or {"weights": object()})
        finally:
            log.append("exit")
            if fails_on_exit:
                raise ValueError("their loader would not let go")

    return construct


class _Quiet(Progress):
    """A watcher that keeps what it was told, so a note can be read back."""

    def __init__(self):
        super().__init__()
        self.notes = []

    def note(self, text):
        self.notes.append(text)


class AModelBlockOpensAndClosesOncePerNamespace(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)
        self.log = []
        self.role = Role(
            "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
        )

    def _resolve(self, **changes):
        arguments = dict(
            chain_role=self.role, fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None, construct=_week(self.log),
        )
        arguments.update(changes)
        return resolve(self.tmp, **arguments)

    def test_every_open_is_matched_by_a_close(self):
        submission = self._resolve()
        self.assertTrue(submission.ready, submission.verdict.headline)

        submission.close()

        self.assertEqual(self.log.count("enter"), self.log.count("exit"))
        self.assertGreater(self.log.count("enter"), 1)

    def test_the_search_closes_its_own_models_before_returning(self):
        """The reading the search used is gone by the time a caller has the
        submission; only the returned run's is still open."""

        submission = self._resolve()

        # One block is still open: the run this submission owns.
        self.assertEqual(self.log.count("enter") - self.log.count("exit"), 1)
        submission.close()
        self.assertEqual(self.log.count("enter"), self.log.count("exit"))

    def test_search_model_exits_before_the_returned_model_enters(self):
        events = []

        @contextlib.contextmanager
        def construct(root, namespace, inputs):
            identity = object()
            events.append(("enter", identity))
            try:
                yield {"weights": object()}
            finally:
                events.append(("exit", identity))

        submission = self._resolve(construct=construct)
        self.addCleanup(submission.close)
        self.assertTrue(submission.ready, submission.verdict.headline)
        search = events[0][1]
        returned = [identity for event, identity in events if event == "enter"][-1]
        self.assertIsNot(search, returned)
        self.assertLess(events.index(("exit", search)), events.index(("enter", returned)))

    def test_each_run_of_a_binding_builds_and_releases_its_own(self):
        submission = self._resolve()
        first, second = submission.fresh(), submission.fresh()
        opened = self.log.count("enter")

        first.close()
        self.assertEqual(self.log.count("exit"), opened - 2)
        second.close()
        self.assertEqual(self.log.count("exit"), opened - 1)
        submission.close()
        self.assertEqual(self.log.count("enter"), self.log.count("exit"))

    def test_a_week_that_loads_nothing_needs_no_hook(self):
        """Every data-only and no-weight adapter keeps working untouched."""

        submission = self._resolve(construct=None)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(self.log, [])
        submission.close()


class AClosedReadingRefusesRatherThanAnswering(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)

    def _resolve(self):
        return resolve(
            self.tmp,
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
        )

    def test_a_step_kept_from_before_the_close_refuses(self):
        submission = self._resolve()
        step = submission.chain[0]
        self.assertEqual(step.bound([1, 2]), [3, 6])

        submission.close()

        with self.assertRaises(Closed):
            step.bound([1, 2])

    def test_what_the_run_recorded_is_still_readable(self):
        submission = self._resolve()
        before = submission.to_dict()

        submission.close()

        self.assertEqual(submission.to_dict(), before)
        self.assertEqual(submission.verdict.status, before["verdict"]["status"])
        self.assertEqual([step.label for step in submission.chain], ["theirs.scale"])

    def test_closing_twice_is_the_same_as_closing_once(self):
        submission = self._resolve()

        submission.close()
        submission.close()

        with self.assertRaises(Closed):
            submission.chain[0].bound([1])

    def test_a_closed_submission_will_not_quietly_reopen(self):
        submission = self._resolve()
        submission.close()

        with self.assertRaises(Closed):
            submission.fresh()

    def test_it_works_as_a_context_manager(self):
        with self._resolve() as submission:
            self.assertEqual(submission.chain[0].bound([1]), [3])

        with self.assertRaises(Closed):
            submission.chain[0].bound([1])


class ALoaderThatRaisesOnTheWayOutIsReportedNotFatal(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)
        self.log = []
        self.watcher = _Quiet()

    def _resolve(self):
        return resolve(
            self.tmp,
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
            construct=_week(self.log, fails_on_exit=True),
            progress=self.watcher,
        )

    def test_the_search_still_resolves_and_says_what_happened(self):
        submission = self._resolve()
        self.addCleanup(self._release, submission)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertTrue(
            any("would not let go" in note for note in self.watcher.notes),
            self.watcher.notes,
        )

    @staticmethod
    def _release(submission):
        try:
            submission.close()
        except CleanupFailed:
            pass

    def test_an_explicit_close_raises_and_still_closes(self):
        submission = self._resolve()

        with self.assertRaises(CleanupFailed):
            submission.close()

        # Closed either way: a namespace half owned is the worse outcome.
        with self.assertRaises(Closed):
            submission.chain[0].bound([1])


class ModelsAreBuiltPerReadingAndNeverCopied(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(
            "def scale(rows, weights):\n    return [r * weights['by'] for r in rows]\n"
        )
        self.built = []

        @contextlib.contextmanager
        def construct(root, namespace, inputs):
            made = {"by": 3, "id": len(self.built)}
            self.built.append(made)
            yield {"weights": made}

        self.construct = construct
        self.role = Role(
            "search",
            (Stage("one", produces=lambda v: isinstance(v, list),
                   extras=("weights",)),),
        )

    def _resolve(self):
        return resolve(
            self.tmp, chain_role=self.role, fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None, construct=self.construct,
        )

    def test_their_step_is_handed_the_model_this_reading_built(self):
        submission = self._resolve()

        self.assertTrue(submission.ready, submission.verdict.headline)
        handed = submission.chain[0].supplied["weights"]
        # The object itself, not a copy of one from another namespace.
        self.assertIs(handed, self.built[-1])
        self.assertEqual(submission.chain[0].bound([2]), [6])
        submission.close()

    def test_two_runs_hold_two_models(self):
        submission = self._resolve()
        first, second = submission.fresh(), submission.fresh()

        self.assertIsNot(
            first.chain[0].supplied["weights"], second.chain[0].supplied["weights"]
        )
        first.close()
        second.close()
        submission.close()

    def test_a_hook_claiming_a_name_the_benchmark_owns_is_refused(self):
        """Either could own it. Choosing would be guessing which half of the
        week's own declaration to believe."""

        @contextlib.contextmanager
        def claims_the_data(root, namespace, inputs):
            yield {"weights": {"by": 3}}

        submission = resolve(
            self.tmp, chain_role=self.role, fixture=([1],),
            accepts=lambda chain, *_: (True, ""), arrangements=None,
            construct=claims_the_data, extras={"weights": {"by": 9}},
        )

        self.assertFalse(submission.ready)
        self.assertIn("hook_contract", submission.verdict.headline)
        self.assertIn("weights", submission.verdict.headline)


class AProjectIsTheThingThatOwnsAReading(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)
        self.found = discover(self.tmp)

    def test_close_runs_the_block_then_drops_the_namespace(self):
        log = []
        project = Project(self.tmp, self.found)
        models = project.models(_week(log), {})
        self.assertEqual(log, ["enter"])
        # The same mapping every time: one reading, one set of models.
        self.assertIs(project.models(_week(log), {}), models)
        self.assertEqual(log, ["enter"])

        project.close()

        self.assertEqual(log, ["enter", "exit"])
        self.assertTrue(project.closed)
        with self.assertRaises(Closed):
            project.found

    def test_it_works_as_a_context_manager(self):
        log = []
        with Project(self.tmp, self.found) as project:
            project.models(_week(log), {})
        self.assertEqual(log, ["enter", "exit"])
        self.assertTrue(project.closed)


#: Their own class, and a model their loader builds out of it. The class
#: refuses to be copied, which is the whole assertion in one line: a model
#: that reached the benchmark's input snapshot would be deep-copied there.
MODEL_REPO = '''
SEEN = []


class Encoder:
    def __init__(self):
        self.calls = 0

    def __deepcopy__(self, memo):
        raise AssertionError("a model must never be copied")

    def encode(self, rows):
        self.calls += 1
        SEEN.append(self.calls)
        return [r * 3 for r in rows]


def embed(rows, encoder):
    return encoder.encode(rows)
'''


def _their_model(namespace, inputs=None, keep=None):
    """Build a model out of the class in THIS reading, not any other."""

    for module in namespace:
        if hasattr(module, "Encoder"):
            made = module.Encoder()
            if inputs is not None:
                made.table = inputs["table"]
            if keep is not None:
                keep.append(made)
            return made
    raise AssertionError("their Encoder is not in this namespace")


class AModelIsBuiltFromTheClassInItsOwnReading(unittest.TestCase):
    """A model is an object of THEIR class, so it belongs to the reading whose
    class object it was built from, and it is never carried to another."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(MODEL_REPO)
        self.made = []
        self.role = Role(
            "search",
            (Stage("one", produces=lambda v: isinstance(v, list),
                   extras=("encoder",)),),
        )

        @contextlib.contextmanager
        def construct(root, namespace, inputs):
            yield {"encoder": _their_model(namespace, keep=self.made)}

        self.construct = construct

    def _resolve(self, **changes):
        arguments = dict(
            chain_role=self.role, fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None, construct=self.construct,
        )
        arguments.update(changes)
        submission = resolve(self.tmp, **arguments)
        self.addCleanup(submission.close)
        return submission

    def test_a_model_that_refuses_to_be_copied_still_resolves(self):
        """`__deepcopy__` raises, so a run that reaches this at all proves the
        model never entered the benchmark's input snapshot."""

        submission = self._resolve()

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.chain[0].bound([2]), [6])

    def test_its_class_is_this_readings_class(self):
        submission = self._resolve()
        # The hook built one model per reading and `self.made` has them in
        # that order, so the first is the search's own. The run no longer
        # holds the search's reading at all; this is what is left of it.
        searched = self.made[0]

        handed = submission.chain[0].supplied["encoder"]

        # Built from a class object this run read for itself, not the one the
        # search imported.
        self.assertEqual(type(handed).__name__, "Encoder")
        self.assertIsNot(handed, searched)
        self.assertIsNot(type(handed), type(searched))

    def test_two_runs_hold_two_models_of_two_classes(self):
        submission = self._resolve()
        first, second = submission.fresh(), submission.fresh()
        self.addCleanup(first.close)
        self.addCleanup(second.close)

        one = first.chain[0].supplied["encoder"]
        two = second.chain[0].supplied["encoder"]

        self.assertIsNot(one, two)
        self.assertIsNot(type(one), type(two))

    def test_what_one_run_puts_in_a_model_or_a_global_stays_there(self):
        submission = self._resolve()
        first, second = submission.fresh(), submission.fresh()
        self.addCleanup(first.close)
        self.addCleanup(second.close)

        self.assertEqual(first.chain[0].bound([1]), [3])
        self.assertEqual(first.chain[0].bound([1]), [3])
        # Their model counted twice and their module global grew twice, in the
        # first run's namespace. The second run's start from nothing.
        self.assertEqual(first.chain[0].supplied["encoder"].calls, 2)
        self.assertEqual(second.chain[0].supplied["encoder"].calls, 0)
        self.assertEqual(second.chain[0].bound([1]), [3])
        self.assertEqual(second.chain[0].supplied["encoder"].calls, 1)


class TheHookAndTheStepsSeeOneSetOfInputs(unittest.TestCase):
    """`construct` is handed the data pool its own reading's steps are handed.

    A model built out of the benchmark's caption table and a step handed that
    table have to be handed the same table, or the week is running a program
    it did not write. This holds for the search's own namespace too, which was
    reading its models out of one graph and its inputs out of another.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(MODEL_REPO)
        self.seen = []

        @contextlib.contextmanager
        def construct(root, namespace, inputs):
            made = _their_model(namespace, inputs=inputs)
            self.seen.append(made.table)
            yield {"encoder": made}

        self.construct = construct
        self.role = Role(
            "search",
            (Stage("one", produces=lambda v: isinstance(v, list),
                   extras=("encoder", "table")),),
        )
        (self.tmp / "theirs.py").write_text(
            MODEL_REPO.replace(
                "def embed(rows, encoder):\n    return encoder.encode(rows)\n",
                "def embed(rows, encoder, table):\n"
                "    return encoder.encode(rows) if table is encoder.table else None\n",
            )
        )

    def test_the_model_and_the_step_hold_one_table(self):
        original = ["a", "b"]

        submission = resolve(
            self.tmp, chain_role=self.role, fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None, construct=self.construct,
            extras={"table": original},
        )
        self.addCleanup(submission.close)

        self.assertTrue(submission.ready, submission.verdict.headline)
        step = submission.chain[0]
        self.assertIs(step.supplied["table"], step.supplied["encoder"].table)
        # And never the caller's own object. By identity: every
        # reconstruction is equal to it, which is the point.
        self.assertIsNot(step.supplied["table"], original)
        self.assertTrue(self.seen)
        self.assertFalse([seen for seen in self.seen if seen is original])


class AModelHoldingAFileLetsGoOfIt(unittest.TestCase):
    """The point of the hook being a context manager. A real handle, checked
    by asking the handle, on each of the three ways a run can end."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(MODEL_REPO)
        self.artifact = self.tmp / "weights.txt"
        self.artifact.write_text("3")
        self.handles = []

        @contextlib.contextmanager
        def construct(root, namespace, inputs):
            opened_file = open(str(self.artifact))
            self.handles.append(opened_file)
            try:
                model = _their_model(namespace)
                model.source = opened_file
                yield {"encoder": model}
            finally:
                opened_file.close()

        self.construct = construct
        self.role = Role(
            "search",
            (Stage("one", produces=lambda v: isinstance(v, list),
                   extras=("encoder",)),),
        )

    def _resolve(self, accepts):
        return resolve(
            self.tmp, chain_role=self.role, fixture=([1],),
            accepts=accepts, arrangements=None, construct=self.construct,
        )

    def test_every_handle_is_closed_after_a_run_that_worked(self):
        submission = self._resolve(
            lambda chain, *_: (chain[0].bound([1]) == [3], "")
        )
        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertTrue(any(not h.closed for h in self.handles))

        submission.close()

        self.assertTrue(self.handles)
        self.assertTrue(all(h.closed for h in self.handles), self.handles)

    def test_every_handle_is_closed_after_a_refusal(self):
        submission = self._resolve(lambda chain, *_: (False, "no"))

        self.assertFalse(submission.ready)
        self.assertTrue(self.handles)
        self.assertTrue(all(h.closed for h in self.handles), self.handles)

    def test_every_handle_is_closed_when_their_test_raises(self):
        def explodes(chain, *_):
            raise RuntimeError("the week's own test broke")

        try:
            self._resolve(explodes)
        except RuntimeError:
            pass

        self.assertTrue(self.handles)
        self.assertTrue(all(h.closed for h in self.handles), self.handles)


class ACleanupComplaintReachesTheRunNotOnlyATerminal(unittest.TestCase):
    """`Silent` is the default `Progress` and its `note` does nothing, so a
    hosted run has no terminal to hear this. It goes on the record."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)
        self.log = []

    def _resolve(self):
        return resolve(
            self.tmp,
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
            construct=_week(self.log, fails_on_exit=True),
        )

    @staticmethod
    def _release(submission):
        try:
            submission.close()
        except CleanupFailed:
            pass

    def test_the_default_progress_still_records_it(self):
        submission = self._resolve()
        self.addCleanup(self._release, submission)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertTrue(submission.cleanup, "nothing was recorded")
        self.assertTrue(
            any("would not let go" in line for line in submission.cleanup),
            submission.cleanup,
        )

    def test_it_survives_the_record_and_the_verdict_stands(self):
        submission = self._resolve()
        self.addCleanup(self._release, submission)
        record = submission.to_dict()

        self.assertEqual(record["cleanup"], list(submission.cleanup))
        # The scoring already happened; a leak beside it does not retract it.
        self.assertEqual(record["verdict"]["status"], submission.verdict.status)
        self.assertTrue(submission.ready)

    def test_a_run_that_released_cleanly_says_nothing(self):
        submission = resolve(
            self.tmp,
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None, construct=_week(self.log),
        )
        self.addCleanup(submission.close)

        self.assertEqual(submission.cleanup, ())
        self.assertNotIn("cleanup", submission.to_dict())


class TheThreeSmallerLifetimeRules(unittest.TestCase):
    """One case each for the rules that are easy to get subtly wrong."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.log = []
        self.role = Role(
            "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
        )

    def test_a_week_that_loads_models_does_not_use_the_memo(self):
        """What a hook built is not in the key and could not be, so a binding
        chosen with one model must not be replayed against another."""

        from cogbench import memo

        (self.tmp / "theirs.py").write_text(REPO)
        for _ in range(2):
            submission = resolve(
                self.tmp, chain_role=self.role, fixture=([1],),
                accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
                arrangements=None, remember=True, benchmark="models",
                construct=_week(self.log),
            )
            self.addCleanup(submission.close)
            self.assertTrue(submission.ready, submission.verdict.headline)
            self.assertFalse(submission.recalled)
        self.assertFalse(memo.cache_path(self.tmp).exists())

    def test_a_data_only_week_still_remembers(self):
        from cogbench import memo

        (self.tmp / "theirs.py").write_text(REPO)
        for expected in (False, True):
            submission = resolve(
                self.tmp, chain_role=self.role, fixture=([1],),
                accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
                arrangements=None, remember=True, benchmark="data-only",
            )
            self.addCleanup(submission.close)
            self.assertEqual(submission.recalled, expected)
        self.assertTrue(memo.cache_path(self.tmp).exists())

    def test_a_lazy_import_is_reported_before_the_reading_is_let_go(self):
        """A file one of their functions imports while it runs is why a key
        would be unsafe. Dropping the reading first loses the only record."""

        package = self.tmp / "a" / "b"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("")
        (package / "late.py").write_text("BY = 3\n")
        (self.tmp / "theirs.py").write_text(
            "def scale(rows):\n"
            "    from a.b.late import BY\n"
            "    return [r * BY for r in rows]\n"
        )
        seen = set()
        project = Project(self.tmp, discover(self.tmp), observed=seen)
        step = project.rebind(
            next(
                c for c in __import__(
                    "cogbench.pipeline", fromlist=["callables_in"]
                ).callables_in(project.found.namespace)
                if c.label.endswith(".scale")
            )
        )
        self.assertEqual(step.bound([1]), [3])
        before = len(seen)

        project.close()

        # The late import is in the inventory, and it got there on the way out.
        self.assertTrue(
            any(str(path).endswith("late.py") for path in seen), sorted(seen)
        )
        self.assertGreaterEqual(len(seen), before)

    def test_a_failing_run_reports_what_failed_not_what_would_not_close(self):
        """`fresh` releases the reading it just made, and a loader that also
        complains on the way out does not replace the real failure."""

        (self.tmp / "theirs.py").write_text(REPO)
        submission = resolve(
            self.tmp, chain_role=self.role, fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None, construct=_week(self.log, fails_on_exit=True),
        )
        self.addCleanup(lambda: self._quiet(submission))
        self.assertTrue(submission.ready, submission.verdict.headline)

        with patch.object(Project, "rebind", _refuses):
            with self.assertRaises(Unmapped) as caught:
                submission.fresh()

        # The mapping failure, not the loader's parting complaint.
        self.assertEqual(caught.exception.reason, "file_missing")

    @staticmethod
    def _quiet(submission):
        try:
            submission.close()
        except CleanupFailed:
            pass


def _refuses(self, candidate, finish=None):
    raise Unmapped("file_missing", candidate.label, "not on this reading")


class ASpecCarriesBothHooks(unittest.TestCase):
    """`DiscoverySpec` is the type a plugin actually imports and constructs.

    The real Week 3 plugin does `from cogbench.discovery_spec import
    DiscoverySpec` and builds one with `prepare`; the two hooks sit beside
    each other because they produce different kinds of thing, and only one of
    them can be copied.
    """

    def test_it_is_importable_by_the_name_a_plugin_uses(self):
        module = __import__("cogbench.discovery_spec", fromlist=["DiscoverySpec"])
        # The real package path, not a file loaded from somewhere convenient.
        self.assertEqual(module.__name__, "cogbench.discovery_spec")
        self.assertEqual(
            Path(module.__file__).parts[-2:], ("cogbench", "discovery_spec.py")
        )
        self.assertEqual(module.DiscoverySpec.__module__, "cogbench.discovery_spec")

    def test_a_data_only_plugin_constructs_exactly_as_before(self):
        from cogbench.discovery_spec import DiscoverySpec

        spec = DiscoverySpec(
            chain_role=Role("search", (Stage("one"),)),
            fixture=([1],),
            accepts=lambda *_: (True, ""),
            arrangements=lambda *_: (),
            prepare=lambda root, modules: {},
        )

        self.assertIsNone(spec.construct)

    def test_a_week_that_loads_models_declares_construct(self):
        from cogbench.discovery_spec import DiscoverySpec

        hook = _week([])
        spec = DiscoverySpec(
            chain_role=Role("search", (Stage("one"),)),
            fixture=([1],),
            accepts=lambda *_: (True, ""),
            arrangements=lambda *_: (),
            construct=hook,
        )

        self.assertIs(spec.construct, hook)

    def test_from_spec_forwards_both_hooks(self):
        from cogbench.discovery_spec import DiscoverySpec
        from cogbench.resolve import from_spec

        tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "theirs.py").write_text(REPO)
        log = []
        spec = DiscoverySpec(
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
            construct=_week(log),
        )

        submission = from_spec(tmp, spec)
        self.addCleanup(submission.close)

        self.assertTrue(submission.ready, submission.verdict.headline)
        # Reached the resolver rather than being dropped on the way.
        self.assertGreater(log.count("enter"), 0)
        self.assertEqual(log.count("enter") - log.count("exit"), 1)


class AHookThatYieldsTheWrongThingSaysSo(unittest.TestCase):
    """Three escapes, each proved by running them on Python 3.8 before this
    existed: yielding None left as `'NoneType' object is not iterable` from
    the argument builder, and a non-string name left as `keywords must be
    strings` from the call. Neither named the hook."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)
        self.role = Role(
            "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
        )

    def _resolve(self, yields):
        @contextlib.contextmanager
        def construct(root, namespace, inputs):
            yield yields

        return resolve(
            self.tmp, chain_role=self.role, fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None, construct=construct,
        )

    def test_yielding_nothing_is_named_as_the_hooks_contract(self):
        submission = self._resolve(None)

        self.assertFalse(submission.ready)
        self.assertIn("hook_contract", submission.verdict.headline)
        self.assertIn("must yield a mapping", submission.verdict.headline)
        self.assertNotIn("NoneType", submission.verdict.headline)

    def test_a_name_that_is_not_a_name_is_named(self):
        submission = self._resolve({1: object()})

        self.assertFalse(submission.ready)
        self.assertIn("hook_contract", submission.verdict.headline)
        self.assertIn("names must be strings", submission.verdict.headline)

    def test_a_mapping_that_will_not_be_read_is_contained(self):
        # Not a `dict` subclass: `dict(...)` takes the C fast path for those
        # and never calls the overridden `keys`.
        from collections.abc import Mapping as _Mapping

        class Refuses(_Mapping):
            def __getitem__(self, key):
                raise KeyError(key)

            def __iter__(self):
                raise RuntimeError("their mapping broke")

            def __len__(self):
                return 1

        submission = self._resolve(Refuses())

        self.assertFalse(submission.ready)
        self.assertIn("hook_contract", submission.verdict.headline)

    def test_something_that_is_not_a_mapping_at_all_is_named(self):
        submission = self._resolve(["weights"])

        self.assertFalse(submission.ready)
        self.assertIn("hook_contract", submission.verdict.headline)
        self.assertIn("list", submission.verdict.headline)


class ABodyThatFailedKeepsItsOwnFailure(unittest.TestCase):
    """`with submission:` whose body raises, and whose loader also raises on
    the way out. The body's failure is what leaves; the loader's is recorded
    on it rather than replacing it."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)
        self.log = []

    def _resolve(self):
        return resolve(
            self.tmp,
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
            construct=_week(self.log, fails_on_exit=True),
        )

    def test_the_bodys_error_leaves_and_carries_the_cleanup(self):
        submission = self._resolve()

        with self.assertRaises(RuntimeError) as caught:
            with submission:
                raise RuntimeError("what the caller came for")

        self.assertEqual(str(caught.exception), "what the caller came for")
        self.assertTrue(
            any("would not let go" in line
                for line in getattr(caught.exception, "cogbench_cleanup", ())),
            getattr(caught.exception, "cogbench_cleanup", ()),
        )

    def test_an_explicit_close_with_nothing_in_flight_still_raises(self):
        submission = self._resolve()

        with self.assertRaises(CleanupFailed):
            submission.close()

    def test_a_project_exit_keeps_the_bodys_failure_too(self):
        project = Project(self.tmp, discover(self.tmp))

        with self.assertRaises(RuntimeError) as caught:
            with project:
                project.models(_week(self.log, fails_on_exit=True), {})
                raise RuntimeError("the body")

        self.assertEqual(str(caught.exception), "the body")
        self.assertTrue(project.closed)


class EveryRefusalCarriesWhatCouldNotBeReleased(unittest.TestCase):
    """Six refusal returns used not to carry it, and the exit stack ran after
    the return value was built. Written against the default `Progress`, whose
    `note` does nothing."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.log = []

    def test_a_refusal_still_reports_the_loader_that_would_not_let_go(self):
        # Their chain cannot bind, so this returns a refusal rather than a run.
        (self.tmp / "theirs.py").write_text("def unrelated(x, y, z):\n    return x\n")

        submission = resolve(
            self.tmp,
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
            construct=_week(self.log, fails_on_exit=True),
        )

        self.assertFalse(submission.ready)
        self.assertTrue(submission.cleanup, "a refusal dropped it")
        self.assertTrue(
            any("would not let go" in line for line in submission.cleanup),
            submission.cleanup,
        )
        self.assertEqual(submission.to_dict()["cleanup"], list(submission.cleanup))

    def test_a_failure_only_on_the_searchs_own_way_out_is_still_recorded(self):
        """Every trial and the returned run close cleanly; only the search's
        own block raises. That failure happens last, after the return value
        would have been built."""

        (self.tmp / "theirs.py").write_text(REPO)
        opened_blocks = []

        @contextlib.contextmanager
        def construct(root, namespace, inputs):
            mine = len(opened_blocks)
            opened_blocks.append(mine)
            try:
                yield {"weights": object()}
            finally:
                if mine == 0:
                    raise ValueError("only the search's block would not let go")

        submission = resolve(
            self.tmp,
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None, construct=construct,
        )
        self.addCleanup(submission.close)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertTrue(
            any("only the search's block" in line for line in submission.cleanup),
            submission.cleanup,
        )


class TheStorageModuleDefinesEachNameOnce(unittest.TestCase):
    """The capture port appended a copy of six functions that already existed,
    and the second copy won. Five of them were byte-identical, so nothing
    changed; `latest_report` was not, and its copy dropped every guard."""

    def _source(self):
        import inspect

        from cogbench import storage

        return inspect.getsource(storage), storage

    def test_no_function_is_defined_twice(self):
        import re

        text, _ = self._source()
        names = re.findall(r"^def (\w+)", text, re.M)
        twice = sorted({name for name in names if names.count(name) > 1})

        self.assertEqual(twice, [])

    def test_latest_report_keeps_all_four_of_its_guards(self):
        import inspect

        _, storage = self._source()
        body = inspect.getsource(storage.latest_report)

        # A linked checkout is refused by `reports_dir` and read as "none".
        self.assertIn("except OSError", body)
        # A file called `reports` is not a directory to glob.
        self.assertIn("is_dir()", body)
        # A planted link is not followed, and a directory is not a report.
        self.assertIn("is_symlink()", body)
        self.assertIn("is_file()", body)

    def test_a_symlinked_or_nonfile_report_is_not_chosen(self):
        from cogbench import storage

        tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        reports = tmp / ".cogbench" / "reports"
        reports.mkdir(parents=True)
        real = reports / "local_real.json"
        real.write_text("{}")
        # Newer than the real one, so an unguarded sort would pick each.
        (reports / "local_dir.json").mkdir()
        elsewhere = tmp / "outside.json"
        elsewhere.write_text("{}")
        (reports / "local_link.json").symlink_to(elsewhere)

        self.assertEqual(storage.latest_report(tmp), real)


class OnlyTheWeekCanSayItsBindingReadTheWeights(unittest.TestCase):
    """Retention copies bytes; only the week knows whether the binding the
    search chose read them."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)
        self.weights = self.tmp / "w.npy"
        self.weights.write_bytes(b"trained")
        self.role = Role(
            "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
        )

    def _prepare(self, root, modules, capture=None):
        capture(root / "w.npy")
        return {}

    def _names_only(self, root, modules):
        """No `capture` parameter, so nothing is offered one: this is the
        older shape of the hook, which names what it read."""

        return {"weights_used": ["w.npy"]}

    def _names(self, *declared):
        def prepare(root, modules):
            return {"weights_used": list(declared)}
        return prepare

    def _resolve(self, **changes):
        arguments = dict(
            chain_role=self.role, fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None, prepare=self._prepare,
        )
        arguments.update(changes)
        submission = resolve(self.tmp, **arguments)
        self.addCleanup(submission.close)
        return submission

    def test_a_week_that_does_not_answer_publishes_no_receipt(self):
        submission = self._resolve()

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.weights_used, ("w.npy",))
        self.assertIsNone(submission.weights_captured)
        self.assertIsNone(submission.to_dict()["weightsCaptured"])

    def test_a_week_that_answers_yes_publishes_them(self):
        submission = self._resolve(weights_consumed=lambda made: True)

        self.assertTrue(submission.weights_captured)
        self.assertEqual(
            [item["path"] for item in submission.weights_captured], ["w.npy"]
        )
        self.assertEqual(submission.weights_captured[0]["size"], len(b"trained"))

    def test_what_the_hook_returned_comes_back_on_the_run(self):
        """The week reads its own answer back off the submission.

        A plugin resolving several repositories in turn cannot keep what it
        read about one of them on itself: week 3 reports which weights file it
        chose and why the image side is unmeasured, and the next repository
        read would describe the first one's run. Only the run knows.
        """

        def prepare(root, modules, capture=None):
            return {"weights_report": {"path": "w.npy"}}

        submission = self._resolve(prepare=prepare)

        self.assertEqual(submission.prepared, {"weights_report": {"path": "w.npy"}})
        # And it survives another run of the same binding, which is when a
        # week is scoring it.
        run = submission.fresh()
        self.addCleanup(run.close)
        self.assertEqual(run.prepared, submission.prepared)

    def test_a_week_that_declares_nothing_prepared_carries_nothing(self):
        submission = self._resolve(prepare=None)

        self.assertEqual(submission.prepared, {})

    def test_a_week_that_answers_no_keeps_the_names_only(self):
        submission = self._resolve(weights_consumed=lambda made: False)

        self.assertEqual(submission.weights_used, ("w.npy",))
        self.assertIsNone(submission.weights_captured)

    def test_a_hook_that_raises_is_not_a_failed_score(self):
        """A week's hook must not cost a repository its run. It also must not
        publish on the strength of an answer nobody got."""

        def explodes(made):
            raise RuntimeError("the week's hook broke")

        submission = self._resolve(weights_consumed=explodes)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertIsNone(submission.weights_captured)

    def test_a_run_with_no_weights_stays_empty_not_unknown(self):
        """`()` and `None` are different answers and must not collapse."""

        submission = resolve(
            self.tmp, chain_role=self.role, fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None, weights_consumed=lambda made: True,
        )
        self.addCleanup(submission.close)

        self.assertEqual(submission.weights_used, ())
        self.assertEqual(submission.weights_captured, ())
        self.assertEqual(submission.to_dict()["weightsCaptured"], [])

    def test_the_hook_is_handed_the_run_the_caller_gets(self):
        """Labels and cleanup match on the pre-`fresh` submission too, so
        identity is the only assertion that distinguishes them."""

        seen = []

        def remember(made):
            seen.append(made)
            return True

        submission = self._resolve(weights_consumed=remember)

        self.assertEqual(len(seen), 1)
        self.assertIs(seen[0], submission)
        self.assertIs(seen[0].chain[0].call, submission.chain[0].call)

    def test_a_replayed_binding_is_asked_the_same_question(self):
        self.assertFalse(
            self._resolve(remember=True, benchmark="consumed",
                          weights_consumed=lambda made: True).recalled
        )

        second = self._resolve(remember=True, benchmark="consumed",
                               weights_consumed=lambda made: True)

        self.assertTrue(second.recalled, second.verdict.headline)
        # This run's retention, not the stored binding's: the memo carries no
        # receipts and what `prepare` just retained is what this run scored.
        self.assertEqual(second.weights_used, ("w.npy",))
        self.assertEqual(
            [item["path"] for item in second.weights_captured], ["w.npy"]
        )

    def test_a_replay_whose_week_cannot_vouch_publishes_nothing(self):
        self.assertFalse(self._resolve(remember=True, benchmark="quiet").recalled)

        second = self._resolve(remember=True, benchmark="quiet")

        self.assertTrue(second.recalled, second.verdict.headline)
        self.assertEqual(second.weights_used, ("w.npy",))
        self.assertIsNone(second.weights_captured)

    def test_naming_weights_without_capturing_them_still_scores(self):
        """The older contract: a week may name what it loaded without handing
        the bytes over. That used to be refused outright."""

        submission = self._resolve(prepare=self._names_only)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.weights_used, ("w.npy",))
        self.assertIsNone(submission.weights_captured)
        self.assertIsNone(submission.to_dict()["weightsCaptured"])

    def test_named_weights_are_sorted_project_relative_names(self):
        (self.tmp / "nested").mkdir()
        (self.tmp / "nested" / "b.npy").write_bytes(b"second")

        submission = self._resolve(prepare=self._names(
            "nested/b.npy", "./w.npy",
        ))

        self.assertEqual(submission.weights_used, ("nested/b.npy", "w.npy"))

    def test_a_named_weight_outside_the_project_is_refused(self):
        """Uncaptured names go through the same path check as captured ones,
        so a report cannot describe a file the repository does not hold."""

        outside = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, str(outside), ignore_errors=True)
        (outside / "elsewhere.npy").write_bytes(b"trained")
        escape = os.path.join(
            os.path.relpath(str(outside), str(self.tmp)), "elsewhere.npy"
        )

        submission = self._resolve(prepare=self._names(escape))

        self.assertFalse(submission.ready)
        self.assertIn("RetentionError", submission.verdict.headline)
        self.assertIn("outside the project", submission.verdict.headline)
        self.assertEqual(submission.weights_used, ())
        self.assertEqual(submission.weights_captured, ())

    def test_a_week_cannot_vouch_for_weights_it_never_handed_over(self):
        """`True` is honoured only where retention produced receipts."""

        submission = self._resolve(prepare=self._names_only,
                                   weights_consumed=lambda made: True)

        self.assertEqual(submission.weights_used, ("w.npy",))
        self.assertIsNone(submission.weights_captured)

    def test_a_named_weight_is_replayed_only_while_it_is_unchanged(self):
        """Named weights join the memo key by name and by bytes, so a
        retrained file is rescored rather than answered from the cache."""

        def run():
            return self._resolve(remember=True, benchmark="named",
                                 prepare=self._names_only)

        self.assertFalse(run().recalled)
        again = run()
        self.assertTrue(again.recalled, again.verdict.headline)
        self.assertEqual(again.weights_used, ("w.npy",))
        self.assertIsNone(again.weights_captured)

        self.weights.write_bytes(b"retrained, and longer than before")
        self.assertFalse(run().recalled)

    def test_renaming_the_weight_it_names_is_not_a_replay(self):
        (self.tmp / "later.npy").write_bytes(b"a different file")
        self.assertFalse(
            self._resolve(remember=True, benchmark="renamed",
                          prepare=self._names_only).recalled
        )

        second = self._resolve(remember=True, benchmark="renamed",
                               prepare=self._names("later.npy"))

        self.assertFalse(second.recalled)
        self.assertEqual(second.weights_used, ("later.npy",))
        self.assertIsNone(second.weights_captured)

    def test_capturing_and_naming_them_both_is_refused(self):
        """Two answers to one question. Refused rather than reconciled."""

        def both(root, modules, capture=None):
            capture(root / "w.npy")
            return {"weights_used": ["w.npy"]}

        submission = self._resolve(prepare=both)

        self.assertFalse(submission.ready)
        self.assertIn("both captures", submission.verdict.headline)

    def test_from_spec_forwards_the_hook(self):
        spec = DiscoverySpec(
            chain_role=self.role,
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
            prepare=self._prepare,
            weights_consumed=lambda made: True,
        )

        submission = from_spec(self.tmp, spec)
        self.addCleanup(submission.close)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(
            [item["path"] for item in submission.weights_captured], ["w.npy"]
        )


class _Projection:
    """A trained projection a `prepare` hook loaded, in place of an array.

    `prepare` is data-only; a week that needs a loaded object of their class
    declares `construct` instead. This stands for week 3's matrix, because
    the question here is identity rather than arithmetic.
    """

    def __init__(self, rows):
        self.rows = rows


class TheReportAPrepareHookReturnsBelongsToTheRunItWasReadFor(unittest.TestCase):
    """A plugin prepares one repository after another, and week 3's hook is a
    method on that plugin.

    A hook that fills a nested dictionary it keeps between calls used to hand
    the same dictionary to every run, so the first run's report said what the
    second repository had found. The containers on `Submission.prepared` are
    the run's own; what is inside them is still the week's, because a matrix
    or a model in there is not ours to copy.
    """

    def setUp(self):
        self.made = []
        self.role = Role(
            "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
        )

    def _repository(self):
        tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "theirs.py").write_text(REPO)
        return tmp

    def _resolve(self, prepare, repository=None, accepts=None):
        submission = resolve(
            repository or self._repository(),
            chain_role=self.role,
            fixture=([1],),
            accepts=accepts or (lambda chain, *_: (chain[0].bound([1]) == [3], "")),
            arrangements=None,
            prepare=prepare,
        )
        self.addCleanup(submission.close)
        return submission

    def _a_plugin_that_reuses_its_report(self):
        """The shape that caused this: one report dictionary, filled again."""

        report = {}

        def prepare(root, modules):
            report["path"] = root.name + ".pkl"
            return {"weights_report": report}

        return prepare

    def test_preparing_the_next_repository_leaves_the_first_report_alone(self):
        prepare = self._a_plugin_that_reuses_its_report()
        first = self._resolve(prepare)
        was = dict(first.prepared["weights_report"])

        second = self._resolve(prepare)

        self.assertEqual(first.prepared["weights_report"], was)
        self.assertNotEqual(
            first.prepared["weights_report"], second.prepared["weights_report"]
        )

    def test_a_refused_run_reports_what_was_prepared_for_it(self):
        """A repository that binds nothing still carries its own report: the
        week wrote that report before anything of theirs was tried."""

        prepare = self._a_plugin_that_reuses_its_report()
        refused = self._resolve(
            prepare, accepts=lambda chain, *_: (False, "not this one")
        )
        was = dict(refused.prepared["weights_report"])

        self._resolve(prepare)

        self.assertFalse(refused.ready)
        self.assertEqual(refused.prepared["weights_report"], was)

    def test_a_repository_with_no_code_at_all_still_carries_its_report(self):
        """The one return that used to skip the common exit.

        A team may commit their weights before any of their code. The hook has
        already run and already said which file it chose, so the run page can
        say so instead of reporting an empty repository and nothing else.
        """

        empty = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, empty, ignore_errors=True)
        prepare = self._a_plugin_that_reuses_its_report()

        nothing = self._resolve(prepare, repository=empty)

        self.assertFalse(nothing.ready)
        self.assertEqual(
            nothing.prepared["weights_report"], {"path": empty.name + ".pkl"}
        )

    def test_another_run_of_the_binding_reports_the_same_thing(self):
        prepare = self._a_plugin_that_reuses_its_report()
        submission = self._resolve(prepare)

        run = submission.fresh()
        self.addCleanup(run.close)
        self._resolve(prepare)

        self.assertIs(run.prepared, submission.prepared)
        self.assertEqual(
            run.prepared["weights_report"], submission.prepared["weights_report"]
        )

    def test_two_names_that_shared_one_table_still_share_it(self):
        shared = {"rows": [1, 2]}

        submission = self._resolve(
            lambda root, modules: {"table": shared, "same_table": shared}
        )

        self.assertIs(
            submission.prepared["table"], submission.prepared["same_table"]
        )
        self.assertIsNot(submission.prepared["table"], shared)

    def test_what_the_week_read_is_the_object_it_read(self):
        """Only the containers are taken. The trained projection week 3 loads
        off the chosen root is the week's own object, and a copy of it would
        be a second matrix."""

        matrix = _Projection([[1.0, 0.0], [0.0, 1.0]])

        submission = self._resolve(
            lambda root, modules: {"W": matrix, "of": [matrix]}
        )

        self.assertIs(submission.prepared["W"], matrix)
        self.assertIs(submission.prepared["of"][0], matrix)

    def test_a_tuple_reached_again_through_what_it_holds_is_one_tuple(self):
        """A pair that names the rows it came from, with the rows pointing
        back at the pair. Copied a tuple at a time, the back-reference became
        a second pair naming the same rows."""

        rows = []
        pair = (rows,)
        rows.append(pair)

        submission = self._resolve(lambda root, modules: {"loop": pair})

        taken = submission.prepared["loop"]
        self.assertIsNot(taken, pair)
        self.assertIs(taken[0][0], taken)

    def test_an_answer_that_holds_itself_holds_the_one_that_was_taken(self):
        """A hook whose report names the whole report. Copied at the top level
        first, the run's copy pointed back at the week's original."""

        answer = {}
        answer["all"] = answer

        submission = self._resolve(lambda root, modules: answer)

        taken = submission.prepared
        self.assertIsNot(taken, answer)
        self.assertIs(taken["all"], taken)


#: A team who wrote their pipeline over a directory rather than over arguments.
#: The constructor reads the folder, which is what lets the search find out
#: that it reads one, and a method reached off it reads the same folder again
#: later, which is where a scored run used to go wrong.
FOLDER_REPO = '''
import os


class Album:
    def __init__(self):
        self.where = "baseImages"
        self.count = len(os.listdir(self.where))

    def names(self):
        return sorted(os.listdir(self.where))
'''

FOLDER_ROLE = Role(
    "cluster",
    (
        Stage("make", produces=lambda v: hasattr(v, "names"), folder=True),
        Stage("read", produces=lambda v: isinstance(v, list) and len(v) == 2),
    ),
)


class _AFolder(unittest.TestCase):
    """A repository read over a folder, and a decoy folder beside the caller.

    The decoy is the whole point. A step bound over a folder takes no
    arguments, so nothing about the call says where to read; before this run
    owned a directory, `baseImages` meant whatever the caller happened to be
    standing next to, and a run scored that instead.
    """

    SOURCE = FOLDER_REPO

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        (self.repo / "theirs.py").write_text(self.SOURCE)
        self.A = self._photos("a", ["one.png", "two.png"])
        self.B = self._photos("b", ["three.png", "four.png"])
        self.caller = self.tmp / "caller"
        (self.caller / "baseImages").mkdir(parents=True)
        (self.caller / "baseImages" / "decoy.png").write_bytes(b"not ours")
        previous = os.getcwd()
        os.chdir(self.caller)
        self.addCleanup(os.chdir, previous)

    def _photos(self, where, names):
        made = []
        directory = self.tmp / where
        directory.mkdir(parents=True, exist_ok=True)
        for name in names:
            path = directory / name
            path.write_bytes(b"pretend photo")
            made.append(path)
        return made

    def _spec(self, **overrides):
        settings = dict(
            chain_role=FOLDER_ROLE,
            fixture=(self.A,),
            accepts=lambda chain, *_: (
                chain[1].bound(chain[0].bound(self.A)) == ["one.png", "two.png"], ""
            ),
            arrangements=None,
        )
        settings.update(overrides)
        return DiscoverySpec(**settings)

    def _resolved(self, **overrides):
        submission = from_spec(self.repo, self._spec(**overrides))
        self.addCleanup(self._quietly, submission.close)
        return submission

    @staticmethod
    def _quietly(close):
        try:
            close()
        except (CleanupFailed, Closed):
            pass


class AFolderReaderIsHandedThisRunsOwnFiles(_AFolder):
    """What a scored run does with a binding the search made over a folder.

    Every one of these failed before this change. The search recorded the name
    their code asked for and nothing put anything there afterwards, so the
    first call of a scored run raised `FileNotFoundError`, or, beside a folder
    of that name it did not own, returned that folder's contents and reported
    success.
    """

    def test_the_binding_records_the_name_their_code_asked_for(self):
        submission = self._resolved()

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.chain[0].supplied["folder"], "baseImages")

    def test_the_constructor_reads_this_calls_files_and_not_the_decoy(self):
        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        made = run.chain[0].bound(self.A)

        self.assertEqual(made.count, 2)
        self.assertEqual(run.chain[1].bound(made), ["one.png", "two.png"])

    def test_a_method_reached_later_reads_the_same_folder_the_constructor_did(self):
        """`names()` runs after the constructor returned, on a call of its own.

        A directory made for the length of one call would be gone by then, so
        the reading owns it rather than the call.
        """

        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        made = run.chain[0].bound(self.B)

        self.assertEqual(run.chain[1].bound(made), ["four.png", "three.png"])

    def test_two_runs_of_one_binding_read_their_own_files(self):
        submission = self._resolved()
        one, two = submission.fresh(), submission.fresh()
        self.addCleanup(self._quietly, one.close)
        self.addCleanup(self._quietly, two.close)

        first = one.chain[1].bound(one.chain[0].bound(self.A))
        second = two.chain[1].bound(two.chain[0].bound(self.B))

        self.assertEqual(first, ["one.png", "two.png"])
        self.assertEqual(second, ["four.png", "three.png"])
        self.assertNotEqual(one._owned._home, two._owned._home)

    def test_a_second_call_replaces_the_first_calls_files(self):
        """Their code lists the folder and counts what is in it, so a file the
        last call left behind is an extra photo in this call's answer."""

        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        run.chain[0].bound(self.A)
        made = run.chain[0].bound(self.B)

        self.assertEqual(made.count, 2)
        self.assertEqual(run.chain[1].bound(made), ["four.png", "three.png"])

    def test_the_caller_is_left_standing_where_it_was(self):
        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        run.chain[1].bound(run.chain[0].bound(self.A))

        self.assertEqual(Path(os.getcwd()).resolve(), self.caller.resolve())


class AFolderStepSaysWhatItCouldNotBeGiven(_AFolder):
    """The refusals name the input, because that is what the caller can fix."""

    def test_a_call_handed_no_files_refuses_rather_than_reading_whatever_is_there(self):
        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        with self.assertRaises(Unmapped) as caught:
            run.chain[0].bound([])

        self.assertEqual(caught.exception.reason, "benchmark_inputs")
        self.assertIn("handed it none", caught.exception.detail)

    def test_two_files_of_one_name_refuse_rather_than_one_overwriting_the_other(self):
        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        with self.assertRaises(Unmapped) as caught:
            run.chain[0].bound([self.A[0], self.A[0]])

        self.assertEqual(caught.exception.reason, "benchmark_inputs")
        self.assertIn("both called one.png", caught.exception.detail)

    def test_a_photo_that_is_not_there_refuses_and_names_it(self):
        """Discovery's `_files_in` drops what is not a file, which is right for
        a probe deciding whether a fixture is paths at all. Reusing it here
        furnished the one photo that existed and ran their code over a batch
        of one, and the answer was scored."""

        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)
        missing = self.tmp / "a" / "gone.png"

        with self.assertRaises(Unmapped) as caught:
            run.chain[0].bound([self.A[0], missing])

        self.assertEqual(caught.exception.reason, "benchmark_inputs")
        self.assertIn(str(missing), caught.exception.detail)

    def test_something_that_is_not_a_sequence_of_paths_refuses(self):
        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        with self.assertRaises(Unmapped) as caught:
            run.chain[0].bound([self.A[0], 17])

        self.assertEqual(caught.exception.reason, "benchmark_inputs")
        self.assertIn("17", caught.exception.detail)

    def test_a_refused_replacement_leaves_the_last_call_standing(self):
        """The folder is theirs to read between calls, so a call that refuses
        must not have emptied it on the way to refusing."""

        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)
        made = run.chain[0].bound(self.A)

        with self.assertRaises(Unmapped):
            run.chain[0].bound([self.B[0], self.tmp / "b" / "gone.png"])

        self.assertEqual(run.chain[1].bound(made), ["one.png", "two.png"])

    def test_a_photo_named_relative_to_the_caller_is_found(self):
        """`furnish` runs before the working directory changes, so a relative
        path still means what the caller meant by it."""

        (self.caller / "here.png").write_bytes(b"pretend photo")
        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        made = run.chain[0].bound(["here.png", self.A[0]])

        self.assertEqual(run.chain[1].bound(made), ["here.png", "one.png"])


class AFileKeepsTheNameTheBenchmarkHandedOver(_AFolder):
    """A benchmark whose corpus is links into a cache hands over the name it
    chose, and their code reads the name it was given.

    `Path.resolve()` follows the last component too, so the search wrote
    `one.png` into the folder and a scored run wrote the link's target name
    instead. A week whose right answer is the name it handed over then read a
    file it had never named, and the run was reported as wired and wrong.
    """

    def setUp(self):
        super().setUp()
        target = self.tmp / "cache" / "0f3a.png"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"pretend photo")
        self.linked = self.tmp / "a" / "student-one.png"
        self.linked.symlink_to(target)

    def test_the_search_and_a_fresh_run_put_the_same_name_in_the_folder(self):
        handed = [self.linked, self.A[1]]
        submission = self._resolved(
            fixture=(handed,),
            accepts=lambda chain, *_: (
                chain[1].bound(chain[0].bound(handed))
                == ["student-one.png", "two.png"], ""
            ),
        )
        self.assertTrue(submission.ready, submission.verdict.headline)
        run = submission.fresh()
        self.addCleanup(self._quietly, run.close)

        made = run.chain[0].bound(handed)

        self.assertEqual(
            run.chain[1].bound(made), ["student-one.png", "two.png"]
        )


class ARunsOwnFolderGoesWhenTheRunDoes(_AFolder):
    """The directory belongs to the reading, so it lasts exactly as long."""

    def test_the_directory_is_gone_after_a_run_that_worked(self):
        run = self._resolved().fresh()
        run.chain[1].bound(run.chain[0].bound(self.A))
        home = run._owned._home

        run.close()

        self.assertIsNotNone(home)
        self.assertFalse(home.exists())

    def test_a_closed_run_refuses_rather_than_reading_from_nowhere(self):
        run = self._resolved().fresh()
        run.chain[0].bound(self.A)

        run.close()

        with self.assertRaises(Closed):
            run.chain[0].bound(self.A)

    def test_a_loader_that_would_not_let_go_still_loses_the_directory(self):
        """Their `__exit__` raising is reported, and is not a reason to leave a
        folder of the benchmark's photos on the disk."""

        log = []
        run = self._resolved(construct=_week(log, fails_on_exit=True)).fresh()
        run.chain[0].bound(self.A)
        home = run._owned._home

        with self.assertRaises(CleanupFailed) as caught:
            run.close()

        self.assertIn("their model loader raised", str(caught.exception))
        self.assertIsNotNone(home)
        self.assertFalse(home.exists())

    def test_a_run_that_refused_still_gives_its_directory_back(self):
        run = self._resolved().fresh()
        home = run._owned._home
        with self.assertRaises(Unmapped):
            run.chain[0].bound([])

        run.close()

        self.assertIsNotNone(home)
        self.assertFalse(home.exists())

    def test_the_directory_exists_before_their_model_is_built(self):
        """A loader may read a relative path of its own, and a fit stage runs
        before the chain does, so the directory cannot wait for the first
        call."""

        seen = []

        @contextlib.contextmanager
        def watches_where_it_is(root, namespace, inputs):
            seen.append(Path(os.getcwd()).resolve())
            yield {}

        run = self._resolved(construct=watches_where_it_is).fresh()
        self.addCleanup(self._quietly, run.close)

        self.assertEqual(seen[-1], run._owned._home)


class AReaderThatAlsoReadsItsOwnThingsStillBinds(_AFolder):
    """External weight-file opens remain allowed alongside the input listing."""

    SOURCE = '''
import os
from pathlib import Path


class Album:
    def __init__(self):
        self.where = "baseImages"
        self.count = len(os.listdir(self.where))
        self.weights = (Path(__file__).resolve().parent / "models" / "facenet.pt").read_bytes()

    def names(self):
        (Path(__file__).resolve().parent / "models" / "facenet.pt").read_bytes()
        return sorted(os.listdir(self.where))
'''

    def setUp(self):
        super().setUp()
        (self.repo / "models").mkdir()
        (self.repo / "models" / "facenet.pt").write_bytes(b"weights")

    def test_it_binds_and_a_fresh_run_reads_this_runs_files(self):
        submission = self._resolved()
        self.assertTrue(submission.ready, submission.verdict.headline)
        run = submission.fresh()
        self.addCleanup(self._quietly, run.close)

        made = run.chain[0].bound(self.B)

        self.assertEqual(run.chain[1].bound(made), ["four.png", "three.png"])
        self.assertEqual(made.weights, b"weights")


class ARememberedAnswerEarnsNoClaimAboutTheInput(_AFolder):
    """An observed listing does not prove the answer depends on those files.

    The retry lists the supplied directory but returns remembered names. The
    week's acceptance test owns the answer; discovery only establishes access.
    """

    SOURCE = '''
import os

_tried = []


class Album:
    def __init__(self):
        if not _tried:
            _tried.append(1)
            self.remembered = sorted(os.listdir("baseImages"))
        else:
            os.listdir("baseImages")
            self.remembered = ["remembered.png", "remembered-too.png"]

    def names(self):
        return list(self.remembered)
'''

    def test_the_record_says_only_which_folder_was_pointed_at_our_files(self):
        submission = self._resolved()

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(
            dict(submission.chain[0].supplied), {"folder": "baseImages"}
        )

    def test_a_fresh_reading_starts_their_state_over_so_the_first_call_is_real(self):
        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        self.assertEqual(
            run.chain[1].bound(run.chain[0].bound(self.B)),
            ["four.png", "three.png"],
        )

    def test_a_week_that_asks_twice_refuses_the_remembered_answer(self):
        """What settles it is the week's own test, so a week whose test changes
        the input between calls sees the remembered list for what it is. The
        record says which folder was pointed at our files and nothing about
        where the answer came from; this is the part that does."""

        def asks_twice(chain, *_):
            chain[1].bound(chain[0].bound(self.A))
            second = chain[1].bound(chain[0].bound(self.B))
            return second == ["four.png", "three.png"], ""

        submission = self._resolved(accepts=asks_twice)

        self.assertFalse(submission.ready)

    def test_a_second_call_on_one_run_is_still_their_stateful_class(self):
        """Not a defect to detect here. Their object remembers, the folder on
        disk holds this call's files either way, and nothing in the record
        claims the two agree."""

        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        run.chain[0].bound(self.A)
        made = run.chain[0].bound(self.B)

        self.assertEqual(
            run.chain[1].bound(made), ["remembered.png", "remembered-too.png"]
        )
        self.assertEqual(
            sorted(p.name for p in (run._owned._home / "baseImages").iterdir()),
            ["four.png", "three.png"],
        )


class AFolderBindingIsNotRememberedBetweenRuns(_AFolder):
    """`_remembered` has no field for the folder name a step was bound over.

    A replayed entry would call the step with no arguments and put nothing
    where its code looks, so it would read whatever the caller is standing
    next to, which here is a folder called `baseImages` holding one file that
    is not ours. A wrong answer that looks right is worse than searching
    again, so a week that offers a folder does not use the memo, the way a
    week that loads models does not.
    """

    def _named(self, files):
        """The fixture as strings.

        `memo._inputs` hashes exact builtins and refuses a `Path`, so a week
        that hands its photos over as `Path` objects has no key at all and
        this would prove nothing. A week may perfectly well hand them over as
        strings, and then the only thing left stopping the write is the rule
        under test.
        """

        return [str(path) for path in files]

    def test_nothing_is_written_to_the_cache_for_a_folder_week(self):
        submission = from_spec(
            self.repo,
            self._spec(
                fixture=(self._named(self.A),),
                accepts=lambda chain, *_: (
                    chain[1].bound(chain[0].bound(self._named(self.A)))
                    == ["one.png", "two.png"], ""
                ),
            ),
            remember=True,
        )
        self.addCleanup(self._quietly, submission.close)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertFalse((self.repo / ".cogbench" / "resolved.json").exists())

    def test_the_same_week_without_the_folder_stage_does_remember(self):
        """The control. Without it the test above passes for any reason at
        all, including this repository having no memo key to write."""

        plain = self.tmp / "plain"
        plain.mkdir()
        (plain / "theirs.py").write_text(REPO)
        submission = from_spec(
            plain,
            DiscoverySpec(
                chain_role=Role(
                    "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
                ),
                fixture=([1],),
                accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
                arrangements=None,
            ),
            remember=True,
        )
        self.addCleanup(self._quietly, submission.close)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertTrue((plain / ".cogbench" / "resolved.json").exists())


class TheCallersDirectoryIsLeftAloneWhenNoFolderIsRead(unittest.TestCase):
    """The owned directory is opt-in, and the thing it must not disturb is a
    week that gives each attempt a working directory of its own.

    `test_resolve.TheDatabaseIsMadeWhereTheWeeksTestRuns` is the contract for
    that. This is its other half: a binding with no folder step makes no
    directory at all, so there is nothing to stand in.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)

    def test_a_run_with_no_folder_step_owns_no_directory(self):
        submission = resolve(
            self.tmp,
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
        )
        self.addCleanup(submission.close)
        run = submission.fresh()
        self.addCleanup(run.close)

        where = Path(os.getcwd()).resolve()
        run.chain[0].bound([1])

        self.assertIsNone(run._owned._home)
        self.assertEqual(Path(os.getcwd()).resolve(), where)


class AHookThatOpensAndYieldsRubbishIsStillClosed(unittest.TestCase):
    """`opened` validated what the hook yielded before entering the block that
    exits it, so a hook that opened and then yielded a non-mapping was never
    exited.

    A hook written as a generator hid this: nothing referenced the exhausted
    generator, so the collector ran its `finally` and the exit happened
    anyway. One written as a class, which is what a team writes when the
    loader holds a file handle, was entered and left open.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)
        self.found = discover(self.tmp)

    def test_a_class_based_loader_is_exited_when_its_mapping_is_refused(self):
        log = []

        class TheirLoader:
            def __enter__(self):
                log.append("enter")
                return None

            def __exit__(self, *exc):
                log.append("exit")
                return False

        from cogbench._namespace import opened

        with self.assertRaises(Unmapped):
            with opened(lambda *a: TheirLoader(), self.found, {}, {}):
                pass

        self.assertEqual(log, ["enter", "exit"])

    def test_a_loader_that_also_raises_on_the_way_out_keeps_the_first_failure(self):
        class TheirLoader:
            def __enter__(self):
                return None

            def __exit__(self, *exc):
                raise ValueError("and it would not let go either")

        from cogbench._namespace import opened

        with self.assertRaises(Unmapped) as caught:
            with opened(lambda *a: TheirLoader(), self.found, {}, {}):
                pass

        self.assertIn("hook_contract", str(caught.exception))
        self.assertTrue(
            any("ValueError" in note
                for note in getattr(caught.exception, "cogbench_cleanup", ())),
            getattr(caught.exception, "cogbench_cleanup", ()),
        )

    def _refused(self, loader):
        return from_spec(
            self.tmp,
            DiscoverySpec(
                chain_role=Role(
                    "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
                ),
                fixture=([1],),
                accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
                arrangements=None,
                construct=lambda *a: loader,
            ),
        )

    def test_a_loader_that_releases_only_on_a_failure_is_told_there_was_one(self):
        """Through the week's own `construct`, which is the only way a team
        reaches this. A loader written the way the language documents, holding
        its handle until `__exit__` is given an exception, was handed three
        Nones and kept it."""

        log = []

        class TheirLoader:
            def __enter__(self):
                log.append("enter")
                return None

            def __exit__(self, exc_type, exc, traceback):
                if exc_type is not None:
                    log.append("released")
                return False

        submission = self._refused(TheirLoader())
        self.addCleanup(self._quietly, submission.close)

        self.assertFalse(submission.ready)
        self.assertIn("hook_contract", submission.verdict.headline)
        self.assertEqual(log, ["enter", "released"])

    def test_a_loader_that_raises_on_the_way_out_still_reaches_the_run(self):
        """Both facts travel: the hook broke its contract, and its loader
        would not let go. The refusal used to carry only the first."""

        class TheirLoader:
            def __enter__(self):
                return None

            def __exit__(self, *exc):
                raise ValueError("and it would not let go either")

        submission = self._refused(TheirLoader())
        self.addCleanup(self._quietly, submission.close)

        self.assertFalse(submission.ready)
        self.assertTrue(
            any("ValueError" in note for note in submission.cleanup),
            submission.cleanup,
        )

    @staticmethod
    def _quietly(close):
        try:
            close()
        except (CleanupFailed, Closed):
            pass


class AFailedRunKeepsWhatItAlsoCouldNotRelease(unittest.TestCase):
    """`fresh` closes the reading it just made when renewal fails, and dropped
    the loader's complaint on the floor while doing it.

    Both facts matter and neither replaces the other: renewal failed, and
    their loader would not let go. `Submission.close` already reads
    `cogbench_cleanup` off a failure, so the complaint rides there.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)

    def test_the_loaders_complaint_rides_on_the_failure_that_travels(self):
        log = []
        submission = from_spec(
            self.tmp,
            DiscoverySpec(
                chain_role=Role(
                    "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
                ),
                fixture=([1],),
                accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
                arrangements=None,
                construct=_week(log, fails_on_exit=True),
            ),
        )
        self.addCleanup(self._quietly, submission.close)
        self.assertTrue(submission.ready, submission.verdict.headline)
        # Their file goes, so the next reading builds models and then cannot
        # find the chain's own function.
        (self.tmp / "theirs.py").unlink()

        with self.assertRaises(Unmapped) as caught:
            submission.fresh()

        self.assertEqual(caught.exception.reason, "file_missing")
        self.assertTrue(
            any("their model loader raised" in note
                for note in getattr(caught.exception, "cogbench_cleanup", ())),
            getattr(caught.exception, "cogbench_cleanup", ()),
        )

    @staticmethod
    def _quietly(close):
        try:
            close()
        except (CleanupFailed, Closed):
            pass


#: A team whose first step reads a folder and whose second takes the week's
#: model alongside its input, which is how week 2's `detect_and_describe`
#: takes FaceNet. The second half is the point: a test where nothing consumes
#: the model shows the hook was called and not that anything was handed what
#: it built.
FOLDER_AND_MODEL_REPO = '''
import os


def load():
    return sorted(os.listdir("baseImages"))


def describe(names, embedder):
    return [embedder.describe(name) for name in names]
'''

FOLDER_AND_MODEL_ROLE = Role(
    "cluster",
    (
        Stage(
            "make",
            produces=lambda v: isinstance(v, list) and len(v) == 2,
            folder=True,
        ),
        Stage(
            "describe",
            produces=lambda v: (
                isinstance(v, list) and len(v) == 2
                and all(isinstance(item, str) and ":" in item for item in v)
            ),
            extras=("embedder",),
        ),
    ),
)


class _Describer:
    """A model that holds its file open until the reading lets it go.

    Reads on use rather than at construction, which is what a loader holding
    weights does and what makes an early `close` show up as a failure rather
    than as nothing at all.
    """

    def __init__(self, source):
        self.handle = open(str(source), "rb")
        self.closed = False

    def describe(self, name):
        self.handle.seek(0)
        return "{}:{}".format(self.handle.read().decode(), name)

    def close(self):
        self.handle.close()
        self.closed = True


class TheTwoHooksCarryAFileIntoAModelTheChainIsHanded(_AFolder):
    """The `prepare` and `construct` contract, end to end through `from_spec`.

    A week whose model is a file the team committed writes two hooks, because
    only one of them produces something that can be copied: `prepare` runs once
    per search and returns the retained path as data, `construct` runs once per
    reading and returns an object of that reading's own.

    A contract test and not plugin acceptance. The hooks below are written
    here; no benchmark in this checkout declares a `DiscoverySpec`, and the two
    that exist elsewhere declare `prepare` alone or neither, so nothing here
    says a real week is adapted to this shape.

    What it does establish is that the object reaches their code: the chain's
    second step takes `embedder` as an argument and calls it, so a run that
    built a model nobody was handed fails these rather than passing them.
    """

    SOURCE = FOLDER_AND_MODEL_REPO

    def setUp(self):
        super().setUp()
        self.built = []

    def _hooks(self):
        def prepare(root, modules, capture):
            """Which file holds the weights, and keep the bytes that were read."""

            found = sorted(Path(root).glob("*.weights"))
            if not found:
                return {}
            return {"embedder weights": capture(found[0].resolve())}

        @contextlib.contextmanager
        def construct(root, namespace, inputs):
            """One model for this reading, closed when the reading is let go."""

            source = inputs.get("embedder weights")
            if source is None:
                # No weights is an ordinary answer, not a broken repository.
                # A hook that raised here would refuse the whole run.
                yield {}
                return
            made = _Describer(Path(source))
            self.built.append(made)
            try:
                yield {"embedder": made}
            finally:
                made.close()

        return prepare, construct

    def _spec(self, **overrides):
        prepare, construct = self._hooks()
        settings = dict(
            chain_role=FOLDER_AND_MODEL_ROLE,
            fixture=(self.A,),
            accepts=lambda chain, *_: (
                chain[1].bound(chain[0].bound(self.A))
                == ["MODELBYTES:one.png", "MODELBYTES:two.png"], ""
            ),
            arrangements=None,
            prepare=prepare,
            construct=construct,
            # The week's own question, answered off the binding rather than
            # asserted: the model is consumed when a step was handed it.
            weights_consumed=lambda run: any(
                "embedder" in step.supplied for step in run.chain
            ),
        )
        settings.update(overrides)
        return super()._spec(**settings)

    def test_the_model_this_reading_built_is_what_their_step_is_handed(self):
        (self.repo / "model.weights").write_bytes(b"MODELBYTES")

        submission = self._resolved()

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(
            [item["path"] for item in submission.weights_captured], ["model.weights"]
        )
        self.assertIn("embedder", submission.chain[1].supplied)

    def test_a_fresh_run_reads_its_own_files_through_its_own_model(self):
        (self.repo / "model.weights").write_bytes(b"MODELBYTES")
        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        described = run.chain[1].bound(run.chain[0].bound(self.B))

        self.assertEqual(described, ["MODELBYTES:four.png", "MODELBYTES:three.png"])
        self.assertIsNot(self.built[-1], self.built[0])

    def test_closing_the_run_closes_the_model_it_built(self):
        (self.repo / "model.weights").write_bytes(b"MODELBYTES")
        run = self._resolved().fresh()
        run.chain[1].bound(run.chain[0].bound(self.A))
        mine = self.built[-1]

        self.assertFalse(mine.closed)
        run.close()

        self.assertTrue(mine.closed)

    def test_a_repository_with_no_weights_is_read_rather_than_refused(self):
        """A team may have committed no weights, and that is an ordinary
        answer. The hook yields nothing rather than raising, so the search
        reports what did not bind instead of reporting a broken repository."""

        submission = self._resolved()

        self.assertFalse(submission.ready)
        self.assertIn("describe", submission.verdict.headline)
        self.assertEqual(submission.weights_captured, ())
        self.assertEqual(self.built, [])


class _NoCloseEncoder:
    """A model with nothing to call on the way out.

    `facenet_models.FacenetModel` is this shape: a constructor and two
    methods, no close and no `__enter__`. A week's hook can only stop
    referring to one of these, so whether it is released is entirely a
    question about what the SDK itself is still holding.
    """

    def __init__(self, mark=3):
        self.mark = mark

    def times(self, rows):
        return [r * self.mark for r in rows]


class _PooledEncoder(_NoCloseEncoder):
    """The same model, callable, so the pool entry is the step itself."""

    def __call__(self, rows):
        return self.times(rows)


#: Their module holds a value the search may bind a fit to, and a function
#: that takes the week's model as an argument.
VALUE_AND_MODEL_REPO = '''
idf = {'a': 0.5, 'b': 1.5}


def embed(texts, idfs):
    return [idfs[t] for t in texts]


def scale(rows, encoder):
    return encoder.times(rows)
'''

#: The same team without that last function, so the only thing that can serve
#: the stage is the callable the week put in the pool.
VALUE_AND_POOLED_MODEL_REPO = '''
idf = {'a': 0.5, 'b': 1.5}


def embed(texts, idfs):
    return [idfs[t] for t in texts]
'''

#: A team whose chain is a class of theirs and a method of the object it
#: built, over a module that loaded something when it was imported. Teams do
#: load weights at module scope, so their module namespace is a place a model
#: lives, and their class is what keeps that namespace reachable.
CONSTRUCTOR_AND_METHOD_REPO = '''
class Weights:
    def __init__(self):
        self.mark = 3


LOADED = Weights()


class Store:
    def __init__(self, rows):
        self.rows = rows

    def ids(self):
        return [r * LOADED.mark for r in self.rows]
'''


class AClosedReadingIsNotStillHoldingTheirModel(unittest.TestCase):
    """What `close` releases is the whole of what this reading was holding.

    The week's hook owns whatever it built and lets go of it on the way out,
    and for a model with a `close` of its own that is the end of it. It is not
    the end of it here: the SDK puts the object on the binding as well, once
    as a declared side input and once as the call itself when the pool entry
    is callable (`pipeline._from_pool`, which is how week 3's image encoder
    binds), and a sealed candidate is held by the closure behind
    `Candidate.bound` for as long as anything holds the record. A run that
    scores ten repositories in a process then holds ten models.

    Asked with weak references, because a model with no close cannot be asked
    whether it was closed, and because the question is exactly whether
    anything is still referring to it.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _resolve(self, encoder, source=VALUE_AND_MODEL_REPO):
        (self.tmp / "theirs.py").write_text(source)
        #: Every model this resolution built, in the order the readings did,
        #: weakly: the question here is what the SDK is holding, so the record
        #: of it must not hold anything itself.
        self.made = []

        @contextlib.contextmanager
        def construct(root, namespace, inputs):
            made = encoder()
            self.made.append(weakref.ref(made))
            yield {"encoder": made}

        return resolve(
            self.tmp,
            chain_role=Role(
                "search",
                (
                    Stage(
                        "idfs",
                        fit=True,
                        fixture=(["a", "b"],),
                        produces=lambda v: isinstance(v, dict),
                    ),
                    Stage(
                        "text",
                        produces=lambda v: isinstance(v, list),
                        extras=("idfs",),
                    ),
                    Stage(
                        "scale", produces=lambda v: v == [1.5], extras=("encoder",)
                    ),
                ),
            ),
            fixture=(["a"],),
            accepts=lambda chain, *_: (chain[0].bound(["b"]) == [1.5], ""),
            arrangements=None,
            construct=construct,
        )

    @staticmethod
    def _gone(reference):
        # Their object may sit in a cycle their own class made, so a
        # collection is the honest way to ask whether anything holds it.
        gc.collect()
        return reference() is None

    def test_a_model_handed_to_a_step_goes_when_the_reading_does(self):
        submission = self._resolve(_NoCloseEncoder)
        step = next(s for s in submission.chain if "encoder" in s.supplied)
        watch = weakref.ref(step.supplied["encoder"])
        # Everything a caller would ordinarily keep is still held here: the
        # submission, its record, and one step's callable.
        call = step.bound
        del step

        submission.close()

        self.assertTrue(self._gone(watch))
        with self.assertRaises(Closed):
            call([1])

    def test_a_model_that_was_the_step_itself_goes_too(self):
        submission = self._resolve(_PooledEncoder, VALUE_AND_POOLED_MODEL_REPO)
        step = next(s for s in submission.chain if s.supplied.get("pooled"))
        watch = weakref.ref(step.call)
        call = step.bound
        del step

        submission.close()

        self.assertTrue(self._gone(watch))
        with self.assertRaises(Closed):
            call([1])

    def _still_held(self, watching, handed):
        gc.collect()
        return [ref() for ref in watching if ref() is not None and ref() is not handed]

    def test_the_searchs_own_models_go_when_the_run_is_handed_back(self):
        """The models built for a reading the search never gave to anybody.

        The search binds against modules it imported itself rather than through
        a `Project`, so the steps it produced are the only thing holding what
        they were handed, and no close covers them. `fresh` keeps that binding
        to replay from, which is how they reached the returned submission and
        stayed for as long as a caller held it. What it keeps now is a
        description: the names to find their code by, and nothing live.
        """

        submission = self._resolve(_NoCloseEncoder)
        self.assertGreater(len(self.made), 1)
        handed = submission.chain[-1].supplied["encoder"]

        self.assertEqual(self._still_held(self.made, handed), [])

        watch = weakref.ref(handed)
        call = submission.chain[-1].bound
        del handed
        submission.close()
        self.assertTrue(self._gone(watch))
        with self.assertRaises(Closed):
            call([1])

    def test_a_pooled_model_of_the_searchs_goes_the_same_way(self):
        """The same question where the model is the step rather than an input.

        `pipeline._from_pool` makes the pool object the call itself, so the
        search's model is on the search's binding as `call` and not under a
        name. A replay takes that object out of its own reading's pool, so the
        description carries the name and not the object.
        """

        submission = self._resolve(_PooledEncoder, VALUE_AND_POOLED_MODEL_REPO)
        handed = next(
            step.call for step in submission.chain if step.supplied.get("pooled")
        )

        self.assertEqual(self._still_held(self.made, handed), [])

    def test_a_run_made_after_the_first_one_closed_still_replays(self):
        """Letting go of the search's models must not cost the next run.

        Two runs of one binding read the same description, so a release that
        emptied what they share would leave the second run unable to put a step
        on a reading at all.
        """

        submission = self._resolve(_NoCloseEncoder)
        one = submission.fresh()
        self.assertEqual(one.chain[-1].bound(one.chain[0].bound(["b"])), [4.5])
        one.close()

        two = submission.fresh()
        try:
            self.assertEqual(two.chain[-1].bound(two.chain[0].bound(["b"])), [4.5])
        finally:
            two.close()

    def test_the_run_still_says_what_it_was_handed(self):
        """The record is the reason any of this is on the binding at all.

        Two of those entries are text rather than handles: the sentence
        `_from_pool` writes when the step was one of the benchmark's own
        objects, and the note a fit bound to a module value carries. A close
        that cleared everything left the run page saying `encoder` where it
        used to name what the step was, and dropped the module-value line.
        """

        submission = self._resolve(_PooledEncoder, VALUE_AND_POOLED_MODEL_REPO)
        before = submission.to_dict()

        submission.close()

        self.assertEqual(submission.to_dict(), before)
        notes = [row["supplied"] for row in before["supplied"]]
        self.assertIn("encoder (_PooledEncoder) handed to the chain as this step", notes)
        self.assertIn(
            "read from theirs.idf, a value their module computes when it loads", notes
        )

    def test_their_class_and_what_their_constructor_built_go_too(self):
        """A model does not have to arrive from the week's hook.

        A step that is a method of theirs carries their class, and their class
        carries the module it was read into, so a team who loads weights when
        their module imports has that object reachable through the binding. The
        object their constructor stage built is the same kind of thing, held by
        the handle that step shares with the method.
        """

        (self.tmp / "theirs.py").write_text(CONSTRUCTOR_AND_METHOD_REPO)
        submission = resolve(
            self.tmp,
            chain_role=Role(
                "search",
                (
                    Stage("make", produces=lambda v: hasattr(v, "ids")),
                    Stage("read", produces=lambda v: v == [3]),
                ),
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (
                chain[1].bound(chain[0].bound([1])) == [3], ""
            ),
            arrangements=None,
        )
        self.assertEqual(
            [step.label for step in submission.chain],
            ["theirs.Store", "theirs.Store.ids"],
        )
        step = submission.chain[1]
        # Run it once: the object their constructor stage builds is what the
        # two steps share, and it is not there until the chain has run.
        self.assertEqual(step.bound(submission.chain[0].bound([1])), [3])
        loaded = weakref.ref(step.owner.ids.__globals__["LOADED"])
        built = weakref.ref(step.receiver.get())
        call = step.bound
        del step

        submission.close()

        self.assertTrue(self._gone(loaded))
        self.assertTrue(self._gone(built))
        with self.assertRaises(Closed):
            call([1])


#: A week whose task ends in a database, over a module that loaded something
#: when it imported. Their store is a plain function, so the trial holds one of
#: their functions, and a function holds the module it came from.
A_DATABASE_REPO = '''
class Weights:
    """Stands for what a team loads at module scope."""


LOADED = Weights()

_DB = {}


def make_features(value, rate):
    return [(value * 2, rate)]


def remember(features, item_id):
    _DB[tuple(features)] = item_id


def whose(features):
    return _DB.get(tuple(features), "")
'''


class AClosedDatabaseRunIsNotStillHoldingTheirDatabase(unittest.TestCase):
    """What a week with a database is holding beyond its reading.

    Closing a run closes the reading, and for a chain-only week that is the
    whole of it. A week whose task ends in a database has a trial as well, and
    the trial made three things out of that reading that outlive it: their
    database, the store method it enrolled through, and their query. The
    week's adapter holds the trial through `enroll` and `query` for as long as
    the run is on a page, so nothing else was ever going to drop them.

    Asked through their module's own object, because a store that is one of
    their functions holds the module it was read into, and a team who loads
    weights at module scope has a model there.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(A_DATABASE_REPO)

    def _resolve(self):
        def accepts(chain, enroll_call, query_call):
            try:
                for item_id, value in (("alpha", 7), ("beta", 9)):
                    enroll_call(item_id, chain[0].call(value, 44100))
            except BaseException as error:  # noqa: BLE001 - their code
                return False, "enrolling raised {}".format(type(error).__name__)
            if query_call is None:
                return True, "enrolled both"
            try:
                answer = query_call(chain[0].call(7, 44100))
            except BaseException as error:  # noqa: BLE001 - their code
                return False, "querying raised {}".format(type(error).__name__)
            return answer == "alpha", "asked for alpha"

        return resolve(
            self.tmp,
            chain_role=Role(
                "fingerprint",
                (
                    Stage(
                        "features",
                        prefers=("feature",),
                        produces=lambda v: (
                            isinstance(v, list) and bool(v) and len(v[0]) == 2
                        ),
                        arity=2,
                    ),
                ),
            ),
            fixture=(7, 44100),
            accepts=accepts,
            arrangements=lambda store, item_id, item: (
                lambda: store(item, item_id), lambda: store(item_id, item)
            ),
        )

    def test_their_module_goes_when_the_run_does(self):
        submission = self._resolve()
        self.assertTrue(submission.ready, submission.verdict.headline)
        features = submission.chain[0].bound(7, 44100)
        submission.enroll("alpha", features)
        self.assertEqual(submission.query(features), "alpha")
        loaded = weakref.ref(submission.chain[0].call.__globals__["LOADED"])
        # What a week's adapter keeps, and the only thing holding the trial.
        enroll, query = submission.enroll, submission.query

        submission.close()

        gc.collect()
        self.assertIsNone(loaded())
        with self.assertRaises(Closed):
            enroll("gamma", features)
        with self.assertRaises(Closed):
            query(features)

    def test_the_run_still_says_what_it_did(self):
        submission = self._resolve()
        before = submission.to_dict()

        submission.close()

        self.assertEqual(submission.to_dict(), before)
        self.assertEqual(submission.attempt.enroll, "theirs.remember")
        self.assertEqual(submission.attempt.query, "theirs.whose")

    def test_closing_twice_is_the_same_as_closing_once(self):
        submission = self._resolve()

        submission.close()
        submission.close()

        with self.assertRaises(Closed):
            submission.query(submission.chain[0].bound(7, 44100))


#: A team who keeps their photos in a folder two names deep. `data/photos` is
#: neither `data` nor `photos`: writing the benchmark's files under either of
#: those puts them somewhere their own code never looks.
NESTED_FOLDER_REPO = '''
import os


def load():
    return sorted(os.listdir(os.path.join("data", "photos")))


def describe(names, embedder):
    return [embedder.describe(name) for name in names]
'''

#: The same team with a second function that reads the same folder and is
#: tried first. By the time the one that binds is probed, `data/photos` is on
#: the disk, so the folder is read off the disk rather than off the request.
TWO_READERS_OF_ONE_FOLDER_REPO = '''
import os


def count_photos():
    return len(os.listdir(os.path.join("data", "photos")))


def load():
    return sorted(os.listdir(os.path.join("data", "photos")))


def describe(names, embedder):
    return [embedder.describe(name) for name in names]
'''

ESCAPING_FOLDER_REPO = '''
import os


def load():
    return sorted(os.listdir(os.path.join("..", "photos")))


def describe(names, embedder):
    return [embedder.describe(name) for name in names]
'''


class AWeekThatReadsAFolderAndLoadsAModel(_AFolder):
    """Both hooks and a nested folder, through the public `from_spec`.

    This is the shape week 2 has: a step that reads a directory of the
    benchmark's photos, and a step that takes a model the benchmark built.
    The two have different lifetimes and this is where that shows. The folder
    is written again for every call, because it holds this call's input; the
    model is built once per reading and goes when the reading does.

    The decoy is what makes the folder assertions mean anything. A
    `data/photos` sits beside the caller holding a file the benchmark never
    handed over, so a run that reads the caller's directory instead of its own
    answers `decoy.png` and these fail.
    """

    SOURCE = NESTED_FOLDER_REPO

    def setUp(self):
        super().setUp()
        (self.caller / "data" / "photos").mkdir(parents=True)
        (self.caller / "data" / "photos" / "decoy.png").write_bytes(b"not ours")
        (self.repo / "model.weights").write_bytes(b"MODELBYTES")
        self.built = []

    def _spec(self, **overrides):
        def prepare(root, modules, capture):
            found = sorted(Path(root).glob("*.weights"))
            return {} if not found else {"weights": capture(found[0].resolve())}

        @contextlib.contextmanager
        def construct(root, namespace, inputs):
            source = inputs.get("weights")
            if source is None:
                yield {}
                return
            made = _Describer(Path(source))
            self.built.append(made)
            try:
                yield {"embedder": made}
            finally:
                made.close()

        settings = dict(
            chain_role=FOLDER_AND_MODEL_ROLE,
            fixture=(self.A,),
            accepts=lambda chain, *_: (
                chain[1].bound(chain[0].bound(self.A))
                == ["MODELBYTES:one.png", "MODELBYTES:two.png"], ""
            ),
            arrangements=None,
            prepare=prepare,
            construct=construct,
        )
        settings.update(overrides)
        return super()._spec(**settings)

    def test_the_folder_is_the_whole_name_their_code_asked_for(self):
        submission = self._resolved()

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.chain[0].supplied["folder"], "data/photos")

    def test_two_runs_read_their_own_photos_through_their_own_models(self):
        one = self._resolved().fresh()
        self.addCleanup(self._quietly, one.close)
        two = self._resolved().fresh()
        self.addCleanup(self._quietly, two.close)

        # Alternating, because a run that answered correctly only while it was
        # the most recent one would pass a first-then-second ordering.
        first = one.chain[1].bound(one.chain[0].bound(self.A))
        second = two.chain[1].bound(two.chain[0].bound(self.B))
        again = one.chain[1].bound(one.chain[0].bound(self.A))

        self.assertEqual(first, ["MODELBYTES:one.png", "MODELBYTES:two.png"])
        self.assertEqual(second, ["MODELBYTES:four.png", "MODELBYTES:three.png"])
        self.assertEqual(again, first)
        self.assertIsNot(self.built[-1], self.built[0])

    def test_one_resolution_handed_out_twice_gives_each_run_its_own_model(self):
        """Two runs of ONE binding, which is what a scored pair actually is.

        Resolving twice is two searches, so the model each run answers through
        is trivially not the other's. The case the platform has is one
        resolution handed out twice: one recorded binding, one retained weights
        file, two readings. The objects compared here are the two the runs were
        handed, rather than a run's model and the search's.
        """

        resolved = self._resolved()
        one = resolved.fresh()
        self.addCleanup(self._quietly, one.close)
        two = resolved.fresh()
        self.addCleanup(self._quietly, two.close)

        # Alternating, and each run over its own photos: a reading that
        # answered correctly only while it was the most recent one would pass a
        # first-then-second ordering.
        first = one.chain[1].bound(one.chain[0].bound(self.A))
        second = two.chain[1].bound(two.chain[0].bound(self.B))
        again = one.chain[1].bound(one.chain[0].bound(self.A))

        self.assertEqual(first, ["MODELBYTES:one.png", "MODELBYTES:two.png"])
        self.assertEqual(second, ["MODELBYTES:four.png", "MODELBYTES:three.png"])
        self.assertEqual(again, first)
        mine = one.chain[1].supplied["embedder"]
        theirs = two.chain[1].supplied["embedder"]
        self.assertIsNot(mine, theirs)
        self.assertIn(mine, self.built)
        self.assertIn(theirs, self.built)

    def test_a_second_run_of_one_binding_outlives_the_first_ones_close(self):
        """Closing one run must not take the description the other replays from.

        Both runs read the same recorded binding, so a `close` that reached
        into what they share would leave the second run with a step it could no
        longer put on a reading.
        """

        resolved = self._resolved()
        one = resolved.fresh()
        one.chain[1].bound(one.chain[0].bound(self.A))
        one.close()

        two = resolved.fresh()
        self.addCleanup(self._quietly, two.close)

        self.assertEqual(
            two.chain[1].bound(two.chain[0].bound(self.B)),
            ["MODELBYTES:four.png", "MODELBYTES:three.png"],
        )

    def test_a_reading_builds_its_model_and_lets_it_go_on_its_own(self):
        run = self._resolved().fresh()
        run.chain[1].bound(run.chain[0].bound(self.A))
        mine = self.built[-1]
        self.assertFalse(mine.closed)

        run.close()

        self.assertTrue(mine.closed)

    def test_their_code_stops_reading_anything_once_the_run_is_closed(self):
        run = self._resolved().fresh()
        step = run.chain[0]
        run.close()

        with self.assertRaises(Closed):
            step.bound(self.A)

        self.assertFalse((self.caller / "data" / "photos" / "one.png").exists())

    def test_the_caller_s_own_folder_is_left_alone(self):
        run = self._resolved().fresh()
        self.addCleanup(self._quietly, run.close)

        run.chain[0].bound(self.B)

        self.assertEqual(
            sorted(p.name for p in (self.caller / "data" / "photos").iterdir()),
            ["decoy.png"],
        )


class AFolderAlreadyOnTheDiskIsStillNamedInFull(AWeekThatReadsAFolderAndLoadsAModel):
    """The folder is read off the disk once an earlier probe has made it.

    Their first function reads `data/photos` and returns a count, which the
    stage refuses; the next one is probed in the same scratch directory, where
    that folder now exists. That is the one path where the name comes from the
    disk rather than from the request their code made, and naming it by its
    first segment there put this call's photos in `data/` while their code
    went on reading `data/photos`.
    """

    SOURCE = TWO_READERS_OF_ONE_FOLDER_REPO


class AFolderThatWouldClimbOutIsRefusedBeforeAnythingIsWritten(_AFolder):
    """Their code reads `../photos`, which names a directory above the one
    this run owns.

    Refused rather than clamped, and refused before a write: a benchmark that
    quietly rewrote that into a folder of its own choosing would have written
    somewhere nobody asked it to, and their code would then read the caller's
    `photos` and score whatever is in it.
    """

    SOURCE = ESCAPING_FOLDER_REPO

    def setUp(self):
        super().setUp()
        (self.tmp / "photos").mkdir(parents=True, exist_ok=True)
        (self.tmp / "photos" / "decoy.png").write_bytes(b"not ours")

    def test_it_does_not_bind_and_nothing_climbed_out(self):
        submission = self._resolved()

        self.assertFalse(submission.ready)
        self.assertEqual(
            sorted(p.name for p in (self.tmp / "photos").iterdir()), ["decoy.png"]
        )
        self.assertFalse((self.caller.parent / "photos" / "one.png").exists())


#: Their module builds one object as it imports and parks it in a global, the
#: way a team who loads weights at module scope does, so every reading of this
#: file makes another. The list it appends to is on `builtins` because that is
#: the one channel a test has into a reading the run has already let go of:
#: each entry is a weak reference to the object one reading made, and counting
#: the live ones counts the readings something is still holding.
A_MODULE_THAT_LOADS_AS_IT_IMPORTS = '''
import builtins
import weakref


class Weights:
    def __init__(self):
        self.mark = 3


LOADED = Weights()
builtins.COGBENCH_READINGS.append(weakref.ref(LOADED))


def scale(rows):
    return [row * LOADED.mark for row in rows]
'''

#: The same team reaching the same global through an object of theirs, so the
#: binding the search returns is a method taken off one of their instances
#: rather than one of their functions. A method holds its object, and the
#: object's class holds the module the global is in.
A_DATABASE_THAT_LOADS_AS_IT_IMPORTS = '''
import builtins
import weakref


class Weights:
    def __init__(self):
        self.mark = 3


LOADED = Weights()
builtins.COGBENCH_READINGS.append(weakref.ref(LOADED))


def make_features(value, rate):
    return [(value * LOADED.mark, rate)]


class Bank:
    def __init__(self):
        self.rows = {}

    def remember(self, features, item_id):
        self.rows[tuple(features)] = item_id

    def whose(self, features):
        return self.rows.get(tuple(features), "")
'''


class TheSearchsOwnReadingGoesWhenTheBindingIsHandedOver(unittest.TestCase):
    """The search reads their repository, binds against what it imported, and
    then hands the binding a reading of its own.

    What it bound to is theirs: a function holds the module it was read into,
    a method holds the object it came off, and either way a model their file
    loaded at import is in there. Holding those to identify the same code later
    kept the search's whole namespace alive for as long as anything held the
    run, so a plugin scoring ten repositories held ten of them. The binding
    kept for replay is a description instead, and `Submission.discovery` is let
    go at the same handoff, since what a later reading needs off it is the file
    each module name belongs to.

    A repository that binds nothing has no handoff and keeps that reading as
    the evidence behind the refusal, so `close` is where it goes instead.

    Counted rather than asserted per object: one live reading per open run is
    the whole claim.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        import builtins

        builtins.COGBENCH_READINGS = []
        self.addCleanup(delattr, builtins, "COGBENCH_READINGS")

    def _readings_alive(self):
        import builtins

        gc.collect()
        gc.collect()
        return sum(1 for ref in builtins.COGBENCH_READINGS if ref() is not None)

    def _a_chain(self):
        (self.tmp / "theirs.py").write_text(A_MODULE_THAT_LOADS_AS_IT_IMPORTS)
        return resolve(
            self.tmp,
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: v == [3]),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
        )

    def _a_refusal(self):
        """The same file, against a week nothing in it can answer."""

        (self.tmp / "theirs.py").write_text(A_MODULE_THAT_LOADS_AS_IT_IMPORTS)
        return resolve(
            self.tmp,
            chain_role=Role(
                "search", (Stage("one", produces=lambda v: v == [99]),)
            ),
            fixture=([1],),
            accepts=lambda chain, *_: (False, "not this one"),
            arrangements=None,
        )

    def _a_database(self):
        (self.tmp / "theirs.py").write_text(A_DATABASE_THAT_LOADS_AS_IT_IMPORTS)

        def accepts(chain, enroll_call, query_call):
            # Their query offered as a store is an ordinary thing for the
            # search to try, and it raises; the week's own test is what tells
            # the two apart, so it has to survive that.
            try:
                for item_id, value in (("alpha", 7), ("beta", 9)):
                    enroll_call(item_id, chain[0].call(value, 44100))
                if query_call is None:
                    return True, "enrolled both"
                answer = query_call(chain[0].call(7, 44100))
            except BaseException as error:  # noqa: BLE001 - their code
                return False, "{} raised".format(type(error).__name__)
            return answer == "alpha", "asked for alpha"

        return resolve(
            self.tmp,
            chain_role=Role(
                "fingerprint",
                (
                    Stage(
                        "features",
                        produces=lambda v: (
                            isinstance(v, list) and bool(v) and len(v[0]) == 2
                        ),
                        arity=2,
                    ),
                ),
            ),
            fixture=(7, 44100),
            accepts=accepts,
            arrangements=lambda store, item_id, item: (
                lambda: store(item, item_id), lambda: store(item_id, item)
            ),
        )

    def test_one_reading_is_left_and_it_is_the_one_the_run_answers_from(self):
        submission = self._a_chain()
        self.addCleanup(submission.close)
        call = submission.chain[0].bound

        self.assertEqual(self._readings_alive(), 1)
        self.assertIsNone(submission.discovery)
        self.assertEqual(call([2]), [6])

    def test_a_method_binding_lets_the_object_the_search_filled_go(self):
        submission = self._a_database()
        self.addCleanup(submission.close)
        features = submission.chain[0].bound(7, 44100)
        submission.enroll("alpha", features)

        self.assertEqual(submission.attempt.enroll, "theirs.Bank().remember")
        self.assertEqual(submission.query(features), "alpha")
        self.assertEqual(self._readings_alive(), 1)

    def test_a_sibling_run_is_not_touched_by_closing_the_first(self):
        submission = self._a_chain()
        sibling = submission.fresh()
        self.addCleanup(sibling.close)

        self.assertEqual(self._readings_alive(), 2)
        submission.close()

        self.assertEqual(self._readings_alive(), 1)
        self.assertEqual(sibling.chain[0].bound([2]), [6])
        # And it can still be asked for a run of its own. Siblings share one
        # description, so closing one must not have taken it away.
        third = sibling.fresh()
        self.assertEqual(third.chain[0].bound([2]), [6])
        third.close()
        self.assertEqual(self._readings_alive(), 1)

    def test_closing_every_run_leaves_none_of_their_readings(self):
        submission = self._a_chain()
        sibling = submission.fresh()
        held = (submission.chain[0].bound, sibling.chain[0].bound)

        sibling.close()
        submission.close()

        self.assertEqual(self._readings_alive(), 0)
        for call in held:
            with self.assertRaises(Closed):
                call([2])

    def test_the_record_still_says_what_was_read(self):
        submission = self._a_chain()
        self.addCleanup(submission.close)

        record = submission.to_dict()["discovery"]

        self.assertEqual(
            [entry["name"] for entry in record["modules"]], ["theirs"]
        )
        self.assertEqual(submission.to_dict(), submission.report().record)

    def test_a_refusal_keeps_the_search_open_until_it_is_closed(self):
        refused = self._a_refusal()

        self.assertFalse(refused.ready)
        self.assertIsNotNone(refused.discovery)
        self.assertEqual(self._readings_alive(), 1)

        refused.close()
        refused.close()

        self.assertIsNone(refused.discovery)
        self.assertEqual(self._readings_alive(), 0)

    def _a_database_with_nothing_to_store_it(self):
        """The same file through the public entry point, against a week whose
        own test never takes an enrolment. Their fingerprinting is found and
        nothing in the repository can hold what it produced, which is the one
        refusal that names the chain it found."""

        (self.tmp / "theirs.py").write_text(A_DATABASE_THAT_LOADS_AS_IT_IMPORTS)
        return from_spec(self.tmp, DiscoverySpec(
            chain_role=Role(
                "fingerprint",
                (
                    Stage(
                        "features",
                        produces=lambda v: (
                            isinstance(v, list) and bool(v) and len(v[0]) == 2
                        ),
                        arity=2,
                    ),
                ),
            ),
            fixture=(7, 44100),
            accepts=lambda chain, *_: (False, "nothing stored it"),
            arrangements=lambda store, item_id, item: (
                lambda: store(item, item_id), lambda: store(item_id, item)
            ),
        ))

    def test_a_refusal_that_names_the_chain_it_found_still_lets_it_go(self):
        refused = self._a_database_with_nothing_to_store_it()
        was = refused.to_dict()

        self.assertFalse(refused.ready)
        self.assertEqual(
            [step.label for step in refused.chain], ["theirs.make_features"]
        )
        self.assertEqual(refused.chain[0].bound(7, 44100), [(21, 44100)])
        self.assertEqual(self._readings_alive(), 1)

        refused.close()
        refused.close()

        self.assertEqual(self._readings_alive(), 0)
        self.assertEqual(refused.to_dict(), was)
        self.assertEqual(
            [step.label for step in refused.chain], ["theirs.make_features"]
        )
        with self.assertRaises(Closed):
            refused.chain[0].bound(7, 44100)

    def test_a_closed_refusal_still_says_what_it_read_and_why(self):
        refused = self._a_refusal()
        headline = refused.verdict.headline

        refused.close()

        record = refused.to_dict()
        self.assertEqual(
            [entry["name"] for entry in record["discovery"]["modules"]], ["theirs"]
        )
        self.assertEqual(refused.verdict.headline, headline)
        self.assertEqual(refused.report().record, record)

    def test_writing_into_one_report_leaves_the_run_and_its_sibling_alone(self):
        submission = self._a_chain()
        self.addCleanup(submission.close)
        sibling = submission.fresh()
        self.addCleanup(sibling.close)

        report = submission.report()
        report.record["discovery"]["modules"] = []

        self.assertIsNot(
            submission.report().record["discovery"], report.record["discovery"]
        )
        for run in (submission, sibling):
            self.assertEqual(
                [entry["name"] for entry in run.to_dict()["discovery"]["modules"]],
                ["theirs"],
            )

    def test_the_step_kept_for_replay_names_their_code_and_holds_none_of_it(self):
        submission = self._a_chain()
        self.addCleanup(submission.close)

        step = submission._source.steps[0]

        self.assertIsNone(step.owner)
        self.assertEqual(step._described.module, "theirs")
        self.assertEqual(step._described.qualname, "scale")
        with self.assertRaises(RuntimeError):
            step.call([1])


if __name__ == "__main__":
    unittest.main()
