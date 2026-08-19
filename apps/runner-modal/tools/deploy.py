"""Deploy the CogWorks runner.

Use this instead of a bare `modal deploy`. `_prepare` creates its evaluation
sandbox from inside a Modal container, and Modal resolves an image definition
on the client, so a container asked to resolve `week3_image` tries to re-read
the `add_local_dir` sources from a repository that only exists on a developer
machine. This script builds both sandbox images here, where the repository is
present, publishes them under stable names, and only then deploys the app; the
container then references them with `Image.from_name` and never rebuilds.

    python apps/runner-modal/tools/deploy.py

Republishing is cheap when nothing changed: `Image.build` returns the cached
image rather than rebuilding it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import modal

# modal 1.x reaches `modal.runner` through a lazy __getattr__ that resolves only
# a curated list of names, and `runner` is not on it: `modal.runner.deploy_app`
# raises AttributeError unless the submodule was imported by name first.
import modal.runner

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cogworks_runner.modal_app import (  # noqa: E402
    BENCHMARK_SANDBOX_IMAGE,
    WEEK1_SANDBOX_IMAGE,
    WEEK3_SANDBOX_IMAGE,
    app,
    benchmark_image,
    week1_image,
    week3_image,
)

SANDBOX_IMAGES = (
    (benchmark_image, BENCHMARK_SANDBOX_IMAGE),
    (week3_image, WEEK3_SANDBOX_IMAGE),
    (week1_image, WEEK1_SANDBOX_IMAGE),
)


def main() -> int:
    # `Image.build` needs an initialized app purely as a load context. Use a
    # separate one so building images never touches the deployed app's state.
    build_context = modal.App.lookup("cogworks-runner-images", create_if_missing=True)
    with modal.enable_output():
        for image, name in SANDBOX_IMAGES:
            print("building sandbox image {}...".format(name))
            built = image.build(build_context)
            built.publish(name)
            print("published {} -> {}".format(name, built.object_id))
        modal.runner.deploy_app(app)
    print(
        "deployed; sandbox images published as {}".format(
            ", ".join(name for _image, name in SANDBOX_IMAGES)
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
