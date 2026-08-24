from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

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
