from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict


PROTOCOL_VERSION = "1"
MAX_CLOCK_SKEW_SECONDS = 300


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
    if set(value) != required:
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
