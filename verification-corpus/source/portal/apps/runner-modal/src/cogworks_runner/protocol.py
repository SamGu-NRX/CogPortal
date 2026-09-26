from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict


PROTOCOL_VERSION = "1"
MAX_CLOCK_SKEW_SECONDS = 300
# Workers caps request bodies at 100 MB on Free and Pro plans, and this
# account's plan is not established. The largest trained weight in the 2026
# corpus is 411 KB. Week 3's separate 200 MiB discovery probe is unchanged.
MAX_WEIGHT_BYTES = 100 * 1024 * 1024


class ProtocolError(ValueError):
    pass


def validate_job(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ProtocolError("Run job must be a JSON object.")
    required = {
        "protocolVersion",
        "jobId",
        "runId",
        "mode",
        "preparedArtifactId",
        "source",
        "benchmark",
        "runtime",
        "callback",
    }
    allowed = required | {"weights"}
    if not required.issubset(value) or not set(value).issubset(allowed):
        raise ProtocolError("Run job fields do not match protocol v1.")
    if value["protocolVersion"] != PROTOCOL_VERSION:
        raise ProtocolError("Unsupported runner protocol version.")
    if value["mode"] not in ("practice", "official"):
        raise ProtocolError("Invalid run mode.")
    if value["mode"] == "official" and not value["preparedArtifactId"]:
        raise ProtocolError("Official runs require a prepared artifact.")
    source = value["source"]
    if not isinstance(source, dict) or len(str(source.get("sha", ""))) != 40:
        raise ProtocolError("Run source is invalid.")
    archive_url = str(source.get("archiveUrl", ""))
    if not archive_url.startswith("https://api.github.com/repos/"):
        raise ProtocolError("Source archive must use the public GitHub API.")
    callback_url = str(value["callback"].get("url", ""))
    if not callback_url.startswith("https://"):
        raise ProtocolError("Runner callback must use HTTPS.")
    weights = value.get("weights")
    if weights is None:
        if not value["preparedArtifactId"]:
            raise ProtocolError("A run without a prepared artifact requires weights.")
        weights = []
    if not isinstance(weights, list):
        raise ProtocolError("Run weights must be a JSON array.")
    if len(weights) > 8:
        raise ProtocolError("Run weights may contain at most 8 entries.")
    for weight in weights:
        if not isinstance(weight, dict) or set(weight) != {"path", "size", "sha256"}:
            raise ProtocolError("Run weight entry is invalid.")
        path = weight["path"]
        size = weight["size"]
        sha256 = weight["sha256"]
        if (
            not isinstance(path, str)
            or not path
            or path.startswith("/")
            or ".." in path.split("/")
        ):
            raise ProtocolError("Run weight path is unsafe.")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or size > MAX_WEIGHT_BYTES
        ):
            raise ProtocolError("Run weight size is invalid.")
        if (
            not isinstance(sha256, str)
            or len(sha256) != 64
            or any(character not in "0123456789abcdef" for character in sha256)
        ):
            raise ProtocolError("Run weight digest is invalid.")
    return value


def signature(secret: str, timestamp: str, body: bytes) -> str:
    payload = timestamp.encode("ascii") + b"." + body
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def verify_signature(
    secret: str,
    timestamp: str,
    body: bytes,
    supplied: str,
    now_seconds: int | None = None,
) -> bool:
    try:
        timestamp_seconds = int(timestamp)
    except (TypeError, ValueError):
        return False
    now = int(time.time()) if now_seconds is None else now_seconds
    if abs(now - timestamp_seconds) > MAX_CLOCK_SKEW_SECONDS:
        return False
    candidate = supplied[3:] if supplied.startswith("v1=") else ""
    return hmac.compare_digest(signature(secret, timestamp, body), candidate)


def canonical_json(value: Dict[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
