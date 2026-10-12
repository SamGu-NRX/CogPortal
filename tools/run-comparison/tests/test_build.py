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


def test_matching_labels_and_a_clean_commit_stay_unknown_and_blocked():
    analysis = analyze_pair(_load("01-run-a.json"), _load("02-run-b.json"))
    assert analysis["comparable"] is False
    assert analysis["conditions"]["source"]["verdict"] == "changed"
    assert analysis["conditions"]["dataset"]["verdict"] == "unknown"
    benchmark = {
        field["field"]: field
        for field in analysis["conditions"]["dataset"]["fields"]
    }["benchmark"]
    assert benchmark["verdict"] == "unknown"
    assert "byte-level" in benchmark["detail"]
    assert analysis["conditions"]["scorer"]["verdict"] == "same"
    assert all(row["delta"] is None for row in analysis["shared"])


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
    assert receipt["pair_comparable"] is False
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
    # No byte-level dataset binding is recorded, so the deltas are not
    # compared and the banner states the pair is not comparable.
    assert "+0.0750" not in html_text
    assert "Not comparable" in html_text
    assert "unknown provenance blocks a conclusion" in html_text

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
    # --replay so the evidence triple is complete: verify requires the
    # replay record, and this test must fail on the tampered value alone.
    build_result = subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "build.py"),
            "--fixtures",
            str(FIXTURES),
            "--out",
            str(out),
            "--replay",
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


def test_label_only_dataset_same_claim_is_caught_after_a_full_rebind(tmp_path):
    # The dataset verdict is a semantic check, not a digest check. A
    # receipt edited to claim the dataset "same" from matching labels -
    # with every digest rebound until the evidence triple is
    # hash-self-consistent - must still fail verification naming the
    # dataset disagreement. A digest-mismatch failure would prove
    # nothing.
    import hashlib

    out = tmp_path / "evidence"
    build_result = subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "build.py"),
            "--fixtures",
            str(FIXTURES),
            "--out",
            str(out),
            "--replay",
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert build_result.returncode == 0, build_result.stdout + build_result.stderr

    receipt_path = out / "view-receipts-{}.json".format(PAIR_STEM)
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["conditions"]["dataset"]["verdict"] == "unknown"
    receipt["conditions"]["dataset"]["verdict"] = "same"
    for field in receipt["conditions"]["dataset"]["fields"]:
        if field["field"] == "benchmark":
            field["verdict"] = "same"
            field["detail"] = "both runs used the same benchmark (label match)"
    receipt_bytes = (
        json.dumps(receipt, indent=2, sort_keys=True) + chr(10)
    ).encode("utf-8")
    receipt_path.write_bytes(receipt_bytes)

    # Rebind the one digest that covers the receipt's own bytes. Every
    # other binding is untouched and still valid: the view bytes,
    # fixture bytes and generator sources did not change.
    replay_path = out / "replay-{}.json".format(PAIR_STEM)
    replay = json.loads(replay_path.read_text(encoding="utf-8"))
    replay["receipt_sha256"] = hashlib.sha256(receipt_bytes).hexdigest()
    replay_path.write_text(
        json.dumps(replay, indent=2, sort_keys=True) + chr(10), encoding="utf-8"
    )

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
    assert "dataset" in verify.stderr


def test_floor_identity_metadata_is_caught_after_a_full_rebind(tmp_path):
    # Floor identity is semantic, not just bytes. Tamper one report's
    # floor unit AND reference, rebuild (which rebinds every digest
    # around the tampered report) and require the floor verdict to read
    # changed with both differences rendered honestly. Then forge the
    # receipt a value-only builder would have written - floors "same",
    # pair comparable - rebind every digest until the evidence triple is
    # hash-self-consistent, and require verify.py to fail naming the
    # scoring-floors disagreement. A digest-mismatch failure would
    # prove nothing.
    import hashlib
    import shutil

    work = tmp_path / "fixtures"
    shutil.copytree(FIXTURES, work)
    report_path = work / "02-run-b.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    floors = [m for m in report["metrics"] if m.get("role") == "floor"]
    assert len(floors) == 1
    floors[0]["unit"] = "ratio"
    floors[0]["relatesTo"] = "ranking_failure_rate"
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + chr(10), encoding="utf-8"
    )

    out = tmp_path / "evidence"
    build_result = subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "build.py"),
            "--fixtures",
            str(work),
            "--out",
            str(out),
            "--replay",
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert build_result.returncode == 0, build_result.stdout + build_result.stderr

    receipt_path = out / "view-receipts-{}.json".format(PAIR_STEM)
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    floors_field = {
        field["field"]: field
        for field in receipt["conditions"]["dataset"]["fields"]
    }["scoring floors"]
    assert floors_field["verdict"] == "changed"
    assert "identity (unit, direction, reference)" in floors_field["detail"]
    assert receipt["pair_comparable"] is False

    html_text = (out / "view-{}.html".format(PAIR_STEM)).read_text(encoding="utf-8")
    assert "floor identity differs between the runs" in html_text
    assert "unit differs: run A" in html_text
    assert "run A floor of identification_score" in html_text
    assert "run B floor of ranking_failure_rate" in html_text

    verify_ok = subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "verify.py"),
            "--fixtures",
            str(work),
            "--out",
            str(out),
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert verify_ok.returncode == 0, verify_ok.stderr

    # Forge the value-only claim and rebind every digest that covers it.
    floors_field["verdict"] = "same"
    receipt["conditions"]["dataset"]["verdict"] = "same"
    receipt["pair_comparable"] = True
    receipt_bytes = (
        json.dumps(receipt, indent=2, sort_keys=True) + chr(10)
    ).encode("utf-8")
    receipt_path.write_bytes(receipt_bytes)
    replay_path = out / "replay-{}.json".format(PAIR_STEM)
    replay = json.loads(replay_path.read_text(encoding="utf-8"))
    replay["receipt_sha256"] = hashlib.sha256(receipt_bytes).hexdigest()
    replay_path.write_text(
        json.dumps(replay, indent=2, sort_keys=True) + chr(10), encoding="utf-8"
    )

    verify = subprocess.run(
        [
            sys.executable,
            str(WORKBENCH / "verify.py"),
            "--fixtures",
            str(work),
            "--out",
            str(out),
        ],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert verify.returncode == 1
    assert "misrendered" in verify.stderr
    assert "scoring floors" in verify.stderr
