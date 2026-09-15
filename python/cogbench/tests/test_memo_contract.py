"""Current benchmark inputs must not inherit a previous binding decision."""
from __future__ import annotations

import json
import shutil
import signal
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.memo import cache_path  # noqa: E402
from cogbench.pipeline import Candidate, Role, Stage  # noqa: E402
from cogbench.resolve import Submission, _valid_replay, resolve  # noqa: E402
from cogbench.verdict import SCORED, Verdict  # noqa: E402


def _key(repository: Path) -> str:
    return json.loads(cache_path(repository).read_text())["key"]


def _stored(repository: Path) -> dict:
    return json.loads(cache_path(repository).read_text())["binding"]


class CurrentMemoContractTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        (self.root / "features.py").write_text(
            "def a(value):\n    return 1\n\ndef b(value):\n    return 2\n"
        )
        self.role = Role("features", (Stage("features", produces=lambda x: isinstance(x, int)),))

    def resolve(self, expected=1, **changes):
        arguments = dict(
            chain_role=self.role, fixture=([1],),
            accepts=lambda steps, *_: (steps[0].bound([1]) == expected, ""),
            remember=True, benchmark="mini", arrangements=None,
        )
        arguments.update(changes)
        return resolve(self.root, **arguments)

    def test_equal_inputs_hit_and_changed_fixture_content_misses(self):
        self.assertFalse(self.resolve().recalled)
        self.assertTrue(self.resolve().recalled)
        changed = self.resolve(fixture=([9],))
        self.assertTrue(changed.ready, changed.verdict.headline)
        self.assertFalse(changed.recalled)
        self.assertTrue(self.resolve(fixture=([9],)).recalled)

    def test_changed_acceptance_closure_revalidates_the_selected_binding(self):
        first = self.resolve(expected=1)
        self.assertTrue(first.chain[0].label.endswith(".a"))
        changed = self.resolve(expected=2)
        self.assertTrue(changed.ready, changed.verdict.headline)
        self.assertFalse(changed.recalled)
        self.assertTrue(changed.chain[0].label.endswith(".b"))
        self.assertTrue(self.resolve(expected=2).recalled)

    def test_a_partial_revalidation_cannot_hide_a_better_binding(self):
        self.resolve()

        def accepts(steps, *_):
            return (0.5 if steps[0].bound([1]) == 1 else 1.0), ""

        changed = self.resolve(accepts=accepts)
        self.assertFalse(changed.recalled)
        # For a chain-only role the acceptance callback owns the verdict and
        # may accept a partial score. The memo must still rerun the search.
        self.assertTrue(changed.ready, changed.verdict.headline)

    def test_changed_extras_identities_and_stage_configuration_miss(self):
        for name, before, after in (
            ("extras", {"scale": 1}, {"scale": 2}),
            ("identities", ("alpha",), ("beta",)),
            ("chain_role", self.role, Role("features", (Stage("features", prefers=("b",)),))),
        ):
            with self.subTest(input=name):
                first = self.resolve(**{name: before})
                self.assertTrue(first.ready, first.verdict.headline)
                self.assertTrue(self.resolve(**{name: before}).recalled)
                changed = self.resolve(**{name: after})
                self.assertTrue(changed.ready, changed.verdict.headline)
                self.assertFalse(changed.recalled)

    def test_declared_model_bytes_invalidate_even_when_prepare_values_are_equal(self):
        model = self.root / "model.dat"
        model.write_bytes(b"first model")

        def prepare(root, modules, capture=None):
            capture(root / "model.dat")
            return {}

        self.assertFalse(self.resolve(prepare=prepare).recalled)
        self.assertTrue(self.resolve(prepare=prepare).recalled)
        model.write_bytes(b"other model")
        self.assertFalse(self.resolve(prepare=prepare).recalled)
        self.assertTrue(self.resolve(prepare=prepare).recalled)

    def test_declared_course_file_bytes_invalidate(self):
        resource = self.root / "course.dat"
        resource.write_bytes(b"one")
        files = {"course.dat": resource}
        self.resolve(resource_files=files)
        self.assertTrue(self.resolve(resource_files=files).recalled)
        resource.write_bytes(b"two")
        self.assertFalse(self.resolve(resource_files=files).recalled)

    def test_revalidation_does_not_fill_the_returned_modules_or_classes(self):
        sources = (
            "count = 0\ndef transform(value):\n"
            "    global count\n    count += 1\n    return count\n",
            "class Engine:\n    count = 0\n"
            "def transform(value):\n"
            "    Engine.count += 1\n    return Engine.count\n",
        )
        for source in sources:
            with self.subTest(source=source.splitlines()[0]):
                (self.root / "features.py").write_text(source)
                accepts = lambda steps, *_: (steps[0].bound([1]) in (1, 2), "")
                first = self.resolve(accepts=accepts)
                self.assertTrue(first.ready, first.verdict.headline)
                recalled = self.resolve(accepts=accepts)
                self.assertTrue(recalled.recalled)
                self.assertEqual(recalled.attempts_tried, 1)
                self.assertEqual(recalled.chain[0].bound([1]), 1)

    @unittest.skipUnless(hasattr(signal, "getitimer"), "requires POSIX timer inspection")
    def test_factory_policy_runs_in_scratch_under_the_clock(self):
        observed = []

        def factory():
            observed.append((Path.cwd(), signal.getitimer(signal.ITIMER_REAL)[0]))
            return {}

        submission = Submission(
            Verdict(SCORED, "test"),
            _factory=Candidate("factory", factory, "test"),
        )
        original = Path.cwd()
        self.assertTrue(_valid_replay(
            submission, lambda *_: (True, ""), (),
            factories=lambda candidate: candidate.call() == {}, readers=0,
        ))
        self.assertEqual(len(observed), 1)
        self.assertNotEqual(observed[0][0], original)
        self.assertGreater(observed[0][1], 0)
        self.assertEqual(Path.cwd(), original)

    def test_validation_does_not_mutate_returned_tuning(self):
        (self.root / "features.py").write_text(
            'def features(value, settings):\n'
            '    if value == [9]:\n        settings["count"] += 1\n'
            '    return settings["count"]\n'
        )

        def role():
            return Role("features", (Stage(
                "features", produces=lambda x: isinstance(x, int),
                tunings=({"count": 0},),
            ),))

        self.resolve(chain_role=role(), accepts=lambda *_: (True, ""))
        recalled = self.resolve(
            chain_role=role(),
            accepts=lambda steps, *_: (steps[0].bound([9]) == 1, ""),
        )
        self.assertTrue(recalled.recalled)
        self.assertEqual(recalled.chain[0].tuning, {"count": 0})
        self.assertEqual(recalled.chain[0].bound([9]), 1)

    def test_copy_failure_during_validation_is_a_cache_miss(self):
        nested = 0
        for _ in range(600):
            nested = [nested]
        first = self.resolve(extras={"unused": nested})
        self.assertTrue(first.ready, first.verdict.headline)
        self.assertTrue(cache_path(self.root).exists())
        second = self.resolve(extras={"unused": nested})
        self.assertTrue(second.ready, second.verdict.headline)
        self.assertFalse(second.recalled)

    def test_a_keyword_only_argument_survives_being_remembered(self):
        """`plan` places positional arguments only. A step the search called
        with a keyword-only argument, replayed without it, is their function
        called a way it was never proved to accept."""

        (self.root / "features.py").write_text(
            "def scale(value, *, factor, name):\n"
            "    return len(value) * factor if name else 0\n"
        )
        role = Role(
            "features",
            (Stage("features", produces=lambda x: isinstance(x, int),
                   extras=("factor",), identity=True),),
        )
        arguments = dict(
            chain_role=role, fixture=([1, 1],), arrangements=None, remember=True,
            benchmark="keyword", extras={"factor": 3}, identities=("one", "two"),
            accepts=lambda steps, *_: (steps[0].bound([1, 1]) == 6, ""),
        )

        first = resolve(self.root, **arguments)
        self.assertTrue(first.ready, first.verdict.headline)
        self.assertTrue(first.chain[0].keyword_plan)
        second = resolve(self.root, **arguments)

        self.assertTrue(second.recalled, second.verdict.headline)
        self.assertEqual(
            dict(second.chain[0].keyword_plan), dict(first.chain[0].keyword_plan)
        )
        self.assertEqual(second.chain[0].bound([1, 1]), 6)

    def test_a_remembered_keyword_plan_this_version_cannot_read_is_a_miss(self):
        """A record that does not say how every step was called sends the
        binding back through the search rather than guessing at the call."""

        from cogbench import memo

        for broken in ("not a list", [["factor"]], [["factor", 3]], [[["f"], "tuning"]]):
            with self.subTest(broken=broken):
                self.assertFalse(self.resolve().recalled)
                key = _key(self.root)
                stored = dict(_stored(self.root))
                stored["keywordPlans"] = [broken]
                memo.write(self.root, key, stored)

                again = self.resolve()

                self.assertTrue(again.ready, again.verdict.headline)
                self.assertFalse(again.recalled)
                cache_path(self.root).unlink()

    def test_opaque_inputs_and_missing_models_are_deliberate_misses(self):
        for options in (
            {"extras": {"opaque": object()}},
            {"prepare": lambda root, modules: {"weights_used": ("missing.dat",)}},
        ):
            with self.subTest(options=tuple(options)):
                for _ in range(2):
                    submission = self.resolve(**options)
                    self.assertTrue(submission.ready, submission.verdict.headline)
                    self.assertFalse(submission.recalled)
                self.assertFalse(cache_path(self.root).exists())

    def test_a_named_model_that_is_not_there_scores_without_a_receipt(self):
        """Naming a weight is not a claim that anything read it, so the name
        survives on its own. The key needs the file's bytes, so nothing is
        stored, which the loop above pins from the other side."""

        submission = self.resolve(
            prepare=lambda root, modules: {"weights_used": ("missing.dat",)}
        )

        self.assertTrue(submission.ready, submission.verdict.headline)
        self.assertEqual(submission.weights_used, ("missing.dat",))
        self.assertIsNone(submission.weights_captured)


if __name__ == "__main__":
    unittest.main()
