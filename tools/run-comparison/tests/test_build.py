"""build.py and verify.py against the synthetic fixture matrix."""

import json
import subprocess
import sys
from pathlib import Path

from build import analyze_pair
from report_reader import read_report

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
WORKBENCH = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKBENCH.parents[1]

PAIR_STEM = "01-run-a-vs-02-run-b"


def _load(name):
    return read_report(FIXTURES / name)


def test_same_conditions_and_different_clean_commit_is_comparable():
    analysis = analyze_pair(_load("01-run-a.json"), _load("02-run-b.json"))
    assert analysis["comparable"] is True
    assert analysis["conditions"]["source"]["verdict"] == "changed"
    assert analysis["conditions"]["dataset"]["verdict"] == "same"
    assert analysis["conditions"]["scorer"]["verdict"] == "same"
    rows = {row["key"]: row for row in analysis["shared"]}
    assert rows["identification_score"]["delta"] == "+0.0750"
    assert rows["identification_score"]["direction"] == "higher is better"
    assert rows["ranking_failure_rate"]["delta"] == "-0.062"
    assert rows["ranking_failure_rate"]["direction"] == "lower is better"


def test_unknown_conditions_block_every_difference():
    analysis = analyze_pair(_load("01-run-a.json"), _load("04-run-legacy-unrecorded.json"))
    assert analysis["comparable"] is False
    fields = {
        field["field"]: field
        for field in analysis["conditions"]["dataset"]["fields"]
    }
    assert fields["case set (command)"]["verdict"] == "unknown"
    assert fields["weights"]["verdict"] == "unknown"
    assert all(row["delta"] is None for row in analysis["shared"])


def test_a_dirty_source_blocks_attribution_even_with_matching_conditions():
    analysis = analyze_pair(_load("01-run-a.json"), _load("03-run-dirty.json"))
    assert analysis["comparable"] is False
    assert analysis["conditions"]["source"]["verdict"] == "unknown"
    assert all(row["delta"] is None for row in analysis["shared"])


def test_floor_metrics_land_in_context_without_deltas():
    analysis = analyze_pair(_load("01-run-a.json"), _load("02-run-b.json"))
    assert [item["key"] for item in analysis["context"]] == ["chance_top1"]
    assert all("delta" not in item for item in analysis["context"])


def test_refused_reports_never_reach_the_pair():
    # The reader refuses 07-11; analyze_pair only ever sees accepted reports,
    # so feeding it the refused file is impossible by construction — assert
    # the refusal exists so this stays true.
    assert _load("07-refused-future-contract.json").accepted is False


def test_end_to_end_build_replay_and_verify(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "build.py"),
            "--fixtures",
            str(FIXTURES),
            "--out",
            str(tmp_path),
            "--replay",
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0, result.stdout + result.stderr

    html_path = tmp_path / "view-{}.html".format(PAIR_STEM)
    receipt_path = tmp_path / "view-receipts-{}.json".format(PAIR_STEM)
    replay_path = tmp_path / "replay-{}.json".format(PAIR_STEM)
    assert html_path.exists()
    assert receipt_path.exists()
    assert replay_path.exists()

    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["pair_comparable"] is True
    assert receipt["compared"] == ["01-run-a.json", "02-run-b.json"]
    assert [entry["file"] for entry in receipt["excluded"]] == [
        "07-refused-future-contract.json",
        "08-refused-unknown-command.json",
        "09-refused-bad-receipt-digest.json",
        "10-refused-receipt-unscored-path.json",
        "11-refused-malformed.json",
    ]
    assert [entry["file"] for entry in receipt["not_compared"]] == [
        "03-run-dirty.json",
        "04-run-legacy-unrecorded.json",
        "05-run-precapture-weights.json",
        "06-run-unrecorded-command.json",
    ]

    replay = json.loads(replay_path.read_text(encoding="utf-8"))
    assert replay["identical"] is True

    html_text = html_path.read_text(encoding="utf-8")
    assert "<script" not in html_text.lower()
    assert "http://" not in html_text and "https://" not in html_text
    assert "+0.0750" in html_text  # the one honest difference the pair supports
    assert "Not comparable" not in html_text

    verify = subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "verify.py"),
            "--fixtures",
            str(FIXTURES),
            "--out",
            str(tmp_path),
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert verify.returncode == 0, verify.stdout + verify.stderr


def test_build_refuses_to_compare_fewer_than_two(tmp_path):
    single = tmp_path / "fixtures"
    single.mkdir()
    (single / "01-run-a.json").write_bytes((FIXTURES / "01-run-a.json").read_bytes())
    result = subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "build.py"),
            "--fixtures",
            str(single),
            "--out",
            str(tmp_path / "out"),
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == 2
    assert "two accepted reports" in result.stderr


def test_verify_rejects_a_tampered_value(tmp_path):
    out = tmp_path / "out"
    build_result = subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "build.py"),
            "--fixtures",
            str(FIXTURES),
            "--out",
            str(out),
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert build_result.returncode == 0, build_result.stdout + build_result.stderr

    receipt_path = out / "view-receipts-{}.json".format(PAIR_STEM)
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    receipt["metrics"]["shared"][0]["run_b"] = "9.9999"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")

    verify = subprocess.run(
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
    assert verify.returncode == 1
    assert "misrendered" in verify.stderr
