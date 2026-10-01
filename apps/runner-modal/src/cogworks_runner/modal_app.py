from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import textwrap
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import modal
from fastapi import Request, Response

from .deployment import (
    BENCHMARK_SANDBOX_IMAGE,
    WEEK1_SANDBOX_IMAGE,
    WEEK3_SANDBOX_IMAGE,
)
from .deployment import select as select_deployment
from .image_bake import (
    WEEK2_CACHE_DIR,
    WEEK3_DATA_DIR,
    cache_facenet_checkpoint,
    cache_week2_celeba,
    cache_week3_artifacts,
)
from .failure import RunnerFailure
from .prediction_validation import (
    check_predictions,
    load_predictions,
    restore_v2_predictions,
)
from .protocol import canonical_json, signature, validate_job, verify_signature
from .prepared_environment import (
    bind_environment,
    student_python,
    validate_observation,
    validate_prepared_environment,
)

# Every request the runner makes to the portal or to GitHub carries this.
# urllib's default is "Python-urllib/3.11", and Cloudflare's managed rules
# in front of the portal answer that with 403 (error 1010) before the worker
# sees the request. The 2026-09-04 audio run stalled in "queued" for an hour
# for exactly that reason: the sandbox could not report "preparing".
RUNNER_USER_AGENT = "cogworks-runner"


def _repo_root() -> Path:
    """Monorepo root, needed only by the `add_local_dir` calls in the image
    definitions below.

    Those paths matter only while a local `modal deploy` builds the images.
    Modal also imports this module inside the container, where the package sits
    at `/root/cogworks_runner` and the repository does not exist. A hardcoded
    `parents[4]` raised IndexError there, which crash-looped every container.
    Anchoring on the workspace marker also removes the silent failure mode where
    moving this file makes `parents[4]` point somewhere else that happens to
    exist.
    """
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "pnpm-workspace.yaml").is_file():
            return candidate
    if modal.is_local():
        raise RuntimeError(
            "Deploy cogworks_runner.modal_app from inside the CogPortal monorepo; "
            "no pnpm-workspace.yaml found above {}.".format(Path(__file__).resolve())
        )
    # In-container: the images are already built, so these paths are never read.
    return Path("/opt/cogworks-runner-not-local")


REPO_ROOT = _repo_root()


#: How long one scorer note may be on the wire.
#:
#: It was 240, and the scorers write longer than that. The week 1 notes run to
#: 315 characters and week 2's abstention note to 392, so five of the fixed
#: templates arrived on the run page cut mid-word, losing the half of the note
#: that said what to change.
#:
#: 600 is not a new number here. It is what packages/contracts already allows
#: for every prose field of a refusal (headline, nextStep, notes), which is the
#: same kind of text written for the same reader. Thirty-two notes at 600 is
#: 19 KB in the worst case, against the 8 KiB the sanitized log gets on its own
#: separate allowance.
#:
#: Raising this needs the portal deployed before the runner. The worker
#: validates the inbound event and answers 400 for a longer string, and
#: `_post_event` does not retry a 400, so a runner that ran ahead of the portal
#: would lose whole completed events rather than a few characters.
DIAGNOSTIC_LIMIT = 600

#: `protocol.ts` caps `detail` here, and it is one string with nowhere to
#: put a remainder.
DETAIL_LIMIT = 240

#: `protocol.ts` caps `sanitizedLog` here, on completed and failed events.
LOG_LIMIT = 8 * 1024

def _receiver_units(text: str) -> int:
    """What `z.string().max(n)` counts: UTF-16 code units, not code points.

    Arithmetic rather than `.encode("utf-16-le")`, which raises on a lone
    surrogate. Student code can produce one and Unix paths can carry one, and
    this is called from inside failure handling.
    """

    return sum(2 if ord(character) > 0xFFFF else 1 for character in text)


def _take_units(text: str, limit: int) -> Tuple[str, str]:
    """`(head, rest)` where `head` is within `limit` receiver units."""

    used = 0
    for index, character in enumerate(text):
        size = 2 if ord(character) > 0xFFFF else 1
        if used + size > limit:
            return text[:index], text[index:]
        used += size
    return text, ""


def _fit(text: str, limit: int) -> str:
    """`text` within `limit` receiver units, cut at a word and marked if cut.

    For a field with nowhere to put a remainder. The receiver answers 400 past
    its cap and `_post_event` does not retry a 400, so an oversized field loses
    the whole event rather than a few characters.
    """

    if _receiver_units(text) <= limit:
        return text
    head, _ = _take_units(text, limit - 4)  # room for " ..."
    return (head.rsplit(" ", 1)[0] if " " in head else head) + " ..."


def _failure_detail(error: Any) -> str:
    """The failure's own words, within `DETAIL_LIMIT`.

    Sliced at 240 code points, this landed mid-word: staging run
    run_158c8e88c3 read "...trying to locate the file on the Hub a". A short
    message keeps its own line breaks; only one that has to be cut is joined
    into a line, because a word-boundary cut needs words on one line.
    """

    raw = str(error)
    if _receiver_units(raw) <= DETAIL_LIMIT:
        return raw
    return _fit(" ".join(raw.split()), DETAIL_LIMIT)


def _diagnostic_lines(item: Any) -> List[str]:
    """One note, in pieces no longer than the wire allows, split between words.

    Nothing in the current scorers reaches the limit, so this is what happens
    the day one does. Splitting keeps the whole instruction, where slicing kept
    a prefix and threw away the sentence the student was meant to act on.

    Two notes on the shape. The run page reads the first entry as the headline
    and the rest as supporting lines, so a note long enough to split puts its
    second half in a bullet, which is worse than one paragraph and much better
    than losing it. And a split note spends more of the 32-entry budget, which
    is why the caller still caps the list afterwards.
    """

    text = str(item).strip()
    if _receiver_units(text) <= DIAGNOSTIC_LIMIT:
        return [text]
    # `textwrap` measures in code points, so a line of astral characters can
    # still exceed the cap the receiver counts. Any that does is split again
    # rather than cut: this path has somewhere to put a remainder, and keeping
    # the whole instruction is the reason it exists.
    lines = []
    for line in textwrap.wrap(
        text,
        width=DIAGNOSTIC_LIMIT,
        break_long_words=True,
        break_on_hyphens=False,
    ):
        while _receiver_units(line) > DIAGNOSTIC_LIMIT:
            head, line = _take_units(line, DIAGNOSTIC_LIMIT)
            lines.append(head)
        lines.append(line)
    return lines or [text]


def _cogbench_environment():
    """The per-track package manifest, from wherever cogbench is reachable.

    The manifest lives in `cogbench` rather than here because a student's
    laptop has cogbench and not this package, and `cogworks check` has to be
    able to say which of the graded run's packages the laptop is missing.

    Two call sites, two ways to reach it. Inside a container PYTHONPATH carries
    /opt/cogbench, so the plain import works. On a developer machine running
    `tools/deploy.py`, cogbench is frequently not installed into the same
    interpreter, so the repository copy is put on the path first. Failing
    loudly is deliberate: an image built from a silently-substituted default
    would install a package set nobody wrote down.
    """

    try:
        from cogbench import environment
    except ImportError:
        source = REPO_ROOT / "python" / "cogbench" / "src"
        if not source.is_dir():
            raise
        import sys

        sys.path.insert(0, str(source))
        from cogbench import environment
    return environment


ENVIRONMENT = _cogbench_environment()


def add_source_dir(image: "modal.Image", local: Path, remote: str) -> "modal.Image":
    """`add_local_dir` for a source tree, without the developer's build junk.

    Two distinct problems, one fix. Modal hashes every file it copies and
    fails the build if one changes underneath it, and `.pytest_cache` is
    rewritten by any test run, so building an image while tests run aborts
    with "was modified during build process". Separately, a stale
    `*.egg-info` or `__pycache__` copied into the image can shadow the
    package actually installed there, which fails much later and much more
    confusingly than a build error.
    """

    return image.add_local_dir(str(local), remote, copy=True, ignore=BUILD_JUNK)


#: Glob patterns excluded from every source copy. `~=` is Modal's "match this
#: as a .dockerignore pattern" prefix; `**/` makes each one match at any depth.
BUILD_JUNK = [
    "~=**/__pycache__",
    "~=**/*.pyc",
    "~=**/.pytest_cache",
    "~=**/.ruff_cache",
    "~=**/.mypy_cache",
    "~=**/*.egg-info",
    "~=**/.git",
    "~=**/.venv",
    "~=**/build",
    "~=**/dist",
]

#: Staging unless the environment says otherwise, both here and inside every
#: container: Modal re-imports this module to resolve a deployed function, so
#: the selection has to be something the container can read for itself.
#: `tools/deploy.py` sets it before importing this module, and bakes it into
#: the production controller image for the container half. See deployment.py.
DEPLOYMENT = select_deployment(os.environ)

app = modal.App(DEPLOYMENT.app_name)
# modal>=1.5 removed create_if_missing from Secret.from_name; the secret is
# still required to exist (deploy fails at reference resolution otherwise).
runner_secret = modal.Secret.from_name(DEPLOYMENT.signing_secret_name)
hidden_datasets = modal.Volume.from_name("cogworks-hidden-datasets", create_if_missing=True)
# One dataset volume with one owner, mounted read-only in production. Nothing
# here writes under /hidden: `_cases`, `_v2_cases`, `_week3_cases` and
# `_week1_manifest` only read it, and the operator materializers write their
# bundles locally. So read-only costs production nothing and removes the one
# way it could damage data every environment reads.
hidden_mount = (
    hidden_datasets.with_mount_options(read_only=True)
    if DEPLOYMENT.is_production
    else hidden_datasets
)
# Job ids are portal-scoped, so two environments sharing one dictionary would
# let either one answer for the other's claim and stored outcome.
job_store = modal.Dict.from_name(DEPLOYMENT.job_dict_name, create_if_missing=True)

# Hosted images run 3.11: Modal's 2025.06 image builder dropped Python 3.8,
# and the run protocol already declared pythonVersion "3.11" (runner.ts).
# The student-local contract stays 3.8; 3.8-compatible code runs on 3.11.
# Every package each image installs comes from `cogbench.environment`, which
# holds them as data. They used to be spelled out here as builder arguments,
# which made this file the only thing that knew what a graded run provides:
# nothing could import a chain of Modal method calls, so every other component
# that needed to know kept a separate list and those lists drifted apart.
#
# The measured cost of that drift: `networkx` sat on cogbench's list of
# packages the sandbox does not have while this image installed networkx==3.1,
# so discovery replaced a working package with a stand-in and reported a team's
# own clustering code as broken. `apps/runner-modal/tests/test_environment_parity.py`
# now compares the two lists and fails if they ever overlap again.
#
# The requirement strings are unchanged by that move, and
# `tools/image_manifest.py` prints them so a build can be diffed against a
# previous one.
benchmark_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    # The Week 2 conda environment the course tells students to build
    # (docs/capstones/environment.md:146) carries scikit-learn, scikit-image,
    # and matplotlib, and mygrad/mynn/noggin are the pip installs on the same
    # page (line 168). This image had none of them, so a submission importing
    # any one of them failed at import with a ModuleNotFoundError that named a
    # package the course told the student to have. mygrad is pinned to 2.2.0
    # because 2.3.0 requires Python 3.9 and the student contract is 3.8;
    # imageio and networkx are scikit-image's own runtime dependencies, named
    # explicitly so a pin change in scikit-image cannot silently drop them.
    .pip_install(*ENVIRONMENT.requirement_strings("week2"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "python" / "cogbench" / "src", "/opt/cogbench"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "apps" / "runner-modal" / "src", "/opt/runner"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "week2", "/opt/week2"))
    .run_commands("python -m pip install --no-deps /opt/week2")
    # MPLBACKEND: student code plots, and a backend that wants a window blocks
    # until the sandbox times out. One 2026 team's whispers calls plt.show()
    # inside its iteration loop. Week 1's image already set this; the other two
    # did not, so the same student code burned a whole Week 2 evaluation.
    .env(
        {
            "PYTHONPATH": "/opt/cogbench:/opt/runner",
            "TORCH_HOME": "/opt/torch",
            "MPLBACKEND": "Agg",
            # PYTHONHASHSEED: one 2026 team builds its IDF table by iterating
            # a set, so which order words land in it depends on string
            # hashing, and its text retrieval score moved between 0.8188 and
            # 0.8335 across three seeds. An interpreter's seed is fixed before
            # its first line, so it has to come from the image environment,
            # where every process in the sandbox inherits it. The binding
            # records whether it was pinned (isolate.hash_seed_in_effect).
            "PYTHONHASHSEED": "0",
            # XDG_CACHE_HOME: Week 2 asks platformdirs where its photographs
            # are and never passes a root of its own, so the answer depends on
            # whose home directory is asking. Pinning it here is what makes the
            # cache `cache_week2_celeba` writes at build time the same cache
            # the sandbox opens at run time.
            "XDG_CACHE_HOME": WEEK2_CACHE_DIR,
        }
    )
    .run_function(cache_facenet_checkpoint)
    .run_function(cache_week2_celeba)
)

#: Student evaluation interpreter for Week 3. Modal's runtime requires
#: Python 3.10+, but the course contract is 3.8, so the image carries a
#: pinned CPython 3.8.20 venv (built with uv) and every prepare/evaluate
#: step for language-search runs through it. The 3.11 interpreter remains
#: the Modal control runtime only.
WEEK3_STUDENT_PYTHON = ENVIRONMENT.PY38_VENV

#: Same arrangement for Week 1. The path is identical by construction (one
#: venv layout, two images), but naming it separately keeps a future change
#: to one track's interpreter from silently moving the other's.
WEEK1_STUDENT_PYTHON = ENVIRONMENT.PY38_VENV

week3_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "numpy==1.24.4",
        "gensim>=4.3,<4.4",
        "platformdirs>=4,<5",
        "uv>=0.5",
    )
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "python" / "cogbench" / "src", "/opt/cogbench"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "apps" / "runner-modal" / "src", "/opt/runner"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "week3", "/opt/week3"))
    .run_commands(
        "python -m pip install --no-deps /opt/week3",
        "uv venv --python 3.8.20 /opt/cogworks-py38",
        # Student code runs in this venv, so the course's Week 3 stack has to
        # be here and not only in the 3.11 control interpreter. mygrad, mynn,
        # noggin, and cogworks-data are the pip installs the course prescribes
        # (docs/capstones/environment.md:244); matplotlib, scikit-learn, and
        # numba come from the conda line above it (line 218). Without them a
        # submission that trains with mygrad, the shape the course teaches,
        # failed at import. mygrad is pinned to 2.2.0 because 2.3.0 requires
        # Python 3.9.
        ENVIRONMENT.venv_install_command("week3"),
        "/opt/cogworks-py38/bin/python -m pip install --no-deps /opt/week3",
        "/opt/cogworks-py38/bin/python -c \"import sys; assert sys.version_info[:3] == (3, 8, 20), sys.version\"",
    )
    .env(
        {
            "PYTHONPATH": "/opt/cogbench:/opt/runner",
            "COGWORKS_LANGUAGE_DATA": WEEK3_DATA_DIR,
            # See the Week 2 image: a plot that wants a window never gets one.
            "MPLBACKEND": "Agg",
            # One 2026 team builds its IDF table by iterating a set, so word
            # order depends on string hashing and its text retrieval score moved
            # between 0.8188 and 0.8335 across three seeds. An interpreter's
            # seed is fixed before its first line, so it has to come from the
            # image environment for every process in the sandbox to inherit it.
            "PYTHONHASHSEED": "0",
        }
    )
    .run_function(cache_week3_artifacts)
)

week1_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    # libsndfile is soundfile's C library; the wheel does not vendor it on
    # Linux, so an import of soundfile (and therefore of librosa) fails
    # without it. Deliberately no portaudio/pyaudio: nothing in the contract
    # touches a microphone, and leaving it out makes a submission's mic path
    # fail loudly at import rather than block on a device that does not exist.
    .apt_install("libsndfile1", "ffmpeg")
    .pip_install(
        "numpy==1.24.4",
        "platformdirs>=4,<5",
        "uv>=0.5",
    )
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "python" / "cogbench" / "src", "/opt/cogbench"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "apps" / "runner-modal" / "src", "/opt/runner"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "week1", "/opt/week1"))
    .run_commands(
        "python -m pip install --no-deps /opt/week1",
        "uv venv --python 3.8.20 /opt/cogworks-py38",
        # The Week 1 conda environment the course prescribes
        # (docs/capstones/environment.md:86,90) is numpy, scipy, matplotlib,
        # numba, librosa, and ffmpeg. Every version here was checked to
        # resolve together on 3.8 for manylinux with
        # `uv pip compile --python-version 3.8 --python-platform
        # x86_64-manylinux_2_28`; librosa is left unpinned in that check and
        # resolved to 0.11.0, which is pinned here so a later release cannot
        # move under a run. soundfile is librosa's I/O backend and the
        # course's own audio loader.
        #
        # pyaudio is deliberately absent. It is in the course's conda line
        # because students record their own clips; the benchmark hands over
        # arrays and never opens a device.
        # ipython is in the course's own week 1 conda line
        # (docs/capstones/environment.md:86), because the capstone is written
        # in Jupyter. Leaving it out of the image meant `from IPython.display
        # import Audio` -- a display call, nothing to do with scoring -- made
        # a module unimportable, and one 2026 team lost their whole pipeline
        # to that single line. The environment students are told to build is
        # the environment their code should run in.
        ENVIRONMENT.venv_install_command("week1"),
        "/opt/cogworks-py38/bin/python -m pip install --no-deps /opt/week1",
        "/opt/cogworks-py38/bin/python -c \"import sys; assert sys.version_info[:3] == (3, 8, 20), sys.version\"",
        # Import-checked at build time rather than trusted: a wheel that
        # installs and then fails to import (libsndfile, llvmlite/numba ABI)
        # would otherwise surface as every student's run failing.
        "/opt/cogworks-py38/bin/python -c \"import numpy, scipy, matplotlib, numba, soundfile, librosa, IPython\"",
    )
    .env(
        {
            "PYTHONPATH": "/opt/cogbench:/opt/runner",
            # Discovery and scoring iterate the student's dicts and sets. Weeks
            # 2 and 3 pin the seed; week 1 did not, so two hosted runs of one
            # repository could bind different functions and score differently.
            "PYTHONHASHSEED": "0",
            "MPLBACKEND": "Agg",
        }
    )
)


def controller_layers(base: "modal.Image") -> "modal.Image":
    """What the controller adds to a Week 2 evaluation image.

    The controller scores every benchmark, so it carries every plugin package;
    week1 and week3 scoring are pure numpy (gensim and librosa stay lazy and
    unused there). Both targets add exactly these layers, over different bases.
    """

    return (
        base.pip_install("fastapi>=0.115,<1")
        .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "week3", "/opt/week3"))
        .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "week1", "/opt/week1"))
        .run_commands(
            "python -m pip install --no-deps /opt/week3",
            "python -m pip install --no-deps /opt/week1",
        )
    )


if DEPLOYMENT.is_production:
    # Production starts from the pinned Week 2 image itself rather than from
    # `benchmark_image`. The definition above copies this checkout's runner
    # source at /opt/runner, so resolving it now would rebuild every layer
    # after that copy (the Week 2 package install and the facenet checkpoint
    # download), and the controller would sit on layers the pinned sandboxes do
    # not share. Starting from the id keeps those layers, and the copy below
    # puts the controller's own source on top.
    #
    # `add_local_dir` is a COPY, so it merges: a file this checkout deleted
    # would survive underneath. Nothing is deleted here, but a release that
    # removes a runner module has to handle that deliberately.
    controller_image = controller_layers(
        add_source_dir(
            modal.Image.from_id(DEPLOYMENT.sandbox_image_ids[BENCHMARK_SANDBOX_IMAGE]),
            REPO_ROOT / "apps" / "runner-modal" / "src",
            "/opt/runner",
        )
    ).env(
        # How the selection reaches the container: the last layer, which the
        # container's own import of this module reads back through `select`.
        DEPLOYMENT.environment()
    )
else:
    controller_image = controller_layers(benchmark_image)

PREPARE_SCRIPT = r"""
import importlib.metadata
import json
import pathlib
import subprocess
import hashlib
import sys
import tarfile
import urllib.request

RUNNER_USER_AGENT = "cogworks-runner"

archive_url, benchmark_id, contract_group = sys.argv[1], sys.argv[2], sys.argv[3]
weights = json.loads(sys.argv[4])
archive = pathlib.Path("/tmp/source.tar.gz")
max_archive_bytes = 100 * 1024 * 1024
request = urllib.request.Request(archive_url, headers={"User-Agent": RUNNER_USER_AGENT})
try:
    with urllib.request.urlopen(request, timeout=30) as response, archive.open("wb") as output:
        declared = int(response.headers.get("Content-Length", "0"))
        if declared > max_archive_bytes:
            raise RuntimeError("Source archive is larger than 100 MiB.")
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_archive_bytes:
                raise RuntimeError("Source archive is larger than 100 MiB.")
            output.write(chunk)
except Exception as error:
    raise RuntimeError("Source archive could not be downloaded safely.") from error
root = pathlib.Path("/workspace")
root.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive, "r:gz") as bundle:
    for member in bundle.getmembers():
        if not (member.isfile() or member.isdir()):
            raise RuntimeError("Source archive contains a link or special file.")
        target = (root / member.name).resolve()
        if root.resolve() not in target.parents and target != root.resolve():
            raise RuntimeError("Source archive contains an unsafe path.")
    bundle.extractall(root)
projects = [path for path in root.iterdir() if path.is_dir()]
if len(projects) != 1:
    raise RuntimeError("Source archive must contain one project root.")
project = projects[0]

# Workers caps request bodies at 100 MB on Free and Pro plans, and this
# account's plan is not established. The largest trained weight in the 2026
# corpus is 411 KB. Week 3's separate 200 MiB discovery probe is unchanged.
max_weight_bytes = 100 * 1024 * 1024
for weight in weights:
    relative_path = weight["path"]
    expected_size = weight["size"]
    expected_digest = weight["sha256"]
    if (
        not relative_path
        or relative_path.startswith("/")
        or ".." in relative_path.split("/")
    ):
        raise RuntimeError("Weight file has an unsafe path: {}".format(relative_path))
    if expected_size > max_weight_bytes:
        raise RuntimeError("Weight file is larger than 100 MiB: {}".format(relative_path))
    target = (project / relative_path).resolve()
    if project.resolve() not in target.parents:
        raise RuntimeError("Weight file has an unsafe path: {}".format(relative_path))
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        weight["url"], headers={"User-Agent": RUNNER_USER_AGENT, **weight["headers"]}
    )
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(request) as response, target.open("wb") as output:
            declared = int(response.headers.get("Content-Length", "0"))
            if declared > max_weight_bytes:
                raise RuntimeError("Weight file is larger than 100 MiB.")
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_weight_bytes:
                    raise RuntimeError("Weight file is larger than 100 MiB.")
                digest.update(chunk)
                output.write(chunk)
        if total != expected_size:
            raise RuntimeError(
                "Weight file size changed from {} to {} bytes.".format(expected_size, total)
            )
    except Exception as error:
        raise RuntimeError(
            "Weight file {} could not be downloaded safely.".format(relative_path)
        ) from error
    if digest.hexdigest() != expected_digest:
        raise RuntimeError("Weight file {} did not match its digest.".format(relative_path))

# Resolution uses the most explicit available route.
#
# 0. An installed package exposes a `cogworks.submissions.v2` entry point.
# 1. The repository declares its binding through `cogworks.toml` or a root
#    `submission.py` or `benchmark_adapter.py`. The root file is imported by
#    path.
# 2. Automatic discovery runs only when neither declaration resolves the run.
#
# A root file avoids executing the repository's setup.py in this prepare
# sandbox, which still has network access for PyPI. The evaluate sandbox
# imports the file behind block_network=True.
has_packaging = any(
    (project / name).is_file() for name in ("pyproject.toml", "setup.py", "setup.cfg")
)
adapter_file = next(
    (
        project / name
        for name in ("submission.py", "benchmark_adapter.py")
        if (project / name).is_file()
    ),
    None,
)

installed = False
if has_packaging:
    try:
        subprocess.run(
            [
                sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                "--no-input", "-e", str(project),
            ],
            check=True,
            timeout=420,
        )
        installed = True
    except Exception:
        # A build failure is fatal only when nothing else can resolve the
        # submission. A repository carrying both a broken pyproject.toml and a
        # working submission.py is scoreable.
        if adapter_file is None:
            raise

# A repository's own requirements.txt, installed under a budget. The image
# already carries the course stack; this is for the extra package a team
# happened to use. A failure is a warning, not a refusal: the import that
# actually needs it will fail later in the student's own frame, which names the
# module, rather than here in ours, which names pip.
requirements = project / "requirements.txt"
if requirements.is_file():
    try:
        subprocess.run(
            [
                sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                "--no-input", "-r", str(requirements),
            ],
            check=True,
            timeout=300,
        )
    except Exception as error:
        sys.stderr.write("COG_NOTE: requirements.txt did not install: {}\n".format(str(error)[:200]))

resolved_by = None
if installed:
    points = importlib.metadata.entry_points()
    if hasattr(points, "select"):
        matches = list(points.select(group=contract_group, name=benchmark_id))
    else:
        matches = [
            point
            for point in points.get(contract_group, ())
            if point.name == benchmark_id
        ]
    if len(matches) == 1:
        resolved_by = "entry_point"
    elif len(matches) > 1:
        raise RuntimeError("Submission adapter entry point is ambiguous.")
if resolved_by is None and adapter_file is not None:
    resolved_by = "file:" + adapter_file.name
# 2. Automatic discovery. When the repository declares no binding, the
#    benchmark describes what it needs and `cogbench.resolve` searches for
#    functions that perform the task. It runs last so a declaration always
#    wins over inference.
#
#    An unresolved search writes a report before preparation fails, so the
#    controller can forward its advice to the run page.
discovery = None
if resolved_by is None:
    import json

    try:
        sys.path.insert(0, "/opt/cogbench")
        from cogbench.plugins import load_benchmark
        from cogbench.resolve import from_spec

        plugin = load_benchmark(benchmark_id)
        describes = getattr(plugin, "discovery", None)
        if callable(describes):
            spec = describes()
            # from_spec forwards everything a week declares: its resources,
            # its resource files, its database factory predicate, its reader
            # budget. Naming the five original fields here is how Week 3's
            # GloVe would have quietly never reached its own stages.
            found = from_spec(
                project,
                spec,
                # Without this the advice is written against the union of all
                # three images, so every missing package reads as one the
                # student must declare. cv2 is in the Week 2 image; telling a
                # Week 2 team to add it to requirements.txt sends them to fix
                # something that is not broken.
                benchmark=benchmark_id,
            )
            discovery = found.to_dict()
            if found.ready:
                resolved_by = "discovery"
    except Exception as error:
        discovery = {
            "verdict": {
                "status": "not_read",
                "headline": "The search for your code could not finish: {}".format(
                    str(error)[:200]
                ),
                "nextStep": "",
            }
        }

    if discovery is not None:
        verdict = discovery.get("verdict", {})
        if verdict.get("status") == "not_read" and not verdict.get("nextStep"):
            verdict["nextStep"] = "Run cogworks check --benchmark {} locally to inspect the search.".format(benchmark_id)
        pathlib.Path("/tmp/discovery.json").write_text(
            json.dumps(discovery), encoding="utf-8"
        )

if resolved_by is None:
    # The verdict says more than this line can, and it has already been
    # written for the caller to read. This is the summary that reaches a log.
    detail = ""
    if discovery:
        detail = " " + str(discovery.get("verdict", {}).get("headline", ""))[:300]
        if discovery.get("verdict", {}).get("status") == "not_read":
            if detail.lstrip().lower().startswith("the search for your code could not finish"):
                raise RuntimeError(detail.lstrip())
            raise RuntimeError("The search for your code could not finish.{}".format(detail))
    raise RuntimeError(
        "No adapter found in {}, and no set of functions in it performed the "
        "benchmark's task.{}".format(project.name, detail)
    )

# Read by the evaluate sandbox, which imports the adapter from this directory.
pathlib.Path("/tmp/project-root.txt").write_text(str(project), encoding="utf-8")
pathlib.Path("/tmp/adapter-source.txt").write_text(resolved_by, encoding="utf-8")
"""

EVALUATE_SCRIPT = r"""
import collections
import contextlib
import io
import json
import traceback
import pathlib
import sys
from cogbench.plugins import load_benchmark, load_submission

# Keeps the head and the tail of the stream, dropping the middle. The
# benchmark writes its own lines (showcase results, final summaries) after the
# submission has run, into this same buffer. A head-only cap let a chatty
# submission push those off the end, so the student lost the most useful part
# of their log and any check reading it saw nothing. Keeping both ends means
# the first error and the final state both survive.
class BoundedBuffer(io.TextIOBase):
    def __init__(self, limit):
        self.limit = limit
        # Half and half. The benchmark's trailing showcase block is about
        # 2.7 KB against the 8 KB cap the portal sends, so the tail has to be
        # comfortably larger than that or a chatty submission still evicts it.
        self.head_limit = max(1, limit // 2)
        self.head = []
        self.head_len = 0
        self.tail = collections.deque()
        self.tail_len = 0
        self.dropped = 0
    def write(self, value):
        text = str(value)
        written = len(text)
        room = self.head_limit - self.head_len
        if room > 0:
            chunk = text[:room]
            self.head.append(chunk)
            self.head_len += len(chunk)
            text = text[room:]
        if text:
            self.tail.append(text)
            self.tail_len += len(text)
            tail_limit = max(0, self.limit - self.head_len)
            while self.tail_len > tail_limit and self.tail:
                oldest = self.tail.popleft()
                excess = self.tail_len - tail_limit
                if len(oldest) <= excess:
                    self.tail_len -= len(oldest)
                    self.dropped += len(oldest)
                else:
                    self.tail.appendleft(oldest[excess:])
                    self.tail_len -= excess
                    self.dropped += excess
        return written
    def value(self):
        if not self.dropped:
            return "".join(self.head) + "".join(self.tail)
        marker = "\n[{} characters omitted]\n".format(self.dropped)
        return "".join(self.head) + marker + "".join(self.tail)

benchmark_id = sys.argv[1]
limit = int(sys.argv[2])
buffer = BoundedBuffer(limit)

# Where the repository was unpacked, recorded by the prepare step. Student code
# is imported from here, and the process changes directory here too: a
# student's open("db.pkl") is relative to the repository root on their laptop
# and would otherwise resolve against /tmp. The path is ours, written before
# any student code ran, so a submission cannot influence it.
_root_file = pathlib.Path("/tmp/project-root.txt")
repo_root = pathlib.Path(_root_file.read_text().strip()) if _root_file.is_file() else None
if repo_root is not None and repo_root.is_dir():
    import os
    os.chdir(str(repo_root))
    sys.path.insert(0, str(repo_root))


# How the prepare step resolved this repository. "discovery" means nothing in
# it declared a submission and the benchmark found the functions itself, which
# is a different code path here: there is no adapter file to import.
_source_file = pathlib.Path("/tmp/adapter-source.txt")
adapter_source = _source_file.read_text().strip() if _source_file.is_file() else ""


def load_student(benchmark_id, contract_version="cogworks.submissions.v1"):
    # cogbench.plugins.load_submission, anchored at the repository root.
    # Passing repo_root explicitly rather than relying on the working directory
    # keeps this correct even if a submission changes directory during its own
    # import, which several audited repositories do while loading a pickle.
    if adapter_source == "discovery":
        return _discovered_factory(benchmark_id)
    return load_submission(benchmark_id, contract_version, repo_root=repo_root), contextlib.nullcontext()


def _discovered_factory(benchmark_id):
    # Search this repository again, and hand back what the driver runs.
    #
    # Prepare already proved a binding exists, but this sandbox is a different
    # process with no network, so it searches again rather than trying to
    # carry live functions across a process boundary. The repository is the
    # same bytes and the search is deterministic, so it reaches the same
    # binding.
    #
    # A benchmark supplies its own submission_from_discovery, because turning
    # a binding into the object its driver expects is that benchmark protocol,
    # not something the resolver knows.
    from cogbench.resolve import from_spec

    benchmark = load_benchmark(benchmark_id)
    spec = benchmark.discovery()
    found = from_spec(repo_root, spec, benchmark=benchmark_id)
    if not found.ready:
        raise RuntimeError(
            "The functions found when preparing this repository could not be "
            "found again: {}".format(found.verdict.headline)
        )
    # Which of their functions ran, for the run page. Written here because
    # this is where the binding exists; the controller reads it back with the
    # predictions.
    try:
        steps = [
            {
                "stage": step.stage,
                "function": step.function,
                "received": step.received,
                "returned": step.returned,
            }
            for step in found.verdict.trace
        ]
        if found.attempt is not None:
            steps.append({"stage": "store", "function": found.attempt.enroll})
            steps.append({"stage": "query", "function": found.attempt.query})
        pathlib.Path("/tmp/cog-wiring.json").write_text(
            json.dumps(steps), encoding="utf-8"
        )
    except Exception:
        pass  # the score is the point; the explanation is worth less than it

    return (
        lambda *args, **kwargs: benchmark.submission_from_discovery(found),
        _course_files(spec),
    )


def _course_files(spec):
    # The mapping `cogworks run` holds across the candidate call, held here too.
    #
    # `from_spec` opens this same scope for resolution and closes it when it
    # returns, so a submission that reads a course file while running rather
    # than while being searched is outside it. A captured alias still works,
    # because a from-import keeps the patched function; a lookup through the
    # module, or a first import inside the call, gets the real loader, which
    # downloads into its own cache and fails here because the evaluation
    # sandbox has no network.
    #
    # Discovery path only, because that is where the mapping already exists. A
    # repository that declares its own submission would need `spec` built for
    # it, and building one loads the week's test tier and course artifacts.
    from cogbench.discover import _Redirects

    return _Redirects(dict(getattr(spec, "resource_files", {}) or {}))


# Who owns the step currently running. Decided from WHERE the exception came
# from, never from what the message says: the message is written by the
# submission, so matching words in it let a student label their own crash as a
# platform fault.
owner = "platform"
try:
    if pathlib.Path("/tmp/cog-week1-payload.zip").exists():
        import os
        from cogworks_runner.week1_payload import decode_payload
        payload_id, showcase, cases = decode_payload(
            pathlib.Path("/tmp/cog-week1-payload.zip").read_bytes()
        )
        if payload_id != benchmark_id:
            raise RuntimeError("Staged benchmark payload does not match the job.")
        os.environ["COGWORKS_SHOWCASE"] = "1" if showcase else "0"
        buffer.write("student python {}\n".format(sys.version.split()[0]))
        if sys.version_info[:2] != (3, 8):
            raise RuntimeError(
                "Week 1 evaluation must run under Python 3.8; got {}".format(sys.version.split()[0])
            )
        benchmark = load_benchmark(benchmark_id)
        # The corpus is rendered and sha256-verified by decode_payload above,
        # before any student import, so a corpus mismatch is unambiguously
        # ours and is tagged as such by `owner` still being "platform".
        resources = benchmark.model_factory()
        owner = "student"
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            factory, course_files = load_student(benchmark_id, "cogworks.submissions.v2")
            with course_files:
                # Materialized inside both scopes, not after them. `benchmark.run`
                # may return a generator, and a generator runs its body at
                # iteration: listing it once the scopes had closed executed the
                # submission against the restored course loader, which downloads
                # and cannot reach the network here, and sent its output past the
                # capture buffer.
                predictions = list(benchmark.run(factory, resources, cases))
        if len(predictions) != len(cases):
            raise RuntimeError("Submission returned the wrong number of case outputs.")
    elif pathlib.Path("/tmp/cog-week3-payload.zip").exists():
        import os
        from cogworks_runner.week3_payload import decode_payload
        payload_id, showcase, cases = decode_payload(
            pathlib.Path("/tmp/cog-week3-payload.zip").read_bytes()
        )
        if payload_id != benchmark_id:
            raise RuntimeError("Staged benchmark payload does not match the job.")
        os.environ["COGWORKS_SHOWCASE"] = "1" if showcase else "0"
        buffer.write("student python {}\n".format(sys.version.split()[0]))
        if sys.version_info[:2] != (3, 8):
            raise RuntimeError(
                "Week 3 evaluation must run under Python 3.8; got {}".format(sys.version.split()[0])
            )
        benchmark = load_benchmark(benchmark_id)
        # Course artifacts load before any student code is imported, so a
        # missing or corrupt GloVe/COCO cache is unambiguously ours.
        resources = benchmark.model_factory()
        owner = "student"
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            factory, course_files = load_student(benchmark_id, "cogworks.submissions.v2")
            with course_files:
                # Materialized inside both scopes, not after them. `benchmark.run`
                # may return a generator, and a generator runs its body at
                # iteration: listing it once the scopes had closed executed the
                # submission against the restored course loader, which downloads
                # and cannot reach the network here, and sent its output past the
                # capture buffer.
                predictions = list(benchmark.run(factory, resources, cases))
        if len(predictions) != len(cases):
            raise RuntimeError("Submission returned the wrong number of component outputs.")
    elif pathlib.Path("/tmp/cog-v2-payload.zip").exists():
        from cogworks_runner.week2_payload import decode_cases
        from facenet_models import FacenetModel
        payload_id, cases = decode_cases(pathlib.Path("/tmp/cog-v2-payload.zip").read_bytes())
        if payload_id != benchmark_id:
            raise RuntimeError("Staged benchmark payload does not match the job.")
        benchmark = load_benchmark(benchmark_id)
        model = FacenetModel(device="cpu")
        owner = "student"
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            factory, course_files = load_student(benchmark_id, "cogworks.submissions.v2")
            with course_files:
                # Materialized inside both scopes, not after them. `benchmark.run`
                # may return a generator, and a generator runs its body at
                # iteration: listing it once the scopes had closed executed the
                # submission against the restored course loader, which downloads
                # and cannot reach the network here, and sent its output past the
                # capture buffer.
                predictions = list(benchmark.run(factory, model, cases))
        if len(predictions) != len(cases):
            raise RuntimeError("Submission returned the wrong number of scenario outputs.")
    else:
        inputs = json.loads(pathlib.Path("/tmp/cog-inputs.json").read_text(encoding="utf-8"))
        owner = "student"
        adapter, course_files = load_student(benchmark_id)
        predictor = getattr(adapter, "predict", adapter if callable(adapter) else None)
        if not callable(predictor):
            raise RuntimeError("Submission adapter must be callable or expose predict(inputs).")
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer), course_files:
            predictions = list(predictor(inputs))
        if len(predictions) != len(inputs):
            raise RuntimeError("Submission returned the wrong number of predictions.")
except Exception as error:
    # What raised and where, for the run page. The message alone read
    # "'NoneType' object is not subscriptable", with no class and no file,
    # when the line that raised was the benchmark's own replay (B-44), so the
    # team could not tell it was not theirs. Display only: student code can
    # forge any of this, which is why the controller never reads it to decide
    # whose fault the failure was.
    def _where(frame):
        path = pathlib.Path(frame.filename)
        if repo_root is not None and repo_root in path.parents:
            shown = path.relative_to(repo_root).as_posix()
        elif "site-packages" in path.parts:
            last = max(i for i, part in enumerate(path.parts) if part == "site-packages")
            shown = "/".join(path.parts[last + 1:])
        else:
            shown = path.name
        return "{}:{}, in {}".format(shown, frame.lineno, frame.name)

    # This script's own frames name nothing a reader can open.
    frames = [frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename != __file__]
    where = [_where(frames[-1])] if frames else []
    if repo_root is not None:
        theirs = [frame for frame in frames if repo_root in pathlib.Path(frame.filename).parents]
        if theirs and theirs[-1] is not frames[-1]:
            where.append(_where(theirs[-1]))
    # The record goes out before the log is written, so nothing about the log
    # can lose it.
    marker = "COG_ERROR" if owner == "student" else "COG_PLATFORM_ERROR"
    sys.stderr.write("{}: {}\n".format(marker, json.dumps({
        "type": type(error).__name__,
        "message": str(error)[:500],
        "where": where,
    })))
    # The log a successful run keeps, kept for a failed one too, with the
    # traceback last so the bounded buffer's tail holds it.
    buffer.write(traceback.format_exc())
    pathlib.Path("/tmp/cog-student.log").write_bytes(buffer.value().encode("utf-8", "replace"))
    raise SystemExit(2)
encoded = json.dumps(predictions).encode("utf-8")
# 8 MiB was sized when the Week 3 sandbox ran six cases with one retrieval
# case. The real evaluation tier has four, and each one returns the whole
# 700-image pool embedded again, so a correct run does not fit: measured on
# that tier with random float32, 16,214,347 bytes at the 200-d embedding the
# demo submission trains, and 41,318,368 bytes at 512-d. A valid submission was
# refused for returning a bad result, a message that names the student's code
# and spends one of their three official attempts.
#
# 64 MiB clears the 512-d measurement. It does not make the limit right: the
# four retrieval rungs differ only in query text, so three of those four
# image matrices are the same numbers sent again. Dropping them from the
# retrieval output would fit the original 8 MiB with room over, and that
# belongs to the benchmark's output contract, not here.
if len(encoded) > 64 * 1024 * 1024:
    raise RuntimeError("Submission predictions exceed the 64 MiB result limit.")
pathlib.Path("/tmp/cog-predictions.json").write_bytes(encoded)
# "replace": printed output can hold a lone surrogate, which strict UTF-8
# refuses, and Python 3.8's write_text takes no `errors`.
pathlib.Path("/tmp/cog-student.log").write_bytes(buffer.value().encode("utf-8", "replace"))
"""


def _refusal_from(sandbox) -> Optional[Dict[str, Any]]:
    """The verdict the prepare step wrote, if it wrote one.

    Absent whenever the failure was something other than "nothing here to
    score", which is most failures. A missing file is the normal case and not
    an error.
    """

    try:
        record = json.loads(sandbox.filesystem.read_text("/tmp/discovery.json"))
    except Exception:
        return None
    verdict = record.get("verdict") if isinstance(record, dict) else None
    if not isinstance(verdict, dict):
        return None
    coverage = verdict.get("coverage")
    skipped = coverage.get("skipped") if isinstance(coverage, dict) else None
    refusal = {
        "status": str(verdict.get("status", ""))[:40],
        "headline": str(verdict.get("headline", ""))[:600],
        "nextStep": str(verdict.get("nextStep", ""))[:600],
        "trace": [
            {
                "stage": str(step.get("stage", ""))[:60],
                "function": str(step.get("function", ""))[:200],
                "received": str(step.get("received", ""))[:200],
                "returned": str(step.get("returned", ""))[:200],
            }
            for step in (verdict.get("trace") or [])[:16]
            if isinstance(step, dict)
        ],
        # The three below are the rest of what the check already worked out
        # and used to leave in the sandbox. A refusal that names the step
        # which stalled and nothing else is true and thin: the modules that
        # could not be read, and the lines their own code raised on, are what
        # a team opens a file over. Caps match the protocol schema.
        "notes": [str(note)[:600] for note in (verdict.get("notes") or [])[:8]],
        "skipped": [
            {
                "module": str(entry.get("module", ""))[:200],
                "reason": str(entry.get("reason", ""))[:300],
                "owner": str(entry.get("owner", "theirs"))[:20],
            }
            for entry in (skipped or [])[:32]
            if isinstance(entry, dict)
        ],
        "errors": [
            {
                "file": str(error.get("file", ""))[:200],
                "line": int(error.get("line", 0) or 0),
                "function": str(error.get("function", ""))[:200],
                "message": str(error.get("message", ""))[:200],
            }
            for error in (verdict.get("errors") or [])[:16]
            if isinstance(error, dict)
        ],
    }
    return refusal if refusal["status"] and refusal["headline"] else None


def _event(job: Dict[str, Any], sequence: int, event_type: str, **fields: Any) -> Dict[str, Any]:
    return {
        "protocolVersion": "1",
        "eventId": "event_{}_{}_{}".format(job["runId"], sequence, int(time.time() * 1000)),
        "runId": job["runId"],
        "sequence": sequence,
        "occurredAt": int(time.time() * 1000),
        "type": event_type,
        **fields,
    }


def _post_event(job: Dict[str, Any], event: Dict[str, Any]) -> None:
    body = canonical_json(event)
    secret = os.environ["RUNNER_SIGNING_SECRET"]
    for attempt in range(3):
        timestamp = str(int(time.time()))
        request = urllib.request.Request(
            job["callback"]["url"],
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "User-Agent": RUNNER_USER_AGENT,
                "X-Cogworks-Timestamp": timestamp,
                "X-Cogworks-Key-Id": job["callback"]["keyId"],
                "X-Cogworks-Signature": "v1=" + signature(secret, timestamp, body),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                if response.status // 100 != 2:
                    raise RuntimeError("Portal rejected runner event.")
                return
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
            retry_after = float(error.headers.get("Retry-After", "0") or 0)
        except urllib.error.URLError:
            if attempt == 2:
                raise
            retry_after = 0
        time.sleep(max(retry_after, 0.25 * (2**attempt)))


def _outcome_key(job_id: str) -> str:
    """Where a finished job's terminal event lives.

    Beside the status rather than inside it. `job_store[jobId]` stays the
    plain word it has always been, so a runner rolled back to a build without
    any of this still reads its own entries and still refuses to run a job
    twice. A dict in that slot would have matched none of the old code's
    comparisons, and every completed job would have been scored again.
    """

    return "{}:outcome".format(job_id)


def _deliver_terminal(job: Dict[str, Any], outcome: Dict[str, Any]) -> None:
    """Send a stored terminal event, and record that it landed.

    The same event every time. It carries one eventId and one sequence number
    for its whole life, so the portal collapses a replay through the primary
    key on run_events rather than applying the result twice.
    """

    _post_event(job, outcome["event"])
    job_store[_outcome_key(job["jobId"])] = {**outcome, "delivered": True}


def _finish(job: Dict[str, Any], outcome: Dict[str, Any], status: str) -> None:
    """Record how a job ended, send it, and raise only if it did not land.

    Raising is the signal to this function's retry policy, so the rule has to
    be exact: a job raises when the portal has not heard its outcome, and
    returns in every other case. A job that reported a student's failure has
    done its work, and raising there would spend a container start on a retry
    with nothing to do.

    The outcome is written before the status word, so a reader that sees
    "completed" always finds the event beside it.
    """

    job_store[_outcome_key(job["jobId"])] = outcome
    job_store[job["jobId"]] = status
    if outcome.get("delivered"):
        return
    _deliver_terminal(job, outcome)


class LiveReporter:
    """Serializes idempotent runner callbacks and supplies real elapsed time."""

    def __init__(self, job: Dict[str, Any]) -> None:
        self.job = job
        self.started_at = int(time.time() * 1000)
        self.sequence = 0
        self.lock = threading.Lock()

    def event(self, event_type: str, **fields: Any) -> None:
        with self.lock:
            sequence = self.sequence
            self.sequence += 1
            _post_event(self.job, _event(self.job, sequence, event_type, **fields))

    def build(self, event_type: str, **fields: Any) -> Dict[str, Any]:
        """Claim this event's place in the sequence without sending it.

        For a terminal event, which is stored before it is sent so that a
        delivery which never lands can be replayed instead of lost.
        """

        with self.lock:
            sequence = self.sequence
            self.sequence += 1
            return _event(self.job, sequence, event_type, **fields)

    def status(
        self,
        status: str,
        current: int | None = None,
        total: int | None = None,
    ) -> None:
        fields: Dict[str, Any] = {
            "status": status,
            "elapsedMs": max(0, int(time.time() * 1000) - self.started_at),
        }
        if current is not None and total is not None:
            fields["progress"] = {"current": current, "total": total, "unit": "cases"}
        self.event("status", **fields)


class StatusHeartbeat:
    def __init__(
        self,
        reporter: LiveReporter,
        status: str,
        current: int | None = None,
        total: int | None = None,
    ) -> None:
        self.reporter = reporter
        self.status = status
        self.current = current
        self.total = total
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self.stopped.wait(2.0):
            self.reporter.status(self.status, self.current, self.total)

    def __enter__(self) -> "StatusHeartbeat":
        self.thread.start()
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.stopped.set()
        self.thread.join(timeout=1.0)


def _load_benchmark(job: Dict[str, Any]) -> Any:
    from cogbench.plugins import load_benchmark

    benchmark = load_benchmark(job["benchmark"]["id"])
    expected = {
        "benchmark_id": job["benchmark"]["id"],
        "benchmark_version": job["benchmark"]["version"],
        "contract_version": job["benchmark"]["contractVersion"],
        "plugin_version": job["benchmark"]["pluginVersion"],
        "scorer_version": job["benchmark"]["scorerVersion"],
    }
    for attribute, value in expected.items():
        if getattr(benchmark, attribute, None) != value:
            raise RunnerFailure(
                "data_download",
                "contract_check",
                "Trusted benchmark plugin version does not match the run job.",
                True,
            )
    return benchmark


def _cases(job: Dict[str, Any], benchmark: Any) -> Tuple[List[Any], List[Any]]:
    if job["mode"] == "practice":
        cases = list(benchmark.public_cases())
    else:
        path = (
            Path("/hidden")
            / job["benchmark"]["id"]
            / (job["benchmark"]["datasetVersion"] + ".json")
        )
        if not path.exists():
            raise RunnerFailure(
                "provider",
                "evaluating",
                "Official evaluation dataset is not configured.",
                True,
            )
        try:
            cases = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise RunnerFailure(
                "provider",
                "evaluating",
                "Official evaluation dataset is unreadable.",
                True,
            ) from error
    return [case["input"] for case in cases], [case["expected"] for case in cases]


def _v2_cases(job: Dict[str, Any], benchmark: Any) -> List[Any]:
    if job["mode"] == "practice":
        try:
            return list(benchmark.load_cases("evaluation"))
        except Exception as error:
            raise RunnerFailure(
                "provider",
                "evaluating",
                "Public Week 2 data could not be prepared.",
                True,
            ) from error
    from cogworks_runner.week2_payload import (
        attach_clustering_labels,
        attach_recognition_gold,
        decode_cases,
    )

    root = Path("/hidden") / job["benchmark"]["id"] / job["benchmark"]["datasetVersion"]
    try:
        payload_bytes = (root / "payload.zip").read_bytes()
        payload_id, cases = decode_cases(payload_bytes)
        if payload_id != job["benchmark"]["id"]:
            raise ValueError("Official payload track mismatch.")
        # Both tracks now keep their answers in expected.json beside the
        # payload, read here and never copied into a sandbox. Clustering's file
        # holds the cluster labels. Recognition's holds the query grouping:
        # which query photos belong to which enrolled person, and which belong
        # to the stranger. That grouping used to travel inside payload.zip,
        # where the sandbox could read it and rebuild every expected label
        # without opening a single image.
        expected = json.loads((root / "expected.json").read_text(encoding="utf-8"))
        if payload_id == "vision-clustering":
            cases = attach_clustering_labels(cases, expected)
        else:
            cases = attach_recognition_gold(payload_bytes, expected)
        return cases
    except (OSError, ValueError, KeyError) as error:
        raise RunnerFailure(
            "data_download",
            "evaluating",
            "Official Week 2 data is missing or failed integrity validation.",
            True,
        ) from error


def _week3_cases(job: Dict[str, Any], benchmark: Any) -> List[Any]:
    """Gold-attached cases for scoring; the sandbox payload strips gold."""

    if job["mode"] == "practice":
        try:
            return list(benchmark.load_cases("evaluation"))
        except Exception as error:
            raise RunnerFailure(
                "data_download",
                "evaluating",
                "Public Week 3 data could not be prepared.",
                True,
            ) from error
    from language_search_benchmark.datasets import attach_gold

    from cogworks_runner.week3_payload import decode_payload

    root = Path("/hidden") / job["benchmark"]["id"] / job["benchmark"]["datasetVersion"]
    try:
        payload_id, _showcase, cases = decode_payload((root / "payload.zip").read_bytes())
        if payload_id != job["benchmark"]["id"]:
            raise ValueError("Official payload benchmark mismatch.")
        gold = json.loads((root / "gold.json").read_text(encoding="utf-8"))
        return attach_gold(
            cases,
            text_group_rows=gold["text_group_rows"],
            retrieval_gold_rows=gold["retrieval_gold_rows"],
            search_gold_image_ids=gold["search_gold_image_ids"],
        )
    except (OSError, ValueError, KeyError) as error:
        raise RunnerFailure(
            "data_download",
            "evaluating",
            "Official Week 3 data is missing or failed integrity validation.",
            True,
        ) from error


def _week1_manifest(job: Dict[str, Any]) -> Dict[str, Any]:
    """The manifest whose seeds the sandbox renders the corpus from.

    Practice runs read the manifest shipped inside the plugin. Official runs
    read one from the hidden volume, because a manifest that ships with the
    package is one a student can read.
    """

    from audio_identification_benchmark.datasets import load_manifest

    if job["mode"] == "practice":
        try:
            return load_manifest("evaluation")
        except Exception as error:
            raise RunnerFailure(
                "data_download",
                "evaluating",
                "Public Week 1 data could not be prepared.",
                True,
            ) from error
    root = Path("/hidden") / job["benchmark"]["id"] / job["benchmark"]["datasetVersion"]
    try:
        return json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RunnerFailure(
            "data_download",
            "evaluating",
            "Official Week 1 data is missing or failed integrity validation.",
            True,
        ) from error


def _week1_cases(job: Dict[str, Any], manifest: Dict[str, Any]) -> List[Any]:
    """Gold-bearing cases for scoring; the sandbox payload strips gold.

    The controller renders the corpus a second time rather than reusing the
    sandbox's copy, so the numbers it scores against never travelled through
    the sandbox. Rendering is deterministic and sha256-verified, so the two
    copies are the same audio by construction.
    """

    from audio_identification_benchmark.datasets import materialize_cases

    try:
        return list(materialize_cases(manifest))
    except Exception as error:
        raise RunnerFailure(
            "data_download",
            "evaluating",
            "Week 1 corpus did not match its pinned digests.",
            True,
        ) from error


def _sandbox_image(job: Dict[str, Any]) -> Any:
    """Reference this benchmark's sandbox image.

    This runs inside the container, so it must not touch `week3_image` or
    `benchmark_image` directly; resolving those definitions needs the local
    repository. Staging references the name `tools/deploy.py` published at
    deploy time. Production references the immutable id captured into its
    controller, because publishing a name is a staging release step and a
    name resolved here would follow it.
    """
    name = {
        "language-search": WEEK3_SANDBOX_IMAGE,
        "audio-identification": WEEK1_SANDBOX_IMAGE,
    }.get(job["benchmark"]["id"], BENCHMARK_SANDBOX_IMAGE)
    if DEPLOYMENT.is_production:
        return modal.Image.from_id(DEPLOYMENT.sandbox_image_ids[name])
    return modal.Image.from_name(name)


def _student_python(job: Dict[str, Any]) -> str:
    """Use the same interpreter selection as the release probe."""

    return student_python(job["benchmark"]["id"], ENVIRONMENT.PY38_VENV)


def _prepare(job: Dict[str, Any], reporter: LiveReporter) -> Tuple[str, Dict[str, Any]]:
    sandbox = None
    try:
        callback = urlsplit(job["callback"]["url"])
        portal_origin = "{}://{}".format(callback.scheme, callback.netloc)
        timestamp = str(int(time.time()))
        weight_requests = []
        for weight in job["weights"]:
            pathname = "/api/v1/runs/{}/weights/{}".format(
                job["runId"], quote(weight["path"], safe="/")
            )
            weight_requests.append({
                "path": weight["path"],
                "size": weight["size"],
                "sha256": weight["sha256"],
                "url": portal_origin + pathname,
                "headers": {
                    "X-Cogworks-Key-Id": job["callback"]["keyId"],
                    "X-Cogworks-Timestamp": timestamp,
                    "X-Cogworks-Signature": "v1=" + signature(
                        os.environ["RUNNER_SIGNING_SECRET"],
                        timestamp,
                        pathname.encode("utf-8"),
                    ),
                },
            })
        allowlist = [
            "api.github.com",
            "codeload.github.com",
            "pypi.org",
            "files.pythonhosted.org",
        ]
        if callback.hostname and callback.hostname not in allowlist:
            allowlist.append(callback.hostname)
        image = _sandbox_image(job)
        sandbox = modal.Sandbox.create(
            image=image,
            app=app,
            cpu=(0.5, job["runtime"]["cpu"]),
            memory=(512, job["runtime"]["memoryMb"]),
            timeout=job["runtime"]["timeoutSeconds"],
            outbound_domain_allowlist=allowlist,
        )
        # Modal 1.5.5 rejects direct hydration of a named image. Sandbox.create
        # resolves this same handle, so its base image id is available only now.
        base_image_id = image.object_id
        reporter.status("preparing")
        # Only this pristine image is platform-owned. Neither the archive nor
        # an installer has run. Preserve the observation in controller memory;
        # reading it back after student code runs would cross the trust boundary.
        pristine = sandbox.exec(
            _student_python(job), "-m", "cogworks_runner.prepared_environment",
            job["benchmark"]["id"],
        )
        pristine.wait()
        if pristine.returncode != 0:
            raise RunnerFailure(
                "provider", "preparing",
                "The published environment cannot establish its execution contract.", True,
            )
        try:
            observation = json.loads(pristine.stdout.read())
            validate_observation(job, observation)
        except (ValueError, TypeError) as error:
            raise RunnerFailure(
                "provider", "preparing",
                "The published environment does not satisfy the current execution contract.", True,
            ) from error
        sandbox.filesystem.write_text(PREPARE_SCRIPT, "/tmp/cog-prepare.py")
        reporter.status("installing")
        with StatusHeartbeat(reporter, "installing"):
            process = sandbox.exec(
                _student_python(job),
                "/tmp/cog-prepare.py",
                job["source"]["archiveUrl"],
                job["benchmark"]["id"],
                job["benchmark"]["contractVersion"],
                json.dumps(weight_requests, separators=(",", ":")),
                # Modal decodes text streams as strict UTF-8, so one invalid
                # byte from a team's install would raise on read and be filed
                # as a provider failure. Decode here and keep the message.
                text=False,
            )
            process.wait()
        if process.returncode != 0:
            stderr_text = process.stderr.read().decode("utf-8", "replace")
            # The exception message, not the tail of the traceback. Slicing the
            # last 240 characters produced details like "line 144, in <module>"
            # -- the traceback's own last frame, which names our sandbox script
            # and tells a student nothing. The message is on the final
            # non-indented line, which is where Python puts it.
            detail = _last_error_line(stderr_text)
            try:
                refusal = _refusal_from(sandbox)
            except Exception:
                # Malformed student-writable advice cannot turn a failed
                # installation into a refundable controller exception.
                refusal = None
            normalized = (detail + " " + stderr_text[-400:]).lower()
            if "source archive" in normalized:
                raise RunnerFailure("repository_fetch", "preparing", detail, False)
            if "weight file" in normalized:
                raise RunnerFailure("data_download", "preparing", detail, False)
            # These messages select advice, never refund eligibility: the
            # installation and discovery process can execute student code.
            # Earlier pip output can mention adapters even when installation
            # failed, so only the final error detail identifies discovery.
            detail_normalized = detail.lower()
            if ("no adapter found" in detail_normalized or "entry point" in detail_normalized
                    or "the search for your code could not finish" in detail_normalized):
                raise RunnerFailure(
                    "adapter_missing", "contract_check", detail, False, refusal
                )
            raise RunnerFailure("dependency_install", "installing", detail or "Install failed.", False)
        reporter.status("contract_check")
        snapshot_id = sandbox.snapshot_filesystem().object_id
        return snapshot_id, bind_environment(job, observation, snapshot_id, base_image_id)
    except RunnerFailure:
        raise
    except Exception as error:
        raise RunnerFailure(
            "provider",
            "preparing",
            "Preparation provider failed: {}".format(str(error)[:180]),
            True,
        ) from error
    finally:
        if sandbox is not None:
            sandbox.terminate()


#: Filled by the controller when an evaluate sandbox reported which of the
#: team's functions it ran. A module-level box rather than a return value,
#: because four evaluators would otherwise each grow a third element for
#: something only one of them can produce.
_WIRING: List[Dict[str, Any]] = []


def _collect_wiring(sandbox) -> None:
    """Read the wiring the evaluate step wrote, if it wrote one.

    Absent for a repository that declared its own submission, which is the
    normal case for the reference examples and the intended case for the
    template. Absent is not an error and is not reported as one.
    """

    _WIRING.clear()
    try:
        steps = json.loads(sandbox.filesystem.read_text("/tmp/cog-wiring.json"))
    except Exception:
        return
    if not isinstance(steps, list):
        return
    # Clipped to WiredStepSchema in packages/contracts/src/protocol.ts. The
    # portal validates the completed event as one object, so a step past those
    # lengths costs the run rather than the panel it draws, and nothing
    # upstream bounds them: `function` is `module.function` as it appears in
    # the team's repository, and this file sits on a filesystem their code runs
    # on after the evaluate step writes it.
    for step in steps[:16]:
        if not isinstance(step, dict):
            continue
        stage = step.get("stage")
        function = step.get("function")
        if not (isinstance(stage, str) and stage and isinstance(function, str) and function):
            continue
        kept = {"stage": stage[:60], "function": function[:200]}
        for field in ("received", "returned"):
            value = step.get(field)
            if isinstance(value, str):
                kept[field] = value[:200]
        _WIRING.append(kept)


def _evaluate(job: Dict[str, Any], snapshot_id: str, inputs: List[Any]) -> Tuple[List[Any], str]:
    sandbox = None
    try:
        sandbox = modal.Sandbox.create(
            image=modal.Image.from_id(snapshot_id),
            app=app,
            cpu=(0.5, job["runtime"]["cpu"]),
            memory=(512, job["runtime"]["memoryMb"]),
            timeout=job["runtime"]["timeoutSeconds"],
            block_network=True,
        )
        sandbox.filesystem.write_text(json.dumps(inputs), "/tmp/cog-inputs.json")
        sandbox.filesystem.write_text(EVALUATE_SCRIPT, "/tmp/cog-evaluate.py")
        started = time.time()
        process = sandbox.exec(
            "python",
            "/tmp/cog-evaluate.py",
            job["benchmark"]["id"],
            str(job["runtime"]["maxOutputBytes"]),
            # Strict UTF-8 text mode turns one invalid byte into a provider failure.
            text=False,
        )
        process.wait()
        if process.returncode != 0:
            raise _evaluation_failure(job, sandbox, process, started)
        predictions = load_predictions(
            sandbox.filesystem.read_text("/tmp/cog-predictions.json")
        )
        _collect_wiring(sandbox)
        return list(predictions), sandbox.filesystem.read_text("/tmp/cog-student.log")
    except RunnerFailure:
        raise
    except Exception as error:
        normalized = str(error).lower()
        if "timeout" in normalized or "timed out" in normalized:
            raise RunnerFailure("timeout", "evaluating", "Evaluation timed out.", False) from error
        if "memory" in normalized or "oom" in normalized:
            raise RunnerFailure("memory_limit", "evaluating", "Evaluation exceeded memory.", False) from error
        raise RunnerFailure(
            "provider",
            "evaluating",
            "Evaluation provider failed: {}".format(str(error)[:180]),
            True,
        ) from error
    finally:
        if sandbox is not None:
            sandbox.terminate()


def _evaluate_v2(
    job: Dict[str, Any], snapshot_id: str, cases: List[Any]
) -> Tuple[List[Any], str]:
    from cogworks_runner.week2_payload import encode_cases

    # The recognition payload hands the sandbox its query images shuffled into
    # two unlabelled batches, so the predictions come back in that order rather
    # than in the lifecycle shape score() reads. These plans are the only map
    # back. They stay in this process, and keeping them here is what keeps the
    # grouping out of the zip the sandbox reads. Clustering returns no plans.
    payload, plans = encode_cases(job["benchmark"]["id"], cases)
    sandbox = None
    try:
        sandbox = modal.Sandbox.create(
            image=modal.Image.from_id(snapshot_id),
            app=app,
            cpu=(0.5, job["runtime"]["cpu"]),
            memory=(512, job["runtime"]["memoryMb"]),
            timeout=job["runtime"]["timeoutSeconds"],
            block_network=True,
        )
        sandbox.filesystem.write_bytes(payload, "/tmp/cog-v2-payload.zip")
        sandbox.filesystem.write_text(EVALUATE_SCRIPT, "/tmp/cog-evaluate.py")
        started = time.time()
        process = sandbox.exec(
            "python",
            "/tmp/cog-evaluate.py",
            job["benchmark"]["id"],
            str(job["runtime"]["maxOutputBytes"]),
            # Strict UTF-8 text mode turns one invalid byte into a provider failure.
            text=False,
        )
        process.wait()
        if process.returncode != 0:
            raise _evaluation_failure(job, sandbox, process, started)
        predictions = load_predictions(
            sandbox.filesystem.read_text("/tmp/cog-predictions.json")
        )
        _collect_wiring(sandbox)
        log = sandbox.filesystem.read_text("/tmp/cog-student.log")
        # Un-permuted here rather than after `check_predictions`, because that
        # check reads the lifecycle field names ("known", "unknown_before",
        # "post_enrollment") and those only exist once the shuffle is undone.
        # The consequence is that the two-batch shape the sandbox actually
        # wrote is only ever visible inside this call, so that is where it is
        # checked. See `restore_v2_predictions` for what the coercion costs.
        predictions = restore_v2_predictions(list(predictions), plans)
        return predictions, log
    except RunnerFailure:
        raise
    except Exception as error:
        normalized = str(error).lower()
        if "timeout" in normalized or "timed out" in normalized:
            raise RunnerFailure("timeout", "evaluating", "Evaluation timed out.", False) from error
        if "memory" in normalized or "oom" in normalized:
            raise RunnerFailure("memory_limit", "evaluating", "Evaluation exceeded memory.", False) from error
        raise RunnerFailure(
            "provider", "evaluating", "Evaluation provider failed.", True
        ) from error
    finally:
        if sandbox is not None:
            sandbox.terminate()


def _evaluate_week3(
    job: Dict[str, Any], snapshot_id: str, cases: List[Any]
) -> Tuple[List[Any], str]:
    """Like _evaluate_v2 but with the Week 3 payload, which is gold-free by
    construction even for practice runs; the controller re-attaches gold to
    its own copy of the cases for scoring."""

    from cogworks_runner.week3_payload import encode_payload

    sandbox = None
    try:
        sandbox = modal.Sandbox.create(
            image=modal.Image.from_id(snapshot_id),
            app=app,
            cpu=(0.5, job["runtime"]["cpu"]),
            memory=(512, job["runtime"]["memoryMb"]),
            timeout=job["runtime"]["timeoutSeconds"],
            block_network=True,
        )
        sandbox.filesystem.write_bytes(
            encode_payload(
                job["benchmark"]["id"], cases, showcase=job["mode"] == "practice"
            ),
            "/tmp/cog-week3-payload.zip",
        )
        sandbox.filesystem.write_text(EVALUATE_SCRIPT, "/tmp/cog-evaluate.py")
        started = time.time()
        process = sandbox.exec(
            WEEK3_STUDENT_PYTHON,
            "/tmp/cog-evaluate.py",
            job["benchmark"]["id"],
            str(job["runtime"]["maxOutputBytes"]),
            # Strict UTF-8 text mode turns one invalid byte into a provider failure.
            text=False,
        )
        process.wait()
        if process.returncode != 0:
            # _week3_cases already decoded and validated the same artifacts
            # in this process, before the sandbox ran.
            raise _evaluation_failure(job, sandbox, process, started)
        predictions = load_predictions(
            sandbox.filesystem.read_text("/tmp/cog-predictions.json")
        )
        _collect_wiring(sandbox)
        return list(predictions), sandbox.filesystem.read_text("/tmp/cog-student.log")
    except RunnerFailure:
        raise
    except Exception as error:
        normalized = str(error).lower()
        if "timeout" in normalized or "timed out" in normalized:
            raise RunnerFailure("timeout", "evaluating", "Evaluation timed out.", False) from error
        if "memory" in normalized or "oom" in normalized:
            raise RunnerFailure("memory_limit", "evaluating", "Evaluation exceeded memory.", False) from error
        raise RunnerFailure(
            "provider", "evaluating", "Evaluation provider failed.", True
        ) from error
    finally:
        if sandbox is not None:
            sandbox.terminate()


def _evaluate_week1(
    job: Dict[str, Any], snapshot_id: str, manifest: Dict[str, Any]
) -> Tuple[List[Any], str]:
    """Like _evaluate_week3, but the payload is the manifest, not the audio.

    The sandbox renders its own corpus from the seeds and verifies each
    signal's sha256 before student code runs, so the ~240 MB of float32 the
    evaluation tier scores over never crosses this boundary.
    """

    from cogworks_runner.week1_payload import encode_payload

    sandbox = None
    try:
        sandbox = modal.Sandbox.create(
            image=modal.Image.from_id(snapshot_id),
            app=app,
            cpu=(0.5, job["runtime"]["cpu"]),
            memory=(512, job["runtime"]["memoryMb"]),
            timeout=job["runtime"]["timeoutSeconds"],
            block_network=True,
        )
        sandbox.filesystem.write_bytes(
            encode_payload(
                job["benchmark"]["id"], manifest, showcase=job["mode"] == "practice"
            ),
            "/tmp/cog-week1-payload.zip",
        )
        sandbox.filesystem.write_text(EVALUATE_SCRIPT, "/tmp/cog-evaluate.py")
        started = time.time()
        process = sandbox.exec(
            WEEK1_STUDENT_PYTHON,
            "/tmp/cog-evaluate.py",
            job["benchmark"]["id"],
            str(job["runtime"]["maxOutputBytes"]),
            # Strict UTF-8 text mode turns one invalid byte into a provider failure.
            text=False,
        )
        process.wait()
        if process.returncode != 0:
            # _week1_cases renders the same corpus from the same seeds in this
            # process and verifies it against the same pinned digests, before
            # the sandbox starts, so a corpus fault is caught there by a party
            # the submission cannot reach.
            raise _evaluation_failure(
                job, sandbox, process, started,
                # Measured on carti4ce/week1_capstone; see `_timed_out`.
                "Every song has to be enrolled and every query answered inside "
                "that window; a database that is re-read or rewritten once per "
                "song or per query grows with the catalog and will not fit.",
            )
        predictions = load_predictions(
            sandbox.filesystem.read_text("/tmp/cog-predictions.json")
        )
        _collect_wiring(sandbox)
        return list(predictions), sandbox.filesystem.read_text("/tmp/cog-student.log")
    except RunnerFailure:
        raise
    except Exception as error:
        normalized = str(error).lower()
        if "timeout" in normalized or "timed out" in normalized:
            raise RunnerFailure("timeout", "evaluating", "Evaluation timed out.", False) from error
        if "memory" in normalized or "oom" in normalized:
            raise RunnerFailure("memory_limit", "evaluating", "Evaluation exceeded memory.", False) from error
        raise RunnerFailure(
            "provider", "evaluating", "Evaluation provider failed.", True
        ) from error
    finally:
        if sandbox is not None:
            sandbox.terminate()


def _evaluation_failure(
    job: Dict[str, Any], sandbox: Any, process: Any, started: float, timeout_advice: str = ""
) -> RunnerFailure:
    """The failure for an evaluation process that exited nonzero, in every lane.

    One function because each lane used to carry its own copy, and the Week 2
    copy never checked the clock, so a vision run killed at its budget was
    reported as an exception (B-11).

    Only two outcomes, and no platform-fault branch: see
    `_platform_owned_evaluation_failure`. A timeout is decided from elapsed
    time and the return code. Anything else is `student_runtime`, the
    category for "the evaluation raised", which the portal words without
    claiming whose code it was, because nothing here can establish that.
    """

    if _timed_out(job, started, process.returncode):
        return RunnerFailure(
            "timeout",
            "evaluating",
            "Evaluation ran past its {} second budget and was stopped. {}".format(
                job["runtime"]["timeoutSeconds"], timeout_advice
            ).strip(),
            False,
        )
    try:
        # Written by the sandbox's own failure handler; absent when the
        # process was killed or exited before reaching it.
        log = sandbox.filesystem.read_text("/tmp/cog-student.log")
    except Exception:
        log = None
    detail = _last_error_line(process.stderr.read().decode("utf-8", "replace"))
    return RunnerFailure("student_runtime", "evaluating", detail, False, log=log)


def _platform_owned_evaluation_failure() -> None:
    """Why no evaluation failure is ever attributed to the platform from here.

    The sandbox used to say. It wrote `COG_PLATFORM_ERROR:` to stderr when it
    failed before importing student code, and the controller read that. The
    comment above the read said the marker could not be forged because only
    the message text was student-controlled. That was wrong, and measurably:
    `contextlib.redirect_stderr` rebinds the `sys.stderr` object and does not
    touch file descriptor 2, so three lines inside any student module

        import os
        os.write(2, b"COG_PLATFORM_ERROR: FaceNet cache validation failed")

    put the marker on the pipe the controller reads, and the run page blamed
    our model cache.

    The exit code is no better: `os._exit` beats the `SystemExit(2)` the script
    would otherwise raise. Once student code is running in a process, nothing
    that process emits is evidence about us. That is the rule, and it is why
    this is not fixed by a harder-to-forge channel.

    Saved-environment compatibility is checked separately against the retained
    pre-install observation. It proves provisioning, not that installation left
    those modules intact. Never replace it with a read from the restored image.

    The conditions the old marker reported are checked outside student execution:

      _week1_cases   re-renders the corpus from its seeds and checks it
                     against the same pinned sha256 digests
      _week3_cases   decodes and validates the same course artifacts
      _v2_cases      decodes and validates the payload
      image_bake     downloads the FaceNet checkpoint under a sha256 lock at
                     image build time, so a cache fault at evaluation would
                     mean the image did not build

    The remaining ways a run can fail through no fault of the submission are
    the ones the controller observes
    from outside: a process killed for time or memory, which `_timed_out`
    decides from elapsed seconds and the return code, and provider faults,
    which surface as exceptions here rather than as text from in there.

    Not a real function. Somewhere to put the reasoning, referenced from each
    place that would otherwise look like an oversight.
    """


def _timed_out(job: Dict[str, Any], started: float, returncode: int) -> bool:
    """Whether the sandbox killed the process for exceeding its wall clock.

    Modal enforces the sandbox timeout by killing the process, and a killed
    process reports a nonzero returncode with no traceback -- identical, from
    here, to a crash. Reported as a crash it becomes `student_runtime`, which
    tells the team "Evaluation failed." with nothing to act on; a timeout is
    its own category, and the right message names the budget they exceeded.

    Measured: `carti4ce/week1_capstone` reached 999 s against a 900 s budget on
    the evaluation corpus, because its `database.add` rewrites the whole pickle
    per song and `query_details` reloads it per query, so its cost grows with
    the catalog rather than with the clip.

    Two signals, either sufficient. Elapsed time at or past the budget is the
    reliable one. SIGKILL surfacing as -9 or 137 is the corroborating one, kept
    because a process killed slightly early should still read as a timeout.
    """

    budget = float(job["runtime"]["timeoutSeconds"])
    if time.time() - started >= budget * 0.95:
        return True
    # No stderr check. A third rung read "killed" near the end of stderr,
    # which the submission writes, and once every lane shared this check a
    # fast `raise RuntimeError("killed")` was reported as a timeout.
    return returncode in (-9, 137, -15, 143)


def _last_error_line(value: str) -> str:
    """The one sentence worth showing, out of a sandbox's stderr.

    Two shapes arrive here. The evaluate script marks its own failures with
    `COG_ERROR:` and a JSON record of the exception's class, message and
    where it was raised. The prepare script does not: it raises, and Python
    prints a traceback.

    For a traceback, the message is the final line that is not indented and
    not a `File "..."` frame -- `RuntimeError: No adapter found in ...`. Taking
    the last N characters instead yields `line 144, in <module>`, which names
    our sandbox script and tells a student nothing; that is what this function
    exists to avoid.
    """

    lines = [line for line in value.splitlines() if line.strip()]
    if not lines:
        return "The run failed before producing a result."

    stripped = lines[-1].strip()
    if stripped.startswith("COG_ERROR:"):
        marked = stripped[len("COG_ERROR:"):].strip()
        try:
            record = json.loads(marked)
        except ValueError:
            record = None
        if not isinstance(record, dict):
            # Student code shares this pipe, so the last line can be anything.
            return _fit(marked, DETAIL_LIMIT)
        # Student code can write this line, so any shape can arrive. A
        # malformed one must not raise: the lane's handler would then report
        # the platform as the cause.
        places = record.get("where")
        where = [p for p in places if isinstance(p, str) and p][:2] if isinstance(places, list) else []
        located = "\n".join(
            _fit(("at " if index == 0 else "called from ") + place, 100)
            for index, place in enumerate(where)
        )
        # The class stays here, unlike in a prepare traceback below: this one
        # was raised while evaluating, and `TypeError` against `KeyError` is
        # half of what the reader needs.
        kind, message = str(record.get("type") or ""), str(record.get("message") or "")
        said = "{}: {}".format(kind, message) if kind and message else kind or message
        if not located:
            return _fit(said, DETAIL_LIMIT)
        # The place is budgeted first: a long message is cut before the line
        # that says which file to open.
        return _fit(said, DETAIL_LIMIT - _receiver_units(located) - 1) + "\n" + located

    # Walk back to the last unindented line: Python puts `Type: message`
    # there, and every traceback frame above it is indented.
    for line in reversed(lines):
        if line[:1].strip() and not line.lstrip().startswith("File \""):
            text = line.strip()
            # Drop the exception class, which is our vocabulary, and keep the
            # message, which was written for the reader.
            if ": " in text and text.split(": ", 1)[0].isidentifier():
                text = text.split(": ", 1)[1]
            if text and not text.startswith("Traceback"):
                return _fit(text, DETAIL_LIMIT)
    return "The student process exited before producing a valid result."


def _wire_log(job: Dict[str, Any], log: Optional[str]) -> Optional[str]:
    """A practice run's log as the event carries it; official runs send none.

    Bounded in the receiver's units. A slice by code points let an astral
    character count twice against `protocol.ts`'s cap, which answers 400 and
    loses the whole terminal event rather than the end of the log.
    """

    if job["mode"] != "practice" or log is None:
        return None
    if _receiver_units(log) <= LOG_LIMIT:
        return log
    # Head and tail, as the sandbox's buffer keeps them: a failed run's
    # traceback is at the end, and a prefix alone dropped it.
    marker = "\n[log shortened to fit]\n"
    half = (LOG_LIMIT - len(marker)) // 2
    return _take_units(log, half)[0] + marker + _take_units(log[::-1], half)[0][::-1]


def _primary_for_run(benchmark) -> str:
    """The primary metric for the run just scored.

    A plugin may override its class-level `primary_metric` per run. Week 3
    withholds `overall` when the image side was never measured (no trained
    weights in the repository) and names `text_mrr`; scoring a run under a
    primary that is not in the metrics would fail the contract check and
    hide the text score that was measured.
    """

    return str(getattr(benchmark, "primary_metric_for_run", None) or benchmark.primary_metric)


def _v2_metrics(benchmark: Any, outputs: List[Any], cases: List[Any]) -> Tuple[List[Any], List[str]]:
    from cogbench.models import Metric

    labels = {
        "known_identification": "Known identification",
        "unknown_rejection_recall": "Unknown rejection recall",
        "post_enrollment_accuracy": "Post-enrollment accuracy",
        "unknown_lifecycle": "Unknown lifecycle",
        "recognition_score": "Recognition score",
        "clustering_pairwise_f1": "Pairwise F1",
        "adjusted_rand_index": "Adjusted Rand index",
    }
    # Newer plugins carry their own presentation; Week 2 predates this.
    labels.update(getattr(benchmark, "metric_labels", {}))
    lower_is_better = getattr(benchmark, "lower_is_better", ())
    # What each number means, in the course's vocabulary. Absent on plugins
    # that predate it, which is why this reads as a plain dict lookup rather
    # than a required attribute.
    help_text = getattr(benchmark, "metric_help", {})
    # What kind of number each one is, and what it belongs beside. A plugin
    # that declares neither gets today's rendering: one row per metric, with
    # an arrow saying which direction is better.
    #
    # That arrow is an assertion about the submission, and it is false on a
    # floor. Week 3 publishes three floors and drew "higher is better" on all
    # of them, which reads as advice to raise a number the student does not
    # control. `metric_roles` is how a benchmark says so.
    roles = getattr(benchmark, "metric_roles", {})
    relations = getattr(benchmark, "metric_relations", {})
    scores = benchmark.score(outputs, cases)
    metrics = [
        Metric(
            key=key,
            label=labels.get(key, key.replace("_", " ").title()),
            value=float(value),
            unit=None,
            # A floor has no direction of better, so it does not get an
            # arrow at all; the renderer reads the role and draws it as the
            # scale of the metric it belongs to.
            higher_is_better=key not in lower_is_better,
            primary=key == _primary_for_run(benchmark),
            # Four for the primary, three for the rest; runner.py says why, and
            # local and hosted must print the same digits for the same score.
            precision=4 if key == _primary_for_run(benchmark) else 3,
            help=help_text.get(key),
            role=roles.get(key),
            relates_to=relations.get(key),
        )
        for key, value in scores.items()
    ]
    return metrics, list(getattr(benchmark, "last_diagnostics", []))


def _sweep_wire(benchmark):
    """The plugin's difficulty sweep, in the shape the protocol expects.

    A plugin publishes `last_sweep` after `score()` when its benchmark has a
    difficulty knob worth turning; the rest leave the attribute absent and get
    `None` here. `sweep_axis_label` names the knob in the course's own words,
    since the run page draws an axis it cannot otherwise name.

    Fewer than two points is not a curve, and one point drawn as a curve would
    claim a trend from a single measurement.
    """

    points = getattr(benchmark, "last_sweep", None) or []
    if len(points) < 2:
        return None
    # Each benchmark names its own knob, so read the keys the plugin declares
    # rather than Week 1's. A plugin that grew a sweep without declaring them
    # gets no curve instead of a wrong one.
    x_key = getattr(benchmark, "sweep_x_key", None)
    y_key = getattr(benchmark, "sweep_y_key", None)
    if not x_key or not y_key:
        return None
    # An optional per-point name, for a sweep whose x is an ordering rather
    # than a quantity. Week 3's rungs run from the caption unchanged to the
    # furthest rewrite, so the x values are 0 through 3 and mean nothing on
    # their own; the run page prints the endpoint labels and reads them to a
    # screen reader, which would otherwise say "from 0.95 at 0 to 0.03 at 3".
    # Absent on Week 1, whose x is a real count of songs and reads correctly
    # as itself.
    label_key = getattr(benchmark, "sweep_label_key", None)
    try:
        wire = []
        for point in points[:24]:
            entry = {"x": float(point[x_key]), "y": float(point[y_key])}
            if label_key and point.get(label_key) is not None:
                entry["label"] = str(point[label_key])[:40]
            wire.append(entry)
    except (KeyError, TypeError, ValueError):
        return None
    return {
        "axis": getattr(benchmark, "sweep_axis_label", "difficulty"),
        # Producer validators check explicit curve metrics before release.
        # Otherwise preserve the primary metric selected for this run.
        "metric": getattr(benchmark, "sweep_metric", None) or _primary_for_run(benchmark),
        "points": wire,
    }


@app.function(
    image=controller_image,
    secrets=[runner_secret],
    volumes={"/hidden": hidden_mount},
    timeout=3_600,
    # Modal's own retry policy is the mechanism that replays an outcome the
    # portal never heard. `_finish` raises when, and only when, a terminal
    # event failed to land, so a retry is always a redelivery and never a
    # second scoring run: the guard below returns before any work. Storing the
    # result made it recoverable; this is what recovers it.
    #
    # Five attempts at 10s doubling to the 60s ceiling (modal validates
    # max_delay to 1-60; a 120 here failed the deploy) is about three minutes
    # of delay, plus each attempt's own callback timeouts.
    #
    # What bounds the useful window is the portal's stale sweep, and it
    # measures from `runs.createdAt` rather than from the last callback
    # (maintenance.ts). So the headroom is 3600 seconds minus however long the
    # run itself took, not 3600 seconds from the first failed delivery: a run
    # that scored at 3590 seconds can lose its result to the sweep during the
    # first retry delay. Once the sweep marks the run failed it is terminal,
    # `applyEvent` ignores the replay, and the runner still records the event
    # as delivered because the route answers 200. Retrying for longer would
    # not fix that; moving the sweep to the last callback would.
    retries=modal.Retries(max_retries=5, initial_delay=10.0, max_delay=60.0),
)
def execute_job(job_value: Dict[str, Any]) -> None:
    job = validate_job(job_value)
    outcome = job_store.get(_outcome_key(job["jobId"]))
    if outcome is not None:
        # This job already produced its outcome, completed or failed alike.
        # Send it again if it never landed, and never score a second time: the
        # result exists, and a second measurement presented as the first is a
        # claim about the team's code that nothing observed.
        _finish(job, outcome, outcome["status"])
        return
    # Claim the job, or find that someone already has. `skip_if_exists` makes
    # that one operation: reading the key and then writing it let two
    # invocations both see nothing and both do the work.
    #
    # A claimed job with no outcome beside it is one of two things, and this
    # cannot tell them apart: a job another invocation is running right now,
    # or one whose attempt died between the claim and the terminal write.
    # Standing down is right for the first and gives up on the second, which
    # is then left to the portal's stale sweep. Telling them apart needs an
    # owner on the claim that a later attempt can recognise as its own dead
    # self; `modal.current_function_call_id` looks like the way in, and
    # whether it survives a retry is not something this repository can
    # establish without running on Modal.
    if not job_store.put(job["jobId"], "running", skip_if_exists=True):
        return
    reporter = LiveReporter(job)
    phase = "queued"
    try:
        prepared_this_run = job["preparedArtifactId"] is None
        if prepared_this_run:
            snapshot_id, prepared_environment = _prepare(job, reporter)
        else:
            phase = "contract_check"
            reporter.status("contract_check")
            snapshot_id = job["preparedArtifactId"]
            prepared_environment = job.get("preparedEnvironment")
            incompatibility = validate_prepared_environment(job, prepared_environment)
            if incompatibility:
                raise RunnerFailure("provider", "contract_check", incompatibility, True)
        # This evidence came from before installation, over the signed job.
        # Later package changes or prediction claims cannot change attribution.
        weights_supplied = [weight["path"] for weight in job.get("weights", [])]
        phase = "contract_check"
        benchmark = _load_benchmark(job)
        week3 = job["benchmark"]["id"] == "language-search"
        week1 = job["benchmark"]["id"] == "audio-identification"
        week1_manifest: Dict[str, Any] = {}
        if week1:
            week1_manifest = _week1_manifest(job)
            cases = _week1_cases(job, week1_manifest)
            inputs, expected = [], []
            case_count = len(cases)
        elif week3:
            cases = _week3_cases(job, benchmark)
            inputs, expected = [], []
            case_count = len(cases)
        elif benchmark.contract_version == "cogworks.submissions.v2":
            cases = _v2_cases(job, benchmark)
            inputs, expected = [], []
            case_count = len(cases)
        else:
            inputs, expected = _cases(job, benchmark)
            cases = []
            case_count = len(inputs)
        phase = "evaluating"
        reporter.status("evaluating", 0, case_count)
        with StatusHeartbeat(reporter, "evaluating", 0, case_count):
            if week1:
                predictions, student_log = _evaluate_week1(
                    job, snapshot_id, week1_manifest
                )
            elif week3:
                predictions, student_log = _evaluate_week3(job, snapshot_id, cases)
            elif benchmark.contract_version == "cogworks.submissions.v2":
                predictions, student_log = _evaluate_v2(job, snapshot_id, cases)
            else:
                predictions, student_log = _evaluate(job, snapshot_id, inputs)
        reporter.status("evaluating", case_count, case_count)
        # Before the phase moves to scoring, and deliberately so: a refusal
        # here is about what the submission returned, and `phase` is what the
        # failure handler below reports. Anything raised once phase is
        # "scoring" and is not a RunnerFailure becomes category "scorer" with
        # infrastructure=True, which tells the team the platform broke.
        check_predictions(benchmark, predictions, case_count)
        phase = "scoring"
        reporter.status("scoring")
        if benchmark.contract_version == "cogworks.submissions.v2":
            metrics, diagnostics = _v2_metrics(benchmark, predictions, cases)
        else:
            metrics, diagnostics = benchmark.score(predictions, expected)
        output_digest = hashlib.sha256(
            json.dumps(predictions, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        # Preparation identity is preserved separately from this evaluator.
        # Requested image labels cannot describe a restored filesystem.
        environment_digest = hashlib.sha256(canonical_json({
            "preparedEnvironment": prepared_environment,
            "evaluationScriptSha256": hashlib.sha256(EVALUATE_SCRIPT.encode("utf-8")).hexdigest(),
            "controllerPython": sys.version,
            "pluginVersion": benchmark.plugin_version,
            "scorerVersion": benchmark.scorer_version,
        })).hexdigest()
        result = {
            "protocolVersion": "1",
            "benchmarkId": job["benchmark"]["id"],
            "benchmarkVersion": job["benchmark"]["version"],
            "metrics": [metric.to_wire() for metric in metrics],
            "diagnostics": [
                line
                for item in diagnostics[:32]
                for line in _diagnostic_lines(item)
            ][:32],
            "outputDigest": output_digest,
        }
        if prepared_this_run:
            result["weightsSupplied"] = weights_supplied
        sweep = _sweep_wire(benchmark)
        if sweep:
            result["sweep"] = sweep
        if _WIRING:
            result["wiring"] = _WIRING
    except Exception as error:
        detail = _failure_detail(error)
        refusal = None
        if isinstance(error, RunnerFailure):
            category = error.category
            failure_phase = error.phase
            infrastructure = error.infrastructure
            refusal = error.refusal
        elif phase == "scoring":
            category = "scorer"
            failure_phase = "scoring"
            infrastructure = True
        else:
            category = "provider"
            failure_phase = phase
            infrastructure = True
        log = error.log if isinstance(error, RunnerFailure) else None
        failed = reporter.build(
            "failed",
            failure={
                "category": category,
                "phase": failure_phase,
                "detail": detail,
                "infrastructure": infrastructure,
                **({"refusal": refusal} if refusal else {}),
            },
            sanitizedLog=_wire_log(job, log),
        )
        print("run failed: {}".format(detail), file=sys.stderr)
        _finish(job, {"status": "failed", "event": failed, "delivered": False}, "failed")
        # This job is over. Without the return, control left the handler and
        # ran the completion block below on a `result` that was never built.
        return

    # Outside the boundary on purpose. Producing the result and delivering it
    # are different problems, and they shared that `except`, whose handler maps
    # anything raised while the phase is "scoring" to `category: "scorer"`. So a
    # portal that would not answer turned a run that scored into a scorer
    # failure: the team's real number was replaced by a claim that our scorer
    # broke.
    #
    # The result is written down before it is sent. `_post_event` retries three
    # times; when those are exhausted the numbers used to exist only in this
    # frame, so the run was unrecoverable even though it had scored. Stored,
    # a later dispatch of the same job replays this exact event. The window is
    # the portal's stale-run sweep: once that marks the run failed the run is
    # terminal and `applyEvent` ignores the replay, so recovery has to happen
    # inside it.
    completed = reporter.build(
        "completed",
        result=result,
        preparedArtifactId=snapshot_id,
        preparedEnvironment=prepared_environment,
        environmentDigest=environment_digest,
        sanitizedLog=_wire_log(job, student_log),
    )
    _finish(job, {"status": "completed", "event": completed, "delivered": False}, "completed")


@app.function(image=controller_image, secrets=[runner_secret], timeout=30)
@modal.fastapi_endpoint(method="POST", docs=False)
async def submit_job(request: Request) -> Response:
    body = await request.body()
    timestamp = request.headers.get("X-Cogworks-Timestamp", "")
    supplied = request.headers.get("X-Cogworks-Signature", "")
    key_id = request.headers.get("X-Cogworks-Key-Id", "")
    secret = os.environ["RUNNER_SIGNING_SECRET"]
    if key_id != os.environ.get("RUNNER_SIGNING_KEY_ID", "runner-v1"):
        return Response(status_code=401)
    if not verify_signature(secret, timestamp, body, supplied):
        return Response(status_code=401)
    try:
        job = validate_job(json.loads(body))
    except (ValueError, json.JSONDecodeError):
        return Response(status_code=400)
    status = job_store.get(job["jobId"])
    outcome = job_store.get(_outcome_key(job["jobId"]))
    # A finished job whose outcome never reached the portal is the one case
    # worth re-entering: `execute_job` replays the stored event and scores
    # nothing. Everything else keeps the guard this endpoint always had.
    undelivered = outcome is not None and not outcome.get("delivered")
    if status not in ("running", "completed") or undelivered:
        execute_job.spawn(job)
    return Response(status_code=202)
