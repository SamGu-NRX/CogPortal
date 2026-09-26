"""Score the Week 3 reference inside the real sandbox, without GitHub.

`smoke_modal.py` fetches a repository by tarball, which needs the submission
to be pushed and public. The Week 3 reference lives in this monorepo and is
deliberately not published -- students must not see a finished solution -- so
the hosted evaluate path had no coverage at all: the corpus payload, the 3.8
venv, the GloVe cache baked into the image, the network block, and the
gold-stripping boundary were all unexercised.

This uploads the reference into a sandbox created from the same published
image, then runs the same `EVALUATE_SCRIPT` the job runner runs. Everything
after the fetch is identical to a real run; only the source of the code
differs.

    python apps/runner-modal/tools/smoke_week3_sandbox.py

A pass means the Week 3 hosted evaluation works end to end. It says nothing
about repository discovery, which `smoke_modal.py` covers against a public
repository.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(REPO / "python" / "cogbench" / "src"))
sys.path.insert(0, str(REPO / "benchmarks" / "week3"))

import modal  # noqa: E402
import modal.runner  # noqa: E402

from cogworks_runner import modal_app  # noqa: E402

REFERENCE = REPO / "examples" / "week3-language-submission"


def main() -> int:
    from cogbench.plugins import load_benchmark

    benchmark = load_benchmark("language-search")
    job = {
        "protocolVersion": "1",
        "jobId": "job_w3_sandbox",
        "runId": "run_w3_sandbox",
        "mode": "practice",
        "preparedArtifactId": None,
        "source": {"repositoryId": 0, "fullName": "local/reference", "sha": "0" * 40,
                   "archiveUrl": "https://api.github.com/repos/local/reference/tarball/x"},
        "benchmark": {
            "id": "language-search",
            "version": benchmark.benchmark_version,
            "contractVersion": benchmark.contract_version,
            "pluginVersion": benchmark.plugin_version,
            "datasetVersion": "practice-v1",
            "scorerVersion": benchmark.scorer_version,
        },
        "runtime": {"pythonVersion": "3.8", "imageDigest": "sandbox-smoke", "cpu": 1,
                    "memoryMb": 4096, "timeoutSeconds": 900, "maxOutputBytes": 8192},
        "callback": {"url": "https://example.invalid/never", "keyId": "runner-v1"},
    }

    print("building cases...", flush=True)
    cases = modal_app._week3_cases(job, benchmark)
    print("  {} cases".format(len(cases)), flush=True)

    started = time.time()
    with modal.enable_output(), modal.runner.run_app(modal_app.app):
        sandbox = modal.Sandbox.create(
            image=modal.Image.from_name(modal_app.WEEK3_SANDBOX_IMAGE),
            app=modal_app.app,
            cpu=(0.5, 1),
            memory=(512, 4096),
            timeout=900,
            # Network stays on only long enough to upload the reference; the
            # evaluation itself reads nothing remote, and the image already
            # carries GloVe and COCO.
            block_network=False,
        )
        try:
            print("uploading the reference submission...", flush=True)
            workspace = "/workspace/reference"
            sandbox.exec("mkdir", "-p", workspace).wait()
            for path in sorted(REFERENCE.rglob("*")):
                if not path.is_file() or "__pycache__" in path.parts or ".egg-info" in str(path):
                    continue
                target = "{}/{}".format(workspace, path.relative_to(REFERENCE))
                parent = target.rsplit("/", 1)[0]
                sandbox.exec("mkdir", "-p", parent).wait()
                sandbox.filesystem.write_bytes(path.read_bytes(), target)
            # The evaluate script reads this to find the submission, exactly as
            # the prepare step writes it in a real run.
            sandbox.filesystem.write_text(workspace, "/tmp/project-root.txt")
            sandbox.filesystem.write_text(
                "file:benchmark_adapter.py", "/tmp/adapter-source.txt"
            )

            from cogworks_runner.week3_payload import encode_payload

            print("staging the payload...", flush=True)
            sandbox.filesystem.write_bytes(
                encode_payload("language-search", cases, showcase=False),
                "/tmp/cog-week3-payload.zip",
            )
            sandbox.filesystem.write_text(modal_app.EVALUATE_SCRIPT, "/tmp/cog-evaluate.py")

            print("evaluating under python 3.8...", flush=True)
            process = sandbox.exec(
                modal_app.WEEK3_STUDENT_PYTHON, "/tmp/cog-evaluate.py", "language-search", "8192"
            )
            process.wait()
            if process.returncode != 0:
                stderr = process.stderr.read()
                print("\nFAILED after {:.0f}s".format(time.time() - started))
                print("  detail  {}".format(modal_app._last_error_line(stderr)))
                print("\n--- stderr tail ---\n{}".format(stderr[-1500:]))
                return 1
            predictions = json.loads(sandbox.filesystem.read_text("/tmp/cog-predictions.json"))
            log = sandbox.filesystem.read_text("/tmp/cog-student.log")
        finally:
            sandbox.terminate()

    metrics, diagnostics = modal_app._v2_metrics(benchmark, predictions, cases)
    print("\nPASSED in {:.0f}s".format(time.time() - started))
    for metric in metrics:
        print("  {:<26} {:.4f}{}".format(
            metric.key, metric.value, "  (primary)" if metric.primary else ""))
    for line in diagnostics:
        print("  note: {}".format(line))
    if log.strip():
        print("\n--- submission log (first 800 chars) ---\n{}".format(log[:800]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
