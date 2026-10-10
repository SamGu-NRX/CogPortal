"""Run (and later replay) the run-interference study against the real runner.

Run mode executes every batch in a manifest through the supervisor — which
drives the repository's real ``cogbench.runner.execute`` and
``cogbench.isolate.run_isolated`` — and records full evidence per batch under
``results/<stamp>/``. Replay mode (milestone 3) re-derives the detector
verdicts from those saved artifacts and compares them with what was recorded
at run time.

Host-level accounting here complements the supervisor's per-run evidence:
process counts and scratch-file counts before, during, and after the whole
run are the no-leftovers receipt for the run as a whole.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))

import detector  # noqa: E402
import evidence as ev  # noqa: E402
from supervisor import RunSupervisor, Limits  # noqa: E402

RESULTS_DIR = Path(__file__).resolve().parent / "results"
SCRATCH_GLOBS = ("/tmp/ri-",)  # the supervisor's mkdtemp prefixes all start here


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scratch_file_count() -> int:
    """Study scratch dirs alive under /tmp right now (ours are all prefixed)."""

    total = 0
    for prefix in SCRATCH_GLOBS:
        root = prefix.rstrip("/").rsplit("/", 1)[0]
        base = Path(root)
        if base.is_dir():
            total += sum(1 for entry in base.iterdir() if entry.name.startswith(Path(prefix).name))
    return total


def host_snapshot() -> Dict[str, Any]:
    return {
        "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "descendants": len(ev.descendant_pids()),
        "study_scratch_dirs": scratch_file_count(),
    }


def load_manifest(path: Path) -> Dict[str, Any]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if "batches" not in manifest or not isinstance(manifest["batches"], list):
        raise ValueError("manifest must hold a 'batches' list")
    return manifest


def summarize_batch(batch: Dict[str, Any]) -> Dict[str, Any]:
    """The headline numbers for one batch (full evidence lives beside it)."""

    evaluation = detector.evaluate(batch["runs"], batch["limits"], batch["module_state_series"])
    digests = [run["output"]["predictions_digest"] for run in batch["runs"]
               if run["output"]["predictions_digest"]]
    return {
        "id": batch["batch_id"],
        "mode": batch["spec"]["mode"],
        "purpose": batch["spec"]["purpose"],
        "adapters": list(batch["spec"]["adapters"]),
        "concurrency": int(batch["spec"].get("concurrency", 1)),
        "runs": len(batch["runs"]),
        "status_counts": _status_counts(batch["runs"]),
        "flagged_signals": evaluation["flagged_signals"],
        "agrees_with_expectation": evaluation["agrees_with_expectation"],
        "distinct_output_digests": len(set(digests)),
        "processes": batch["counts"]["processes"],
        "files": batch["counts"]["files"],
        "fds": batch["counts"].get("fds", {}),
        "supervision_reaped": len(batch["supervision"]["reaped"]),
        "remaining_after_sweep": len(batch["supervision"]["remaining_after_sweep"]),
        "interruption": batch.get("interruption"),
    }


def _status_counts(runs: List[Dict[str, Any]]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for run in runs:
        status = run["output"]["status"]
        counts[status] = counts.get(status, 0) + 1
    return counts


def _answer_identity(run: Dict[str, Any]) -> str:
    """Match key for two runs that should answer identically: the adapter
    plus a canonical form of its DECLARED inputs. The supervisor hands each
    run its own scratch directory, so the per-case 'workspace' field is
    environment, not question, and is stripped. The pre-run 'before'
    snapshot is the question actually asked — a mutated 'after' state must
    not split one question into two identities. Mode, run index, and
    scheduling are deliberately not part of the identity either: those are
    the things that must not change the answer."""

    inputs = run.get("inputs")
    if isinstance(inputs, dict):  # {"before": [...], "after": [...]} snapshots
        declared = inputs.get("before", inputs.get("after"))
        if declared is not None:
            inputs = declared
    if isinstance(inputs, list):
        inputs = [{key: value for key, value in case.items() if key != "workspace"}
                  if isinstance(case, dict) else case for case in inputs]
    return json.dumps({"adapter": run["adapter"], "inputs": inputs},
                      sort_keys=True, default=str)


def compare_batch_answers(runs_a: List[Dict[str, Any]],
                          runs_b: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Actual digest agreement between two run sets, by matched identity.

    The earlier comparison counted DISTINCT digests per batch: two different
    constant answers (X once in the sequential leg, Y once in the concurrent
    leg) both read as 'no spread' and passed as identical. This comparison
    indexes runs by adapter/input identity and requires both legs to have
    produced the SAME digest set for every identity present in both. Runs
    without an output digest (timed out or failed) carry no answer and are
    excluded rather than treated as a third answer.
    """

    def index(runs: List[Dict[str, Any]]) -> Dict[str, set]:
        index: Dict[str, set] = {}
        for run in runs:
            digest = run["output"]["predictions_digest"]
            if digest:
                index.setdefault(_answer_identity(run), set()).add(digest)
        return index

    index_a, index_b = index(runs_a), index(runs_b)
    matched = sorted(set(index_a) & set(index_b))
    identities = [{
        "adapter": json.loads(key)["adapter"],
        "inputs": json.loads(key)["inputs"],
        "digests_first": sorted(index_a[key]),
        "digests_second": sorted(index_b[key]),
        "agree": index_a[key] == index_b[key],
    } for key in matched]
    if not matched:
        verdict = "no-shared-identities"
    elif all(row["agree"] for row in identities):
        verdict = "identical"
    else:
        verdict = "differs"
    return {"matched_identities": identities, "verdict": verdict}


def build_answer_agreements(pairs: List[Dict[str, Any]],
                            batch_records: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Pairwise digest-identity comparisons the manifest declares.

    Each pair asserts what two legs of the same adapter set must do:
    'identical' for the clean equivalence pair, 'differs' for the
    different-answer control that proves the comparison can fail.
    """

    rows: List[Dict[str, Any]] = []
    for pair in pairs:
        first = batch_records.get(str(pair["sequential"]))
        second = batch_records.get(str(pair["concurrent"]))
        if first is None or second is None:
            rows.append({"id": pair["id"], "verdict": "missing-batches",
                         "agrees_with_expectation": False})
            continue
        row: Dict[str, Any] = {"id": pair["id"],
                               "sequential": pair["sequential"],
                               "concurrent": pair["concurrent"]}
        row.update(compare_batch_answers(first["runs"], second["runs"]))
        expect = str(pair.get("expect", "identical"))
        row["expect"] = expect
        row["agrees_with_expectation"] = row["verdict"] == expect
        rows.append(row)
    return rows


def run_manifest(manifest_path: Path, results_root: Path) -> Dict[str, Any]:
    manifest = load_manifest(manifest_path)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out_dir = results_root / stamp
    out_dir.mkdir(parents=True, exist_ok=False)

    before = host_snapshot()
    prior_runs = sorted(entry.name for entry in results_root.iterdir() if entry.is_dir())
    supervisor = RunSupervisor(limits=Limits(), log=lambda line: None)
    batch_summaries: List[Dict[str, Any]] = []
    batch_records: Dict[str, Dict[str, Any]] = {}
    sweep_record: Dict[str, List[int]] = {"reaped": [], "remaining": []}
    started = time.monotonic()
    try:
        for spec in manifest["batches"]:
            batch = supervisor.run_batch(spec)
            batch_path = out_dir / "batch-{}.json".format(spec["id"])
            batch_path.write_text(json.dumps(batch, indent=1, sort_keys=True), encoding="utf-8")
            batch_records[str(spec["id"])] = batch
            summary = summarize_batch(batch)
            summary["artifact"] = str(batch_path.relative_to(results_root))
            summary["artifact_sha256"] = sha256_file(batch_path)
            batch_summaries.append(summary)
    finally:
        # The run owns everything it spawned: a final sweep reaps any
        # straggler the batches left, and the accounting records whether
        # that sweep had to do anything at all.
        reaped, remaining = supervisor._sweep("post-run")
        sweep_record = {"reaped": [entry.get("pid") for entry in reaped],
                        "remaining": [entry.get("pid") for entry in remaining]}

    wall = round(time.monotonic() - started, 3)
    after = host_snapshot()
    files_after = sum(1 for _ in out_dir.iterdir())
    summary = {
        "run": stamp,
        "manifest": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "started_utc": before["utc"],
        "finished_utc": after["utc"],
        "wall_seconds": wall,
        "host": {
            "before": before,
            "after": after,
            "post_run_sweep": sweep_record,
            "study_scratch_dirs_delta": after["study_scratch_dirs"] - before["study_scratch_dirs"],
        },
        "results_dir": {"prior_runs": prior_runs, "files_written": files_after},
        "batches": batch_summaries,
        "answer_agreements": build_answer_agreements(
            manifest.get("answer_agreement_pairs", []), batch_records),
    }
    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=1, sort_keys=True), encoding="utf-8")
    print("run {} recorded to {}".format(stamp, out_dir))
    for entry in batch_summaries:
        print("  {:24s} runs={} flagged={} agrees={} status={}".format(
            entry["id"], entry["runs"], ",".join(entry["flagged_signals"]) or "-",
            entry["agrees_with_expectation"], entry["status_counts"]))
    print("  host: descendants {} -> {}, scratch dirs {} -> {}, post-run sweep reaped {}".format(
        before["descendants"], after["descendants"],
        before["study_scratch_dirs"], after["study_scratch_dirs"],
        len(sweep_record["reaped"])))
    return summary


def replay_answer_agreements(summary: Dict[str, Any],
                             batch_by_id: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Re-derive the recorded answer-agreement rows from saved artifacts.

    Current summaries record explicit answer_agreements pairs; older
    summaries recorded the global sequential_vs_concurrent verdict, which is
    re-derived here as pairwise digest-identity agreement across that
    section's clean batches. A row matches only when the re-derived verdict
    equals the recorded one - so the different-answer control that the old
    distinct-count comparison would have passed now fails any run that
    recorded it as identical.
    """

    rows: List[Dict[str, Any]] = []
    if "answer_agreements" in summary:
        for recorded in summary["answer_agreements"]:
            first = batch_by_id.get(str(recorded.get("sequential")))
            second = batch_by_id.get(str(recorded.get("concurrent")))
            if first is None or second is None:
                rows.append({"id": recorded["id"], "recorded_verdict": recorded.get("verdict"),
                             "derived_verdict": "missing-batches", "matches": False})
                continue
            derived = compare_batch_answers(first["runs"], second["runs"])
            derived_agrees = derived["verdict"] == str(recorded.get("expect", "identical"))
            rows.append({
                "id": recorded["id"],
                "sequential": recorded.get("sequential"),
                "concurrent": recorded.get("concurrent"),
                "recorded_verdict": recorded.get("verdict"),
                "derived_verdict": derived["verdict"],
                "recorded_agrees": recorded.get("agrees_with_expectation"),
                "derived_agrees": derived_agrees,
                "matched_identities": derived["matched_identities"],
                "matches": (derived["verdict"] == recorded.get("verdict")
                            and derived_agrees == recorded.get("agrees_with_expectation")),
            })
    elif "sequential_vs_concurrent" in summary:
        recorded = summary["sequential_vs_concurrent"]
        clean_ids = [row["id"] for row in recorded.get("clean_batches", [])]
        pairwise = []
        verdicts = []
        for i in range(len(clean_ids)):
            for j in range(i + 1, len(clean_ids)):
                first = batch_by_id.get(clean_ids[i])
                second = batch_by_id.get(clean_ids[j])
                if first is None or second is None:
                    continue
                comparison = compare_batch_answers(first["runs"], second["runs"])
                # Only pairs with matched identities are informative: two
                # clean batches running different adapters share no question,
                # which is compatible with identical answers, not evidence
                # of divergence.
                if comparison["matched_identities"]:
                    pairwise.append({"batches": [clean_ids[i], clean_ids[j]],
                                     "verdict": comparison["verdict"],
                                     "matched_identities": comparison["matched_identities"]})
                    verdicts.append(comparison["verdict"])
        if not verdicts:
            derived_verdict = "no-shared-identities"
        elif all(v == "identical" for v in verdicts):
            derived_verdict = "identical"
        else:
            derived_verdict = "differs"
        rows.append({"id": "sequential_vs_concurrent",
                     "recorded_verdict": recorded.get("verdict"),
                     "derived_verdict": derived_verdict,
                     "pairwise": pairwise,
                     "matches": derived_verdict == recorded.get("verdict")})
    return rows


def replay_results(results_root: Path) -> int:
    """Re-derive every saved batch's verdict from its own evidence.

    Two checks per batch. Integrity: each batch artifact must still hash to
    the sha256 the run recorded for it - otherwise the evidence was edited
    after the fact and no verdict can be trusted. Derivation: the detector
    runs again over the saved per-run evidence, and the fresh verdict is
    compared with what the run recorded. Replay therefore also catches
    detector changes made after the run: if the code changed, its verdict
    over the same bytes changes with it. Per-fixture drift is re-derived
    from the run's own recorded digests (predictions vs fresh-import
    baseline); the run records never stored a drift field, so drift has
    nothing recorded to disagree with - it is shown, not matched.

    Returns 0 when every batch re-derives to the recorded verdict, 1 otherwise.
    """

    summary_path = results_root / "summary.json"
    if not summary_path.is_file():
        runs = sorted(entry for entry in results_root.iterdir()
                      if entry.is_dir() and (entry / "summary.json").is_file())
        if not runs:
            raise SystemExit("no summary.json under {} - nothing to replay".format(results_root))
        results_root = runs[-1]  # latest recorded run
        summary_path = results_root / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))

    table: List[Dict[str, Any]] = []
    batch_by_id: Dict[str, Dict[str, Any]] = {}
    for recorded in summary["batches"]:
        # recorded["artifact"] is stored relative to results/, so resolve it
        # against the run dir first, then the results root.
        batch_path = results_root / recorded["artifact"]
        if not batch_path.is_file():
            batch_path = results_root.parent / recorded["artifact"]
        if sha256_file(batch_path) != recorded["artifact_sha256"]:
            raise SystemExit("artifact changed since the run: {}".format(batch_path))
        batch = json.loads(batch_path.read_text(encoding="utf-8"))
        batch_by_id[str(recorded["id"])] = batch
        fresh = detector.evaluate(batch["runs"], batch["limits"], batch["module_state_series"])
        runs_table = []
        for run in batch["runs"]:
            digest = run["output"]["predictions_digest"]
            baseline = run.get("baseline_output_digest")
            runs_table.append({
                "run_id": run["run_id"],
                "fixture": run["adapter"],
                "status": run["output"]["status"],
                "drift_from_fresh_import": bool(digest and baseline and digest != baseline),
            })
        table.append({
            "id": recorded["id"],
            "artifact": recorded["artifact"],
            "artifact_integrity": "verified",
            "recorded_flagged": recorded["flagged_signals"],
            "derived_flagged": fresh["flagged_signals"],
            "recorded_agrees": recorded["agrees_with_expectation"],
            "derived_agrees": fresh["agrees_with_expectation"],
            "matches": (fresh["flagged_signals"] == recorded["flagged_signals"]
                        and fresh["agrees_with_expectation"] == recorded["agrees_with_expectation"]),
            "runs": runs_table,
        })

    agreement_rows = replay_answer_agreements(summary, batch_by_id)
    all_match = all(row["matches"] for row in table) and all(row["matches"] for row in agreement_rows)
    replay_record = {
        "replayed_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "results_dir": str(results_root),
        "summary_sha256": sha256_file(summary_path),
        "all_match": all_match,
        "batches": table,
        "answer_agreements": agreement_rows,
    }
    replay_path = results_root / "replay.json"
    replay_path.write_text(json.dumps(replay_record, indent=1, sort_keys=True), encoding="utf-8")

    print("replay of {} (summary sha256 verified) - {}".format(
        results_root, "ALL MATCH" if all_match else "DISAGREEMENT"))
    for row in table:
        print("  {:24s} integrity={} recorded={} derived={} match={}".format(
            row["id"], row["artifact_integrity"],
            ",".join(row["recorded_flagged"]) or "-",
            ",".join(row["derived_flagged"]) or "-", row["matches"]))
        for run_row in row["runs"]:
            print("    {:28s} fixture={:18s} status={:10s} drift={}".format(
                run_row["run_id"], run_row["fixture"], run_row["status"],
                run_row["drift_from_fresh_import"]))
    for row in agreement_rows:
        print("  agreement {:24s} recorded={} derived={} match={}".format(
            row["id"], row["recorded_verdict"], row["derived_verdict"], row["matches"]))
        for identity in row.get("matched_identities", []):
            print("    identity adapter={:18s} agree={} first={} second={}".format(
                identity["adapter"], identity["agree"],
                ",".join(d[:12] for d in identity["digests_first"]),
                ",".join(d[:12] for d in identity["digests_second"])))
    print("replay table written to {}".format(replay_path))
    return 0 if all_match else 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, help="manifest to execute")
    parser.add_argument("--replay", type=Path, help="results root to replay from")
    args = parser.parse_args()
    if args.replay:
        raise SystemExit(replay_results(args.replay))
    if not args.manifest:
        parser.error("one of --manifest or --replay is required")
    run_manifest(args.manifest, RESULTS_DIR)


if __name__ == "__main__":
    main()
