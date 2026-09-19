from __future__ import annotations

import io
import sys
import unittest
from datetime import datetime, timezone
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.cli import _format_expiry, _parser, _print_report, main  # noqa: E402
from cogbench.client import PortalError  # noqa: E402
from cogbench.models import LocalReport, Metric, RepositoryState  # noqa: E402


class CliContractTests(unittest.TestCase):
    def test_bare_command_prints_help_and_succeeds(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            self.assertEqual(main([]), 0)
        self.assertIn("usage: cogworks", stdout.getvalue())
        self.assertIn("check", stdout.getvalue())

    def test_offline_check_never_submits_setup_without_flag(self):
        with patch("cogbench.cli._check", return_value=0):
            with patch("cogbench.cli._update_setup") as update:
                self.assertEqual(main(["check", "--benchmark", "vision-recognition"]), 0)
        update.assert_not_called()

    def test_update_setup_names_the_benchmark_that_was_checked(self):
        # Two of the four checks are about one benchmark: the install line
        # names a distribution and wiring resolves that benchmark's entry
        # points. Without the id the portal recorded them against the student
        # and team only, and the setup page marked whichever track it was
        # showing as installed and wired.
        with patch("cogbench.cli._check", return_value=0):
            with patch("cogbench.cli._update_setup") as update:
                self.assertEqual(
                    main(
                        [
                            "check",
                            "--benchmark",
                            "vision-recognition",
                            "--update-setup",
                        ]
                    ),
                    0,
                )
        self.assertEqual(update.call_args.args[3], "vision-recognition")

    def test_setup_payload_omits_the_benchmark_when_there_is_none(self):
        # `cogworks link` reports the clone and nothing else, so there is no
        # benchmark to name. The key is left out rather than sent empty: a
        # portal pinned before the field exists rejects unknown properties.
        from cogbench import cli

        repository = SimpleNamespace(full_name="demo-org/solo")
        with patch("cogbench.cli.repository_state", return_value=repository):
            with patch("cogbench.cli.plugin_names", return_value=[]):
                without = cli._setup_payload(("clone",), Path("."))
                with_benchmark = cli._setup_payload(
                    ("clone", "environment", "project", "wiring"),
                    Path("."),
                    "audio-identification",
                )
        self.assertNotIn("checkedBenchmarkId", without)
        self.assertEqual(with_benchmark["checkedBenchmarkId"], "audio-identification")

    def test_flagged_local_success_returns_two_when_portal_update_fails(self):
        stderr = io.StringIO()
        with patch("cogbench.cli._check", return_value=0):
            with patch(
                "cogbench.cli._update_setup",
                side_effect=PortalError("Could not reach CogPortal: offline"),
            ):
                with redirect_stderr(stderr):
                    result = main(
                        [
                            "check",
                            "--benchmark",
                            "vision-recognition",
                            "--update-setup",
                        ]
                    )
        self.assertEqual(result, 2)
        self.assertIn("Could not reach CogPortal", stderr.getvalue())


class ReportFormattingTests(unittest.TestCase):
    def test_primary_metrics_keep_four_decimals_and_seconds_get_a_unit(self):
        report = LocalReport(
            report_id="local_test",
            benchmark_id="audio-identification",
            benchmark_version=1,
            contract_version="cogworks.submissions.v2",
            sdk_version="0.2.0",
            plugin_version="0.2.0",
            repository=RepositoryState(None, None, None, False),
            started_at=1,
            finished_at=2,
            metrics=[
                Metric(
                    "identification_score",
                    "Identification score",
                    0.5375,
                    None,
                    True,
                    True,
                    3,
                ),
                Metric(
                    "median_identify_seconds",
                    "Median identify time",
                    0.025,
                    None,
                    False,
                    False,
                    3,
                ),
                Metric("latency", "Latency", 12.3, "ms", False, False, 1),
            ],
            diagnostics=[],
            output_digest="digest",
        )
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            _print_report(report)

        text = stdout.getvalue()
        self.assertIn("Identification score: 0.5375", text)
        self.assertIn("Median identify time: 0.025 s", text)
        self.assertIn("Latency: 12.3 ms", text)


class HelpTextTests(unittest.TestCase):
    def _subcommand_help(self, command):
        stdout = io.StringIO()
        with self.assertRaises(SystemExit), redirect_stdout(stdout):
            _parser().parse_args([command, "--help"])
        return stdout.getvalue()

    def test_main_help_explains_test_in_plain_words(self):
        self.assertIn(
            "check your code against one small benchmark case",
            _parser().format_help(),
        )

    def test_link_help_explains_portal_and_browser_options(self):
        text = self._subcommand_help("link")
        self.assertIn("use this CogPortal address instead of the saved one", text)
        self.assertIn("print the approval link without opening your browser", text)

    def test_sync_help_explains_the_optional_report_path(self):
        text = self._subcommand_help("sync")
        self.assertIn("saved report file to sync", text)
        # argparse wraps help at 80 columns, so the phrase may carry a line
        # break; compare with whitespace collapsed.
        self.assertIn("uses the latest report when omitted", " ".join(text.split()))
        self.assertIn("use this CogPortal address instead of the saved one", text)


class StatusFormattingTests(unittest.TestCase):
    def test_expiry_is_a_utc_date_with_calendar_days_remaining(self):
        expires = int(
            datetime(2026, 9, 22, 19, 8, 3, 130000, tzinfo=timezone.utc).timestamp()
            * 1000
        )
        now = datetime(2026, 9, 5, 1, 0, tzinfo=timezone.utc)
        self.assertEqual(_format_expiry(expires, now), "Sep 22 (in 17 days)")

    def test_status_hides_the_discord_id_and_states_both_channel_states(self):
        base = {
            "githubLogin": "student",
            "teamName": "Team",
            "repositoryFullName": "course/team",
            "deviceName": "Laptop",
            "deviceExpiresAt": 1,
        }
        for channel_id, expected in (
            ("1515858059405295762", "Discord  team channel chosen"),
            (None, "Discord  team channel not chosen"),
        ):
            stdout = io.StringIO()
            value = dict(base, discordChannelId=channel_id)
            with patch("cogbench.cli._portal", return_value="https://portal.example"):
                with patch("cogbench.cli.token_for", return_value="token"):
                    with patch("cogbench.cli.device_status", return_value=value):
                        with patch("cogbench.cli._format_expiry", return_value="Sep 22 (in 17 days)"):
                            with redirect_stdout(stdout):
                                self.assertEqual(main(["status"]), 0)
            text = stdout.getvalue()
            self.assertIn(expected, text)
            self.assertNotIn("1515858059405295762", text)
            self.assertIn("Expires  Sep 22 (in 17 days)", text)


if __name__ == "__main__":
    unittest.main()
