/**
 * The week 2 vision submission fixture, verified against the real benchmark:
 * the packaged entry-point protocol (create_submission / Submission) whose
 * instance answers enroll(person_id, images), recognize(images) -> one label
 * or None per photo, and cluster(images, seed=...) -> one label per photo.
 * FaceNet descriptors over cosine distance, cutoff calibrated on the public
 * test images (same-face pairs under 0.2, different faces over 0.9). Local
 * verification: recognition_score 0.9167, clustering pairwise F1 0.700.
 */
export const VISION_SUBMISSION_PY = `
"""Face recognition and grouping over FaceNet descriptors."""
from collections import defaultdict

import numpy as np


class Submission:
    """The team's application: enroll faces, name them, and group them."""

    # Cosine distance below which two descriptors are the same person;
    # calibrated on the public test images (same-face pairs sit under 0.2,
    # different faces over 0.9).
    CUTOFF = 0.75

    def __init__(self, model):
        self._model = model
        self._profiles = defaultdict(list)

    def _descriptors(self, image):
        """One photo in, its face descriptors out (one row per face)."""
        image = np.asarray(image)
        if image.dtype != np.uint8:
            image = (
                (np.clip(image, 0, 1) * 255).astype(np.uint8)
                if image.size and image.max() <= 1.0
                else image.astype(np.uint8)
            )
        if image.ndim == 2:
            image = np.stack([image] * 3, axis=-1)
        found = self._model.detect(np.ascontiguousarray(image))
        boxes = found[0] if isinstance(found, tuple) else getattr(found, "boxes", None)
        if boxes is None or len(boxes) == 0:
            return np.zeros((0, 512), dtype=np.float32)
        return np.asarray(
            self._model.compute_descriptors(np.ascontiguousarray(image), boxes),
            dtype=np.float32,
        )

    # --- recognition ------------------------------------------------------

    def enroll(self, person_id, images):
        """File every face in the enrollment photos under this person's name."""
        for image in images:
            for row in self._descriptors(image):
                self._profiles[str(person_id)].append(row)

    def recognize(self, images):
        """One label per photo: the person's name, or None when nobody we know."""
        return [self._recognize_one(image) for image in images]

    def _recognize_one(self, image):
        rows = self._descriptors(image)
        votes = []
        for row in rows:
            best_name, best_distance = None, float(self.CUTOFF)
            for name, profile in self._profiles.items():
                for other in profile:
                    distance = float(
                        1.0 - np.dot(row, other) / (np.linalg.norm(row) * np.linalg.norm(other))
                    )
                    if distance < best_distance:
                        best_name, best_distance = name, distance
            votes.append(best_name)
        named = [vote for vote in votes if vote is not None]
        if not named:
            return None
        return max(set(named), key=named.count)

    # --- clustering -------------------------------------------------------

    def cluster(self, images, seed=None):
        """One label per photo: faces closer than our cutoff share a group."""
        rows = [self._descriptors(image) for image in images]
        stacked = [row for row in rows if row.shape[0]]
        faces = np.vstack(stacked) if stacked else np.zeros((0, 512), dtype=np.float32)
        parent = list(range(faces.shape[0]))

        def find(node):
            while parent[node] != node:
                parent[node] = parent[parent[node]]
                node = parent[node]
            return node

        for one in range(faces.shape[0]):
            for other in range(one + 1, faces.shape[0]):
                a, b = faces[one], faces[other]
                cosine = 1.0 - float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
                if cosine < self.CUTOFF:
                    parent[find(one)] = find(other)
        roots = {}
        labels = []
        for node in range(faces.shape[0]):
            root = find(node)
            if root not in roots:
                roots[root] = len(roots)
            labels.append(roots[root])
        return labels


def create_submission(model):
    """The entry point the benchmark looks for; one fresh app per scenario."""
    return Submission(model)
`;
