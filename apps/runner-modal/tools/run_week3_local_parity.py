"""Run the Week 3 evaluation exactly as the Modal sandbox would, locally.

What is real here: the EVALUATE_SCRIPT string itself (pulled from
modal_app.py by AST so this works where the modal client cannot install),
the gold-free payload staged at the same /tmp path, the subprocess boundary,
the predictions/log files, the controller-side scoring, and the signed
runner events (written to a JSONL sink instead of the portal).

What is not: the sandbox isolation itself (network block, memory ceiling).

Run this under Python 3.8. The evaluate script asserts the version exactly as
it does in the sandbox, so any other interpreter fails immediately.

Usage, inside an environment where the benchmark and a submission are
installed:

    python apps/runner-modal/tools/run_week3_local_parity.py [test|evaluation]
"""

from __future__ import annotations

import ast
import json
import os
import pathlib
import subprocess
import sys
import time

REPO = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "apps" / "runner-modal" / "src"))

from cogworks_runner.protocol import canonical_json, signature  # noqa: E402
from cogworks_runner.week3_payload import encode_payload  # noqa: E402

MODAL_APP = REPO / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"
PAYLOAD_PATH = pathlib.Path("/tmp/cog-week3-payload.zip")
SCRIPT_PATH = pathlib.Path("/tmp/cog-evaluate.py")
PREDICTIONS_PATH = pathlib.Path("/tmp/cog-predictions.json")
LOG_PATH = pathlib.Path("/tmp/cog-student.log")
SINK = pathlib.Path("/tmp/week3-parity-events.jsonl")
MAX_OUTPUT_BYTES = 8 * 1024
SIGNING_SECRET = "parity-secret"


def evaluate_script() -> str:
    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if getattr(target, "id", None) == "EVALUATE_SCRIPT":
                    return ast.literal_eval(node.value)
    raise SystemExit("EVALUATE_SCRIPT not found in modal_app.py")


def emit(events: list, event_type: str, **fields) -> None:
    event = {
        "protocolVersion": "1",
        "eventId": "event_parity_{}_{}".format(len(events), int(time.time() * 1000)),
        "runId": "run_parity",
        "sequence": len(events),
        "occurredAt": int(time.time() * 1000),
        "type": event_type,
        **fields,
    }
    body = canonical_json(event)
    timestamp = str(int(time.time()))
    record = {
        "event": event,
        "headers": {
            "X-Cogworks-Timestamp": timestamp,
            "X-Cogworks-Key-Id": "runner-v1",
            "X-Cogworks-Signature": "v1=" + signature(SIGNING_SECRET, timestamp, body),
        },
    }
    events.append(record)
    with SINK.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record) + "\n")


def main() -> None:
    tier = sys.argv[1] if len(sys.argv) > 1 else "test"
    # The evaluate script asserts 3.8 the same way it does in the sandbox, and
    # this tool runs it under whatever interpreter invoked us. Without this
    # check the assertion surfaces as a nonzero exit and gets reported below
    # as a `student_runtime` failure, which blames the submission for the
    # operator's choice of interpreter.
    if sys.version_info[:2] != (3, 8):
        raise SystemExit(
            "Run this under Python 3.8; the sandbox pins CPython 3.8.20 and the "
            "evaluate script asserts it. Current interpreter: {}".format(
                sys.version.split()[0]
            )
        )
    from cogbench.plugins import load_benchmark

    SINK.unlink(missing_ok=True)
    events: list = []
    benchmark = load_benchmark("language-search")
    cases = list(benchmark.load_cases(tier))
    emit(
        events,
        "status",
        status="evaluating",
        elapsedMs=0,
        progress={"current": 0, "total": len(cases), "unit": "cases"},
    )

    PAYLOAD_PATH.write_bytes(encode_payload("language-search", cases, showcase=True))
    SCRIPT_PATH.write_text(evaluate_script(), encoding="utf-8")
    started = time.time()
    # The sandbox image sets PYTHONPATH=/opt/cogbench:/opt/runner; the local
    # equivalent of /opt/runner is the runner src tree (cogbench is installed).
    env = dict(os.environ)
    runner_src = str(REPO / "apps" / "runner-modal" / "src")
    env["PYTHONPATH"] = runner_src + (
        os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
    )
    process = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "language-search", str(MAX_OUTPUT_BYTES)],
        capture_output=True,
        text=True,
        timeout=900,
        env=env,
    )
    elapsed = time.time() - started
    if process.returncode != 0:
        lines = [line for line in process.stderr.splitlines() if line.strip()]
        detail = lines[-1] if lines else "Evaluation failed."
        emit(
            events,
            "failed",
            failure={
                "category": "student_runtime",
                "phase": "evaluating",
                "detail": detail[:240],
                "infrastructure": False,
            },
        )
        raise SystemExit("sandbox script failed: {}".format(detail))

    predictions = json.loads(PREDICTIONS_PATH.read_text(encoding="utf-8"))
    student_log = LOG_PATH.read_text(encoding="utf-8")[:MAX_OUTPUT_BYTES]
    assert len(predictions) == len(cases), "component count mismatch"

    scores = benchmark.score(predictions, cases)
    assert set(scores) >= {"overall", "text_mrr", "retrieval_mrr", "search_mrr"}
    emit(events, "status", status="scoring", elapsedMs=int(elapsed * 1000))
    emit(
        events,
        "completed",
        result={
            "protocolVersion": "1",
            "benchmarkId": "language-search",
            "benchmarkVersion": 1,
            "metrics": [
                {
                    "key": key,
                    "label": benchmark.metric_labels.get(key, key),
                    "value": float(value),
                    "unit": None,
                    "higherIsBetter": key not in benchmark.lower_is_better,
                    "primary": key == "overall",
                    "precision": 3,
                }
                for key, value in scores.items()
            ],
            "diagnostics": list(benchmark.last_diagnostics),
            "outputDigest": "0" * 64,
        },
        preparedArtifactId="parity",
        environmentDigest="0" * 64,
        sanitizedLog=student_log,
    )

    print("parity run ({} tier): {:.1f}s in-script".format(tier, elapsed))
    for key in sorted(scores):
        print("  {:<24} {:.4f}".format(key, scores[key]))
    showcase_lines = [
        line for line in student_log.splitlines() if line.startswith("showcase")
    ]
    print("  showcase lines in sandbox log: {}".format(len(showcase_lines)))
    print("  events written to {}: {}".format(SINK, len(events)))
    assert showcase_lines, "showcase lines missing from the sandbox log"
    assert scores["overall"] > 3 * scores["chance_mrr"], "reference should clear chance"
    print("parity acceptance passed")


if __name__ == "__main__":
    main()
