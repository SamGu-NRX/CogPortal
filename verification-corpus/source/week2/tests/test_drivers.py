from __future__ import annotations

import numpy as np
import pytest

from facial_recognition_benchmark.adapters import AdapterContractError
from facial_recognition_benchmark.drivers import (
    ClusteringScenario,
    RecognitionIdentity,
    RecognitionScenario,
    recognition_expected,
    run_clustering_scenario,
    run_recognition_scenario,
)


def image(value):
    return np.full((2, 2, 3), value, dtype=np.uint8)


class ClassBasedRecognition:
    def __init__(self, model):
        self.database = {}

    def enroll(self, person_id, images):
        self.database[person_id] = {int(item[0, 0, 0]) for item in images}

    def recognize(self, images):
        output = []
        for item in images:
            value = int(item[0, 0, 0])
            output.append(
                next((name for name, values in self.database.items() if value in values), None)
            )
        return output


def function_based_factory(model):
    database = {}

    class ThinAdapter:
        def enroll(self, person_id, images):
            database[person_id] = {int(item[0, 0, 0]) for item in images}

        def recognize(self, images):
            return [
                next(
                    (name for name, values in database.items() if int(item[0, 0, 0]) in values),
                    None,
                )
                for item in images
            ]

    return ThinAdapter()


def recognition_scenario():
    return RecognitionScenario(
        known=[RecognitionIdentity("known", [image(1)], [image(1)])],
        unknown_person_id="new",
        unknown_queries=[image(2)],
        unknown_enrollment=[image(2)],
        post_enrollment_queries=[image(2)],
    )


def test_different_application_architectures_have_identical_behavior():
    scenario = recognition_scenario()
    class_result = run_recognition_scenario(ClassBasedRecognition, object(), scenario)
    function_result = run_recognition_scenario(function_based_factory, object(), scenario)
    assert class_result == function_result == recognition_expected(scenario)


def test_recognition_lifecycle_retains_one_adapter():
    assert run_recognition_scenario(ClassBasedRecognition, object(), recognition_scenario())[
        "post_enrollment"
    ] == ["new"]


def test_wrong_recognition_length_fails_contract():
    class Broken:
        def enroll(self, person_id, images):
            pass

        def recognize(self, images):
            return []

    with pytest.raises(AdapterContractError, match="returned 0 labels"):
        run_recognition_scenario(lambda model: Broken(), object(), recognition_scenario())


def test_clustering_validates_length_and_label_type():
    scenario = ClusteringScenario([image(1), image(2)], [0, 1], seed=1)

    class Broken:
        def cluster(self, images, *, seed):
            return [object()]

    with pytest.raises(AdapterContractError, match="returned 1 labels"):
        run_clustering_scenario(lambda model: Broken(), object(), scenario)
