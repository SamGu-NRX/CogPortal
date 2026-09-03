from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import memo  # noqa: E402
from cogbench.pipeline import Role, Stage  # noqa: E402
from cogbench.progress import Progress  # noqa: E402
from cogbench.resolve import resolve  # noqa: E402
from cogbench.verdict import NOT_READ, NOT_WIRED, NOTHING_HERE, SCORED  # noqa: E402


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


def _accepts(chain, enroll_call, query_call):
    """Enroll two items, ask for one back."""

    try:
        for item_id, value in (("alpha", 7), ("beta", 9)):
            enroll_call(item_id, chain[0].call(value, 44100))
    except TypeError as error:
        return False, "enrolling did not accept those arguments: {}".format(error)
    except BaseException as error:  # noqa: BLE001
        return False, "enrolling raised {}".format(type(error).__name__)
    try:
        answer = query_call(chain[0].call(7, 44100))
    except BaseException as error:  # noqa: BLE001
        return False, "querying raised {}".format(type(error).__name__)
    return (answer == "alpha"), "asked for alpha and got {}".format(answer)


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


if __name__ == "__main__":
    unittest.main()


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


def _ranked_accepts(chain, enroll_call, query_call):
    """Enroll two items and require a ranked list naming the right one."""

    try:
        for item_id, value in (("alpha", 7), ("beta", 9)):
            enroll_call(item_id, chain[0].call(value, 44100))
    except TypeError as error:
        return False, "enrolling did not accept those arguments: {}".format(error)
    except BaseException as error:  # noqa: BLE001
        return False, "enrolling raised {}".format(type(error).__name__)
    try:
        answer = query_call(chain[0].call(7, 44100))
    except BaseException as error:  # noqa: BLE001
        return False, "querying raised {}".format(type(error).__name__)
    ok = bool(isinstance(answer, list) and answer and answer[0] == "alpha")
    return ok, "asked for alpha and got {}".format(answer)


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

        submission = self._resolve(factories=_is_factory, readers=2).fresh()
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
