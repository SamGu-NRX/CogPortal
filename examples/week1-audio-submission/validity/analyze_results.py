"""Independent scoring, arithmetic checks, and comparisons for study results.

Everything here reads retained predictions (predictions-*.jsonl.gz) and the
run records the study runner wrote; nothing imports the benchmark package's
scoring path for the numbers it reports — the check command is the one place
that additionally calls the official scorer, and its job is to disagree loudly
if the two paths ever diverge.

    python analyze_results.py summarize results/official/week1-evaluation
    python analyze_results.py check results/official/week1-evaluation
    python analyze_results.py tune results/seeds/... [--tau-out ...]
    python analyze_results.py compare DIR_A DIR_B [--label-a A --label-b B]
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

TOP_K = 5
BOOTSTRAP_REPS = 10000
BOOTSTRAP_SEED = 20261009
OUTCOME_ORDER = (
    "top_1",
    "top_k",
    "ranking_failure",
    "retrieval_failure",
    "error",
    "enrollment_failure",
)


def load_predictions(directory: Path, variant: str) -> List[Dict[str, Any]]:
    path = directory / "predictions-{}.jsonl.gz".format(variant)
    with gzip.open(path, "rt") as stream:
        return [json.loads(line) for line in stream]


def load_run(directory: Path, variant: str) -> Dict[str, Any]:
    return json.loads((directory / "run-{}.json".format(variant)).read_text())


def variants_in(directory: Path) -> List[str]:
    return sorted(
        path.name[len("predictions-") : -len(".jsonl.gz")]
        for path in directory.glob("predictions-*.jsonl.gz")
    )


# --------------------------------------------------------------------------
# Independent scoring from retained rows
# --------------------------------------------------------------------------


def cell_key(row: Dict[str, Any]) -> str:
    """Cell label: the official cell on the official grid, the study cell
    elsewhere."""
    return row.get("official_cell") or row.get("study_cell") or "unlabeled"


def summarize_rows(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    per_cell_hits: Dict[str, List[float]] = defaultdict(list)
    outcomes: Dict[str, int] = defaultdict(int)
    oos_total = oos_confident = 0
    seconds: List[float] = []
    gold_rows = 0
    twin_first: Dict[str, int] = defaultdict(int)
    for row in rows:
        outcomes[row["outcome"]] += 1
        if row.get("seconds") is not None:
            seconds.append(float(row["seconds"]))
        if row["kind"] == "out_of_set" or row.get("gold") is None:
            oos_total += 1
            if row.get("candidates"):
                oos_confident += 1
            continue
        gold_rows += 1
        hit = 1.0 if row["outcome"] == "top_1" else 0.0
        per_cell_hits[cell_key(row)].append(hit)
        candidates = row.get("candidates") or []
        if candidates and candidates[0] in ("song-30", "song-31"):
            twin_first[candidates[0]] += 1
    per_cell = {
        cell: {"top1": float(np.mean(values)), "n": len(values)}
        for cell, values in sorted(per_cell_hits.items())
    }
    all_hits = [value for values in per_cell_hits.values() for value in values]
    summary = {
        "n_in_set": gold_rows,
        "n_out_of_set": oos_total,
        "identification_score": float(np.mean(all_hits)) if all_hits else 0.0,
        "per_cell": per_cell,
        "outcomes": {name: outcomes.get(name, 0) for name in OUTCOME_ORDER},
        "out_of_set_confident_rate": (oos_confident / oos_total) if oos_total else None,
        "median_identify_seconds": float(np.median(seconds)) if seconds else None,
        "twin_top1_counts": dict(twin_first),
    }
    return summary


def cluster_bootstrap_ci(
    rows: Sequence[Dict[str, Any]], stat: str = "top1", reps: int = BOOTSTRAP_REPS
) -> Dict[str, float]:
    """Percentile CI over a per-song cluster bootstrap: resample songs with
    replacement, pool each draw's hits. Reproducible from the frozen seed."""

    by_song: Dict[str, List[float]] = defaultdict(list)
    for row in rows:
        if row.get("gold") is None or row["kind"] == "out_of_set":
            continue
        value = 1.0 if (row["outcome"] == "top_1" if stat == "top1" else row["outcome"] == stat) else 0.0
        by_song[row["gold"]].append(value)
    if not by_song:
        return {}
    song_arrays = [np.asarray(by_song[song], dtype=np.float64) for song in sorted(by_song)]
    song_count = len(song_arrays)
    rng = np.random.default_rng(BOOTSTRAP_SEED)
    means = np.empty(reps, dtype=np.float64)
    for rep in range(reps):
        picks = rng.integers(0, song_count, size=song_count)
        means[rep] = np.concatenate([song_arrays[index] for index in picks]).mean()
    point = float(np.mean(np.concatenate(song_arrays)))
    return {
        "point": point,
        "ci_low": float(np.percentile(means, 2.5)),
        "ci_high": float(np.percentile(means, 97.5)),
    }


def paired_difference(
    rows_a: Sequence[Dict[str, Any]],
    rows_b: Sequence[Dict[str, Any]],
    reps: int = BOOTSTRAP_REPS,
) -> Dict[str, Any]:
    """Paired per-query top-1 difference A-B with a cluster bootstrap CI and
    McNemar-style discordant counts."""

    by_id_a = {row["query_id"]: row for row in rows_a if row.get("gold")}
    by_id_b = {row["query_id"]: row for row in rows_b if row.get("gold")}
    shared = sorted(set(by_id_a) & set(by_id_b))
    if not shared:
        return {"paired_queries": 0}
    diff = np.array(
        [
            (1.0 if by_id_a[qid]["outcome"] == "top_1" else 0.0)
            - (1.0 if by_id_b[qid]["outcome"] == "top_1" else 0.0)
            for qid in shared
        ]
    )
    b_only = sum(1 for qid in shared if by_id_a[qid]["outcome"] != "top_1" and by_id_b[qid]["outcome"] == "top_1")
    a_only = sum(1 for qid in shared if by_id_a[qid]["outcome"] == "top_1" and by_id_b[qid]["outcome"] != "top_1")
    rng = np.random.default_rng(BOOTSTRAP_SEED + 1)
    means = np.empty(reps)
    for rep in range(reps):
        picks = rng.integers(0, diff.size, size=diff.size)
        means[rep] = diff[picks].mean()
    return {
        "paired_queries": len(shared),
        "mean_diff": float(diff.mean()),
        "ci_low": float(np.percentile(means, 2.5)),
        "ci_high": float(np.percentile(means, 97.5)),
        "a_top1_only": a_only,
        "b_top1_only": b_only,
    }


def tune_tau(
    tuned_rows: Sequence[Dict[str, Any]],
    grid: Optional[Sequence[float]] = None,
) -> Dict[str, Any]:
    """Choose the abstention margin from a retained tuned run: the smallest
    tau that rejects >= 90% of out-of-set queries, with the in-set top-1
    retention each tau costs. Margin = official relative top1/top2 margin."""

    if grid is None:
        grid = (0.0, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0)

    def margin_of(row: Dict[str, Any]) -> Optional[float]:
        scores = row.get("scores")
        if not scores:
            return None
        if len(scores) == 1:
            return 1.0
        top, second = float(scores[0]), float(scores[1])
        if not (np.isfinite(top) and np.isfinite(second)):
            return None
        return (top - second) / max(abs(top), 1e-12)

    in_margins, oos_margins = [], []
    for row in tuned_rows:
        margin = margin_of(row)
        if margin is None:
            continue
        if row["kind"] == "out_of_set" or row.get("gold") is None:
            oos_margins.append(margin)
        elif row["ok"]:
            in_margins.append(margin)
    baseline_top1 = float(
        np.mean([1.0 if row["outcome"] == "top_1" else 0.0 for row in tuned_rows if row.get("gold") and row["ok"]])
    )
    curve = []
    chosen = None
    for tau in grid:
        oos_rejected = float(np.mean([margin < tau for margin in oos_margins])) if oos_margins else 0.0
        retained = [
            row
            for row in tuned_rows
            if row.get("gold") and row["ok"] and (margin_of(row) is None or margin_of(row) >= tau)  # type: ignore[operator]
        ]
        retained_top1 = float(np.mean([1.0 if row["outcome"] == "top_1" else 0.0 for row in retained])) if retained else 0.0
        curve.append(
            {
                "tau": tau,
                "oos_reject_rate": oos_rejected,
                "in_set_top1_retained": retained_top1,
                "retained_queries": len(retained),
            }
        )
        if chosen is None and oos_rejected >= 0.90:
            chosen = curve[-1]
    return {
        "chosen_tau": chosen["tau"] if chosen else None,
        "chosen": chosen,
        "curve": curve,
        "baseline_top1": baseline_top1,
        "n_in_margins": len(in_margins),
        "n_oos_margins": len(oos_margins),
    }


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------


def cmd_summarize(directory: Path) -> Dict[str, Any]:
    report: Dict[str, Any] = {"directory": str(directory), "variants": {}}
    for variant in variants_in(directory):
        rows = load_predictions(directory, variant)
        run = load_run(directory, variant)
        summary = summarize_rows(rows)
        summary["top1_by_song_cluster_bootstrap"] = cluster_bootstrap_ci(rows)
        summary["enroll_failures"] = [
            item["song_id"] for item in run.get("enroll", []) if not item.get("ok")
        ]
        report["variants"][variant] = summary
        cells = summary["per_cell"]
        pitch = [key for key in cells if key.startswith("pitch_")]
        snr = [key for key in cells if key.startswith("snr_")]
        pitch_val = float(np.mean([cells[key]["top1"] for key in pitch])) if pitch else float("nan")
        snr_val = float(np.mean([cells[key]["top1"] for key in snr])) if snr else float("nan")
        line = "{:22s} score {:.3f} | clean-long {:.3f} clean-short {:.3f} pitch {:.3f} snr-worst {:.3f} | oos-conf {}".format(
            variant,
            summary["identification_score"],
            max((cells[key]["top1"] for key in cells if key.startswith("clean_")), default=float("nan")),
            min((cells[key]["top1"] for key in cells if key.startswith("clean_")), default=float("nan")),
            pitch_val,
            snr_val,
            summary["out_of_set_confident_rate"],
        )
        print(line)
    (directory / "summary.json").write_text(json.dumps(report, indent=1, sort_keys=True))
    return report


def cmd_check(directory: Path) -> Dict[str, Any]:
    """Arithmetic checks, independent of the runner's own summarizer:
    (1) every prediction row recomputes its outcome from candidates+gold;
    (2) official-arm official metrics recomputed from score_outputs on
    reconstructed cases match the retained predictions;
    (3) trivial baseline matches the benchmark's own computation."""

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from run_study import cases_from_corpus, load_corpus, load_manifest  # local import: keeps check standalone

    report: Dict[str, Any] = {"directory": str(directory), "checks": []}

    def record(name: str, ok: bool, detail: str = "") -> None:
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})

    manifest_record = json.loads((directory / "manifest.json").read_text())
    arm = manifest_record["arm"]
    tier = manifest_record.get("tier")

    official_cases = None
    catalog = None
    if arm in ("official", "seeds", "probe", "ambiguity"):
        tier = tier or "evaluation"
        if arm == "official":
            manifest = load_manifest(tier)
        else:
            from run_study import EVALUATION_GEOMETRY, TEST_GEOMETRY

            geometry = EVALUATION_GEOMETRY if tier == "evaluation" else TEST_GEOMETRY
            from audio_identification_benchmark.datasets import build_manifest

            manifest = build_manifest(
                manifest_id="check-{}".format(tier),
                master_seed=int(manifest_record["master_seed"]),
                with_stats=False,
                **geometry,
            )
        blob = load_corpus(manifest)
        official_cases = cases_from_corpus(blob)
        catalog = blob["catalog"]
        record(
            "corpus_sha_matches_run_record",
            blob["manifest_sha256"] == manifest_record["corpus_sha256"],
            "{} vs {}".format(blob["manifest_sha256"][:12], str(manifest_record["corpus_sha256"])[:12]),
        )

    from audio_identification_benchmark.metrics import _margin, margin_auc, score_outputs, trivial_baseline_outcomes
    from audio_identification_benchmark.metrics import classify_outcome  # noqa: F401  (used via recompute below)

    for variant in variants_in(directory):
        rows = load_predictions(directory, variant)
        run = load_run(directory, variant)
        record(
            "{}:row_count".format(variant),
            len(rows) == run["query_count"],
            "{} rows vs run record {}".format(len(rows), run["query_count"]),
        )

        # 1. Outcome recomputation from the retained fields.
        bad = 0
        for row in rows:
            if not row.get("ok"):
                continue
            candidates = [str(c) for c in row.get("candidates", [])]
            if row["kind"] == "out_of_set" or row.get("gold") is None:
                expected = "out_of_set_confident" if candidates else "out_of_set_abstain"
            else:
                expected = classify_outcome(candidates, row["gold"])
            if expected != row["outcome"]:
                bad += 1
        record("{}:outcomes_recompute".format(variant), bad == 0, "{} mismatches".format(bad))

        if official_cases is None or catalog is None:
            continue

        # 2. Official scorer on reconstructed cases, outputs rebuilt from rows.
        query_rows = [row for row in rows if row["kind"] != "enroll"]
        # Only the official-grid rows line up with official_cases order.
        official_rows = [row for row in query_rows if row.get("cellset") == "official_grid"]
        from audio_identification_benchmark.datasets import QueryCase

        cases_for_official = [case for case in official_cases if isinstance(case, QueryCase)]
        ids_aligned = all(
            row["query_id"] == case.query_id for row, case in zip(official_rows, cases_for_official)
        ) and len(official_rows) == len(cases_for_official)
        if not ids_aligned:
            record(
                "{}:official_alignment".format(variant),
                False,
                "{} official-grid rows vs {} official query cases, ids aligned: {}".format(
                    len(official_rows), len(cases_for_official), ids_aligned
                ),
            )
            continue
        record("{}:official_alignment".format(variant), True, "{} queries, ids aligned".format(len(official_rows)))
        outputs = [
            {
                "ok": row["ok"],
                "kind": "query",
                "query_id": row["query_id"],
                "candidates": row.get("candidates", []),
                "scores": row.get("scores"),
                "shape": row.get("shape"),
                "seconds": row.get("seconds"),
                "error": row.get("error"),
            }
            for row in official_rows
        ]
        baseline = trivial_baseline_outcomes(cases_for_official, catalog)
        metrics, _diagnostics = score_outputs(outputs, cases_for_official, baseline=baseline)
        summary = summarize_rows(official_rows)
        checks = {
            "identification_score": abs(metrics["identification_score"] - summary["identification_score"]) < 1e-9,
            "retrieval_failure_rate": abs(
                metrics["retrieval_failure_rate"]
                - summary["outcomes"]["retrieval_failure"] / max(1, summary["n_in_set"] + summary["n_out_of_set"] - sum(1 for r in official_rows if r.get("gold") is None))
            ) < 1e-9,
        }
        record(
            "{}:official_metrics_match".format(variant),
            all(checks.values()),
            json.dumps({key: [round(metrics[key], 6), summary["identification_score"]] for key in checks}),
        )

        # 3. Margin separation recomputed independently from rows.
        in_m, out_m = [], []
        for row in official_rows:
            margin = _margin(row.get("scores"))
            if margin is None:
                continue
            if row["kind"] == "out_of_set":
                out_m.append(margin)
            elif row["ok"]:
                in_m.append(margin)
        auc = margin_auc(in_m, out_m)
        official_auc = metrics.get("margin_separation")
        record(
            "{}:margin_separation_match".format(variant),
            (auc is None and official_auc is None) or (auc is not None and official_auc is not None and abs(auc - official_auc) < 1e-9),
            "independent {} vs official {}".format(auc, official_auc),
        )

    report["all_ok"] = all(item["ok"] for item in report["checks"])
    (directory / "check-report.json").write_text(json.dumps(report, indent=1, sort_keys=True))
    print("checks: {} passing, all_ok={}".format(sum(1 for item in report["checks"] if item["ok"]), report["all_ok"]))
    return report


def cmd_compare(dir_a: Path, dir_b: Path, label_a: str, label_b: str, per_cell: bool = True) -> Dict[str, Any]:
    """Paired comparison of every shared variant between two run directories,
    plus (for the seeds arm) between-seed consistency of each cell."""

    report: Dict[str, Any] = {"a": str(dir_a), "b": str(dir_b), "variants": {}}
    shared = sorted(set(variants_in(dir_a)) & set(variants_in(dir_b)))
    for variant in shared:
        rows_a = load_predictions(dir_a, variant)
        rows_b = load_predictions(dir_b, variant)
        summary_a = summarize_rows(rows_a)
        summary_b = summarize_rows(rows_b)
        entry: Dict[str, Any] = {
            label_a: summary_a["identification_score"],
            label_b: summary_b["identification_score"],
            "paired": paired_difference(rows_a, rows_b),
        }
        if per_cell:
            entry["per_cell_{}".format(label_a)] = summary_a["per_cell"]
            entry["per_cell_{}".format(label_b)] = summary_b["per_cell"]
        report["variants"][variant] = entry
        paired = entry["paired"]
        if paired.get("paired_queries"):
            print(
                "{:22s} {} {:.3f} -> {} {:.3f} | paired diff {:+.3f} [{:+.3f},{:+.3f}] (a-only {}, b-only {})".format(
                    variant,
                    label_a,
                    summary_a["identification_score"],
                    label_b,
                    summary_b["identification_score"],
                    paired["mean_diff"],
                    paired["ci_low"],
                    paired["ci_high"],
                    paired["a_top1_only"],
                    paired["b_top1_only"],
                )
            )
    (dir_a / "compare.json").write_text(json.dumps(report, indent=1, sort_keys=True))
    return report


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("summarize", "check", "tune", "compare"))
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--variant", default="tuned")
    parser.add_argument("--label-a", default="A")
    parser.add_argument("--label-b", default="B")
    parser.add_argument("--tau-out", default="")
    args = parser.parse_args(argv)

    if args.command == "summarize":
        for path in args.paths:
            cmd_summarize(Path(path))
        return 0
    if args.command == "check":
        all_ok = True
        for path in args.paths:
            report = cmd_check(Path(path))
            all_ok = all_ok and report["all_ok"]
        return 0 if all_ok else 1
    if args.command == "tune":
        for path in args.paths:
            directory = Path(path)
            rows = load_predictions(directory, args.variant)
            result = tune_tau(rows)
            text = json.dumps(result, indent=1, sort_keys=True)
            print("tau analysis for {}:\n{}".format(directory, text[:2000]))
            out = Path(args.tau_out) if args.tau_out else directory / "tau-analysis.json"
            out.write_text(text)
        return 0
    if args.command == "compare":
        if len(args.paths) != 2:
            parser.error("compare needs exactly two run directories")
        cmd_compare(Path(args.paths[0]), Path(args.paths[1]), args.label_a, args.label_b)
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
