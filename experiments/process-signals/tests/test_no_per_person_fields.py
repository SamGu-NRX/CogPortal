"""No per-person totals: the study inherits the builders' hard rule. Every
serialized canonical result must expose identity only as name lists inside
ownership maps, never as per-person counts, shares, or grades."""

import re

import pytest

from harness import HERE, load_manifest, run_python_arm

FORBIDDEN_KEY_PATTERN = re.compile(
    r"(per[_-]?person|per[_-]?author|per[_-]?member|grade|rating|rank|leaderboard|contribution)",
    re.IGNORECASE,
)

# Structural keys the canonical result shape may contain. Stage names
# (`peaks`, `fanout`, ...) are dynamic keys under stageFootprint and
# ownershipBreadth; they are validated separately, against the builders'
# own stage maps.
ALLOWED_KEYS = {
    "historyQuality",
    "stageFootprint",
    "firstLight",
    "boundaryChurn",
    "ownershipBreadth",
    "windowCommits",
    "commitCount",
    "distinctAuthorCount",
    "firstTouchAtMs",
    "lastTouchAtMs",
    "available",
    "unavailableReason",
    "firstScoredAtMs",
    "scoredRunCount",
    "sha",
    "authorLogin",
    "authoredAtMs",
    "files",
}


def _all_stage_names():
    import cogbench.process as py_process

    names = set()
    for stage_map in py_process.DEFAULT_STAGE_MAPS.values():
        names.update(stage_map)
    return names


STAGE_NAMES = _all_stage_names()


def _walk_keys(node, collected):
    if isinstance(node, dict):
        for key, value in node.items():
            collected.append(key)
            _walk_keys(value, collected)
    elif isinstance(node, list):
        for item in node:
            _walk_keys(item, collected)


@pytest.fixture(scope="module")
def canonical_results():
    manifest = load_manifest()
    results = {}
    for scenario in manifest["scenarios"]:
        if "fetchFailure" in scenario:
            continue
        roster = manifest["rosters"][scenario["roster"]]
        results[scenario["id"]] = run_python_arm(scenario, roster)
    return results


def test_no_key_outside_the_allowlist(canonical_results):
    for scenario_id, result in canonical_results.items():
        keys = []
        _walk_keys(result, keys)
        extra = {k for k in keys if k not in ALLOWED_KEYS and k not in STAGE_NAMES}
        assert not extra, (scenario_id, extra)


def test_stage_keys_are_real_stage_names(canonical_results):
    for scenario_id, result in canonical_results.items():
        for section in ("stageFootprint", "ownershipBreadth"):
            assert set(result[section]) <= STAGE_NAMES, (scenario_id, section)


def test_no_forbidden_vocabulary_anywhere(canonical_results):
    for scenario_id, result in canonical_results.items():
        keys = []
        _walk_keys(result, keys)
        forbidden = [k for k in keys if FORBIDDEN_KEY_PATTERN.search(k)]
        assert not forbidden, (scenario_id, forbidden)


def test_ownership_is_names_only(canonical_results):
    for scenario_id, result in canonical_results.items():
        for stage, authors in result["ownershipBreadth"].items():
            assert isinstance(authors, list), (scenario_id, stage)
            assert all(isinstance(name, str) for name in authors), (scenario_id, stage)
            assert authors == sorted(authors), (scenario_id, stage)


def test_distinct_author_counts_are_stage_wide(canonical_results):
    """`distinctAuthorCount` must never exceed the length of any stage's
    ownership list's union of authors — it is a set size, not a per-person
    tally hiding behind another name."""
    for scenario_id, result in canonical_results.items():
        for stage, activity in result["stageFootprint"].items():
            count = activity["distinctAuthorCount"]
            if count is not None:
                assert count == len(set(result["ownershipBreadth"].get(stage, []))), (scenario_id, stage)
