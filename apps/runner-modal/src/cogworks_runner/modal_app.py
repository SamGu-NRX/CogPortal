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
    )
    .add_local_dir(str(REPO_ROOT / "python" / "cogbench" / "src"), "/opt/cogbench", copy=True)
    .add_local_dir(
        str(REPO_ROOT / "apps" / "runner-modal" / "src"),
        "/opt/runner",
        copy=True,
    )
    .add_local_dir(str(REPO_ROOT / "benchmarks" / "week2"), "/opt/week2", copy=True)
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

week3_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "numpy==1.24.4",
        "gensim>=4.3,<4.4",
        "platformdirs>=4,<5",
        "uv>=0.5",
    )
    .add_local_dir(str(REPO_ROOT / "python" / "cogbench" / "src"), "/opt/cogbench", copy=True)
    .add_local_dir(
        str(REPO_ROOT / "apps" / "runner-modal" / "src"),
        "/opt/runner",
        copy=True,
    )
    .add_local_dir(str(REPO_ROOT / "benchmarks" / "week3"), "/opt/week3", copy=True)
    .run_commands(
        "python -m pip install --no-deps /opt/week3",
        "uv venv --python 3.8.20 /opt/cogworks-py38",
        "uv pip install --python /opt/cogworks-py38/bin/python pip 'numpy==1.24.4' 'gensim>=4.3,<4.4' 'platformdirs>=4,<5'",
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

# The controller scores every benchmark, so it carries both plugin packages;
# week3 scoring is pure numpy (gensim stays lazy and unused there).
controller_image = (
    benchmark_image.pip_install("fastapi>=0.115,<1")
    .add_local_dir(str(REPO_ROOT / "benchmarks" / "week3"), "/opt/week3", copy=True)
    .run_commands("python -m pip install --no-deps /opt/week3")
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

PREPARE_SCRIPT = r"""
import importlib.metadata
import pathlib
import subprocess
import sys
import tarfile
import urllib.request

archive_url, benchmark_id, contract_group = sys.argv[1], sys.argv[2], sys.argv[3]
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
subprocess.run(
    [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-e", str(project)],
    check=True,
    timeout=420,
)
points = importlib.metadata.entry_points()
if hasattr(points, "select"):
    matches = points.select(group=contract_group, name=benchmark_id)
else:
    matches = [
        point
        for point in points.get(contract_group, ())
        if point.name == benchmark_id
    ]
if len(list(matches)) != 1:
    raise RuntimeError("Submission adapter entry point is missing or ambiguous.")
pathlib.Path("/tmp/project-root.txt").write_text(str(project), encoding="utf-8")
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
# Who owns the step currently running. The controller decides whether a
# failure consumes one of the three official attempts, and it must decide that
# from WHERE the exception came from, never from what the message says: the
# message is written by the submission, so matching words in it let a student
# label their own crash as a platform fault and retry for free.
owner = "platform"
try:
    if pathlib.Path("/tmp/cog-week3-payload.zip").exists():
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
            factory = load_submission(benchmark_id, "cogworks.submissions.v2")
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
            factory = load_submission(benchmark_id, "cogworks.submissions.v2")
            predictions = benchmark.run(factory, model, cases)
        predictions = list(predictions)
        if len(predictions) != len(cases):
            raise RuntimeError("Submission returned the wrong number of scenario outputs.")
    else:
        inputs = json.loads(pathlib.Path("/tmp/cog-inputs.json").read_text(encoding="utf-8"))
        owner = "student"
        adapter = load_submission(benchmark_id)
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
    def __init__(self, category: str, phase: str, detail: str, infrastructure: bool):
        super().__init__(detail)
        self.category = category
        self.phase = phase
        self.infrastructure = infrastructure


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


def _sandbox_image(job: Dict[str, Any]) -> Any:
    """Reference the published sandbox image by name.

    This runs inside the container, so it must not touch `week3_image` or
    `benchmark_image` directly; resolving those definitions needs the local
    repository. `tools/deploy.py` publishes both names at deploy time.
    """
    name = (
        WEEK3_SANDBOX_IMAGE
        if job["benchmark"]["id"] == "language-search"
        else BENCHMARK_SANDBOX_IMAGE
    )
    return modal.Image.from_name(name)


def _student_python(job: Dict[str, Any]) -> str:
    """Week 3 student code runs under the pinned 3.8.20 venv; the course
    contract is Python 3.8 and Modal's own runtime cannot be."""

    return WEEK3_STUDENT_PYTHON if job["benchmark"]["id"] == "language-search" else "python"


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
            )
            process.wait()
        if process.returncode != 0:
            detail = process.stderr.read()[-240:]
            normalized = detail.lower()
            if "source archive" in normalized:
                raise RunnerFailure("repository_fetch", "preparing", detail, False)
            if "entry point" in normalized:
                raise RunnerFailure("adapter_missing", "contract_check", detail, False)
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
            raise RunnerFailure("student_runtime", "evaluating", detail, False)
        predictions = json.loads(sandbox.filesystem.read_text("/tmp/cog-predictions.json"))
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


def _last_error_line(value: str) -> str:
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    if not lines:
        return "Evaluation failed."
    line = lines[-1]
    if line.startswith("COG_ERROR:"):
        return line[len("COG_ERROR:") :].strip()[:240]
    return "Student process exited before producing a valid result."


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
        )
        for key, value in scores.items()
    ]
    return metrics, list(getattr(benchmark, "last_diagnostics", []))


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
        if week3:
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
            if week3:
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
        if isinstance(error, RunnerFailure):
            category = error.category
            failure_phase = error.phase
            infrastructure = error.infrastructure
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
