"""Current-invocation gating for the TypeScript arm.

A TS comparison may only read outputs the worker produced during THIS
run.py invocation, with a matching run-id. A failed invocation must stay
unexercised even when output files from an earlier, already-committed run are
still sitting at the published paths -- file existence is never evidence that
the current run produced anything. The stale-file regression below seeds
exactly that trap: stale bytes whose diff would read as `confirmed` if the
old existence-based gate ever looked at them.
"""

import importlib.util
import json
import sys
from pathlib import Path

from harness import HERE

RUN_SCRIPT = HERE / "run.py"


def _load_run_module():
    spec = importlib.util.spec_from_file_location("process_signals_run", RUN_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _script(tmp_path: Path, name: str, body: str) -> Path:
    path = tmp_path / name
    path.write_text(body)
    return path


FAILING_WORKER = "import sys\nsys.stderr.write('boom: simulated worker failure\\n')\nsys.exit(1)\n"

# A canonical-shaped pair whose diff_paths equals the declared expected delta
# for ablate-scored-flag. If a gate ever reads these stale bytes, the
# ablation reports "confirmed" -- which is precisely what must not happen
# when the current invocation failed.
STALE_BASE = {
    "historyQuality": "usable",
    "stageFootprint": {},
    "firstLight": {"firstScoredAtMs": 1000, "scoredRunCount": 1},
    "boundaryChurn": [],
    "ownershipBreadth": {},
}
STALE_ABLATED = {
    "historyQuality": "usable",
    "stageFootprint": {},
    "firstLight": {"firstScoredAtMs": 2000, "scoredRunCount": 2},
    "boundaryChurn": [],
    "ownershipBreadth": {},
}


def _seed_stale_ablation(results: Path, ablation_id: str, base: dict, ablated: dict):
    ablations = results / "ablations"
    ablations.mkdir(parents=True, exist_ok=True)
    for label, doc in (("base", base), ("ablated", ablated)):
        (ablations / f"{ablation_id}.ts.{label}.json").write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")


def test_failing_current_run_leaves_stale_committed_outputs_unexercised(tmp_path, monkeypatch):
    run = _load_run_module()
    results = tmp_path / "results"
    _seed_stale_ablation(results, "ablate-scored-flag", STALE_BASE, STALE_ABLATED)
    stale_before = {
        path: path.read_bytes() for path in sorted((results / "ablations").glob("*.json"))
    }

    failing = (tmp_path, [sys.executable, str(_script(tmp_path, "failing_worker.py", FAILING_WORKER))])
    monkeypatch.setattr(run, "find_ts_invocation", lambda root: failing)

    confusion = run.run_live(results, HERE / "manifest.json")

    row = next(r for r in confusion["rows"] if r["kind"] == "ablation" and r["id"] == "ablate-scored-flag")
    assert row["tsDeltaPaths"] is None, "a failed current run must not read stale outputs"
    assert row["tsVerdict"].startswith("unexercised-ts"), row["tsVerdict"]
    assert not row["tsVerdict"].startswith("confirmed"), "the stale trap fired: the comparison read bytes this run never produced"

    record = json.loads((results / "ablations" / "ablate-scored-flag.ts.unexercised.json").read_text())
    assert record["ok"] is False and record["reason"] == "unexercised"
    assert record["runId"] == confusion["runId"], "the unexercised record names the run that failed"

    stale_after = {path: path.read_bytes() for path in sorted(stale_before)}
    assert stale_after == stale_before, "a failed invocation must not touch old output files"


def test_run_id_mismatch_is_never_published(tmp_path):
    run = _load_run_module()
    out = tmp_path / "published.json"
    wrong_id = _script(
        tmp_path,
        "wrong_id_worker.py",
        "import json, sys\n"
        "open(sys.argv[2], 'w').write(json.dumps({'historyQuality': 'usable'}))\n"
        "sys.stderr.write('run-id deadbeef\\n')\n",
    )
    record = run.run_ts_arm((tmp_path, [sys.executable, str(wrong_id)]), {}, out, "cafe001")
    assert record["ok"] is False
    assert "run-id" in record["detail"]
    assert not out.exists(), "an output without the matching run-id must never reach the published path"
    assert not list(tmp_path.glob("*.staged")), "staging must leave nothing behind"


def test_matching_run_id_publishes_the_output(tmp_path):
    run = _load_run_module()
    out = tmp_path / "published.json"
    good = _script(
        tmp_path,
        "good_worker.py",
        "import json, sys\n"
        "open(sys.argv[2], 'w').write(json.dumps({'historyQuality': 'usable'}))\n"
        "sys.stderr.write(f'run-id {sys.argv[4]}\\n')\n",
    )
    record = run.run_ts_arm((tmp_path, [sys.executable, str(good)]), {}, out, "cafe001")
    assert record["ok"] is True and record["runId"] == "cafe001"
    assert json.loads(out.read_text()) == {"historyQuality": "usable"}
    assert not list(tmp_path.glob("*.staged")), "the staged file is consumed by the publish"
