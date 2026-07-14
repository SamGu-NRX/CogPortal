from __future__ import annotations

import hashlib
import json
import os
import time
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

benchmark_image = (
    modal.Image.debian_slim(python_version="3.11")
    .add_local_dir(str(REPO_ROOT / "python" / "cogbench" / "src"), "/opt/cogbench")
    .add_local_dir(
        str(REPO_ROOT / "benchmarks" / "vision-recognition" / "src"),
        "/opt/vision-benchmark",
    )
    .env({"PYTHONPATH": "/opt/cogbench:/opt/vision-benchmark"})
)

controller_image = benchmark_image.pip_install("fastapi>=0.115,<1")

PREPARE_SCRIPT = r"""
import importlib.metadata
import os
import pathlib
import subprocess
import sys
import tarfile
import urllib.request

archive_url, benchmark_id = sys.argv[1], sys.argv[2]
archive = pathlib.Path("/tmp/source.tar.gz")
max_archive_bytes = 100 * 1024 * 1024
request = urllib.request.Request(archive_url, headers={"User-Agent": "cogworks-runner"})
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
matches = points.select(group="cogworks.submissions.v1", name=benchmark_id)
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
from cogbench.plugins import load_submission

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
inputs = json.loads(pathlib.Path("/tmp/cog-inputs.json").read_text(encoding="utf-8"))
adapter = load_submission(benchmark_id)
predictor = getattr(adapter, "predict", adapter if callable(adapter) else None)
if not callable(predictor):
    raise RuntimeError("Submission adapter must be callable or expose predict(inputs).")
buffer = BoundedBuffer(limit)
with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
    predictions = predictor(inputs)
predictions = list(predictions)
if len(predictions) != len(inputs):
    raise RuntimeError("Submission returned the wrong number of predictions.")
encoded = json.dumps(predictions).encode("utf-8")
if len(encoded) > 8 * 1024 * 1024:
    raise RuntimeError("Submission predictions exceed the 8 MiB result limit.")
pathlib.Path("/tmp/cog-predictions.json").write_bytes(encoded)
pathlib.Path("/tmp/cog-student.log").write_text(buffer.value(), encoding="utf-8")
"""


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
    timestamp = str(int(time.time()))
    secret = os.environ["RUNNER_SIGNING_SECRET"]
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
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status // 100 != 2:
            raise RuntimeError("Portal rejected runner event.")


def _status(job: Dict[str, Any], sequence: int, status: str) -> None:
    _post_event(job, _event(job, sequence, "status", status=status))


def _cases(job: Dict[str, Any]) -> Tuple[List[Any], List[Any]]:
    if job["mode"] == "practice":
        from cogbench.plugins import load_benchmark

        cases = list(load_benchmark(job["benchmark"]["id"]).public_cases())
    else:
        path = (
            Path("/hidden")
            / job["benchmark"]["id"]
            / (job["benchmark"]["datasetVersion"] + ".json")
        )
        if not path.exists():
            raise RuntimeError("Official evaluation dataset is not configured.")
        cases = json.loads(path.read_text(encoding="utf-8"))
    return [case["input"] for case in cases], [case["expected"] for case in cases]


def _prepare(job: Dict[str, Any]) -> str:
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
    try:
        _status(job, 1, "preparing")
        sandbox.filesystem.write_text(PREPARE_SCRIPT, "/tmp/cog-prepare.py")
        _status(job, 2, "installing")
        process = sandbox.exec(
            "python",
            "/tmp/cog-prepare.py",
            job["source"]["archiveUrl"],
            job["benchmark"]["id"],
        )
        process.wait()
        if process.returncode != 0:
            detail = process.stderr.read()[-240:]
            raise RuntimeError("Preparation failed: {}".format(detail or "unknown error"))
        _status(job, 3, "contract_check")
        return sandbox.snapshot_filesystem().object_id
    finally:
        sandbox.terminate()


def _evaluate(job: Dict[str, Any], snapshot_id: str, inputs: List[Any]) -> Tuple[List[Any], str]:
    sandbox = modal.Sandbox.create(
        image=modal.Image.from_id(snapshot_id),
        app=app,
        cpu=(0.5, job["runtime"]["cpu"]),
        memory=(512, job["runtime"]["memoryMb"]),
        timeout=job["runtime"]["timeoutSeconds"],
        block_network=True,
    )
    try:
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
            raise RuntimeError("Evaluation failed: {}".format(detail or "unknown error"))
        predictions = json.loads(
            sandbox.filesystem.read_text("/tmp/cog-predictions.json")
        )
        log = sandbox.filesystem.read_text("/tmp/cog-student.log")
        return list(predictions), log[: job["runtime"]["maxOutputBytes"]]
    finally:
        sandbox.terminate()


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
    sequence = 1
    try:
        snapshot_id = job["preparedArtifactId"] or _prepare(job)
        sequence = 4 if not job["preparedArtifactId"] else 1
        inputs, expected = _cases(job)
        _status(job, sequence, "evaluating")
        predictions, student_log = _evaluate(job, snapshot_id, inputs)
        sequence += 1
        _status(job, sequence, "scoring")
        from cogbench.plugins import load_benchmark

        benchmark = load_benchmark(job["benchmark"]["id"])
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
        _post_event(
            job,
            _event(
                job,
                sequence + 1,
                "completed",
                result=result,
                preparedArtifactId=snapshot_id,
                environmentDigest=environment_digest,
                sanitizedLog=student_log if job["mode"] == "practice" else None,
            ),
        )
        job_store[job["jobId"]] = "completed"
    except Exception as error:
        job_store[job["jobId"]] = "failed"
        detail = str(error)[:240]
        infrastructure = "dataset is not configured" in detail or "Portal rejected" in detail
        try:
            _post_event(
                job,
                _event(
                    job,
                    sequence + 20,
                    "failed",
                    failure={
                        "category": "provider" if infrastructure else "student_runtime",
                        "phase": "evaluating" if sequence >= 4 else "installing",
                        "detail": detail,
                        "infrastructure": infrastructure,
                    },
                ),
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
