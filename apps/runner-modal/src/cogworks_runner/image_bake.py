"""Image build-time cache functions.

These run inside Modal's image builder via ``Image.run_function``, which
imports the function's module in the builder container. They live apart
from modal_app so the builder never has to import fastapi or the rest of
the controller surface.
"""

from __future__ import annotations

import hashlib
import os
import urllib.request
from pathlib import Path

CHECKPOINT_URL = (
    "https://github.com/timesler/facenet-pytorch/releases/download/"
    "v2.2.9/20180402-114759-vggface2.pt"
)
CHECKPOINT_SHA256 = "281cebca8662831adb987a874bdcb36e73f5b1c6dc5ee5878f305e985625d99b"

WEEK3_DATA_DIR = "/opt/cogworks-data/week3"


def cache_facenet_checkpoint() -> None:
    path = Path("/opt/torch/checkpoints/20180402-114759-vggface2.pt")
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(CHECKPOINT_URL, timeout=120) as response:
        payload = response.read()
    if (
        len(payload) != 111_898_327
        or hashlib.sha256(payload).hexdigest() != CHECKPOINT_SHA256
    ):
        raise RuntimeError("FaceNet checkpoint does not match the reviewed lock.")
    path.write_bytes(payload)


def cache_week3_artifacts() -> None:
    """Bake the three verified course artifacts (and the fast GloVe cache)
    into the image so the network-blocked evaluation sandbox has them."""

    os.environ["COGWORKS_LANGUAGE_DATA"] = WEEK3_DATA_DIR
    from language_search_benchmark.datasets import build_resources

    resources = build_resources(download=True, build_kv=True)
    if resources.glove_kv_path is None:
        raise RuntimeError(
            "GloVe .kv cache was not built; gensim is required in the image."
        )
