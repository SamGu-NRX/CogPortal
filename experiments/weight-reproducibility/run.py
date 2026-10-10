#!/usr/bin/env python3
"""Weight-reproducibility experiment runner.

Manifest mode re-runs every case family against tiny synthetic artifacts and
the production receipt module loaded from the tree, commits receipt verdicts
and prediction verdicts as separate sections, and rechecks every recorded
digest with hashlib.

Replay mode audits a committed results directory without trusting the run
that wrote it: source refs must still hash the same, every case must
re-derive to the recorded verdicts, and every digest claim is recomputed from
the committed bytes.

    python experiments/weight-reproducibility/run.py \
        --manifest experiments/weight-reproducibility/manifest.json
    python experiments/weight-reproducibility/run.py \
        --replay experiments/weight-reproducibility/results
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from harness import cases, digest, sources  # noqa: E402

MANIFEST_SCHEMA = "wr-manifest/1"
RESULTS_SCHEMA = "wr-results/1"
BASE_BRANCH = "fix/device-link-recovery-20261004"
DEFAULT_RESULTS = HERE / "results"

RUNNERS = {runner.__name__: runner for runner in cases.FAMILIES}


def load_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text())
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise SystemExit(f"manifest schema must be {MANIFEST_SCHEMA}")
    if manifest.get("experiment") != "weight-reproducibility":
        raise SystemExit("manifest names a different experiment")
    recorded = {row["name"]: row for row in manifest.get("sourceRefs", [])}
    expected = {
        name: (rel, role) for name, (rel, role) in sources.PRODUCTION_SOURCES.items()
    }
    if set(recorded) != set(expected):
        raise SystemExit(f"manifest sourceRefs must name exactly {sorted(expected)}")
    for name, (rel, role) in expected.items():
        if recorded[name].get("path") != rel or recorded[name].get("role") != role:
            raise SystemExit(
                f"manifest sourceRef {name} does not match the traced path/role"
            )
    ids = [case["id"] for case in manifest["cases"]]
    if len(ids) != len(set(ids)):
        raise SystemExit("manifest case ids must be unique")
    for case in manifest["cases"]:
        if case["runner"] not in RUNNERS:
            raise SystemExit(f"case {case['id']} names unknown runner {case['runner']}")
    return manifest


def evaluate_expectations(case_spec: dict, record: dict) -> list[str]:
    """Compare a case record with the expectations the manifest declares.

    Receipt expectations map a layer to the status it must start with.
    Prediction expectations are positional: the i-th entry must carry every
    listed key with the listed value."""
    failures = []
    expect = case_spec.get("expect", {})
    for layer, status in expect.get("receipt", {}).items():
        rows = [row for row in record["receiptVerdicts"] if row["layer"] == layer]
        if not rows:
            failures.append(f"receipt layer {layer!r} never reported")
        elif not str(rows[0]["status"]).startswith(status):
            failures.append(
                f"receipt {layer!r}: expected {status!r}, got {rows[0]['status']!r}"
            )
    for index, want in enumerate(expect.get("prediction", [])):
        rows = record["predictionVerdicts"]
        if index >= len(rows):
            failures.append(
                f"prediction entry {index} missing (only {len(rows)} recorded)"
            )
            continue
        for key, value in want.items():
            if rows[index].get(key) != value:
                failures.append(
                    f"prediction[{index}] {key}: expected {value!r}, "
                    f"got {rows[index].get(key)!r}"
                )
    return failures


def run_cases(manifest: dict, prod) -> tuple[list[dict], list[str]]:
    records, failures = [], []
    for case_spec in manifest["cases"]:
        record = RUNNERS[case_spec["runner"]](prod)
        record["manifestRunner"] = case_spec["runner"]
        records.append(record)
        for failure in evaluate_expectations(case_spec, record):
            failures.append(f"{case_spec['id']}: {failure}")
    return records, failures


def recheck_digests(records: list[dict]) -> tuple[list[dict], list[str]]:
    """Recompute every ledger claim from its committed bytes with hashlib.

    A corrupt-at-rest or refused-upload entry carries the honest recorded
    digest over bytes that do not (or may not) produce it; the recheck must
    surface exactly those mismatches, so they are expected, not errors.
    Only honest weight-bytes entries are expected to match."""
    rechecks, failures = [], []
    for record in records:
        for entry in record["digestLedger"]:
            result = digest.recheck(entry["claim"], bytes.fromhex(entry["bytesHex"]))
            result.update(
                {
                    "caseId": record["id"],
                    "kind": entry["kind"],
                    "path": entry["path"],
                    "expectedMatch": entry["kind"] == "weight-bytes",
                }
            )
            rechecks.append(result)
            if result["match"] != result["expectedMatch"]:
                failures.append(
                    f"{record['id']}: digest recheck "
                    f"{'matched' if result['match'] else 'mismatched'} "
                    f"unexpectedly for {entry['path']} ({entry['kind']})"
                )
    return rechecks, failures


def run_manifest(manifest_path: Path, results_dir: Path) -> int:
    manifest = load_manifest(manifest_path)
    refs = sources.source_refs()
    prod = sources.load_prepared_environment_module()

    records, failures = run_cases(manifest, prod)
    rechecks, recheck_failures = recheck_digests(records)
    failures.extend(recheck_failures)

    receipt_verdicts = [
        {"caseId": record["id"], **verdict}
        for record in records
        for verdict in record["receiptVerdicts"]
    ]
    prediction_verdicts = [
        {"caseId": record["id"], **verdict}
        for record in records
        for verdict in record["predictionVerdicts"]
    ]
    results = {
        "schema": RESULTS_SCHEMA,
        "runFrom": {
            "baseBranch": BASE_BRANCH,
            "headSha": sources.head_sha(),
            "pythonVersion": platform.python_version(),
        },
        "manifest": {
            "path": str(manifest_path),
            "sha256": digest.recheck("", manifest_path.read_bytes())["recomputed"],
            "copy": manifest,
        },
        "sourceRefs": refs,
        "cases": records,
        "receiptVerdicts": receipt_verdicts,
        "predictionVerdicts": prediction_verdicts,
        "digestRecheck": rechecks,
        "summary": {
            "cases": len(records),
            "receiptVerdicts": len(receipt_verdicts),
            "predictionVerdicts": len(prediction_verdicts),
            "digestsRechecked": len(rechecks),
            "expectationFailures": failures,
        },
    }
    results_dir.mkdir(parents=True, exist_ok=True)
    (results_dir / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(
        f"ran {len(records)} cases: {len(receipt_verdicts)} receipt verdicts, "
        f"{len(prediction_verdicts)} prediction verdicts, "
        f"{len(rechecks)} digests rechecked"
    )
    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    print("all manifest expectations hold; every digest recheck agrees")
    return 0


def replay(results_dir: Path) -> int:
    results_path = results_dir / "results.json"
    if not results_path.exists():
        raise SystemExit(f"no results.json under {results_dir}")
    results = json.loads(results_path.read_text())
    if results.get("schema") != RESULTS_SCHEMA:
        raise SystemExit(f"results schema must be {RESULTS_SCHEMA}")

    drift: list[str] = []

    sources.assert_unchanged(results["sourceRefs"])

    # Every case must re-derive to the recorded verdicts, deterministically,
    # from the committed manifest copy.
    manifest = results["manifest"]["copy"]
    prod = sources.load_prepared_environment_module()
    records, _ = run_cases(manifest, prod)
    for recorded, fresh in zip(results["cases"], records):
        if recorded != fresh:
            drift.append(f"case {recorded['id']} does not re-derive identically")

    # Digest claims are recomputed from the committed bytes, independently of
    # the run that wrote them.
    rechecks, recheck_failures = recheck_digests(results["cases"])
    drift.extend(recheck_failures)
    if rechecks != results["digestRecheck"]:
        drift.append("digest rechecks do not reproduce from the committed ledger")

    # Interrupted cache publications must still be refused on replay.
    for record in results["cases"]:
        if record["family"] == "cache-publication":
            for verdict in record["receiptVerdicts"]:
                if verdict.get("interrupted") and verdict["status"] != "refused":
                    drift.append(
                        f"{record['id']}: interrupted publication "
                        f"{verdict['layer']} is {verdict['status']}, must be refused"
                    )

    replay_report = {
        "schema": "wr-replay/1",
        "replayedFrom": str(results_path),
        "sourceRefsVerified": True,
        "casesReDerived": len(records),
        "digestsRechecked": len(rechecks),
        "drift": drift,
    }
    (results_dir / "replay.json").write_text(json.dumps(replay_report, indent=2) + "\n")
    if drift:
        for item in drift:
            print(f"DRIFT {item}", file=sys.stderr)
        return 1
    print(
        f"replay clean: {len(records)} cases re-derived, {len(rechecks)} digests "
        "recomputed, source refs unchanged, interrupted publications still refused"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--manifest", type=Path, help="run every case in the manifest")
    mode.add_argument("--replay", type=Path, help="audit a committed results directory")
    parser.add_argument(
        "--results-dir", type=Path, default=DEFAULT_RESULTS, help="where results.json lives"
    )
    args = parser.parse_args()
    if args.manifest is not None:
        return run_manifest(args.manifest, args.results_dir)
    return replay(args.replay)


if __name__ == "__main__":
    raise SystemExit(main())
