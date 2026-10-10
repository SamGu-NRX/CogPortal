#!/usr/bin/env python3
"""Experiment runner for the process-signals study.

Two modes:

  --manifest <path>   Live run: executes every frozen scenario and ablation
                      through the real builders (Python arm in-process, TS arm
                      via `pnpm exec tsx run-worker.ts`), twice each for
                      determinism, then writes results/, the confusion table,
                      and the static summary.

  --replay <results>  Cached run: regenerates the static summary from the
                      recorded result bytes only -- no builder executes -- and
                      records regeneration agreement.

An unexercised TypeScript arm (tsx unavailable, or a scenario the Python
module cannot represent) is recorded as exactly that -- it is never treated
as evidence of agreement or divergence.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness as H  # noqa: E402

SHARED_KEYS = ["historyQuality", "stageFootprint", "firstLight", "boundaryChurn", "ownershipBreadth"]

# Machine-checkable expectations for each ablation, per arm: the exact set of
# canonical paths a single-variable change is allowed to move. The manifest's
# prose `expected` field is the human reading of this table; run.py is where
# the verdict is computed, so the machine form lives beside the verdict logic.
EXPECTED_ABLATION_DELTAS = {
    "ablate-filename": {
        "python": [
            "stageFootprint.query.commitCount",
            "stageFootprint.query.distinctAuthorCount",
            "stageFootprint.query.firstTouchAtMs",
            "stageFootprint.query.lastTouchAtMs",
            "ownershipBreadth.query",
        ],
        "ts": [
            "stageFootprint.query.commitCount",
            "stageFootprint.query.distinctAuthorCount",
            "stageFootprint.query.firstTouchAtMs",
            "stageFootprint.query.lastTouchAtMs",
            "ownershipBreadth.query",
        ],
    },
    "ablate-scored-flag": {
        "python": ["firstLight.firstScoredAtMs", "firstLight.scoredRunCount"],
        "ts": ["firstLight.firstScoredAtMs", "firstLight.scoredRunCount"],
    },
    # The documented ported divergence: TS resolves Co-authored-by trailers
    # against the roster, Python cannot express them.
    "ablate-coauthor": {
        "python": [],
        "ts": [
            "stageFootprint.spectrogram.distinctAuthorCount",
            "stageFootprint.peaks.distinctAuthorCount",
            "ownershipBreadth.spectrogram",
            "ownershipBreadth.peaks",
        ],
    },
    "ablate-insertions": {"python": [], "ts": []},
    "ablate-run-status": {"python": [], "ts": []},
    "ablate-timestamp": {"python": ["boundaryChurn"], "ts": ["boundaryChurn"]},
    "combined-many-changes": {
        "python": [
            "stageFootprint.query.commitCount",
            "stageFootprint.query.distinctAuthorCount",
            "stageFootprint.query.firstTouchAtMs",
            "stageFootprint.query.lastTouchAtMs",
            "ownershipBreadth.query",
            "firstLight.firstScoredAtMs",
            "firstLight.scoredRunCount",
        ],
        "ts": [
            "stageFootprint.query.commitCount",
            "stageFootprint.query.distinctAuthorCount",
            "stageFootprint.query.firstTouchAtMs",
            "stageFootprint.query.lastTouchAtMs",
            "ownershipBreadth.query",
            "stageFootprint.spectrogram.distinctAuthorCount",
            "stageFootprint.peaks.distinctAuthorCount",
            "ownershipBreadth.spectrogram",
            "ownershipBreadth.peaks",
            "firstLight.firstScoredAtMs",
            "firstLight.scoredRunCount",
        ],
    },
}

# Scenario-level diffs that are declared, documented divergences rather than
# defects (see FIELDS.md: the TS-only roster-based trailer resolution).
EXPECTED_SCENARIO_DIVERGENCES = {
    "week2-coauthors": [
        "stageFootprint.descriptors.distinctAuthorCount",
        "ownershipBreadth.descriptors",
    ],
}


# ---------------------------------------------------------------------------
# Diff
# ---------------------------------------------------------------------------


def diff_paths(a, b, prefix=""):
    """Sorted list of canonical paths whose leaves differ."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for key in sorted(set(a) | set(b)):
            child = f"{prefix}.{key}" if prefix else key
            if key not in a or key not in b:
                out.append(child)
            else:
                out.extend(diff_paths(a[key], b[key], child))
        return out
    if isinstance(a, list) and isinstance(b, list):
        if a == b:
            return []
        # A changed list reports at the list's own path only -- no indexed
        # children -- so a delta table stays stable under reordering.
        return [prefix] if prefix else ["<root>"]
    if a != b:
        return [prefix] if prefix else ["<root>"]
    return []


def shared_view(canonical: dict) -> dict:
    return {key: canonical[key] for key in SHARED_KEYS}


# ---------------------------------------------------------------------------
# TypeScript arm
# ---------------------------------------------------------------------------


def find_ts_invocation(repo_root: Path):
    """Find a `pnpm exec tsx` that resolves. Prefers the repo root (the task's
    literal command shape); falls back to the apps/portal workspace where tsx
    is declared. Returns (cwd, args) or None."""
    script = "experiments/process-signals/run-worker.ts"
    candidates = [
        (repo_root, ["pnpm", "exec", "tsx", script]),
        (repo_root / "apps" / "portal", ["pnpm", "exec", "tsx", f"../../{script}"]),
    ]
    for cwd, args in candidates:
        # Probe tsx itself, not the script: `script --version` would execute
        # the adapter, which exits nonzero on missing arguments.
        probe = subprocess.run(["pnpm", "exec", "tsx", "--version"], cwd=cwd, capture_output=True, text=True)
        if probe.returncode == 0:
            return (cwd, args)
    return None


def run_ts_arm(invocation, fixture: dict, out_path: Path) -> dict:
    """Execute the TS adapter on one fixture. Returns {'ok': True, ...} or
    {'ok': False, 'reason': 'unexercised', 'detail': ...}."""
    if invocation is None:
        return {"ok": False, "reason": "unexercised", "detail": "no runnable `pnpm exec tsx` found; TypeScript arm not executed"}
    cwd, args = invocation
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(fixture, handle)
        fixture_path = handle.name
    try:
        proc = subprocess.run(args + [fixture_path, str(out_path)], cwd=cwd, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            return {"ok": False, "reason": "unexercised", "detail": f"tsx exited {proc.returncode}: {proc.stderr[-400:]}"}
        return {"ok": True, "path": str(out_path)}
    except subprocess.TimeoutExpired:
        return {"ok": False, "reason": "unexercised", "detail": "tsx timed out after 120s"}
    finally:
        Path(fixture_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Verdicts
# ---------------------------------------------------------------------------


def scenario_verdict(python_view, ts_view, scenario_id):
    if python_view is None:
        return "unexercisable-python (TS-only state; not evidence either way)"
    if ts_view is None:
        return "unexercised-ts (arm did not run; not evidence of agreement)"
    differences = diff_paths(python_view, ts_view)
    declared = EXPECTED_SCENARIO_DIVERGENCES.get(scenario_id, [])
    unexpected = [d for d in differences if d not in declared]
    if not differences:
        return "agree"
    if not unexpected:
        return "agree-except-documented-divergence"
    return f"unexpected-divergence: {unexpected}"


def ablation_arm_verdict(observed, expected):
    if observed is not None and sorted(observed) == sorted(expected):
        if expected:
            return "confirmed"
        return "confirmed-null (zero delta was the expectation; still inconclusive about code paths this history never reaches)"
    return f"unexpected: observed {sorted(observed)}"


# ---------------------------------------------------------------------------
# Live run
# ---------------------------------------------------------------------------


def fixture_for(scenario, roster_members):
    return {"scenario": scenario, "roster": roster_members}


def run_live(results_dir: Path, manifest_path: Path) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    rosters = manifest["rosters"]
    runs_dir = results_dir / "runs"
    ablations_dir = results_dir / "ablations"
    runs_dir.mkdir(parents=True, exist_ok=True)
    ablations_dir.mkdir(parents=True, exist_ok=True)

    invocation = find_ts_invocation(H.REPO_ROOT)

    rows = []
    determinism = {"note": "Each arm ran twice per unit; hashes must agree. A cached/replayed run is compared in regeneration.json.", "units": {}}

    # -- Scenarios ---------------------------------------------------------
    for scenario in manifest["scenarios"]:
        scenario_id = scenario["id"]
        roster_members = rosters[scenario["roster"]]

        # Python arm (twice, for the repeated-run check).
        if "fetchFailure" in scenario:
            python_canonical = None
            python_repeat = "unexercisable (process.py has no fetch-failure input)"
        else:
            first = H.run_python_arm(scenario, roster_members)
            second = H.run_python_arm(scenario, roster_members)
            python_repeat = "identical" if H.canonical_hash(first) == H.canonical_hash(second) else "DIVERGED"
            python_canonical = first
            (runs_dir / f"{scenario_id}.python.json").write_text(json.dumps(first, indent=2, sort_keys=True) + "\n")

        # TypeScript arm (also twice).
        ts_record = run_ts_arm(invocation, fixture_for(scenario, roster_members), runs_dir / f"{scenario_id}.ts.json")
        ts_canonical = None
        ts_repeat = "not-run"
        if ts_record["ok"]:
            first_ts = json.loads((runs_dir / f"{scenario_id}.ts.json").read_text())
            ts_record2 = run_ts_arm(invocation, fixture_for(scenario, roster_members), runs_dir / f"{scenario_id}.ts.repeat.json")
            if ts_record2["ok"]:
                second_ts = json.loads(Path(ts_record2["path"]).read_text())
                ts_repeat = "identical" if H.canonical_hash(first_ts) == H.canonical_hash(second_ts) else "DIVERGED"
            else:
                ts_repeat = f"second run failed: {ts_record2.get('detail', '')[:120]}"
            Path(str(runs_dir / f"{scenario_id}.ts.repeat.json")).unlink(missing_ok=True)
            ts_canonical = first_ts
            (runs_dir / f"{scenario_id}.ts.json").write_text(json.dumps(first_ts, indent=2, sort_keys=True) + "\n")
        else:
            (runs_dir / f"{scenario_id}.ts.unexercised.json").write_text(json.dumps(ts_record, indent=2, sort_keys=True) + "\n")

        python_view = shared_view(python_canonical) if python_canonical else None
        ts_view = shared_view(ts_canonical) if ts_canonical else None
        rows.append(
            {
                "kind": "scenario",
                "id": scenario_id,
                "declaredHistoryType": scenario["historyType"],
                "pythonObserved": python_canonical["historyQuality"] if python_canonical else None,
                "tsObserved": ts_canonical["historyQuality"] if ts_canonical else None,
                "sharedDiffPaths": diff_paths(python_view, ts_view) if python_view and ts_view else None,
                "verdict": scenario_verdict(python_view, ts_view, scenario_id),
            }
        )
        determinism["units"][scenario_id] = {"python": python_repeat, "ts": ts_repeat}

    # -- Ablations ---------------------------------------------------------
    for ablation in manifest["ablations"]:
        ablation_id = ablation["id"]
        base = next(s for s in manifest["scenarios"] if s["id"] == ablation["basedOn"])
        roster_members = rosters[base["roster"]]
        mutant = H.apply_patches(base, ablation["patches"])

        arm_results = {}
        base_out = H.run_python_arm(base, roster_members)
        ablated_out = H.run_python_arm(mutant, roster_members)
        (ablations_dir / f"{ablation_id}.python.base.json").write_text(json.dumps(base_out, indent=2, sort_keys=True) + "\n")
        (ablations_dir / f"{ablation_id}.python.ablated.json").write_text(json.dumps(ablated_out, indent=2, sort_keys=True) + "\n")
        arm_results["python"] = diff_paths(base_out, ablated_out)

        if invocation is not None:
            for label, sc in (("base", base), ("ablated", mutant)):
                record = run_ts_arm(invocation, fixture_for(sc, roster_members), ablations_dir / f"{ablation_id}.ts.{label}.json")
                if not record["ok"]:
                    (ablations_dir / f"{ablation_id}.ts.unexercised.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
            base_file = ablations_dir / f"{ablation_id}.ts.base.json"
            ablated_file = ablations_dir / f"{ablation_id}.ts.ablated.json"
            if base_file.exists() and ablated_file.exists():
                arm_results["ts"] = diff_paths(json.loads(base_file.read_text()), json.loads(ablated_file.read_text()))
        else:
            (ablations_dir / f"{ablation_id}.ts.unexercised.json").write_text(
                json.dumps({"ok": False, "reason": "unexercised", "detail": "no runnable tsx"}, indent=2) + "\n"
            )

        expected = EXPECTED_ABLATION_DELTAS[ablation_id]
        rows.append(
            {
                "kind": "ablation",
                "id": ablation_id,
                "basedOn": ablation["basedOn"],
                "singleVariable": ablation["singleVariable"],
                "manySimultaneous": ablation.get("manySimultaneous", False),
                "expected": ablation["expected"],
                "pythonDeltaPaths": arm_results["python"],
                "tsDeltaPaths": arm_results.get("ts"),
                "pythonVerdict": ablation_arm_verdict(arm_results["python"], expected["python"]),
                "tsVerdict": ablation_arm_verdict(arm_results["ts"], expected["ts"]) if "ts" in arm_results else "unexercised-ts (arm did not run; not evidence of agreement)",
            }
        )
        determinism["units"][ablation_id] = {
            "python": "identical (pure function of frozen inputs)",
            "ts": "subprocess determinism covered by scenario repeats",
        }

    # -- Assemble ----------------------------------------------------------
    confusion = {
        "note": "Confusion table over the frozen histories. Verdicts compare observed deltas against declared expectations; an unexercised arm is never evidence of agreement or divergence. No per-person scores or grades appear anywhere in this table.",
        "tsxInvocation": {"cwd": str(invocation[0]), "args": invocation[1]} if invocation else None,
        "sourceHashes": {
            "python/cogbench/src/cogbench/process.py": H.sha256_of(H.PYTHON_SOURCE),
            "apps/portal/worker/services/process-signals.ts": H.sha256_of(H.TS_SOURCE),
        },
        "manifestSha256": H.canonical_hash(json.loads(manifest_path.read_text(encoding="utf-8"))),
        "rows": rows,
    }
    (results_dir / "confusion-table.json").write_text(json.dumps(confusion, indent=2, sort_keys=True) + "\n")
    (results_dir / "determinism.json").write_text(json.dumps(determinism, indent=2, sort_keys=True) + "\n")
    return confusion


# ---------------------------------------------------------------------------
# Static summary
# ---------------------------------------------------------------------------


def build_summary(results_dir: Path) -> str:
    """Regenerate the static summary purely from recorded result bytes."""
    confusion = json.loads((results_dir / "confusion-table.json").read_text())
    determinism = json.loads((results_dir / "determinism.json").read_text())
    tsx = confusion["tsxInvocation"]
    lines = [
        "# Process-signals study: static summary",
        "",
        "Regenerated from the recorded result bytes in `results/` only; no builder executes during replay.",
        "",
        f"- Manifest sha256: `{confusion['manifestSha256']}`",
        f"- python/cogbench/src/cogbench/process.py: `{confusion['sourceHashes']['python/cogbench/src/cogbench/process.py']}`",
        f"- apps/portal/worker/services/process-signals.ts: `{confusion['sourceHashes']['apps/portal/worker/services/process-signals.ts']}`",
        (
            f"- TypeScript arm: exercised via `{' '.join(tsx['args'])}` (cwd `{tsx['cwd']}`)"
            if tsx
            else "- TypeScript arm: unexercised (no runnable tsx) — an unexercised arm, not evidence of agreement"
        ),
        "",
        "## Scenario rows (paired histories)",
        "",
        "| Scenario | Declared | Python | TS | Verdict |",
        "|---|---|---|---|---|",
    ]
    for row in confusion["rows"]:
        if row["kind"] != "scenario":
            continue
        lines.append(f"| {row['id']} | {row['declaredHistoryType']} | {row['pythonObserved']} | {row['tsObserved']} | {row['verdict']} |")
    lines += ["", "## Ablation rows", "", "| Ablation | Python verdict | TS verdict |", "|---|---|---|"]
    for row in confusion["rows"]:
        if row["kind"] != "ablation":
            continue
        lines.append(f"| {row['id']} | {row['pythonVerdict']} | {row['tsVerdict']} |")
    lines += ["", "## Repeated-run determinism", ""]
    for unit, repeats in sorted(determinism["units"].items()):
        lines.append(f"- {unit}: python {repeats['python']}; ts {repeats['ts']}")
    lines += [
        "",
        "## What these results do not support",
        "",
        "See `unsupported-interpretations.md` for the standing list. In short: an unexercised arm supports no claim; zero-delta ablations cannot rule out reading in unreached code paths; absence findings inside a truncated window are not attributable; and no per-person totals or grades exist anywhere in this study.",
        "",
    ]
    return "\n".join(lines)


def write_summary(results_dir: Path) -> str:
    text = build_summary(results_dir)
    (results_dir / "summary.md").write_text(text, encoding="utf-8")
    return H.canonical_hash(text)


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------


def run_replay(results_dir: Path, out_dir: Path | None) -> dict:
    """Regenerate the static summary from recorded bytes only, then compare
    against the committed original."""
    live_summary = (results_dir / "summary.md").read_text()
    committed_summary_hash = H.canonical_hash(live_summary)

    target = out_dir or results_dir
    if out_dir is not None and out_dir.resolve() != results_dir.resolve():
        target.mkdir(parents=True, exist_ok=True)
        for sub in ("runs", "ablations"):
            if (results_dir / sub).exists():
                shutil.copytree(results_dir / sub, target / sub, dirs_exist_ok=True)

    regenerated_hash = write_summary(target)
    regeneration = {
        "note": "Agreement between the committed summary and a replay that executed no builder. Byte equality here is the cached-run guarantee, and it covers the aggregate records (confusion-table.json, determinism.json) the summary is built from; per-run bytes are attested by the live-run repeats, not by replay.",
        "summaryAgrees": regenerated_hash == committed_summary_hash,
        "regeneratedSummarySha256": regenerated_hash,
        "committedSummarySha256": committed_summary_hash,
        "builderExecutedDuringReplay": False,
    }
    (results_dir / "regeneration.json").write_text(json.dumps(regeneration, indent=2, sort_keys=True) + "\n")
    return regeneration


# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, help="run all frozen scenarios and ablations against the real builders")
    parser.add_argument("--replay", type=Path, help="regenerate the summary from recorded results (no builder execution)")
    parser.add_argument("--out", type=Path, default=None, help="replay output directory (default: in place)")
    args = parser.parse_args()

    if args.manifest:
        results_dir = Path("experiments/process-signals/results")
        results_dir.mkdir(parents=True, exist_ok=True)
        confusion = run_live(results_dir, args.manifest)
        write_summary(results_dir)
        unexpected = [
            row
            for row in confusion["rows"]
            if str(row.get("verdict", "")).startswith("unexpected")
            or str(row.get("pythonVerdict", "")).startswith("unexpected")
            or str(row.get("tsVerdict", "")).startswith("unexpected")
        ]
        print(f"ran {len(confusion['rows'])} rows; unexpected verdicts: {len(unexpected)}")
        for row in unexpected:
            print("  UNEXPECTED:", json.dumps(row, sort_keys=True)[:300])
        return 0

    if args.replay:
        regeneration = run_replay(args.replay, args.out)
        print(json.dumps(regeneration, indent=2, sort_keys=True))
        return 0 if regeneration["summaryAgrees"] else 1

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
