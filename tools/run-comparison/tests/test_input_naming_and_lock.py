"""CLI regressions for distinct input names and Windows lock failures."""

import errno
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import build

WORKBENCH = Path(__file__).resolve().parents[1]
FIXTURES = WORKBENCH / "fixtures"


def _run(tool, out, *inputs):
    command = [sys.executable, str(WORKBENCH / tool), "--out", str(out)]
    for path in inputs:
        command += ["--fixtures", str(path)]
    if tool == "build.py":
        command += ["--replay"]
    return subprocess.run(command, capture_output=True, text=True, timeout=10)


def test_build_keeps_same_named_inputs_distinct_in_receipt_and_view(tmp_path):
    paths = []
    for directory, fixture in (("left", "01-run-a.json"), ("right", "02-run-b.json")):
        path = tmp_path / directory / "run.json"
        path.parent.mkdir()
        path.write_bytes((FIXTURES / fixture).read_bytes())
        paths.append(path)
    out = tmp_path / "evidence"
    result = _run("build.py", out, *reversed(paths))
    assert result.returncode == 0, result.stdout + result.stderr
    receipt = json.loads(next(out.glob("view-receipts-*.json")).read_text())
    expected = ["left/run.json", "right/run.json"]
    assert receipt["compared"] == expected
    assert "input_naming.py" in receipt["tool_source"]["files"]
    assert [entry["file"] for entry in receipt["inputs"]] == expected
    view = next(out.glob("view-*.html")).read_text()
    for identity in expected:
        assert identity in view
    verified = _run("verify.py", out, *paths)
    assert verified.returncode == 0, verified.stdout + verified.stderr


@pytest.mark.parametrize("tool", ["build.py", "verify.py"])
@pytest.mark.parametrize("alias", [False, True])
def test_cli_refuses_the_same_input_twice(tmp_path, tool, alias):
    report = FIXTURES / "01-run-a.json"
    second = report
    if alias:
        second = tmp_path / "alias.json"
        second.symlink_to(report)
    result = _run(tool, tmp_path / "evidence", report, second)
    assert result.returncode == 2, result.stdout + result.stderr
    assert "the same fixture file is given more than once" in result.stderr
    assert "01-run-a.json" in result.stderr
    assert not list((tmp_path / "evidence").glob("view-*"))


def test_windows_lock_invalid_argument_fails_without_retry(tmp_path, monkeypatch):
    calls = []

    def locking(*args):
        calls.append(args)
        if len(calls) > 1:
            pytest.fail("retried a non-contention lock failure")
        raise OSError(errno.EINVAL, "invalid locking operation")

    monkeypatch.setattr(build, "fcntl", None)
    monkeypatch.setattr(
        build, "msvcrt", SimpleNamespace(locking=locking, LK_LOCK=1, LK_UNLCK=0),
        raising=False,
    )
    # Older heads import msvcrt inside output_lock. Supply the same fake
    # there too, so fail-before exercises the retry rather than an import.
    monkeypatch.setitem(sys.modules, "msvcrt", build.msvcrt)
    out = tmp_path / "evidence"
    monkeypatch.setattr(sys, "argv", [
        "build.py", "--out", str(out), "--fixtures", str(FIXTURES), "--replay",
    ])
    with pytest.raises(OSError) as caught:
        build.main()
    assert caught.value.errno == errno.EINVAL
    assert str(out / ".build.lock") in str(caught.value)
    assert len(calls) == 1
    assert not list(out.glob("view-*"))


@pytest.mark.parametrize("contention", [errno.EACCES, errno.EDEADLK])
def test_windows_lock_retries_only_contention(tmp_path, monkeypatch, contention):
    calls = []

    def locking(fd, mode, size):
        calls.append(mode)
        if len(calls) == 1:
            raise OSError(contention, "lock is held")

    monkeypatch.setattr(build, "fcntl", None)
    monkeypatch.setattr(build, "msvcrt", SimpleNamespace(locking=locking, LK_LOCK=1, LK_UNLCK=0))
    with build.output_lock(tmp_path / "evidence"):
        assert calls == [1, 1]
    assert calls == [1, 1, 0]
