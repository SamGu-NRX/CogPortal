"""Which environment a runner deployment is, and which Modal objects it owns.

Staging and production run the same controller source against different Modal
objects. The choice has to reach two places that never see each other: the
machine running `tools/deploy.py`, and every container Modal starts, which
imports this package again from nothing (`modal/_runtime/user_code_imports.py`
resolves a deployed function with `importlib.import_module`, modal 1.5.5). A
value held in the deploy process would leave the container taking the default,
so the selection travels as two environment variables, set locally by
`deploy.py` and baked into the production controller image. This module is the
only reader.

Staging is the default and names what it has always named, so ordinary
deploys, the operator tools and the tests see no change.

Production pins each sandbox image to an immutable id rather than a published
name, because publishing a name is how a staging release makes an image live
and `Image.from_name` would follow it. Its own signing secret keeps a staging
rotation from locking production out, and its own job dictionary keeps the two
from colliding on a job id.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Dict, Mapping, MutableMapping, Sequence

STAGING = "staging"
PRODUCTION = "production"

#: Read at import by `modal_app`. `deploy.py` sets both before importing the
#: controller; the production controller image carries them as image
#: environment so the container reaches the same answer.
TARGET_VARIABLE = "COGWORKS_RUNNER_TARGET"
SANDBOX_IMAGE_IDS_VARIABLE = "COGWORKS_RUNNER_SANDBOX_IMAGE_IDS"

#: Names the sandbox images are published under at staging deploy time.
#:
#: `_prepare` creates its sandbox from inside a Modal container, where the
#: repository that these images' `add_local_dir` layers read does not exist.
#: Modal resolves an image definition client-side, so naming the objects
#: directly there makes it try to rebuild them from local files and fail with
#: "local dir ... does not exist". Publishing each image from the machine that
#: does have the repository (see tools/deploy.py) turns it into a server-side
#: object the container can reference by name instead of rebuild.
BENCHMARK_SANDBOX_IMAGE = "cogworks-runner-benchmark"
WEEK3_SANDBOX_IMAGE = "cogworks-runner-week3"
WEEK1_SANDBOX_IMAGE = "cogworks-runner-week1"

#: Every name a dispatch can resolve. Production supplies an id for all of them.
SANDBOX_IMAGE_NAMES = (
    BENCHMARK_SANDBOX_IMAGE,
    WEEK3_SANDBOX_IMAGE,
    WEEK1_SANDBOX_IMAGE,
)

#: Modal object ids are prefixed and opaque; matching the prefix separates one
#: from the mutable names a staging deploy publishes.
IMAGE_ID = re.compile(r"im-[A-Za-z0-9]+\Z")


class DeploymentError(ValueError):
    """A selection that must be refused before anything reaches Modal."""


@dataclass(frozen=True)
class Deployment:
    """One environment's Modal object names and pinned sandbox images."""

    target: str
    app_name: str
    signing_secret_name: str
    job_dict_name: str
    #: Empty for staging, which resolves each sandbox image by published name.
    sandbox_image_ids: Mapping[str, str]

    @property
    def is_production(self) -> bool:
        return self.target == PRODUCTION

    def environment(self) -> Dict[str, str]:
        """What a fresh import has to read to reach this same deployment.

        Empty for staging, which is already the default: an image layer saying
        so would change the controller image staging deploys.
        """

        if not self.is_production:
            return {}
        return {
            TARGET_VARIABLE: self.target,
            SANDBOX_IMAGE_IDS_VARIABLE: json.dumps(
                dict(self.sandbox_image_ids), sort_keys=True, separators=(",", ":")
            ),
        }

    def apply_to(self, environ: MutableMapping[str, str]) -> None:
        """Select this deployment for the next import of the controller.

        Both variables are cleared first, or an operator who exported
        `COGWORKS_RUNNER_TARGET` would get a production controller out of a
        command that said staging.
        """

        for name in (TARGET_VARIABLE, SANDBOX_IMAGE_IDS_VARIABLE):
            environ.pop(name, None)
        environ.update(self.environment())


def staging() -> Deployment:
    """The objects this app has used since July, and the default everywhere."""

    return Deployment(
        target=STAGING,
        app_name="cogworks-runner",
        signing_secret_name="cogworks-runner-signing",
        job_dict_name="cogworks-runner-jobs",
        sandbox_image_ids={},
    )


def production(sandbox_image_ids: Mapping[str, str]) -> Deployment:
    """The isolated objects, given an immutable id for every sandbox image."""

    return Deployment(
        target=PRODUCTION,
        app_name="cogworks-runner-production",
        signing_secret_name="cogworks-runner-production-signing",
        job_dict_name="cogworks-runner-production-jobs",
        sandbox_image_ids=_complete_image_ids(sandbox_image_ids),
    )


def select(environ: Mapping[str, str]) -> Deployment:
    """Read the deployment out of an environment mapping, or refuse it.

    This runs at controller import, so a refusal stops a misconfigured deploy
    on the operator's machine and a misconfigured container before it claims a
    job.
    """

    target = environ.get(TARGET_VARIABLE) or STAGING
    raw_ids = environ.get(SANDBOX_IMAGE_IDS_VARIABLE) or ""
    if target == STAGING:
        if raw_ids:
            raise DeploymentError(
                "{} is set while {} selects staging. Staging resolves each image "
                "by its published name, so one of the two was set by mistake.".format(
                    SANDBOX_IMAGE_IDS_VARIABLE, TARGET_VARIABLE
                )
            )
        return staging()
    if target != PRODUCTION:
        raise DeploymentError(
            "{!r} is not a deployment target. Expected {} or {}.".format(
                target, STAGING, PRODUCTION
            )
        )
    try:
        decoded = json.loads(raw_ids) if raw_ids else None
    except ValueError as error:
        raise DeploymentError(
            "{} is not JSON: {}".format(SANDBOX_IMAGE_IDS_VARIABLE, error)
        ) from error
    if not isinstance(decoded, dict):
        raise DeploymentError(
            "{} must be a JSON object mapping each sandbox image name to its "
            "immutable id.".format(SANDBOX_IMAGE_IDS_VARIABLE)
        )
    return production(decoded)


def parse_image_pairs(values: Sequence[str]) -> Dict[str, str]:
    """Read every `NAME=IMAGE_ID` command-line pair, or refuse the whole set."""

    pairs: Dict[str, str] = {}
    for value in values:
        name, separator, image_id = value.partition("=")
        if not separator:
            raise DeploymentError("{!r} is not NAME=IMAGE_ID.".format(value))
        if name in pairs:
            raise DeploymentError("{} was given twice.".format(name))
        _check_pair(name, image_id)
        pairs[name] = image_id
    return pairs


def _check_pair(name: str, image_id: str) -> None:
    if name not in SANDBOX_IMAGE_NAMES:
        raise DeploymentError(
            "{} is not a sandbox image name. Expected one of {}.".format(
                name or "an empty name", ", ".join(SANDBOX_IMAGE_NAMES)
            )
        )
    if not IMAGE_ID.match(image_id):
        raise DeploymentError(
            "{} is not an immutable image id for {}. Pass the `im-...` id "
            "`--build-only` printed.".format(image_id or "an empty id", name)
        )


def _complete_image_ids(values: Mapping[str, str]) -> Dict[str, str]:
    ids: Dict[str, str] = {}
    for name, image_id in sorted(dict(values).items()):
        _check_pair(str(name), str(image_id))
        ids[str(name)] = str(image_id)
    missing = [name for name in SANDBOX_IMAGE_NAMES if name not in ids]
    if missing:
        raise DeploymentError(
            "No image id for {}. Production pins every sandbox image, and a "
            "benchmark whose image is unnamed has nothing to run on.".format(
                ", ".join(missing)
            )
        )
    return ids
