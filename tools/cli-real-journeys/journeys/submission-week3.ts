/**
 * The week 3 language submission fixture: the full search-adapter protocol.
 * Captions embed as GloVe means (the text branch); image descriptors embed
 * through a ridge-fit linear projection W learned, at adapter construction,
 * from the benchmark's own pinned training pairs — the week's projection
 * exercise. The benchmark only scores components when the adapter exposes
 * the whole protocol (embed_text + embed_images), so a text-only object
 * scores zero on everything; this fixture binds both and reports real
 * retrieval metrics.
 *
 * The entry point is the name the CLI's scanner looks for (one of
 * create_submission / create_language_search_adapter / create_search_adapter /
 * Submission — this fixture answers create_search_adapter(resources), the
 * shape pinned in language_search_benchmark/contracts.py), and the weights
 * load through the documented `resources.load_glove()` — the course's own
 * artifact loader, which prefers the pre-parsed .kv save when present.
 */
export const LANGUAGE_SUBMISSION_PY = `
"""GloVe-mean caption embeddings and a fitted image projection for the
language-search benchmark."""
import numpy as np


def _tokens(caption):
    if isinstance(caption, (list, tuple)):
        return [str(token).lower() for token in caption]
    return str(caption).lower().split()


def embed_caption(table, caption):
    """One caption (or token list) in, one embedding row out.

    The mean of the caption's in-vocabulary word vectors. A caption with no
    known word embeds to a zero row - finite, honest, and scored for what
    it is.
    """
    words = _tokens(caption)
    vectors = []
    for word in words:
        try:
            vectors.append(np.asarray(table[word], dtype=np.float32))
        except KeyError:
            continue
    if not vectors:
        dimension = getattr(table, "vector_size", 0) or 1
        return np.zeros(dimension, dtype=np.float32)
    return np.mean(np.vstack(vectors), axis=0).astype(np.float32)


def _fit_projection(table, resources, max_pairs=20000, ridge=1e-3):
    """A linear map from ResNet-18 descriptors into the GloVe space.

    Fit on the benchmark's own pinned training pairs (captions whose image
    has a stored descriptor): minimize || X W^T - Y ||^2 + lambda ||W||^2,
    with X the descriptor rows and Y the GloVe-mean caption rows. One
    caption per image (the first in the annotations), pairs whose caption
    has no in-vocabulary word skipped, and the pair list subsampled
    deterministically so the fit is reproducible.
    """
    captions = resources.load_captions()
    descriptors = resources.load_descriptors()
    first_caption = {}
    for annotation in captions.get("annotations", []):
        image_id = annotation.get("image_id")
        if image_id in descriptors and image_id not in first_caption:
            first_caption[image_id] = annotation["caption"]
    image_ids = sorted(first_caption)
    if len(image_ids) > max_pairs:
        step = len(image_ids) / float(max_pairs)
        image_ids = [image_ids[int(index * step)] for index in range(max_pairs)]
    rows, targets = [], []
    for image_id in image_ids:
        target = embed_caption(table, first_caption[image_id])
        if not np.any(target):
            continue
        rows.append(np.asarray(descriptors[image_id], dtype=np.float64).reshape(-1))
        targets.append(target.astype(np.float64))
    matrix_x = np.vstack(rows)
    matrix_y = np.vstack(targets)
    gram = matrix_x.T @ matrix_x
    gram += ridge * np.trace(gram) / gram.shape[0] * np.eye(gram.shape[0])
    weights = np.linalg.solve(gram, matrix_x.T @ matrix_y)
    return weights.astype(np.float32)  # (512, D): descriptors @ this lands in GloVe space


class GloveMeanSearchAdapter:
    """The full search contract: caption strings to GloVe-mean rows, ResNet-18
    descriptors into the same space through the fitted projection, and
    cosine search over a prepared image database."""

    def __init__(self, resources):
        self._table = resources.load_glove()
        self._weights = _fit_projection(self._table, resources)
        self._db_ids = []
        self._db_vectors = np.zeros((0, self._weights.shape[1]), dtype=np.float32)

    def embed_text(self, captions):
        return np.vstack([embed_caption(self._table, caption) for caption in captions])

    def embed_images(self, descriptors):
        matrix = np.asarray(descriptors, dtype=np.float32).reshape(len(descriptors), -1)
        return matrix @ self._weights

    def prepare_database(self, image_ids, descriptors):
        self._db_ids = list(image_ids)
        vectors = self.embed_images(descriptors)
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        self._db_vectors = vectors / norms

    def search(self, query, k):
        vector = embed_caption(self._table, query).astype(np.float32)
        norm = float(np.linalg.norm(vector)) or 1.0
        scores = self._db_vectors @ (vector / norm)
        order = np.argsort(-scores)[: int(k)]
        return [self._db_ids[int(index)] for index in order]


def create_search_adapter(resources):
    """The entry point the CLI scans for."""
    return GloveMeanSearchAdapter(resources)
`;
