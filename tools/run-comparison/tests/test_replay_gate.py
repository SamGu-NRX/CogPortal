"""Failure-path tests for the validate-before-write replay gate.

Each test builds the evidence triple (view, receipt, replay receipt)
fresh in a temporary directory, then attacks it: a tampered view, a
tampered receipt, a fixture edited after the fact, a half-deleted
evidence directory, a tampered or missing replay receipt. The gate must
refuse with named disagreement lines, exit nonzero, and leave every
artifact byte-identical to what it refused to overwrite; verify.py must
catch the same tampering with a ``misrendered:`` line. ``--force`` is
the one path past the gate, and it must hand back a green one.
"""

import json
import subprocess
import sys
from pathlib import Path

WORKBENCH = Path(__file__).resolve().parents[1]
FIXTURES = WORKBENCH / "fixtures"
REPO_ROOT = WORKBENCH.parents[1]

PAIR_STEM = "01-run-a-vs-02-run-b"
VIEW = "view-{}.html".format(PAIR_STEM)
RECEIPT = "view-receipts-{}.json".format(PAIR_STEM)
REPLAY = "replay-{}.json".format(PAIR_STEM)


def _run_build(out, *extra, fixtures=FIXTURES):
    return subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "build.py"),
            "--fixtures",
            str(fixtures),
            "--out",
            str(out),
            *extra,
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _run_verify(out):
    return subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "verify.py"),
            "--fixtures",
            str(FIXTURES),
            "--out",
            str(out),
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )


def _snapshot(out):
    """Byte snapshot of the evidence triple, None where a file is absent."""

    return {
        name: (out / name).read_bytes() if (out / name).exists() else None
        for name in (VIEW, RECEIPT, REPLAY)
    }


def _copy_fixtures(tmp_path):
    target = tmp_path / "fixtures"
    target.mkdir()
    for fixture in sorted(FIXTURES.glob("*.json")):
        (target / fixture.name).write_bytes(fixture.read_bytes())
    return target


def _canonical(payload):
    return json.dumps(payload, indent=2, sort_keys=True) + "\n"


def test_first_gated_build_writes_and_a_second_gate_is_byte_idempotent(tmp_path):
    out = tmp_path / "evidence"
    first = _run_build(out, "--replay")
    assert first.returncode == 0, first.stdout + first.stderr
    assert all((out / name).exists() for name in (VIEW, RECEIPT, REPLAY))
    before = _snapshot(out)

    second = _run_build(out, "--replay")
    assert second.returncode == 0, second.stdout + second.stderr
    assert "existing evidence validated against a fresh build" in second.stdout
    assert _snapshot(out) == before


def test_gated_replay_refuses_a_tampered_view_and_preserves_all_evidence(tmp_path):
    out = tmp_path / "evidence"
    assert _run_build(out, "--replay").returncode == 0
    view = out / VIEW
    view.write_bytes(view.read_bytes().replace(b"Run comparison", b"Tampered comparison"))
    before = _snapshot(out)

    result = _run_build(out, "--replay")
    assert result.returncode == 1
    assert "replay disagreement" in result.stderr
    assert _snapshot(out) == before  # nothing overwritten, nothing deleted


def test_gated_replay_refuses_a_tampered_receipt_and_preserves_all_evidence(tmp_path):
    out = tmp_path / "evidence"
    assert _run_build(out, "--replay").returncode == 0
    receipt_path = out / RECEIPT
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    receipt["metrics"]["shared"][0]["run_b"] = "9.9999"
    receipt_path.write_text(_canonical(receipt), encoding="utf-8")
    before = _snapshot(out)

    result = _run_build(out, "--replay")
    assert result.returncode == 1
    assert "replay disagreement" in result.stderr
    assert _snapshot(out) == before


def test_gated_replay_refuses_stale_evidence_after_a_fixture_change(tmp_path):
    fixtures = _copy_fixtures(tmp_path)
    out = tmp_path / "evidence"
    assert _run_build(out, "--replay", fixtures=fixtures).returncode == 0

    # A fixture edited after the evidence was generated makes it stale:
    # the gate must notice the input digests moved and refuse.
    stale = json.loads((fixtures / "01-run-a.json").read_text(encoding="utf-8"))
    stale["metrics"][0]["value"] = 0.6
    (fixtures / "01-run-a.json").write_text(_canonical(stale), encoding="utf-8")
    before = _snapshot(out)

    result = _run_build(out, "--replay", fixtures=fixtures)
    assert result.returncode == 1
    assert "replay disagreement" in result.stderr
    assert _snapshot(out) == before


def test_gated_replay_refuses_a_mixed_state_and_preserves_artifacts(tmp_path):
    out = tmp_path / "evidence"
    assert _run_build(out, "--replay").returncode == 0
    (out / REPLAY).unlink()
    before = _snapshot(out)

    result = _run_build(out, "--replay")
    assert result.returncode == 1
    assert "mixed state" in result.stderr
    assert _snapshot(out) == before


def test_verify_detects_a_tampered_replay_receipt(tmp_path):
    out = tmp_path / "evidence"
    assert _run_build(out, "--replay").returncode == 0
    replay_path = out / REPLAY
    replay = json.loads(replay_path.read_text(encoding="utf-8"))
    replay["html_sha256"] = "0" * 64
    replay_path.write_text(_canonical(replay), encoding="utf-8")

    result = _run_verify(out)
    assert result.returncode == 1
    assert "misrendered" in result.stderr
    assert "replay receipt" in result.stderr


def test_verify_detects_a_missing_replay_receipt(tmp_path):
    out = tmp_path / "evidence"
    assert _run_build(out, "--replay").returncode == 0
    (out / REPLAY).unlink()

    result = _run_verify(out)
    assert result.returncode == 1
    assert "misrendered" in result.stderr


def test_verify_detects_a_stale_generator_digest_in_both_receipts(tmp_path):
    out = tmp_path / "evidence"
    assert _run_build(out, "--replay").returncode == 0
    for name in (RECEIPT, REPLAY):
        path = out / name
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["tool_source"]["files"]["build.py"] = "0" * 64
        path.write_text(_canonical(payload), encoding="utf-8")

    result = _run_verify(out)
    assert result.returncode == 1
    assert "misrendered" in result.stderr
    # Both receipts are checked against the current generator sources.
    assert result.stderr.count("tool_source digests do not match") == 2


def test_force_regenerates_disagreeing_evidence_and_restores_the_gate(tmp_path):
    out = tmp_path / "evidence"
    assert _run_build(out, "--replay").returncode == 0
    view = out / VIEW
    view.write_bytes(view.read_bytes().replace(b"Run comparison", b"Tampered comparison"))
    assert _run_build(out, "--replay").returncode == 1  # the gate refuses

    forced = _run_build(out, "--replay", "--force")
    assert forced.returncode == 0, forced.stdout + forced.stderr
    assert "--force replaces existing evidence" in forced.stdout

    fresh = tmp_path / "fresh"
    assert _run_build(fresh, "--replay").returncode == 0
    assert _snapshot(out) == _snapshot(fresh)  # regenerated == never tampered

    again = _run_build(out, "--replay")
    assert again.returncode == 0, again.stdout + again.stderr  # gate green again
    assert _run_verify(out).returncode == 0


def test_gated_replay_refuses_a_tampered_generator_field_and_preserves_all_evidence(tmp_path):
    """A tampered generator field must not survive the gate.

    The replay receipt's own bytes are not digested anywhere else, so
    this tamper leaves every digest check green — rebinding the receipt's
    digests changes nothing. Only the complete expected-receipt
    comparison can catch it: the gate must refuse and leave all three
    artifacts byte-identical.
    """

    import hashlib

    out = tmp_path / "evidence"
    assert _run_build(out, "--replay").returncode == 0
    replay_path = out / REPLAY
    replay = json.loads(replay_path.read_text(encoding="utf-8"))
    view_digest = hashlib.sha256((out / VIEW).read_bytes()).hexdigest()
    receipt_digest = hashlib.sha256((out / RECEIPT).read_bytes()).hexdigest()
    replay["html_sha256"] = view_digest
    replay["rebuilt_html_sha256"] = view_digest
    replay["receipt_sha256"] = receipt_digest
    replay["generator"] = "tampered/tamper.py --replay"
    replay_path.write_text(_canonical(replay), encoding="utf-8")
    before = _snapshot(out)

    result = _run_build(out, "--replay")
    assert result.returncode == 1
    assert "replay disagreement" in result.stderr
    assert "generator" in result.stderr
    assert _snapshot(out) == before  # all three artifacts byte-identical


def test_gated_replay_refuses_a_tampered_fixture_root_binding(tmp_path):
    """The receipt's fixture-root binding is part of its identity."""

    out = tmp_path / "evidence"
    assert _run_build(out, "--replay").returncode == 0
    replay_path = out / REPLAY
    replay = json.loads(replay_path.read_text(encoding="utf-8"))
    replay["fixtures_root"] = "somewhere/else"
    replay_path.write_text(_canonical(replay), encoding="utf-8")
    before = _snapshot(out)

    result = _run_build(out, "--replay")
    assert result.returncode == 1
    assert "replay disagreement" in result.stderr
    assert "fixtures_root" in result.stderr
    assert _snapshot(out) == before
