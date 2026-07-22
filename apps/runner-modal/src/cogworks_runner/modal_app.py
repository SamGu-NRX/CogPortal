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

from .protocol import canonical_json, signature, validate_job, verify_signature


REPO_ROOT = Path(__file__).resolve().parents[4]
app = modal.App("cogworks-runner")
runner_secret = modal.Secret.from_name("cogworks-runner-signing", create_if_missing=False)
hidden_datasets = modal.Volume.from_name("cogworks-hidden-datasets", create_if_missing=True)
job_store = modal.Dict.from_name("cogworks-runner-jobs", create_if_missing=True)

CHECKPOINT_URL = (
    "https://github.com/timesler/facenet-pytorch/releases/download/"
    "v2.2.9/20180402-114759-vggface2.pt"
)
CHECKPOINT_SHA256 = "281cebca8662831adb987a874bdcb36e73f5b1c6dc5ee5878f305e985625d99b"


def _cache_facenet_checkpoint() -> None:
    path = Path("/opt/torch/checkpoints/20180402-114759-vggface2.pt")
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(CHECKPOINT_URL, timeout=120) as response:
        payload = response.read()
    if len(payload) != 111_898_327 or hashlib.sha256(payload).hexdigest() != CHECKPOINT_SHA256:
        raise RuntimeError("FaceNet checkpoint does not match the reviewed lock.")
    path.write_bytes(payload)

benchmark_image = (
    modal.Image.debian_slim(python_version="3.8")
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
    .add_local_dir(str(REPO_ROOT / "python" / "cogbench" / "src"), "/opt/cogbench")
    .add_local_dir(
        str(REPO_ROOT / "apps" / "runner-modal" / "src"),
        "/opt/runner",
    )
    .add_local_dir(str(REPO_ROOT / "benchmarks" / "week2"), "/opt/week2", copy=True)
    .run_commands("python -m pip install --no-deps /opt/week2")
    .env({"PYTHONPATH": "/opt/cogbench:/opt/runner", "TORCH_HOME": "/opt/torch"})
    .run_function(_cache_facenet_checkpoint)
)

controller_image = benchmark_image.pip_install("fastapi>=0.115,<1")

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
import contextlib
import io
import json
import pathlib
import sys
from cogbench.plugins import load_benchmark, load_submission

class BoundedBuffer(io.TextIOBase):
    def __init__(self, limit):
        self.limit = limit
        self.parts = []
        self.length = 0
    def write(self, value):
        text = str(value)
        remaining = max(0, self.limit - self.length)
        if remaining:
            self.parts.append(text[:remaining])
            self.length += len(text[:remaining])
        return len(text)
    def value(self):
        suffix = "\n[output truncated]" if self.length >= self.limit else ""
        return "".join(self.parts) + suffix

benchmark_id = sys.argv[1]
limit = int(sys.argv[2])
buffer = BoundedBuffer(limit)
try:
    if pathlib.Path("/tmp/cog-v2-payload.zip").exists():
        from cogworks_runner.week2_payload import decode_cases
        from facenet_models import FacenetModel
        payload_id, cases = decode_cases(pathlib.Path("/tmp/cog-v2-payload.zip").read_bytes())
        if payload_id != benchmark_id:
            raise RuntimeError("Staged benchmark payload does not match the job.")
        benchmark = load_benchmark(benchmark_id)
        factory = load_submission(benchmark_id, "cogworks.submissions.v2")
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            predictions = benchmark.run(factory, FacenetModel(device="cpu"), cases)
        predictions = list(predictions)
        if len(predictions) != len(cases):
            raise RuntimeError("Submission returned the wrong number of scenario outputs.")
    else:
        inputs = json.loads(pathlib.Path("/tmp/cog-inputs.json").read_text(encoding="utf-8"))
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
    sys.stderr.write("COG_ERROR: {}\n".format(str(error)[:500]))
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


def _prepare(job: Dict[str, Any], reporter: LiveReporter) -> str:
    sandbox = None
    try:
        sandbox = modal.Sandbox.create(
            image=benchmark_image,
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
                "python",
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
            detail = _last_error_line(process.stderr.read())
            if any(token in detail.lower() for token in ("checkpoint", "facenet model", "torch_home")):
                raise RunnerFailure("model_cache", "evaluating", "FaceNet cache validation failed.", True)
            category = "contract_invalid" if "benchmark_adapter.py" in detail else "student_runtime"
            raise RunnerFailure(category, "evaluating", detail, False)
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
    scores = benchmark.score(outputs, cases)
    metrics = [
        Metric(
            key=key,
            label=labels.get(key, key.replace("_", " ").title()),
            value=float(value),
            unit=None,
            higher_is_better=True,
            primary=key == benchmark.primary_metric,
            precision=3,
        )
        for key, value in scores.items()
    ]
    return metrics, []


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
        if benchmark.contract_version == "cogworks.submissions.v2":
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
            if benchmark.contract_version == "cogworks.submissions.v2":
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
