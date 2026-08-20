"""Which code `cogworks run` scores.

The worst failure this tool can have is scoring the wrong code and reporting
success, because it looks exactly like a pass. It happened: an installed
reference submission answered for `audio-identification` no matter which
directory the command ran in, so an empty repository scored 52%.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import cli  # noqa: E402
from cogbench.plugins import PluginError  # noqa: E402


class _Benchmark:
    contract_version = "cogworks.submissions.v2"

    def submission_from_discovery(self, submission):
        return ("discovered", submission)


class WhichCodeIsScored(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self._resolve = cli.resolve_submission
        self._discover = cli._discover
        self.addCleanup(setattr, cli, "resolve_submission", self._resolve)
        self.addCleanup(setattr, cli, "_discover", self._discover)

    def test_a_submission_file_in_this_repository_wins(self):
        cli.resolve_submission = lambda *a, **k: ("theirs", "file", "submission.py")
        cli._discover = lambda *a, **k: (_ready(), None)

        chosen = cli._submission_for("b", _Benchmark(), self.tmp, as_json=False)

        self.assertEqual(chosen, "theirs")

    def test_an_installed_entry_point_does_not_answer_for_this_repository(self):
        """It belongs to whatever was pip-installed, which on a machine that
        has done more than one week is quite possibly another repository."""

        cli.resolve_submission = lambda *a, **k: (
            "somebody else's",
            "entry_point",
            "cogworks.submissions.v2",
        )
        cli._discover = lambda *a, **k: (_ready(), None)

        chosen = cli._submission_for("b", _Benchmark(), self.tmp, as_json=False)

        self.assertNotEqual(chosen, "somebody else's")
        self.assertEqual(chosen()[0], "discovered")

    def test_an_empty_repository_refuses_rather_than_scoring_something(self):
        cli.resolve_submission = lambda *a, **k: (None, "entry_point", "")
        cli._discover = lambda *a, **k: (None, None)

        with self.assertRaises(PluginError) as caught:
            cli._submission_for("audio-identification", _Benchmark(), self.tmp, as_json=False)

        self.assertIn("cogworks check", str(caught.exception))

    def test_a_repository_that_did_not_resolve_refuses(self):
        cli.resolve_submission = lambda *a, **k: (None, "entry_point", "")
        cli._discover = lambda *a, **k: (_unready(), None)

        with self.assertRaises(PluginError):
            cli._submission_for("b", _Benchmark(), self.tmp, as_json=False)

    def test_a_benchmark_that_cannot_run_a_discovered_binding_refuses(self):
        """Weeks 2 and 3 have no discovery yet. Binding something and having
        no way to run it must not look like a score."""

        class _Old:
            contract_version = "cogworks.submissions.v2"

        cli.resolve_submission = lambda *a, **k: (None, "entry_point", "")
        cli._discover = lambda *a, **k: (_ready(), None)

        with self.assertRaises(PluginError):
            cli._submission_for("b", _Old(), self.tmp, as_json=False)


def _ready():
    class _S:
        ready = True

    return _S()


def _unready():
    class _S:
        ready = False

    return _S()


if __name__ == "__main__":
    unittest.main()
