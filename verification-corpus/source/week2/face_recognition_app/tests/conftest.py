from __future__ import annotations

import numpy as np
import pytest


class FakeFaceNet:
    """Small deterministic stand-in for adapter and application unit tests."""

    def detect(self, image: np.ndarray):
        height, width = image.shape[:2]
        boxes = np.asarray([[0.0, 0.0, float(width), float(height)]])
        probabilities = np.asarray([1.0])
        landmarks = np.zeros((1, 5, 2), dtype=float)
        return boxes, probabilities, landmarks

    def compute_descriptors(self, image: np.ndarray, boxes: np.ndarray) -> np.ndarray:
        value = float(np.asarray(image, dtype=float).mean()) / 255.0
        descriptor = np.zeros(512, dtype=float)
        descriptor[0] = value
        descriptor[1] = 1.0 - value
        descriptor /= np.linalg.norm(descriptor)
        return np.repeat(descriptor[None, :], len(boxes), axis=0)


@pytest.fixture
def fake_model() -> FakeFaceNet:
    return FakeFaceNet()
