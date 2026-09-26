from __future__ import annotations

import os

import pytest

from facial_recognition_benchmark.plugins import ClusteringBenchmark, RecognitionBenchmark

pytestmark = pytest.mark.skipif(
    os.environ.get("COGWORKS_REAL_DATA") != "1",
    reason="explicit real-data integration lane only",
)


class AlwaysUnknown:
    def __init__(self, model):
        pass

    def enroll(self, person_id, images):
        pass

    def recognize(self, images):
        return [None] * len(images)


class SingletonClusters:
    def __init__(self, model):
        pass

    def cluster(self, images, *, seed):
        return list(range(len(images)))


def test_real_facenet_and_public_test_data():
    from facenet_models import FacenetModel

    model = FacenetModel(device="cpu")

    recognition = RecognitionBenchmark()
    recognition_cases = recognition.load_cases("test")
    recognition_score = recognition.score(
        recognition.run(AlwaysUnknown, model, recognition_cases), recognition_cases
    )
    assert recognition_score["recognition_score"] == 0.25

    clustering = ClusteringBenchmark()
    clustering_cases = clustering.load_cases("test")
    clustering_score = clustering.score(
        clustering.run(SingletonClusters, model, clustering_cases), clustering_cases
    )
    assert clustering_score["clustering_pairwise_f1"] == 0.0


def test_reynaldo_reference_runs_both_public_tracks():
    """Exercise the complete golden application against real public data."""

    from face_recognition import FaceRecognitionApp
    from facenet_models import FacenetModel

    model = FacenetModel(device="cpu")

    def factory(received):
        return FaceRecognitionApp(received)

    recognition = RecognitionBenchmark()
    recognition_cases = recognition.load_cases("test")
    recognition_outputs = recognition.run(factory, model, recognition_cases)
    recognition_score = recognition.score(recognition_outputs, recognition_cases)
    assert recognition_score["recognition_score"] >= 0.8

    clustering = ClusteringBenchmark()
    clustering_cases = clustering.load_cases("test")
    clustering_outputs = clustering.run(factory, model, clustering_cases)
    clustering_score = clustering.score(clustering_outputs, clustering_cases)
    assert clustering_score["clustering_pairwise_f1"] >= 0.8
