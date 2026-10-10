"""History-type counts: the frozen manifest must contain the histories the
study declares, and the frozen counts file must describe exactly it."""

import json
from pathlib import Path

import pytest

from harness import HERE, load_manifest

FROZEN = HERE / "frozen" / "counts.json"
PYTHON_VISIBLE_TYPES = {"usable", "bulk_upload", "empty"}
TS_ONLY_TYPES = {"fetch_failed"}


@pytest.fixture(scope="module")
def manifest():
    return load_manifest()


@pytest.fixture(scope="module")
def counts_doc():
    with open(FROZEN, "r", encoding="utf-8") as handle:
        return json.load(handle)


def test_every_scenario_declares_a_known_history_type(manifest):
    known = PYTHON_VISIBLE_TYPES | TS_ONLY_TYPES
    for scenario in manifest["scenarios"]:
        assert scenario["historyType"] in known, scenario["id"]


def test_declared_history_type_matches_the_builder_itself(manifest):
    """The `historyType` label is not trusted: the python arm must classify
    each scenario the same way (except the fetch-failed state it cannot
    represent)."""
    import harness as H

    for scenario in manifest["scenarios"]:
        if "fetchFailure" in scenario:
            continue
        roster = manifest["rosters"][scenario["roster"]]
        canonical = H.run_python_arm(scenario, roster)
        assert canonical["historyQuality"] == scenario["historyType"], scenario["id"]


def test_frozen_counts_describe_the_manifest(manifest, counts_doc):
    observed = {}
    for scenario in manifest["scenarios"]:
        observed[scenario["historyType"]] = observed.get(scenario["historyType"], 0) + 1
    assert counts_doc["counts"] == observed
    assert counts_doc["totalScenarios"] == len(manifest["scenarios"])
    assert counts_doc["ablationCount"] == len(manifest["ablations"])


def test_each_python_visible_type_is_represented(counts_doc):
    """A study with no bulk_upload or empty histories cannot measure the
    degraded paths at all; the freeze must include every python-visible type."""
    assert set(counts_doc["pythonVisibleCounts"]) == PYTHON_VISIBLE_TYPES
    assert all(v > 0 for v in counts_doc["pythonVisibleCounts"].values())


def test_ts_only_type_is_reported_as_ts_only(counts_doc):
    assert set(counts_doc["tsOnlyCounts"]) == TS_ONLY_TYPES
