"""Run the real link command against the test Worker's loopback HTTP server.

Only local persistence, repository discovery and polling delays are replaced.
Device start, polling and bearer-token verification use the real HTTP client.
"""
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, sys.argv[2])

from cogbench.cli import main
from cogbench.client import device_status

portal = sys.argv[1]
with patch("cogbench.client.time.sleep"), \
        patch("cogbench.cli.save_token") as save, \
        patch("cogbench.cli.repository_state", return_value=SimpleNamespace(full_name=None)), \
        patch("cogbench.cli._installed_benchmark_hint", return_value="vision-recognition"):
    assert main(["link", "--portal", portal, "--no-browser"]) == 0

save.assert_called_once()
status = device_status(portal, save.call_args.args[1])
assert status["githubLogin"] == "ada", status
assert status["teamName"] == "Team A", status
