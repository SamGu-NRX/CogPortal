"""The committed reader-checks record stays exact against the fixtures."""

import hashlib
import json
from pathlib import Path

from reader_checks import collect

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
COMMITTED = Path(__file__).resolve().parents[1] / "evidence" / "reader-checks.json"

EXPECTED_COUNTS = {"total": 11, "accepted": 6, "refused": 5}
EXPECTED_CODES = {
    "bad_weight_receipt": 1,
    "not_json": 1,
    "unknown_command": 1,
    "unsupported_contract": 1,
    "unscored_weight_receipt": 1,
}


def _without_root(record):
    """The record embeds where it was produced; everything else is content."""

    return {key: value for key, value in record.items() if key != "fixtures_root"}


def test_counts_are_exact():
    record = collect(FIXTURES)
    assert record["total"] == EXPECTED_COUNTS["total"]
    assert record["accepted"] == EXPECTED_COUNTS["accepted"]
    assert record["refused"] == EXPECTED_COUNTS["refused"]
    assert record["refusal_codes"] == EXPECTED_CODES


def test_every_hash_matches_the_committed_bytes():
    record = collect(FIXTURES)
    for entry in record["files"]:
        assert entry["sha256"] == hashlib.sha256(
            (FIXTURES / entry["file"]).read_bytes()
        ).hexdigest()


def test_the_record_is_deterministic():
    assert collect(FIXTURES) == collect(FIXTURES)


def test_the_committed_record_matches_the_fixtures():
    committed = json.loads(COMMITTED.read_text(encoding="utf-8"))
    assert _without_root(committed) == _without_root(collect(FIXTURES))
