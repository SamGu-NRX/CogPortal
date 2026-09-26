from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from facial_recognition_benchmark.adapters import (
    AdapterContractError,
    adapt_clustering,
    adapt_recognition,
    instantiate,
)


class NativeRecognition:
    def enroll(self, person_id, images):
        pass

    def recognize(self, images):
        return [None] * len(images)


class ReynaldoSurface:
    def detect(self, *args):
        pass

    def compute_descriptors(self, *args):
        pass

    def process_image(self, *args):
        pass

    def recognize_face(self, *args):
        pass

    def add_image_to_database(self, *args):
        pass

    def add_descriptors_to_database(self, *args):
        pass

    def cluster_images(self, *args):
        pass

    def save_database(self, *args):
        pass

    def load_database(self, *args):
        pass

    def get_database_dict(self, *args):
        pass


def test_native_adapter_is_used_without_guessing():
    adapter = NativeRecognition()
    assert adapt_recognition(adapter) is adapter


def test_factory_receives_benchmark_model():
    model = object()
    assert instantiate(lambda received: received, model) is model


def test_factory_signature_error_is_actionable():
    with pytest.raises(AdapterContractError, match="must accept"):
        instantiate(lambda: object(), object())


def test_entry_point_must_be_a_factory_so_scenarios_receive_fresh_state():
    with pytest.raises(AdapterContractError, match="callable factory"):
        instantiate(NativeRecognition(), object())


def test_factory_internal_type_error_is_not_mislabeled():
    def broken(model):
        raise TypeError("student bug")

    with pytest.raises(TypeError, match="student bug"):
        instantiate(broken, object())


def test_unsupported_shape_reports_available_methods():
    class DifferentDesign:
        def lookup(self):
            pass

    with pytest.raises(AdapterContractError, match=r"lookup.*benchmark_adapter.py"):
        adapt_recognition(DifferentDesign())


def test_reynaldo_recognition_surface_translates_arrays_and_results():
    class ReynaldoApp(ReynaldoSurface):
        def __init__(self):
            self.enrolled = []

        def add_image_to_database(self, path, name):
            assert Path(path).is_file()
            self.enrolled.append(name)
            return True

        def process_image(self, path):
            pixel = np.asarray(Image.open(path))[0, 0, 0]
            return {"faces": [{"name": "person" if pixel else "Unknown"}]}

    adapter = adapt_recognition(ReynaldoApp())
    adapter.enroll("person", [np.ones((2, 2, 3), dtype=np.uint8)])
    assert adapter.recognize(
        [np.zeros((2, 2, 3), dtype=np.uint8), np.ones((2, 2, 3), dtype=np.uint8)]
    ) == [None, "person"]


def test_reynaldo_clustering_surface_receives_seeded_randomness():
    class ReynaldoApp(ReynaldoSurface):
        def cluster_images(self, images):
            return {"labels": [int(np.random.randint(1000)) for _ in images]}

    adapter = adapt_clustering(ReynaldoApp())
    images = [np.zeros((1, 1, 3), dtype=np.uint8)] * 2
    assert adapter.cluster(images, seed=4) == adapter.cluster(images, seed=4)
