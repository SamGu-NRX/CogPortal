"""Loader variants and the receipt layer that wraps them.

Two loaders model the fork the experiment measures:

- ``VerifyingLoader`` mirrors the runner's preparation loop in
  ``apps/runner-modal/src/cogworks_runner/modal_app.py``: stream the object in
  chunks through hashlib.sha256, refuse on size drift, then refuse on digest
  mismatch, before the bytes are handed to anything that runs.

- ``LegacyLoader`` trusts whatever record it was handed and returns the stored
  bytes unverified. Real code does not ship this shape; it stands in for any
  path that hands weight bytes to the evaluator without re-deriving them from
  the recorded digest, which is the gap the changed-loader family measures.

``Receipt`` binds a prepared-artifact record with the production module loaded
from the tree (``sources.load_prepared_environment_module``) and answers one
question per dispatch: does the receipt's validation accept this job, and does
the store still hold what the receipt recorded?
"""

from __future__ import annotations

import hashlib

from .store import StoreRefusal, WeightStore


class VerifyingLoader:
    name = "verifying"

    def __init__(self, store: WeightStore):
        self.store = store

    def load(self, repo: str, sha: str, weight: dict) -> bytes:
        found = self.store.locate(repo, sha, weight["path"], weight["sha256"], weight["size"])
        if found["status"] != "matched":
            raise StoreRefusal(f"weight sync refused {weight['path']}: {found['status']}")
        obj = self.store.head(found["key"])
        # The runner-side loop: hash the bytes as they stream, in chunks, then
        # check size and digest. Loading is the check, not a courtesy.
        digest = hashlib.sha256()
        for start in range(0, len(obj.data), 1024):
            digest.update(obj.data[start : start + 1024])
        if obj.size != weight["size"]:
            raise StoreRefusal(f"size changed for {weight['path']}")
        if digest.hexdigest() != weight["sha256"]:
            raise StoreRefusal(f"weight file {weight['path']} did not match its digest.")
        return obj.data


class LegacyLoader(VerifyingLoader):
    """Skips the rehash: bytes go straight from storage to the model."""

    name = "legacy-unverified"

    def load(self, repo: str, sha: str, weight: dict) -> bytes:
        found = self.store.locate(repo, sha, weight["path"], weight["sha256"], weight["size"])
        if found["status"] != "matched":
            raise StoreRefusal(f"weight sync refused {weight['path']}: {found['status']}")
        return self.store.head(found["key"]).data


class Receipt:
    """The prepared-artifact receipt, validated by the production module."""

    def __init__(self, production):
        self._prod = production
        self.evidence: dict | None = None

    def bind(self, prod_job: dict, observation: dict, artifact_id: str, base_image_id: str) -> dict:
        """bind_environment on the freshly prepared artifact."""
        self.evidence = self._prod.bind_environment(
            prod_job, observation, artifact_id, base_image_id
        )
        return self.evidence

    def check_reuse(self, prod_job: dict) -> str | None:
        """Production validate_prepared_environment on a reuse dispatch:
        None accepts, a string is the fixed refusal reason."""
        return self._prod.validate_prepared_environment(prod_job, self.evidence)

    def weight_rows(self) -> list[dict]:
        return [
            {"path": row["path"], "sha256": row["sha256"]}
            for row in self.evidence["weights"]
        ]
