from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from . import __version__


USER_AGENT = "CogWorks-Benchmark/{} (+https://github.com/CogWorksBWSI/CogPortal)".format(
    __version__
)
MAX_ATTEMPTS = 3
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


class PortalError(RuntimeError):
    pass


def normalize_portal(value: str) -> str:
    return value.rstrip("/")


def request_json(
    portal: str,
    path: str,
    body: Optional[Dict[str, Any]] = None,
    token: Optional[str] = None,
    retry: bool = False,
    timeout: float = 15,
) -> Dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
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
    attempts = MAX_ATTEMPTS if retry else 1
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raw = error.read()
            if error.code in RETRYABLE_STATUS_CODES and attempt < attempts - 1:
                time.sleep(0.25 * (2**attempt))
                continue
            try:
                payload = json.loads(raw.decode("utf-8"))
                message = payload["error"]["message"]
            except (ValueError, KeyError, TypeError):
                message = "CogPortal returned HTTP {}.".format(error.code)
            raise PortalError(message) from error
        except urllib.error.URLError as error:
            if attempt < attempts - 1:
                time.sleep(0.25 * (2**attempt))
                continue
            raise PortalError("Could not reach CogPortal: {}".format(error.reason)) from error
    raise PortalError("Could not reach CogPortal after {} attempts.".format(attempts))


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
    return request_json(portal, "/api/v1/local-reports", report, token=token, retry=True)


def start_local_run(
    portal: str, token: str, run: Dict[str, Any]
) -> Dict[str, Any]:
    return request_json(portal, "/api/v1/local-runs", run, token=token, retry=True)


def send_local_run_event(
    portal: str, token: str, session_id: str, event: Dict[str, Any]
) -> Dict[str, Any]:
    return request_json(
        portal,
        "/api/v1/local-runs/{}/events".format(session_id),
        event,
        token=token,
        retry=True,
    )


def send_local_run_event_batch(
    portal: str,
    token: str,
    session_id: str,
    events: List[Dict[str, Any]],
) -> Dict[str, Any]:
    return request_json(
        portal,
        "/api/v1/local-runs/{}/events/batch".format(session_id),
        {"events": events},
        token=token,
        retry=False,
        timeout=5,
    )


def device_status(portal: str, token: str) -> Dict[str, Any]:
    return request_json(portal, "/api/v1/cli/device/status", token=token, retry=True)


def update_setup_checks(
    portal: str,
    token: str,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    """Submit explicit, coarse setup evidence after a local command passes.

    This call is deliberately non-retrying: the student asked for one visible
    portal update, and a failure should return control with an actionable retry
    instead of becoming background telemetry.
    """

    return request_json(
        portal,
        "/api/v1/cli/setup/checks",
        payload,
        token=token,
        retry=False,
        timeout=10,
    )
