"""Measure every accepted-report pair in a fixture corpus.

For every unordered pair of accepted reports across the given fixture
roots this runs exactly what the builder's view runs --
``report_reader.read_report``, then ``build.analyze_pair`` -- and
records the outcome: the three condition verdicts, the comparability
decision, the blockers, the findings and the metric rows (with deltas
where, and only where, the doctrine compares them). Refused files are
counted and named, never analysed as a pair side.

Nothing here invents a number: every verdict and delta comes from
``analyze_pair`` on the fixture bytes, and the record binds the fixture
digests and the generator sources (this file, build.py,
report_reader.py) so a stale record is detectable, never silent.
Deterministic by construction: files are read in sorted order and
nothing but their content enters the record. Pairing covers every
accepted report, so a pair the conditions do not line up for is
recorded with its blockers -- that record is the measurement.

Usage:
  python3 all_pairs_checks.py --fixtures PATH [--fixtures PATH ...] --out DIR

Writes ``<out>/all-pairs-checks.json``. Standard library only, fully
offline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

from build import analyze_pair
from report_reader import read_report


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def tool_source_digests() -> Dict[str, str]:
    here = Path(__file__).resolve().parent
    names = ("all_pairs_checks.py", "build.py", "report_reader.py")
    return {name: _sha((here / name).read_bytes()) for name in sorted(names)}


def collect(fixtures_roots: List[Path]) -> Dict[str, Any]:
    files: List[Path] = []
    for root in fixtures_roots:
        files.extend(path for path in root.glob("*.json") if path.is_file())
    files.sort(key=lambda path: path.name)
    loaded: List[Any] = []
    accepted_files: List[str] = []
    refused: List[Dict[str, Any]] = []
    inputs: Dict[str, str] = {}
    for path in files:
        # One read: the recorded digest and the analysed report are the
        # same bytes.
        report = read_report(path)
        inputs[path.name] = report.file_sha256
        if report.accepted:
            loaded.append((path.name, report))
            accepted_files.append(path.name)
        else:
            refused.append(
                {
                    "file": path.name,
                    "reasons": [
                        "{}: {}".format(refusal.code, refusal.detail)
                        for refusal in report.refusals
                    ],
                }
            )
    pairs: List[Dict[str, Any]] = []
    comparable_count = 0
    for a_index in range(len(loaded)):
        for b_index in range(a_index + 1, len(loaded)):
            a_name, a_report = loaded[a_index]
            b_name, b_report = loaded[b_index]
            analysis = analyze_pair(a_report, b_report)
            if analysis["comparable"]:
                comparable_count += 1
            pairs.append(
                {
                    "files": [a_name, b_name],
                    "comparable": analysis["comparable"],
                    "conditions": analysis["conditions"],
                    "blockers": analysis["blockers"],
                    "findings": analysis["findings"],
                    "metrics": {
                        "shared": analysis["shared"],
                        "context": analysis["context"],
                        "only_in_a": analysis["only_in_a"],
                        "only_in_b": analysis["only_in_b"],
                    },
                }
            )
    return {
        "fixtures_roots": sorted(root.name for root in fixtures_roots),
        "total_files": len(files),
        "accepted": len(accepted_files),
        "refused": len(refused),
        "accepted_files": accepted_files,
        "refused_files": refused,
        "total_pairs": len(pairs),
        "comparable_pairs": comparable_count,
        "pairs": pairs,
        "inputs": inputs,
        "tool_source": {"files": tool_source_digests()},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixtures",
        required=True,
        action="append",
        help="directory of saved-report JSON files (repeatable)",
    )
    parser.add_argument("--out", required=True, help="where to write the record")
    arguments = parser.parse_args()
    record = collect([Path(item) for item in arguments.fixtures])
    out = Path(arguments.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(
        "{} accepted files -> {} pairs ({} comparable) -> {}".format(
            record["accepted"],
            record["total_pairs"],
            record["comparable_pairs"],
            arguments.out,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
