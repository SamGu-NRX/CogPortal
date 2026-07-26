"""Train the reference image encoder and save weights.npz.

Ridge regression from ResNet-18 descriptors onto mean caption embeddings:
with X (n, 512) and Y (n, 200), W = (X'X + lambda I)^-1 X'Y. A 512x512
solve, so the whole run is minutes even on a laptop, dominated by the
one-time GloVe parse. Training images reproduce the manifest builder's
master shuffle and skip its first three blocks (public test, public
evaluation, official candidates), so no evaluation image is ever trained on.

Run inside an environment with the benchmark installed:

    python train_reference.py
"""

from __future__ import annotations

import random
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from language_search_benchmark.datasets import build_resources
from reference_search import TextEmbedder, build_idf

# Mirrors tools/build_public_manifests.py in the benchmark repo; a change
# there must be reflected here or training may touch evaluation images.
MASTER_SEED = 20260301
BLOCK_SIZE = 2000
RESERVED_BLOCKS = 3

TRAIN_IMAGES = 8000
RIDGE_LAMBDA = 1.0
OUT = Path(__file__).resolve().parent / "weights.npz"


def main() -> None:
    started = time.time()
    resources = build_resources(download=True, build_kv=True)
    captions_blob = resources.load_captions()
    descriptors = resources.load_descriptors()

    captions_of = defaultdict(list)
    for annotation in captions_blob["annotations"]:
        captions_of[int(annotation["image_id"])].append(str(annotation["caption"]))

    print("building idf over {} captions...".format(len(captions_blob["annotations"])))
    idf = build_idf(
        str(annotation["caption"]) for annotation in captions_blob["annotations"]
    )

    eligible = sorted(
        image_id
        for image_id, texts in captions_of.items()
        if image_id in descriptors and len(texts) >= 2
    )
    shuffled = list(eligible)
    random.Random(MASTER_SEED).shuffle(shuffled)
    train_ids = shuffled[RESERVED_BLOCKS * BLOCK_SIZE :][:TRAIN_IMAGES]
    print(
        "training on {} images (first {} blocks reserved).".format(
            len(train_ids), RESERVED_BLOCKS
        )
    )

    print("loading glove...")
    embedder = TextEmbedder(resources.load_glove(), idf)

    features = np.zeros((len(train_ids), 512))
    targets = np.zeros((len(train_ids), 200))
    for row, image_id in enumerate(train_ids):
        features[row] = np.asarray(descriptors[image_id]).reshape(-1)
        vectors = embedder.embed(captions_of[image_id][:5])
        mean = vectors.mean(axis=0)
        norm = np.linalg.norm(mean)
        targets[row] = mean / norm if norm else mean
        if row and row % 2000 == 0:
            print("  embedded {}/{}".format(row, len(train_ids)))

    gram = features.T @ features + RIDGE_LAMBDA * np.eye(512)
    weights = np.linalg.solve(gram, features.T @ targets)

    words = sorted(idf)
    np.savez_compressed(
        str(OUT),
        weights=weights.astype(np.float32),
        idf_words=np.asarray(words),
        idf_values=np.asarray([idf[word] for word in words], dtype=np.float32),
    )
    print(
        "wrote {} ({} KiB) in {:.0f}s".format(
            OUT, OUT.stat().st_size // 1024, time.time() - started
        )
    )


if __name__ == "__main__":
    main()
