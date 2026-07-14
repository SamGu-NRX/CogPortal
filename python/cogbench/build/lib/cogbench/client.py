from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional


class PortalError(RuntimeError):
    pass


def normalize_portal(value: str) -> str:
    return value.rstrip("/")


def request_json(
    portal: str,
    path: str,
    body: Optional[Dict[str, Any]] = None,
    token: Optional[str] = None,
) -> Dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer {}".format(token)
    request = urllib.request.Request(
        normalize_portal(portal) + path,
        data=data,
        headers=headers,
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
            message = payload["error"]["message"]
        except (ValueError, KeyError, TypeError):
            message = "CogPortal returned HTTP {}.".format(error.code)
        raise PortalError(message) from error
    except urllib.error.URLError as error:
        raise PortalError("Could not reach CogPortal: {}".format(error.reason)) from error


def start_device_link(portal: str) -> Dict[str, Any]:
    return request_json(portal, "/api/v1/cli/device/start", {})


def poll_device_link(portal: str, device_code: str, interval: int, expires_at: int) -> Dict[str, Any]:
    while int(time.time() * 1000) < expires_at:
        result = request_json(
            portal,
            "/api/v1/cli/device/token",
            {"deviceCode": device_code},
        )
        if result.get("status") == "authorized":
            return result
        time.sleep(max(interval, int(result.get("retryAfterSeconds", interval))))
    raise PortalError("The device link expired before it was approved.")


def sync_report(portal: str, token: str, report: Dict[str, Any]) -> Dict[str, Any]:
    report.pop("outputDigest", None)
    return request_json(portal, "/api/v1/local-reports", report, token=token)
