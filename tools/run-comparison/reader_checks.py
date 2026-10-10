"""Record exactly what the reader did to the synthetic fixture reports.

One JSON file: each fixture's SHA-256, the reader's verdict with reasons,
and the exact accepted/refused counts. The test suite asserts the counts
against the same fixtures, so the committed record and the committed
tests cannot drift apart. Deterministic by construction: files are read
in sorted order and nothing but their content enters the record.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

from report_reader import read_report


def collect(fixtures: Path) -> Dict[str, Any]:
    files = sorted(path for path in fixtures.glob("*.json") if path.is_file())
    entries: List[Dict[str, Any]] = []
    refusal_codes: Dict[str, int] = {}
    accepted = 0
    refused = 0
    for path in files:
        report = read_report(path)
        if report.accepted:
            accepted += 1
        else:
            refused += 1
        for refusal in report.refusals:
            refusal_codes[refusal.code] = refusal_codes.get(refusal.code, 0) + 1
        entries.append(
            {
                "file": path.name,
                "sha256": report.file_sha256,
                "status": report.status,
                "refusals": [
                    "{}: {}".format(code, detail) for code, detail in
                    ((refusal.code, refusal.detail) for refusal in report.refusals)
                ],
                "reportId": report.report_id,
            }
        )
    return {
        "fixtures_root": fixtures.as_posix(),
        "total": len(files),
        "accepted": accepted,
        "refused": refused,
        "refusal_codes": dict(sorted(refusal_codes.items())),
        "files": entries,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", required=True, help="directory of saved-report JSON files")
    parser.add_argument("--out", required=True, help="where to write the record")
    arguments = parser.parse_args()
    record = collect(Path(arguments.fixtures))
    out = Path(arguments.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(
        "{}: {} accepted, {} refused of {} -> {}".format(
            arguments.fixtures,
            record["accepted"],
            record["refused"],
            record["total"],
            arguments.out,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
