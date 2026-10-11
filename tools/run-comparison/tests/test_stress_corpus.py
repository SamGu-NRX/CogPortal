"""Stress-corpus pins for the M3 corpus under fixtures-stress/.

Every stress file's reader verdict and exact refusal codes are pinned,
the corpus counts are exact, the committed stress evidence verifies
green as committed, and the whole corpus (canonical + stress roots in
one build) builds, replays byte-identically and verifies green. These
are measurements of what the reader and builder actually do, not claims
about what comparisons ought to mean.
"""

import json
import subprocess
import sys
from pathlib import Path

from report_reader import read_report

WORKBENCH = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKBENCH.parents[1]
CANONICAL = WORKBENCH / "fixtures"
STRESS = WORKBENCH / "fixtures-stress"
STRESS_EVIDENCE = WORKBENCH / "evidence-stress"

#: Per-file expectation: status and the exact refusal codes (a multiset:
#: one file may earn the same code twice).
EXPECTED_STRESS = {
    "s10-accepted-test-command.json": ("accepted", []),
    "s11-accepted-weight-receipts.json": ("accepted", []),
    "s12-accepted-benchmark-v2.json": ("accepted", []),
    "s13-accepted-extra-fields.json": ("accepted", []),
    "s14-accepted-dirty-weights.json": ("accepted", []),
    "s80-refused-missing-field.json": ("refused", ["missing_field"]),
    "s81-refused-bad-top-level-types.json": ("refused", ["bad_field_type", "bad_field_type"]),
    "s82-refused-not-an-object.json": ("refused", ["not_an_object"]),
    "s83-refused-duplicate-weights-used.json": ("refused", ["duplicate_weights_used", "unscored_weight_receipt"]),
    "s84-refused-duplicate-receipt.json": ("refused", ["duplicate_weight_receipt"]),
    "s85-refused-missing-receipt.json": ("refused", ["missing_weight_receipt"]),
    "s86-refused-uploaded-not-list.json": ("refused", ["malformed_weights_uploaded"]),
    "s87-refused-uploaded-entry-not-object.json": ("refused", ["malformed_weights_uploaded", "missing_weight_receipt"]),
    "s88-refused-metric-missing-field.json": ("refused", ["malformed_metrics"]),
    "s89-refused-duplicate-metric-key.json": ("refused", ["duplicate_metric_key"]),
    "s8a-refused-bad-metric-value.json": ("refused", ["bad_metric_value"]),
    "s8b-refused-bad-diagnostics.json": ("refused", ["bad_field_type"]),
    "s8c-refused-old-contract.json": ("refused", ["unsupported_contract"]),
}

#: Exact refusal-code counts over the stress corpus, as recorded by
#: reader_checks.py into evidence-stress/reader-checks.json.
EXPECTED_STRESS_CODES = {
    "bad_field_type": 3,
    "bad_metric_value": 1,
    "duplicate_metric_key": 1,
    "duplicate_weight_receipt": 1,
    "duplicate_weights_used": 1,
    "malformed_metrics": 1,
    "malformed_weights_uploaded": 2,
    "missing_field": 1,
    "missing_weight_receipt": 2,
    "not_an_object": 1,
    "unsupported_contract": 1,
    "unscored_weight_receipt": 1,
}


def _run_tool(tool, *fixture_roots, out, extra=()):
    command = [sys.executable, str(WORKBENCH / tool)]
    for root in fixture_roots:
        command += ["--fixtures", str(root)]
    command += ["--out", str(out), *extra]
    return subprocess.run(command, capture_output=True, text=True, cwd=str(REPO_ROOT))


def test_stress_reader_matrix_verdict_and_codes():
    for name, (status, codes) in EXPECTED_STRESS.items():
        loaded = read_report(STRESS / name)
        assert loaded.status == status, (name, [str(r) for r in loaded.refusals])
        assert sorted(refusal.code for refusal in loaded.refusals) == sorted(codes), name


def test_stress_corpus_counts_are_exact():
    files = sorted(STRESS.glob("*.json"))
    accepted = [path for path in files if read_report(path).accepted]
    refused = [path for path in files if not read_report(path).accepted]
    assert (len(accepted), len(refused), len(files)) == (5, 13, 18)


def test_stress_reader_checks_record_matches_corpus():
    record = json.loads((STRESS_EVIDENCE / "reader-checks.json").read_text(encoding="utf-8"))
    assert (record["total"], record["accepted"], record["refused"]) == (18, 5, 13)
    assert record["refusal_codes"] == EXPECTED_STRESS_CODES
    by_file = {entry["file"]: entry for entry in record["files"]}
    for name, (status, codes) in EXPECTED_STRESS.items():
        assert by_file[name]["status"] == status, name
        assert sorted(code.split(":")[0] for code in by_file[name]["refusals"]) == sorted(codes), name


def test_committed_stress_evidence_verifies_green():
    done = _run_tool("verify.py", STRESS, out=STRESS_EVIDENCE)
    assert done.returncode == 0, done.stderr


def test_stress_corpus_builds_replays_and_verifies_green(tmp_path):
    out = tmp_path / "stress-evidence"
    fresh = _run_tool("build.py", STRESS, out=out, extra=("--replay",))
    assert fresh.returncode == 0, fresh.stderr
    replay = _run_tool("build.py", STRESS, out=out, extra=("--replay",))
    assert replay.returncode == 0, replay.stderr
    assert "replay: existing evidence validated against a fresh build" in replay.stdout
    checked = _run_tool("verify.py", STRESS, out=out)
    assert checked.returncode == 0, checked.stderr


def test_full_corpus_builds_replays_and_verifies_green(tmp_path):
    out = tmp_path / "full-corpus-evidence"
    fresh = _run_tool("build.py", CANONICAL, STRESS, out=out, extra=("--replay",))
    assert fresh.returncode == 0, fresh.stderr
    checked = _run_tool("verify.py", CANONICAL, STRESS, out=out)
    assert checked.returncode == 0, checked.stderr
    receipt = json.loads((out / "view-receipts-01-run-a-vs-02-run-b.json").read_text(encoding="utf-8"))
    assert [entry["file"] for entry in receipt["excluded"]] == [
        "07-refused-future-contract.json",
        "08-refused-unknown-command.json",
        "09-refused-bad-receipt-digest.json",
        "10-refused-receipt-unscored-path.json",
        "11-refused-malformed.json",
        "s80-refused-missing-field.json",
        "s81-refused-bad-top-level-types.json",
        "s82-refused-not-an-object.json",
        "s83-refused-duplicate-weights-used.json",
        "s84-refused-duplicate-receipt.json",
        "s85-refused-missing-receipt.json",
        "s86-refused-uploaded-not-list.json",
        "s87-refused-uploaded-entry-not-object.json",
        "s88-refused-metric-missing-field.json",
        "s89-refused-duplicate-metric-key.json",
        "s8a-refused-bad-metric-value.json",
        "s8b-refused-bad-diagnostics.json",
        "s8c-refused-old-contract.json",
    ]
    assert [entry["file"] for entry in receipt["not_compared"]] == [
        "03-run-dirty.json",
        "04-run-legacy-unrecorded.json",
        "05-run-precapture-weights.json",
        "06-run-unrecorded-command.json",
        "s10-accepted-test-command.json",
        "s11-accepted-weight-receipts.json",
        "s12-accepted-benchmark-v2.json",
        "s13-accepted-extra-fields.json",
        "s14-accepted-dirty-weights.json",
    ]
