import sys
from pathlib import Path

import pytest

STUDY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(STUDY))

RESULTS = STUDY / "results"


def test_replay_agrees_with_committed_results():
    if not (RESULTS / "raw").exists():
        pytest.skip("results not yet committed")
    import run as runner

    exit_code = runner.replay(RESULTS)
    replay = __import__("json").loads((RESULTS / "replay.json").read_text(encoding="utf-8"))
    assert replay["agrees"] is True, replay["problems"]
    assert exit_code == 0


def test_unmeasured_tracks_are_declared():
    manifest = __import__("json").loads((STUDY / "manifest.json").read_text(encoding="utf-8"))
    unmeasured = [t["name"] for t in manifest["tracks"] if not t["measured"]]
    assert "vision-recognition" in unmeasured
    assert "vision-clustering" in unmeasured
    assert "language-search" in unmeasured
