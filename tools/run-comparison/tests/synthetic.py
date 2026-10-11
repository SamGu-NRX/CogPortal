"""Factory for synthetic saved-run reports.

Every report this module produces is synthetic: no field is copied from
a real student run. The default payload is a fully recorded report in
the writer's current shape; tests and the fixture generator mutate it to
produce the unknown-provenance and refusal cases, so one factory defines
what "valid" means and every case is a deviation from it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

#: The report builder's own fixture file, read by the tests to prove this
#: reader accepts the format the builder actually produces.
REFERENCE_REPORT = (
    Path(__file__).resolve().parents[3]
    / "python"
    / "cogbench"
    / "tests"
    / "fixtures"
    / "audio_no_weight_report.json"
)

_DIGEST = "b" * 64


def metric(
    *,
    key: str,
    label: str,
    value: float,
    unit: Optional[str] = None,
    higher_is_better: bool = True,
    primary: bool = False,
    precision: int = 3,
    help: Optional[str] = None,
    role: Optional[str] = None,
    relates_to: Optional[str] = None,
) -> Dict[str, Any]:
    """One metric entry in the writer's wire shape; omitted when not recorded."""

    entry: Dict[str, Any] = {
        "key": key,
        "label": label,
        "value": value,
        "unit": unit,
        "higherIsBetter": higher_is_better,
        "primary": primary,
        "precision": precision,
    }
    if help is not None:
        entry["help"] = help
    if role is not None:
        entry["role"] = role
    if relates_to is not None:
        entry["relatesTo"] = relates_to
    return entry


def default_metrics() -> List[Dict[str, Any]]:
    return [
        metric(
            key="identification_score",
            label="Identification score",
            value=0.5375,
            primary=True,
            precision=4,
            help="How often the right song came back first. "
            "Synthetic help text written for the fixture factory.",
        ),
        metric(
            key="chance_top1",
            label="Chance",
            value=0.0333,
            role="floor",
            relates_to="identification_score",
            help="1/N for a catalog of N songs. Synthetic help text.",
        ),
        metric(
            key="ranking_failure_rate",
            label="Wrong song ranked first",
            value=0.2125,
            higher_is_better=False,
        ),
    ]


def report() -> Dict[str, Any]:
    """A fully recorded synthetic report in the writer's current shape."""

    return {
        "reportId": "local_" + "a" * 32,
        "benchmarkId": "audio-identification",
        "benchmarkVersion": 1,
        "contractVersion": "cogworks.submissions.v2",
        "sdkVersion": "0.2.0",
        "pluginVersion": "0.1.0",
        "repositoryId": 4,
        "repositoryFullName": "SamGu-NRX/cogportal-demo-week1",
        "sha": "1" * 40,
        "dirty": False,
        "startedAt": 1789380575807,
        "finishedAt": 1789380587761,
        "metrics": default_metrics(),
        "diagnostics": [
            "Synthetic diagnostic: identification falls gradually from "
            "clean clips toward shifted ones, without a single break "
            "(fixture text).",
            "Synthetic diagnostic: the weakest cell is the pitch shift "
            "(fixture text).",
        ],
        "weightsUsed": [],
        "weightsUploaded": [],
        "command": "run",
        "outputDigest": _DIGEST,
    }


def dump(path: Path, payload: Dict[str, Any]) -> None:
    """Write a fixture exactly as the writer serializes a saved report."""

    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
