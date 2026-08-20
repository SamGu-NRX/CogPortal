from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Tuple

import modal
from fastapi import Request, Response

from .image_bake import WEEK3_DATA_DIR, cache_facenet_checkpoint, cache_week3_artifacts
from .protocol import canonical_json, signature, validate_job, verify_signature


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
benchmark_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "numpy==1.24.4",
        "Pillow==10.2.0",
        "torch==2.2.2",
        "torchvision==0.17.2",
        "facenet-pytorch==2.6.0",
        "opencv-python-headless==4.10.0.84",
        "platformdirs>=4,<5",
        "datasets>=2.20,<4",
        "facenet_models @ git+https://github.com/CogWorksBWSI/facenet_models.git@96b9599b03f26910b66f61ce725a8660e0ba654c",
        # The Week 2 conda environment the course tells students to build
        # (docs/capstones/environment.md:146) carries scikit-learn,
        # scikit-image, and matplotlib, and mygrad/mynn/noggin are the pip
        # installs on the same page (line 168). This image had none of them,
        # so a submission importing any one of them failed at import with a
        # ModuleNotFoundError that named a package the course told the student
        # to have. mygrad is pinned to 2.2.0 because 2.3.0 requires Python
        # 3.9 and the student contract is 3.8; imageio and networkx are
        # scikit-image's own runtime dependencies, listed here so a pin
        # change in scikit-image cannot silently drop them.
        "scikit-learn==1.3.2",
        "scikit-image==0.21.0",
        "matplotlib==3.7.5",
        "imageio==2.35.1",
        "networkx==3.1",
        "mygrad==2.2.0",
        "mynn==0.9.4",
        "noggin==0.10.1",
        "cogworks-data==0.2.0",
    )
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "python" / "cogbench" / "src", "/opt/cogbench"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "adapters", "/opt/adapters"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "apps" / "runner-modal" / "src", "/opt/runner"))
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "week2", "/opt/week2"))
    .run_commands("python -m pip install --no-deps /opt/week2")
    .env({"PYTHONPATH": "/opt/cogbench:/opt/runner", "TORCH_HOME": "/opt/torch"})
    .run_function(cache_facenet_checkpoint)
)

#: Student evaluation interpreter for Week 3. Modal's runtime requires
#: Python 3.10+, but the course contract is 3.8, so the image carries a
#: pinned CPython 3.8.20 venv (built with uv) and every prepare/evaluate
#: step for language-search runs through it. The 3.11 interpreter remains
#: the Modal control runtime only.
WEEK3_STUDENT_PYTHON = "/opt/cogworks-py38/bin/python"

#: Same arrangement for Week 1. The path is identical by construction (one
#: venv layout, two images), but naming it separately keeps a future change
#: to one track's interpreter from silently moving the other's.
WEEK1_STUDENT_PYTHON = "/opt/cogworks-py38/bin/python"

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
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "adapters", "/opt/adapters"))
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
        "uv pip install --python /opt/cogworks-py38/bin/python pip 'numpy==1.24.4'"
        " 'gensim>=4.3,<4.4' 'platformdirs>=4,<5' 'mygrad==2.2.0' 'mynn==0.9.4'"
        " 'noggin==0.10.1' 'cogworks-data==0.2.0' 'matplotlib==3.7.5'"
        " 'scikit-learn==1.3.2' 'numba==0.58.1' 'llvmlite==0.41.1'",
        "/opt/cogworks-py38/bin/python -m pip install --no-deps /opt/week3",
        "/opt/cogworks-py38/bin/python -c \"import sys; assert sys.version_info[:3] == (3, 8, 20), sys.version\"",
    )
    .env(
        {
            "PYTHONPATH": "/opt/cogbench:/opt/runner",
            "COGWORKS_LANGUAGE_DATA": WEEK3_DATA_DIR,
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
    .pipe(lambda i: add_source_dir(i, REPO_ROOT / "benchmarks" / "adapters", "/opt/adapters"))
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
        "uv pip install --python /opt/cogworks-py38/bin/python pip 'numpy==1.24.4'"
        " 'scipy==1.10.1' 'matplotlib==3.7.5' 'numba==0.58.1' 'llvmlite==0.41.1'"
        " 'soundfile==0.12.1' 'librosa==0.11.0' 'platformdirs>=4,<5'"
        " 'ipython==8.12.3'",
        "/opt/cogworks-py38/bin/python -m pip install --no-deps /opt/week1",
        "/opt/cogworks-py38/bin/python -c \"import sys; assert sys.version_info[:3] == (3, 8, 20), sys.version\"",
        # Import-checked at build time rather than trusted: a wheel that
        # installs and then fails to import (libsndfile, llvmlite/numba ABI)
        # would otherwise surface as every student's run failing.
        "/opt/cogworks-py38/bin/python -c \"import numpy, scipy, matplotlib, numba, soundfile, librosa, IPython\"",
    )
    .env({"PYTHONPATH": "/opt/cogbench:/opt/runner", "MPLBACKEND": "Agg"})
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
import pathlib
import subprocess
import sys
import tarfile
import urllib.request

archive_url, benchmark_id, contract_group = sys.argv[1], sys.argv[2], sys.argv[3]
repository_slug = sys.argv[4] if len(sys.argv) > 4 else ""
archive = pathlib.Path("/tmp/source.tar.gz")
max_archive_bytes = 100 * 1024 * 1024
request = urllib.request.Request(archive_url, headers={"User-Agent": "cogworks-runner"})
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

# Two ways a repository can declare itself, checked in this order.
#
# 1. A packaging file plus a `cogworks.submissions.v2` entry point. This is the
#    template's shape and the shape `examples/` uses.
# 2. A `submission.py` (or `benchmark_adapter.py`) at the repository root,
#    imported by path. This is what actually serves student repositories: none
#    of the thirteen audited this year carries a pyproject.toml or setup.py, so
#    requiring rung 1 rejected every one of them at prepare time.
#
# Rung 2 is also the safer rung, which is why it is not merely a fallback for
# the unpackaged. `pip install -e` executes the repository's own setup.py, and
# it does so HERE, in the prepare sandbox, which still has network access for
# PyPI. Importing one file happens in the evaluate sandbox instead, behind
# block_network=True. Every repository that can take rung 2 therefore runs less
# student code with a network than one that takes rung 1.
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

# Only when the repository has none of its own. A team that writes an adapter
# is scored by it, always: an instructor adapter that could shadow a student's
# would silently score our wiring instead of their work.
staged_adapter = None
if adapter_file is None and repository_slug:
    candidate = pathlib.Path("/opt/adapters") / repository_slug / "submission.py"
    if candidate.is_file():
        adapter_file = project / "submission.py"
        adapter_file.write_bytes(candidate.read_bytes())
        staged_adapter = repository_slug

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
    resolved_by = (
        "instructor_adapter:" + staged_adapter
        if staged_adapter
        else "file:" + adapter_file.name
    )
# 3. Discovery. Nothing in the repository declares itself, so the benchmark
#    describes what it needs and `cogbench.resolve` searches for functions that
#    do it by running them. This is the rung every 2026 repository actually
#    reaches, and it runs last so that a team who declares anything is scored
#    by their declaration rather than by our inference.
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
        from cogbench.resolve import resolve

        plugin = load_benchmark(benchmark_id)
        describes = getattr(plugin, "discovery", None)
        if callable(describes):
            spec = describes()
            found = resolve(
                project,
                chain_role=spec.chain_role,
                fixture=spec.fixture,
                accepts=spec.accepts,
                arrangements=spec.arrangements,
                hints=spec.hints,
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
    if adapter_source == "discovery":
        return _discovered_factory(benchmark_id)
    return load_submission(benchmark_id, contract_version, repo_root=repo_root)


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
    from cogbench.resolve import resolve

    benchmark = load_benchmark(benchmark_id)
    spec = benchmark.discovery()
    found = resolve(
        repo_root,
        chain_role=spec.chain_role,
        fixture=spec.fixture,
        accepts=spec.accepts,
        arrangements=spec.arrangements,
        hints=spec.hints,
    )
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

    return lambda *args, **kwargs: benchmark.submission_from_discovery(found)
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
            factory = load_student(benchmark_id, "cogworks.submissions.v2")
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
            factory = load_student(benchmark_id, "cogworks.submissions.v2")
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
            factory = load_student(benchmark_id, "cogworks.submissions.v2")
            predictions = benchmark.run(factory, model, cases)
        predictions = list(predictions)
        if len(predictions) != len(cases):
            raise RuntimeError("Submission returned the wrong number of scenario outputs.")
    else:
        inputs = json.loads(pathlib.Path("/tmp/cog-inputs.json").read_text(encoding="utf-8"))
        owner = "student"
        adapter = load_student(benchmark_id)
        predictor = getattr(adapter, "predict", adapter if callable(adapter) else None)
        if not callable(predictor):
            raise RuntimeError("Submission adapter must be callable or expose predict(inputs).")
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            predictions = predictor(inputs)
        predictions = list(predictions)
        if len(predictions) != len(inputs):
            raise RuntimeError("Submission returned the wrong number of predictions.")
except Exception as error:
    marker = "COG_ERROR" if owner == "student" else "COG_PLATFORM_ERROR"
    sys.stderr.write("{}: {}\n".format(marker, str(error)[:500]))
    raise SystemExit(2)
encoded = json.dumps(predictions).encode("utf-8")
if len(encoded) > 8 * 1024 * 1024:
    raise RuntimeError("Submission predictions exceed the 8 MiB result limit.")
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
    from cogworks_runner.week2_payload import attach_clustering_labels, decode_cases

    root = Path("/hidden") / job["benchmark"]["id"] / job["benchmark"]["datasetVersion"]
    try:
        payload_id, cases = decode_cases((root / "payload.zip").read_bytes())
        if payload_id != job["benchmark"]["id"]:
            raise ValueError("Official payload track mismatch.")
        if payload_id == "vision-clustering":
            labels = json.loads((root / "expected.json").read_text(encoding="utf-8"))
            cases = attach_clustering_labels(cases, labels)
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
    from cogworks_runner.week3_payload import attach_gold, decode_payload

    root = Path("/hidden") / job["benchmark"]["id"] / job["benchmark"]["datasetVersion"]
    try:
        payload_id, _showcase, cases = decode_payload((root / "payload.zip").read_bytes())
        if payload_id != job["benchmark"]["id"]:
            raise ValueError("Official payload benchmark mismatch.")
        gold = json.loads((root / "gold.json").read_text(encoding="utf-8"))
        return attach_gold(cases, gold)
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


#: Instructor-written adapters for repositories that predate the benchmark,
#: keyed by `owner/name`. Baked into the images from `benchmarks/adapters/`.
STAGED_ADAPTER_DIR = "/opt/adapters"


def _repository_slug(job: Dict[str, Any]) -> str:
    """`owner/name` as the directory name `benchmarks/adapters/` uses.

    Teams that finished a capstone before the benchmark existed could not have
    written a `submission.py`. Scoring them otherwise means either editing
    their repository or refusing to score them, so the images carry our
    adapters and the prepare step copies one in when the repository has none
    of its own. The run result says so: each adapter carries a `PROVENANCE`
    dict the driver surfaces, so a leaderboard row reads "scored through an
    instructor-supplied adapter" rather than passing our wiring off as theirs.

    A repository's own `submission.py` always wins; see PREPARE_SCRIPT. This
    is a bridge for existing work, not a substitute for the template.
    """

    return str(job["source"]["fullName"]).replace("/", "__")


def _prepare(job: Dict[str, Any], reporter: LiveReporter) -> str:
    sandbox = None
    try:
        sandbox = modal.Sandbox.create(
            image=_sandbox_image(job),
            app=app,
            cpu=(0.5, job["runtime"]["cpu"]),
            memory=(512, job["runtime"]["memoryMb"]),
            timeout=job["runtime"]["timeoutSeconds"],
            outbound_domain_allowlist=[
                "api.github.com",
                "codeload.github.com",
                "pypi.org",
                "files.pythonhosted.org",
            ],
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
                _repository_slug(job),
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
        predictions = json.loads(
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
            encode_cases(job["benchmark"]["id"], cases),
            "/tmp/cog-v2-payload.zip",
        )
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
            # The sandbox tags the failing step's owner. Never infer this from
            # the message text, which the submission controls.
            if "COG_PLATFORM_ERROR:" in stderr_text:
                raise RunnerFailure("model_cache", "evaluating", "FaceNet cache validation failed.", True)
            # Not "contract_invalid" from the message text: that category is
            # absent from CONSUMING_FAILURES in runner-events.ts, so deriving
            # it from student-controlled words was a second way to buy a free
            # official attempt (`raise RuntimeError("benchmark_adapter.py")`).
            # The contract check already ran during prepare; a failure here is
            # the submission's.
            raise RunnerFailure("student_runtime", "evaluating", detail, False)
        predictions = json.loads(sandbox.filesystem.read_text("/tmp/cog-predictions.json"))
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
            # See _evaluate_v2: ownership comes from the sandbox marker, not
            # from words a submission can put in its own exception.
            if "COG_PLATFORM_ERROR:" in stderr_text:
                raise RunnerFailure("model_cache", "evaluating", "Course artifact cache validation failed.", True)
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
        predictions = json.loads(sandbox.filesystem.read_text("/tmp/cog-predictions.json"))
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
            # See _evaluate_v2: ownership comes from the sandbox marker, not
            # from words a submission can put in its own exception.
            if "COG_PLATFORM_ERROR:" in stderr_text:
                # Carry the sandbox's own message. "Week 1 corpus validation
                # failed" alone named the phase and nothing else, which is
                # exactly the wrong half: this branch is ours by construction,
                # so the detail is safe to surface and is the only thing that
                # says which of sha mismatch, import error, or wrong
                # interpreter actually happened.
                marker = stderr_text.rsplit("COG_PLATFORM_ERROR:", 1)[-1].strip()
                raise RunnerFailure(
                    "data_download",
                    "evaluating",
                    "Week 1 corpus validation failed: {}".format(marker[:400] or "no detail"),
                    True,
                )
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
        predictions = json.loads(sandbox.filesystem.read_text("/tmp/cog-predictions.json"))
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
    scores = benchmark.score(outputs, cases)
    metrics = [
        Metric(
            key=key,
            label=labels.get(key, key.replace("_", " ").title()),
            value=float(value),
            unit=None,
            higher_is_better=key not in lower_is_better,
            primary=key == benchmark.primary_metric,
            precision=3,
            help=help_text.get(key),
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
    try:
        wire = [
            {"x": float(point[x_key]), "y": float(point[y_key])}
            for point in points[:24]
        ]
    except (KeyError, TypeError, ValueError):
        return None
    return {
        "axis": getattr(benchmark, "sweep_axis_label", "difficulty"),
        "metric": benchmark.primary_metric,
        "points": wire,
    }


@app.function(
    image=controller_image,
    secrets=[runner_secret],
    volumes={"/hidden": hidden_datasets},
    timeout=3_600,
)
def execute_job(job_value: Dict[str, Any]) -> None:
    job = validate_job(job_value)
    if job_store.get(job["jobId"]) in ("running", "completed"):
        return
    job_store[job["jobId"]] = "running"
    reporter = LiveReporter(job)
    phase = "queued"
    try:
        snapshot_id = job["preparedArtifactId"] or _prepare(job, reporter)
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
            "diagnostics": [str(item)[:240] for item in diagnostics[:32]],
            "outputDigest": output_digest,
        }
        sweep = _sweep_wire(benchmark)
        if sweep:
            result["sweep"] = sweep
        if _WIRING:
            result["wiring"] = _WIRING
        reporter.event(
            "completed",
            result=result,
            preparedArtifactId=snapshot_id,
            environmentDigest=environment_digest,
            sanitizedLog=student_log if job["mode"] == "practice" else None,
        )
        job_store[job["jobId"]] = "completed"
    except Exception as error:
        job_store[job["jobId"]] = "failed"
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
        try:
            reporter.event(
                "failed",
                failure={
                    "category": category,
                    "phase": failure_phase,
                    "detail": detail,
                    "infrastructure": infrastructure,
                    **({"refusal": refusal} if refusal else {}),
                },
            )
        except Exception:
            pass
        raise


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
    if job_store.get(job["jobId"]) not in ("running", "completed"):
        execute_job.spawn(job)
    return Response(status_code=202)
