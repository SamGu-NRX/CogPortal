import json
import sys
from pathlib import Path

import pytest

STUDY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(STUDY))

import diagnose  # noqa: E402
import materialize  # noqa: E402
from oracle import apply_repair_ops  # noqa: E402

# Canned bundles quoted from pre-study probes of the pinned instrument.
NAME_ERROR_BUNDLE = (
    "8 songs failed to enroll, so every query for them scored zero. First: "
    "song-00: NameError: name 'np' is not defined at submission.py:12"
)
SIGNATURE_BUNDLE = (
    "| received MiniSearch with callables: enroll, identify | missing: "
    "identify(samples, sample_rate) | identify looks like identify but "
    "accepts only 1 positional arguments; not mapped"
)
RETRIEVAL_CLAIM_BUNDLE = (
    "86% of queries found no candidate at all. Retrieval, not ranking, is "
    "what is failing: the clip's fingerprints are not landing on the same "
    "keys the database stored."
)
HASH_SPACE_BUNDLE = (
    "Almost every query came back with no shared fingerprints at all, which "
    "usually means your database and your queries are in different hash spaces."
)
SHAPE_BUNDLE = (
    "Margin separation is not measured: there was no first-to-second margin "
    "to read on both sides (identify returned ranked ids without scores, or "
    "no out-of-database query produced one). Return (song_id, score) pairs."
)


def test_name_error_diagnosis_claims_an_import_restoration():
    diagnosis = diagnose.diagnose(NAME_ERROR_BUNDLE)
    assert diagnosis["claimed_class"] == "name_error"
    repair = diagnosis["claimed_repair"]
    assert repair["op"] == "insert_import"
    assert repair["line"] == "import numpy as np"


def test_signature_diagnosis_claims_the_named_signature():
    diagnosis = diagnose.diagnose(SIGNATURE_BUNDLE)
    assert diagnosis["claimed_class"] == "signature"
    assert diagnosis["claimed_repair"]["op"] == "replace"


def test_misleading_retrieval_claim_is_non_actionable():
    diagnosis = diagnose.diagnose(RETRIEVAL_CLAIM_BUNDLE)
    assert diagnosis["claimed_class"] == "hash_space"
    assert diagnosis["claimed_repair"]["op"] == "non_actionable"


def test_empty_result_bundle_leaves_the_surrogate_no_edit():
    diagnosis = diagnose.diagnose(HASH_SPACE_BUNDLE)
    assert diagnosis["claimed_class"] == "hash_space"
    assert diagnosis["claimed_repair"]["op"] == "non_actionable"


def test_shape_bundle_claims_pair_restoration():
    diagnosis = diagnose.diagnose(SHAPE_BUNDLE)
    assert diagnosis["claimed_class"] == "shape_pairs"


def test_shape_rule_yields_to_retrieval_failure():
    """The CLI prints its shape warning whenever no out-of-database query
    produced a margin - which is also true when retrieval itself is dead.
    The rule must not fire on those bundles (pre-study probes + the pilot
    run both showed this over-firing)."""
    combined = SHAPE_BUNDLE + " " + HASH_SPACE_BUNDLE
    diagnosis = diagnose.diagnose(combined)
    assert diagnosis["claimed_class"] == "hash_space"


def test_undiagnosed_bundle_is_honest():
    diagnosis = diagnose.diagnose("nothing here matches any rule")
    assert diagnosis["claimed_class"] == "undiagnosed"
    assert diagnosis["claimed_repair"]["op"] == "non_actionable"


def test_wrong_repair_fails_the_oracle(tmp_path):
    """The task's negative oracle: a deliberately wrong repair must NOT
    restore the control outcome. Structural half first (no benchmark run),
    then the measured probe record once results exist."""
    key = materialize.load_key()
    paths = materialize.materialize(tmp_path, key)
    control_source = (paths["control"] / "submission.py").read_text(encoding="utf-8")

    target = paths["wrong_order"]
    source = (target / "submission.py").read_text(encoding="utf-8")
    assert source != control_source
    repaired, applied = apply_repair_ops(
        source,
        {"op": "insert_import", "name": "np", "line": "import numpy as np", "file": "submission.py"},
    )
    assert repaired != control_source  # the true defect (sort direction) is untouched
    assert "inserted" in applied

    results = STUDY / "results"
    probe_path = results / "wrong_repair_probe.json"
    if not probe_path.exists():
        pytest.skip("results not yet committed")
    probe = json.loads(probe_path.read_text(encoding="utf-8"))
    assert probe["restored"] is False
    assert probe["oracle_agrees"] is True
