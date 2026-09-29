"""Observe a pristine sandbox and bind that observation to its later snapshot.

Run the probe before fetching, installing, or importing a submission. The
controller must retain its stdout outside the sandbox. These source hashes
record what was imported then; they do not attest to post-install integrity.
Only a trusted signed job may supply evidence to the validation helpers.
"""

from __future__ import annotations

import copy
import hashlib
import importlib
import inspect
import json
import platform
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional


# Release declarations, checked against concrete decoder/driver fixtures in
# test_prepared_environment.py. Language 2 decodes nine cases: one text plus
# four retrieval and four search rungs, with a separate pool per component.
# The frozen Language 1 decoder emits only six from the same wire payload;
# test_saved_contract_pairs.py proves that pair must refuse reuse before scoring.
# Scorer-only changes do not change a sandbox contract.
SANDBOX_CONTRACTS = {
    "audio-identification": 1,
    "vision-recognition": 1,
    "vision-clustering": 1,
    "language-search": 2,
}

# EVALUATE_SCRIPT in modal_app.py explicitly requires sys.version_info[:2]
# == (3, 8) for Audio and Language. Its image build pins 3.8.20, but that pin
# does not establish incompatibility with another 3.8 patch. Keep the exact
# observed version as provenance; Vision has no corresponding runtime guard.
_REQUIRED_PYTHON = {
    "audio-identification": "3.8",
    "language-search": "3.8",
}

_MODULES = {
    "audio-identification": (
        "cogworks_runner.week1_payload",
        "audio_identification_benchmark.drivers",
        "audio_identification_benchmark.datasets",
        "audio_identification_benchmark.synth",
    ),
    "vision-recognition": (
        "cogworks_runner.week2_payload",
        "facial_recognition_benchmark.drivers",
    ),
    "vision-clustering": (
        "cogworks_runner.week2_payload",
        "facial_recognition_benchmark.drivers",
    ),
    "language-search": (
        "cogworks_runner.week3_payload",
        "language_search_benchmark.drivers",
        "language_search_benchmark.datasets",
        "language_search_benchmark.perturb",
    ),
}

# These are called by the injected evaluator or its discovery path. Checking
# their presence on the pristine imports rejects older SDKs with missing APIs
# without requiring SDK version or source-hash equality. Callability is only
# an interface-presence check; the decoder/driver tests cover bounded behavior.
_REQUIRED_CALLABLES = {
    "cogbench.plugins": (("load_benchmark",), ("load_submission",)),
    "cogbench.resolve": (("from_spec",),),
    "cogbench.discover": (
        ("_Redirects",), ("_Redirects", "enter"), ("_Redirects", "leave"),
        ("_Redirects", "__enter__"), ("_Redirects", "__exit__"),
    ),
}

UNKNOWN = "Prepared environment compatibility is unknown."
INCOMPATIBLE = "Prepared environment sandbox contract is incompatible with this benchmark."
BINDING_MISMATCH = "Prepared environment does not match this artifact, benchmark, source, or requested weights."
INVALID = "Prepared environment evidence has an invalid schema."
INVALID_OBSERVATION = "Prepared environment observation has an invalid schema."
INCOMPATIBLE_PYTHON = "Prepared environment interpreter does not meet this benchmark's Python 3.8 requirement."


class PreparedEnvironmentError(ValueError):
    """A fixed, controller-safe preparation or compatibility failure."""


def _text(value: Any, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum


def _positive_integer(value: Any) -> bool:
    return type(value) is int and value > 0


def _digest(value: Any, length: int = 64) -> bool:
    return isinstance(value, str) and re.fullmatch("[a-f0-9]{%d}" % length, value) is not None


def _keys(value: Any, keys: Any) -> bool:
    return isinstance(value, dict) and set(value) == set(keys)


def _module_records(value: Any) -> bool:
    return isinstance(value, list) and 1 <= len(value) <= 32 and all(
        _keys(row, ("name", "path", "sha256"))
        and _text(row["name"], 200)
        and _text(row["path"], 500)
        and _digest(row["sha256"])
        for row in value
    )


def _weight_records(value: Any) -> bool:
    return isinstance(value, list) and len(value) <= 8 and all(
        _keys(row, ("path", "sha256"))
        and _text(row["path"], 500)
        and _digest(row["sha256"])
        for row in value
    )


def _observation_shape(value: Any) -> bool:
    return (
        _keys(value, ("sandboxContract", "pythonVersion", "sdkVersion", "modules"))
        and _positive_integer(value["sandboxContract"])
        and _text(value["pythonVersion"], 80)
        and _text(value["sdkVersion"], 80)
        and _module_records(value["modules"])
    )


def validate_record_shape(evidence: Any) -> None:
    """Validate a non-null schema-1 record without deciding eligibility."""
    if not _keys(evidence, (
        "schemaVersion", "artifactId", "benchmarkId", "source", "sandboxContract",
        "baseImageId", "pythonVersion", "sdkVersion", "modules", "weights",
    )):
        raise PreparedEnvironmentError(INVALID)
    source = evidence["source"]
    if not (
        type(evidence["schemaVersion"]) is int and evidence["schemaVersion"] == 1
        and _text(evidence["artifactId"], 200)
        and _text(evidence["benchmarkId"], 120)
        and _text(evidence["baseImageId"], 200)
        and _keys(source, ("repositoryId", "fullName", "sha"))
        and (source["repositoryId"] is None or _positive_integer(source["repositoryId"]))
        and isinstance(source["fullName"], str)
        and re.fullmatch(r"[^/\s]+/[^/\s]+", source["fullName"]) is not None
        and _digest(source["sha"], 40)
        and _observation_shape({key: evidence[key] for key in (
            "sandboxContract", "pythonVersion", "sdkVersion", "modules"
        )})
        and _weight_records(evidence["weights"])
    ):
        raise PreparedEnvironmentError(INVALID)


def _requirement(job: Dict[str, Any]) -> int:
    benchmark = job.get("benchmark")
    if not isinstance(benchmark, dict):
        raise PreparedEnvironmentError(UNKNOWN)
    benchmark_id = benchmark.get("id")
    required = benchmark.get("sandboxContract")
    if not isinstance(benchmark_id, str) or benchmark_id not in SANDBOX_CONTRACTS:
        raise PreparedEnvironmentError(UNKNOWN)
    if not _positive_integer(required):
        raise PreparedEnvironmentError(UNKNOWN)
    if required != SANDBOX_CONTRACTS[benchmark_id]:
        raise PreparedEnvironmentError(INCOMPATIBLE)
    return required


def _validate_interpreter(benchmark_id: str, python_version: str) -> None:
    required = _REQUIRED_PYTHON.get(benchmark_id)
    if required is not None and re.fullmatch(re.escape(required) + r"\.[0-9]+", python_version) is None:
        raise PreparedEnvironmentError(INCOMPATIBLE_PYTHON)


def validate_observation(job: Dict[str, Any], observation: Any) -> None:
    """Check the catalog requirement before any student preparation runs."""
    required = _requirement(job)
    if not _observation_shape(observation):
        raise PreparedEnvironmentError(INVALID_OBSERVATION)
    if observation["sandboxContract"] != required:
        raise PreparedEnvironmentError(INCOMPATIBLE)
    _validate_interpreter(job["benchmark"]["id"], observation["pythonVersion"])


def bind_environment(
    job: Dict[str, Any], observation: Dict[str, Any], snapshot_id: str, base_image_id: str
) -> Dict[str, Any]:
    """Copy a retained pre-student observation and the requested weight digests.

    Call only after successful preparation and snapshot creation. Weight digests
    describe the requested inputs; download verification belongs to preparation.
    This helper is for newly prepared artifacts, never for reconstructing a
    reused artifact's weights from a job that intentionally omits them.
    """
    validate_observation(job, observation)
    try:
        evidence = copy.deepcopy(observation)
        evidence.update({
            "schemaVersion": 1,
            "artifactId": snapshot_id,
            "benchmarkId": job["benchmark"]["id"],
            "source": {key: copy.deepcopy(job["source"][key]) for key in (
                "repositoryId", "fullName", "sha"
            )},
            "baseImageId": base_image_id,
            "weights": [{"path": row["path"], "sha256": row["sha256"]}
                        for row in job["weights"]],
        })
    except (KeyError, TypeError):
        raise PreparedEnvironmentError(BINDING_MISMATCH) from None
    validate_record_shape(evidence)
    return evidence


def validate_prepared_environment(job: Dict[str, Any], evidence: Any) -> Optional[str]:
    """Return a fixed failure reason or None for trusted, bound evidence.

    Artifact availability is deliberately not checked here. A missing provider
    image must still follow the ordinary image lookup failure path. SDK version,
    source hashes and base image are provenance, not eligibility. Interpreter
    requirements apply only to tracks with an explicit evaluator runtime guard.
    """
    try:
        required = _requirement(job)
        if evidence is None:
            return UNKNOWN
        validate_record_shape(evidence)
        if evidence["sandboxContract"] != required:
            return INCOMPATIBLE
        _validate_interpreter(job["benchmark"]["id"], evidence["pythonVersion"])
        source = job.get("source")
        if not isinstance(source, dict):
            return BINDING_MISMATCH
        if (
            evidence["artifactId"] != job.get("preparedArtifactId")
            or evidence["benchmarkId"] != job["benchmark"]["id"]
            or any(key not in source or source[key] != evidence["source"][key]
                   for key in ("repositoryId", "fullName", "sha"))
        ):
            return BINDING_MISMATCH
        # Reuse jobs omit weights, or normalize omission to []. The retained
        # evidence remains the record of the original preparation's weights.
        if job.get("weights"):
            requested = [{"path": row["path"], "sha256": row["sha256"]}
                         for row in job["weights"]]
            if sorted(requested, key=lambda row: (row["path"], row["sha256"])) != sorted(
                evidence["weights"], key=lambda row: (row["path"], row["sha256"])
            ):
                return BINDING_MISMATCH
    except PreparedEnvironmentError as error:
        return str(error)
    except (KeyError, TypeError):
        return BINDING_MISMATCH
    return None


def _validate_sdk_capabilities(name: str, module: Any) -> None:
    for attributes in _REQUIRED_CALLABLES.get(name, ()):
        value = module
        for attribute in attributes:
            value = getattr(value, attribute, None)
        if not callable(value):
            raise PreparedEnvironmentError("Prepared environment SDK lacks required evaluation APIs.")


def probe(benchmark_id: str) -> Dict[str, Any]:
    """Import installed platform modules without importing the Modal app.

    No checkout fallback or sys.path insertion is allowed here: the paths must
    be those this sandbox's interpreter actually imports. The listed modules
    cover the SDK entry points and decoder/driver sources, not every dependency.
    """
    if benchmark_id not in SANDBOX_CONTRACTS:
        raise PreparedEnvironmentError(UNKNOWN)
    modules = []
    try:
        sdk = importlib.import_module("cogbench")
        for name in (
            "cogbench", "cogbench.plugins", "cogbench.models",
            "cogbench.discover", "cogbench.resolve",
        ) + _MODULES[benchmark_id]:
            module = importlib.import_module(name)
            _validate_sdk_capabilities(name, module)
            source = inspect.getsourcefile(module)
            if source is None:
                raise PreparedEnvironmentError("Prepared environment module source is unavailable.")
            path = Path(source).resolve(strict=True)
            modules.append({
                "name": name, "path": str(path),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            })
        observation = {
            "sandboxContract": SANDBOX_CONTRACTS[benchmark_id],
            "pythonVersion": platform.python_version(),
            "sdkVersion": sdk.__version__,
            "modules": modules,
        }
    except (ImportError, OSError, TypeError, AttributeError):
        raise PreparedEnvironmentError("Prepared environment platform imports could not be observed.") from None
    if not _observation_shape(observation):
        raise PreparedEnvironmentError(INVALID_OBSERVATION)
    return observation


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python -m cogworks_runner.prepared_environment <benchmarkId>", file=sys.stderr)
        return 2
    try:
        observation = probe(sys.argv[1])
    except PreparedEnvironmentError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(observation, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
