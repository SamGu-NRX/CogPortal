from __future__ import annotations

import io
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.client import (
    PortalError,
    USER_AGENT,
    default_device_name,
    poll_device_link,
    request_json,
    send_local_run_event_batch,
    start_device_link,
    update_setup_checks,
)


class _JsonResponse:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self) -> bytes:
        return b'{"ok": true}'


class PortalClientTests(unittest.TestCase):
    @patch("cogbench.client.urllib.request.urlopen", return_value=_JsonResponse())
    def test_requests_identify_cogbench_instead_of_python_urllib(self, urlopen):
        result = request_json("https://portal.example", "/api/test", {})

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), USER_AGENT)
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(result, {"ok": True})

    @patch("cogbench.client.time.sleep")
    @patch(
        "cogbench.client.urllib.request.urlopen",
        side_effect=[urllib.error.URLError("temporary timeout"), _JsonResponse()],
    )
    def test_transient_network_failures_retry_idempotent_requests(self, urlopen, sleep):
        self.assertEqual(request_json("https://portal.example", "/api/test", {}, retry=True), {"ok": True})
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(0.25)

    @patch("cogbench.client.time.sleep")
    def test_authorization_errors_fail_without_retrying(self, sleep):
        error = urllib.error.HTTPError(
            "https://portal.example/api/test",
            403,
            "Forbidden",
            {},
            io.BytesIO(b'{"error":{"message":"Device revoked."}}'),
        )
        with patch("cogbench.client.urllib.request.urlopen", side_effect=error) as urlopen:
            with self.assertRaisesRegex(PortalError, "Device revoked"):
                request_json("https://portal.example", "/api/test", {})
        urlopen.assert_called_once()
        sleep.assert_not_called()

    def test_device_authorization_posts_are_never_generically_retried(self):
        with patch("cogbench.client.request_json") as request:
            request.return_value = {"deviceCode": "device-code"}
            start_device_link("https://portal.example", "macos-a1b2c3")
            request.assert_called_once_with(
                "https://portal.example",
                "/api/v1/cli/device/start",
                {"deviceName": "macos-a1b2c3"},
            )

    def test_default_device_name_carries_no_hostname_fragment(self):
        # The lead's report: a campus machine's name is its reverse-DNS
        # address, and a name built from it would put the student's network
        # identity in portal data. Both stdlib hostname reads are pointed at
        # such a machine; the default may not echo any of it back.
        distinctive = "wireless-10-148-67-40.public.utexas.edu"
        with patch("socket.gethostname", return_value=distinctive), \
                patch("platform.node", return_value=distinctive):
            name = default_device_name()
        for fragment in (distinctive, "wireless", "10-148-67-40", "utexas"):
            self.assertNotIn(fragment, name)
        self.assertRegex(name, r"^[a-z]+-[0-9a-f]{6}$")

    @patch("cogbench.client.time.sleep")
    @patch("cogbench.client.time.time", side_effect=[1.0, 1.0])
    def test_device_token_poll_does_not_retry_issuance_request(self, _time, sleep):
        with patch("cogbench.client.request_json") as request:
            request.return_value = {"status": "authorized", "token": "cog_test"}
            result = poll_device_link("https://portal.example", "device-code", 5, 10_000)
            self.assertEqual(result["token"], "cog_test")
            request.assert_called_once_with(
                "https://portal.example",
                "/api/v1/cli/device/token",
                {"deviceCode": "device-code"},
            )
            sleep.assert_not_called()

    def test_terminal_event_batch_uses_one_bounded_non_retrying_request(self):
        events = [{"type": "progress", "sequence": 0}]
        with patch("cogbench.client.request_json", return_value={"ok": True}) as request:
            send_local_run_event_batch(
                "https://portal.example",
                "device-token",
                "localrun_123",
                events,
            )
        request.assert_called_once_with(
            "https://portal.example",
            "/api/v1/local-runs/localrun_123/events/batch",
            {"events": events},
            token="device-token",
            retry=False,
            timeout=5,
        )

    def test_setup_update_is_bearer_authenticated_and_never_retried(self):
        payload = {
            "schemaVersion": 1,
            "repositoryFullName": "course/team",
            "checks": ["environment", "project", "wiring"],
        }
        with patch(
            "cogbench.client.request_json",
            return_value={"accepted": payload["checks"]},
        ) as request:
            result = update_setup_checks(
                "https://portal.example",
                "cog_device",
                payload,
            )
        self.assertEqual(result["accepted"], payload["checks"])
        request.assert_called_once_with(
            "https://portal.example",
            "/api/v1/cli/setup/checks",
            payload,
            token="cog_device",
            retry=False,
            timeout=10,
        )


if __name__ == "__main__":
    unittest.main()
