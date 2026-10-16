"""The measurement suite: every manifest case runs through the same machinery
run.py uses, and each must meet the expectations the manifest declares. Also
pins the thesis cases directly: a receipt that matches does not force the
prediction to follow."""

from __future__ import annotations

import pytest

import run as runner
from harness import cases as case_modules
from harness.sources import load_prepared_environment_module

from harness import artifacts as A


@pytest.fixture(scope="module")
def prod():
    return load_prepared_environment_module()


@pytest.fixture(scope="module")
def manifest(tmp_path_factory):
    from pathlib import Path

    return runner.load_manifest(
        Path(runner.HERE) / "manifest.json"
    )


def test_every_manifest_case_meets_its_expectations(prod, manifest):
    records, failures = runner.run_cases(manifest, prod)
    assert records and not failures, "\n".join(failures)


def test_every_record_carries_both_verdict_sections(prod, manifest):
    records, _ = runner.run_cases(manifest, prod)
    for record in records:
        assert isinstance(record["receiptVerdicts"], list)
        assert isinstance(record["predictionVerdicts"], list)
        assert record["digestLedger"]


def test_digest_recheck_catches_tampered_bytes(prod, manifest):
    records, _ = runner.run_cases(manifest, prod)
    records[0]["digestLedger"][0]["claim"] = "0" * 64
    _, failures = runner.recheck_digests(records)
    assert any("baseline" in failure for failure in failures)


def test_recheck_accepts_honest_ledger_and_flags_corruption(prod, manifest):
    records, failures = runner.run_cases(manifest, prod)
    assert not any("unexpected" in failure for failure in failures)
    corrupt = [
        row
        for record in records
        for row in runner.recheck_digests([record])[0]
        if row["kind"] == "corrupt-bytes-at-rest"
    ]
    assert corrupt and all(row["match"] is False for row in corrupt)


def test_thesis_receipt_consistent_substitution_diverges(prod):
    """The load-bearing finding: rebuilding the lineage honestly around
    same-size substituted bytes passes every receipt check and still changes
    the prediction."""
    record = case_modules.substitution_receipt_consistent(prod)
    diverged = [
        row for row in record["predictionVerdicts"] if row.get("diverged") is True
    ]
    assert len(diverged) == 1
    receipts = [row["status"] for row in record["receiptVerdicts"]]
    assert all(status.startswith("accepted") or status == "matched" for status in receipts)


def test_thesis_state_mutation_invisible_to_receipt(prod):
    record = case_modules.state_mutation_after_load(prod)
    assert [row.get("diverged") for row in record["predictionVerdicts"]] == [False, True]
    assert all(
        row["status"].startswith("accepted") or row["status"] == "matched"
        for row in record["receiptVerdicts"]
    )


def test_baseline_bytes_are_fixture_only(prod):
    """Guard the no-real-weights promise: the fixture must stay tiny and
    synthetic, never a course weight."""
    assert len(A.BENIGN_WEIGHT) == A.WEIGHT_SIZE == 2048
    assert A.REPO == "course/submit-2026"
