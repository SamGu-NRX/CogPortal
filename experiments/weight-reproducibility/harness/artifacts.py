"""Tiny synthetic submission artifact and deterministic stand-in model.

Everything here is invented fixture data: 2 KB "weights", a one-file "source
archive", a fake commit sha. The model's prediction is a deterministic
function of the loaded weight bytes alone, which is exactly what makes it a
usable oracle: if a case changes the bytes the evaluator would actually use
and the prediction stays the same, the case was not measuring what it claims.
"""

from __future__ import annotations

import hashlib

REPO = "course/submit-2026"
SHA = "a" * 40
WEIGHT_PATH = "artifacts/model.bin"
WEIGHT_SIZE = 2048

BENIGN_WEIGHT = bytes((i * 7 + 3) % 256 for i in range(WEIGHT_SIZE))
# Same length, different content: the substitution the receipt layer must see.
SUBSTITUTED_WEIGHT = bytes((i * 11 + 91) % 256 for i in range(WEIGHT_SIZE))

assert len(SUBSTITUTED_WEIGHT) == len(BENIGN_WEIGHT) == WEIGHT_SIZE
assert hashlib.sha256(BENIGN_WEIGHT).hexdigest() != hashlib.sha256(SUBSTITUTED_WEIGHT).hexdigest()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def weight_record(path: str = WEIGHT_PATH, data: bytes = BENIGN_WEIGHT) -> dict:
    """The WeightFile wire record: {path, size, sha256}."""
    return {"path": path, "size": len(data), "sha256": sha256(data)}


def job(weights: list[dict], prepared_artifact_id: str | None = None) -> dict:
    """A minimal RunJobV1-shaped job, limited to the fields the receipt
    validator reads. ``preparedArtifactId`` set means a reuse dispatch."""
    job: dict = {
        "benchmark": {"id": "vision-recognition", "sandboxContract": 1},
        "source": {
            "repositoryId": 1,
            "fullName": REPO,
            "sha": SHA,
        },
    }
    if prepared_artifact_id is not None:
        job["preparedArtifactId"] = prepared_artifact_id
    if weights or prepared_artifact_id is None:
        job["weights"] = [dict(row) for row in weights]
    return job


def observation(benchmark_id: str = "vision-recognition") -> dict:
    """A schema-valid pristine-sandbox observation: the four observation keys
    the receipt binds, with module records and a fake sdk version."""
    return {
        "sandboxContract": 1,
        "pythonVersion": "3.11.7",
        "sdkVersion": "2026.10.0-fixture",
        "modules": [
            {
                "name": "cogbench",
                "path": "/fixture/cogbench/__init__.py",
                "sha256": sha256(b"fixture module cogbench"),
            }
        ],
    }


def predict(weights: dict[str, bytes]) -> str:
    """Deterministic stand-in for 'run the model on the loaded weights'."""
    digest = hashlib.sha256()
    for path in sorted(weights):
        digest.update(path.encode("utf-8"))
        digest.update(weights[path])
    return "score-" + digest.hexdigest()[:16]
