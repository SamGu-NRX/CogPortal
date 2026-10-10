"""Field-presence and legacy-reuse contract, against the production module.

These load the real ``prepared_environment.py`` from the tree and pin the two
properties the experiment commits as its contract evidence: the exact schema-1
field set, and the legacy rule that a reuse job may omit (or empty) its weight
list while the retained evidence keeps recording the original preparation's
weights. Provenance is not invented: every check names the production module
whose bytes are hashed in ``sources.source_refs``.
"""

from __future__ import annotations

import pytest

from harness.sources import load_prepared_environment_module, source_refs

from harness import artifacts as A


@pytest.fixture(scope="module")
def prod():
    return load_prepared_environment_module()


SCHEMA_FIELDS = (
    "schemaVersion", "artifactId", "benchmarkId", "source", "sandboxContract",
    "baseImageId", "pythonVersion", "sdkVersion", "modules", "weights",
)


def _evidence() -> dict:
    prod = load_prepared_environment_module()
    job = A.job([A.weight_record()])
    observation = A.observation()
    return prod.bind_environment(job, observation, "artifact-fixture-0001", "image-fixture-0001")


def test_valid_evidence_binds_and_reuses(prod):
    evidence = _evidence()
    prod.validate_record_shape(evidence)  # must not raise
    reuse = A.job([], prepared_artifact_id="artifact-fixture-0001")
    assert prod.validate_prepared_environment(reuse, evidence) is None


def test_every_schema_field_is_required(prod):
    evidence = _evidence()
    for field in SCHEMA_FIELDS:
        broken = {key: value for key, value in evidence.items() if key != field}
        with pytest.raises(prod.PreparedEnvironmentError, match="invalid schema"):
            prod.validate_record_shape(broken)


def test_no_extra_field_is_tolerated(prod):
    evidence = _evidence()
    extra = {**evidence, "verifiedBy": "someone"}
    with pytest.raises(prod.PreparedEnvironmentError, match="invalid schema"):
        prod.validate_record_shape(extra)


def test_weight_record_fields_are_exact(prod):
    evidence = _evidence()
    row = evidence["weights"][0]
    with_extra = {**evidence, "weights": [{**row, "size": 1}]}
    with pytest.raises(prod.PreparedEnvironmentError, match="invalid schema"):
        prod.validate_record_shape(with_extra)
    bad_digest = {**evidence, "weights": [{**row, "sha256": row["sha256"].upper()}]}
    with pytest.raises(prod.PreparedEnvironmentError, match="invalid schema"):
        prod.validate_record_shape(bad_digest)


def test_legacy_reuse_rules(prod):
    """A reuse job may omit weights entirely, or normalize omission to [];
    the retained evidence stays the record of the original preparation."""
    evidence = _evidence()
    omit = A.job([], prepared_artifact_id="artifact-fixture-0001")
    assert "weights" not in omit
    assert prod.validate_prepared_environment(omit, evidence) is None
    empty = dict(omit, weights=[])
    assert prod.validate_prepared_environment(empty, evidence) is None


def test_reuse_with_different_weights_refuses(prod):
    evidence = _evidence()
    different = A.job([A.weight_record(data=A.SUBSTITUTED_WEIGHT)], prepared_artifact_id="artifact-fixture-0001")
    reason = prod.validate_prepared_environment(different, evidence)
    assert reason is not None and "does not match" in reason


def test_bind_records_requested_digests_not_storage(prod):
    """bind_environment copies the job's requested weight rows; it never
    reads storage. What a receipt records is what the job asked for."""
    evidence = _evidence()
    job = A.job([A.weight_record()])
    assert evidence["weights"] == [
        {"path": row["path"], "sha256": row["sha256"]} for row in job["weights"]
    ]


def test_source_refs_are_real_tree_hashes():
    refs = source_refs()
    assert {row["name"] for row in refs} == {
        "prepared_environment", "weight_sync_portal", "weight_sync_runner", "protocol"
    }
    for row in refs:
        assert len(row["sha256"]) == 64 and row["sha256"] == row["sha256"].lower()
        from harness.sources import REPO_ROOT

        assert (REPO_ROOT / row["path"]).is_file(), row["path"]
