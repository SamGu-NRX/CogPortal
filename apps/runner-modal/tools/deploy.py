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
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence

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

#: Every name a dispatch can resolve. `--publish` requires all of them.
SANDBOX_IMAGE_NAMES = tuple(name for _image, name in SANDBOX_IMAGES)

#: Modal object ids are prefixed and opaque; matching the prefix separates one
#: from the mutable names this script publishes.
IMAGE_ID = re.compile(r"im-[A-Za-z0-9]+\Z")


class PublishArgumentError(ValueError):
    """A `--publish` input that must be refused before anything is sent."""


def parse_publish(values: Sequence[str]) -> Dict[str, str]:
    """Read every `NAME=IMAGE_ID` pair, or refuse the whole set.

    Require all three names before any cloud call, so omitted inputs cannot
    silently retain an old image. Publication itself is not atomic.
    """

    published: Dict[str, str] = {}
    for value in values:
        name, separator, image_id = value.partition("=")
        if not separator:
            raise PublishArgumentError("{!r} is not NAME=IMAGE_ID.".format(value))
        if name not in SANDBOX_IMAGE_NAMES:
            raise PublishArgumentError(
                "{} is not a sandbox image name. Expected one of {}.".format(
                    name or "an empty name", ", ".join(SANDBOX_IMAGE_NAMES)
                )
            )
        if name in published:
            raise PublishArgumentError("{} was given twice.".format(name))
        if not IMAGE_ID.match(image_id):
            raise PublishArgumentError(
                "{} is not an immutable image id for {}. Pass the `im-...` id "
                "`--build-only` printed.".format(image_id or "an empty id", name)
            )
        published[name] = image_id

    missing = [name for name in SANDBOX_IMAGE_NAMES if name not in published]
    if missing:
        raise PublishArgumentError(
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

    # Before Modal, so a mistyped id or a missing image costs nothing.
    published: Dict[str, str] = {}
    if arguments.publish:
        try:
            published = parse_publish(arguments.publish)
        except PublishArgumentError as error:
            parser.error(str(error))

    # Publishing also deploys the controller, which installs benchmark source.
    stale = stale_build_trees()
    if stale:
        print("Refusing to deploy: stale build trees would shadow the real source.")
        for path in stale:
            print("  rm -rf {}".format(path))
        return 1

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
        for image, name in SANDBOX_IMAGES:
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
            ", ".join(name for _image, name in SANDBOX_IMAGES)
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
