"""Owned-storage model of the traced weight-sync contract.

Ported from ``apps/portal/worker/services/weights.ts`` (source-indexed in
``sources.PRODUCTION_SOURCES``), which this module mirrors faithfully enough
that its refusal semantics can be probed offline:

- Content-addressed keys: ``weight-objects/<repo>/<sha>/<digest>/<path>``.
  Writing binds the bytes to the key's digest; a write whose bytes do not hash
  to the digest is refused, exactly as R2 refuses ``put(..., {sha256})`` with
  a BadDigest.
- Repository spellings: reads try the exact spelling, then the lowercase one
  (GitHub resolves names without case); writes always land on the lowercase
  spelling.
- Legacy pre-digest keys: ``weights/<repo>/<sha>/<path>`` — mutable, read-only
  today, and counted as a hit only when the stored bytes still hash to the
  digest the run recorded. The first object found is the answer: one that
  fails its checks is a refusal, never a reason to look further.
- Weight paths: never normalized. A path that would need rewriting is refused,
  so two spellings can never name the same object.
"""

from __future__ import annotations

import hashlib
import re

SHA256_HEX = re.compile(r"^[a-f0-9]{64}$")
COMMIT_SHA = re.compile(r"^[a-f0-9]{40}$")
REPOSITORY_FULL_NAME = re.compile(r"^[^/\s]+/[^/\s]+$")
# Mirrors UNSAFE_IN_PATH plus the segment rules of validateWeightPath.
UNSAFE_IN_PATH = re.compile(r"[\\\x00-\x1f\x7f]")


class StoreRefusal(Exception):
    """A write or lookup the traced contract refuses."""


def validate_weight_path(path: str) -> str:
    segments = path.split("/")
    if (
        not path
        or UNSAFE_IN_PATH.search(path)
        or any(seg in ("", ".", "..") for seg in segments)
    ):
        raise StoreRefusal("Weight path must stay inside the repository.")
    return path


def validate_digest(sha256: str | None) -> str:
    if not sha256 or not SHA256_HEX.fullmatch(sha256):
        raise StoreRefusal("digest must be a lowercase 64-character SHA-256 hex string.")
    return sha256


def content_key(repo: str, sha: str, digest: str, path: str) -> str:
    return f"weight-objects/{_locator(repo, sha)}/{validate_digest(digest)}/{validate_weight_path(path)}"


def legacy_key(repo: str, sha: str, path: str) -> str:
    return f"weights/{_locator(repo, sha)}/{validate_weight_path(path)}"


def _locator(repo: str, sha: str) -> str:
    if not REPOSITORY_FULL_NAME.fullmatch(repo) or not COMMIT_SHA.fullmatch(sha):
        raise StoreRefusal("Weight storage needs a repository and a revision.")
    return f"{repo}/{sha}"


class StoredObject:
    def __init__(self, data: bytes, bound_checksum: str | None, size: int | None = None):
        self.data = data
        self.bound_checksum = bound_checksum
        # A truncated object is still the bytes someone wrote; the mismatch the
        # portal detects is between the stored bytes/checksum and the record.
        self.size = len(data) if size is None else size

    @property
    def checksums(self) -> dict:
        return {"sha256": self.bound_checksum}


class WeightStore:
    """In-memory stand-in for the R2 bucket the portal owns."""

    def __init__(self) -> None:
        self._objects: dict[str, StoredObject] = {}

    # -- writes ------------------------------------------------------------
    def put_content_addressed(self, repo: str, sha: str, path: str, data: bytes, digest: str) -> str:
        """Mirrors uploadWeight: lowercase spelling, checksum-bound write."""
        validate_digest(digest)
        key = content_key(repo.lower(), sha, digest, path)
        actual = hashlib.sha256(data).hexdigest()
        if actual != digest:
            raise StoreRefusal("BadDigest: bytes do not hash to the key's digest.")
        self._objects[key] = StoredObject(data, bound_checksum=digest)
        return key

    def put_legacy(self, repo: str, sha: str, path: str, data: bytes, with_checksum: bool = True) -> str:
        """Writes the mutable pre-digest key. ``with_checksum=False`` models
        an older upload whose object carries no sha256 checksum."""
        key = legacy_key(repo, sha, path)
        self._objects[key] = StoredObject(
            data, bound_checksum=hashlib.sha256(data).hexdigest() if with_checksum else None
        )
        return key

    def put_raw(self, key: str, data: bytes, bound_checksum: str | None = None) -> None:
        """Places an object at an arbitrary key, for scenario setup only."""
        self._objects[key] = StoredObject(data, bound_checksum=bound_checksum)

    def truncate(self, key: str, keep: int) -> None:
        obj = self._objects[key]
        self._objects[key] = StoredObject(obj.data[:keep], obj.bound_checksum)

    # -- reads -------------------------------------------------------------
    def head(self, key: str) -> StoredObject | None:
        return self._objects.get(key)

    def spellings(self, repo: str) -> list[str]:
        lower = repo.lower()
        return [repo] if lower == repo else [repo, lower]

    def stored_keys(self, repo: str, sha: str, path: str, digest: str) -> list[str]:
        """Every key a recorded weight may sit at, in reading order:
        every spelling's content-addressed key, then every spelling's
        legacy pre-digest key."""
        names = self.spellings(repo)
        return [
            *(
                content_key(name, sha, digest, path)
                for name in names
            ),
            *(legacy_key(name, sha, path) for name in names),
        ]

    def locate(self, repo: str, sha: str, path: str, digest: str, size: int) -> dict:
        """Mirrors locateRecordedWeight + storedBytesMatch. Returns
        {'status': 'matched'|'mismatched'|'missing', ...}."""
        validate_weight_path(path)
        validate_digest(digest)
        for key in self.stored_keys(repo, sha, path, digest):
            obj = self._objects.get(key)
            if obj is None:
                continue
            digest_hex = obj.checksums["sha256"]
            matched = (
                obj.size == size
                and digest_hex is not None
                and digest_hex == digest
            )
            if matched:
                return {"status": "matched", "key": key}
            return {
                "status": "mismatched",
                "key": key,
                "reason": (
                    "stored bytes no longer match the recorded checksum"
                    if digest_hex is not None
                    else "stored object has no sha256 checksum"
                ),
            }
        return {"status": "missing"}
