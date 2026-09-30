"""Benchmark-owned execution drivers for student application behavior."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from .adapters import AdapterContractError, adapt_clustering, adapt_recognition, instantiate
from .contracts import ClusterId, Image, PersonId


@dataclass(frozen=True)
class RecognitionIdentity:
    """Enrollment and held-out images for one known identity."""

    person_id: PersonId
    enrollment: Sequence[Image]
    queries: Sequence[Image]


@dataclass(frozen=True)
class ShuffledQueryBatches:
    """Query images with their labels and their grouping removed.

    A hosted evaluation cannot hand the submission ``known``,
    ``unknown_queries``, and ``post_enrollment_queries`` as three named lists,
    because those names are the answer: everything in ``unknown_queries`` is
    correctly labelled ``None``, and everything in ``post_enrollment_queries``
    is correctly labelled with the identity just enrolled. So the runner deals
    every query image into these two batches in an order the submission cannot
    predict, and un-permutes the predictions afterwards.

    Two batches rather than one, because the stranger's photos are asked about
    twice with two different correct answers, and ``enroll`` has to run between
    the asking. Both batches also carry known-identity queries, so neither can
    be answered with a single constant label.

    Each batch is still one ``recognize`` call. Clustering the whole batch and
    then labelling the clusters is a technique this week teaches, and splitting
    the batch into one call per image would forbid it.
    """

    before_enrollment: Sequence[Image]
    after_enrollment: Sequence[Image]


@dataclass(frozen=True)
class RecognitionScenario:
    """One complete known-to-unknown recognition lifecycle.

    The same fresh adapter is retained across initial enrollment, known
    queries, unknown rejection, enrollment of that unknown identity, and
    held-out re-identification.

    ``shuffled_queries`` is absent for a locally built scenario, which is the
    case a student runs against the public manifests and the case
    ``recognition_scenarios`` returns. Then the three query lists above are
    populated and the driver runs the lifecycle in its plain form. It is
    present only for a scenario rebuilt from a hosted payload, where those
    three lists are empty and the images live in the batches instead.
    """

    known: Sequence[RecognitionIdentity]
    unknown_person_id: PersonId
    unknown_queries: Sequence[Image]
    unknown_enrollment: Sequence[Image]
    post_enrollment_queries: Sequence[Image]
    shuffled_queries: Optional[ShuffledQueryBatches] = None


@dataclass(frozen=True)
class ClusteringScenario:
    """One fixed image partition and random seed for Whispers evaluation.

    ``scored`` marks whether this case contributes to the metrics. The seed
    sweep re-runs the same images under other seeds to report how far a
    randomized clusterer's answer moves; those repeats are diagnostic and
    must not change the number a team publishes.

    ``scenario_key`` names the manifest scenario a case belongs to, so the
    sweep compares each repeat against its own scenario's scored case
    rather than against every scenario at once. ``None`` means the case
    attaches to the most recent scored case in the list, which is the
    order ``clustering_scenarios`` emits them in.
    """

    images: Sequence[Image]
    expected_labels: Sequence[ClusterId]
    seed: int
    scored: bool = True
    scenario_key: Optional[str] = None


RecognitionOutput = Dict[str, List[Optional[PersonId]]]


def run_recognition_scenario(
    factory: Any, model: Any, scenario: RecognitionScenario
) -> RecognitionOutput:
    """Run one stateful recognition lifecycle with a fresh student adapter.

    Parameters
    ----------
    factory
        Raw submission factory or compatible application object.
    model
        Benchmark-owned FaceNet model supplied to the factory.
    scenario
        Enrollment and query sequence to execute.

    Returns
    -------
    dict
        Labels for known, pre-enrollment unknown, and post-enrollment queries.
    """

    adapter = adapt_recognition(instantiate(factory, model))
    for identity in scenario.known:
        adapter.enroll(identity.person_id, identity.enrollment)

    # See `recognition_expected` on why this is a getattr: a scenario-shaped
    # object without the field is a locally built case and takes the plain path.
    batches = getattr(scenario, "shuffled_queries", None)
    if batches is not None:
        return _run_shuffled_queries(adapter, scenario, batches)

    known_images: List[Image] = []
    for identity in scenario.known:
        known_images.extend(identity.queries)
    known = _recognition_labels(adapter.recognize(known_images), len(known_images), "known")

    unknown_before = _recognition_labels(
        adapter.recognize(scenario.unknown_queries),
        len(scenario.unknown_queries),
        "unknown-before-enrollment",
    )
    adapter.enroll(scenario.unknown_person_id, scenario.unknown_enrollment)
    post_enrollment = _recognition_labels(
        adapter.recognize(scenario.post_enrollment_queries),
        len(scenario.post_enrollment_queries),
        "post-enrollment",
    )
    return {
        "known": known,
        "unknown_before": unknown_before,
        "post_enrollment": post_enrollment,
    }


def _run_shuffled_queries(
    adapter: Any, scenario: RecognitionScenario, batches: ShuffledQueryBatches
) -> RecognitionOutput:
    """The same lifecycle, asked in label-free batches.

    The enrollment calls, their order, and the position of ``enroll`` between
    the two ``recognize`` calls are identical to the plain path. Only the
    contents of the two batches differ, and the caller that built them holds
    the map back to ``known``/``unknown_before``/``post_enrollment``.
    """

    before = _recognition_labels(
        adapter.recognize(batches.before_enrollment),
        len(batches.before_enrollment),
        "before-enrollment",
    )
    adapter.enroll(scenario.unknown_person_id, scenario.unknown_enrollment)
    after = _recognition_labels(
        adapter.recognize(batches.after_enrollment),
        len(batches.after_enrollment),
        "after-enrollment",
    )
    return {"before_enrollment": before, "after_enrollment": after}


def run_clustering_scenario(
    factory: Any, model: Any, scenario: ClusteringScenario
) -> List[ClusterId]:
    """Run and validate one clustering case with a fresh student adapter.

    Cluster identifiers may be arbitrary strings or integers. Only their
    partition relationships are meaningful to scoring.
    """

    adapter = adapt_clustering(instantiate(factory, model))
    labels = adapter.cluster(scenario.images, seed=scenario.seed)
    if isinstance(labels, (str, bytes)):
        raise AdapterContractError("cluster() must return one label per image, not a string.")
    try:
        output = list(labels)
    except TypeError as error:
        raise AdapterContractError("cluster() must return a sequence of labels.") from error
    if len(output) != len(scenario.images):
        raise AdapterContractError(
            f"cluster() returned {len(output)} labels for {len(scenario.images)} images."
        )
    for index, label in enumerate(output):
        if isinstance(label, np.generic):
            label = label.item()
            output[index] = label
        if isinstance(label, bool) or not isinstance(label, (str, int)):
            raise AdapterContractError(f"cluster() label {index} must be a string or integer.")
    return output


def recognition_expected(scenario: RecognitionScenario) -> RecognitionOutput:
    """Construct trusted labels for a recognition lifecycle scenario.

    Raises on a scenario carrying ``shuffled_queries``. That is the sandbox's
    own gold-free view, whose three query lists are empty by construction, so
    the answer built from it would be three empty vectors. Scored, those give a
    quiet zero that looks like a submission failing rather than like the
    controller forgetting to re-attach gold.
    """

    # `getattr` rather than attribute access: this function accepts anything
    # scenario-shaped, and `test_metrics.py` scores a SimpleNamespace built
    # from the five fields below. A structural caller that predates this field
    # is a locally built case, which is exactly the gold-bearing kind.
    if getattr(scenario, "shuffled_queries", None) is not None:
        raise ValueError(
            "This scenario came from a hosted payload and carries no labels. "
            "Re-attach the official gold before scoring it."
        )
    known: List[Optional[PersonId]] = []
    for identity in scenario.known:
        known.extend([identity.person_id] * len(identity.queries))
    return {
        "known": known,
        "unknown_before": [None] * len(scenario.unknown_queries),
        "post_enrollment": [scenario.unknown_person_id] * len(scenario.post_enrollment_queries),
    }


def _recognition_labels(value: Any, expected_count: int, phase: str) -> List[Optional[str]]:
    if isinstance(value, (str, bytes)):
        raise AdapterContractError(
            f"recognize() must return one label per image during {phase}, not a string."
        )
    try:
        output = list(value)
    except TypeError as error:
        raise AdapterContractError(f"recognize() must return a sequence during {phase}.") from error
    if len(output) != expected_count:
        raise AdapterContractError(
            f"recognize() returned {len(output)} labels for {expected_count} images during {phase}."
        )
    normalized: List[Optional[str]] = []
    for index, label in enumerate(output):
        if label is None:
            normalized.append(None)
        elif isinstance(label, str):
            normalized.append(label)
        else:
            raise AdapterContractError(
                f"recognize() label {index} during {phase} must be a string or None."
            )
    return normalized
