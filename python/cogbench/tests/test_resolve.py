from __future__ import annotations

import copy
import os
import shutil
import signal
import sys
import tempfile
import unittest
from collections.abc import Mapping
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import memo  # noqa: E402
from cogbench._namespace import (  # noqa: E402
    Bundle, Project, Unmapped, declared_in, reads_anything,
)
from cogbench.discover import discover  # noqa: E402
from cogbench.pipeline import (  # noqa: E402
    Candidate, Role, Stage, _Timeout, instances_in, methods_of, runtime_pool,
)
from cogbench.progress import Progress  # noqa: E402
from cogbench.resolve import (  # noqa: E402
    AmbiguousStore, NoDatabase, _FromTheirStore, _Shape, _Trial, _accepts_n,
    _produced_by, _read_further, _reader_input, _takes_one, resolve,
)
from cogbench.verdict import NOT_READ, NOT_WIRED, NOTHING_HERE, SCORED  # noqa: E402


#: Where their code writes down what it did, and how it finds the file.
#:
#: A module global cannot be counted any more. Every trial reads the
#: repository again, so the module object the search imported is not the one
#: any trial calls, and a count kept in it stays at zero however much of their
#: code runs. A file named by the environment is the one place every reading
#: of the repository can reach, and it outlives the scratch directory each
#: probe runs in.
RECORD_VARIABLE = "COGBENCH_TEST_RECORD"

RECORDER = '''
import os as _os


def _record(what):
    where = _os.environ.get("{}")
    if where:
        with open(where, "a") as opened:
            opened.write(str(what) + "\\n")
'''.format(RECORD_VARIABLE)


def _recording(case):
    """Point their code at a file this test can read, and return a reader."""

    handle, path = tempfile.mkstemp(prefix="cogbench-record-")
    os.close(handle)
    case.addCleanup(os.unlink, path)
    before = os.environ.get(RECORD_VARIABLE)
    os.environ[RECORD_VARIABLE] = path

    def restore():
        if before is None:
            os.environ.pop(RECORD_VARIABLE, None)
        else:
            os.environ[RECORD_VARIABLE] = before

    case.addCleanup(restore)

    def read():
        with open(path) as opened:
            return opened.read().split()

    return read


class StoredMappingInspectionTests(unittest.TestCase):
    def test_inherited_and_mangled_slots_are_read_without_properties(self):
        class Base:
            __slots__ = ("__table", "uninitialized")

            def __init__(self):
                self.__table = {"key": []}

            def store(self):
                self.__table["key"].append("alpha")

            @property
            def trap(self):
                raise AssertionError("property must not run")

        class Cabinet(Base):
            __slots__ = ("metadata",)

            def __init__(self):
                super().__init__()
                self.metadata = {"settings": [1]}

        cabinet = Cabinet()
        state = _FromTheirStore(cabinet.store)
        self.assertEqual(set(state._before), {"_Base__table", "metadata"})
        cabinet.store()
        state.enrolling("alpha")
        table, names = state.arguments()
        self.assertIs(table, cabinet._Base__table)
        self.assertEqual(state.chosen, "_Base__table")
        self.assertEqual(names, {"alpha": "alpha"})

    def test_actual_dict_storage_is_read_beneath_a_property(self):
        class Base:
            pass

        class Cabinet(Base):
            __slots__ = ("table",)

            def __init__(self):
                self.table = {"key": []}
                self.metadata = {"settings": [1]}

            @property
            def __dict__(self):
                raise AssertionError("not actual storage")

            def store(self):
                self.table["key"].append("alpha")

        cabinet = Cabinet()
        state = _FromTheirStore(cabinet.store)
        self.assertEqual(set(state._before), {"table", "metadata"})
        cabinet.store()
        self.assertIs(state.arguments()[0], cabinet.table)

    def test_nested_in_place_change_beside_unchanged_metadata(self):
        class Cabinet:
            def __init__(self):
                self.table = {"key": {"ids": []}}
                self.metadata = {"settings": [1]}

            def store(self):
                self.table["key"]["ids"].append("alpha")

        cabinet = Cabinet()
        state = _FromTheirStore(cabinet.store)
        cabinet.store()
        self.assertIs(state.arguments()[0], cabinet.table)

    def test_uncopyable_or_uncomparable_tables_cannot_be_ruled_out(self):
        class Uncopyable:
            def __deepcopy__(self, memo):
                raise ValueError("cannot snapshot")

        class Uncomparable:
            def __eq__(self, other):
                raise ValueError("cannot compare")

        class Cabinet:
            def __init__(self, opaque):
                self.metadata = {"opaque": opaque}
                self.table = {}

            def store(self):
                self.table["key"] = ["alpha"]

        for opaque in (Uncopyable(), Uncomparable()):
            with self.subTest(kind=type(opaque).__name__):
                cabinet = Cabinet(opaque)
                state = _FromTheirStore(cabinet.store)
                cabinet.store()
                with self.assertRaisesRegex(AmbiguousStore, "metadata, table"):
                    state.arguments()

    def test_mapping_conversion_copy_and_equality_run_under_the_guard(self):
        guarded = []
        observed = []

        def guard(call, *args, **kwargs):
            guarded.append(True)
            try:
                return call(*args, **kwargs)
            finally:
                guarded.pop()

        class Nested:
            def __deepcopy__(self, memo):
                observed.append(("copy", bool(guarded)))
                return Nested()

            def __eq__(self, other):
                observed.append(("equality", bool(guarded)))
                return True

        class Table(Mapping):
            def __len__(self):
                return 1

            def __iter__(self):
                observed.append(("iteration", bool(guarded)))
                return iter(["key"])

            def __getitem__(self, key):
                observed.append(("lookup", bool(guarded)))
                return Nested()

        class Cabinet:
            def __init__(self):
                self.table = Table()

            def store(self):
                pass

        cabinet = Cabinet()
        with patch("cogbench.resolve._under_clock", side_effect=guard):
            state = _FromTheirStore(cabinet.store)
            self.assertIs(state.arguments()[0], cabinet.table)
        self.assertEqual({kind for kind, _ in observed}, {
            "copy", "equality", "iteration", "lookup",
        })
        self.assertTrue(all(active for _, active in observed), observed)

    def test_snapshot_or_comparison_timeout_leaves_ambiguous_tables(self):
        class Cabinet:
            def __init__(self):
                self.metadata = {"settings": [1]}
                self.table = {"key": []}

            def store(self):
                self.table["key"].append("alpha")

        for operation in ("snapshot", "comparison"):
            with self.subTest(operation=operation):
                cabinet = Cabinet()
                if operation == "comparison":
                    state = _FromTheirStore(cabinet.store)
                with patch(
                    "cogbench.resolve._under_clock", side_effect=_Timeout("existing clock"),
                ) as clock:
                    if operation == "snapshot":
                        state = _FromTheirStore(cabinet.store)
                    cabinet.store()
                    with self.assertRaisesRegex(AmbiguousStore, "metadata, table"):
                        state.arguments()
                self.assertEqual(clock.call_count, 2)

    @unittest.skipUnless(
        hasattr(signal, "SIGALRM") and hasattr(signal, "getitimer"),
        "live alarm inspection requires POSIX interval timers",
    )
    def test_nested_copy_and_equality_observe_a_live_alarm(self):
        observed = []

        class Nested:
            def __deepcopy__(self, memo):
                observed.append(("copy", signal.getitimer(signal.ITIMER_REAL)[0]))
                return Nested()

            def __eq__(self, other):
                observed.append(("equality", signal.getitimer(signal.ITIMER_REAL)[0]))
                return True

        class Cabinet:
            def __init__(self):
                self.table = {"key": Nested()}

            def store(self):
                pass

        cabinet = Cabinet()
        with patch("cogbench.pipeline.CALL_TIMEOUT_SECONDS", 1):
            state = _FromTheirStore(cabinet.store)
            self.assertIs(state.arguments()[0], cabinet.table)
        self.assertEqual([kind for kind, _ in observed], ["copy", "equality"])
        self.assertTrue(all(0 < remaining <= 1 for _, remaining in observed), observed)

    def test_equal_contents_replacement_is_still_a_changed_table(self):
        class Cabinet:
            def __init__(self):
                self.table = {"key": ["alpha"]}
                self.metadata = {"settings": [1]}

            def store(self):
                self.table = {"key": ["alpha"]}

        cabinet = Cabinet()
        state = _FromTheirStore(cabinet.store)
        cabinet.store()
        self.assertIs(state.arguments()[0], cabinet.table)


class ReaderInputIsolationTests(unittest.TestCase):
    class Trial:
        def reading(self, candidate):
            return candidate.call

    def test_mutating_reader_cannot_poison_siblings_at_either_depth(self):
        for raises in (False, True):
            for depth in (1, 2):
                with self.subTest(raises=raises, depth=depth):
                    answer = {"ids": ["alpha"], "depth": 0}

                    def poison(value):
                        value["ids"].clear()
                        if raises:
                            raise ValueError("mutated before failing")
                        return value

                    def advance(value):
                        value["depth"] += 1
                        return value

                    def finish(value):
                        if value == {"ids": ["alpha"], "depth": depth - 1}:
                            return "complete"
                        raise ValueError("not ready")

                    pool = [Candidate("poison", poison, "test")]
                    if depth == 2:
                        pool.append(Candidate("advance", advance, "test"))
                    pool.append(Candidate("finish", finish, "test"))
                    result = _read_further(
                        lambda value: (value == "complete", ""),
                        answer, self.Trial(), pool, depth,
                    )
                    self.assertIsNotNone(result)
                    self.assertEqual(
                        [candidate.label for candidate in result[1]],
                        ["advance", "finish"] if depth == 2 else ["finish"],
                    )
                    self.assertEqual(answer, {"ids": ["alpha"], "depth": 0})

    def test_dictionary_views_keep_their_type_and_detach_the_backing_data(self):
        for kind in ("items", "keys", "values"):
            with self.subTest(kind=kind):
                shared = [1]
                source = {"beta": shared, "alpha": shared}
                view = getattr(source, kind)()
                detached = _reader_input(view)
                self.assertIs(type(detached), type(view))
                self.assertEqual(list(detached), list(view))
                source["later"] = [2]
                self.assertEqual(len(detached), 2)
                if kind != "keys":
                    values = [value for _, value in detached] if kind == "items" else list(detached)
                    self.assertIs(values[0], values[1])
                    values[0].append(3)
                    self.assertEqual(shared, [1])

    def test_sorting_readers_accept_each_dictionary_view_type(self):
        source = {"beta": 2, "alpha": 1}
        for kind in ("items", "keys", "values"):
            with self.subTest(kind=kind):
                answer = getattr(source, kind)()
                expected = sorted(answer)
                seen = []

                def sort_view(value):
                    seen.append(type(value))
                    return sorted(value)

                reader = Candidate("sort", sort_view, "test")
                result = _read_further(
                    lambda value: (value == expected, ""),
                    answer, self.Trial(), [reader], 1,
                )
                self.assertEqual(result, (1.0, (reader,)))
                self.assertEqual(seen, [type(answer)])

    def test_nested_items_view_mutation_cannot_poison_a_later_frontier(self):
        for raises in (False, True):
            with self.subTest(raises=raises):
                source = {"beta": ["beta"], "alpha": ["alpha"]}
                view_type = type(source.items())
                seen = []

                def poison(view):
                    for _, ids in view:
                        ids.clear()
                    if raises:
                        raise ValueError("mutated before failing")
                    return view

                def advance(view):
                    for _, ids in view:
                        ids.append("ready")
                    return view

                def finish(view):
                    seen.append(type(view))
                    if not all(ids == [name, "ready"] for name, ids in view):
                        raise ValueError("not ready")
                    return sorted(name for name, _ in view)

                pool = [Candidate(name, call, "test") for name, call in (
                    ("poison", poison), ("advance", advance), ("finish", finish),
                )]
                result = _read_further(
                    lambda value: (value == ["alpha", "beta"], ""),
                    source.items(), self.Trial(), pool, 2,
                )
                self.assertEqual(result, (1.0, (pool[1], pool[2])))
                self.assertTrue(seen)
                self.assertEqual(set(seen), {view_type})
                self.assertEqual(source, {"beta": ["beta"], "alpha": ["alpha"]})

    def test_copying_runs_under_the_guard_and_failure_skips_the_reader(self):
        guarded = []
        calls = []

        class Uncopyable:
            def __deepcopy__(self, memo):
                self_test.assertTrue(guarded)
                raise ValueError("cannot copy reader input")

        def guard(call, *args, **kwargs):
            guarded.append(True)
            try:
                return call(*args, **kwargs)
            finally:
                guarded.pop()

        self_test = self
        reader = Candidate("reader", lambda value: calls.append(value), "test")
        with patch("cogbench.resolve._under_clock", side_effect=guard) as clock:
            result = _read_further(
                lambda value: (False, ""), Uncopyable(), self.Trial(), [reader], 2,
            )
        self.assertIsNone(result)
        self.assertEqual(calls, [])
        self.assertEqual(clock.call_count, 1)


class QuerySignatureTests(unittest.TestCase):
    def test_optional_queries_do_not_expand_the_reader_pool(self):
        def query(first=None, second=None):
            return first

        candidate = Candidate("query", query, "test")
        self.assertTrue(_accepts_n(candidate, 1))
        self.assertTrue(_accepts_n(candidate, 2))
        self.assertFalse(_accepts_n(candidate, 3))
        self.assertFalse(_takes_one(candidate))

    def test_required_keyword_only_parameters_are_not_supplied(self):
        def query(first, *, threshold):
            return first

        self.assertFalse(_accepts_n(Candidate("query", query, "test"), 1))

    def test_variadic_only_queries_remain_deferred(self):
        def query(*values):
            return values

        self.assertFalse(_accepts_n(Candidate("query", query, "test"), 1))


# A miniature week: an item is a number, "fingerprinting" doubles it, a store
# keeps it under an id, and a query names the id back. Small enough to read,
# shaped like the real thing.
def _pairs(value):
    return isinstance(value, list) and bool(value) and len(value[0]) == 2


ROLE = Role(
    "fingerprint",
    (Stage("features", prefers=("feature",), produces=_pairs, arity=2),),
)

FIXTURE = (7, 44100)


def _grades(answer):
    """The miniature week's reading of one answer, and nothing else."""

    return (answer == "alpha"), "asked for alpha and got {}".format(answer)


def _enrol(chain, enroll_call):
    """Put both fixture items in, the way every acceptance test here starts."""

    try:
        for item_id, value in (("alpha", 7), ("beta", 9)):
            enroll_call(item_id, chain[0].call(value, 44100))
    except TypeError as error:
        return False, "enrolling did not accept those arguments: {}".format(error)
    except BaseException as error:  # noqa: BLE001
        return False, "enrolling raised {}".format(type(error).__name__)
    return True, "enrolled both items"


def _accepts(chain, enroll_call, query_call):
    """Enroll two items, ask for one back.

    ``query_call`` is None when the resolver is asking only whether this store
    takes an item, which is the contract in `DiscoverySpec.accepts`.
    """

    enrolled, detail = _enrol(chain, enroll_call)
    if not enrolled or query_call is None:
        return enrolled, detail
    try:
        answer = query_call(chain[0].call(7, 44100))
    except BaseException as error:  # noqa: BLE001
        return False, "querying raised {}".format(type(error).__name__)
    return _grades(answer)


def _arrangements(store, item_id, item):
    return (
        lambda: store(item, item_id),
        lambda: store(item_id, item),
    )


REPO = '''
_DB = {}


def make_features(value, rate):
    return [(value * 2, rate)]


def remember(features, item_id):
    _DB[tuple(features)] = item_id


def whose(features):
    return _DB.get(tuple(features), "")
'''


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _resolve(self):
        return resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
        )

    def test_a_working_repository_resolves_to_something_runnable(self):
        (self.tmp / "theirs.py").write_text(REPO)

        submission = self._resolve()

        self.assertTrue(submission.ready)
        self.assertEqual(submission.verdict.status, SCORED)
        self.assertEqual(submission.attempt.enroll, "theirs.remember")
        self.assertEqual(submission.attempt.query, "theirs.whose")

    def test_an_empty_repository_says_so_rather_than_failing(self):
        (self.tmp / "README.md").write_text("# soon\n")

        submission = self._resolve()

        self.assertFalse(submission.ready)
        self.assertEqual(submission.verdict.status, NOTHING_HERE)

    def test_an_unimportable_repository_names_the_missing_package(self):
        (self.tmp / "theirs.py").write_text("import definitely_not_installed\n")

        submission = self._resolve()

        self.assertEqual(submission.verdict.status, NOT_READ)
        self.assertIn("definitely_not_installed", submission.verdict.headline)
        self.assertIn("requirements.txt", submission.verdict.next_step)

    def test_a_repository_with_no_pipeline_refuses_at_the_first_stage(self):
        (self.tmp / "theirs.py").write_text("def unrelated(x):\n    return x\n")

        submission = self._resolve()

        self.assertEqual(submission.verdict.status, NOT_WIRED)
        self.assertFalse(submission.ready)

    def test_a_pipeline_with_no_store_says_which_half_was_found(self):
        """The half-resolved case is the one worth being precise about."""

        (self.tmp / "theirs.py").write_text(
            "def make_features(value, rate):\n    return [(value * 2, rate)]\n"
        )

        submission = self._resolve()

        self.assertEqual(submission.verdict.status, NOT_WIRED)
        self.assertEqual([step.label for step in submission.chain], ["theirs.make_features"])
        self.assertIn("stores", submission.verdict.next_step)

    def test_the_store_is_never_looked_for_among_the_pipeline_it_already_bound(self):
        (self.tmp / "theirs.py").write_text(REPO)
        submission = self._resolve()
        self.assertNotEqual(submission.attempt.enroll, "theirs.make_features")

    def test_the_record_carries_what_a_surface_needs_to_render(self):
        (self.tmp / "theirs.py").write_text(REPO)

        record = self._resolve().to_dict()

        self.assertEqual(record["verdict"]["status"], SCORED)
        self.assertEqual(record["chain"], ["theirs.make_features"])
        self.assertIn("discovery", record)
        self.assertGreater(record["attemptsTried"], 0)

    def test_resolution_is_the_same_every_time(self):
        (self.tmp / "theirs.py").write_text(REPO)
        first = self._resolve()
        second = self._resolve()
        self.assertEqual(first.attempt, second.attempt)
        self.assertEqual(first.attempts_tried, second.attempts_tried)

    def test_the_search_stops_at_the_attempt_ceiling(self):
        """A repository is refused for having no working pairing, not for
        taking a long time to prove it."""

        (self.tmp / "theirs.py").write_text(
            REPO + "\n" + "\n".join(
                "def spare{}(a, b=None):\n    return None\n".format(index)
                for index in range(12)
            )
        )

        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=lambda *_: (False, "never"),
            arrangements=_arrangements,
            max_attempts=8,
        )

        self.assertFalse(submission.ready)
        self.assertLessEqual(submission.attempts_tried, 8)


class _Recorder(Progress):
    """Keeps every call, so what a student is shown can be asserted on."""

    def __init__(self):
        self.phases = []
        self.bound = []
        self.counts = []

    def phase(self, headline):
        self.phases.append(headline)

    def found(self, stage, label):
        self.bound.append((stage, label))

    def attempts(self, done, total):
        self.counts.append((done, total))


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REPO)
        self.watcher = _Recorder()

    def _resolve(self, **kwargs):
        return resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
            progress=self.watcher,
            **kwargs,
        )

    def test_the_total_shown_is_the_search_the_student_is_actually_waiting_on(self):
        """A bar whose total is a guess is worse than no bar: it reads as a
        measurement and is wrong every time the search ends early."""

        self._resolve(max_attempts=8)

        self.assertTrue(self.watcher.counts)
        for done, total in self.watcher.counts:
            self.assertLessEqual(done, total)
            self.assertLessEqual(total, 8)

    def test_the_count_advances_by_one_per_pairing_tried(self):
        submission = self._resolve()
        ticks = [done for done, _ in self.watcher.counts]

        self.assertEqual(ticks[: submission.attempts_tried], list(range(1, submission.attempts_tried + 1)))

    def test_a_bound_stage_is_announced_while_the_slow_part_is_still_running(self):
        """Finding their fingerprinting is the first real evidence the search
        is working, and it arrives long before a score does."""

        self._resolve()

        self.assertIn(("features", "theirs.make_features"), self.watcher.bound)

    def test_progress_is_optional_and_resolution_is_unchanged_without_it(self):
        with_watcher = self._resolve()
        without = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
        )

        self.assertEqual(with_watcher.attempt, without.attempt)
        self.assertEqual(with_watcher.attempts_tried, without.attempts_tried)


class TheTwoRefusalsDoNotShareASentence(unittest.TestCase):
    """"Nothing accepted that" and "your chain gave the wrong answer" are
    opposite findings and were reported identically.

    The first is a wiring problem, often ours to explain. The second is their
    algorithm, and it means every function the benchmark wanted exists and is
    connected. Saying the first when the second is true sends a team looking
    for a function they already wrote.

    Measured on a 2026 repository: its chain runs end to end, and running
    their own pipeline by hand at every threshold the search tries returns 4,
    5, or 6 clusters where the fixture has 3. Nothing was unwired.
    """

    def test_a_chain_that_ran_is_not_reported_as_unwired(self):
        from cogbench.pipeline import Refusal

        refusal = Refusal(
            "cluster",
            ("their.adj_list", "their.whispers"),
            "labels",
            "the chain ran but did not return the right answer on the benchmark's own case",
            ran_to_the_end=True,
        )
        self.assertTrue(refusal.ran_to_the_end)

    def test_a_stalled_chain_still_reports_the_handoff(self):
        from cogbench.pipeline import Refusal

        refusal = Refusal(
            "cluster",
            ("their.adj_list",),
            "graph",
            "nothing accepted what their.adj_list returned",
        )
        self.assertFalse(refusal.ran_to_the_end)

    def test_the_flag_is_a_field_rather_than_a_phrase_match(self):
        """The two used to be told apart, where they were told apart at all,
        by their prose. Matching on prose is how they came to share one."""

        from cogbench.pipeline import Refusal

        self.assertIn("ran_to_the_end", Refusal.__dataclass_fields__)


#: A repository whose database is a dict their own factory returns, and whose
#: answer is three of their own functions deep. Both shapes are measured on
#: one 2026 week 1 repository, and neither is expressible as a pair of
#: callables: the first argument of their store and their query is an object
#: nothing else in the search produces, and their query returns a vote tally
#: rather than a name.
FACTORY_REPO = '''
def make_features(value, rate):
    return [(value * 2, rate)]


def create_database():
    return {}


def add_fingerprints(database, item_id, features):
    for key in features:
        database.setdefault(key, []).append(item_id)


def query_database(database, features):
    votes = {}
    for key in features:
        for item_id in database.get(key, []):
            votes[item_id] = votes.get(item_id, 0) + 1
    return votes


def get_sorted_matches(votes):
    return sorted(votes.items(), key=lambda pair: -pair[1])


def get_sorted_songs(matches):
    return [item_id for item_id, _votes in matches]
'''


def _is_factory(candidate):
    """A week's own answer to "what does an empty database look like"."""

    import inspect

    try:
        inspect.signature(candidate.call).bind()
    except (TypeError, ValueError):
        return False
    try:
        made = candidate.call()
    except BaseException:  # noqa: BLE001
        return False
    return isinstance(made, dict) and not made


def _ranked_grades(answer):
    """A ranked list naming the right item first, read off the answer alone."""

    ok = bool(isinstance(answer, list) and answer and answer[0] == "alpha")
    return ok, "asked for alpha and got {}".format(answer)


def _ranked_accepts(chain, enroll_call, query_call):
    """Enroll two items and require a ranked list naming the right one."""

    enrolled, detail = _enrol(chain, enroll_call)
    if not enrolled or query_call is None:
        return enrolled, detail
    try:
        answer = query_call(chain[0].call(7, 44100))
    except BaseException as error:  # noqa: BLE001
        return False, "querying raised {}".format(type(error).__name__)
    return _ranked_grades(answer)


class TheirDatabaseIsAnObjectTheirOwnFactoryMakes(unittest.TestCase):
    """P9. `add_fingerprints(db, id, fps)` and `query_database(db, fps)` both
    take a database as their first argument, and no pairing of their
    functions can be tried until something makes one."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(FACTORY_REPO)

    def _resolve(self, **kwargs):
        return resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_ranked_accepts,
            grades=_ranked_grades,
            arrangements=_arrangements,
            **kwargs,
        )

    def test_without_a_factory_and_readers_the_repository_is_refused(self):
        """The refusal is correct before this existed, and it is the baseline
        the two additions have to beat."""

        submission = self._resolve()

        self.assertFalse(submission.ready)

    def test_their_factory_and_their_readers_together_resolve_it(self):
        submission = self._resolve(factories=_is_factory, readers=2)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.attempt.enroll, "theirs.add_fingerprints")
        self.assertEqual(submission.attempt.query, "theirs.query_database")
        record = submission.to_dict()
        self.assertEqual(record["factory"], "theirs.create_database")
        self.assertEqual(
            record["readers"],
            ["theirs.get_sorted_matches", "theirs.get_sorted_songs"],
        )

    def test_a_scored_run_starts_from_an_empty_database_of_their_own(self):
        """Proving the binding enrolled two fixture items into the database
        the factory made, and scoring from there would rank them against the
        benchmark's real catalog."""

        submission = self._resolve(factories=_is_factory, readers=2)
        submission.enroll("gamma", [(14, 44100)])

        self.assertEqual(submission.query([(14, 44100)]), ["gamma"])

    def test_a_week_that_declares_neither_runs_the_same_search_as_before(self):
        (self.tmp / "theirs.py").write_text(REPO)

        without = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
        )
        with_declared = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
            factories=None,
            readers=0,
        )

        self.assertEqual(without.attempt, with_declared.attempt)
        self.assertEqual(without.attempts_tried, with_declared.attempts_tried)


class EverythingSuppliedIsOnTheRecord(unittest.TestCase):
    """A score computed with a resource the benchmark provided is a different
    claim from one computed without it, so the record says which."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_side_input_appears_under_supplied(self):
        (self.tmp / "embedder.py").write_text(
            "def embed(items, glove):\n    return [glove[i] for i in items]\n"
        )
        role = Role(
            "search",
            (
                Stage(
                    "text",
                    produces=lambda v: isinstance(v, list),
                    extras=("glove",),
                ),
            ),
        )

        submission = resolve(
            self.tmp,
            chain_role=role,
            fixture=(["a"],),
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
            extras={"glove": {"a": 1}},
        )

        self.assertTrue(submission.ready)
        self.assertEqual(
            submission.to_dict()["supplied"],
            [{"step": "embedder.embed", "supplied": "glove"}],
        )

    def test_the_record_says_whether_hashing_was_pinned(self):
        """Their IDF table is built by iterating a set in one repository, so
        the order words land in it depends on string hashing. Recorded rather
        than asserted: an interpreter's seed is fixed before it starts."""

        (self.tmp / "plain.py").write_text(
            "def feats(value, rate):\n    return [(value, rate)]\n"
        )

        record = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
        ).to_dict()

        self.assertIn("hashRandomization", record)
        self.assertIsInstance(record["hashRandomization"], bool)


class TheChildRunsWithHashingPinned(unittest.TestCase):
    """`cogbench.isolate` is where discovery actually runs, and everything it
    starts inherits the seed it sets."""

    @unittest.skipUnless(hasattr(os, "fork"), "requires os.fork process isolation")
    def test_the_child_environment_pins_the_hash_seed(self):
        from cogbench.isolate import COMPLETED, run_isolated

        outcome = run_isolated(lambda: os.environ.get("PYTHONHASHSEED"))

        self.assertEqual(outcome.status, COMPLETED)
        self.assertEqual(outcome.value, "0")


class ARememberedCallIsReplayedWholeNotJustItsName(unittest.TestCase):
    """A step replayed without the side input, the per-item loop, or the part
    of each item's result it produced is a call their code never received."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "sideinputs.py").write_text(
            "def embed(one, glove):\n    return ('box', glove[one])\n"
        )

    def _resolve(self):
        role = Role(
            "search",
            (
                Stage(
                    "text",
                    produces=lambda v: isinstance(v, list) and isinstance(v[0], int),
                    extras=("glove",),
                    per_item=True,
                ),
            ),
        )
        return resolve(
            self.tmp,
            chain_role=role,
            fixture=(["a", "b"],),
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
            extras={"glove": {"a": 1, "b": 2, "z": 9}},
            remember=True,
        )

    def test_the_plan_survives_a_replay_and_the_resource_is_looked_up_again(self):
        first = self._resolve()
        self.assertTrue(first.ready)
        self.assertEqual(first.chain[0].plan, ("value", "extra:glove"))
        self.assertTrue(first.chain[0].per_item)
        self.assertEqual(first.chain[0].element, 1)

        second = self._resolve()

        self.assertTrue(second.recalled)
        self.assertEqual(second.chain[0].plan, ("value", "extra:glove"))
        self.assertEqual(second.chain[0].bound(["z"]), [9])

    def test_an_entry_that_does_not_say_how_a_step_was_called_is_discarded(self):
        import json

        self._resolve()
        path = memo.cache_path(self.tmp)
        record = json.loads(path.read_text())
        del record["binding"]["plans"]
        path.write_text(json.dumps(record))

        again = self._resolve()

        self.assertFalse(again.recalled)
        self.assertEqual(again.chain[0].plan, ("value", "extra:glove"))


class EverythingSuppliedToTheirCodeIsDisclosed(unittest.TestCase):
    """A score computed with a resource the benchmark handed over is a
    different claim from one computed without it, so the record has to name
    every one of them.

    A fit stage is a call like any other and takes side inputs like any
    other: week 3's IDF tables are computed as `fit(corpus, glove)`. Only the
    "computed once" line was recorded for a fit, so the GloVe vectors that
    call was given never appeared under "supplied" and the run page
    understated what the benchmark had provided.
    """

    def _submission(self):
        from cogbench.pipeline import Candidate
        from cogbench.resolve import Submission
        from cogbench.verdict import scored

        glove = {"a": [0.0]}
        fit = Candidate("embedder.compute_idfs", lambda *a: {}, "embedder").with_plan(
            ("value", "extra:glove"), {"glove": glove}
        )
        use = Candidate("embedder.embed", lambda *a: [], "embedder").with_plan(
            ("value", "extra:idf"), {"idf": {}}
        )
        return Submission(
            scored("text_mrr", 0.5),
            chain=(use,),
            fits=(("idf", fit),),
        )

    def test_a_fit_stages_own_resource_is_named(self):
        supplied = self._submission().to_dict()["supplied"]

        self.assertIn(
            {"step": "embedder.compute_idfs", "supplied": "glove"}, supplied
        )

    def test_the_fit_is_still_reported_as_computed_once(self):
        supplied = self._submission().to_dict()["supplied"]

        self.assertIn(
            {"step": "embedder.compute_idfs", "supplied": "computed once as idf"},
            supplied,
        )

    def test_and_an_ordinary_steps_resources_are_unchanged(self):
        supplied = self._submission().to_dict()["supplied"]

        self.assertIn({"step": "embedder.embed", "supplied": "idf"}, supplied)


class TheRecordSaysWhichHashSeedTheRunHad(unittest.TestCase):
    """"Randomization was off" is not enough to reproduce a run: two pinned
    runs under different seeds are two different programs. A reader has to be
    able to tell "pinned at 0" from "we do not know"."""

    def test_a_pinned_run_records_the_seed(self):
        import subprocess

        source = (
            "import json, sys\n"
            "sys.path.insert(0, {src!r})\n"
            "from cogbench.resolve import Submission\n"
            "from cogbench.verdict import scored\n"
            "print(json.dumps(Submission(scored('m', 1.0)).to_dict()['hashSeed']))\n"
        ).format(src=str(ROOT / "python" / "cogbench" / "src"))

        done = subprocess.run(
            [sys.executable, "-c", source],
            capture_output=True,
            text=True,
            env=dict(os.environ, PYTHONHASHSEED="0"),
        )

        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), '"0"')

    def test_an_unpinned_run_says_it_does_not_know(self):
        """CPython keeps the seed it chose private, so the honest record is
        null rather than a number this process guessed."""

        import subprocess

        source = (
            "import json, sys\n"
            "sys.path.insert(0, {src!r})\n"
            "from cogbench.resolve import Submission\n"
            "from cogbench.verdict import scored\n"
            "print(json.dumps(Submission(scored('m', 1.0)).to_dict()['hashSeed']))\n"
        ).format(src=str(ROOT / "python" / "cogbench" / "src"))

        environment = dict(os.environ)
        environment.pop("PYTHONHASHSEED", None)
        environment["PYTHONHASHSEED"] = "random"
        done = subprocess.run(
            [sys.executable, "-c", source],
            capture_output=True,
            text=True,
            env=environment,
        )

        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), "null")


class _Encoder:
    """One of their objects, built and loaded by the benchmark from a path."""

    def __call__(self, rows):
        return [row * 3 for row in rows]


class AnObjectTheBenchmarkHandedOverIsAStepOnTheRecord(unittest.TestCase):
    """G4. Bagel's week 3 image encoder is their own `ImageToCaption`, built
    with no arguments and loaded from their pickle by the benchmark. Nothing
    in the repository can serve that stage: `methods_of` skips `__call__`
    and the loaded instance lives in the extras pool. A step that was not one
    of their functions at all is the largest thing a run can supply, so it is
    the one thing that must never be missing from the record."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text("def unrelated(x):\n    return None\n")

    def _submission(self):
        role = Role(
            "search",
            (
                Stage(
                    "image",
                    produces=lambda v: isinstance(v, list),
                    extras=("weights_model",),
                ),
            ),
        )
        return resolve(
            self.tmp,
            chain_role=role,
            fixture=([1, 2],),
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
            extras={"weights_model": _Encoder()},
        )

    def test_the_stage_binds_to_the_object_the_week_put_in_the_pool(self):
        submission = self._submission()

        self.assertTrue(submission.ready)
        self.assertEqual(
            [step.label for step in submission.chain], ["weights_model (_Encoder)"]
        )

    def test_it_appears_under_supplied(self):
        supplied = self._submission().to_dict()["supplied"]

        self.assertIn(
            {
                "step": "weights_model (_Encoder)",
                "supplied": "weights_model (_Encoder) handed to the chain as this step",
            },
            supplied,
        )


class ASurfaceTheRepositoryDoesNotHaveIsNamedRatherThanScored(unittest.TestCase):
    """G6. A week 3 repository with no trained weights has no image side, and
    the decided policy withholds those numbers rather than zeroing them. The
    run then has to say which surface is absent and how far the search got
    looking for it, in their terms."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(
            "def embed(texts):\n    return [len(t) for t in texts]\n"
        )

    def _submission(self):
        role = Role(
            "search",
            (),
            branches=(
                Role(
                    "text",
                    (Stage("text", produces=lambda v: isinstance(v, list)),),
                    fixture=(["a"],),
                ),
                Role(
                    "image",
                    (Stage("image", produces=lambda v: isinstance(v, dict)),),
                    fixture=([1],),
                    optional=True,
                ),
            ),
        )
        return resolve(
            self.tmp,
            chain_role=role,
            fixture=(["a"],),
            accepts=lambda chains, *_: (True, ""),
            arrangements=None,
        )

    def test_the_half_that_works_still_resolves(self):
        submission = self._submission()

        self.assertEqual(
            submission.to_dict()["branches"], {"text": ["theirs.embed"]}
        )

    def test_the_record_names_the_surface_that_is_not_there(self):
        record = self._submission().to_dict()["missing"]

        self.assertEqual(sorted(record), ["image"])
        self.assertEqual(record["image"]["stage"], "image")
        self.assertIn("nothing accepted", record["image"]["detail"])

    def test_a_role_whose_branches_all_bound_records_no_missing(self):
        role = Role(
            "search",
            (),
            branches=(
                Role(
                    "text",
                    (Stage("text", produces=lambda v: isinstance(v, list)),),
                    fixture=(["a"],),
                ),
            ),
        )
        submission = resolve(
            self.tmp,
            chain_role=role,
            fixture=(["a"],),
            accepts=lambda chains, *_: (True, ""),
            arrangements=None,
        )

        self.assertNotIn("missing", submission.to_dict())


class ABranchBindingIsReadyToScore(unittest.TestCase):
    """A role made of branches leaves `chain` empty; the branches are the
    binding, and `ready` has to read them or the CLI refuses to score a
    repository the search just bound."""

    def test_ready_reads_the_branches(self):
        import tempfile, shutil
        from cogbench.pipeline import Role, Stage

        tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "theirs.py").write_text("def embed(xs):\n    return [[1.0] for _ in xs]\n")
        role = Role("all", (), branches=(Role("text", (Stage("text", produces=lambda v: isinstance(v, list)),), fixture=(["a"],)),))
        found = resolve(tmp, chain_role=role, fixture=(["a"],), accepts=lambda chains, *_: (True, ""), arrangements=None)
        self.assertEqual(found.verdict.status, SCORED)
        self.assertTrue(found.branches)
        self.assertTrue(found.ready)


class WhatTheRepositoryItselfSuppliesIsReadOnceTheRootIsKnown(unittest.TestCase):
    """A week 3 team's trained projection is a file in their repository. The
    spec is built before any repository is chosen, so it cannot hold the
    matrix; a hook run after discovery picks the root reads it and puts it in
    the pool. Without this every repository read as having no weights, with
    `data/W_embed.npy` sitting in the tree."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(
            "def project(rows, W):\n    return [r * W for r in rows]\n"
        )
        self.role = Role(
            "image",
            (Stage("image", produces=lambda v: isinstance(v, list), extras=("W",)),),
        )

    def test_the_hook_sees_the_chosen_root_and_the_loaded_modules(self):
        seen = {}

        def prepare(root, modules):
            seen["root"] = root
            seen["modules"] = [m.__name__ for m in modules]
            return {"W": 3}

        submission = resolve(
            self.tmp,
            chain_role=self.role,
            fixture=([1, 2],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
            prepare=prepare,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(seen["root"], self.tmp)
        self.assertEqual(seen["modules"], ["theirs"])

    def test_the_weights_the_hook_captured_are_recorded_and_kept_out_of_the_pool(self):
        weights = self.tmp / "data"
        weights.mkdir(exist_ok=True)
        (weights / "b.npy").write_bytes(b"second")
        (weights / "a.npy").write_bytes(b"first")

        def prepare(root, modules, capture=None):
            # Loading through `capture` is what declares the weight; the hook
            # does not name it a second time.
            for name in ("b.npy", "a.npy"):
                capture(root / "data" / name)
            return {"W": 3}

        submission = resolve(
            self.tmp,
            chain_role=self.role,
            fixture=([1, 2],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
            prepare=prepare,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.weights_used, ("data/a.npy", "data/b.npy"))
        self.assertEqual(submission.to_dict()["weightsUsed"], ["data/a.npy", "data/b.npy"])
        # No `weights_consumed`, so the week never said this binding read
        # them. The names stay; the receipts are unestablished.
        self.assertIsNone(submission.weights_captured)
        self.assertIsNone(submission.to_dict()["weightsCaptured"])

    def test_a_week_that_says_its_binding_consumed_them_gets_the_receipts(self):
        weights = self.tmp / "data"
        weights.mkdir(exist_ok=True)
        (weights / "b.npy").write_bytes(b"second")
        (weights / "a.npy").write_bytes(b"first")

        def prepare(root, modules, capture=None):
            for name in ("b.npy", "a.npy"):
                capture(root / "data" / name)
            return {"W": 3}

        submission = resolve(
            self.tmp,
            chain_role=self.role,
            fixture=([1, 2],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
            prepare=prepare,
            weights_consumed=lambda made: True,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        captured = submission.to_dict()["weightsCaptured"]
        self.assertEqual([item["path"] for item in captured], ["data/a.npy", "data/b.npy"])
        self.assertEqual([item["size"] for item in captured], [len(b"first"), len(b"second")])

    def test_a_hook_may_name_weights_it_did_not_capture(self):
        """Naming without retaining scores locally and publishes no receipt;
        the extras it returned alongside still reach the search."""

        submission = resolve(
            self.tmp,
            chain_role=self.role,
            fixture=([1, 2],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
            prepare=lambda root, modules: {"W": 3, "weights_used": ["data/a.npy"]},
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.weights_used, ("data/a.npy",))
        self.assertIsNone(submission.weights_captured)

    def test_the_benchmarks_own_extras_win_over_the_repositorys(self):
        submission = resolve(
            self.tmp,
            chain_role=self.role,
            fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [5], ""),
            arrangements=None,
            extras={"W": 5},
            prepare=lambda root, modules: {"W": 3},
        )

        self.assertTrue(submission.ready, submission.verdict.headline)

    def test_prepare_runs_under_the_existing_guard_in_scratch(self):
        guarded = []
        original_cwd = Path.cwd()
        resource = self.tmp / "benchmark-resource.txt"
        resource.write_text("course artifact")

        def guard(call, *args, **kwargs):
            guarded.append(True)
            try:
                return call(*args, **kwargs)
            finally:
                guarded.pop()

        conversions = []

        class Prepared(Mapping):
            def __len__(self):
                conversions.append(bool(guarded))
                return 1

            def __iter__(self):
                conversions.append(bool(guarded))
                return iter(("W",))

            def __getitem__(self, key):
                conversions.append(bool(guarded))
                return 3

        def prepare(root, modules):
            self.assertTrue(guarded)
            self.assertNotEqual(Path.cwd(), original_cwd)
            self.assertNotEqual(Path.cwd(), root)
            Path("prepare-created.txt").write_text("scratch only")
            self.assertEqual(os.environ["COGWORKS_LANGUAGE_DATA"], str(resource.parent))
            self.assertEqual(resource.read_text(), "course artifact")
            return Prepared()

        with patch("cogbench.resolve._under_clock", side_effect=guard) as clock:
            submission = resolve(
                self.tmp, chain_role=self.role, fixture=([1],),
                accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
                arrangements=None, prepare=prepare,
                resource_files={"course-artifact.txt": resource},
            )
        self.assertTrue(submission.ready, submission.verdict.headline)
        clock.assert_called_once()
        self.assertTrue(conversions)
        self.assertTrue(all(conversions))
        self.assertEqual(Path.cwd(), original_cwd)
        self.assertFalse((self.tmp / "prepare-created.txt").exists())

    def test_prepare_timeout_uses_the_existing_refusal_without_waiting(self):
        original_cwd = Path.cwd()

        def prepare(root, modules):
            self.fail("the patched guard must cut off the hook")

        with patch(
            "cogbench.resolve._under_clock",
            side_effect=_Timeout("prepare exhausted the existing clock"),
        ) as clock:
            submission = resolve(
                self.tmp, chain_role=self.role, fixture=([1],),
                accepts=lambda chain, *_: (True, ""),
                arrangements=None, prepare=prepare,
            )
        clock.assert_called_once()
        self.assertEqual(submission.verdict.status, NOT_READ)
        self.assertIn("prepare exhausted the existing clock", submission.verdict.headline)
        self.assertEqual(Path.cwd(), original_cwd)

    def test_a_hook_that_raises_refuses_with_its_own_words(self):
        def prepare(root, modules):
            raise RuntimeError("two files could be the projection: a.npy, b.npy")

        submission = resolve(
            self.tmp,
            chain_role=self.role,
            fixture=([1],),
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
            prepare=prepare,
        )

        self.assertEqual(submission.verdict.status, NOT_READ)
        self.assertIn("two files could be the projection", submission.verdict.headline)


class AValueTheirModuleComputedWhenItLoadedCanAnswerAFitStage(unittest.TestCase):
    """One 2026 repository has no IDF function. `text_to_image` builds `idf`
    at module scope in a loop over the course captions and every embedding
    call reads the global. The computation is theirs and it ran; a fit stage
    that only calls functions reported that nothing produced the table."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _role(self):
        return Role(
            "search",
            (
                Stage(
                    "idfs",
                    fit=True,
                    fixture=(["a", "b"],),
                    produces=lambda v: isinstance(v, dict) and all(
                        isinstance(x, float) for x in v.values()
                    ),
                ),
                Stage("text", produces=lambda v: isinstance(v, list), extras=("idfs",)),
            ),
        )

    def test_the_module_value_is_used_and_disclosed(self):
        (self.tmp / "theirs.py").write_text(
            "idf = {'a': 0.5, 'b': 1.5}\n"
            "counts = {'a': 2, 'b': 1}\n"
            "def embed(texts, idfs):\n    return [idfs[t] for t in texts]\n"
        )

        submission = resolve(
            self.tmp,
            chain_role=self._role(),
            fixture=(["a"],),
            accepts=lambda chain, *_: (chain[0].bound(["b"]) == [1.5], ""),
            arrangements=None,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        record = submission.to_dict()
        self.assertEqual(record["fits"], [["idfs", "theirs.idf"]])
        notes = [row["supplied"] for row in record["supplied"]]
        self.assertIn(
            "read from theirs.idf, a value their module computes when it loads", notes
        )

    def test_one_of_their_functions_is_preferred_over_a_module_value(self):
        (self.tmp / "theirs.py").write_text(
            "idf = {'a': 0.5}\n"
            "def compute_idfs(corpus):\n    return {w: 2.5 for w in corpus}\n"
            "def embed(texts, idfs):\n    return [idfs[t] for t in texts]\n"
        )

        submission = resolve(
            self.tmp,
            chain_role=self._role(),
            fixture=(["a"],),
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.to_dict()["fits"], [["idfs", "theirs.compute_idfs"]])


class EveryTrialRecomputesTheirSideInputs(unittest.TestCase):
    """A fit stage is one of their functions, so its value belongs to whichever
    reading of the repository ran it.

    Carrying the search's value onto a fresh reading would put half the old
    namespace back: the table came out of the modules the search filled, and
    handing it to fresh code makes a run that is half one reading and half
    another. So the fit runs again, on the fixture its own stage declared.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.ran = _recording(self)

    def _role(self, **stage):
        return Role(
            "search",
            (
                Stage("idfs", fit=True, fixture=(["a", "b"],),
                      produces=lambda v: isinstance(v, dict), **stage),
                Stage("text", produces=lambda v: isinstance(v, list), extras=("idfs",)),
            ),
        )

    def test_their_fit_function_runs_again_on_each_reading(self):
        (self.tmp / "theirs.py").write_text(
            RECORDER
            + "SEEN = []\n"
            "def compute_idfs(corpus):\n"
            "    _record('fit')\n"
            "    SEEN.append(1)\n"
            "    return {w: float(len(SEEN)) for w in corpus}\n"
            "def embed(texts, idfs):\n    return [idfs[t] for t in texts]\n"
        )

        submission = resolve(
            self.tmp,
            chain_role=self._role(),
            fixture=(["a"],),
            accepts=lambda chain, *_: (chain[0].bound(["b"]) == [1.0], ""),
            arrangements=None,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        # Their counter is per reading, so every run of the fit sees an empty
        # SEEN and answers 1.0. A carried-over table would answer with
        # whatever the search's last call left.
        self.assertGreater(self.ran().count("fit"), 1)
        self.assertEqual(submission.chain[0].bound(["b"]), [1.0])
        self.assertEqual(submission.fresh().chain[0].bound(["b"]), [1.0])

    def test_a_module_value_fit_is_read_off_the_new_module(self):
        """Its export is recorded, so there is no need to look inside the
        helper the search built around the old module's object."""

        (self.tmp / "theirs.py").write_text(
            "idf = {'a': 0.5, 'b': 1.5}\n"
            "def embed(texts, idfs):\n    return [idfs[t] for t in texts]\n"
        )

        submission = resolve(
            self.tmp,
            chain_role=self._role(),
            fixture=(["a"],),
            accepts=lambda chain, *_: (chain[0].bound(["b"]) == [1.5], ""),
            arrangements=None,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.to_dict()["fits"], [["idfs", "theirs.idf"]])
        table = submission.fits[0][1].bound()
        other = submission.fresh()
        self.addCleanup(other.close)

        self.assertEqual(table, {"a": 0.5, "b": 1.5})
        # Each run reads the value off its own module, so the two are equal
        # and are not one object. Carrying the search's would make them one.
        self.assertEqual(other.fits[0][1].bound(), table)
        self.assertIsNot(other.fits[0][1].bound(), table)

    def test_two_branches_may_both_declare_a_stage_called_idfs(self):
        """Branch-local stage names repeat, and the two are different values.
        Keyed by name alone, one branch's table would answer for the other."""

        (self.tmp / "theirs.py").write_text(
            "def idfs_of(corpus):\n    return {w: float(len(w)) for w in corpus}\n"
            "def embed(texts, idfs):\n    return [idfs[t] for t in texts]\n"
        )
        branch = lambda name, words: Role(
            name,
            (
                Stage("idfs", fit=True, fixture=(words,),
                      produces=lambda v: isinstance(v, dict)),
                Stage(name, produces=lambda v: isinstance(v, list), extras=("idfs",)),
            ),
            fixture=([words[0]],),
        )
        role = Role("search", (), branches=(branch("short", ["a"]), branch("long", ["abcd"])))

        submission = resolve(
            self.tmp,
            chain_role=role,
            fixture=(["a"],),
            # Each branch is judged as it binds, so only the branches bound so
            # far are here. Whichever are present must answer with their own
            # table rather than with the other branch's.
            accepts=lambda chains, *_: (
                all(
                    chains[name][0].bound([word]) == [float(len(word))]
                    for name, word in (("short", "a"), ("long", "abcd"))
                    if name in chains
                ),
                "",
            ),
            arrangements=None,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        ready = submission.fresh()
        self.assertEqual(ready.branches["short"][0].bound(["a"]), [1.0])
        self.assertEqual(ready.branches["long"][0].bound(["abcd"]), [4.0])

    def test_a_declared_resource_that_cannot_be_made_again_is_refused_by_name(self):
        """Their code is handed this one, so there is nothing honest to do
        with a copy that failed except say which input it was."""

        (self.tmp / "theirs.py").write_text(
            "def embed(texts, table):\n    return [table.get(t, 0) for t in texts]\n"
        )
        role = Role(
            "search",
            (Stage("text", produces=lambda v: isinstance(v, list), extras=("table",)),),
        )
        nested = 0
        for _ in range(600):
            nested = [nested]

        submission = resolve(
            self.tmp,
            chain_role=role,
            fixture=(["a"],),
            accepts=lambda chain, *_: (True, ""),
            arrangements=None,
            extras={"table": {"a": 1, "deep": nested}},
        )

        self.assertFalse(submission.ready)
        self.assertEqual(submission.verdict.status, NOT_READ)
        self.assertIn("table", submission.verdict.headline)
        self.assertIn("benchmark_inputs", submission.verdict.headline)


class WhatOneTrialIsHandedIsOneGraph(unittest.TestCase):
    """Their code must receive what the benchmark shares, and nothing a
    previous trial touched.

    Two things have to hold at once and they pull in opposite directions.
    Across trials, every mutable input is a separate object, or one trial
    writes into the next one's. Within one trial, two steps taking the same
    resource take the SAME object, because that is the program the week wrote:
    a week whose first stage reads the caption table a later stage also
    declares handed their code one table, and reconstructing it twice would
    hand them two.

    These read what their functions actually received. Checking the record on
    the step instead would pass while the call used the search's value, which
    is a defect this has already had.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_two_steps_of_one_trial_are_handed_one_object(self):
        (self.tmp / "theirs.py").write_text(
            "def first(rows, table):\n"
            "    table.append('first')\n"
            "    return [len(table)]\n"
            "def second(counts, table):\n"
            "    return (len(table), counts)\n"
        )
        role = Role(
            "search",
            (
                Stage("one", produces=lambda v: isinstance(v, list), extras=("table",)),
                Stage("two", produces=lambda v: isinstance(v, tuple), extras=("table",)),
            ),
        )
        seen = []

        def accepts(chain, *_):
            # Their first step appends to the table; their second step reads
            # the same table and sees that append. One object, or the count
            # their second step reads is zero.
            seen.append(chain[1].bound(chain[0].bound([1])))
            return True, ""

        submission = resolve(
            self.tmp, chain_role=role, fixture=([1],), accepts=accepts,
            arrangements=None, extras={"table": []},
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(seen[-1], (1, [1]))
        self.assertIs(
            submission.chain[0].supplied["table"],
            submission.chain[1].supplied["table"],
        )

    def test_the_case_and_a_declared_resource_stay_one_object(self):
        """A week may put the same table in the case and in the pool. Copying
        them apart makes a program the week did not write."""

        (self.tmp / "theirs.py").write_text(
            "def go(rows, table):\n    return [rows is table]\n"
        )
        role = Role(
            "search",
            (Stage("one", produces=lambda v: isinstance(v, list), extras=("table",)),),
        )
        shared = [1]
        answers = []

        def accepts(chain, case):
            answers.append(chain[0].bound(case))
            return answers[-1] == [True], ""

        submission = resolve(
            self.tmp, chain_role=role, fixture=(shared,), accepts=accepts,
            arrangements=None, extras={"table": shared},
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(answers[-1], [True])

    def test_a_renewed_resource_is_what_their_function_actually_receives(self):
        """The record on a step and the value its call reads have to be the
        same value. They were not: the call was sealed before the resource
        was renewed, so a step reported the new one and ran on the old."""

        (self.tmp / "theirs.py").write_text(
            "def go(rows, table):\n    return [table['which']]\n"
        )
        role = Role(
            "search",
            (Stage("one", produces=lambda v: isinstance(v, list), extras=("table",)),),
        )

        submission = resolve(
            self.tmp, chain_role=role, fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [["benchmark"]], ""),
            arrangements=None, extras={"table": {"which": ["benchmark"]}},
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        step = submission.chain[0]
        # A list rather than a string on purpose: equal strings are usually
        # the same object, so comparing them would pass even when the call
        # ran on the search's table and the record showed this run's.
        self.assertEqual(step.supplied["table"], {"which": ["benchmark"]})
        self.assertIs(step.bound([1])[0], step.supplied["table"]["which"])

    def test_two_runs_of_one_binding_do_not_share_a_resource(self):
        (self.tmp / "theirs.py").write_text(
            "def go(rows, table):\n"
            "    table.append(len(table))\n"
            "    return [len(table)]\n"
        )
        role = Role(
            "search",
            (Stage("one", produces=lambda v: isinstance(v, list), extras=("table",)),),
        )
        shared = []

        submission = resolve(
            self.tmp, chain_role=role, fixture=([1],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [1], ""),
            arrangements=None, extras={"table": shared},
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        # The search probes their chain with the pool the week passed, which
        # is the pipeline's own call and not this module's to change. What is
        # this module's is every call after it.
        probed = list(shared)
        first, second = submission.fresh(), submission.fresh()
        # Each run appends to its own table, so both count 1.
        self.assertEqual(first.chain[0].bound([1]), [1])
        self.assertEqual(second.chain[0].bound([1]), [1])
        self.assertEqual(first.chain[0].bound([1]), [2])
        self.assertEqual(shared, probed)


class ALaterBranchTakesWhatAnEarlierBranchProducedOnThisReading(unittest.TestCase):
    """`_resolve_branches` puts what each branch produced into the pool under
    that branch's own name, and a later branch may declare it. Bagel's week 3
    `CaptionImageQuery(EMBEDDINGS, ids)` is that shape.

    It is one of their values, so it belongs to whichever reading made it.
    Carrying the search's would put the old namespace back; refusing it would
    refuse a supported week. It is recomputed by running the earlier branch's
    renewed chain on this reading.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # `project` counts its own calls in a module global, so a value made
        # on one reading is tellable from a value made on another.
        (self.tmp / "theirs.py").write_text(
            "RUNS = []\n"
            "def project(rows):\n"
            "    RUNS.append(1)\n"
            "    return [r * 10 + len(RUNS) for r in rows]\n"
            "def index(ids, image):\n"
            "    return {i: v for i, v in zip(ids, image)}\n"
        )
        self.role = Role(
            "all",
            (),
            branches=(
                Role(
                    "image",
                    (Stage("image", produces=lambda v: isinstance(v, list)),),
                    fixture=([1, 2],),
                ),
                Role(
                    "prepare",
                    (Stage("prepare", produces=lambda v: isinstance(v, dict),
                           extras=("image",)),),
                    fixture=(["a", "b"],),
                ),
            ),
        )

    def _resolve(self, accepts):
        return resolve(
            self.tmp, chain_role=self.role, fixture=([1, 2],),
            accepts=accepts, arrangements=None,
        )

    def test_the_branch_output_is_made_again_rather_than_carried(self):
        seen = []

        def accepts(chains, *_):
            if "prepare" not in chains:
                return True, ""
            seen.append(chains["prepare"][0].bound(["a", "b"]))
            return True, ""

        submission = self._resolve(accepts)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(
            submission.to_dict()["branches"],
            {"image": ["theirs.project"], "prepare": ["theirs.index"]},
        )
        # `project` ran once on this reading, so its counter reads 1 rather
        # than continuing the search's count.
        self.assertEqual(seen[-1], {"a": 11, "b": 21})

    def test_two_independent_runs_each_make_their_own_branch_output(self):
        submission = self._resolve(lambda chains, *_: (True, ""))
        self.assertTrue(submission.ready, submission.verdict.headline)

        first, second = submission.fresh(), submission.fresh()

        for run in (first, second, first, second):
            # Each run read the repository for itself, so each one's `project`
            # has run exactly once and both answer the same.
            self.assertEqual(
                run.branches["prepare"][0].bound(["a", "b"]), {"a": 11, "b": 21}
            )


class ARefusalOnOneChainDoesNotDecideTheRepository(unittest.TestCase):
    """Two separate claims the report used to make and could not support.

    A chain that could not be put back on a fresh reading says nothing about
    the chain the search tried next, and a repository whose second chain binds
    is a repository that binds. And when no chain could be put back at all,
    the week's test was never reached, so "your code ran end to end and
    answered differently" describes something nobody observed.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_later_chain_still_binds_after_an_earlier_one_could_not(self):
        (self.tmp / "theirs.py").write_text(
            "def early(rows):\n    return [r + 1 for r in rows]\n"
            "def later(rows):\n    return [r + 2 for r in rows]\n"
        )
        role = Role(
            "search",
            (Stage("one", produces=lambda v: isinstance(v, list)),),
        )
        refusals = {"left": 1}
        real = Project.rebind

        def sometimes(self, candidate, finish=None):
            # The first chain offered cannot be put back; the next one can.
            if refusals["left"] > 0 and candidate.label.endswith(".early"):
                refusals["left"] -= 1
                raise Unmapped("file_missing", candidate.label, "not this time")
            return real(self, candidate, finish)

        with patch.object(Project, "rebind", sometimes):
            submission = resolve(
                self.tmp, chain_role=role, fixture=([1],),
                accepts=lambda chain, *_: (True, ""), arrangements=None,
            )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.verdict.status, SCORED)

    def test_a_repository_never_asked_is_not_told_it_answered_wrongly(self):
        (self.tmp / "theirs.py").write_text(
            "def only(rows):\n    return [r + 1 for r in rows]\n"
        )
        role = Role(
            "search",
            (Stage("one", produces=lambda v: isinstance(v, list)),),
        )

        def never(self, candidate, finish=None):
            raise Unmapped("file_missing", candidate.label, "gone on this reading")

        with patch.object(Project, "rebind", never):
            submission = resolve(
                self.tmp, chain_role=role, fixture=([1],),
                accepts=lambda chain, *_: (True, ""), arrangements=None,
                expects="one number per row",
            )

        self.assertFalse(submission.ready)
        self.assertEqual(submission.verdict.status, NOT_READ)
        self.assertIn("file_missing", submission.verdict.headline)
        # The sentence that would have been wrong.
        self.assertNotIn("different answer", submission.verdict.headline)


class EveryRunIsMadeFromTheBindingTheSearchFound(unittest.TestCase):
    """A run of a binding is made from the search's candidates, not from the
    previous run's.

    Discovery names a package directory after itself when this process does
    not already own that name, and after a counter when it does. The counter
    never restarts, so two readings of a repository holding a `json/` call its
    package two different things. Making the second run out of the first run's
    candidates then looks for a module named for a reading that has already
    been thrown away, and a repository that resolves refuses on its second
    scored run.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # Named for something the interpreter already holds, which is what
        # sends discovery to its counter.
        package = self.tmp / "json"
        package.mkdir()
        (package / "__init__.py").write_text(
            "def scale(rows):\n    return [r * 3 for r in rows]\n"
        )
        self.role = Role(
            "search", (Stage("one", produces=lambda v: isinstance(v, list)),)
        )

    def test_a_repository_whose_package_name_is_taken_runs_again_and_again(self):
        submission = resolve(
            self.tmp, chain_role=self.role, fixture=([1, 2],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
        )
        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertIn("_json.scale", submission.chain[0].label)

        run = submission
        for _ in range(3):
            # Each run is made from the search's binding, so the tenth is as
            # good as the first.
            run = run.fresh()
            self.assertEqual(run.chain[0].bound([1, 2]), [3, 6])


class AFitStageKeepsItsCourseFilesOnEveryRun(unittest.TestCase):
    """Their fit function may open the week's artifact, and the path it names
    is one this machine does not have.

    The search answers that read from the benchmark's own copy. A later run of
    the binding runs the fit again, and running it outside that mapping means
    their function opens a path that is not there.
    """

    def test_a_public_fresh_run_reads_the_benchmark_copy(self):
        tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        artifact = tmp / "course.txt"
        artifact.write_text("3")
        (tmp / "theirs.py").write_text(
            "from pathlib import Path\n"
            "import os\n"
            "def read_resource():\n"
            "    where = Path(os.environ['COGWORKS_LANGUAGE_DATA']) / 'course.txt'\n"
            "    return int(where.read_text().strip())\n"
            "def weights(corpus):\n"
            "    scale = read_resource()\n"
            "    return {w: scale for w in corpus}\n"
            "def embed(texts, weights):\n    return [weights[t] for t in texts]\n"
        )
        role = Role(
            "search",
            (
                Stage("weights", fit=True, fixture=(["a"],),
                      produces=lambda v: isinstance(v, dict)),
                Stage("text", produces=lambda v: isinstance(v, list),
                      extras=("weights",)),
            ),
        )

        submission = resolve(
            tmp, chain_role=role, fixture=(["a"],),
            accepts=lambda chain, *_: (chain[0].bound(["a"]) == [3], ""),
            arrangements=None, resource_files={"course.txt": artifact},
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        for run in (submission.fresh(), submission.fresh()):
            self.assertEqual(run.chain[0].bound(["a"]), [3])


class AMethodCarriedOutOfABranchNeedsThatBranchToHaveRun(unittest.TestCase):
    """A later branch may bind a method of the object an earlier branch's
    constructor stage built. Lashika's week 3 image step is that shape:
    `ImageDatabase(ids, descriptors, W).descriptor_to_embedding`, a method of
    the object the prepare branch builds.

    Nothing in that method's call says which branch it came from. It finds its
    object through the construction handle it shares with the step that built
    it, so on a fresh reading the owning branch has to run before the method
    can be called, even though no stage declares that branch's value.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(
            "class Store:\n"
            "    def __init__(self, rows):\n"
            "        self.rows = list(rows)\n"
            "    def lookup(self, keys):\n"
            "        return [self.rows[k] for k in keys]\n"
        )
        self.role = Role(
            "all",
            (),
            branches=(
                Role("prepare",
                     (Stage("prepare", produces=lambda v: hasattr(v, "lookup")),),
                     fixture=([10, 20],)),
                Role("search",
                     (Stage("search", produces=lambda v: isinstance(v, list)),),
                     fixture=([0, 1],)),
            ),
        )

    def _resolve(self, accepts):
        return resolve(
            self.tmp, chain_role=self.role, fixture=([0, 1],),
            accepts=accepts, arrangements=None,
        )

    def test_the_carried_method_answers_from_this_readings_object(self):
        answers = []

        def accepts(chains, *_):
            if "search" in chains:
                answers.append(chains["search"][0].bound([0, 1]))
            return True, ""

        submission = self._resolve(accepts)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(
            submission.to_dict()["branches"],
            {"prepare": ["theirs.Store"], "search": ["theirs.Store.lookup"]},
        )
        self.assertEqual(answers[-1], [10, 20])
        # No stage declares the prepare branch, so nothing in the call records
        # the dependency. It is the carried method's own branch that does.
        carried = submission.branches["search"][0]
        self.assertEqual(carried.branch, "prepare")
        self.assertEqual(
            [slot for slot in carried.plan if slot.startswith("extra:")], []
        )

    def test_independent_runs_each_build_their_own_object(self):
        submission = self._resolve(lambda chains, *_: (True, ""))
        self.assertTrue(submission.ready, submission.verdict.headline)

        first, second = submission.fresh(), submission.fresh()

        for run in (first, second, first, second):
            self.assertEqual(run.branches["search"][0].bound([0, 1]), [10, 20])
        self.assertIsNot(
            first.branches["search"][0].receiver, second.branches["search"][0].receiver
        )


class TheWeeksTestReadsTheStoreItsDriverJustBuilt(unittest.TestCase):
    """A week's acceptance test drives its adapter, and the adapter builds the
    database for the case it is judging. Two objects of their class are alive
    while it does: the one the renewal built on the branch fixture's rows, and
    the one the driver just built on this case's rows. The query reads the
    second while the binding is judged and after it is handed over, or the same
    adapter answers two different ways.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(
            "class Store:\n"
            "    def __init__(self, rows):\n"
            "        self.rows = list(rows)\n"
            "    def lookup(self, keys):\n"
            "        return [self.rows[k] for k in keys]\n"
        )
        self.role = Role(
            "all",
            (),
            branches=(
                Role("prepare",
                     (Stage("prepare", produces=lambda v: hasattr(v, "lookup")),),
                     fixture=([11, 22],)),
                Role("search",
                     (Stage("search", produces=lambda v: isinstance(v, list)),),
                     fixture=([0, 1],)),
            ),
        )
        self.answered = []

    def _driven(self, chains):
        """One pass through the branches the way a week's adapter runs them.

        Each branch runs in its own pool, and what one produced is carried to
        the next under its branch name; `language_search_benchmark`'s
        `DiscoveredSearch._through` is this shape.
        """

        live = {}
        with runtime_pool(live):
            built = chains["prepare"][0].bound([41, 52])
        live["prepare"] = built
        with runtime_pool(live):
            return chains["search"][0].bound([0, 1])

    def _accepts(self, chains, *_):
        if "search" not in chains:
            return True, ""
        self.answered.append(self._driven(chains))
        return self.answered[-1] == [41, 52], "read {}".format(self.answered[-1])

    def _resolve(self, accepts):
        return resolve(
            self.tmp, chain_role=self.role, fixture=([0, 1],),
            accepts=accepts, arrangements=None,
        )

    def test_the_driver_is_judged_on_the_rows_it_prepared(self):
        submission = self._resolve(self._accepts)

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(self.answered[-1], [41, 52])
        # The same driver, on the run the caller gets and on a second run of
        # the same binding: one answer, whoever is asking.
        for run in (submission, submission.fresh()):
            self.assertEqual(self._driven(run.branches), [41, 52])

    def test_a_test_that_calls_the_chain_itself_reads_the_renewed_object(self):
        seen = []

        def accepts(chains, *_):
            if "search" in chains:
                seen.append(chains["search"][0].bound([0, 1]))
            return True, ""

        submission = self._resolve(accepts)

        self.assertTrue(submission.ready, submission.verdict.headline)
        # No driver and no pool, so the object is the one the renewal built on
        # the branch fixture. A method still finds its own constructor's object.
        self.assertEqual(seen[-1], [11, 22])


class TheFixturePoolMakesNothingUntilItIsAsked(unittest.TestCase):
    """A week's branch fixture is handed the pool and may read any name in it.

    Reconstructing every resource first would refuse a run over a resource
    nobody reads, which is the contract `test_memo_contract` pins: an opaque
    entry is a deliberate memo miss and a working cold resolve. So listing,
    counting, iterating and membership make nothing, and only asking for a
    value by name does.

    Measured on both runtimes because they differ: Python 3.8's `ChainMap`
    fetches every value just to iterate keys, which is why this is a mapping
    of its own rather than one.
    """

    def setUp(self):
        self.made = []
        self.bundle = Bundle(
            fixture=([1],),
            extras={
                "rows": _Counted("rows", self.made, [1, 2]),
                "opaque": _Uncopyable(),
            },
            declared=("rows", "opaque"),
        )
        # The snapshot copied `rows` once. Count from here, so what a test
        # counts is what its own pool asked for.
        del self.made[:]

    def _pool(self, local=None):
        return self.bundle.again().pool(local)

    def test_names_membership_and_length_make_nothing(self):
        pool = self._pool({"image": ["theirs"]})

        # The order the caller supplied the pool in, then what their own code
        # produced. A week's fixture hook may iterate what it is handed, and
        # `_fixture_for` used to hand it a plain copy of the caller's dict.
        self.assertEqual(list(pool), ["rows", "opaque", "image"])
        self.assertEqual(len(pool), 3)
        self.assertIn("opaque", pool)
        self.assertIn("rows", pool)
        self.assertNotIn("absent", pool)
        self.assertEqual(sorted(pool.keys()), ["image", "opaque", "rows"])

        self.assertEqual(self.made, [])

    def test_a_product_overlaying_a_resource_keeps_that_names_position(self):
        """Their own value replaces the benchmark's under one name. It is the
        same name, so it stays where that name was rather than moving to the
        end and reordering what a fixture hook iterates."""

        pool = self._pool({"rows": ["theirs"], "image": [1]})

        self.assertEqual(list(pool), ["rows", "opaque", "image"])
        self.assertEqual(pool["rows"], ["theirs"])
        self.assertEqual(self.made, [])

    def test_asking_for_a_value_makes_it_once_for_the_whole_trial(self):
        pool = self._pool()

        first = pool["rows"]
        self.assertEqual(first.value, [1, 2])
        # The trial's own memo, so the second ask is the same object rather
        # than a second reconstruction.
        self.assertIs(pool["rows"], first)
        self.assertEqual(self.made, ["rows"])

    def test_an_unreadable_resource_refuses_by_name_only_when_read(self):
        pool = self._pool()
        self.assertIn("opaque", pool)
        self.assertEqual(self.made, [])

        with self.assertRaises(Unmapped) as caught:
            pool["opaque"]

        self.assertEqual(caught.exception.reason, "benchmark_inputs")
        self.assertEqual(caught.exception.label, "opaque")

    def test_get_asks_rather_than_checking(self):
        """`get` is a request for the value. An unreadable resource that is
        present must not come back as a default that was never the resource."""

        pool = self._pool()

        self.assertEqual(pool.get("rows").value, [1, 2])
        self.assertIsNone(pool.get("absent"))
        with self.assertRaises(Unmapped):
            pool.get("opaque")

    def test_their_own_products_overlay_the_benchmarks_names(self):
        pool = self._pool({"rows": ["theirs"]})

        self.assertEqual(pool["rows"], ["theirs"])
        self.assertEqual(self.made, [])

    def test_writes_and_deletes_keep_to_one_copy(self):
        pool = self._pool({"image": [1]})
        other = copy.copy(pool)

        other["rows"] = ["written"]
        other["added"] = 1
        del other["image"]

        self.assertEqual(other["rows"], ["written"])
        self.assertEqual(pool["rows"].value, [1, 2])
        self.assertIn("image", pool)
        self.assertNotIn("image", other)
        self.assertNotIn("added", pool)
        self.assertEqual(self.made, ["rows"])

    def test_a_copy_still_draws_on_the_same_trials_reconstruction(self):
        pool = self._pool()
        other = copy.copy(pool)

        self.assertIs(other["rows"], pool["rows"])
        self.assertEqual(self.made, ["rows"])


class ACallableBranchFixtureReachesTheBenchmarksOwnResources(unittest.TestCase):
    """A branch fixture written as a callable reads the pool by name, and the
    names it reads are not declared anywhere: week 3's prepare branch is
    offered the image branch's projected matrix alongside the raw
    descriptors, and the descriptors are the benchmark's.

    So a role with such a fixture snapshots every name the caller supplied,
    not only the ones a stage declared. An unused one that will not copy is
    still not a refusal.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(
            "def project(rows):\n    return [r * 10 for r in rows]\n"
            "def index(pairs):\n    return {a: b for a, b in pairs}\n"
        )
        self.role = Role(
            "all",
            (),
            branches=(
                Role("image",
                     (Stage("image", produces=lambda v: isinstance(v, list)),),
                     fixture=([1, 2],)),
                Role("prepare",
                     (Stage("prepare", produces=lambda v: isinstance(v, dict)),),
                     # Reads a benchmark resource no stage declares, beside
                     # the earlier branch's output.
                     fixture=lambda pool, chains: (
                         list(zip(pool["descriptors"], pool["image"])),
                     )),
            ),
        )

    def test_the_role_snapshots_every_supplied_name(self):
        self.assertTrue(reads_anything(self.role))
        declared, _fits = declared_in(self.role)
        self.assertEqual(declared, [])

        bundle = Bundle(
            fixture=([1, 2],),
            extras={"descriptors": ["a", "b"], "spare": _Uncopyable()},
            declared=list({"descriptors": 1, "spare": 1}),
        )
        pool = bundle.again().pool({"image": [10, 20]})

        self.assertEqual(sorted(pool), ["descriptors", "image", "spare"])
        self.assertEqual(pool["descriptors"], ["a", "b"])
        # Present, listed, and only a refusal if something reads it.
        self.assertIn("spare", pool)
        with self.assertRaises(Unmapped):
            pool["spare"]

    def test_an_unused_opaque_resource_does_not_refuse_the_run(self):
        submission = resolve(
            self.tmp, chain_role=self.role, fixture=([1, 2],),
            accepts=lambda chains, *_: (True, ""), arrangements=None,
            extras={"descriptors": ["a", "b"], "spare": _Uncopyable()},
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(
            submission.to_dict()["branches"],
            {"image": ["theirs.project"], "prepare": ["theirs.index"]},
        )


class AFixtureThatFailedIsNotTheirBranchFailing(unittest.TestCase):
    """`_fixture_for` reports a fixture that raised by wrapping the error, so
    the wrapper has to be read before the value is used.

    Unread, their chain is called with a one-tuple holding the wrapper, their
    own first line raises `TypeError` on it, and the report says their branch
    failed. Two failures wearing one sentence: a week's fixture hook raising
    is the week's, and a resource this reading could not make again is ours.
    """

    def _refusal(self, fixture, extras):
        tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "theirs.py").write_text(
            "def project(rows):\n    return [r * 10 for r in rows]\n"
            "def index(pairs):\n    return {a: b for a, b in pairs}\n"
        )
        role = Role(
            "all",
            (),
            branches=(
                Role("image",
                     (Stage("image", produces=lambda v: isinstance(v, list)),),
                     fixture=([1, 2],)),
                Role("prepare",
                     (Stage("prepare", produces=lambda v: isinstance(v, dict)),),
                     fixture=fixture),
            ),
        )
        binding = {}

        def accepts(chains, *_):
            binding["chains"] = sorted(chains)
            return True, ""

        submission = resolve(
            tmp, chain_role=role, fixture=([1, 2],), accepts=accepts,
            arrangements=None, extras=extras,
        )
        return submission, binding

    def _asking(self, fixture):
        """Run one branch's output the way `_renewed` does."""

        branch = Role(
            "prepare",
            (Stage("prepare", produces=lambda v: isinstance(v, dict)),),
            fixture=fixture,
        )
        chain = (Candidate("theirs.index", lambda pairs: dict(pairs), "theirs"),)
        handed = Bundle(fixture=([1, 2],)).again()
        return _produced_by(branch, chain, handed, {}, ("all",), {})

    def test_a_consumed_resource_that_cannot_be_made_keeps_its_own_name(self):
        """Once the pool is lazy, reading a resource that will not reconstruct
        raises from inside the week's fixture, and `_fixture_for` wraps it.
        Unwrapping has to give back the original refusal, by name."""

        def reads_a_broken_resource(pool, chains):
            raise Unmapped("benchmark_inputs", "spare", "cannot be made again")

        with self.assertRaises(Unmapped) as caught:
            self._asking(reads_a_broken_resource)

        self.assertEqual(caught.exception.reason, "benchmark_inputs")
        self.assertEqual(caught.exception.label, "spare")

    def test_a_fixture_error_of_the_weeks_own_names_that_error(self):
        def broken(pool, chains):
            raise ValueError("the week's own fixture is wrong")

        with self.assertRaises(Unmapped) as caught:
            self._asking(broken)

        self.assertEqual(caught.exception.reason, "branch_input")
        self.assertIn("ValueError", caught.exception.detail)
        # Not their chain running on a wrapper and raising TypeError.
        self.assertNotIn("TypeError", caught.exception.detail)

    def test_a_weeks_own_fixture_error_is_not_blamed_on_their_branch(self):
        def broken(pool, chains):
            raise ValueError("the week's own fixture is wrong")

        submission, _binding = self._refusal(broken, {})

        self.assertFalse(submission.ready)
        # Whatever the report says, it must not say their branch ran and
        # failed, and it must name the fixture's own error rather than a
        # TypeError their code never raised.
        headline = submission.verdict.headline + " " + (
            submission.verdict.next_step or ""
        )
        self.assertNotIn("branch_failed", headline)
        self.assertNotIn("TypeError", headline)


def _producer_takes_pools_without_reading():
    """Whether `_fixture_for` copies the pool it is given or rebuilds it.

    The older producer calls `dict(pool)`, which asks a mapping for every
    value it has before the week's hook runs. Detected by handing it one that
    records, rather than by reading a version anywhere.
    """

    from collections.abc import Mapping as _Mapping

    from cogbench.pipeline import _fixture_for

    read = []

    class Watching(_Mapping):
        def __getitem__(self, key):
            read.append(key)
            return 1

        def __iter__(self):
            return iter(["a"])

        def __len__(self):
            return 1

    _fixture_for(
        Role("b", (), fixture=lambda pool, chains: (0,)), (), Watching(), {}
    )
    return not read


class AFixtureReadsTheBenchmarksResourcesAndNotTheRest(unittest.TestCase):
    """FOCUSED BOUNDARY. A week's branch fixture reads some of the pool. What
    it does not read must not decide the run.

    This is the whole of F1 in one call: `_produced_by` hands the hook this
    trial's pool, the hook reads one resource and one earlier branch's output,
    and a third resource that cannot be copied is never touched. It needs the
    producer to take the pool without reading it, so it says so rather than
    failing where that is not yet true.
    """

    @unittest.skipUnless(
        _producer_takes_pools_without_reading(),
        "needs the published PR5 producer, where `_fixture_for` copies the "
        "pool instead of rebuilding it with `dict(pool)`",
    )
    def test_an_untouched_resource_that_cannot_be_copied_is_not_reached(self):
        branch = Role(
            "prepare",
            (Stage("prepare", produces=lambda v: isinstance(v, dict)),),
            fixture=lambda pool, chains: (
                list(zip(pool["descriptors"], pool["image"])),
            ),
        )
        chain = (Candidate("theirs.index", lambda pairs: dict(pairs), "theirs"),)
        handed = Bundle(
            fixture=([1, 2],),
            extras={"descriptors": ["a", "b"], "spare": _Uncopyable()},
            declared=["descriptors", "spare"],
        ).again()

        produced = _produced_by(
            branch, chain, handed, {("all",): {"image": [10, 20]}}, ("all",), {}
        )

        self.assertEqual(produced, {"a": 10, "b": 20})


class _Counted:
    """A resource that records each time a copy of it is made."""

    def __init__(self, name, log, value):
        self.name, self.log, self.value = name, log, value

    def __deepcopy__(self, memo):
        self.log.append(self.name)
        return _Counted(self.name, self.log, copy.deepcopy(self.value, memo))


class _Uncopyable:
    """A resource no copy can be taken of, which weeks really do supply."""

    def __deepcopy__(self, memo):
        raise ValueError("this one cannot be copied")


class AHalfCopiedInputIsNeverHandedOver(unittest.TestCase):
    """An input that fails halfway leaves the pieces it had already made where
    the next input can find them.

    Python's `deepcopy` records each object it has copied so a graph that
    points at one thing twice comes out pointing at one thing, and that record
    survives the failure. A second input pointing at the half-made piece then
    gets it back with no error at all: a truncated list, silently, as though
    it were the benchmark's own.
    """

    def test_another_input_pointing_at_the_failed_one_is_refused(self):
        class Refuses:
            def __deepcopy__(self, memo):
                raise ValueError("cannot be made again")

        rows = [1, Refuses(), 3]
        # Copying this fails while it is partway through copying `rows`.
        wrapping = [rows]
        bundle = Bundle(
            fixture=(), extras={"bad": wrapping, "good": rows},
            declared=("bad", "good"),
        )

        handed = bundle.again()

        for name in ("bad", "good"):
            with self.subTest(name=name):
                with self.assertRaises(Unmapped) as caught:
                    handed.extra(name)
                self.assertEqual(caught.exception.reason, "benchmark_inputs")

    def test_a_failure_while_reconstructing_refuses_the_rest_of_the_trial(self):
        """Once a reconstruction has failed partway, anything made after it
        could be one of the pieces that failure left behind."""

        # Copies while the snapshot is taken and refuses afterwards, which is
        # how a reconstruction gets to fail on an input the snapshot holds.
        refusing = []

        class Sometimes:
            def __deepcopy__(self, memo):
                if refusing:
                    raise ValueError("not this time")
                return Sometimes()

        bundle = Bundle(
            fixture=(), extras={"first": [1], "second": Sometimes()},
            declared=("first", "second"),
        )
        refusing.append(True)
        handed = bundle.again()
        self.assertEqual(handed.extra("first"), [1])

        with self.assertRaises(Unmapped):
            handed.extra("second")
        # And the reconstruction is over, not carried on with.
        with self.assertRaises(Unmapped) as caught:
            handed.extra("first")
        self.assertEqual(caught.exception.reason, "benchmark_inputs")


class AChainThatRanAndAnsweredWronglyIsReportedInTheWeeksWords(unittest.TestCase):
    """The resolver's headline for this case said "answered a different
    grouping where the answer is one group per person", which is week 2's
    sentence, to a week 3 team whose caption search had run. The week says
    what its test expects, and what the test said goes in the headline."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text("def answer(xs):\n    return 'no'\n")
        self.role = Role("say", (Stage("say", produces=lambda v: isinstance(v, str)),))

    def test_the_headline_carries_what_the_week_expected_and_what_its_test_said(self):
        submission = resolve(
            self.tmp,
            chain_role=self.role,
            fixture=([1],),
            accepts=lambda chain, *_: (False, "asked for yes and got no"),
            arrangements=None,
            expects="yes",
        )

        headline = submission.verdict.headline
        self.assertIn("where the answer is yes", headline)
        self.assertIn("asked for yes and got no", headline)
        self.assertNotIn("grouping", headline)

    def test_a_week_that_says_nothing_gets_a_sentence_true_of_every_week(self):
        submission = resolve(
            self.tmp,
            chain_role=self.role,
            fixture=([1],),
            accepts=lambda chain, *_: (False, ""),
            arrangements=None,
        )

        self.assertIn("the answer the benchmark's own case has", submission.verdict.headline)
        self.assertNotIn("grouping", submission.verdict.headline)


# ---------------------------------------------------------------------------
# Their database is one of their own objects
#
# `instances_in` builds exactly one object per class, for the whole search, and
# every method of that class in the candidate list is bound to that one object.
# What follows is what a trial and a scored run each have to do about that.
# ---------------------------------------------------------------------------

#: Their store refuses an id it has already seen, which is an ordinary thing
#: for a database to do, and the search reaches that store more than once
#: because it pairs it with every other candidate in turn.
GUARDED_OBJECT_REPO = '''
def make_features(value, rate):
    return [(value * 2, rate)]


class Cabinet:
    def __init__(self):
        self.kept = {}
        self.ids = []

    def acknowledge(self, features):
        """One argument, so no arrangement fits it as a store."""
        return ""

    def remember(self, item_id, features):
        if item_id in self.ids:
            raise ValueError("{!r} is already in this database".format(item_id))
        self.ids.append(item_id)
        self.kept[tuple(features)] = item_id

    def whose(self, features):
        return self.kept.get(tuple(features), "")
'''


class EveryTrialGetsItsOwnStoreObject(unittest.TestCase):
    """One object shared by every trial made an earlier rejected pairing
    decide a later valid one.

    The search pairs `remember` with `acknowledge` first, which stores both
    items and then fails to name one back. `remember` is then paired with
    `whose`, which is the pairing that works -- and it raised, because the
    ids were already in the one object the first pairing had filled. The
    repository was refused for having no store.

    The store alone is not enough. Rebuilding it and leaving `whose` bound to
    the object the search built means the query is asked about a database
    nothing enrolled into, so no pairing of two methods could ever bind.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(GUARDED_OBJECT_REPO)

    def test_a_rejected_pairing_no_longer_fills_the_database_a_later_one_needs(self):
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.attempt.enroll, "theirs.Cabinet().remember")
        self.assertEqual(submission.attempt.query, "theirs.Cabinet().whose")


#: The same shape, plus one of their own functions applied to what the query
#: returned -- and that reader reads the object's own state, so which object
#: it is bound to decides what it says.
READING_OBJECT_REPO = '''
def make_features(value, rate):
    return [(value * 2, rate)]


class Shelf:
    def __init__(self):
        self.kept = {}
        self.seen = []

    def lookup(self, features):
        return self.kept.get(tuple(features), "")

    def ranked(self, name):
        return [name] + [other for other in self.seen if other != name]

    def remember(self, item_id, features):
        self.kept[tuple(features)] = item_id
        self.seen.append(item_id)
'''


class AScoredRunReadsTheObjectItJustBuilt(unittest.TestCase):
    """`fresh` rebuilt the store and rebound the query, and left their readers
    bound to the object the search had filled.

    A reader is one of their functions and can be a method like any other. One
    that reads instance state then answered from the fixture the search
    enrolled, or -- when the state was a path -- from a scratch directory the
    search had already deleted.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(READING_OBJECT_REPO)

    def _resolve(self):
        return resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_ranked_accepts,
            grades=_ranked_grades,
            arrangements=_arrangements,
            readers=1,
        )

    def test_their_reader_answers_from_what_this_run_enrolled(self):
        submission = self._resolve()
        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(
            [reader.label for reader in submission._readers],
            ["theirs.Shelf().ranked"],
        )

        for ready in (submission, submission.fresh()):
            ready.enroll("gamma", [(28, 44100)])
            ready.enroll("delta", [(36, 44100)])

            self.assertEqual(ready.query([(28, 44100)]), ["gamma", "delta"])


#: The same shape again, counting constructions. Their constructor is one of
#: their functions and may do anything, so calling it a third time is a call
#: the accepted pairing never proved.
COUNTED_BUILD_REPO = RECORDER + '''
BUILDS = []


def make_features(value, rate):
    return [(value * 2, rate)]


class Vault:
    def __init__(self):
        BUILDS.append(1)
        _record("build")
        self.kept = {}

    def remember(self, item_id, features):
        self.kept[tuple(features)] = item_id

    def whose(self, features):
        return self.kept.get(tuple(features), "")
'''


#: Two classes whose constructors are both reachable, one of which refuses to
#: build when the environment says so. A trial takes its store and its query
#: off its own reading of this, so what a probe left in either is gone.
TRIAL_OWNER_REPO = RECORDER + '''
import os


class Store:
    def __init__(self):
        _record("store")
        self.items = {}

    def enroll(self, name, item):
        self.items[item] = name


class Query:
    def __init__(self):
        _record("query")
        if os.environ.get("COGBENCH_TEST_REFUSE") == "Query":
            raise ValueError("closed")
        self.cache = {}

    def query(self, item):
        return self.cache.setdefault(item, "new")

    def read(self, value):
        self.cache["reader"] = value
        return value

    def read_again(self, value):
        return self.cache["reader"]


class Other:
    def __init__(self):
        _record("other")
        if os.environ.get("COGBENCH_TEST_REFUSE") == "Other":
            raise ValueError("closed")
        self.cache = {}

    def query(self, item):
        return self.cache.setdefault(item, "new")
'''


class DistinctTrialOwners(unittest.TestCase):
    """What the old per-trial rebuild callback answered, answered by the
    trial's own reading of the repository instead.

    The three questions are the same three: a reader the search is only
    speculating about must not refuse the trial, a reader the pairing selected
    must refuse it and keep refusing it, and a query and its readers must come
    off one object that holds nothing a probe put there.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(TRIAL_OWNER_REPO)
        self.built = _recording(self)
        self.found = discover(self.tmp)
        self.by_label = {}
        for label, instance in instances_in(self.found.namespace):
            self.by_label.update({c.label: c for c in methods_of(label, instance)})
        # Enumerating candidates built one object of each class. Count from
        # here, so what a test counts is what its own trials built.
        self.baseline = self.built()

    def _builds(self, which):
        return self.built().count(which) - self.baseline.count(which)

    def _refusing(self, which):
        before = os.environ.get("COGBENCH_TEST_REFUSE")
        os.environ["COGBENCH_TEST_REFUSE"] = which
        self.addCleanup(
            lambda: os.environ.pop("COGBENCH_TEST_REFUSE", None) if before is None
            else os.environ.__setitem__("COGBENCH_TEST_REFUSE", before)
        )

    def _trial(self, shape, store, ask):
        return _Trial(shape, store, ask, None, 0, Project(self.tmp, self.found))

    def test_failed_speculative_reader_does_not_refuse_the_trial(self):
        self._refusing("Other")
        trial = self._trial(
            _Shape(),
            self.by_label["theirs.Store().enroll"],
            self.by_label["theirs.Query().query"],
        )
        trial.enroll("alpha", "item")
        bad = self.by_label["theirs.Other().query"]
        good = self.by_label["theirs.Query().read"]

        result = _read_further(_ranked_grades, "item", trial, (bad, good), 1)

        self.assertEqual(result, None)
        self.assertIn("other", self.built())
        # The trial survived the reader that could not be built.
        self.assertEqual(trial.query()("still usable"), "new")

    def test_selected_reader_failure_remains_sticky(self):
        self._refusing("Other")
        store = self.by_label["theirs.Store().enroll"]
        ask = self.by_label["theirs.Query().query"]
        reader = self.by_label["theirs.Other().query"]
        trial = self._trial(_Shape(readers=(reader,)), store, ask)
        calls = (
            lambda: trial.enroll("alpha", "item"),
            lambda: trial.enroll("beta", "item"),
            lambda: trial.query()("item"),
            lambda: trial.reading(ask),
        )
        for call in calls:
            with self.assertRaisesRegex(NoDatabase, "construction_failed: ValueError"):
                call()
        # Their constructor ran once, not once per call.
        self.assertEqual(self._builds("other"), 1)

    def test_query_and_its_readers_share_one_object_with_nothing_in_it(self):
        store = self.by_label["theirs.Store().enroll"]
        ask = self.by_label["theirs.Query().query"]
        reader = self.by_label["theirs.Query().read"]
        again = self.by_label["theirs.Query().read_again"]
        distinct = self.by_label["theirs.Other().query"]
        # What an earlier probe left in the objects the search built.
        ask.call.__self__.cache["item"] = "probe"
        distinct.call.__self__.cache["item"] = "other probe"

        for _ in range(2):
            trial = self._trial(_Shape(readers=(reader, again)), store, ask)
            trial.enroll("gamma", "item")
            self.assertEqual(trial.query()("item"), "new")
            self.assertEqual(trial.reading(again)("ignored"), "new")
            self.assertEqual(trial.reading(distinct)("item"), "new")
            # One reading, one object per class of theirs.
            self.assertEqual(trial.reading(distinct)("item"), "new")

        self.assertEqual(ask.call.__self__.cache, {"item": "probe"})
        self.assertEqual(distinct.call.__self__.cache, {"item": "other probe"})
        # Two trials, two objects of each class.
        self.assertEqual(self._builds("query"), 2)
        self.assertEqual(self._builds("other"), 2)


class AScoredRunBuildsTheirClassOnce(unittest.TestCase):
    """The store and the query are two methods of one object, so making the
    store's object again is the whole job.

    `fresh` called the class twice and threw the second object away: the
    store's, and then the query's, whose owner was discarded a line later.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(COUNTED_BUILD_REPO)
        self.built = _recording(self)

    def test_only_the_store_owner_is_rebuilt(self):
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
        )
        self.assertTrue(submission.ready, submission.verdict.headline)
        before = len(self.built())

        ready = submission.fresh()
        # Reading the repository again runs their file, not their class.
        self.assertEqual(len(self.built()), before)
        ready.enroll("gamma", [(28, 44100)])
        self.assertEqual(ready.query([(28, 44100)]), "gamma")

        self.assertEqual(len(self.built()) - before, 1)

    def test_two_runs_of_one_binding_do_not_share_their_class(self):
        """Each `fresh` is a reading of its own, so a store that refuses an id
        it has already seen takes the same id in both."""

        (self.tmp / "theirs.py").write_text(
            COUNTED_BUILD_REPO.replace(
                "    def remember(self, item_id, features):",
                "    SEEN = []\n\n    def remember(self, item_id, features):\n"
                "        if item_id in Vault.SEEN:\n"
                "            raise KeyError(item_id)\n"
                "        Vault.SEEN.append(item_id)",
            )
        )
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
        )
        self.assertTrue(submission.ready, submission.verdict.headline)

        first, second = submission.fresh(), submission.fresh()
        # Interleaved on purpose: the two runs take turns, and each takes the
        # same ids, which is only possible if neither sees the other's class.
        for item_id, value in (("gamma", 28), ("delta", 36)):
            first.enroll(item_id, [(value, 44100)])
            second.enroll(item_id, [(value, 44100)])
        self.assertEqual(first.query([(28, 44100)]), "gamma")
        self.assertEqual(second.query([(36, 44100)]), "delta")


#: Their factory writes a file beside itself, which is what a factory that
#: makes a database on disk does.
WRITING_FACTORY_REPO = '''
def make_features(value, rate):
    return [(value * 2, rate)]


def create_database():
    with open("built-here.txt", "w") as opened:
        opened.write("x")
    return {}


def add_fingerprints(database, item_id, features):
    for key in features:
        database.setdefault(key, []).append(item_id)


def query_database(database, features):
    for key in features:
        for item_id in database.get(key, []):
            return item_id
    return ""
'''


def _is_factory_probed_elsewhere(candidate):
    """A week's own answer to "what does an empty database look like", asked
    somewhere their factory's files cannot be mistaken for the search's."""

    import inspect

    try:
        inspect.signature(candidate.call).bind()
    except (TypeError, ValueError):
        return False
    previous = os.getcwd()
    with tempfile.TemporaryDirectory() as probe:
        os.chdir(probe)
        try:
            made = candidate.call()
        except BaseException:  # noqa: BLE001
            return False
        finally:
            os.chdir(previous)
    return isinstance(made, dict) and not made


class TheDatabaseIsMadeWhereTheWeeksTestRuns(unittest.TestCase):
    """A week may give each attempt a world of its own, and it does that
    inside its acceptance test.

    The search made the database before calling that test, so a week whose
    fresh state is a fresh working directory had the database built in one
    directory and filled in another. The scored run does neither: its database
    is built inside the driver's own scratch directory, with the driver
    already there.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(WRITING_FACTORY_REPO)
        elsewhere = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, elsewhere, ignore_errors=True)
        previous = os.getcwd()
        os.chdir(elsewhere)
        self.addCleanup(os.chdir, previous)
        self.built_in_the_attempt = []

    def _accepts_in_a_world_of_its_own(self, chain, enroll_call, query_call):
        previous = os.getcwd()
        with tempfile.TemporaryDirectory() as attempt:
            os.chdir(attempt)
            try:
                return _accepts(chain, enroll_call, query_call)
            finally:
                self.built_in_the_attempt.append(
                    (Path(attempt) / "built-here.txt").exists()
                )
                os.chdir(previous)

    def test_their_factory_runs_inside_the_attempts_own_directory(self):
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=self._accepts_in_a_world_of_its_own,
            arrangements=_arrangements,
            factories=_is_factory_probed_elsewhere,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertTrue(
            any(self.built_in_the_attempt),
            "their factory never ran inside an attempt's own directory",
        )


#: Two more complete chains, both of which map every item to the same
#: features, so they run end to end and no pairing of their functions can name
#: one item back. Both sort before `make_features`, so the search pairs two
#: chains that cannot work before it reaches the one that can.
MANY_CHAINS_REPO = REPO + '''

def blur_features(value, rate):
    return [(0, rate)]


def flat_features(value, rate):
    return [(1, rate)]
'''


class TheCeilingAndTheCountAreOnTheSearch(unittest.TestCase):
    """Both numbers were per chain, and both are claims about the search.

    `max_attempts` restarted for every complete chain, so a repository
    offering several of them could try several times the ceiling and the one
    number that bounds how long a student waits bounded nothing. And a
    successful submission reported the accepted chain's own ordinal, so the
    work spent on every chain before it was not counted anywhere.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(MANY_CHAINS_REPO)

    def test_the_ceiling_bounds_the_whole_search_not_each_chain(self):
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=lambda *_: (False, "never"),
            arrangements=_arrangements,
            max_attempts=5,
        )

        self.assertLessEqual(submission.attempts_tried, 5)

    def test_a_successful_search_reports_every_pairing_it_tried(self):
        watcher = _Recorder()

        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
            progress=watcher,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.chain[0].label, "theirs.make_features")
        ticks = [done for done, _ in watcher.counts]
        # The bar never restarts, and where it ends is what the record says.
        self.assertEqual(ticks, sorted(ticks))
        self.assertEqual(max(ticks), submission.attempts_tried)

    def test_the_bar_only_counts_pairings_the_search_will_make(self):
        watcher = _Recorder()

        resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
            progress=watcher,
        )

        for done, total in watcher.counts:
            self.assertLessEqual(done, total)


#: Their store is a method that fills a table on its own object, their query
#: is a plain function that takes that table -- and their object also carries
#: a settings table their constructor made, which is not an answer to
#: anything.
CONFIGURED_STORE_REPO = '''
def make_features(value, rate):
    return [(value * 2, rate)]


class Cabinet:
    def __init__(self):
        self.settings = {"fanout": 15, "window": 4}
        self.hashes = {}

    def add_hash(self, item_id, features):
        for key in features:
            self.hashes.setdefault(key, []).append(item_id)


def match(features, hashes, names):
    for key in features:
        for item_id in hashes.get(key, []):
            return names[item_id]
    return ""
'''


class OnlyWhatEnrollingFilledCountsAsTheirTable(unittest.TestCase):
    """Two filled tables on a store object are two answers to "what did the
    store fill", and picking one by name would be picking one of their data
    structures at random. So the search refuses.

    It counted every non-empty mapping, including the ones their constructor
    made and their store never touched. A database class that keeps settings,
    or metadata, beside its fingerprints was refused for being ambiguous when
    only one of those mappings had anything to do with enrolling.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(CONFIGURED_STORE_REPO)

    def test_a_slotted_store_resolves_with_prepopulated_nested_contents(self):
        (self.tmp / "theirs.py").write_text(
            CONFIGURED_STORE_REPO.replace(
                "class Cabinet:",
                "class Cabinet:\n    __slots__ = ('settings', 'hashes')",
            ).replace(
                "self.hashes = {}",
                "self.hashes = {(14, 44100): [], (18, 44100): []}",
            )
        )
        submission = resolve(
            self.tmp, chain_role=ROLE, fixture=FIXTURE,
            accepts=_accepts, arrangements=_arrangements,
        )
        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission._state_attribute, "hashes")

    def test_a_settings_table_does_not_make_their_store_ambiguous(self):
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.attempt.enroll, "theirs.Cabinet().add_hash")
        self.assertEqual(submission.attempt.query, "theirs.match")
        self.assertEqual(submission._state_attribute, "hashes")


def _half_grades(answer):
    """Half a mark for naming the item, full for a ranking, read off the
    answer alone."""

    if isinstance(answer, list) and answer and answer[0] == "alpha":
        return 1.0, "ranked"
    return (0.5 if answer == "alpha" else False), "half"


def _half_accepts(chain, enroll_call, query_call):
    enrolled, detail = _enrol(chain, enroll_call)
    if not enrolled or query_call is None:
        return enrolled, detail
    try:
        answer = query_call(chain[0].call(7, 44100))
    except BaseException:  # noqa: BLE001 - a wrong pairing raises
        return False, "raised"
    return _half_grades(answer)


class ABareQuerysGradeSurvivesTheReaderSearch(unittest.TestCase):
    """A reader search that raises must not take the pairing's own grade
    with it: the base grade is recorded before any tail is tried."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(
            "_DB = {}\n"
            "def make_features(value, rate):\n    return [(value * 2, rate)]\n"
            "def remember(features, item_id):\n    _DB[tuple(features)] = item_id\n"
            "def whose(features):\n    return _DB.get(tuple(features), '')\n"
            "def reader(answer):\n    raise RuntimeError('a reader that always fails')\n"
        )

    def test_the_half_grade_is_kept_when_every_reader_raises(self):
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_half_accepts,
            grades=_half_grades,
            arrangements=_arrangements,
            readers=1,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.attempt.query, "theirs.whose")
        self.assertEqual(submission.to_dict().get("readers"), None)


class ATablePreallocatedAndFilledInPlaceIsStillTheirTable(unittest.TestCase):
    """A store that creates its keys up front and writes the values during
    enrolling changes neither the mapping's identity nor its size. An
    independent review built one beside a settings dict and the pairing was
    refused as ambiguous; the contents are what changed."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(
            "def make_features(value, rate):\n    return [(value * 2, rate)]\n"
            "class Cabinet:\n"
            "    def __init__(self):\n"
            "        self.settings = {'fanout': 15}\n"
            "        self.hashes = {(14, 44100): None, (18, 44100): None}\n"
            "    def add_hash(self, item_id, features):\n"
            "        for key in features:\n"
            "            self.hashes[key] = item_id\n"
            "def match(features, hashes, names):\n"
            "    for key in features:\n"
            "        if hashes.get(key) is not None:\n"
            "            return names[hashes[key]]\n"
            "    return ''\n"
        )

    def test_the_filled_table_is_the_one_handed_to_their_matcher(self):
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.attempt.query, "theirs.match")
        self.assertEqual(submission._state_attribute, "hashes")


#: One store that takes an item, one that raises whatever it is handed, and
#: one function that can only be a query.
REFUSING_STORE_REPO = '''
_DB = {}


def make_features(value, rate):
    return [(value * 2, rate)]


def remember(features, item_id):
    _DB[tuple(features)] = item_id


def refuse(features, item_id):
    raise ValueError("this one never takes an item")


def whose(features):
    return _DB.get(tuple(features), "")
'''


class AStoreThatRaisedOnEnrolmentIsNotPaired(unittest.TestCase):
    """Whether a store takes an item is a property of the store, the
    arrangement and the shape. Asking it again for every query it might be
    paired with is what made the search quadratic in the size of a
    repository."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(REFUSING_STORE_REPO)
        self.asked = []

    def _counting_accepts(self, chain, enroll_call, query_call):
        self.asked.append(query_call is None)
        # Half a mark, so the search runs every pairing rather than stopping
        # at the first one: what this counts is which pairings exist.
        return _half_accepts(chain, enroll_call, query_call)

    def test_only_the_store_that_took_an_item_reaches_a_query(self):
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=self._counting_accepts,
            arrangements=_arrangements,
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.attempt.enroll, "theirs.remember")
        # Three candidates in two arrangements, once for the plain shape.
        # Their state shape adds none: nothing here is a method, so no store
        # has an object to read a filled table off.
        self.assertEqual(self.asked.count(True), 6)
        # `remember` took the item both ways round and `whose` is the only
        # candidate a plain query can be asked of, so two pairings. `refuse`
        # raised on both arrangements and is in neither; pairing it would
        # have made four.
        self.assertEqual(self.asked.count(False), 2)


#: Their query returns a vote tally, one of their functions cannot read it,
#: and one can. `CALLS` records every reader call their code receives.
COUNTED_READER_REPO = RECORDER + '''
CALLS = []


def make_features(value, rate):
    return [(value * 2, rate)]


def create_database():
    return {}


def add_fingerprints(database, item_id, features):
    if not isinstance(item_id, str):
        raise TypeError("the item id comes first")
    for key in features:
        database.setdefault(key, []).append(item_id)


def query_database(database, features):
    votes = {}
    for key in features:
        for item_id in database.get(key, []):
            votes[item_id] = votes.get(item_id, 0) + 1
    return votes


def boom(answer):
    CALLS.append("boom")
    _record("boom")
    raise RuntimeError("this one cannot read that")


def tag(answer):
    CALLS.append("tag")
    _record("tag")
    return sorted(answer)
'''


def _nothing_reads(answer):
    """No tail ever satisfies this, so the search runs to its full depth."""

    return False, "nothing here reads as an answer"


def _tallied_accepts(chain, enroll_call, query_call):
    enrolled, detail = _enrol(chain, enroll_call)
    if not enrolled or query_call is None:
        return enrolled, detail
    try:
        answer = query_call(chain[0].call(7, 44100))
    except BaseException as error:  # noqa: BLE001
        return False, "querying raised {}".format(type(error).__name__)
    return (0.5 if answer.get("alpha") else False), "named alpha in a tally"


class AReaderThatRaisedIsNotExtended(unittest.TestCase):
    """A reader that raised produced no value, so there is nothing for a
    second reader to read. Keeping such a tail in the frontier would spend
    the next depth calling their functions on a value that does not exist."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "theirs.py").write_text(COUNTED_READER_REPO)
        self.called = _recording(self)

    def test_the_second_depth_reads_only_what_the_first_returned(self):
        resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_tallied_accepts,
            grades=_nothing_reads,
            arrangements=_arrangements,
            factories=_is_factory,
            readers=2,
        )

        # `boom` on the tally, `tag` on the tally, then `boom` on what `tag`
        # returned. A fourth call would be `tag` reading whatever was kept
        # from the reader that raised.
        self.assertEqual(self.called(), ["boom", "tag", "boom"])


class AWeekThatAllowsReadersMustSayHowToGradeOne(unittest.TestCase):
    """A reader is chosen by grading what it returned. A week that declares
    readers and no `grades` would bind none of them, and the repository that
    needed them would be refused for a reason nothing reported."""

    def test_the_combination_is_refused_where_it_is_written(self):
        with self.assertRaises(ValueError) as raised:
            resolve(
                Path(tempfile.gettempdir()),
                chain_role=ROLE,
                fixture=FIXTURE,
                accepts=_accepts,
                arrangements=_arrangements,
                readers=2,
            )

        self.assertIn("grades", str(raised.exception))


class AMethodAlreadyBoundIsNotOfferedAsAStore(unittest.TestCase):
    """A team whose peak finder and whose database are methods of one class.

    `_store_candidates` filtered the module-level functions by the steps the
    chain had already bound, and then extended the list with every method of
    every constructible class without filtering those. So a class method that
    was already serving a pipeline stage came back as a database candidate,
    and the pairing loop spent attempts proving that a fingerprinter cannot
    store a song.

    Attempts are the scarce resource in this search. KrazeeCoder resolves at
    3962 of them, so a handful of impossible pairings per class is not free.
    """

    def _repository(self):
        """One module holding a class with a stage method and a store."""

        from types import ModuleType

        module = ModuleType("audio")
        source = '''
class Engine:
    """Their whole pipeline and their database, on one object."""

    def __init__(self):
        self.kept = {}

    def find_peaks(self, spectrogram):
        return [(1, 2)]

    def store_fingerprints(self, item_id, prints):
        self.kept[tuple(prints)] = item_id

    def query(self, prints):
        return self.kept.get(tuple(prints), "")
'''
        exec(compile(source, "audio.py", "exec"), module.__dict__)
        module.__dict__["__name__"] = "audio"
        for value in module.__dict__.values():
            if isinstance(value, type):
                value.__module__ = "audio"

        class _Found:
            namespace = [module]

        return _Found()

    def test_the_bound_method_is_gone_and_the_store_and_query_remain(self):
        from cogbench.pipeline import instances_in, methods_of
        from cogbench.resolve import _store_candidates

        found = self._repository()
        label, instance = instances_in(found.namespace)[0]
        by_name = {c.label: c for c in methods_of(label, instance)}
        peaks = by_name["{}.find_peaks".format(label)]
        self.assertIn("{}.store_fingerprints".format(label), by_name)

        # The chain bound their peak finder, which is a method on this class.
        labels = {c.label for c in _store_candidates(found, [peaks])}

        self.assertNotIn(
            peaks.label,
            labels,
            "a method already serving a stage was offered back as a database",
        )
        # And the two that really could be a store are still there, so the
        # filter removed the bound method and nothing else.
        self.assertIn("{}.store_fingerprints".format(label), labels)
        self.assertIn("{}.query".format(label), labels)

    def test_a_method_a_constructor_stage_reached_is_excluded_too(self):
        """The label a step carries depends on how the search reached it.

        `instances_in` builds one object per exported class and names its
        methods `audio.Engine().find_peaks`. A constructor stage instead hands
        `_reachable` the class candidate's own label, giving
        `audio.Engine.find_peaks` for the same method of the same class. The
        second spelling is the one the pipeline path produces, so a filter that
        matched strings would miss exactly the case this exists for.
        """

        from cogbench.pipeline import Candidate, _reachable, instances_in
        from cogbench.resolve import _store_candidates

        found = self._repository()
        label, instance = instances_in(found.namespace)[0]
        engine = type(instance)

        # The class as a stage bound it, the way a constructor stage does.
        klass = Candidate("audio.Engine", engine, "audio")
        reached = {c.attribute: c for c in _reachable(klass, engine(), ())}
        peaks = reached["find_peaks"]
        self.assertEqual(peaks.label, "audio.Engine.find_peaks")
        self.assertNotEqual(peaks.label, "{}.find_peaks".format(label))

        offered = _store_candidates(found, [peaks])
        attributes = {c.attribute for c in offered if c.owner is engine}

        self.assertNotIn("find_peaks", attributes, "the bound method came back as a store")
        self.assertIn("store_fingerprints", attributes)
        self.assertIn("query", attributes)

    def test_nothing_is_removed_when_the_chain_bound_no_method(self):
        from cogbench.pipeline import instances_in, methods_of
        from cogbench.resolve import _store_candidates

        found = self._repository()
        label, instance = instances_in(found.namespace)[0]
        every = {c.label for c in methods_of(label, instance)}

        labels = {c.label for c in _store_candidates(found, [])}

        self.assertTrue(every)
        self.assertTrue(every <= labels, "an unbound chain must offer every method")


if __name__ == "__main__":
    unittest.main()


class AReaderProbeGetsThePerCallClockLikeEveryOtherCall(unittest.TestCase):
    """A reader that does not return used to be waited on forever.

    `_read_further` called their function directly, so the ten-second clock
    every other call into their code goes through did not apply. Measured
    before this test existed: four probes of a reader that sleeps fourteen
    seconds took fifty-six seconds.

    What this does NOT pin is how many probes there are. Tails are orderings
    of the pool, so one pairing over a pool of twelve at depth three is 1,464
    calls and it recurs per partially-graded pairing. That is still unbounded
    and is recorded as open work; drawing it from the pairing ceiling was
    tried and refused the repository instead, see the report.
    """

    @unittest.skipUnless(
        hasattr(signal, "SIGALRM"), "the per-call clock is SIGALRM, which Windows lacks"
    )
    def test_a_reader_that_does_not_return_is_cut_off_not_waited_on(self):
        import time
        import unittest.mock

        from cogbench import pipeline

        # One second rather than the real ten, because what is under test is
        # that a clock applies at all, not what it is set to.
        with unittest.mock.patch.object(pipeline, "CALL_TIMEOUT_SECONDS", 1):
            started = time.time()
            with self.assertRaises(BaseException):
                pipeline._under_clock(lambda: time.sleep(6))
            waited = time.time() - started

        self.assertLess(waited, 4)

    def test_the_clock_steps_aside_where_it_cannot_be_held(self):
        """A worker thread cannot hold a signal handler. Reading that raise as
        "not a reader of this value" would drop one of their working
        functions, so the clock goes away instead of the reader."""

        import threading

        from cogbench.pipeline import _under_clock

        answered = {}

        def work():
            answered["value"] = _under_clock(lambda x: x * 2, 21)

        thread = threading.Thread(target=work)
        thread.start()
        thread.join()

        self.assertEqual(answered.get("value"), 42)
