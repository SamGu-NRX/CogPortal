#!/usr/bin/env python
"""Diagnostic-causality study runner.

Measure mode:
    python run.py --manifest manifest.json
        Materializes control + variants from the frozen fixtures, runs the
        real cogbench CLI (check / test / run / report) on each, derives a
        key-blind diagnosis per variant, applies its claimed repair, and
        accepts the diagnosis as correct only when the control outcome is
        restored. Writes raw bundles, diagnoses, oracle verdicts, graded
        tables, and summary.json under --results (default: results/).

Replay mode:
    python run.py --replay results
        Recomputes every derived artifact (bundle texts, diagnoses, cause
        counts, tables, summary) from the committed raw captures alone and
        asserts byte agreement with the committed ones.

Wrong-repair probe (part of measure mode):
    A deliberately wrong repair (the name_error repair applied to a variant
    whose bundle it does not belong to) is run through the oracle and MUST
    fail to restore the control outcome. results/wrong_repair_probe.json
    records the run.

The defect/repair key is read only by materialize.py (fixture construction)
and grade.py (grading after all measurement is persisted). The subject never
sees it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

STUDY = Path(__file__).resolve().parent
sys.path.insert(0, str(STUDY))

import diagnose  # noqa: E402
import grade as grading  # noqa: E402
import materialize  # noqa: E402
import measure  # noqa: E402
from oracle import apply_repair_ops, oracle  # noqa: E402

BENCHMARK = "audio-identification"


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_manifest(path: Path) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def measure_all(manifest: dict, results: Path) -> None:
    key = materialize.load_key()
    work_root = Path(manifest["work_dir"])
    paths = materialize.materialize(work_root, key)
    raw_dir = results / "raw"
    if results.exists():
        shutil.rmtree(results)
    raw_dir.mkdir(parents=True)

    write_json(results / "environment.json", manifest_environment(manifest))

    # 1. Control: the outcome every repair must restore.
    control_bundle = measure.measure_variant(paths["control"], with_run=True)
    write_json(raw_dir / "control" / "bundle.json", control_bundle)
    control_outcome = measure.outcome_of(control_bundle)
    write_json(raw_dir / "control" / "outcome.json", control_outcome)

    # 2. Single-defect variants: measure, diagnose, oracle.
    diagnoses = {}
    oracles = {}
    for name in materialize.single_defect_names(key):
        bundle = measure.measure_variant(paths[name], with_run=True)
        write_json(raw_dir / name / "bundle.json", bundle)
        text = measure.bundle_text(bundle)
        diagnosis = diagnose.diagnose(text)
        diagnoses[name] = {"bundle_sha256": sha256(text), "diagnosis": diagnosis}
        oracles[name] = oracle(
            paths[name],
            control_outcome,
            work_root / "oracle",
            recorded_diagnosis=diagnosis,
            capture_dir=raw_dir / name / "oracle",
            pristine_capture=f"raw/{name}/bundle.json",
            max_rounds=3,
        )
    for name in materialize.multi_defect_names(key):
        bundle = measure.measure_variant(paths[name], with_run=True)
        write_json(raw_dir / name / "bundle.json", bundle)
        oracles[name] = oracle(
            paths[name],
            control_outcome,
            work_root / "oracle",
            capture_dir=raw_dir / name / "oracle",
            max_rounds=3,
        )

    write_json(results / "diagnoses.json", diagnoses)
    write_json(results / "oracle.json", oracles)

    # 3. Wrong-repair probe: a deliberately wrong repair must fail the oracle.
    probe = wrong_repair_probe(
        paths,
        control_outcome,
        work_root / "probe",
        capture_dir=raw_dir / "fp_freq_sign" / "oracle",
    )
    write_json(results / "wrong_repair_probe.json", probe)

    # 4. Grade against the key, after all measurement is persisted.
    graded = grading.grade(results, key)
    write_json(results / "grade.json", graded)
    grading.write_tables(results / "tables", graded)
    write_json(results / "summary.json", summarize(results, graded, probe))


def manifest_environment(manifest: dict) -> dict:
    import platform

    env = dict(manifest)
    env["measured_with"] = {
        "python": platform.python_version(),
        "platform": platform.platform(),
    }
    try:
        import numpy

        env["measured_with"]["numpy"] = numpy.__version__
    except ImportError:
        env["measured_with"]["numpy"] = None
    return env


def wrong_repair_probe(paths: dict, control_outcome: dict, scratch: Path, *, capture_dir: Path | None = None) -> dict:
    """Apply the name_error claimed repair (a numpy import) to the
    fp_freq_sign variant. The import is harmless, the fingerprint defect
    remains, and the oracle must NOT report restoration.

    Provenance: the wrong claim is the name_error diagnosis recorded from
    name_error's pristine measurement; the measured input is a copy of the
    fp_freq_sign variant source (the input behind its pristine bundle). The
    post-repair bundle is retained under the capture dir.
    """
    target = paths["fp_freq_sign"]
    wrong_claim = {
        "claimed_class": "name_error",
        "claimed_repair": {
            "op": "insert_import",
            "name": "np",
            "line": "import numpy as np",
            "file": "submission.py",
        },
        "evidence": "deliberately wrong repair for the probe",
    }
    source = (target / "submission.py").read_text(encoding="utf-8")
    scratch.mkdir(parents=True, exist_ok=True)
    work = scratch / "wrong_repair_on_fp_freq_sign"
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(target, work)
    new_source, applied = apply_repair_ops(source, wrong_claim["claimed_repair"])
    (work / "submission.py").write_text(new_source, encoding="utf-8")
    bundle = measure.measure_variant(work, with_run=False)
    outcome = measure.outcome_of(bundle)
    restored = measure.outcomes_match(outcome, control_outcome)
    if capture_dir is not None:
        write_json(capture_dir / "wrong_repair.post.json", bundle)
    return {
        "probe": "name_error repair applied to fp_freq_sign variant",
        "measured_input": "raw/fp_freq_sign/bundle.json (variant source copy)",
        "wrong_claim_source": "raw/name_error/bundle.json diagnosis",
        "applied": applied,
        "restored": restored,
        "post_capture": "wrong_repair.post.json" if capture_dir is not None else None,
        "expectation": "restored must be False: a deliberately wrong repair fails the oracle",
        "oracle_agrees": restored is False,
        "observed_outcome": outcome,
    }


def summarize(results: Path, graded: dict, probe: dict) -> dict:
    summary = {
        "totals": graded["totals"],
        "cause_class_counts": graded["cause_class_counts"],
        "wrong_repair_probe_oracle_agrees": probe["oracle_agrees"],
        "indistinguishable_pairs": [p["variants"] for p in graded["indistinguishable_pairs"]],
        "misleading_witnesses": graded["misleading_witnesses"],
        "unmeasured_tracks": [
            {"track": t["name"], "reason": t["reason"]}
            for t in load_manifest(STUDY / "manifest.json")["tracks"]
            if not t["measured"]
        ],
    }
    return summary


def replay(results: Path) -> int:
    """Recompute every derived artifact from raw captures; assert agreement."""
    key = materialize.load_key()
    problems = []

    recomputed_diagnoses = {}
    for path in sorted((results / "raw").glob("*/bundle.json")):
        name = path.parent.name
        if name == "control" or name in materialize.multi_defect_names(key):
            continue
        raw = grading.load_json(path)
        text = measure.bundle_text(raw)
        recomputed_diagnoses[name] = {
            "bundle_sha256": sha256(text),
            "diagnosis": diagnose.diagnose(text),
        }
    committed_diagnoses = grading.load_json(results / "diagnoses.json")
    if recomputed_diagnoses != committed_diagnoses:
        problems.append("diagnoses.json disagrees with replay from raw captures")

    committed_oracle = grading.load_json(results / "oracle.json")
    for name, record in committed_oracle.items():
        final = record["final_outcome"]
        control = record["control_outcome"]
        if record["restored"] != measure.outcomes_match(final, control):
            problems.append(f"oracle.json self-inconsistent for {name}")
        oracle_dir = results / "raw" / name / "oracle"
        for round_record in record["rounds"]:
            source_name = round_record.get("diagnosis_source", "")
            if source_name.startswith("raw/"):
                pre_path = results / source_name
            else:
                pre_path = oracle_dir / source_name
            if not pre_path.exists():
                problems.append(f"oracle diagnosis source missing for {name} round {round_record['round']}: {pre_path}")
                continue
            recomputed = diagnose.diagnose(measure.bundle_text(grading.load_json(pre_path)))
            if recomputed != round_record.get("diagnosis"):
                problems.append(
                    f"oracle round {round_record['round']} diagnosis for {name} disagrees with its recorded source capture"
                )
            post_name = round_record.get("post_capture")
            if post_name:
                post_path = oracle_dir / post_name
                if not post_path.exists():
                    problems.append(f"oracle post capture missing for {name}: {post_path}")
                    continue
                post_outcome = measure.outcome_of(grading.load_json(post_path))
                if round_record["outcome_matches_control"] != measure.outcomes_match(post_outcome, control):
                    problems.append(f"oracle post capture inconsistent for {name} round {round_record['round']}")
        final_path = oracle_dir / record.get("final_capture", "")
        if final_path.exists():
            if measure.outcome_of(grading.load_json(final_path)) != final:
                problems.append(f"oracle final_outcome disagrees with retained capture for {name}")
        else:
            problems.append(f"oracle final capture missing for {name}: {final_path}")

    committed_probe = grading.load_json(results / "wrong_repair_probe.json")
    probe_capture = results / "raw" / "fp_freq_sign" / "oracle" / "wrong_repair.post.json"
    if not probe_capture.exists():
        problems.append("wrong-repair probe capture missing")
    else:
        probe_bundle = grading.load_json(probe_capture)
        if measure.outcome_of(probe_bundle) != committed_probe["observed_outcome"]:
            problems.append("wrong-repair probe observed_outcome disagrees with retained capture")
        probe_control = committed_oracle["fp_freq_sign"]["control_outcome"]
        if committed_probe["restored"] != measure.outcomes_match(measure.outcome_of(probe_bundle), probe_control):
            problems.append("wrong-repair probe restored disagrees with retained capture")

    graded = grading.grade(results, key)
    committed_grade = grading.load_json(results / "grade.json")
    if graded != committed_grade:
        problems.append("grade.json disagrees with replay from raw captures")

    grading.write_tables(results / "replay_tables", graded)
    for table in ("cause_classes.csv", "multi_defect.md", "indistinguishable.md"):
        committed = (results / "tables" / table).read_text(encoding="utf-8")
        replayed = (results / "replay_tables" / table).read_text(encoding="utf-8")
        if committed != replayed:
            problems.append(f"tables/{table} disagrees with replay")
    shutil.rmtree(results / "replay_tables")

    replay_record = {
        "mode": "replay",
        "source": str(results),
        "variants_replayed": sorted(recomputed_diagnoses),
        "problems": problems,
        "agrees": not problems,
    }
    write_json(results / "replay.json", replay_record)
    print(json.dumps(replay_record, indent=2))
    return 0 if not problems else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, help="measure mode: manifest path")
    parser.add_argument("--replay", type=Path, help="replay mode: results directory")
    parser.add_argument("--results", type=Path, default=STUDY / "results")
    arguments = parser.parse_args()

    if arguments.replay:
        return replay(arguments.replay)
    if not arguments.manifest:
        parser.error("measure mode needs --manifest")
    manifest = load_manifest(arguments.manifest)
    results = arguments.results
    measure_all(manifest, results)
    print(json.dumps(json.loads((results / "summary.json").read_text(encoding="utf-8")), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
