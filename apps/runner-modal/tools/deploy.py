"""Deploy the CogWorks runner.

Use this instead of a bare `modal deploy`. `_prepare` creates its evaluation
sandbox from inside a Modal container, and Modal resolves an image definition
on the client, so a container asked to resolve `week3_image` tries to re-read
the `add_local_dir` sources from a repository that only exists on a developer
machine. This script builds the sandbox images here, where the repository is
present, publishes them under stable names, and only then deploys the app; the
container then references them with `Image.from_name` and never rebuilds.

    python apps/runner-modal/tools/deploy.py

Republishing is cheap when nothing changed: `Image.build` returns the cached
image rather than rebuilding it.

Two flags split that into the order the release gate needs, because publishing
a name is what makes an image live and the gate has to run before that:

    python apps/runner-modal/tools/deploy.py --build-only
    python apps/runner-modal/tools/deploy.py \\
        --publish cogworks-runner-benchmark=im-... \\
        --publish cogworks-runner-week3=im-... \\
        --publish cogworks-runner-week1=im-...

`--build-only` builds and prints each immutable id without publishing or
deploying anything. `--publish` takes those exact ids, publishes them under
their names without rebuilding, and deploys the app.

Explicit ids avoid relying on a second build returning the same image.
The operator must verify four benchmark receipts before publication; this
script does not inspect receipts.

Everything above is staging, which is the default. Production deploys the
controller and nothing else, against ids staging already published and
probed:

    python apps/runner-modal/tools/deploy.py --target production \\
        --sandbox-image cogworks-runner-benchmark=im-... \\
        --sandbox-image cogworks-runner-week3=im-... \\
        --sandbox-image cogworks-runner-week1=im-...

It builds no sandbox image and publishes no name, because publishing is what
makes an image live for staging and production must not move underneath a
staging release. The ids are captured into the deployed controller instead.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import modal

# modal 1.x reaches `modal.runner` through a lazy __getattr__ that resolves only
# a curated list of names, and `runner` is not on it: `modal.runner.deploy_app`
# raises AttributeError unless the submodule was imported by name first.
import modal.runner

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cogworks_runner.deployment import (  # noqa: E402
    BENCHMARK_SANDBOX_IMAGE,
    PRODUCTION,
    SANDBOX_IMAGE_NAMES,
    STAGING,
    WEEK1_SANDBOX_IMAGE,
    WEEK3_SANDBOX_IMAGE,
    Deployment,
    DeploymentError,
    parse_image_pairs,
    production,
    staging,
)


def load_app(
    deployment: Deployment,
) -> Tuple["modal.App", Tuple[Tuple["modal.Image", str], ...]]:
    """Import the controller with this deployment selected.

    Deferred rather than imported at module scope, because `modal_app` builds
    its app, secret, dictionary and controller image while it is being
    imported, reading the same environment the container will read. The
    selection therefore has to be in place before the import rather than
    applied to the module afterwards.
    """

    deployment.apply_to(os.environ)
    from cogworks_runner.modal_app import (
        app,
        benchmark_image,
        week1_image,
        week3_image,
    )

    return app, (
        (benchmark_image, BENCHMARK_SANDBOX_IMAGE),
        (week3_image, WEEK3_SANDBOX_IMAGE),
        (week1_image, WEEK1_SANDBOX_IMAGE),
    )


def parse_publish(values: Sequence[str]) -> Dict[str, str]:
    """Read every `NAME=IMAGE_ID` pair, or refuse the whole set.

    Require all three names before any cloud call, so omitted inputs cannot
    silently retain an old image. Publication itself is not atomic.
    """

    published = parse_image_pairs(values)
    missing = [name for name in SANDBOX_IMAGE_NAMES if name not in published]
    if missing:
        raise DeploymentError(
            "No image id for {}. Publish every sandbox image together, or the "
            "app deploys against a mixed set.".format(", ".join(missing))
        )
    return published


def stale_build_trees() -> list:
    """Benchmark directories holding a `build/` from a previous local build.

    The images install each benchmark with `pip install /opt/weekN`, which
    builds from source, and setuptools reuses whatever is already in `build/`
    rather than recopying. A month-old tree there silently shadows the real
    module inside the sandbox: locally every test passes, hosted runs fail on
    a keyword the current source added. Measured once, on Week 3, and it cost
    a deploy cycle to find.

    They are gitignored, so a fresh clone never has them and this only ever
    fires on a developer machine that once ran `python -m build`.
    """

    return [
        path
        for week in ("week1", "week2", "week3")
        for path in [Path(__file__).resolve().parents[3] / "benchmarks" / week / "build"]
        if path.is_dir()
    ]


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--target",
        choices=(STAGING, PRODUCTION),
        default=STAGING,
        help="which environment's app, signing secret and job dictionary to deploy",
    )
    parser.add_argument(
        "--sandbox-image",
        action="append",
        metavar="NAME=IMAGE_ID",
        default=[],
        help=(
            "with --target production, the immutable id this deployment runs "
            "under this name; repeat for every sandbox image"
        ),
    )
    phase = parser.add_mutually_exclusive_group()
    phase.add_argument(
        "--build-only",
        action="store_true",
        help="build each sandbox image and print its immutable id; publish and deploy nothing",
    )
    phase.add_argument(
        "--publish",
        action="append",
        metavar="NAME=IMAGE_ID",
        default=[],
        help="publish this exact image id under this name; repeat for every sandbox image",
    )
    arguments = parser.parse_args(argv)

    # Before Modal, so a mistyped id, a missing image or the wrong flag for
    # this target costs nothing.
    published: Dict[str, str] = {}
    try:
        if arguments.target == PRODUCTION:
            if arguments.build_only or arguments.publish:
                parser.error(
                    "--target production deploys the controller only. Building and "
                    "publishing a sandbox image name is a staging release step."
                )
            deployment = production(parse_image_pairs(arguments.sandbox_image))
        else:
            if arguments.sandbox_image:
                parser.error(
                    "--sandbox-image belongs to --target production. Staging "
                    "resolves each image by the name it publishes."
                )
            deployment = staging()
            if arguments.publish:
                published = parse_publish(arguments.publish)
    except DeploymentError as error:
        parser.error(str(error))

    # Every path below deploys the controller, which installs benchmark source.
    stale = stale_build_trees()
    if stale:
        print("Refusing to deploy: stale build trees would shadow the real source.")
        for path in stale:
            print("  rm -rf {}".format(path))
        return 1

    app, sandbox_images = load_app(deployment)

    if deployment.is_production:
        with modal.enable_output():
            modal.runner.deploy_app(app)
        print(
            "deployed {}; sandbox images pinned to {}".format(
                deployment.app_name,
                ", ".join(
                    "{}={}".format(name, deployment.sandbox_image_ids[name])
                    for name in SANDBOX_IMAGE_NAMES
                ),
            )
        )
        return 0

    if published:
        with modal.enable_output():
            for name in SANDBOX_IMAGE_NAMES:
                image_id = published[name]
                modal.Image.from_id(image_id).publish(name)
                print("published {} -> {}".format(name, image_id))
            modal.runner.deploy_app(app)
        print(
            "deployed; sandbox images published as {}".format(
                ", ".join(SANDBOX_IMAGE_NAMES)
            )
        )
        return 0

    # `Image.build` needs an initialized app purely as a load context. Use a
    # separate one so building images never touches the deployed app's state.
    build_context = modal.App.lookup("cogworks-runner-images", create_if_missing=True)
    built_ids: List[str] = []
    with modal.enable_output():
        for image, name in sandbox_images:
            print("building sandbox image {}...".format(name))
            built = image.build(build_context)
            if arguments.build_only:
                built_ids.append("--publish {}={}".format(name, built.object_id))
                print("built {} -> {}".format(name, built.object_id))
                continue
            built.publish(name)
            print("published {} -> {}".format(name, built.object_id))
        if arguments.build_only:
            print(
                "\nbuilt, nothing published. Probe each id, then publish them together:\n"
                "  python apps/runner-modal/tools/deploy.py \\\n    {}".format(
                    " \\\n    ".join(built_ids)
                )
            )
            return 0
        modal.runner.deploy_app(app)
    print(
        "deployed; sandbox images published as {}".format(
            ", ".join(name for _image, name in sandbox_images)
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
