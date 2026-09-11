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

from .image_bake import WEEK3_DATA_DIR, cache_facenet_checkpoint, cache_week3_artifacts
from .protocol import canonical_json, signature, validate_job, verify_signature

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
    `parents[4]` raised IndexError there, which crash-looped every container:
    `submit_job` never answered, so no job was ever spawned and no run event was
    ever emitted. Anchoring on the workspace marker also removes the silent
    failure mode where moving this file makes `parents[4]` point somewhere else
    that happens to exist.
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
#: templates arrived on the run page cut mid-word: three of them ended "and",
#: "not hid", and "give you on". A note is one instruction about what to change
#: next, so the half that survived was the half that described the problem and
#: the half that was lost was the advice.
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
    if len(text) <= DIAGNOSTIC_LIMIT:
        return [text]
    return textwrap.wrap(
        text,
        width=DIAGNOSTIC_LIMIT,
        break_long_words=True,
        break_on_hyphens=False,
    ) or [text[:DIAGNOSTIC_LIMIT]]


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

app = modal.App("cogworks-runner")
# modal>=1.5 removed create_if_missing from Secret.from_name; the secret is
# still required to exist (deploy fails at reference resolution otherwise).
runner_secret = modal.Secret.from_name("cogworks-runner-signing")
hidden_datasets = modal.Volume.from_name("cogworks-hidden-datasets", create_if_missing=True)
job_store = modal.Dict.from_name("cogworks-runner-jobs", create_if_missing=True)

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
        }
    )
    .run_function(cache_facenet_checkpoint)
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
            # PYTHONHASHSEED: one 2026 team builds its IDF table by iterating
            # a set, so which order words land in it depends on string
            # hashing, and its text retrieval score moved between 0.8188 and
            # 0.8335 across three seeds. An interpreter's seed is fixed before
            # its first line, so it has to come from the image environment,
            # where every process in the sandbox inherits it. The binding
            # records whether it was pinned (isolate.hash_seed_in_effect).
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

# The controller scores every benchmark, so it carries every plugin package;
# week1 and week3 scoring are pure numpy (gensim and librosa stay lazy and
# unused there).
controller_image = (
    benchmark_image.pip_install("fastapi>=0.115,<1")
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "week3", "/opt/week3"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "week1", "/opt/week1"))
    .run_commands(
        "python -m pip install --no-deps /opt/week3",
        "python -m pip install --no-deps /opt/week1",
    )
)

#: Names the two sandbox images are published under at deploy time.
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
        # working submission.py is scoreable, and failing it here would spend
        # one of three official attempts on our packaging preference.
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
#    Failure here is never fatal to the sandbox. The report is written either
#    way and the evaluate step reads it, so a repository that cannot be
#    resolved produces a verdict a student can act on instead of a traceback.
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
                "headline": "The search for your code could not run: {}".format(
                    str(error)[:200]
                ),
                "nextStep": "",
            }
        }

    if discovery is not None:
        pathlib.Path("/tmp/discovery.json").write_text(
            json.dumps(discovery), encoding="utf-8"
        )

if resolved_by is None:
    # The verdict says more than this line can, and it has already been
    # written for the caller to read. This is the summary that reaches a log.
    detail = ""
    if discovery:
        detail = " " + str(discovery.get("verdict", {}).get("headline", ""))[:300]
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
    #
    # Returns the factory and the course-file mapping to hold while it runs.
    # See `_course_files`.
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
    # The SDK's own object and lifetime rules, not a second set of hooks.
    # Nesting is safe: each instance saves what it replaced, and the inner
    # scope restores the outer one rather than the original.
    #
    # Discovery path only, because that is where the mapping already exists. A
    # repository that declares its own submission would need `spec` built for
    # it, and building one loads the week's test tier and course artifacts.
    from cogbench.discover import _Redirects

    return _Redirects(dict(getattr(spec, "resource_files", {}) or {}))
# Who owns the step currently running. The controller decides whether a
# failure consumes one of the three official attempts, and it must decide that
# from WHERE the exception came from, never from what the message says: the
# message is written by the submission, so matching words in it let a student
# label their own crash as a platform fault and retry for free.
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
                predictions = benchmark.run(factory, resources, cases)
        predictions = list(predictions)
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
                predictions = benchmark.run(factory, resources, cases)
        predictions = list(predictions)
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
                predictions = benchmark.run(factory, model, cases)
        predictions = list(predictions)
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
            predictions = predictor(inputs)
        predictions = list(predictions)
        if len(predictions) != len(inputs):
            raise RuntimeError("Submission returned the wrong number of predictions.")
except Exception as error:
    marker = "COG_ERROR" if owner == "student" else "COG_PLATFORM_ERROR"
    sys.stderr.write("{}: {}\n".format(marker, str(error)[:500]))
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
pathlib.Path("/tmp/cog-student.log").write_text(buffer.value(), encoding="utf-8")
"""


class RunnerFailure(RuntimeError):
    def __init__(
        self,
        category: str,
        phase: str,
        detail: str,
        infrastructure: bool,
        refusal: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(detail)
        self.category = category
        self.phase = phase
        self.infrastructure = infrastructure
        #: Why nothing could be found to score, when that is what failed.
        #: `detail` is one capped line, which is right for a log and too short
        #: for the thing a student acts on: a refusal names the step that
        #: stalled, the shape their last function returned, the modules that
        #: could not be read, and the one next thing to do.
        self.refusal = refusal


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
    """Reference the published sandbox image by name.

    This runs inside the container, so it must not touch `week3_image` or
    `benchmark_image` directly; resolving those definitions needs the local
    repository. `tools/deploy.py` publishes both names at deploy time.
    """
    name = {
        "language-search": WEEK3_SANDBOX_IMAGE,
        "audio-identification": WEEK1_SANDBOX_IMAGE,
    }.get(job["benchmark"]["id"], BENCHMARK_SANDBOX_IMAGE)
    return modal.Image.from_name(name)


def _student_python(job: Dict[str, Any]) -> str:
    """Week 1 and Week 3 student code runs under the pinned 3.8.20 venv; the
    course contract is Python 3.8 and Modal's own runtime cannot be."""

    return {
        "language-search": WEEK3_STUDENT_PYTHON,
        "audio-identification": WEEK1_STUDENT_PYTHON,
    }.get(job["benchmark"]["id"], "python")


def _prepare(job: Dict[str, Any], reporter: LiveReporter) -> str:
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
        sandbox = modal.Sandbox.create(
            image=_sandbox_image(job),
            app=app,
            cpu=(0.5, job["runtime"]["cpu"]),
            memory=(512, job["runtime"]["memoryMb"]),
            timeout=job["runtime"]["timeoutSeconds"],
            outbound_domain_allowlist=allowlist,
        )
        reporter.status("preparing")
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
            )
            process.wait()
        if process.returncode != 0:
            stderr_text = process.stderr.read()
            # The exception message, not the tail of the traceback. Slicing the
            # last 240 characters produced details like "line 144, in <module>"
            # -- the traceback's own last frame, which names our sandbox script
            # and tells a student nothing. The message is on the final
            # non-indented line, which is where Python puts it.
            detail = _last_error_line(stderr_text)
            refusal = _refusal_from(sandbox)
            normalized = (detail + " " + stderr_text[-400:]).lower()
            if "source archive" in normalized:
                raise RunnerFailure("repository_fetch", "preparing", detail, False)
            if "weight file" in normalized:
                raise RunnerFailure("data_download", "preparing", detail, False)
            # "no adapter found" is the message PREPARE_SCRIPT raises when a
            # repository has neither a submission.py nor an entry point;
            # "entry point" catches the older ambiguous-registration message.
            if "no adapter found" in normalized or "entry point" in normalized:
                raise RunnerFailure(
                    "adapter_missing", "contract_check", detail, False, refusal
                )
            raise RunnerFailure("dependency_install", "installing", detail or "Install failed.", False)
        reporter.status("contract_check")
        return sandbox.snapshot_filesystem().object_id
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


# ---------------------------------------------------------------------------
# Controller-side validation of the predictions read back from the sandbox.
#
# The sandbox already counts its own outputs against the case list
# (EVALUATE_SCRIPT, the four `len(predictions) != len(...)` raises). That check
# runs inside the student's own process, before the file is written, so it is
# advice rather than a guarantee: a module-level atexit handler that rewrites
# /tmp/cog-predictions.json runs after the script's final write, and the file
# the controller reads is then whatever the handler put there. The same is true
# of the 8 MiB cap on the line above that write. Everything the controller is
# unwilling to be wrong about has to be re-checked here, on this side of the
# boundary.
#
# What a missed check costs, measured against the real scoring modules:
#
#   * A short output list is not a crash. `zip(cases, outputs)` truncates, so
#     four Week 1 outputs covering a submission's two correct queries score
#     `identification_score` 1.0 where the honest twelve score 0.2, and one
#     perfect Week 2 clustering scenario out of four scores
#     `clustering_pairwise_f1` 1.0 against 0.54 (both re-measured against
#     `ClusteringBenchmark.score`, which zips before `score_clustering` sees a
#     length to compare).
#   * A wrong element type is an uncaught AttributeError inside `score()`, and
#     `execute_job` classifies any non-RunnerFailure raised during the scoring
#     phase as `scorer` with `infrastructure=True`. That copy tells the team
#     "this is a platform problem, not a problem with your code" and refunds
#     the attempt, so a payload that crashes the scorer buys unlimited official
#     retries. This is the same free-attempt economics the owner-tag comments
#     in `_evaluate_v2` closed on the evaluating phase; the scoring phase kept
#     it open.
#
# `output_invalid` is the category for this. It exists already
# (FAILURE_CATEGORIES in packages/contracts/src/schema.ts), its copy is written
# for exactly this case ("Predictions did not match the schema",
# packages/contracts/src/failures.ts), and it is a member of CONSUMING_FAILURES
# in both apps/portal/worker/routes/runner-events.ts and
# apps/portal/worker/execution/sync.ts, so refusing here spends the attempt
# rather than refunding it. Until now nothing in the scoring phase could
# produce it: its only producer was the v1 lane's substring match on
# student-controlled stderr.


class _NonFiniteNumber(ValueError):
    """A NaN or an infinity was found while parsing the predictions file."""


def _reject_constant(name: str) -> float:
    raise _NonFiniteNumber(name)


def _finite_float(text: str) -> float:
    value = float(text)
    # `value - value` is 0.0 for every real number, NaN for a NaN (which never
    # equals itself) and NaN for either infinity. One subtraction therefore
    # covers all three without importing math into the hottest loop of the
    # parse. Measured indistinguishable from math.isfinite on a 17 MB payload.
    if value - value != 0.0:
        raise _NonFiniteNumber(text)
    return value


#: Above this, `_bounded_int` stops trusting the value to float() and checks.
#: 2**63 is not a limit Python has; it is just comfortably past any count,
#: index, or score a benchmark deals in, and well under the float ceiling.
_SAFE_INT = 2 ** 63


def _bounded_int(text: str) -> int:
    """An integer the scoring code can still turn into a float.

    Scoring calls float() on submission numbers in several places (Week 1's
    `_margin`, `_v2_metrics`' own `float(value)`), and `float(2 ** 1024)`
    raises OverflowError rather than returning an infinity. Uncaught during
    scoring that is the `scorer`/infrastructure path, so a 400-digit integer
    in a scores list buys the same refunded attempt as a NaN.

    Tried by conversion rather than by a bit-length bound. The bound is not
    exactly on a bit boundary: 2**1023 has 1024 bits and converts, 2**1024 - 1
    also has 1024 bits and overflows, because the conversion rounds before it
    range-checks. Asking float() is both shorter and right at the edge.
    """

    value = int(text)
    # Cheap pre-filter. Every int a submission has any business returning is
    # far below this, and it keeps the try out of the common path.
    if -_SAFE_INT <= value <= _SAFE_INT:
        return value
    try:
        float(value)
    except OverflowError as error:
        raise _NonFiniteNumber(text[:32]) from error
    return value


#: Plain words for the types a JSON document can hold. A team reading this is
#: looking at their own Python, so the words are Python's, except that
#: "NoneType" is the interpreter's vocabulary rather than anything they wrote.
_TYPE_WORDS = {
    dict: "a dictionary",
    list: "a list",
    str: "a string",
    bool: "a true/false value",
    int: "a number",
    float: "a number",
    type(None): "None",
}


def _type_word(value: Any) -> str:
    return _TYPE_WORDS.get(type(value), type(value).__name__)


def _load_predictions(raw: str) -> List[Any]:
    """Parse the predictions file, refusing non-finite numbers at parse time.

    `json.loads` accepts the non-standard tokens NaN, Infinity and -Infinity by
    default, and `json.dumps` re-emits them. A NaN that survives to a metric
    reaches the completed event body, where `JSON.parse` in the Worker rejects
    the literal `NaN` and returns 400 from runner-events.ts. The run is scored,
    the event is dropped, and the run never reaches a terminal state, which
    reads to a team as a hung run rather than as a refusal.

    The hooks catch this during the parse instead of walking the parsed
    structure afterwards. A walk is a second full traversal (measured 0.043 s
    against 0.047 s for the parse itself on a 9 MB payload, so roughly double
    the cost), it has to recurse or maintain its own stack over student-shaped
    data, and it cannot see 1e400, which parses to `inf` with no NaN token
    anywhere in the file. `parse_float` catches that overflow because it sees
    the text. Measured overhead of the three hooks together: `parse_constant`
    is free, `parse_float` costs 35 percent of parse time on a float-heavy
    payload, `parse_int` 2.4x on an int-heavy one, all of it on a parse that
    runs once per run and takes tens of milliseconds.
    """

    try:
        parsed = json.loads(
            raw,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
            parse_int=_bounded_int,
        )
    except _NonFiniteNumber as error:
        raise RunnerFailure(
            "output_invalid",
            "evaluating",
            # Kept under the 240 characters execute_job truncates `detail` to,
            # since a refusal cut mid-sentence loses the half that helps.
            "Your results hold the value {}, which is not a finite number. A "
            "NaN or an infinity here usually comes from a division by zero or "
            "an average over an empty list. Check the numbers your adapter "
            "returns.".format(str(error)[:40]),
            False,
        ) from error

    # The top-level value has to be a JSON array. Each evaluate lane calls
    # list() on what it returns, and list() is a coercion rather than a check:
    # a top-level object becomes a list of its keys, so {"a": 1, "b": 2} turns
    # into ['a', 'b'] and arrives at the count check looking like two results.
    # A top-level string spreads into its characters the same way. Refusing
    # here means the count check downstream counts results rather than
    # whatever list() happened to manufacture.
    if type(parsed) is not list:
        raise RunnerFailure(
            "output_invalid",
            "evaluating",
            "Your submission's results came back as {}, and scoring reads a "
            "list holding one result per case. Check what your adapter "
            "returns.".format(_type_word(parsed)),
            False,
        )
    return parsed


#: What one element of the predictions list has to be, per benchmark: the
#: element's own type, the fields inside it that scoring will iterate, and the
#: types its items may have when the element is itself a list of labels.
#:
#: Three different element types live in this table because the three weeks
#: really do differ. Weeks 1 and 3 call `output.get(...)` on every element,
#: Week 2 recognition reads a Mapping of lifecycle labels, and Week 2
#: clustering reads a flat list holding one label per image. The field names
#: come from the drivers that build these outputs (`drivers.py` in each
#: benchmark package), not from a guess about what scoring might want.
#:
#: Keyed by benchmark_id and consulted only for `cogworks.submissions.v2`,
#: because "vision-recognition" is also the id of the v1 fixture benchmark,
#: whose score() str()-coerces whatever it is handed and so constrains nothing
#: beyond the count.
#:
#: A v2 benchmark missing from this table still gets the count check. That is
#: the deliberate failure mode for a week added later: the check that stops
#: score inflation keeps working, and no submission is refused for a shape
#: nobody has written down yet. `test_prediction_validation.py` fails when a
#: registered v2 benchmark has no entry, so the omission surfaces in CI rather
#: than in a run.
_V2_PREDICTION_SHAPES: Dict[str, Tuple[type, Tuple[str, ...], Optional[Tuple[type, ...]]]] = {
    "audio-identification": (dict, ("candidates", "scores", "mappings"), None),
    "language-search": (
        dict,
        ("embeddings", "text", "images", "rankings", "mappings"),
        None,
    ),
    "vision-recognition": (dict, ("known", "unknown_before", "post_enrollment"), None),
    # Cluster labels are dict keys twice over in scoring: `Counter(zip(...))`
    # and `Counter(actual)` in adjusted_rand_index. A list or dict label is an
    # uncaught TypeError there, so the item types are checked and not left to
    # the driver, which validated them inside the sandbox.
    "vision-clustering": (list, (), (str, int)),
}

#: The one field above that is legitimately null. The Week 1 driver writes
#: `"scores": None` when the submission returned candidates without them, and
#: `_margin` reads that None and returns None. A null in any other field is a
#: crash inside score().
_NULLABLE_PREDICTION_FIELDS = frozenset({"scores"})

#: Fields whose contents are handed to numpy as a float or int matrix, and the
#: leaf type each one's numbers have to be.
#:
#: The field check above stops one level down: it asks whether the value is a
#: list and never asks what is inside. That is not enough for these fields,
#: because `null` is the one wrong value that neither parse hook can see.
#: `parse_constant` fires on the tokens NaN, Infinity and -Infinity;
#: `parse_float` and `parse_int` see number text. A JSON `null` is none of
#: those, so it parses to Python None, and `np.asarray([[None]], dtype=float)`
#: turns None into NaN without raising. The same is true of the strings "nan"
#: and "inf", which float() accepts.
#:
#: NaN does not merely produce a wrong number, it produces the best possible
#: one. Measured against `component_scores` with the public-evaluation text
#: block (500 captions, two per image): an honest random submission scores
#: text_mrr 0.0101, and one whose embeddings are every-value-null scores
#: 1.0000, with `overall` going 0.0034 to 0.3333. The mechanism is that
#: `text_first_relevant_ranks` excludes a caption from its own results by
#: writing -inf on the score matrix diagonal, then sorts by -score. With an
#: all-NaN matrix the diagonal is the only non-NaN entry, and numpy sorts NaN
#: after every real value including +inf, so each caption ranks itself first
#: and every co-caption lands at rank 1. The exclusion that makes the metric
#: meaningful is what the NaN defeats.
#:
#: Week 3's own `coerce_matrix` rejects non-finite values already, and this is
#: not a second opinion on it: that check runs inside the sandbox, in the
#: student's process, on the way out. This side re-checks what reaches numpy.
#:
#: Cost of the walk, measured on a 6.23 MiB public-evaluation-shaped payload
#: with 698,700 numeric leaves: 0.012 s, against 0.034 s for the parse it
#: follows. It is a leaf scan and not a recursion because every field here is
#: exactly two levels deep, a list of rows of numbers.
_NUMERIC_MATRIX_FIELDS: Dict[str, Tuple[type, ...]] = {
    # np.asarray(..., dtype=float). bool is accepted at the leaf check itself
    # rather than listed here, because `type(True) is bool` and a bare
    # membership test would refuse it. See `_check_matrix_field` for why it is
    # allowed through.
    "embeddings": (int, float),
    "text": (int, float),
    "images": (int, float),
    # int(image_id) in search_ranks. A float id is accepted there (int(3.7) is
    # 3) and a str id is accepted when it spells a number, so both are left
    # alone; None and every other type raise inside scoring.
    "rankings": (int, float, str),
}

#: Fields whose rows are allowed to be ragged and allowed to be empty, so the
#: rectangle check is skipped for them.
#:
#: "rankings" is the only one. Each query returns up to k ids and fewer when
#: the submission's index held fewer, and `validate_rankings` writes [] for a
#: query that matched nothing; `search_ranks` scores a short or empty row as a
#: miss on purpose. The embedding fields are not in this set, because they are
#: handed to numpy as a matrix: a ragged one raises ValueError during scoring,
#: and a zero-width one scored text_mrr 0.6667 on a 4-caption case where
#: honest work scored less, since an empty row makes every pair tie.
_EMPTY_ROW_OK = frozenset({"rankings"})


def _refuse_output(detail: str) -> RunnerFailure:
    """Build the refusal for results that cannot be scored.

    `infrastructure=False` and the `output_invalid` category together are what
    spend the official attempt. Both matter: `execute_job` reads
    `infrastructure` to decide whether the run was our fault, and
    CONSUMING_FAILURES in runner-events.ts reads the category. Getting either
    wrong turns the refusal back into the free retry this check exists to
    close.

    The phase is "evaluating" rather than "scoring". What is wrong is the
    submission's results, and those were produced during evaluation; naming
    the scoring phase would put our own name on a step that never ran.
    """

    return RunnerFailure("output_invalid", "evaluating", detail, False)


def _check_matrix_field(index: int, field: str, rows: List[Any]) -> None:
    """Refuse a numbers-field whose leaves are not numbers.

    See `_NUMERIC_MATRIX_FIELDS` for why this exists and what it costs: JSON
    `null` reaches numpy as NaN, and a NaN embedding scores 1.0 rather than
    crashing. Ragged rows are refused too, since numpy raises on them and an
    uncaught raise during the scoring phase is the refunded-attempt path.

    Only the first offending leaf is named. A submission that got this wrong
    usually got it wrong everywhere, and one location is what the team needs
    to find the line.
    """

    leaf_types = _NUMERIC_MATRIX_FIELDS[field]
    rectangular = field not in _EMPTY_ROW_OK
    width: Optional[int] = None
    for position, row in enumerate(rows):
        if type(row) is not list:
            raise _refuse_output(
                'In result {}, row {} of "{}" came back as {}. Each row holds '
                "one list of numbers.".format(index, position, field, _type_word(row))
            )
        # "rankings" is skipped here and only here: it is legitimately ragged
        # and legitimately empty, because each query returns up to k ids and
        # `validate_rankings` writes [] for a query that matched nothing.
        # `search_ranks` scores a short or empty row as a miss on purpose. The
        # embedding fields are a matrix and get both checks.
        if rectangular:
            if not row:
                raise _refuse_output(
                    'In result {}, row {} of "{}" is empty, and scoring reads '
                    "one number per position.".format(index, position, field)
                )
            if width is None:
                width = len(row)
            elif len(row) != width:
                # numpy raises ValueError on a ragged nested list, and an
                # uncaught raise once the phase is "scoring" is reported as
                # our fault rather than the submission's.
                raise _refuse_output(
                    'In result {}, "{}" has rows of different lengths ({} and '
                    "{}). Every row needs the same number of values.".format(
                        index, field, width, len(row)
                    )
                )
        for column, item in enumerate(row):
            # bool is checked first because `type(True) is bool`, not int, and
            # numpy reads True as 1.0. A submission whose embeddings are all
            # True scores text_mrr 0.1620 against the 0.1624 chance floor,
            # which is an honest bad score rather than an inflated one, so
            # refusing it would cost a team an attempt for nothing.
            if type(item) is bool or type(item) in leaf_types:
                continue
            raise _refuse_output(
                'In result {}, "{}" holds {} at row {}, position {}, where '
                "scoring reads a number. A null here becomes a NaN and cannot "
                "be scored.".format(index, field, _type_word(item), position, column)
            )


def _check_predictions(benchmark: Any, predictions: List[Any], case_count: int) -> None:
    """Refuse results that score() cannot read, before score() sees them.

    Called once, from execute_job, on the path all four evaluate lanes
    converge to. One call site rather than four is the point: a fifth lane
    added later is covered by construction instead of by remembering.

    Shallow wherever score() already defends itself, and it is left alone
    there: `score_recognition` returns `_empty_recognition_score()` for every
    length mismatch it can see, and `score_clustering` zeros a case whose
    label count is wrong. A second opinion on either would mean two places to
    edit when the contract moves.

    The exception is `_NUMERIC_MATRIX_FIELDS`, where the check goes down to
    the leaves. Those fields are handed to numpy, and numpy turns a JSON
    `null` into NaN rather than raising, which scores 1.0 instead of failing.
    Week 3's own `coerce_matrix` and `validate_rankings` do reject that, but
    both run inside the sandbox in the student's own process, and this whole
    module exists because that side is not trusted.
    """

    if len(predictions) != case_count:
        # Says what happened and stops. It used to tell the student to look for
        # "a case your code skipped", which under the v2 contract is not
        # something they can do: the benchmark's own driver walks the case list
        # and calls their functions once per case. The one time this fired for
        # real, the platform had handed the sandbox a shorter list than it
        # scored, and the message sent the student looking through their own
        # code for it.
        raise _refuse_output(
            "Your submission returned {} results for {} cases. Scoring pairs "
            "them up in order, so it needs one per case. The driver calls your "
            "code once per case, so if you did not build this list yourself, "
            "tell course staff.".format(len(predictions), case_count)
        )

    if getattr(benchmark, "contract_version", None) != "cogworks.submissions.v2":
        return
    shape = _V2_PREDICTION_SHAPES.get(getattr(benchmark, "benchmark_id", ""))
    if shape is None:
        return
    element_type, fields, item_types = shape

    for index, element in enumerate(predictions):
        # Exact type, not isinstance. json.loads produces a dict for an object
        # and a list for an array, so nothing legitimate is excluded, and a
        # string passes every Sequence check while scoring iterates it one
        # character at a time. Measured: a two-character string in Week 2's
        # "known" field clears the length guard and scores as two correct
        # labels, and a four-character clustering element clears both length
        # guards and is scored as a partition.
        if type(element) is not element_type:
            raise _refuse_output(
                "Result {} came back as {}, and this benchmark scores {} for "
                "each case. Check what your adapter returns for that "
                "case.".format(index, _type_word(element), _TYPE_WORDS[element_type])
            )
        if item_types is not None:
            for position, item in enumerate(element):
                # isinstance and not type(), so a bool label passes here. The
                # driver refuses bools inside the sandbox as a contract
                # matter, but scoring treats True as 1 and False as 0 and
                # returns a correct partition for them (measured: identical
                # metrics to the same labels written as 1 and 0). Refusing a
                # payload that scores correctly would cost a team an attempt
                # for nothing.
                if not isinstance(item, item_types):
                    raise _refuse_output(
                        "In result {}, label {} came back as {}. Cluster "
                        "labels have to be strings or numbers; only which "
                        "labels match each other matters, never what they are "
                        "called.".format(index, position, _type_word(item))
                    )
            continue
        for field in fields:
            if field not in element:
                # Absent is normal and is not an error. A failed case writes
                # {"ok": False, "error": ...} with none of these fields, and
                # scoring reads that shape on purpose.
                continue
            value = element[field]
            if type(value) is list:
                if field in _NUMERIC_MATRIX_FIELDS:
                    _check_matrix_field(index, field, value)
                continue
            if value is None and field in _NULLABLE_PREDICTION_FIELDS:
                continue
            raise _refuse_output(
                'In result {}, "{}" came back as {} where scoring reads a '
                "list. Check what your adapter puts in that "
                "field.".format(index, field, _type_word(value))
            )


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
    if isinstance(steps, list):
        _WIRING.extend(steps[:16])


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
        process = sandbox.exec(
            "python",
            "/tmp/cog-evaluate.py",
            job["benchmark"]["id"],
            str(job["runtime"]["maxOutputBytes"]),
        )
        process.wait()
        if process.returncode != 0:
            detail = process.stderr.read()[-240:]
            normalized = detail.lower()
            category = "output_invalid" if "prediction" in normalized else "student_runtime"
            raise RunnerFailure(category, "evaluating", detail or "Evaluation failed.", False)
        predictions = _load_predictions(
            sandbox.filesystem.read_text("/tmp/cog-predictions.json")
        )
        _collect_wiring(sandbox)
        log = sandbox.filesystem.read_text("/tmp/cog-student.log")
        return list(predictions), log[: job["runtime"]["maxOutputBytes"]]
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
        process = sandbox.exec(
            "python",
            "/tmp/cog-evaluate.py",
            job["benchmark"]["id"],
            str(job["runtime"]["maxOutputBytes"]),
        )
        process.wait()
        if process.returncode != 0:
            stderr_text = process.stderr.read()
            detail = _last_error_line(stderr_text)
            # No platform-fault branch here, deliberately. See
            # _platform_owned_evaluation_failure below: anything this process
            # writes after it imports student code is student speech, and the
            # conditions a marker used to report are already verified by the
            # controller before the sandbox starts.
            # Not "contract_invalid" from the message text: that category is
            # absent from CONSUMING_FAILURES in runner-events.ts, so deriving
            # it from student-controlled words was a second way to buy a free
            # official attempt (`raise RuntimeError("benchmark_adapter.py")`).
            # The contract check already ran during prepare; a failure here is
            # the submission's.
            raise RunnerFailure("student_runtime", "evaluating", detail, False)
        predictions = _load_predictions(
            sandbox.filesystem.read_text("/tmp/cog-predictions.json")
        )
        _collect_wiring(sandbox)
        log = sandbox.filesystem.read_text("/tmp/cog-student.log")
        # Un-permuted here rather than after `_check_predictions`, because that
        # check reads the lifecycle field names ("known", "unknown_before",
        # "post_enrollment") and those only exist once the shuffle is undone.
        # The consequence is that the two-batch shape the sandbox actually
        # wrote is only ever visible inside this call, so that is where it is
        # checked. See `_restore_v2_predictions` for what the coercion costs.
        predictions = _restore_v2_predictions(list(predictions), plans)
        return predictions, log[: job["runtime"]["maxOutputBytes"]]
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


#: The two keys a shuffled recognition scenario comes back under. These are
#: what the sandbox writes, so these are what gets checked; the lifecycle keys
#: score() reads do not exist yet at this point.
_RECOGNITION_BATCHES = ("before_enrollment", "after_enrollment")


def _restore_v2_predictions(predictions: List[Any], plans: List[Any]) -> List[Any]:
    """Put shuffled recognition predictions back into the shape score() reads.

    Clustering carries no plans and passes straight through.

    This is also where a recognition scenario's shape is checked, and it has
    to be here rather than in `_check_predictions`. The two functions run in
    this order (restore at the call in `_evaluate_v2`, then the check from
    `execute_job`) because the check reads the lifecycle field names "known",
    "unknown_before" and "post_enrollment", and those only exist once the
    shuffle is undone. That ordering has a consequence worth stating plainly:
    `restore_recognition_outputs` ends in a literal dict of three list slices,
    so by the time `_check_predictions` sees a recognition result, the result
    is a dict-of-lists no matter what the sandbox wrote. Its table entry for
    "vision-recognition" is a backstop for the path where no plans exist, not
    the live check. The live check is the one below, on the shape that
    actually exists here.

    What it stops: `restore_recognition_outputs` reads its batches through
    `list(output.get(...))`, and list() coerces rather than checks. Measured
    against a 3-before / 1-after plan, `{"before_enrollment": "abc",
    "after_enrollment": "d"}` restored to `{"known": ["a", "c"],
    "unknown_before": ["b"], "post_enrollment": ["d"]}`, cleared the length
    guard because len("abc") is 3, and arrived at `_check_predictions` as a
    clean dict of lists. A dict batch of the right size behaves the same way,
    since iterating a dict yields its keys.

    The refusals here are `output_invalid` rather than provider faults, for the
    reason `_refuse_output` states: what is wrong is the submission's results,
    and a provider category would refund the attempt. The sandbox driver
    already length-checked each batch before writing the file, but that check
    ran inside the student's own process, so it is re-done on this side.
    """

    from cogworks_runner.week2_payload import restore_recognition_outputs

    if not plans:
        return predictions
    if len(predictions) != len(plans):
        # Left to `_check_predictions`, which owns the count check and words it
        # for the reader. Returning early keeps one message for one fault.
        return predictions
    restored: List[Any] = []
    for index, (output, plan) in enumerate(zip(predictions, plans)):
        if not isinstance(output, dict):
            raise _refuse_output(
                "Each recognition scenario has to return a mapping of labels, "
                "and one came back as {}.".format(_type_word(output))
            )
        for batch in _RECOGNITION_BATCHES:
            if batch not in output:
                # Absent is left to the length guard inside
                # `restore_recognition_outputs`, which reports it as a count
                # and words it better than a missing-key message would.
                continue
            if type(output[batch]) is not list:
                raise _refuse_output(
                    'In result {}, "{}" came back as {}, and recognize returns '
                    "one label per image. Check what your adapter returns for "
                    "that batch.".format(index, batch, _type_word(output[batch]))
                )
        try:
            restored.append(restore_recognition_outputs(plan, output))
        except (ValueError, TypeError) as error:
            raise _refuse_output(str(error)[:240]) from error
    return restored


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
        )
        process.wait()
        if process.returncode != 0:
            stderr_text = process.stderr.read()
            detail = _last_error_line(stderr_text)
            # No platform-fault branch. _week3_cases already decoded and
            # validated the same artifacts in this process, before the sandbox
            # ran. See _platform_owned_evaluation_failure.
            # Not "contract_invalid" from the message text: that category is
            # absent from CONSUMING_FAILURES in runner-events.ts, so deriving
            # it from student-controlled words was a second way to buy a free
            # official attempt (`raise RuntimeError("benchmark_adapter.py")`).
            # The contract check already ran during prepare; a failure here is
            # the submission's.
            if _timed_out(job, started, process.returncode, stderr_text):
                raise RunnerFailure(
                    "timeout",
                    "evaluating",
                    "Evaluation ran past its {} second budget and was stopped. "
                    "Every song has to be enrolled and every query answered inside "
                    "that window; a database that is re-read or rewritten once per "
                    "song or per query grows with the catalog and will not "
                    "fit.".format(job["runtime"]["timeoutSeconds"]),
                    False,
                )
            raise RunnerFailure("student_runtime", "evaluating", detail, False)
        predictions = _load_predictions(
            sandbox.filesystem.read_text("/tmp/cog-predictions.json")
        )
        _collect_wiring(sandbox)
        log = sandbox.filesystem.read_text("/tmp/cog-student.log")
        return list(predictions), log[: job["runtime"]["maxOutputBytes"]]
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
        )
        process.wait()
        if process.returncode != 0:
            stderr_text = process.stderr.read()
            detail = _last_error_line(stderr_text)
            # No platform-fault branch. _week1_cases renders the same corpus
            # from the same seeds in this process and verifies it against the
            # same pinned digests, before the sandbox starts, so a corpus
            # fault is caught there by a party the submission cannot reach.
            # See _platform_owned_evaluation_failure.
            if _timed_out(job, started, process.returncode, stderr_text):
                raise RunnerFailure(
                    "timeout",
                    "evaluating",
                    "Evaluation ran past its {} second budget and was stopped. "
                    "Every song has to be enrolled and every query answered inside "
                    "that window; a database that is re-read or rewritten once per "
                    "song or per query grows with the catalog and will not "
                    "fit.".format(job["runtime"]["timeoutSeconds"]),
                    False,
                )
            raise RunnerFailure("student_runtime", "evaluating", detail, False)
        predictions = _load_predictions(
            sandbox.filesystem.read_text("/tmp/cog-predictions.json")
        )
        _collect_wiring(sandbox)
        log = sandbox.filesystem.read_text("/tmp/cog-student.log")
        return list(predictions), log[: job["runtime"]["maxOutputBytes"]]
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


def _platform_owned_evaluation_failure() -> None:
    """Why no evaluation failure is ever attributed to the platform from here.

    A failed official run either spends one of a team's three attempts or is
    refunded. Refunding is the branch that benefits the submission, so the
    evidence for it has to come from somewhere the submission cannot write.

    The sandbox used to say. It wrote `COG_PLATFORM_ERROR:` to stderr when it
    failed before importing student code, and the controller read that. The
    comment above the read said the marker could not be forged because only
    the message text was student-controlled. That was wrong, and measurably:
    `contextlib.redirect_stderr` rebinds the `sys.stderr` object and does not
    touch file descriptor 2, so three lines inside any student module

        import os
        os.write(2, b"COG_PLATFORM_ERROR: FaceNet cache validation failed")

    put the marker on the pipe the controller reads. That bought `model_cache`,
    which is infrastructure-owned and absent from CONSUMING_FAILURES, so the
    attempt came back. Unbounded, and the run page blamed our model cache.

    The exit code is no better: `os._exit` beats the `SystemExit(2)` the script
    would otherwise raise. Once student code is running in a process, nothing
    that process emits is evidence about us. That is the rule, and it is why
    this is not fixed by a harder-to-forge channel. Two earlier fixes each
    moved the trust to a new channel (adapter name, then message words, then
    this marker) and each left the shape intact.

    Nothing is lost by not asking. Every condition the marker reported is
    verified by this process, before the sandbox is created:

      _week1_cases   re-renders the corpus from its seeds and checks it
                     against the same pinned sha256 digests
      _week3_cases   decodes and validates the same course artifacts
      _v2_cases      decodes and validates the payload
      image_bake     downloads the FaceNet checkpoint under a sha256 lock at
                     image build time, so a cache fault at evaluation would
                     mean the image did not build

    So the marker was a second opinion about a settled question, solicited
    from the one party with a reason to lie. The remaining ways a run can fail
    through no fault of the submission are the ones the controller observes
    from outside: a process killed for time or memory, which `_timed_out`
    decides from elapsed seconds and the return code, and provider faults,
    which surface as exceptions here rather than as text from in there.

    Not a real function. Somewhere to put the reasoning, referenced from each
    place that would otherwise look like an oversight.
    """


def _timed_out(job: Dict[str, Any], started: float, returncode: int, stderr_text: str) -> bool:
    """Whether the sandbox killed the process for exceeding its wall clock.

    Modal enforces the sandbox timeout by killing the process, and a killed
    process reports a nonzero returncode with no traceback -- identical, from
    here, to a crash. Reported as a crash it becomes `student_runtime`, which
    consumes an official attempt and tells the team "Evaluation failed." with
    nothing to act on; a timeout is its own category, and the right message
    names the budget they exceeded.

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
    if returncode in (-9, 137, -15, 143):
        return True
    # Last resort only: this reads student-influenced text, so it is checked
    # after the two signals a submission cannot forge.
    return "killed" in stderr_text.lower()[-200:]


def _last_error_line(value: str) -> str:
    """The one sentence worth showing, out of a sandbox's stderr.

    Two shapes arrive here. The evaluate script marks its own failures with
    `COG_ERROR:`, having already decided what a student should read. The
    prepare script does not: it raises, and Python prints a traceback.

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
        return stripped[len("COG_ERROR:"):].strip()[:240]

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
                return text[:240]
    return "The student process exited before producing a valid result."


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
        "metric": _primary_for_run(benchmark),
        "points": wire,
    }


@app.function(
    image=controller_image,
    secrets=[runner_secret],
    volumes={"/hidden": hidden_datasets},
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
        snapshot_id = job["preparedArtifactId"] or _prepare(job, reporter)
        weights_supplied = [weight["path"] for weight in job.get("weights", [])]
        phase = "contract_check"
        if job["preparedArtifactId"]:
            reporter.status("contract_check")
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
        # infrastructure=True, which tells the team the platform broke and
        # refunds the attempt.
        _check_predictions(benchmark, predictions, case_count)
        phase = "scoring"
        reporter.status("scoring")
        if benchmark.contract_version == "cogworks.submissions.v2":
            metrics, diagnostics = _v2_metrics(benchmark, predictions, cases)
        else:
            metrics, diagnostics = benchmark.score(predictions, expected)
        output_digest = hashlib.sha256(
            json.dumps(predictions, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        environment_digest = hashlib.sha256(
            "{}:{}:{}".format(
                snapshot_id,
                job["runtime"]["imageDigest"],
                job["benchmark"]["pluginVersion"],
            ).encode("utf-8")
        ).hexdigest()
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
        detail = str(error)[:240]
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
        failed = reporter.build(
            "failed",
            failure={
                "category": category,
                "phase": failure_phase,
                "detail": detail,
                "infrastructure": infrastructure,
                **({"refusal": refusal} if refusal else {}),
            },
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
    # broke, and in official mode that refunds an attempt against a result that
    # exists.
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
        environmentDigest=environment_digest,
        sanitizedLog=student_log if job["mode"] == "practice" else None,
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
