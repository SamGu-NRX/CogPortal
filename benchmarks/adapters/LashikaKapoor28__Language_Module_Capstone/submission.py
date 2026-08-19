"""Instructor-supplied adapter for LashikaKapoor28/Language_Module_Capstone.

The team wrote a complete semantic image search: IDF-weighted GloVe caption
embeddings, a 512->200 linear encoder trained with a margin ranking loss, and
a cosine-similarity image database. They never wrote a benchmark adapter,
because the benchmark did not exist when they submitted. This file is the
missing wiring and nothing else.

Every number the benchmark reports comes out of their tokenizer, their IDF
weighting, their caption embedder, their trained encoder matrix, and their
database's own similarity ranking. We supply no embedding, no normalization,
and no ranking of our own.

Three things needed a decision, all recorded in ``PROVENANCE``:

Their ``database.py`` imports ``streamlit`` at module scope, only to show
images in their demo. The evaluation sandbox has no streamlit and no network,
so importing that module fails on a line that has nothing to do with search.
Rather than edit their file or vendor a copy of the class, the adapter installs
a stub module under the name ``streamlit`` before the import and removes it
after. Their ``display_images`` is never called.

Their encoder is ``data/W_embed.npy``, saved by their own ``train.py:115``
from ``model.parameters[0].data``. It is a genuine trained 512x200 float32
matrix, so the adapter loads it rather than re-training. If it were missing
the adapter would refuse rather than fall back to random weights, which would
produce a plausible-looking chance score.

Their IDF table is computed at run time from the captions the benchmark
supplies, using their ``compute_idfs``, because that is what their
``train.py:33`` does. Nothing is carried over from their training run.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any, Dict, List, Sequence

import numpy as np

#: What this adapter added, and what it did not. The driver copies this into
#: the run result so a leaderboard row can say which parts of the score belong
#: to the team. Nothing in ``we_supplied`` is embedding, ranking, or training.
PROVENANCE = {
    "source": "instructor-supplied",
    "student_wrote": [
        "embedder.tokenize and embedder.strip_punc: lowercase, strip "
        "punctuation, split on whitespace",
        "embedder.compute_idfs: log10(N / document_frequency) per token",
        "embedder.embed_captions_batch: IDF-weighted sum of GloVe vectors per "
        "caption, L2-normalized, with a per-word cache",
        "data/W_embed.npy: the trained 512x200 encoder, saved by their "
        "train.py:115 from model.parameters[0].data",
        "database.ImageDatabase.descriptor_to_embedding: descriptor @ W_embed "
        "then L2 normalize with a 1e-8 floor",
        "database.ImageDatabase.query: cosine similarity against every "
        "embedded image, argpartition for the top k, sorted descending",
    ],
    "we_supplied": [
        "the embed_text / embed_images / prepare_database / search method "
        "names and their signatures",
        "a stub streamlit module during the import of their database.py, "
        "which imports streamlit at module scope for its demo image display; "
        "their display_images is never called",
        "calling compute_idfs on the captions the benchmark supplies, which "
        "is what their train.py:33 does",
        "loading their committed W_embed.npy rather than re-training",
        "locating the repository on sys.path",
    ],
    "not_used": [
        "main.py, their Streamlit application",
        "train.py, their training loop (the committed weights are used as-is)",
        "coco.py, their COCO loader (the benchmark supplies the data)",
        "triplet_utils.py, their triplet sampler",
    ],
}


def _import_student_modules(repo_root: Path):
    """Import their modules, with streamlit stubbed for the duration.

    ``database.py`` does ``import streamlit as st`` at module scope and uses
    it in exactly one method we never call. The sandbox has no streamlit, so
    without this the import raises ModuleNotFoundError and the team scores
    zero for a reason unrelated to search quality.

    The stub is removed afterwards so nothing else in the process sees a fake
    streamlit, and a real installed streamlit is left alone.
    """

    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    installed = False
    if "streamlit" not in sys.modules:
        try:
            import streamlit  # noqa: F401
        except ImportError:
            stub = types.ModuleType("streamlit")

            def _unavailable(*args: Any, **kwargs: Any) -> None:
                raise RuntimeError(
                    "This adapter stubs streamlit for import only; the "
                    "benchmark never displays images."
                )

            stub.image = _unavailable
            sys.modules["streamlit"] = stub
            installed = True

    try:
        import database as student_database
        import embedder as student_embedder
    finally:
        if installed:
            sys.modules.pop("streamlit", None)

    return student_embedder, student_database


class LashikaSearchAdapter:
    """Their pipeline, behind the four names the contract asks for."""

    def __init__(self, resources: Any) -> None:
        self.resources = resources
        repo_root = Path(__file__).resolve().parent
        self.embedder, self.database_module = _import_student_modules(repo_root)

        weights_path = repo_root / "data" / "W_embed.npy"
        if not weights_path.is_file():
            raise RuntimeError(
                "This submission is scored from its committed encoder at "
                "data/W_embed.npy, written by its own train.py. That file is "
                "missing, and substituting random weights would report a "
                "chance score as if it were a trained one."
            )
        self.encoder = np.load(str(weights_path))
        if self.encoder.shape != (512, 200):
            raise RuntimeError(
                "data/W_embed.npy is {}, not the (512, 200) encoder the "
                "course's architecture produces.".format(self.encoder.shape)
            )

        self.glove = resources.load_glove()
        # Their embed_captions_batch takes an idf table. train.py:33 builds it
        # from the caption corpus, so the adapter does the same with whatever
        # captions the benchmark pinned.
        captions = resources.load_captions()
        corpus = [row["caption"] for row in captions.get("annotations", [])]
        self.idfs = self.embedder.compute_idfs(corpus)

        self._database = None
        self._image_ids: List[Any] = []

    # -- contract ---------------------------------------------------------

    def embed_text(self, captions: Sequence[str]) -> np.ndarray:
        """Their batch caption embedder, unchanged."""

        return np.asarray(
            self.embedder.embed_captions_batch(list(captions), self.glove, self.idfs),
            dtype=np.float32,
        )

    def embed_images(self, descriptors: np.ndarray) -> np.ndarray:
        """Their encoder, through their own database method.

        Calling ``descriptor_to_embedding`` on a throwaway instance rather
        than reimplementing ``descriptors @ W_embed`` keeps the normalization
        (including their 1e-8 floor) theirs.
        """

        matrix = np.asarray(descriptors, dtype=np.float32)
        if matrix.ndim == 3 and matrix.shape[1] == 1:
            # The course's descriptor dict stores (1, 512) per image.
            matrix = matrix[:, 0, :]
        holder = self.database_module.ImageDatabase([], np.zeros((0, 512), np.float32), self.encoder)
        return np.asarray(holder.descriptor_to_embedding(matrix), dtype=np.float32)

    def prepare_database(self, image_ids: Sequence[Any], descriptors: np.ndarray) -> None:
        """Build their ImageDatabase over the pinned pool."""

        matrix = np.asarray(descriptors, dtype=np.float32)
        if matrix.ndim == 3 and matrix.shape[1] == 1:
            matrix = matrix[:, 0, :]
        self._image_ids = list(image_ids)
        self._database = self.database_module.ImageDatabase(
            self._image_ids, matrix, self.encoder
        )

    def search(self, query: str, k: int) -> List[Any]:
        """Their query, with their own ranking."""

        if self._database is None:
            raise RuntimeError("search called before prepare_database.")
        embedding = self.embedder.embed_text(query, self.glove, self.idfs)
        return list(self._database.query(embedding, k=k))


def create_search_adapter(resources: Any) -> LashikaSearchAdapter:
    return LashikaSearchAdapter(resources)


def create_submission(resources: Any) -> LashikaSearchAdapter:
    return LashikaSearchAdapter(resources)
