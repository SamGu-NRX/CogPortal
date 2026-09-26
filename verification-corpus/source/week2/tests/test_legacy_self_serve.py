"""Regression tests for the legacy self-serve benchmark (run_benchmark path).

Each test pins one of the fixed student-facing bugs: the detection ground
truth being swallowed by a dead positional parameter, the descriptor score
exceeding 1, the threshold sweep crashing on empty inputs and computing
specificity where precision belongs, the recognition confusion counters
misfiling wrong-name and Unknown/Unknown cases, and the package docstring
advertising a call signature that does not exist.

The hosted scoring path (plugins.py / drivers.py / metrics.py) never imports
any of these modules, so nothing here touches scored metrics.
"""

from __future__ import annotations

import inspect

import numpy as np
import pytest

import facial_recognition_benchmark
from facial_recognition_benchmark import benchmark as benchmark_module
from facial_recognition_benchmark import detection as detection_module
from facial_recognition_benchmark import recognition as recognition_module
from facial_recognition_benchmark.benchmark import calculate_overall_score, run_benchmark
from facial_recognition_benchmark.distance import benchmark_cosine_distance_threshold
from facial_recognition_benchmark.recognition import benchmark_face_recognition


def one_hot(index: int, dim: int = 8) -> np.ndarray:
    vector = np.zeros(dim, dtype=float)
    vector[index] = 1.0
    return vector


class IndexedFakeModel:
    """Detect one face per image; the descriptor is a one-hot vector whose
    index is stored in the image's first pixel, so a test controls exactly
    which database profile each image matches."""

    def detect(self, image: np.ndarray):
        height, width = image.shape[:2]
        boxes = np.asarray([[0.0, 0.0, float(width), float(height)]])
        probabilities = np.asarray([1.0])
        landmarks = np.zeros((1, 5, 2), dtype=float)
        return boxes, probabilities, landmarks

    def compute_descriptors(self, image: np.ndarray, boxes: np.ndarray) -> np.ndarray:
        index = int(image[0, 0, 0])
        return np.repeat(one_hot(index)[None, :], len(boxes), axis=0)


def fake_image_loader(path: str) -> np.ndarray:
    """Map 'img<i>.png' to an array whose first pixel carries index i."""
    index = int(str(path).split("img")[1].split(".")[0])
    return np.full((4, 4, 3), index, dtype=np.uint8)


@pytest.fixture
def patched_loaders(monkeypatch):
    """Each module froze load_image at import via 'from utils import
    load_image', so the fake loader is patched per module, not on utils."""
    for module in (detection_module, recognition_module):
        monkeypatch.setattr(module, "load_image", fake_image_loader)
    from facial_recognition_benchmark import descriptors as descriptors_module

    monkeypatch.setattr(descriptors_module, "load_image", fake_image_loader)


def test_run_benchmark_reports_detection_accuracy(patched_loaders):
    """run_benchmark used to pass ground_truth_num_faces into the dead
    ground_truth_boxes slot, so accuracy stayed None despite ground truth."""
    paths = ["img0.png", "img1.png"]
    result = run_benchmark(
        IndexedFakeModel(),
        test_config={
            "face_images": paths,
            "ground_truth_num_faces": {p: 1 for p in paths},
        },
    )
    assert result.detection_results["detection_accuracy"] == 1.0


def test_benchmark_detection_keyword_yields_accuracy(patched_loaders):
    results = detection_module.benchmark_detection(
        IndexedFakeModel(),
        ["img0.png"],
        ground_truth_num_faces={"img0.png": 1},
    )
    assert results["detection_accuracy"] == 1.0


def test_benchmark_detection_dropped_dead_parameter():
    assert "ground_truth_boxes" not in inspect.signature(
        detection_module.benchmark_detection
    ).parameters


def test_descriptor_score_clamps_at_one():
    """A sub-50ms generation time made desc_score exceed 1 and the overall
    score print above 100%."""
    results = {
        "detection_results": {},
        "descriptor_results": {"avg_generation_time": 0.001},
        "distance_results": {},
        "database_results": {},
        "recognition_results": {},
        "whispers_results": {},
    }
    assert calculate_overall_score(results) == 1.0


def test_threshold_benchmark_handles_empty_inputs():
    """Empty inputs used to leave the counters unbound and raise
    UnboundLocalError at the precision read."""
    results = benchmark_cosine_distance_threshold([], [])
    assert results["f1_scores"] == [0.0] * len(results["thresholds"])
    assert results["optimal_f1_score"] == 0.0


def test_threshold_benchmark_uses_real_precision():
    """Old code used 1 - fpr (specificity) as precision. With 1 same-person
    pair matched and 2 of 10 different-person pairs matched at 0.5,
    specificity is 0.8 (old F1 0.888...) but precision is 1/3 (F1 0.5)."""
    results = benchmark_cosine_distance_threshold(
        same_person_distances=[0.1],
        different_person_distances=[0.2, 0.3] + [0.9] * 8,
        thresholds=[0.5],
    )
    assert results["f1_scores"][0] == pytest.approx(0.5)


def test_recognition_confusion_counters(patched_loaders):
    """Five cases, one per counter. Naming the wrong known person used to
    land in true_negatives, and Unknown/Unknown in true_positives."""
    database = {
        "Alice": {"name": "Alice", "descriptors": [one_hot(0)], "average_descriptor": one_hot(0)},
        "Bob": {"name": "Bob", "descriptors": [one_hot(1)], "average_descriptor": one_hot(1)},
    }
    # img0 -> Alice's descriptor, img1 -> Bob's, img2 -> matches nobody.
    test_images = ["img0.png", "img0.png", "img2.png", "img1.png", "img2.png"]
    truths = ["Alice", "Bob", "Alice", "Unknown", "Unknown"]
    results = benchmark_face_recognition(
        IndexedFakeModel(), database, test_images, truths, threshold=0.5
    )
    assert results["true_positives"] == 1  # pred Alice, truth Alice
    assert results["misidentifications"] == 1  # pred Alice, truth Bob
    assert results["false_negatives"] == 1  # pred Unknown, truth Alice
    assert results["false_positives"] == 1  # pred Bob, truth Unknown
    assert results["true_negatives"] == 1  # pred Unknown, truth Unknown


def test_recognition_accuracy_stays_exact_match(patched_loaders):
    """recognition_accuracy is exact-match accuracy over all cases, the same
    value the pre-fix code produced (it counted Unknown/Unknown in TP)."""
    database = {
        "Alice": {"name": "Alice", "descriptors": [one_hot(0)], "average_descriptor": one_hot(0)},
    }
    test_images = ["img0.png", "img2.png"]
    truths = ["Alice", "Unknown"]
    results = benchmark_face_recognition(
        IndexedFakeModel(), database, test_images, truths, threshold=0.5
    )
    assert results["recognition_accuracy"] == 1.0


def test_package_docstring_matches_run_benchmark_signature():
    """The docstring advertised run_benchmark(model, database, whispers_func);
    the real third parameter is a test_config dict."""
    signature = inspect.signature(benchmark_module.run_benchmark)
    assert list(signature.parameters) == ["model", "database", "test_config"]
    # The advertised keyword call pattern must bind.
    signature.bind(object(), database={}, test_config={})
    doc = facial_recognition_benchmark.__doc__
    assert "whispers_func" not in doc
    assert "test_config" in doc
