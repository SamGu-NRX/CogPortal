"""Run every variant against the benchmark and print what the instrument does.

This is the measurement, not a test. It answers four questions that decide
whether the Week 1 grid is worth shipping:

- does tuned outscore detuned outscore trivial outscore chance, and by how
  much;
- which grid cells separate tuned from detuned and which saturate at 1.00;
- how much of that separation comes from the pitch axis;
- how big is run-to-run variance across manifest seeds, since a gap smaller
  than that variance is noise.

    /tmp/w1py38/bin/python calibrate.py --tier test
    /tmp/w1py38/bin/python calibrate.py --tier test --seeds 3 --json out.json

``--seeds N`` rebuilds N alternate manifests with fresh master seeds (using
the benchmark's own ``build_manifest``, so the corpus statistics and the sha256
pins are generated the same way the shipped manifests were) and reruns every
variant against each. Those manifests are not written to the package; they
exist only for the variance estimate.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audio_identification_benchmark.contracts import TOP_K  # noqa: E402
from audio_identification_benchmark.datasets import (  # noqa: E402
    QueryCase,
    build_manifest,
    load_manifest,
    materialize_cases,
)
from audio_identification_benchmark.drivers import run_cases  # noqa: E402
from audio_identification_benchmark.metrics import (  # noqa: E402
    _cell_of,
    classify_outcome,
    score_outputs,
    trivial_baseline_outcomes,
)
from audio_identification_benchmark.plugins import AudioIdentificationBenchmark  # noqa: E402
from reference_shazam.variants import VARIANTS  # noqa: E402

#: Metric columns printed for every variant, in the order a reader wants them.
METRIC_ORDER = (
    "identification_score",
    "clean_top1",
    "short_clip_top1",
    "noisy_top1",
    "pitch_top1",
    "retrieval_failure_rate",
    "ranking_failure_rate",
    "margin_separation",
    "chance_top1",
    "trivial_baseline_top1",
    "median_identify_seconds",
)

#: Geometry of the shipped test tier, so a variance manifest is the same size
#: as the one being calibrated. Mirrors tools/build_manifests.py.
TEST_GEOMETRY = dict(
    song_count=8,
    out_of_set_count=2,
    duration_seconds=12.0,
    long_clip=6.0,
    short_clip=2.0,
)
EVALUATION_GEOMETRY = dict(
    song_count=30,
    out_of_set_count=6,
    duration_seconds=45.0,
    long_clip=10.0,
    short_clip=3.0,
)


def per_cell_top1(outputs: Sequence[Dict[str, Any]], cases: Sequence[Any]) -> Dict[str, float]:
    """Top-1 accuracy per grid cell, recomputed the way the scorer bins it.

    The scorer collapses cells into four headline numbers; the calibration
    question is which individual cell separates variants, so the same binning
    (``metrics._cell_of``) is applied here and kept.
    """

    per_cell: Dict[str, List[float]] = {}
    for case, output in zip(cases, outputs):
        if not isinstance(case, QueryCase) or case.kind != "in_set":
            continue
        cell = _cell_of(case)
        if not output.get("ok"):
            per_cell.setdefault(cell, []).append(0.0)
            continue
        candidates = [str(value) for value in output.get("candidates", [])]
        outcome = classify_outcome(candidates, case.gold_song_id, TOP_K)
        per_cell.setdefault(cell, []).append(1.0 if outcome == "top_1" else 0.0)
    return {cell: float(np.mean(values)) for cell, values in sorted(per_cell.items())}


def run_variant(name: str, cases: Sequence[Any], baseline: Dict[str, float]) -> Dict[str, Any]:
    """One variant, one case list. Returns metrics, per-cell, diagnostics."""

    benchmark = AudioIdentificationBenchmark()
    resources = benchmark.model_factory()
    original_cwd = os.getcwd()
    started = time.time()
    try:
        outputs = run_cases(VARIANTS[name], resources, cases)
    finally:
        # run_cases chdirs into its scratch directory on purpose; put this
        # process back so the next variant's relative paths still resolve.
        os.chdir(original_cwd)
    metrics, diagnostics = score_outputs(outputs, cases, TOP_K, baseline)
    return {
        "variant": name,
        "metrics": metrics,
        "per_cell": per_cell_top1(outputs, cases),
        "diagnostics": diagnostics,
        "wall_seconds": round(time.time() - started, 2),
    }


def run_all(cases: Sequence[Any], names: Sequence[str]) -> List[Dict[str, Any]]:
    catalog = {
        case.song_id: case.samples for case in cases if getattr(case, "kind", "") == "enroll"
    }
    baseline = trivial_baseline_outcomes(cases, catalog)
    results = []
    for name in names:
        result = run_variant(name, cases, baseline)
        results.append(result)
        print(
            "  {:<16} identification_score {:.4f}  ({:.0f}s)".format(
                name, result["metrics"]["identification_score"], result["wall_seconds"]
            )
        )
        sys.stdout.flush()
    return results


def print_metric_table(results: Sequence[Dict[str, Any]]) -> None:
    names = [result["variant"] for result in results]
    print()
    print("| metric | " + " | ".join(names) + " |")
    print("| --- |" + " --- |" * len(names))
    for key in METRIC_ORDER:
        cells = []
        for result in results:
            value = result["metrics"].get(key)
            cells.append("not measured" if value is None else "{:.4f}".format(value))
        print("| `{}` | ".format(key) + " | ".join(cells) + " |")


def print_cell_table(results: Sequence[Dict[str, Any]]) -> None:
    names = [result["variant"] for result in results]
    cells = sorted({cell for result in results for cell in result["per_cell"]})
    print()
    print("| grid cell | " + " | ".join(names) + " |")
    print("| --- |" + " --- |" * len(names))
    for cell in cells:
        row = [
            "{:.3f}".format(result["per_cell"].get(cell, float("nan"))) for result in results
        ]
        print("| `{}` | ".format(cell) + " | ".join(row) + " |")


def variance_run(
    tier: str, seeds: Sequence[int], names: Sequence[str]
) -> List[Dict[str, Any]]:
    """Rebuild the tier under alternate master seeds and rerun every variant."""

    geometry = TEST_GEOMETRY if tier == "test" else EVALUATION_GEOMETRY
    runs: List[Dict[str, Any]] = []
    for seed in seeds:
        print("\n-- variance manifest, master_seed={} --".format(seed))
        manifest = build_manifest(
            manifest_id="calibration-{}-{}".format(tier, seed),
            master_seed=int(seed),
            with_stats=False,
            **geometry
        )
        cases = materialize_cases(manifest)
        results = run_all(cases, names)
        runs.append({"master_seed": int(seed), "results": results})
    return runs


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", default="test", choices=("test", "evaluation"))
    parser.add_argument(
        "--seeds",
        type=int,
        default=0,
        help="how many alternate-seed manifests to also run, for the variance estimate",
    )
    parser.add_argument("--json", default="", help="write the full result set here")
    parser.add_argument(
        "--variants",
        default=",".join(VARIANTS),
        help="comma-separated subset of variants to run",
    )
    args = parser.parse_args(argv)

    names = [name.strip() for name in args.variants.split(",") if name.strip()]
    unknown = [name for name in names if name not in VARIANTS]
    if unknown:
        parser.error("unknown variants: {}".format(", ".join(unknown)))

    manifest = load_manifest(args.tier)
    print(
        "manifest {} ({}), {} songs, {} unseen, {} queries".format(
            manifest["manifest_id"],
            manifest["corpus_version"],
            len(manifest["songs"]),
            len(manifest["out_of_set_songs"]),
            len(manifest["queries"]),
        )
    )
    print("corpus stats: {}".format(json.dumps(manifest.get("corpus_stats", {}), sort_keys=True)))
    print("\n-- shipped manifest --")
    cases = materialize_cases(manifest)
    results = run_all(cases, names)

    print_metric_table(results)
    print_cell_table(results)

    print("\n-- diagnostics --")
    for result in results:
        print("\n[{}]".format(result["variant"]))
        for note in result["diagnostics"]:
            print("  - {}".format(note))

    variance: List[Dict[str, Any]] = []
    if args.seeds:
        base = int(manifest["master_seed"])
        seeds = [base + 1_000_003 * (index + 1) for index in range(args.seeds)]
        variance = variance_run(args.tier, seeds, names)
        print("\n-- identification_score across seeds --")
        header = ["shipped({})".format(base)] + [
            "seed({})".format(run["master_seed"]) for run in variance
        ]
        print("| variant | " + " | ".join(header) + " | mean | sd | range |")
        print("| --- |" + " --- |" * (len(header) + 3))
        for index, name in enumerate(names):
            values = [results[index]["metrics"]["identification_score"]]
            for run in variance:
                values.append(run["results"][index]["metrics"]["identification_score"])
            array = np.array(values)
            print(
                "| `{}` | ".format(name)
                + " | ".join("{:.4f}".format(value) for value in values)
                + " | {:.4f} | {:.4f} | {:.4f} |".format(
                    array.mean(), array.std(ddof=1), array.max() - array.min()
                )
            )

    if args.json:
        payload = {
            "tier": args.tier,
            "manifest_id": manifest["manifest_id"],
            "corpus_version": manifest["corpus_version"],
            "master_seed": manifest["master_seed"],
            "shipped": results,
            "variance": variance,
        }
        with open(args.json, "w") as stream:
            json.dump(payload, stream, indent=1, sort_keys=True, default=float)
        print("\nwrote {}".format(args.json))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
