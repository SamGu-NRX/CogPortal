"""Reference semantic-search pipeline for harness validation.

The text side is the course method exactly: lowercase, strip punctuation,
keep stop words, IDF(t) = log10(N/n_t) over all captions, caption vector =
IDF-weighted sum of 200-d GloVe vectors, unit-normalized. The image side is
a single 512x200 linear map. It is trained by ridge regression onto mean
caption embeddings (see train_reference.py) rather than the course's margin
loss: this exists to validate the harness with a strong linear map that
trains in seconds, not to model the pedagogy.
"""

from __future__ import annotations

import re
import string
from collections import Counter
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

import numpy as np

_PUNC = re.compile("[{}]".format(re.escape(string.punctuation)))


def tokenize(caption: str) -> List[str]:
    return _PUNC.sub("", caption.lower()).split()


def build_idf(captions: Iterable[str]) -> Dict[str, float]:
    document_counts: Counter = Counter()
    total = 0
    for caption in captions:
        total += 1
        document_counts.update(set(tokenize(caption)))
    return {
        word: float(np.log10(total / count)) for word, count in document_counts.items()
    }


class TextEmbedder:
    def __init__(self, glove, idf: Dict[str, float], dim: int = 200) -> None:
        self.glove = glove
        self.idf = idf
        self.dim = dim

    def embed_one(self, caption: str) -> np.ndarray:
        total = np.zeros(self.dim)
        for word in tokenize(caption):
            if word in self.idf and word in self.glove:
                total += self.idf[word] * self.glove[word]
        norm = np.linalg.norm(total)
        return total / norm if norm else total

    def embed(self, captions: Sequence[str]) -> np.ndarray:
        return np.stack([self.embed_one(caption) for caption in captions])


class ReferenceApp:
    """The full application: text embedder, image encoder, database, search."""

    def __init__(self, embedder: TextEmbedder, weights: np.ndarray) -> None:
        self.embedder = embedder
        self.weights = weights
        self._db_ids: List[int] = []
        self._db_vectors = np.zeros((0, weights.shape[1]))

    @classmethod
    def load(cls, weights_path: Path, resources) -> "ReferenceApp":
        bundle = np.load(str(weights_path), allow_pickle=False)
        idf = {
            str(word): float(value)
            for word, value in zip(bundle["idf_words"], bundle["idf_values"])
        }
        glove = resources.load_glove()
        return cls(TextEmbedder(glove, idf), bundle["weights"].astype(np.float64))

    def embed_text(self, captions: Sequence[str]) -> np.ndarray:
        return self.embedder.embed(captions)

    def embed_images(self, descriptors: np.ndarray) -> np.ndarray:
        projected = np.asarray(descriptors, dtype=np.float64) @ self.weights
        norms = np.linalg.norm(projected, axis=1, keepdims=True)
        return projected / np.where(norms == 0.0, 1.0, norms)

    def prepare_database(
        self, image_ids: Sequence[int], descriptors: np.ndarray
    ) -> None:
        self._db_ids = list(image_ids)
        self._db_vectors = self.embed_images(descriptors)

    def search(self, query: str, k: int) -> List[int]:
        vector = self.embedder.embed_one(query)
        scores = self._db_vectors @ vector
        order = np.argsort(-scores)[:k]
        return [self._db_ids[index] for index in order]
