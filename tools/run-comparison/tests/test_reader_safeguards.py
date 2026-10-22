"""Regression tests for the reader's four writer-contract refusals.

The writer refuses to save a source SHA that is not absent or a full
40-character lowercase hex digest, keys weights only under usable
relative paths, and never emits a metric whose value is not finite or
whose render precision is not 0-12. A report carrying any of these
cannot have been written by this writer, so the reader refuses it with
a named reason instead of reading it as scored-bytes identity, a
comparable delta, or a renderable precision.

Every refusal names the same strings verify.py mirrors: the verifier
compares the receipt's recorded reasons to its own derivation word for
word, so these tests pin the exact vocabulary both sides share.
"""

import copy
import json
from pathlib import Path

from report_reader import read_payload

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
BASE = json.loads((FIXTURES / "01-run-a.json").read_text(encoding="utf-8"))


def _read(payload):
    raw = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    return read_payload(raw.encode("utf-8"), file="probe.json")


def _codes(loaded):
    return [refusal.code for refusal in loaded.refusals]


def _details(loaded):
    return [refusal.detail for refusal in loaded.refusals]


def test_baseline_fixture_stays_accepted():
    loaded = _read(copy.deepcopy(BASE))
    assert loaded.status == "accepted", _details(loaded)
    assert loaded.refusals == ()


def test_partial_source_sha_is_refused():
    payload = copy.deepcopy(BASE)
    payload["sha"] = "0123456789ab"  # the display form, not the digest
    loaded = _read(payload)
    assert _codes(loaded) == ["bad_source_sha"]
    assert "40-character lowercase hex digest or absent" in _details(loaded)[0]


def test_wrongly_typed_source_sha_is_refused():
    payload = copy.deepcopy(BASE)
    payload["sha"] = 12345
    loaded = _read(payload)
    assert _codes(loaded) == ["bad_source_sha"]


def test_uppercase_source_sha_is_refused():
    payload = copy.deepcopy(BASE)
    payload["sha"] = "A" * 40
    loaded = _read(payload)
    assert _codes(loaded) == ["bad_source_sha"]


def _read_raw(payload):
    raw = json.dumps(payload, indent=2, sort_keys=True, allow_nan=True) + "\n"
    return read_payload(raw.encode("utf-8"), file="probe.json")


def test_non_finite_metric_value_is_refused():
    for value in (float("nan"), float("inf"), float("-inf")):
        payload = copy.deepcopy(BASE)
        payload["metrics"][0]["value"] = value
        loaded = _read_raw(payload)
        assert _codes(loaded) == ["bad_metric_value"], value
        assert "must be a finite number" in _details(loaded)[0]


def test_precision_outside_0_to_12_is_refused():
    for bad in (13, -1):
        payload = copy.deepcopy(BASE)
        payload["metrics"][0]["precision"] = bad
        loaded = _read(payload)
        assert _codes(loaded) == ["bad_precision"], bad
        assert "between 0 and 12" in _details(loaded)[0]


def test_precision_boundaries_are_accepted():
    for good in (0, 12):
        payload = copy.deepcopy(BASE)
        payload["metrics"][0]["precision"] = good
        loaded = _read(payload)
        assert loaded.status == "accepted", _details(loaded)


def test_weight_paths_the_writer_could_not_key_are_refused():
    for path in ("../escape.pt", "/abs/model.pt", "model\\pt", "a" * 501):
        payload = copy.deepcopy(BASE)
        payload["weightsUsed"] = [path]
        payload.pop("weightsUploaded", None)
        loaded = _read(payload)
        assert _codes(loaded) == ["bad_weight_path"], path
        assert "not a path the writer could have keyed" in _details(loaded)[0]


def test_weight_path_with_control_character_is_refused_but_space_is_usable():
    payload = copy.deepcopy(BASE)
    payload["weightsUsed"] = ["model pt"]
    payload.pop("weightsUploaded", None)
    loaded = _read(payload)
    assert loaded.status == "accepted", _details(loaded)  # a space is usable

    payload["weightsUsed"] = ["model\x07.pt"]
    loaded = _read(payload)
    assert _codes(loaded) == ["bad_weight_path"]


def test_usable_relative_weight_path_is_accepted():
    payload = copy.deepcopy(BASE)
    payload["weightsUsed"] = ["checkpoints/model.pt"]
    payload.pop("weightsUploaded", None)
    loaded = _read(payload)
    assert loaded.status == "accepted", _details(loaded)
