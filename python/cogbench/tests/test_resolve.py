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

    def test_the_weights_the_hook_loaded_are_recorded_and_kept_out_of_the_pool(self):
        submission = resolve(
            self.tmp,
            chain_role=self.role,
            fixture=([1, 2],),
            accepts=lambda chain, *_: (chain[0].bound([1]) == [3], ""),
            arrangements=None,
            prepare=lambda root, modules: {"W": 3, "weights_used": ["data/b.npy", "data/a.npy"]},
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.weights_used, ("data/a.npy", "data/b.npy"))
        self.assertEqual(submission.to_dict()["weightsUsed"], ["data/a.npy", "data/b.npy"])

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

        ready = submission.fresh()
        ready.enroll("gamma", [(28, 44100)])
        ready.enroll("delta", [(36, 44100)])

        self.assertEqual(ready.query([(28, 44100)]), ["gamma", "delta"])


#: The same shape again, counting constructions. Their constructor is one of
#: their functions and may do anything, so calling it a third time is a call
#: the accepted pairing never proved.
COUNTED_BUILD_REPO = '''
BUILDS = []


def make_features(value, rate):
    return [(value * 2, rate)]


class Vault:
    def __init__(self):
        BUILDS.append(1)
        self.kept = {}

    def remember(self, item_id, features):
        self.kept[tuple(features)] = item_id

    def whose(self, features):
        return self.kept.get(tuple(features), "")
'''


def _module_holding(submission, attribute):
    """The loaded repository module carrying this name."""

    for module in submission.discovery.namespace:
        if hasattr(module, attribute):
            return module
    raise AssertionError("no loaded module has {}".format(attribute))


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

    def test_only_the_store_owner_is_rebuilt(self):
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_accepts,
            arrangements=_arrangements,
        )
        self.assertTrue(submission.ready, submission.verdict.headline)
        theirs = _module_holding(submission, "BUILDS")
        before = len(theirs.BUILDS)

        submission.fresh()

        self.assertEqual(len(theirs.BUILDS) - before, 1)


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
COUNTED_READER_REPO = '''
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
    raise RuntimeError("this one cannot read that")


def tag(answer):
    CALLS.append("tag")
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

    def test_the_second_depth_reads_only_what_the_first_returned(self):
        submission = resolve(
            self.tmp,
            chain_role=ROLE,
            fixture=FIXTURE,
            accepts=_tallied_accepts,
            grades=_nothing_reads,
            arrangements=_arrangements,
            factories=_is_factory,
            readers=2,
        )

        theirs = _module_holding(submission, "CALLS")
        # `boom` on the tally, `tag` on the tally, then `boom` on what `tag`
        # returned. A fourth call would be `tag` reading whatever was kept
        # from the reader that raised.
        self.assertEqual(theirs.CALLS, ["boom", "tag", "boom"])


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
