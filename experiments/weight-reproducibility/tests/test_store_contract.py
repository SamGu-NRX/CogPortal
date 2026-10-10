"""The ported owned-storage contract: writes bind digests, lookups refuse
rather than fall through, aliases resolve only where the traced contract
resolves them. Ported from apps/portal/worker/services/weights.ts; these
tests pin the port so the measurement cases stand on it."""

from __future__ import annotations

import pytest

from harness import artifacts as A
from harness.store import StoreRefusal, WeightStore, content_key, legacy_key


@pytest.fixture()
def store():
    return WeightStore()


def test_content_addressed_write_binds_digest(store):
    record = A.weight_record()
    with pytest.raises(StoreRefusal, match="BadDigest"):
        store.put_content_addressed(
            A.REPO, A.SHA, record["path"], A.SUBSTITUTED_WEIGHT, record["sha256"]
        )
    assert store.head(
        content_key(A.REPO.lower(), A.SHA, record["sha256"], record["path"])
    ) is None


def test_spelling_alias_resolves(store):
    record = A.weight_record()
    store.put_content_addressed(A.REPO, A.SHA, record["path"], A.BENIGN_WEIGHT, record["sha256"])
    found = store.locate(
        A.REPO.upper(), A.SHA, record["path"], record["sha256"], record["size"]
    )
    assert found["status"] == "matched"


def test_legacy_unbound_object_is_refused_not_skipped(store):
    """A pre-digest-era object without a checksum is a refusal, never a
    reason to keep looking."""
    record = A.weight_record()
    store.put_legacy(A.REPO, A.SHA, record["path"], A.BENIGN_WEIGHT, with_checksum=False)
    found = store.locate(A.REPO, A.SHA, record["path"], record["sha256"], record["size"])
    assert found["status"] == "mismatched"


def test_first_found_refusal_never_falls_through(store):
    """A corrupt content-addressed object refuses the run even though a
    matching legacy object sits one key later."""
    record = A.weight_record()
    key = content_key(A.REPO.lower(), A.SHA, record["sha256"], record["path"])
    store.put_raw(key, A.BENIGN_WEIGHT[: A.WEIGHT_SIZE // 2], bound_checksum=record["sha256"])
    store.put_legacy(A.REPO, A.SHA, record["path"], A.BENIGN_WEIGHT)
    found = store.locate(A.REPO, A.SHA, record["path"], record["sha256"], record["size"])
    assert found["status"] == "mismatched" and found["key"] == key


def test_legacy_key_match_still_counts(store):
    record = A.weight_record()
    store.put_legacy(A.REPO, A.SHA, record["path"], A.BENIGN_WEIGHT)
    found = store.locate(A.REPO, A.SHA, record["path"], record["sha256"], record["size"])
    assert found["status"] == "matched" and found["key"] == legacy_key(A.REPO, A.SHA, record["path"])


@pytest.mark.parametrize(
    "path",
    ["", "artifacts//model.bin", "artifacts/./model.bin", "../outside/model.bin", "a\\b.bin"],
)
def test_unsafe_paths_refused(store, path):
    record = A.weight_record()
    with pytest.raises(StoreRefusal, match="inside the repository"):
        store.locate(A.REPO, A.SHA, path, record["sha256"], record["size"])


def test_digest_shapes_enforced(store):
    record = A.weight_record()
    with pytest.raises(StoreRefusal, match="64-character"):
        store.locate(A.REPO, A.SHA, record["path"], record["sha256"].upper(), record["size"])
