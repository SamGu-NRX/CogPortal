"""Changed-history mutation regression (M3, part 2).

The frozen observability record must be derived from the histories the study
actually ran, not assumed. Mutation proof: edit one frozen scenario's history
(add a commit to the single-commit bulk-upload case) and show that
(a) the real builders' output changes, and
(b) the recomputed observability no longer matches the frozen record -- i.e.
    the freeze would flag the drift instead of silently reporting the
    frozen value.
"""

import copy
import json
from pathlib import Path

import pytest

from harness import (
    HERE,
    apply_patches,
    load_manifest,
    observability_record,
    run_python_arm,
)

FROZEN = HERE / "frozen" / "observability.json"
SINGLE_COMMIT_ID = "week1-single-commit"


@pytest.fixture(scope="module")
def manifest():
    return load_manifest()


@pytest.fixture(scope="module")
def frozen_doc():
    with open(FROZEN, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _scenario(manifest, scenario_id):
    return next(s for s in manifest["scenarios"] if s["id"] == scenario_id)


def test_baseline_still_matches_the_freeze(manifest, frozen_doc):
    """Sanity: the unmutated scenario agrees with the frozen record, so any
    mismatch in the mutation test comes from the mutation itself."""
    scenario = _scenario(manifest, SINGLE_COMMIT_ID)
    roster = manifest["rosters"][scenario["roster"]]
    canonical = run_python_arm(scenario, roster)

    recomputed = observability_record(scenario, canonical)
    assert frozen_doc["scenarios"][SINGLE_COMMIT_ID] == recomputed


def test_added_commit_changes_the_real_builder_output(manifest):
    scenario = _scenario(manifest, SINGLE_COMMIT_ID)
    roster = manifest["rosters"][scenario["roster"]]

    baseline = run_python_arm(scenario, roster)

    second = copy.deepcopy(scenario["commits"][0])
    second["sha"] = second["sha"] + "0000"
    second["authoredAt"] = "2026-09-21T18:00:00Z"
    mutant = apply_patches(scenario, [{"op": "set", "path": "commits", "value": scenario["commits"] + [second]}])
    mutated = run_python_arm(mutant, roster)

    assert baseline["historyQuality"] == "bulk_upload"
    assert mutated["historyQuality"] == "usable", "a second commit must flip the classification"
    assert mutated["windowCommits"] == baseline["windowCommits"] + 1


def test_frozen_observability_flags_the_mutation(manifest, frozen_doc):
    """The freeze must disagree with the mutated run -- the study detects a
    changed history rather than reporting the frozen value."""
    scenario = _scenario(manifest, SINGLE_COMMIT_ID)
    roster = manifest["rosters"][scenario["roster"]]

    second = copy.deepcopy(scenario["commits"][0])
    second["sha"] = second["sha"] + "0000"
    second["authoredAt"] = "2026-09-21T18:00:00Z"
    mutant = apply_patches(scenario, [{"op": "set", "path": "commits", "value": scenario["commits"] + [second]}])
    mutated = run_python_arm(mutant, roster)

    recomputed = observability_record(mutant, mutated)
    frozen = frozen_doc["scenarios"][SINGLE_COMMIT_ID]

    assert recomputed != frozen
    assert recomputed["historyQuality"] != frozen["historyQuality"]
