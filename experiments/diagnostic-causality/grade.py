"""Key-aware grading: claimed classes vs truth, cause-class counts, tables.

This module is the only consumer of key.json after measurement, and it runs
after every diagnosis and oracle verdict is already persisted. It never talks
to the benchmark.
"""
from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

from measure import bundle_text


def normalized_bundle_text(raw: dict) -> str:
    return bundle_text(raw)


def load_json(path: Path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def grade(results: Path, key: dict) -> dict:
    raw_dir = results / "raw"
    diagnoses = load_json(results / "diagnoses.json")
    oracles = load_json(results / "oracle.json")

    true_class = {d: e["cause_class"] for d, e in key["defects"].items()}
    rows = []
    for name in sorted(key["defects"]):
        oracle = oracles[name]
        diag = diagnoses[name]
        claimed = diag["diagnosis"]["claimed_class"]
        rows.append(
            {
                "variant": name,
                "true_class": true_class[name],
                "claimed_class": claimed,
                "claimed_points_at_true": claimed == true_class[name],
                "repair_restored_control": oracle["restored"],
                "diagnosis_correct": oracle["restored"],
                "non_actionable": diag["diagnosis"]["claimed_repair"].get("op") == "non_actionable",
            }
        )

    multi = []
    for name in sorted(key["multi_defect"]):
        oracle = oracles[name]
        members = key["multi_defect"][name]
        rounds = oracle["rounds"]
        claimed_seq = [
            (r.get("diagnosis") or {}).get("claimed_class", "match_at_start") for r in rounds
        ]
        multi.append(
            {
                "variant": name,
                "true_defects": members,
                "true_classes": [true_class[d] for d in members],
                "claimed_classes_by_round": claimed_seq,
                "rounds_recorded": len(rounds),
                "restored": oracle["restored"],
            }
        )

    # Indistinguishable pairs: identical normalized diagnostic bundles between
    # two single-defect variants.
    texts = {}
    for name in sorted(key["defects"]):
        raw = load_json(raw_dir / name / "bundle.json")
        texts[name] = normalized_bundle_text(raw)
    names = sorted(texts)
    indistinct = []
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            if texts[a] == texts[b]:
                indistinct.append({"variants": [a, b], "shared_bundle_sha_prefix": None})

    # Misleading witnesses: the diagnostic asserts a cause whose claimed
    # repair fails the oracle, or asserts a cause class other than the truth.
    witnesses = []
    for row in rows:
        if not row["repair_restored_control"] or not row["claimed_points_at_true"]:
            diag = diagnoses[row["variant"]]
            witnesses.append(
                {
                    "variant": row["variant"],
                    "true_class": row["true_class"],
                    "claimed_class": row["claimed_class"],
                    "evidence": diag["diagnosis"].get("evidence"),
                    "repair_restored_control": row["repair_restored_control"],
                }
            )

    cause_counts = Counter(row["true_class"] for row in rows)
    claimed_counts = Counter(row["claimed_class"] for row in rows)
    return {
        "single_defect": rows,
        "multi_defect": multi,
        "indistinguishable_pairs": indistinct,
        "misleading_witnesses": witnesses,
        "cause_class_counts": {
            "true": dict(sorted(cause_counts.items())),
            "claimed": dict(sorted(claimed_counts.items())),
        },
        "totals": {
            "single_defect_variants": len(rows),
            "diagnoses_correct": sum(1 for r in rows if r["diagnosis_correct"]),
            "claimed_class_matches_true": sum(1 for r in rows if r["claimed_points_at_true"]),
            "multi_defect_variants": len(multi),
            "multi_defect_restored": sum(1 for m in multi if m["restored"]),
        },
    }


def write_tables(tables_dir: Path, graded: dict) -> None:
    tables = tables_dir
    tables.mkdir(parents=True, exist_ok=True)

    with open(tables / "cause_classes.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
        writer.writerow(["variant", "true_class", "claimed_class", "claimed_points_at_true", "repair_restored_control", "diagnosis_correct", "non_actionable"])
        for row in graded["single_defect"]:
            writer.writerow(
                [
                    row["variant"],
                    row["true_class"],
                    row["claimed_class"],
                    row["claimed_points_at_true"],
                    row["repair_restored_control"],
                    row["diagnosis_correct"],
                    row["non_actionable"],
                ]
            )

    lines = ["# Multi-defect variants", ""]
    lines.append("| variant | true defects | claimed classes by round | rounds | restored |")
    lines.append("|---|---|---|---|---|")
    for row in graded["multi_defect"]:
        lines.append(
            "| {} | {} | {} | {} | {} |".format(
                row["variant"],
                ", ".join(row["true_defects"]),
                " -> ".join(row["claimed_classes_by_round"]) or "(none)",
                row["rounds_recorded"],
                row["restored"],
            )
        )
    lines.append("")
    (tables / "multi_defect.md").write_text("\n".join(lines), encoding="utf-8")

    lines = ["# Indistinguishable diagnostics", ""]
    if graded["indistinguishable_pairs"]:
        lines.append("Single-defect variants the instrument reports identically (normalized bundle text equal):")
        lines.append("")
        for pair in graded["indistinguishable_pairs"]:
            lines.append(f"- {pair['variants'][0]}  <->  {pair['variants'][1]}")
    else:
        lines.append("No two single-defect variants produced identical normalized bundles.")
    lines.append("")
    (tables / "indistinguishable.md").write_text("\n".join(lines), encoding="utf-8")
