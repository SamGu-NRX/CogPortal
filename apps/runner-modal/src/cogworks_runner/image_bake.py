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

#: Week 2 reads its photographs through `platformdirs`, which answers with a
#: path under the calling user's home unless XDG_CACHE_HOME says otherwise.
#: The image sets that variable to this directory so the builder writing the
#: cache and the sandbox reading it name the same place, the way TORCH_HOME
#: already does for the FaceNet checkpoint.
WEEK2_CACHE_DIR = "/opt/cogworks-cache"


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


def cache_week2_celeba() -> None:
    """Bake both public CelebA tiers so the sandbox can build its fixture.

    Week 2 is the only week whose discovery reads real photographs, and it
    reads them where student code runs, which has no network. Run 88C3 and
    run 8E60 both stopped at contract check asking the Hub for
    `flwrlabs/celeba`. Both tiers are baked because `cogworks test` scores the
    small one and a hosted practice run scores `evaluation`.
    """

    os.environ["XDG_CACHE_HOME"] = WEEK2_CACHE_DIR
    from facial_recognition_benchmark.datasets import (
        cache_status,
        load_manifest,
        materialize_manifest,
    )

    for tier in ("test", "evaluation"):
        manifest = load_manifest(tier)
        materialize_manifest(manifest)
        # Reading the cache back through the benchmark's own validator is the
        # point: it re-checksums every image, so a truncated download fails
        # the build instead of the student's run.
        status = cache_status(manifest)
        if not status.ready:
            raise RuntimeError(
                "Week 2 {} cache is unusable after baking: {}".format(
                    tier, status.message
                )
            )


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
