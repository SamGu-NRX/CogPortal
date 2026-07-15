"""Reference adapter for exercising CogBench with the Week 2 environment.

This deliberately small implementation recognizes the synthetic public cases.
Student repositories should keep the adapter interface but replace
``predict_one`` with their course model and preprocessing pipeline.
"""

from __future__ import annotations

import math
from typing import Any, List, Mapping, Sequence, Tuple


class Week2VisionSubmission:
    """Classify embeddings by cosine similarity with unknown rejection."""

    unknown_threshold = 0.75

    def predict(self, inputs: Sequence[Mapping[str, Any]]) -> List[str]:
        """Return one JSON-serializable label for every benchmark input."""

        return [self.predict_one(item) for item in inputs]

    def predict_one(self, item: Mapping[str, Any]) -> str:
        embedding = self._vector(item.get("embedding"), "embedding")
        references = item.get("references")
        if not isinstance(references, Mapping) or not references:
            raise ValueError("references must be a non-empty mapping of labels to vectors")

        best_label = "unknown"
        best_score = float("-inf")
        for label in sorted(references):
            if not isinstance(label, str) or not label:
                raise ValueError("reference labels must be non-empty strings")
            reference = self._vector(references[label], "reference {!r}".format(label))
            score = self._cosine_similarity(embedding, reference)
            if score > best_score:
                best_label = label
                best_score = score

        return best_label if best_score >= self.unknown_threshold else "unknown"

    @staticmethod
    def _vector(value: Any, field: str) -> Tuple[float, ...]:
        if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or not value:
            raise ValueError("{} must be a non-empty numeric sequence".format(field))
        try:
            vector = tuple(float(component) for component in value)
        except (TypeError, ValueError) as error:
            raise ValueError("{} must contain only numbers".format(field)) from error
        if not all(math.isfinite(component) for component in vector):
            raise ValueError("{} must contain only finite numbers".format(field))
        return vector

    @staticmethod
    def _cosine_similarity(left: Tuple[float, ...], right: Tuple[float, ...]) -> float:
        if len(left) != len(right):
            raise ValueError("embedding and reference vectors must have the same length")
        left_norm = math.sqrt(sum(component * component for component in left))
        right_norm = math.sqrt(sum(component * component for component in right))
        if left_norm == 0.0 or right_norm == 0.0:
            raise ValueError("embedding and reference vectors must be non-zero")
        return sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)


__all__ = ["Week2VisionSubmission"]
