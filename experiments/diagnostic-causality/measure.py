"""Drive the real cogbench CLI against a variant project directory.

Every capture goes through `python -m cogbench` in a subprocess rooted at the
variant directory: `check` (readiness/survey render), `test` (one scored case
through the benchmark driver and scorer), `run` (the full public practice
benchmark tier), and `report` (the saved local report). Nothing here reads the
defect/repair key.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

BENCHMARK = "audio-identification"
SUBPROCESS_TIMEOUT_S = 900


def _env() -> dict:
    env = dict(os.environ)
    # Freeze set/hash ordering so outcomes are byte-reproducible across runs.
    env["PYTHONHASHSEED"] = "0"
    return env


def run_cli(variant_dir: Path, command: str, extra: tuple = ()) -> dict:
    proc = subprocess.run(
        [sys.executable, "-m", "cogbench", command, "--benchmark", BENCHMARK, "--json", *extra],
        cwd=str(variant_dir),
        env=_env(),
        capture_output=True,
        text=True,
        timeout=SUBPROCESS_TIMEOUT_S,
    )
    payload = None
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        payload = None
    return {
        "command": command,
        "exit": proc.returncode,
        "json": payload,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def measure_variant(variant_dir: Path, *, with_run: bool = False) -> dict:
    """check + test (+ report when a report was saved) for one variant."""
    bundle = {"check": run_cli(variant_dir, "check"), "test": run_cli(variant_dir, "test")}
    if with_run:
        bundle["run"] = run_cli(variant_dir, "run")
    bundle["report"] = run_cli(variant_dir, "report")
    return bundle


def bundle_text(bundle: dict) -> str:
    """Everything the instrument said, as one normalized text block.

    The diagnose step reads only this: the rendered diagnostics, the raised
    records, and the metric lines the CLI chose to print.
    """
    parts = []
    for command in ("check", "test", "run", "report"):
        captured = bundle.get(command) or {}
        parts.append(f"### {command} (exit {captured.get('exit')})")
        payload = captured.get("json")
        if isinstance(payload, dict):
            if "diagnostics" in payload:
                parts.extend(str(line) for line in payload["diagnostics"])
            for key in ("submissionError", "detail", "status"):
                if payload.get(key):
                    parts.append(f"{key}: {payload[key]}")
            metrics = payload.get("metrics") or []
            for metric in metrics:
                parts.append(f"metric {metric.get('key')} = {metric.get('value')}")
        elif captured.get("stdout"):
            parts.append(captured["stdout"])
    return "\n".join(parts)


def outcome_of(bundle: dict) -> dict:
    """The measured outcome a repaired variant must reproduce: metrics and
    the outcome-split diagnostic line, from the `test` capture."""
    payload = (bundle.get("test") or {}).get("json") or {}
    metrics = {}
    for metric in payload.get("metrics") or []:
        metrics[metric.get("key")] = metric.get("value")
    split = next(
        (str(line) for line in payload.get("diagnostics") or [] if "Outcome split" in str(line)),
        None,
    )
    return {"metrics": metrics, "outcome_split": split}


#: Metrics that are timing measurements, not behavior: they move between
#: identical runs, so outcome equality excludes them.
NONDETERMINISTIC_METRICS = {"median_identify_seconds"}


def outcomes_match(a: dict, b: dict) -> bool:
    """Outcome equality for the oracle criterion, ignoring timing metrics."""
    metrics_a = {k: v for k, v in a["metrics"].items() if k not in NONDETERMINISTIC_METRICS}
    metrics_b = {k: v for k, v in b["metrics"].items() if k not in NONDETERMINISTIC_METRICS}
    return metrics_a == metrics_b and a["outcome_split"] == b["outcome_split"]
