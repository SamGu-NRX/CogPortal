"""The reader against the builder's own format, against synthetic reports
with incompatible versions, and against synthetic reports with missing
provenance.

Nothing here invents a value the writer did not write: the repeated
assertion of these tests is that an unrecorded field reads back as
unknown, and a value the writer's rules would refuse is refused with the
reason named.
"""

import hashlib
import json
from pathlib import Path
from typing import Any, Dict

import pytest

from report_reader import read_payload, read_report
from synthetic import REFERENCE_REPORT, metric, report

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

#: The committed fixture matrix and the exact refusal codes each file must
#: earn. The counts this implies (6 accepted, 5 refused of 11) are what
#: evidence/reader-checks.json records; test_reader_checks pins them.
EXPECTED_FIXTURES: Dict[str, tuple] = {
    "01-run-a.json": ("accepted", []),
    "02-run-b.json": ("accepted", []),
    "03-run-dirty.json": ("accepted", []),
    "04-run-legacy-unrecorded.json": ("accepted", []),
    "05-run-precapture-weights.json": ("accepted", []),
    "06-run-unrecorded-command.json": ("accepted", []),
    "07-refused-future-contract.json": ("refused", ["unsupported_contract"]),
    "08-refused-unknown-command.json": ("refused", ["unknown_command"]),
    "09-refused-bad-receipt-digest.json": ("refused", ["bad_weight_receipt"]),
    "10-refused-receipt-unscored-path.json": ("refused", ["unscored_weight_receipt"]),
    "11-refused-malformed.json": ("refused", ["not_json"]),
}


def read_dict(payload: Dict[str, Any]) -> Any:
    return read_payload(
        json.dumps(payload, indent=2, sort_keys=True).encode("utf-8"),
        file="synthetic.json",
    )


def test_reader_accepts_the_report_builder_s_own_specimen():
    payload = json.loads(REFERENCE_REPORT.read_text(encoding="utf-8"))
    loaded = read_payload(REFERENCE_REPORT.read_bytes(), file=REFERENCE_REPORT.name)
    assert loaded.accepted, [str(refusal) for refusal in loaded.refusals]
    assert loaded.refusals == ()
    assert loaded.report_id == payload["reportId"]

    # source identity
    assert loaded.source.repository == "SamGu-NRX/cogportal-demo-week1"
    assert loaded.source.sha == payload["sha"]
    assert loaded.source.dirty is False
    assert loaded.source.pins_the_scored_bytes is True

    # dataset identity: the unrecorded parts stay None, never defaults
    assert loaded.dataset.benchmark_id == "audio-identification"
    assert loaded.dataset.benchmark_version == 1
    assert loaded.dataset.command is None
    assert loaded.dataset.weights_used == ()
    assert loaded.dataset.weights_uploaded is None

    # scorer identity
    assert loaded.scorer.contract_version == "cogworks.submissions.v2"
    assert loaded.scorer.sdk_version == "0.2.0"
    assert loaded.scorer.plugin_version == "0.1.0"

    # metric identity: roles read back, the primary metric is found
    assert [m.key for m in loaded.metrics if m.primary] == ["identification_score"]
    assert {m.key for m in loaded.metrics if m.role == "floor"} == {
        "chance_top1",
        "trivial_baseline_top1",
    }
    assert [m.key for m in loaded.metrics if m.role == "reported"] == [
        "median_identify_seconds",
        "margin_separation",
    ]


def test_the_fixture_matrix_has_not_drifted_from_its_record():
    present = {path.name for path in FIXTURES.glob("*.json")}
    assert present == set(EXPECTED_FIXTURES), (
        "fixtures/ changed without updating the expected matrix in this "
        "test module and the counts in evidence/reader-checks.json"
    )


@pytest.mark.parametrize("name", sorted(EXPECTED_FIXTURES))
def test_each_fixture_reads_exactly_as_recorded(name):
    expected_status, expected_codes = EXPECTED_FIXTURES[name]
    loaded = read_report(FIXTURES / name)
    assert loaded.status == expected_status, [
        str(refusal) for refusal in loaded.refusals
    ]
    assert [refusal.code for refusal in loaded.refusals] == expected_codes


def test_the_recorded_hash_is_the_file_s_own():
    path = FIXTURES / "01-run-a.json"
    loaded = read_report(path)
    assert loaded.file_sha256 == hashlib.sha256(path.read_bytes()).hexdigest()


# --- unknown provenance stays unknown ------------------------------------


def test_unrecorded_command_stays_unknown():
    loaded = read_report(FIXTURES / "06-run-unrecorded-command.json")
    assert loaded.accepted
    assert loaded.dataset.command is None
    # ...while the parts that are recorded still read as recorded
    assert loaded.dataset.weights_used == ()
    assert loaded.dataset.weights_uploaded == ()


def test_a_legacy_report_leaves_every_unrecorded_part_unknown():
    loaded = read_report(FIXTURES / "04-run-legacy-unrecorded.json")
    assert loaded.accepted
    assert loaded.dataset.command is None
    assert loaded.dataset.weights_used is None
    assert loaded.dataset.weights_uploaded is None
    assert loaded.metrics[0].role is None
    assert loaded.metrics[0].help is None


def test_precapture_weights_do_not_read_as_no_weights():
    loaded = read_report(FIXTURES / "05-run-precapture-weights.json")
    assert loaded.accepted
    assert loaded.dataset.weights_used == ("model.pt",)
    assert loaded.dataset.weights_uploaded is None  # never []


def test_a_dirty_source_is_recorded_but_pins_nothing():
    loaded = read_report(FIXTURES / "03-run-dirty.json")
    assert loaded.accepted
    assert loaded.source.dirty is True
    assert loaded.source.sha == "3" * 40
    assert loaded.source.pins_the_scored_bytes is False


def test_a_refused_report_exposes_no_identities_to_compare():
    loaded = read_report(FIXTURES / "07-refused-future-contract.json")
    assert not loaded.accepted
    assert loaded.source is None
    assert loaded.dataset is None
    assert loaded.scorer is None
    assert loaded.metrics == ()


# --- refusals on synthetic payloads, each with its exact reason ----------


def test_a_missing_required_field_names_the_field():
    payload = report()
    del payload["contractVersion"]
    loaded = read_dict(payload)
    assert not loaded.accepted
    assert [refusal.code for refusal in loaded.refusals] == ["missing_field"]
    assert "contractVersion" in loaded.refusals[0].detail


def test_an_incompatible_contract_is_refused_not_interpreted():
    payload = report()
    payload["contractVersion"] = "cogworks.submissions.v1"
    loaded = read_dict(payload)
    assert [refusal.code for refusal in loaded.refusals] == ["unsupported_contract"]


def test_an_unknown_command_value_is_refused():
    payload = report()
    payload["command"] = "profile"
    loaded = read_dict(payload)
    assert [refusal.code for refusal in loaded.refusals] == ["unknown_command"]


def test_a_receipt_digest_must_be_sixty_four_hex_characters():
    payload = report()
    payload["weightsUsed"] = ["model.pt"]
    payload["weightsUploaded"] = [
        {"path": "model.pt", "sha256": "deadbeef", "size": 10}
    ]
    loaded = read_dict(payload)
    assert [refusal.code for refusal in loaded.refusals] == ["bad_weight_receipt"]


def test_a_receipt_without_a_byte_length_is_refused():
    payload = report()
    payload["weightsUsed"] = ["model.pt"]
    payload["weightsUploaded"] = [{"path": "model.pt", "sha256": "a" * 64}]
    loaded = read_dict(payload)
    assert [refusal.code for refusal in loaded.refusals] == ["bad_weight_receipt"]


def test_a_scored_weight_without_a_receipt_is_refused():
    payload = report()
    payload["weightsUsed"] = ["model.pt"]
    payload["weightsUploaded"] = []
    loaded = read_dict(payload)
    assert [refusal.code for refusal in loaded.refusals] == [
        "missing_weight_receipt"
    ]


def test_duplicate_weights_used_names_are_refused():
    payload = report()
    payload["weightsUsed"] = ["model.pt", "model.pt"]
    payload["weightsUploaded"] = [
        {"path": "model.pt", "sha256": "a" * 64, "size": 10},
        {"path": "model.pt", "sha256": "b" * 64, "size": 12},
    ]
    loaded = read_dict(payload)
    codes = {refusal.code for refusal in loaded.refusals}
    assert "duplicate_weights_used" in codes
    # With the names ambiguous, no receipt can be said to describe scored
    # bytes, so the receipts refuse too rather than pick one.
    assert "unscored_weight_receipt" in codes


def test_duplicate_metric_keys_are_refused():
    payload = report()
    payload["metrics"] = payload["metrics"] + [payload["metrics"][0]]
    loaded = read_dict(payload)
    assert [refusal.code for refusal in loaded.refusals] == ["duplicate_metric_key"]


def test_a_non_numeric_metric_value_is_refused():
    payload = report()
    payload["metrics"][0]["value"] = "high"
    loaded = read_dict(payload)
    assert [refusal.code for refusal in loaded.refusals] == ["bad_metric_value"]


@pytest.mark.parametrize(
    "mutation,field_name",
    [
        (lambda p: p.update(benchmarkVersion="1"), "benchmarkVersion"),
        (lambda p: p.update(dirty="false"), "dirty"),
        (lambda p: p.update(metrics={}), "metrics"),
        (lambda p: p.update(diagnostics="none"), "diagnostics"),
        (
            lambda p: p["metrics"][0].update(higherIsBetter="yes"),
            "higherIsBetter",
        ),
    ],
)
def test_wrongly_typed_fields_are_refused_with_the_field_named(mutation, field_name):
    payload = report()
    mutation(payload)
    loaded = read_dict(payload)
    assert not loaded.accepted
    assert {refusal.code for refusal in loaded.refusals} == {"bad_field_type"}
    assert any(field_name in refusal.detail for refusal in loaded.refusals)


def test_a_json_array_is_not_a_report():
    loaded = read_payload(b"[]", file="array.json")
    assert [refusal.code for refusal in loaded.refusals] == ["not_an_object"]


def test_truncated_json_is_refused_as_not_json():
    loaded = read_payload(
        b'{"reportId": "local_x", "benchm', file="cut.json"
    )
    assert [refusal.code for refusal in loaded.refusals] == ["not_json"]
