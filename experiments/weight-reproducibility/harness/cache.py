"""Owned-storage cache publication, including the interrupted case.

Weight-derived render caches (decoded tensors, preprocessed corpora) live in
the same owned storage as the weights themselves. Publication has two steps:
the payload bytes, then an index record naming their digest. An interrupted
publication can leave either alone, and neither half may ever be served as a
complete entry. The rule mirrors the weight store's: an entry is served only
when the payload exists and its hashlib digest equals the digest the index
records; anything else is refused, not skipped and not trusted.
"""

from __future__ import annotations

import hashlib


class CacheStore:
    def __init__(self) -> None:
        self.payloads: dict[str, bytes] = {}
        self.indexes: dict[str, dict] = {}

    @staticmethod
    def index_digest(payload: bytes) -> str:
        return hashlib.sha256(payload).hexdigest()

    def publish(self, key: str, payload: bytes) -> dict:
        index = {"digest": self.index_digest(payload), "complete": True}
        self.payloads[key] = payload
        self.indexes[key] = index
        return index

    def publish_interrupted_payload_only(self, key: str, payload: bytes) -> None:
        """Crash between the payload write and the index write."""
        self.payloads[key] = payload
        self.indexes.pop(key, None)

    def publish_interrupted_unsealed(self, key: str, payload: bytes) -> None:
        """Crash after a partial index write: a record exists but is not
        sealed with the payload's digest."""
        self.payloads[key] = payload
        self.indexes[key] = {"digest": None, "complete": False}

    def resolve(self, key: str) -> dict:
        """Serve-or-refuse decision for one cache read."""
        payload = self.payloads.get(key)
        index = self.indexes.get(key)
        if payload is None and index is None:
            return {"status": "missing", "reason": "no payload and no index"}
        if index is None or index.get("digest") is None:
            return {
                "status": "refused",
                "reason": "publication did not complete; index is absent or unsealed",
            }
        if payload is None:
            return {"status": "refused", "reason": "index names a payload that is absent"}
        recomputed = hashlib.sha256(payload).hexdigest()
        if recomputed != index["digest"]:
            return {
                "status": "refused",
                "reason": "payload bytes do not hash to the indexed digest",
            }
        return {"status": "matched", "digest": recomputed}
