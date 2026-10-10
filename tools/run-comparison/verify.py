"""Independently cross-check a built comparison view against its fixtures.

    python tools/run-comparison/verify.py --fixtures <dir-or-file>... \
        --out <directory build.py wrote into>

Deliberately shares no code with build.py or report_reader.py: fixtures
are loaded with plain json.load, refusal and comparability claims are
re-derived here from the raw JSON, and the built HTML is checked for
hash, shown values and offline-ness. Exits nonzero on the first
mismatch, so the committed evidence cannot drift from the fixtures it
claims to describe.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

_CONTRACT = "cogworks.submissions.v2"
_COMMANDS = ("run", "test")


def _fail(message: str) -> None:
    print("verify: FAIL: " + message, file=sys.stderr)
    raise SystemExit(1)


def _hex64(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _refusal_reason(data: Any) -> Optional[str]:
    """An independent, minimal refusal check; returns why, or None."""

    if not isinstance(data, dict):
        return "not a JSON object"
    if data.get("contractVersion") != _CONTRACT:
        return "incompatible contract"
    command = data.get("command")
    if command is not None and command not in _COMMANDS:
        return "unknown command"
    used = data.get("weightsUsed")
    uploaded = data.get("weightsUploaded")
    if isinstance(used, list) and isinstance(uploaded, list):
        used_names = [name for name in used if isinstance(name, str)]
        named: List[Any] = []
        for entry in uploaded:
            if not isinstance(entry, dict):
                return "malformed receipt entry"
            path = entry.get("path")
            named.append(path)
            if path not in used_names:
                return "receipt names a weight the report did not score"
            if not _hex64(entry.get("sha256")):
                return "receipt digest is not a SHA-256"
            size = entry.get("size")
            if not (isinstance(size, int) and not isinstance(size, bool) and size >= 0):
                return "receipt byte length missing or negative"
        for name in used_names:
            if name not in named:
                return "scored weight without any receipt entry"
    return None


def _collect_files(paths: List[str]) -> List[Path]:
    files: List[Path] = []
    for item in paths:
        path = Path(item)
        if path.is_dir():
            files.extend(sorted(path.glob("*.json")))
        else:
            files.append(path)
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixtures", required=True, action="append", help="same inputs build.py got"
    )
    parser.add_argument(
        "--out", required=True, help="the --out directory build.py wrote into"
    )
    arguments = parser.parse_args()

    out = Path(arguments.out)
    html_paths = sorted(out.glob("view-*.html"))
    receipt_paths = sorted(out.glob("view-receipts-*.json"))
    if len(html_paths) != 1 or len(receipt_paths) != 1:
        _fail(
            "expected exactly one view and one receipt in {}; found {} and {}".format(
                out, len(html_paths), len(receipt_paths)
            )
        )
    html_path, receipt_path = html_paths[0], receipt_paths[0]

    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    html_text = html_path.read_text(encoding="utf-8")
    html_bytes = html_path.read_bytes()

    # 1. the recorded hash is the built file's own
    if receipt.get("html_sha256") != hashlib.sha256(html_bytes).hexdigest():
        _fail("html_sha256 does not match the built file")

    # 2. offline: no scripts, no external references
    if "<script" in html_text.lower():
        _fail("the view contains a script tag")
    for token in ("http://", "https://"):
        if token in html_text:
            _fail("the view references an external URL over " + token)

    # 3. every fixture file is compared, excluded or explicitly not compared
    files = _collect_files(arguments.fixtures)
    paths_by_name = {path.name: path for path in files}
    names = sorted(paths_by_name)
    compared = receipt.get("compared", [])
    excluded_entries = receipt.get("excluded", [])
    excluded = [entry["file"] for entry in excluded_entries]
    not_compared = [entry["file"] for entry in receipt.get("not_compared", [])]
    if sorted(names) != sorted(compared + excluded + not_compared):
        _fail("compared + excluded + not_compared does not cover the fixture files exactly")

    # 4. exclusions match this module's own minimal refusal check
    for name in names:
        try:
            data = json.loads(paths_by_name[name].read_text(encoding="utf-8"))
        except ValueError:
            reason = "not parseable as JSON"
        else:
            reason = _refusal_reason(data)
        if name in excluded and reason is None:
            _fail("{} is excluded but passes the independent refusal check".format(name))
        if name not in excluded and reason is not None:
            _fail("{} is compared but independently refuses: {}".format(name, reason))

    # 5. the compared pair is the first two accepted in sorted order
    accepted_names = [name for name in names if name not in excluded]
    if compared != accepted_names[:2]:
        _fail(
            "compared pair {} is not the first two accepted {}".format(
                compared, accepted_names[:2]
            )
        )

    raw: Dict[str, Dict[str, Any]] = {
        name: json.loads(paths_by_name[name].read_text(encoding="utf-8"))
        for name in compared
    }
    a_raw, b_raw = raw[compared[0]], raw[compared[1]]
    a_metrics = {metric["key"]: metric for metric in a_raw["metrics"]}
    b_metrics = {metric["key"]: metric for metric in b_raw["metrics"]}

    # 6. metric values, directions and delta arithmetic, re-derived from raw JSON
    rows = receipt["metrics"]["shared"]
    for row in rows:
        key = row["key"]
        ma, mb = a_metrics.get(key), b_metrics.get(key)
        if ma is None or mb is None:
            _fail("shared row {} is missing from a fixture's metrics".format(key))
        if row["run_a"] != "{:.{p}f}".format(ma["value"], p=ma["precision"]):
            _fail("run A value for {} is misrendered".format(key))
        if row["run_b"] != "{:.{p}f}".format(mb["value"], p=mb["precision"]):
            _fail("run B value for {} is misrendered".format(key))
        expected_direction = (
            "lower is better" if not ma["higherIsBetter"] else "higher is better"
        )
        if row["direction"] != expected_direction:
            _fail("direction claim for {} does not match the raw metric".format(key))
        if row["delta"] is not None:
            expected_delta = "{:+.{}f}".format(
                mb["value"] - ma["value"], ma["precision"]
            )
            if row["delta"] != expected_delta:
                _fail(
                    "delta arithmetic for {} is wrong: {} should be {}".format(
                        key, row["delta"], expected_delta
                    )
                )
        elif receipt.get("pair_comparable"):
            identity_a = (
                ma.get("unit"),
                ma.get("higherIsBetter"),
                ma.get("role"),
                ma.get("precision"),
                ma.get("relatesTo"),
            )
            identity_b = (
                mb.get("unit"),
                mb.get("higherIsBetter"),
                mb.get("role"),
                mb.get("precision"),
                mb.get("relatesTo"),
            )
            if identity_a == identity_b:
                _fail(
                    "{} has no delta despite comparable conditions and matching identity".format(
                        key
                    )
                )

    # 7. comparability implications from the raw JSON
    if receipt.get("pair_comparable"):
        if bool(a_raw.get("dirty")) or bool(b_raw.get("dirty")):
            _fail("claimed comparable but a side reports a dirty tree")
        if (
            a_raw.get("benchmarkId") != b_raw.get("benchmarkId")
            or a_raw.get("benchmarkVersion") != b_raw.get("benchmarkVersion")
        ):
            _fail("claimed comparable but the benchmark identity differs")
        ca, cb = a_raw.get("command"), b_raw.get("command")
        if ca is not None and cb is not None and ca != cb:
            _fail("claimed comparable but the commands differ")
        wa, wb = a_raw.get("weightsUsed"), b_raw.get("weightsUsed")
        if isinstance(wa, list) and isinstance(wb, list) and wa != wb:
            _fail("claimed comparable but weightsUsed differs")
        for field in ("contractVersion", "sdkVersion", "pluginVersion"):
            if a_raw.get(field) != b_raw.get(field):
                _fail("claimed comparable but {} differs".format(field))

    # 8. the HTML actually shows the claims
    for name in compared:
        report_id = raw[name].get("reportId")
        if report_id and report_id not in html_text:
            _fail("the view does not show reportId {}".format(report_id))
    for row in rows:
        for cell in (row["run_a"], row["run_b"]):
            if cell not in html_text:
                _fail("the view does not show value {} for {}".format(cell, row["key"]))
    for entry in excluded_entries:
        if entry["file"] not in html_text:
            _fail("the view does not name excluded file {}".format(entry["file"]))

    print(
        "verify: OK — {} shared metrics over {} and {}, {} excluded files, html hash matches".format(
            len(rows), compared[0], compared[1], len(excluded)
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
