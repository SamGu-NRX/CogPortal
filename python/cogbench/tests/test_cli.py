from __future__ import annotations

import io
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.cli import main  # noqa: E402
from cogbench.client import PortalError  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
