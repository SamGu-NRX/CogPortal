"""Sandbox payloads for the two Week 2 vision tracks.

The zip that reaches the sandbox has to carry the images and the questions
without carrying the answers, and without carrying an arrangement the answers
can be read off of.

Recognition needs both halves of that. Enrollment groups keep their
``person_id``, because ``run_recognition_scenario`` hands that id straight to
``enroll(person_id, images)``: the submission is told who it is enrolling, so
hiding the id would hide the task rather than the answer. Everything after
enrollment is the answer. Which person a query photo belongs to is the whole
``known`` gold vector. Which query photos belong to the stranger who is not
enrolled yet is the whole ``unknown_before`` vector, whose gold is a constant
``None``. Which belong to that stranger afterwards is the whole
``post_enrollment`` vector, whose gold is a constant id. So query photos leave
here as flat shuffled batches carrying no labels and no grouping, and the
controller keeps the map back.

Two batches and not one: ``unknown_before`` and ``post_enrollment`` are the
same stranger photographed before and after enrollment, and their correct
answers differ only because ``adapter.enroll`` runs between them. A single
``recognize`` call cannot ask both questions, so the minimum is two. Known
queries are dealt across both batches so that neither batch can be answered
with one constant label.

Clustering ships its images and its seed and never its labels; the controller
re-attaches those with ``attach_clustering_labels`` from ``expected.json``.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import zipfile
from dataclasses import dataclass, replace
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

RECOGNITION_ID = "vision-recognition"
CLUSTERING_ID = "vision-clustering"

#: Placed in a slot table to mean "nothing was written here yet". ``None`` is
#: a real prediction (it is how a submission says "I do not know this face"),
#: so it cannot double as the empty marker.
_UNFILLED = object()


@dataclass(frozen=True)
class RecognitionQueryPlan:
    """Where each shuffled query came from. Controller-only, never encoded.

    A *canonical slot* is a query's position in the concatenation
    ``recognition_expected`` builds: known queries in identity order, then the
    unknown queries, then the post-enrollment ones. ``before_slots[i]`` is the
    canonical slot of the i-th image in the batch the sandbox sees before the
    stranger is enrolled, and ``after_slots`` says the same for the batch it
    sees afterwards. Together they are the permutation, and inverting them
    turns flat predictions back into the shape ``score_recognition`` reads.

    ``known_query_counts`` records how many queries each known identity had,
    which is what splits the leading canonical slots back into per-identity
    runs. It is the single fact the sandbox payload most needs to not contain.
    """

    known_query_counts: Tuple[int, ...]
    unknown_count: int
    post_count: int
    before_slots: Tuple[int, ...]
    after_slots: Tuple[int, ...]

    @property
    def known_count(self) -> int:
        return sum(self.known_query_counts)

    @property
    def total(self) -> int:
        return self.known_count + self.unknown_count + self.post_count


# HMAC domain separation. `RUNNER_SIGNING_SECRET` also signs callbacks and
# weight requests; a distinct label keeps a permutation seed and a request
# signature independent uses of the one key.
_PERMUTATION_LABEL = b"cogworks/week2/recognition-permutation/v1"

# `encode_cases(seed_key=...)` defaults to reading the environment. A caller
# that means "no key" has to say `None`, so a missing secret is a loud failure
# rather than a quiet downgrade to the guessable seed.
_FROM_ENVIRONMENT = object()

SEED_KEY_VARIABLE = "RUNNER_SIGNING_SECRET"


def _seed_key(requested: Any) -> Optional[bytes]:
    """The HMAC key for this encode, or ``None`` for an unkeyed carrier plan."""

    if requested is not _FROM_ENVIRONMENT:
        return requested
    try:
        return os.environ[SEED_KEY_VARIABLE].encode("utf-8")
    except KeyError:
        raise RuntimeError(
            "Encoding a recognition payload needs {} to key its per-case "
            "permutation. The controller function declares the signing secret "
            "and already fails without it; a caller that is deliberately "
            "building an unkeyed carrier plan, as materialize_week2_official "
            "does, passes seed_key=None.".format(SEED_KEY_VARIABLE)
        ) from None


def _recognition_seed(case: Any, key: Optional[bytes]) -> int:
    """A per-case shuffle seed the sandbox cannot reproduce.

    The order has to be stable across runs so one submission scored twice sees
    the same batches, which rules out ``random.random()`` and the clock.
    ``RecognitionScenario`` carries no seed field, so the seed is a digest of
    case content.

    It cannot be a digest of anything the payload carries. This module ships
    inside the evaluation image (``modal_app.py`` copies
    ``apps/runner-modal/src`` to ``/opt/runner``, and the sandbox imports
    ``week2_payload`` from there to decode), so student code can read this
    function. A seed built from person ids or image counts would be
    recomputable in the sandbox, and recomputing it recovers the permutation,
    which recovers the grouping the permutation exists to hide.

    The digest therefore runs over the query images in canonical order, which
    is the grouping itself. That much used to be the whole argument, and it
    claimed more than it could: the search is flat, with no partial digest to
    match against, but a guess is checkable. Enumerate a canonical order,
    compute its seed, replay the shuffle and see whether it reproduces the
    batches you were handed. A reviewer did that on a two-identity case,
    3! x 3! = 36 orders per count guess, and recovered every label without
    comparing two faces. Worse, the benchmark hands the submission FaceNet, so
    it can group the queries by appearance first and enumerate only the orders
    within each group, which is a couple of permutations per person.

    So the digest is keyed. ``key`` is HMAC's key and the label below is domain
    separation from the callback signatures that key already makes, so the two
    uses stay independent. The sandbox is created without secrets
    (``modal_app.py`` passes none to ``Sandbox.create``) and the controller
    function holds them, so an enumerated order can no longer be checked: there
    is nothing to compare a guessed seed against.

    ``key`` is ``None`` only where the plan is a carrier rather than a secret.
    ``materialize_week2_official`` builds the hidden bundle on an operator's
    machine, which does not have the key, and its permutation is undone by
    ``attach_recognition_gold`` before the controller re-encodes each run with
    its own. Rotating the key reorders later hosted batches and invalidates
    nothing on the volume.
    """

    digest = hashlib.sha256()

    def absorb(image: Any) -> None:
        array = np.ascontiguousarray(np.asarray(image, dtype=np.uint8))
        digest.update(repr(array.shape).encode("utf-8"))
        digest.update(array.tobytes())
        digest.update(b"\x1e")

    for identity in case.known:
        digest.update(str(identity.person_id).encode("utf-8"))
        digest.update(b"\x1f")
        for image in identity.queries:
            absorb(image)
        digest.update(b"\x1d")
    digest.update(str(case.unknown_person_id).encode("utf-8"))
    digest.update(b"\x1f")
    for image in case.unknown_queries:
        absorb(image)
    digest.update(b"\x1d")
    for image in case.post_enrollment_queries:
        absorb(image)
    content = digest.digest()
    if key is None:
        return int.from_bytes(content[:8], "big")
    keyed = hmac.new(key, _PERMUTATION_LABEL + content, hashlib.sha256).digest()
    return int.from_bytes(keyed[:8], "big")


def _query_plan(case: Any, key: Optional[bytes]) -> RecognitionQueryPlan:
    """Deal the canonical query slots into the two sandbox batches.

    The deal itself belongs to the benchmark, which owns the lifecycle and the
    gold, and `facial_recognition_benchmark.drivers.query_phases` is the one
    both lanes call. This half is what the benchmark deliberately does not
    know: which seed a hosted run deals with, and the map from a shuffled batch
    back to a scored answer, which stays here and never enters a payload.

    Before they shared it, the two dealt differently. This one pooled every
    known slot and split the total, so one person's photos could land wholly on
    one side; the local driver split each person's own. Same lifecycle, and the
    same submission could score two numbers depending on where it ran.

    Imported inside the function, like the other benchmark imports in this
    module, so importing this module still works where the benchmark is not
    installed. Encoding a recognition case does not: this import and
    ``_canonical_query_images`` both run under ``encode_cases``, so that path
    now needs the benchmark the way decoding always has. Clustering is
    unaffected. Every caller that encodes recognition already installs it.
    """

    from facial_recognition_benchmark.drivers import query_phases

    known_query_counts = tuple(len(identity.queries) for identity in case.known)
    known_count = sum(known_query_counts)
    unknown_count = len(case.unknown_queries)
    post_count = len(case.post_enrollment_queries)

    before, after = query_phases(
        known_query_counts,
        unknown_count=unknown_count,
        post_count=post_count,
        seed=_recognition_seed(case, key),
    )
    # Checked on the deal rather than on a count that used to imply it. Half of
    # each person's own photos go to each side now, so two people with one
    # photo each leave the first batch holding nothing but the stranger, which
    # is answerable with one constant label and without looking at any pixels.
    # `known_count >= 2` no longer rules that out; this does. The check reads
    # the deal rather than restating the split rule, so it keeps working if the
    # split changes -- which is also why the message reports what was observed
    # instead of naming a photo count the rule happens to imply today.
    if not any(slot < known_count for slot in before):
        raise ValueError(
            "The first sandbox batch for this recognition case holds no query "
            "whose answer is somebody already enrolled; known query counts {}, "
            "{} unknown and {} post-enrollment. A batch holding only the "
            "stranger's photos is answerable with one constant label and "
            "without looking at any pixels.".format(
                list(known_query_counts), unknown_count, post_count
            )
        )
    return RecognitionQueryPlan(
        known_query_counts=known_query_counts,
        unknown_count=unknown_count,
        post_count=post_count,
        before_slots=before,
        after_slots=after,
    )


def encode_cases(
    benchmark_id: str, cases: Sequence[Any], *, seed_key: Any = _FROM_ENVIRONMENT
) -> Tuple[bytes, List[RecognitionQueryPlan]]:
    """Encode sandbox inputs, and return the map back for the controller.

    The returned plans are empty for clustering and one per case for
    recognition. They are the only record of which shuffled query is which, so
    the caller must keep them in memory and must never write them anywhere the
    sandbox can read. ``recognition_gold`` serializes them for the controller's
    own side of the hidden volume.

    ``seed_key`` keys each case's permutation; see ``_recognition_seed``. Left
    alone it reads ``RUNNER_SIGNING_SECRET``, which the controller function has
    and the sandbox does not. Pass ``None`` to build an unkeyed carrier plan,
    which is what the materialize tool wants and nothing else does. Clustering
    ignores it.
    """

    images: List[np.ndarray] = []

    def add(values: Sequence[Any]) -> List[int]:
        indexes = list(range(len(images), len(images) + len(values)))
        images.extend(np.asarray(value, dtype=np.uint8) for value in values)
        return indexes

    records: List[Dict[str, Any]] = []
    plans: List[RecognitionQueryPlan] = []
    if benchmark_id == RECOGNITION_ID:
        from facial_recognition_benchmark.drivers import canonical_query_images

        seed_key = _seed_key(seed_key)
        for case in cases:
            plan = _query_plan(case, seed_key)
            # Canonical slot order is the order `recognition_expected` builds
            # its gold in, so slot `i` here and entry `i` there are the same
            # image. Taking it from the benchmark rather than writing it out
            # again is what keeps the whole map from a shuffled batch back to a
            # scored answer honest.
            slot_images = canonical_query_images(case)
            # Enrollment images are allocated first, then the queries in the
            # order the sandbox will be handed them. Image indices are assigned
            # sequentially, so allocating a query image at the moment its batch
            # position is known keeps the index numbers from saying anything the
            # batch order does not already say. The previous layout allocated
            # per identity, which made each identity's images one contiguous
            # run: grouping the flat query indices into runs of consecutive
            # integers recovered the identity groups exactly, with no
            # ``person_id`` present anywhere.
            known_records = [
                {
                    "person_id": identity.person_id,
                    "enrollment": add(identity.enrollment),
                }
                for identity in case.known
            ]
            unknown_enrollment = add(case.unknown_enrollment)
            records.append(
                {
                    "known": known_records,
                    "unknown_person_id": case.unknown_person_id,
                    "unknown_enrollment": unknown_enrollment,
                    "queries_before_enrollment": add(
                        [slot_images[slot] for slot in plan.before_slots]
                    ),
                    "queries_after_enrollment": add(
                        [slot_images[slot] for slot in plan.after_slots]
                    ),
                }
            )
            plans.append(plan)
    elif benchmark_id == CLUSTERING_ID:
        for case in cases:
            records.append({"images": add(case.images), "seed": int(case.seed)})
    else:
        raise ValueError("Unsupported Week 2 benchmark.")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr(
            "metadata.json",
            json.dumps({"benchmark_id": benchmark_id, "cases": records}),
        )
        for index, image in enumerate(images):
            value = io.BytesIO()
            np.save(value, image, allow_pickle=False)
            archive.writestr("images/{:04d}.npy".format(index), value.getvalue())
    return buffer.getvalue(), plans


def _read_payload(payload: bytes) -> Tuple[Dict[str, Any], List[np.ndarray]]:
    with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
        metadata = json.loads(archive.read("metadata.json"))
        image_names = sorted(
            name for name in archive.namelist() if name.startswith("images/")
        )
        images = [
            np.load(io.BytesIO(archive.read(name)), allow_pickle=False)
            for name in image_names
        ]
    return metadata, images


def decode_cases(payload: bytes) -> Tuple[str, List[Any]]:
    """Rebuild the sandbox's view of the cases: images, no answers.

    A recognition case comes back with empty ``queries`` on every identity and
    empty ``unknown_queries``/``post_enrollment_queries``, because the payload
    holds none of those groupings. The queries arrive instead on
    ``shuffled_queries``, which is what ``run_recognition_scenario`` runs when
    it is present. Scoring a case in this state yields empty expected vectors
    and therefore zeroes rather than plausible-looking wrong numbers, so a
    controller that forgets to re-attach gold fails visibly.
    """

    from facial_recognition_benchmark.drivers import (
        ClusteringScenario,
        RecognitionIdentity,
        RecognitionScenario,
        ShuffledQueryBatches,
    )

    metadata, images = _read_payload(payload)
    benchmark_id = str(metadata["benchmark_id"])

    def select(indexes: Sequence[int]) -> List[np.ndarray]:
        return [images[int(index)] for index in indexes]

    if benchmark_id == RECOGNITION_ID:
        cases = [
            RecognitionScenario(
                known=[
                    RecognitionIdentity(
                        person_id=str(identity["person_id"]),
                        enrollment=select(identity["enrollment"]),
                        queries=[],
                    )
                    for identity in record["known"]
                ],
                unknown_person_id=str(record["unknown_person_id"]),
                unknown_queries=[],
                unknown_enrollment=select(record["unknown_enrollment"]),
                post_enrollment_queries=[],
                shuffled_queries=ShuffledQueryBatches(
                    before_enrollment=select(record["queries_before_enrollment"]),
                    after_enrollment=select(record["queries_after_enrollment"]),
                ),
            )
            for record in metadata["cases"]
        ]
    elif benchmark_id == CLUSTERING_ID:
        cases = [
            ClusteringScenario(
                images=select(record["images"]),
                expected_labels=[],
                seed=int(record["seed"]),
            )
            for record in metadata["cases"]
        ]
    else:
        raise ValueError("Unsupported Week 2 benchmark payload.")
    return benchmark_id, cases


def recognition_gold(plans: Sequence[RecognitionQueryPlan]) -> List[Dict[str, Any]]:
    """The plans in JSON form, for the controller's half of the hidden volume.

    This is the recognition track's ``expected.json``, in the same role
    clustering's already has: written beside ``payload.zip``, read only by the
    controller, never copied to a sandbox.
    """

    return [
        {
            "known_query_counts": [int(value) for value in plan.known_query_counts],
            "unknown_count": int(plan.unknown_count),
            "post_count": int(plan.post_count),
            "before_slots": [int(value) for value in plan.before_slots],
            "after_slots": [int(value) for value in plan.after_slots],
        }
        for plan in plans
    ]


def _plan_from_mapping(entry: Mapping[str, Any]) -> RecognitionQueryPlan:
    plan = RecognitionQueryPlan(
        known_query_counts=tuple(int(value) for value in entry["known_query_counts"]),
        unknown_count=int(entry["unknown_count"]),
        post_count=int(entry["post_count"]),
        before_slots=tuple(int(value) for value in entry["before_slots"]),
        after_slots=tuple(int(value) for value in entry["after_slots"]),
    )
    # Every canonical slot exactly once. A duplicated or missing slot would
    # silently score one query against another query's answer, so the message
    # names which slots are wrong rather than only that a count did not match:
    # a plan with the right length and the wrong contents is the case that
    # would otherwise read as healthy.
    covered = sorted(plan.before_slots + plan.after_slots)
    if covered != list(range(plan.total)):
        missing = sorted(set(range(plan.total)).difference(covered))
        duplicated = sorted({slot for slot in covered if covered.count(slot) > 1})
        raise ValueError(
            "Recognition gold does not describe a permutation of {} query "
            "slots: missing {}, duplicated {}.".format(
                plan.total, missing or "none", duplicated or "none"
            )
        )
    return plan


def attach_recognition_gold(payload: bytes, gold: Sequence[Mapping[str, Any]]) -> List[Any]:
    """Rebuild the real, gold-bearing cases from the payload plus its plans.

    Takes the payload bytes rather than decoded cases because the grouping has
    to be applied to the payload's image table, and the decoded
    ``RecognitionScenario`` deliberately does not expose that table.

    After this the controller holds cases identical in content to the ones the
    materialize tool encoded, so the official path and the practice path run
    the same code from here on.
    """

    from facial_recognition_benchmark.drivers import (
        RecognitionIdentity,
        RecognitionScenario,
    )

    metadata, images = _read_payload(payload)
    if str(metadata["benchmark_id"]) != RECOGNITION_ID:
        raise ValueError("Recognition gold was given a payload from another track.")
    records = metadata["cases"]
    if len(records) != len(gold):
        raise ValueError(
            "Official recognition gold covers {} cases; the payload holds "
            "{}.".format(len(gold), len(records))
        )

    cases: List[Any] = []
    for record, entry in zip(records, gold):
        plan = _plan_from_mapping(entry)
        before = record["queries_before_enrollment"]
        after = record["queries_after_enrollment"]
        if len(before) != len(plan.before_slots) or len(after) != len(plan.after_slots):
            raise ValueError("Official recognition gold does not match the payload batches.")
        slots: List[Any] = [None] * plan.total
        for position, slot in enumerate(plan.before_slots):
            slots[slot] = images[int(before[position])]
        for position, slot in enumerate(plan.after_slots):
            slots[slot] = images[int(after[position])]

        cursor = 0
        known = []
        for identity, count in zip(record["known"], plan.known_query_counts):
            known.append(
                RecognitionIdentity(
                    person_id=str(identity["person_id"]),
                    enrollment=[images[int(index)] for index in identity["enrollment"]],
                    queries=slots[cursor : cursor + count],
                )
            )
            cursor += count
        if len(known) != len(record["known"]):
            raise ValueError("Official recognition gold names a different identity count.")
        unknown_queries = slots[cursor : cursor + plan.unknown_count]
        cursor += plan.unknown_count
        cases.append(
            RecognitionScenario(
                known=known,
                unknown_person_id=str(record["unknown_person_id"]),
                unknown_queries=unknown_queries,
                unknown_enrollment=[
                    images[int(index)] for index in record["unknown_enrollment"]
                ],
                post_enrollment_queries=slots[cursor : cursor + plan.post_count],
            )
        )
    return cases


def restore_recognition_outputs(
    plan: RecognitionQueryPlan, output: Mapping[str, Sequence[Optional[str]]]
) -> Dict[str, List[Optional[str]]]:
    """Un-permute one case's flat predictions into the scored shape.

    ``run_recognition_scenario`` returns two flat batches when it ran from a
    payload, because the sandbox has no way to label them. This is the inverse
    of the shuffle, and it produces exactly the keys ``score_recognition``
    reads.
    """

    before = list(output.get("before_enrollment", ()))
    after = list(output.get("after_enrollment", ()))
    if len(before) != len(plan.before_slots) or len(after) != len(plan.after_slots):
        raise ValueError(
            "Submission returned {}+{} labels for {}+{} query images.".format(
                len(before), len(after), len(plan.before_slots), len(plan.after_slots)
            )
        )
    slots: List[Any] = [_UNFILLED] * plan.total
    for position, slot in enumerate(plan.before_slots):
        slots[slot] = before[position]
    for position, slot in enumerate(plan.after_slots):
        slots[slot] = after[position]
    if any(value is _UNFILLED for value in slots):
        raise ValueError("Recognition plan left a query slot unfilled.")
    known_end = plan.known_count
    unknown_end = known_end + plan.unknown_count
    return {
        "known": slots[:known_end],
        "unknown_before": slots[known_end:unknown_end],
        "post_enrollment": slots[unknown_end:],
    }


def attach_clustering_labels(cases: Sequence[Any], labels: Sequence[Sequence[Any]]) -> List[Any]:
    if len(cases) != len(labels):
        raise ValueError("Official clustering labels do not match the case count.")
    return [
        replace(case, expected_labels=list(expected))
        for case, expected in zip(cases, labels)
    ]
