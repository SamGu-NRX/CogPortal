"""Shared engine for the process-signals study.

Loads the frozen manifest, applies ablation patches, and runs the Python arm
(`python/cogbench/src/cogbench/process.py`) over each scenario, normalizing
both arms' output into one canonical JSON shape so a confusion table can
compare them. The TypeScript arm lives in `run.py` + `run-worker.ts`; this
module never imports it.

Nothing here talks to the network or invents history: every input comes from
the frozen `manifest.json` bytes.
"""

from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
COGBENCH_SRC = REPO_ROOT / "python" / "cogbench" / "src"
if str(COGBENCH_SRC) not in sys.path:
    sys.path.insert(0, str(COGBENCH_SRC))

import cogbench.process as py_process  # noqa: E402

HERE = Path(__file__).resolve().parent
MANIFEST_PATH = HERE / "manifest.json"

PYTHON_SOURCE = REPO_ROOT / "python" / "cogbench" / "src" / "cogbench" / "process.py"
TS_SOURCE = REPO_ROOT / "apps" / "portal" / "worker" / "services" / "process-signals.ts"

# The TS module's BOUNDARY_FILES, mirrored here so the Python arm is compared
# against the same boundary list the TS arm reads. If the TS constant changes,
# source-hashes drift and the study must be re-frozen.
BOUNDARY_FILES = ["submission.py", "benchmark_adapter.py"]


def load_manifest() -> dict:
    with open(MANIFEST_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Neutral-fixture decoding
# ---------------------------------------------------------------------------


def iso_to_epoch_ms(value: str) -> int:
    """ISO-8601 UTC string -> epoch ms, the exact conversion the TS arm does
    with `Date.parse` for GitHub-style UTC timestamps."""
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    moment = dt.datetime.fromisoformat(text)
    return int(moment.timestamp() * 1000)


def epoch_ms_to_iso(epoch_ms: int) -> str:
    moment = dt.datetime.fromtimestamp(epoch_ms / 1000, tz=dt.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def decode_scenario(scenario: dict, roster: dict) -> dict:
    """Neutral scenario -> (python_commits, python_runs, roster_members)."""
    commits = [
        py_process.Commit(
            sha=c["sha"],
            author_login=c["authorLogin"],
            authored_at=c["authoredAt"],
            files_changed=list(c["filesChanged"]),
            insertions=c["insertions"],
            deletions=c["deletions"],
        )
        for c in scenario["commits"]
    ]
    runs = [
        py_process.Run(
            run_id=r["runId"],
            created_at=r["createdAt"],
            status=r["status"],
            scored=r["scored"],
        )
        for r in scenario["runs"]
    ]
    return {"commits": commits, "runs": runs, "roster": roster}


# ---------------------------------------------------------------------------
# Ablation patches
# ---------------------------------------------------------------------------


def apply_patches(scenario: dict, patches: list) -> dict:
    """Deep-copy the scenario and apply this manifest's patch ops.

    Ops: `set` with a bracket/number path like `commits[2].filesChanged`, and
    `set-all-commits` with named keys. Kept deliberately tiny: patches are
    declared in the frozen manifest and reviewed as data, not code.
    """
    mutant = copy.deepcopy(scenario)

    def resolve(container, segments):
        for index, segment in enumerate(segments):
            match = re.fullmatch(r"([^[]+)\[(\d+)\]", segment)
            if match:
                key, idx = match.group(1), int(match.group(2))
                if index == len(segments) - 1:
                    return container, key, idx
                container = container[key][idx]
            else:
                if index == len(segments) - 1:
                    return container, segment, None
                container = container[segment]
        raise ValueError("empty patch path")

    for patch in patches:
        if patch["op"] == "set":
            segments = patch["path"].split(".")
            container, key, index = resolve(mutant, segments)
            if index is None:
                container[key] = copy.deepcopy(patch["value"])
            else:
                container[key][index] = copy.deepcopy(patch["value"])
        elif patch["op"] == "set-all-commits":
            for commit in mutant["commits"]:
                for key, value in patch.items():
                    if key in ("op",):
                        continue
                    commit[key] = copy.deepcopy(value)
        else:
            raise ValueError(f"unknown patch op: {patch['op']}")
    return mutant


# ---------------------------------------------------------------------------
# Python arm
# ---------------------------------------------------------------------------


def run_python_arm(scenario: dict, roster: dict) -> dict:
    """Run process.py's real functions over a neutral scenario.

    Orchestration mirrors the TS `buildProcessSignals` contract and is
    disclosed here: stage map = `DEFAULT_STAGE_MAPS[week]` when the week is
    knowable, `{}` otherwise (the TS null-week degradation); boundary files =
    the TS module's `BOUNDARY_FILES` so both arms read the same list.
    """
    decoded = decode_scenario(scenario, roster)
    commits, runs = decoded["commits"], decoded["runs"]

    week = scenario.get("week")
    stage_map = py_process.DEFAULT_STAGE_MAPS[week] if week else {}

    signals = py_process.ProcessSignals(
        history_quality=py_process.classify_history_quality(commits),
        stage_footprint=py_process.stage_footprint(commits, stage_map),
        first_light=py_process.first_light(runs),
        boundary_churn=py_process.boundary_churn(commits, BOUNDARY_FILES, py_process.first_light(runs).first_scored_at),
        ownership_breadth=py_process.ownership_breadth(commits, stage_map),
    )
    return normalize_python(signals, commits)


def normalize_python(signals: py_process.ProcessSignals, commits) -> dict:
    """process.py output -> canonical shape (timestamps as epoch ms, the
    intersection the TS arm can also produce)."""
    footprint = {}
    for stage, activity in signals.stage_footprint.items():
        footprint[stage] = {
            "commitCount": activity.commit_count,
            "distinctAuthorCount": activity.distinct_author_count,
            "firstTouchAtMs": iso_to_epoch_ms(activity.first_touch_at) if activity.first_touch_at else None,
            "lastTouchAtMs": iso_to_epoch_ms(activity.last_touch_at) if activity.last_touch_at else None,
            "available": activity.available,
            "unavailableReason": activity.unavailable_reason,
        }
    churn = [
        {
            "sha": event.sha,
            "authorLogin": event.author_login,
            "authoredAtMs": iso_to_epoch_ms(event.authored_at),
            "files": event.files,
        }
        for event in signals.boundary_churn
    ]
    return {
        "historyQuality": signals.history_quality,
        "stageFootprint": footprint,
        "firstLight": {
            "firstScoredAtMs": iso_to_epoch_ms(signals.first_light.first_scored_at) if signals.first_light.first_scored_at else None,
            "scoredRunCount": signals.first_light.scored_run_count,
        },
        "boundaryChurn": churn,
        "ownershipBreadth": {stage: list(authors) for stage, authors in signals.ownership_breadth.items()},
        "windowCommits": len(commits),
    }


# ---------------------------------------------------------------------------
# Observability records (the freeze target for frozen/observability.json)
# ---------------------------------------------------------------------------


def observability_record(scenario: dict, canonical: dict) -> dict:
    """Reduce a canonical result to what was observable, with the module's
    null-vs-zero semantics intact: unavailable means null, computed zero means
    zero, and an empty map means nothing was computed."""
    stages = {}
    for stage, activity in canonical["stageFootprint"].items():
        stages[stage] = {
            "available": activity["available"],
            "commitCount": activity["commitCount"],
            "distinctAuthorCount": activity["distinctAuthorCount"],
            "timestampsPresent": activity["firstTouchAtMs"] is not None,
            "unavailableReason": activity["unavailableReason"],
        }
    return {
        "historyQuality": canonical["historyQuality"],
        "stageFootprint": stages,
        "firstLight": {
            "firstScoredAtPresent": canonical["firstLight"]["firstScoredAtMs"] is not None,
            "firstScoredAtMs": canonical["firstLight"]["firstScoredAtMs"],
            "scoredRunCount": canonical["firstLight"]["scoredRunCount"],
        },
        "boundaryChurnEventCount": len(canonical["boundaryChurn"]),
        "ownershipBreadth": canonical["ownershipBreadth"],
    }


def canonical_hash(payload) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
