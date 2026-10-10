"""Replay-regeneration agreement (M3, part 1).

The committed `results/` must be regenerable from recorded bytes alone:
running the replay mode executes no builder, and the regenerated summary must
be byte-identical to the committed one. A tampered recording must FAIL the
agreement check -- otherwise replay is a rubber stamp, not a check.
"""

import importlib.util
import json
import shutil
from pathlib import Path

from harness import HERE

RUN_SCRIPT = HERE / "run.py"


def _load_run_module():
    spec = importlib.util.spec_from_file_location("process_signals_run", RUN_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _results_dir() -> Path:
    results = HERE / "results"
    assert results.exists(), "committed results/ missing; run run.py --manifest first"
    return results


def _copy_results(tmp_path: Path) -> Path:
    target = tmp_path / "results"
    shutil.copytree(_results_dir(), target)
    return target


def test_replay_regenerates_committed_summary_without_executing_a_builder(tmp_path):
    run = _load_run_module()
    results_copy = _copy_results(tmp_path)

    regeneration = run.run_replay(results_copy, None)

    assert regeneration["builderExecutedDuringReplay"] is False
    assert regeneration["summaryAgrees"] is True, regeneration
    assert regeneration["regeneratedSummarySha256"] == regeneration["committedSummarySha256"]


def test_replay_detects_tampered_verdict_records(tmp_path):
    """Edit a recorded verdict; the replay must refuse to agree. The replay
    attests the aggregate records the summary is built from
    (confusion-table.json, determinism.json) -- per-run byte verification is
    out of scope for replay and covered by the live-run repeats instead."""
    run = _load_run_module()
    results_copy = _copy_results(tmp_path)

    tampered = results_copy / "confusion-table.json"
    payload = json.loads(tampered.read_text())
    payload["rows"][0]["verdict"] = "agree (tampered)"
    tampered.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")

    regeneration = run.run_replay(results_copy, None)

    assert regeneration["summaryAgrees"] is False, regeneration
    assert regeneration["regeneratedSummarySha256"] != regeneration["committedSummarySha256"]


def test_replay_scope_is_the_summary_records_not_per_run_bytes(tmp_path):
    """Documented boundary: tampering a per-run recording does not flip
    summary agreement, because the summary is derived from the aggregate
    records only. Recorded here so the guarantee is never overstated."""
    run = _load_run_module()
    results_copy = _copy_results(tmp_path)

    tampered = results_copy / "runs" / "week1-spread-usable.python.json"
    payload = json.loads(tampered.read_text())
    payload["firstLight"]["scoredRunCount"] += 1
    tampered.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")

    regeneration = run.run_replay(results_copy, None)

    assert regeneration["summaryAgrees"] is True


def test_replay_writes_regeneration_record_into_the_results_directory(tmp_path):
    run = _load_run_module()
    results_copy = _copy_results(tmp_path)

    run.run_replay(results_copy, None)

    record = results_copy / "regeneration.json"
    assert record.exists()
    payload = json.loads(record.read_text())
    assert payload["builderExecutedDuringReplay"] is False
