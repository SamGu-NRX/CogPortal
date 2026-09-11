from __future__ import annotations

import os
import sys
import unittest
from unittest import mock
from importlib.util import find_spec
from pathlib import Path

try:
    import numpy as np
except ImportError:
    np = None

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))
sys.path.insert(0, str(ROOT / "benchmarks" / "week2" / "src"))


# Any key will do; what the tests check is that one is required, that it
# changes the permutation, and that the sandbox has no way to supply it.
KEY = b"test-permutation-key-that-is-long-enough"


def recognition_case(counts=(2, 2, 2), unknown=2, post=3):
    """A scenario whose every image carries a distinct value, so a slot is
    traceable through an encode and back."""

    from facial_recognition_benchmark.drivers import (
        RecognitionIdentity,
        RecognitionScenario,
    )

    counter = iter(range(1, 250))

    def image():
        return np.full((2, 2, 3), next(counter), dtype=np.uint8)

    return RecognitionScenario(
        known=[
            RecognitionIdentity(
                "person_{}".format(at), [image()], [image() for _ in range(count)]
            )
            for at, count in enumerate(counts)
        ],
        unknown_person_id="stranger",
        unknown_queries=[image() for _ in range(unknown)],
        unknown_enrollment=[image()],
        post_enrollment_queries=[image() for _ in range(post)],
    )


def _has(module: str) -> bool:
    """Whether `module` can actually be imported. Naming the submodule the
    tests import matters: a leftover `week2/src/facial_recognition_benchmark`
    directory with no `__init__.py` makes the parent resolve as a namespace
    package while every real module under it is missing."""

    try:
        return find_spec(module) is not None
    except (ImportError, ValueError):
        return False


@unittest.skipIf(
    np is None
    or find_spec("PIL") is None
    or not _has("facial_recognition_benchmark.drivers"),
    "Week 2 dependency lane only",
)
class Week2PayloadTests(unittest.TestCase):
    def test_clustering_payload_excludes_expected_labels(self):
        from cogworks_runner.week2_payload import decode_cases, encode_cases
        from facial_recognition_benchmark.drivers import ClusteringScenario

        case = ClusteringScenario(
            images=[np.zeros((2, 2, 3), dtype=np.uint8)],
            expected_labels=["secret-person"],
            seed=7,
        )
        # `encode_cases` returns the query permutation alongside the bytes now,
        # so recognition can shuffle its queries and keep the map controller-
        # side. Clustering has no queries to shuffle and gets an empty list;
        # the bytes it produces are unchanged.
        encoded, plans = encode_cases("vision-clustering", [case])
        self.assertEqual(plans, [])
        self.assertNotIn(b"secret-person", encoded)
        benchmark_id, decoded = decode_cases(encoded)
        self.assertEqual(benchmark_id, "vision-clustering")
        self.assertEqual(decoded[0].expected_labels, [])
        self.assertEqual(decoded[0].seed, 7)


@unittest.skipIf(
    np is None
    or find_spec("PIL") is None
    or not _has("facial_recognition_benchmark.drivers"),
    "Week 2 dependency lane only",
)
class RecognitionPayloadCannotAnswerItself(unittest.TestCase):
    """The recognition payload used to hand over the whole answer.

    `encode_cases` wrote each identity as {person_id, enrollment, queries} and
    the stranger's photos as their own named lists. Every label
    `recognition_expected` produces is a function of exactly that: the known
    vector is each identity's id repeated once per query, the unknown vector is
    None repeated once per unknown query, the post-enrollment vector is the
    stranger's id repeated once per post-enrollment query. A submission that
    read metadata.json and opened no image scored 1.0.

    These tests assert the property rather than the absence of a string. A
    grep for the ids passes on a payload that groups queries without naming
    them, and grouping alone is enough: `score_recognition` buckets by expected
    label, so any consistent renaming of the groups scores identically.
    """

    def _case(self):
        from facial_recognition_benchmark.drivers import (
            RecognitionIdentity,
            RecognitionScenario,
        )

        # Distinct pixel values so a mis-routed image is visible as a wrong
        # value rather than as a silent duplicate.
        counter = iter(range(1, 250))

        def image():
            return np.full((2, 2, 3), next(counter), dtype=np.uint8)

        return RecognitionScenario(
            known=[
                RecognitionIdentity("secret-alice", [image(), image()], [image(), image()]),
                RecognitionIdentity("secret-bob", [image(), image()], [image(), image()]),
                RecognitionIdentity("secret-carol", [image(), image()], [image(), image()]),
            ],
            unknown_person_id="secret-dave",
            unknown_queries=[image(), image()],
            unknown_enrollment=[image(), image()],
            post_enrollment_queries=[image(), image(), image()],
        )

    def _encode(self, case):
        """Encode one case, tolerating either return shape of `encode_cases`.

        The fix changed that function to return the query permutation beside
        the bytes. Normalizing here rather than unpacking inline is what lets
        the confidentiality assertions below run against a payload built by
        either version: a test that dies on a tuple-unpack proves the signature
        moved, which is not the property any of this is about.
        """

        from cogworks_runner.week2_payload import SEED_KEY_VARIABLE, encode_cases

        # Through the default path, so these run the way the controller does.
        # Scoped rather than assigned, because this module shares a process
        # with the callback tests that also write this variable.
        with mock.patch.dict(os.environ, {SEED_KEY_VARIABLE: KEY.decode("utf-8")}):
            result = encode_cases("vision-recognition", [case])
        if isinstance(result, tuple):
            return result
        return result, []

    def _to_scored_shape(self, output, plans):
        """One case's driver output in the shape `score_recognition` reads.

        With the shuffle in place the driver returns two unlabelled batches and
        the plan un-permutes them. Without it the driver already returns the
        lifecycle shape and there is nothing to undo. Handling both is what
        lets the score assertions below judge the payload rather than the
        function names around it.
        """

        if not plans:
            return output

        from cogworks_runner.week2_payload import restore_recognition_outputs

        return restore_recognition_outputs(plans[0], output)

    def _metadata(self, payload):
        import io
        import json
        import zipfile

        with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
            return json.loads(archive.read("metadata.json"))

    def test_the_payload_no_longer_determines_the_expected_labels(self):
        """The property, stated as what the payload leaves undetermined.

        `recognition_expected` is a pure function of the query grouping, so the
        question is whether the payload pins that grouping down. Before the fix
        it pinned it exactly: `known[i]["queries"]` said which photos were
        identity i's, `unknown_queries` said which were the stranger's, and
        exactly one label vector was consistent with the metadata. After it,
        the metadata fixes only the batch sizes, and every way of cutting those
        images into identity runs and phases is equally consistent.

        Counting those, rather than asserting the truth is absent from them, is
        the assertion that means something. An enumeration of all groupings
        contains the real one by definition; what changed is that it is now one
        of many instead of the only one.
        """

        from facial_recognition_benchmark.drivers import recognition_expected

        case = self._case()
        payload, _plans = self._encode(case)
        record = self._metadata(payload)["cases"][0]
        truth = recognition_expected(case)

        candidates = _consistent_answers(record)
        self.assertIn(
            truth,
            candidates,
            "The enumeration is meant to cover the real grouping; if it does "
            "not, the count below is measuring the wrong thing.",
        )
        # Measured on this case (3 identities, 2 queries each, 2 unknown, 3
        # post): 1 candidate against the old layout, 210 against the new one.
        # The exact number is a function of the case shape and is not the
        # claim; "more than one" is, because one means determined.
        self.assertGreater(len(candidates), 1)

    def test_a_submission_that_only_reads_the_payload_cannot_score(self):
        """The end-to-end version, scored through the real metrics.

        The adapter here is the leak report's attack as a submission: it opens
        the payload zip, reads metadata.json, ignores every image it is handed,
        and answers from structure alone. Against the old payload that is a
        perfect score. What it can still reach is asserted rather than
        described, because a number is checkable and a claim is not.

        `known_identification` is the assertion that matters, and it is 0.0.
        That metric is the one the grouping used to hand over outright, and no
        arrangement of the payload's remaining fields recovers any part of it.

        `recognition_score` stays at 0.5 rather than falling to 0.0, and that
        residual is not a payload leak. It is the driver's fixed call sequence:
        recognize, enroll, recognize. A submission that counts its own calls
        answers all-None on the first and the just-enrolled id on the second,
        and scores `unknown_lifecycle` 1.0 without a payload at all. Closing it
        means changing the lifecycle the course teaches, so it is left open
        here and named rather than papered over.
        """

        from cogworks_runner.week2_payload import decode_cases
        from facial_recognition_benchmark.drivers import (
            recognition_expected,
            run_recognition_scenario,
        )
        from facial_recognition_benchmark.metrics import score_recognition

        case = self._case()
        payload, plans = self._encode(case)
        _benchmark_id, sandbox_cases = decode_cases(payload)
        record = self._metadata(payload)["cases"][0]

        class PayloadReader:
            """Answers from metadata.json. Never looks at an image."""

            def __init__(self, model):
                self.calls = 0
                self.identity_ids = [
                    identity["person_id"] for identity in record["known"]
                ]
                self.stranger = record["unknown_person_id"]

            def enroll(self, person_id, images):
                pass

            def recognize(self, images):
                self.calls += 1
                answer = _read_off_the_answer(record)
                if answer is not None:
                    # Pre-fix: the grouping is in the payload, so emit it.
                    phase = answer["known"] if self.calls == 1 else answer["post_enrollment"]
                    return list(phase)[: len(images)] + [None] * max(
                        0, len(images) - len(phase)
                    )
                # Post-fix: nothing left to read, so guess by call order.
                return [None if self.calls == 1 else self.stranger] * len(images)

        output = run_recognition_scenario(PayloadReader, object(), sandbox_cases[0])
        scores = score_recognition(
            [self._to_scored_shape(output, plans)], [recognition_expected(case)]
        )

        self.assertEqual(scores["known_identification"], 0.0)
        self.assertLess(scores["recognition_score"], 1.0)
        # Measured on this case: 0.5, all of it from the call-order guess
        # described above and none of it from the payload.
        self.assertEqual(scores["recognition_score"], 0.5)

    def test_queries_leave_as_batches_with_no_identity_grouping(self):
        """No per-identity query list, and no separate stranger list.

        Three separate named query lists would still say which photos are the
        stranger's, and `unknown_before` gold is a constant None, so that name
        alone answers a whole phase. Batch membership is checked as a set so
        the assertion does not accidentally depend on the shuffle.
        """

        case = self._case()
        payload, _plans = self._encode(case)
        record = self._metadata(payload)["cases"][0]

        for identity in record["known"]:
            self.assertEqual(sorted(identity), ["enrollment", "person_id"])
        self.assertNotIn("queries", record)
        self.assertNotIn("unknown_queries", record)
        self.assertNotIn("post_enrollment_queries", record)

        batched = sorted(
            record["queries_before_enrollment"] + record["queries_after_enrollment"]
        )
        expected_total = (
            sum(len(identity.queries) for identity in case.known)
            + len(case.unknown_queries)
            + len(case.post_enrollment_queries)
        )
        self.assertEqual(len(batched), expected_total)
        self.assertEqual(len(set(batched)), expected_total)

    def test_neither_batch_is_answerable_with_one_constant_label(self):
        """Both batches hold known-identity queries.

        A batch containing only the stranger's photos has a constant correct
        answer (all None before enrollment, all the stranger's id after), and a
        submission that recognized the batch by its size could return that
        constant and score the phase perfectly. Mixing known queries into both
        makes a constant answer wrong for part of every batch.
        """

        case = self._case()
        payload, plans = self._encode(case)
        plan = plans[0]
        known_slots = set(range(plan.known_count))
        self.assertTrue(known_slots.intersection(plan.before_slots))
        self.assertTrue(known_slots.intersection(plan.after_slots))

    def test_the_batch_order_is_stable_across_encodings(self):
        """Same case in, same order out, with no seed field on the scenario.

        A submission scored twice has to see the same questions, so the shuffle
        is seeded from case content rather than from the clock or from
        `random.random()`.
        """

        case = self._case()
        first, first_plans = self._encode(case)
        second, second_plans = self._encode(case)
        self.assertEqual(first, second)
        self.assertEqual(first_plans, second_plans)

    def test_the_shuffle_is_not_the_identity_order(self):
        """A permutation that leaves everything in place hides nothing."""

        case = self._case()
        _payload, plans = self._encode(case)
        plan = plans[0]
        self.assertNotEqual(
            list(plan.before_slots) + list(plan.after_slots),
            list(range(plan.total)),
        )

    def test_a_correct_submission_still_scores_one(self):
        """The round trip: shuffle, answer honestly, un-shuffle, score 1.0.

        Guards the half of this that is easy to get wrong. A payload that hides
        the answer but scores an honest submission at anything below 1.0 has
        broken the benchmark instead of securing it.
        """

        from cogworks_runner.week2_payload import (
            decode_cases,
            restore_recognition_outputs,
        )
        from facial_recognition_benchmark.drivers import (
            recognition_expected,
            run_recognition_scenario,
        )
        from facial_recognition_benchmark.metrics import score_recognition

        case = self._case()
        payload, plans = self._encode(case)
        _benchmark_id, sandbox_cases = decode_cases(payload)

        # Recognizes by pixel value, which is the honest answer for these
        # synthetic images: it has to actually look at each one.
        class ByPixelValue:
            def __init__(self, model):
                self.database = {}

            def enroll(self, person_id, images):
                self.database[person_id] = {int(item[0, 0, 0]) for item in images}

            def recognize(self, images):
                return [
                    next(
                        (
                            name
                            for name, values in self.database.items()
                            if int(item[0, 0, 0]) in values
                        ),
                        None,
                    )
                    for item in images
                ]

        # The synthetic images are unique per photo, so enrollment pixels alone
        # would never match a query. The adapter is seeded with the mapping a
        # real descriptor pipeline would have learned from the face.
        truth_by_pixel = {}
        for identity in case.known:
            for item in list(identity.enrollment) + list(identity.queries):
                truth_by_pixel[int(item[0, 0, 0])] = identity.person_id
        for item in list(case.unknown_enrollment) + list(case.post_enrollment_queries):
            truth_by_pixel[int(item[0, 0, 0])] = case.unknown_person_id

        class Oracle(ByPixelValue):
            def enroll(self, person_id, images):
                self.database[person_id] = {
                    value for value, name in truth_by_pixel.items() if name == person_id
                }

        output = run_recognition_scenario(Oracle, object(), sandbox_cases[0])
        self.assertEqual(sorted(output), ["after_enrollment", "before_enrollment"])
        restored = restore_recognition_outputs(plans[0], output)
        self.assertEqual(restored, recognition_expected(case))
        scores = score_recognition([restored], [recognition_expected(case)])
        self.assertEqual(scores["recognition_score"], 1.0)

    def test_the_controller_rebuilds_the_original_case_from_its_gold(self):
        """The official path: payload plus expected.json equals the real case.

        `attach_recognition_gold` is what `_v2_cases` calls, and the cases it
        returns are what `recognition_expected` scores against. If it rebuilt
        the grouping wrongly, every official run would score against the wrong
        answer while looking healthy.
        """

        from cogworks_runner.week2_payload import (
            attach_recognition_gold,
            recognition_gold,
        )
        from facial_recognition_benchmark.drivers import recognition_expected

        case = self._case()
        payload, plans = self._encode(case)
        rebuilt = attach_recognition_gold(payload, recognition_gold(plans))[0]

        self.assertEqual(recognition_expected(rebuilt), recognition_expected(case))
        for original, restored in zip(case.known, rebuilt.known):
            self.assertEqual(original.person_id, restored.person_id)
            for left, right in zip(original.queries, restored.queries):
                self.assertTrue(np.array_equal(left, right))
        for left, right in zip(case.unknown_queries, rebuilt.unknown_queries):
            self.assertTrue(np.array_equal(left, right))
        for left, right in zip(case.post_enrollment_queries, rebuilt.post_enrollment_queries):
            self.assertTrue(np.array_equal(left, right))

    def test_scoring_a_sandbox_case_refuses_instead_of_returning_zero(self):
        """A forgotten re-attach has to be loud.

        The sandbox's own view of a case has empty query lists, so labels built
        from it would be three empty vectors: `score_recognition` reads those
        as a submission that got everything wrong rather than as a controller
        that never loaded the answers.
        """

        from cogworks_runner.week2_payload import decode_cases
        from facial_recognition_benchmark.drivers import recognition_expected

        payload, _plans = self._encode(self._case())
        _benchmark_id, sandbox_cases = decode_cases(payload)
        with self.assertRaisesRegex(ValueError, "Re-attach the official gold"):
            recognition_expected(sandbox_cases[0])


def _read_off_the_answer(record):
    """The pre-fix attack: build the answer from the metadata's own grouping.

    Returns None when the metadata does not carry a grouping to read, which is
    the post-fix state and the point of the fix.
    """

    identities = record["known"]
    if not all("queries" in identity for identity in identities):
        return None
    if "unknown_queries" not in record or "post_enrollment_queries" not in record:
        return None
    return {
        "known": [
            identity["person_id"] for identity in identities for _ in identity["queries"]
        ],
        "unknown_before": [None] * len(record["unknown_queries"]),
        "post_enrollment": [record["unknown_person_id"]] * len(
            record["post_enrollment_queries"]
        ),
    }


def _consistent_answers(record):
    """Every expected-label vector the payload's metadata still allows.

    A grouping is consistent when it uses each identity at least once, assigns
    every query image to exactly one phase, and matches the batch sizes the
    metadata shows. The old layout admitted one. Bounded by the case sizes the
    manifests use: the public tiers run 3 and 5 known identities.
    """

    determined = _read_off_the_answer(record)
    if determined is not None:
        return [determined]

    identity_ids = [identity["person_id"] for identity in record["known"]]
    unknown_id = record["unknown_person_id"]
    total = len(record["queries_before_enrollment"]) + len(
        record["queries_after_enrollment"]
    )
    answers = []
    for known_count in range(len(identity_ids), total + 1):
        for cuts in _compositions(known_count, len(identity_ids)):
            known = [
                identity_ids[index]
                for index, count in enumerate(cuts)
                for _ in range(count)
            ]
            for unknown_count in range(0, total - known_count + 1):
                answers.append(
                    {
                        "known": known,
                        "unknown_before": [None] * unknown_count,
                        "post_enrollment": [unknown_id]
                        * (total - known_count - unknown_count),
                    }
                )
    return answers


def _compositions(total, parts):
    """Every way to write `total` as `parts` positive integers, in order."""

    if parts == 1:
        yield (total,)
        return
    for first in range(1, total - parts + 2):
        for rest in _compositions(total - first, parts - 1):
            yield (first,) + rest


if __name__ == "__main__":
    unittest.main()


@unittest.skipIf(
    np is None
    or find_spec("PIL") is None
    or not _has("facial_recognition_benchmark.drivers"),
    "Week 2 dependency lane only",
)
class TheTwoLanesDealTheSameWay(unittest.TestCase):
    """One deal, owned by the benchmark, used by both consumers.

    They used to deal differently: this side pooled every known slot and split
    the total, so one person's photos could land wholly on one side, while the
    local driver split each person's own. The same submission could score two
    numbers depending on where it ran, and only one of the two measured
    whether every person survived the stranger's enrollment.
    """

    def case(self, counts=(2, 2, 2), unknown=2, post=3):
        return recognition_case(counts, unknown, post)

    def test_the_plan_is_the_benchmarks_deal_and_not_a_second_one(self):
        from facial_recognition_benchmark.drivers import query_phases

        from cogworks_runner.week2_payload import _query_plan, _recognition_seed

        case = self.case()
        plan = _query_plan(case, KEY)

        self.assertEqual(
            (plan.before_slots, plan.after_slots),
            query_phases(
                plan.known_query_counts,
                unknown_count=plan.unknown_count,
                post_count=plan.post_count,
                seed=_recognition_seed(case, KEY),
            ),
        )

    def test_a_case_whose_first_batch_would_hold_only_the_stranger_is_refused(self):
        # Two people with one held-out photo each: the count is two, but with
        # the deal splitting each person's own photos both land after the
        # enrollment, so the old `known_count < 2` test no longer rules it out.
        from cogworks_runner.week2_payload import _query_plan

        with self.assertRaises(ValueError) as caught:
            _query_plan(self.case(counts=(1, 1)), KEY)

        self.assertIn("holds no query whose answer is somebody already enrolled",
                      str(caught.exception))

    def test_a_single_person_with_two_photos_is_enough(self):
        from cogworks_runner.week2_payload import _query_plan

        plan = _query_plan(self.case(counts=(2,), unknown=1, post=1), KEY)

        self.assertTrue(any(slot < 2 for slot in plan.before_slots))
        self.assertTrue(any(slot < 2 for slot in plan.after_slots))


@unittest.skipIf(
    np is None
    or find_spec("PIL") is None
    or not _has("facial_recognition_benchmark.drivers"),
    "Week 2 dependency lane only",
)
class OnlyTheControllerCanDealTheHostedOrder(unittest.TestCase):
    """The seed is keyed, so an enumerated guess has nothing to check against.

    The old argument was that digesting the query images in canonical order
    makes the seed unreproducible, because canonical order is the grouping.
    That is not what it gives you. The search is flat, but a guess is
    checkable: enumerate an order, compute its seed, replay the shuffle, see
    whether it reproduces the batches you were handed. A reviewer recovered
    every label on a two-identity case that way, and the benchmark hands the
    submission FaceNet, so the orders worth enumerating are only the ones
    inside each look-alike group.

    A key removes the check. These tests pin that it is required, that it
    changes the answer, and that the one caller allowed to go without it is the
    operator tool, whose permutation is a carrier rather than a secret.
    """

    def case(self, counts=(2, 2, 2), unknown=2, post=3):
        return recognition_case(counts, unknown, post)

    def test_the_same_case_deals_differently_under_a_different_key(self):
        from cogworks_runner.week2_payload import _query_plan

        case = self.case()
        mine = _query_plan(case, KEY)
        theirs = _query_plan(case, b"a-different-key")

        self.assertEqual(mine.known_query_counts, theirs.known_query_counts)
        self.assertNotEqual(
            (mine.before_slots, mine.after_slots),
            (theirs.before_slots, theirs.after_slots),
        )

    def test_the_content_digest_a_sandbox_could_recompute_is_not_the_seed(self):
        """What student code can compute, having this module and the images."""

        from cogworks_runner.week2_payload import _recognition_seed

        case = self.case()

        self.assertNotEqual(_recognition_seed(case, None), _recognition_seed(case, KEY))

    def test_the_same_key_deals_the_same_case_the_same_way_every_time(self):
        from cogworks_runner.week2_payload import _query_plan

        case = self.case()
        first = _query_plan(case, KEY)
        again = _query_plan(case, KEY)

        self.assertEqual(
            (first.before_slots, first.after_slots), (again.before_slots, again.after_slots)
        )

    def test_encoding_without_the_secret_fails_loudly_and_names_it(self):
        from cogworks_runner.week2_payload import SEED_KEY_VARIABLE, encode_cases

        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError) as caught:
                encode_cases("vision-recognition", [self.case()])

        self.assertIn(SEED_KEY_VARIABLE, str(caught.exception))

    def test_the_carrier_the_operator_tool_builds_needs_no_secret(self):
        """`materialize_week2_official` runs where the key is not."""

        from cogworks_runner.week2_payload import encode_cases

        with mock.patch.dict(os.environ, {}, clear=True):
            payload, plans = encode_cases(
                "vision-recognition", [self.case()], seed_key=None
            )

        self.assertTrue(payload)
        self.assertEqual(len(plans), 1)

    def test_clustering_never_needs_the_secret(self):
        from facial_recognition_benchmark.drivers import ClusteringScenario

        from cogworks_runner.week2_payload import encode_cases

        case = ClusteringScenario(
            images=[np.full((2, 2, 3), at, dtype=np.uint8) for at in range(1, 5)],
            expected_labels=[0, 0, 1, 1],
            seed=7,
        )
        with mock.patch.dict(os.environ, {}, clear=True):
            payload, plans = encode_cases("vision-clustering", [case])

        self.assertTrue(payload)
        self.assertEqual(plans, [])
