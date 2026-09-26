"""End-to-end checks against two deliberately different application designs.

Reynaldo's application is the class-based golden reference.  The second
fixture follows the 2024 ``FaceRecognizer`` project's organization: profiles
and a database are plain data objects while recognition and clustering live in
standalone functions.  Its adapter contains translation only, demonstrating
that the benchmark does not require Reynaldo's class hierarchy.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

import numpy as np
from face_recognition import FaceRecognitionApp

from facial_recognition_benchmark.drivers import (
    ClusteringScenario,
    RecognitionIdentity,
    RecognitionScenario,
    recognition_expected,
    run_clustering_scenario,
    run_recognition_scenario,
)
from facial_recognition_benchmark.metrics import score_clustering, score_recognition


def image(red: int, green: int, blue: int) -> np.ndarray:
    """Create a tiny one-face RGB fixture."""

    value = np.empty((3, 3, 3), dtype=np.uint8)
    value[:, :] = (red, green, blue)
    return value


class FakeFaceNet:
    """Produce deterministic descriptors from each image's mean RGB color."""

    def detect(self, value: np.ndarray):
        """Return one full-image face box with a perfect detection score."""

        height, width = value.shape[:2]
        return (
            np.asarray([[0.0, 0.0, float(width), float(height)]]),
            np.asarray([1.0]),
            np.zeros((1, 5, 2), dtype=float),
        )

    def compute_descriptors(self, value: np.ndarray, boxes: np.ndarray) -> np.ndarray:
        """Return one normalized color descriptor for each supplied box."""

        descriptor = np.zeros(512, dtype=float)
        descriptor[:3] = np.asarray(value, dtype=float).mean(axis=(0, 1))
        norm = np.linalg.norm(descriptor)
        if norm == 0:
            descriptor[3] = 1.0
        else:
            descriptor /= norm
        return np.repeat(descriptor[None, :], len(boxes), axis=0)


@dataclass
class Profile:
    """Store descriptors for one person in the 2024-style fixture."""

    name: str
    descriptors: List[np.ndarray] = field(default_factory=list)


class FaceDatabase:
    """Minimal name-to-profile mapping modeled after the 2024 sample."""

    def __init__(self) -> None:
        self.data: Dict[str, Profile] = {}

    def add(self, name: str, descriptors: Sequence[np.ndarray]) -> None:
        """Create or update a profile with new descriptors."""

        profile = self.data.setdefault(name, Profile(name))
        profile.descriptors.extend(descriptors)


def descriptors_for(model: Any, images: Sequence[np.ndarray]) -> List[np.ndarray]:
    """Describe the first face in each one-face image."""

    output = []
    for value in images:
        boxes, _, _ = model.detect(value)
        output.append(model.compute_descriptors(value, boxes[:1])[0])
    return output


def enroll_images(
    database: FaceDatabase,
    model: Any,
    person_id: str,
    images: Sequence[np.ndarray],
) -> None:
    """Add image descriptors to a named profile."""

    database.add(person_id, descriptors_for(model, images))


def identify_images(
    database: FaceDatabase,
    model: Any,
    images: Sequence[np.ndarray],
    threshold: float = 0.5,
) -> List[Optional[str]]:
    """Match images against mean profile descriptors by cosine distance."""

    labels: List[Optional[str]] = []
    for descriptor in descriptors_for(model, images):
        distances = [
            (
                1.0
                - float(
                    np.dot(descriptor, np.mean(profile.descriptors, axis=0))
                ),
                name,
            )
            for name, profile in database.data.items()
        ]
        distance, name = min(distances, default=(float("inf"), None))
        labels.append(name if distance <= threshold else None)
    return labels


def cluster_images(model: Any, images: Sequence[np.ndarray]) -> List[int]:
    """Group descriptors using the same threshold as recognition."""

    representatives: List[np.ndarray] = []
    labels: List[int] = []
    for descriptor in descriptors_for(model, images):
        label = next(
            (
                index
                for index, representative in enumerate(representatives)
                if 1.0 - float(np.dot(descriptor, representative)) <= 0.5
            ),
            None,
        )
        if label is None:
            label = len(representatives)
            representatives.append(descriptor)
        labels.append(label)
    return labels


class FunctionalRecognitionAdapter:
    """Thin adapter over the 2024-style database and standalone functions."""

    def __init__(self, model: Any) -> None:
        self.model = model
        self.database = FaceDatabase()

    def enroll(self, person_id: str, images: Sequence[np.ndarray]) -> None:
        """Delegate enrollment to the standalone application function."""

        enroll_images(self.database, self.model, person_id, images)

    def recognize(self, images: Sequence[np.ndarray]) -> Sequence[Optional[str]]:
        """Delegate recognition to the standalone application function."""

        return identify_images(self.database, self.model, images)


class FunctionalClusteringAdapter:
    """Thin adapter over the standalone clustering function."""

    def __init__(self, model: Any) -> None:
        self.model = model

    def cluster(self, images: Sequence[np.ndarray], *, seed: int) -> Sequence[int]:
        """Return the application's cluster labels; literal values are arbitrary."""

        del seed
        return cluster_images(self.model, images)


def recognition_case() -> RecognitionScenario:
    """Build a known/unknown/enrollment lifecycle shared by both designs."""

    red = image(255, 0, 0)
    green = image(0, 255, 0)
    blue = image(0, 0, 255)
    return RecognitionScenario(
        known=[
            RecognitionIdentity("red", [red], [red]),
            RecognitionIdentity("green", [green], [green]),
        ],
        unknown_person_id="blue",
        unknown_queries=[blue],
        unknown_enrollment=[blue],
        post_enrollment_queries=[blue],
    )


def clustering_case() -> ClusteringScenario:
    """Build a two-person clustering case with label-invariant truth."""

    red = image(255, 0, 0)
    green = image(0, 255, 0)
    return ClusteringScenario([red, red, green, green], ["r", "r", "g", "g"], seed=7)


def test_reference_designs_receive_identical_recognition_scores() -> None:
    """Score Reynaldo's class and the 2024-style functions identically."""

    model = FakeFaceNet()
    case = recognition_case()
    expected = recognition_expected(case)
    reynaldo = run_recognition_scenario(lambda value: FaceRecognitionApp(value), model, case)
    functional = run_recognition_scenario(FunctionalRecognitionAdapter, model, case)
    assert score_recognition([reynaldo], [expected]) == score_recognition(
        [functional], [expected]
    )
    assert score_recognition([reynaldo], [expected])["recognition_score"] == 1.0


def test_reference_designs_receive_identical_clustering_scores() -> None:
    """Score class-based Whispers and standalone clustering identically."""

    model = FakeFaceNet()
    case = clustering_case()
    reynaldo = run_clustering_scenario(lambda value: FaceRecognitionApp(value), model, case)
    functional = run_clustering_scenario(FunctionalClusteringAdapter, model, case)
    assert score_clustering([reynaldo], [case.expected_labels]) == score_clustering(
        [functional], [case.expected_labels]
    )
    assert score_clustering([reynaldo], [case.expected_labels])[
        "clustering_pairwise_f1"
    ] == 1.0
