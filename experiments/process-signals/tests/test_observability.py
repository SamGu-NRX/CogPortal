"""Expected observability: re-run the python arm over every frozen scenario
and require the re-derivation to match the freeze exactly, null-vs-zero
semantics included. A drift here means either the builder changed (source
hashes will say so too) or someone edited a frozen expectation without
re-deriving it."""

import json

import pytest

from harness import HERE, load_manifest, run_python_arm, observability_record

FROZEN = HERE / "frozen" / "observability.json"


@pytest.fixture(scope="module")
def manifest():
    return load_manifest()


@pytest.fixture(scope="module")
def frozen():
    with open(FROZEN, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _recompute(manifest, scenario_id):
    scenario = next(s for s in manifest["scenarios"] if s["id"] == scenario_id)
    roster = manifest["rosters"][scenario["roster"]]
    return observability_record(scenario, run_python_arm(scenario, roster))


def test_every_scenario_is_frozen(manifest, frozen):
    ids = {s["id"] for s in manifest["scenarios"]}
    assert set(frozen["scenarios"]) == ids


@pytest.mark.parametrize(
    "scenario_id",
    [s["id"] for s in load_manifest()["scenarios"] if "fetchFailure" not in s],
)
def test_observability_matches_the_freeze(manifest, frozen, scenario_id):
    assert _recompute(manifest, scenario_id) == frozen["scenarios"][scenario_id]


def test_unavailable_means_null_not_zero(manifest, frozen):
    """The modules' core honesty rule, checked on real degraded scenarios:
    where a stage is unavailable its counts must be null, and where a signal
    was never computed the whole map must be empty (not a map of empty
    values)."""
    single = _recompute(manifest, "week1-single-commit")
    for stage in single["stageFootprint"].values():
        assert stage["available"] is False
        assert stage["commitCount"] is None
        assert stage["distinctAuthorCount"] is None
        assert stage["timestampsPresent"] is False
        assert stage["unavailableReason"]
    empty = _recompute(manifest, "week1-empty")
    assert empty["ownershipBreadth"] == {}


def test_computed_zero_is_reported_as_zero(manifest, frozen):
    """The mirror-image rule: a real, computed zero is a finding and must read
    as 0, not as an unavailable marker."""
    spread = _recompute(manifest, "week1-spread-usable")
    fanout = spread["stageFootprint"]["fanout"]
    assert fanout["available"] is True
    assert fanout["commitCount"] == 0
    assert fanout["unavailableReason"] is None


def test_boundary_churn_is_strictly_after_first_light(manifest, frozen):
    timing = _recompute(manifest, "week3-boundary-timing")
    assert timing["firstLight"]["firstScoredAtPresent"] is True
    assert timing["boundaryChurnEventCount"] == 1


def test_first_light_null_when_no_run_ever_scored(manifest, frozen):
    unscored = _recompute(manifest, "week1-unscored-only")
    assert unscored["firstLight"]["firstScoredAtPresent"] is False
    assert unscored["firstLight"]["scoredRunCount"] == 0
    assert unscored["boundaryChurnEventCount"] == 0


def test_null_week_degrades_to_empty_maps(manifest, frozen):
    for scenario_id in ("week2-no-runs", "week1-unscored-only"):
        record = _recompute(manifest, scenario_id)
        assert record["stageFootprint"] == {}
        assert record["ownershipBreadth"] == {}
