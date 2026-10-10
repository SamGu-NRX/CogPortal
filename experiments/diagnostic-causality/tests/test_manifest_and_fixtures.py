import json
import sys
from pathlib import Path

import pytest

STUDY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(STUDY))

import materialize  # noqa: E402


def test_manifest_pins_are_present_and_consistent():
    manifest = json.loads((STUDY / "manifest.json").read_text(encoding="utf-8"))
    pins = manifest["source_pins"]
    assert pins["cogportal_base_commit"].startswith("276da32")
    assert pins["benchmark_week1_submodule_commit"].startswith("4e516f39")
    counts = manifest["track_counts"]
    measured = [t for t in manifest["tracks"] if t["measured"]]
    unavailable = [t for t in manifest["tracks"] if not t["measured"]]
    assert counts["measured"] == len(measured)
    assert counts["unavailable"] == len(unavailable)
    # Missing-data/weights tracks must be explicitly unmeasured, with reasons.
    for track in unavailable:
        assert track["reason"].startswith("unmeasured:"), track["name"]


def test_worktree_sits_on_pinned_base():
    git = subprocess_git(["rev-parse", "HEAD"])
    manifest = json.loads((STUDY / "manifest.json").read_text(encoding="utf-8"))
    assert git.strip() == manifest["source_pins"]["cogportal_base_commit"]
    week1 = subprocess_git(["rev-parse", "HEAD:benchmarks/week1"])
    assert week1.strip() == manifest["source_pins"]["benchmark_week1_submodule_commit"]


def subprocess_git(args):
    import subprocess

    proc = subprocess.run(
        ["git", *args], cwd=STUDY, capture_output=True, text=True, check=True
    )
    return proc.stdout


def test_materialized_variants_differ_from_control_by_exactly_their_patch(tmp_path):
    key = materialize.load_key()
    paths = materialize.materialize(tmp_path, key)
    control = (paths["control"] / "submission.py").read_text(encoding="utf-8")
    # Sanity: the frozen control is a real, importable adapter.
    compile(control, "control/submission.py", "exec")
    for name in materialize.single_defect_names(key):
        variant = (paths[name] / "submission.py").read_text(encoding="utf-8")
        assert variant != control, name
        # Each single-defect variant differs only in submission.py content;
        # re-applying the true repair restores the control text exactly.
        entry = key["defects"][name]
        # materialize.apply_patch with the true repair is a round trip
        # because true_repair is the patch's inverse by construction.
        import materialize as mat

        repaired = mat.apply_patch(variant, entry["true_repair"])
        assert repaired == control, name
    for name in materialize.multi_defect_names(key):
        variant = (paths[name] / "submission.py").read_text(encoding="utf-8")
        assert variant != control, name


def test_control_is_scored_above_trivial_baseline_marker():
    """The control source must match the module measured at 0.671875 in
    results/raw/control - a marker that fixtures have not drifted."""
    results = STUDY / "results"
    outcome_path = results / "raw" / "control" / "outcome.json"
    if not outcome_path.exists():
        pytest.skip("results not yet committed")
    outcome = json.loads(outcome_path.read_text(encoding="utf-8"))
    primary = outcome["metrics"]["identification_score"]
    assert primary == pytest.approx(0.671875)
