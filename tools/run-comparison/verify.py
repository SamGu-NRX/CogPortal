"""Independent verifier for the offline run-comparison workbench.

Re-derives every published decision -- refusals, comparability, source,
dataset, scorer, weight-byte and floor verdicts, shared metric rows and
floor rows -- straight from the raw fixture JSON with its own parser, then
binds the rendered HTML to parsed positions and cross-checks the builder's
receipt row by row and digest by digest. It imports neither build.py nor
report_reader.py: two implementations must agree, or the disagreement is
the finding.

Usage:
    python3 verify.py --fixtures PATH [--fixtures PATH ...] --out DIR

Exits 0 when the view, receipt and fixtures agree. Any disagreement is
printed to stderr as a ``misrendered`` line and exits 1. Standard library
only, fully offline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SUPPORTED_CONTRACTS = ("cogworks.submissions.v2",)
REPORT_COMMANDS = ("test", "run")

_REQUIRED_FIELDS = (
    "reportId",
    "benchmarkId",
    "benchmarkVersion",
    "contractVersion",
    "sdkVersion",
    "pluginVersion",
    "dirty",
    "startedAt",
    "finishedAt",
    "metrics",
    "outputDigest",
)
_REQUIRED_METRIC_FIELDS = ("key", "label", "value", "higherIsBetter", "primary", "precision")

_HEX = set("0123456789abcdef")

_CAUSAL_PHRASES = (
    "can be attributed to",
    "attributed to the change",
    "is attributable to",
    "caused by",
    "due to the change",
)

_TOOL_SOURCE_FILES = ("build.py", "report_reader.py")


def _fail(failures: List[str], message: str) -> None:
    failures.append("misrendered: " + message)


def _sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _fmt(value: float, precision: int) -> str:
    return "{:.{}f}".format(value, precision)


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def _int_field(value: Any) -> bool:
    return type(value) is int


def _bool_field(value: Any) -> bool:
    return type(value) is bool


def _parse_fixture(path: Path) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        "file": path.name,
        "accepted": False,
        "reasons": [],
        "value": None,
        "source": None,
        "dataset": None,
        "scorer": None,
        "metrics": [],
        "diagnostics": [],
    }
    try:
        data = path.read_bytes()
    except OSError as error:
        record["reasons"].append("unreadable: {}".format(error))
        return record
    try:
        value = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        record["reasons"].append("not_json: {}".format(error))
        return record
    if not isinstance(value, dict):
        record["reasons"].append("not_an_object: the file is JSON but not an object")
        return record

    missing = [name for name in _REQUIRED_FIELDS if name not in value]
    if missing:
        record["reasons"].append("missing_field: missing " + ", ".join(missing))
        return record

    type_problems = []
    for name, kind, check in (
        ("reportId", "a non-empty string", _nonempty_str),
        ("benchmarkId", "a non-empty string", _nonempty_str),
        ("benchmarkVersion", "an integer", _int_field),
        ("contractVersion", "a non-empty string", _nonempty_str),
        ("sdkVersion", "a non-empty string", _nonempty_str),
        ("pluginVersion", "a non-empty string", _nonempty_str),
        ("dirty", "a boolean", _bool_field),
        ("startedAt", "an integer", _int_field),
        ("finishedAt", "an integer", _int_field),
        ("outputDigest", "a non-empty string", _nonempty_str),
        ("metrics", "a list", lambda v: isinstance(v, list)),
    ):
        if not check(value[name]):
            type_problems.append(
                "bad_field_type: {} must be {}, not {!r}".format(name, kind, value[name])
            )
    if type_problems:
        record["reasons"].extend(type_problems)
        return record

    if value["contractVersion"] not in SUPPORTED_CONTRACTS:
        record["reasons"].append(
            "unsupported_contract: {!r}".format(value["contractVersion"])
        )
        return record

    command: Optional[str] = None
    if "command" in value:
        if value["command"] not in REPORT_COMMANDS:
            record["reasons"].append(
                "unknown_command: command must be one of {}, not {!r}".format(
                    ", ".join(REPORT_COMMANDS), value["command"]
                )
            )
        else:
            command = str(value["command"])

    weights_used: Optional[List[str]] = None
    if "weightsUsed" in value:
        used = value["weightsUsed"]
        if not isinstance(used, list) or any(not isinstance(item, str) for item in used):
            record["reasons"].append(
                "malformed_weights_used: weightsUsed must be a list of weight paths"
            )
        elif len(set(used)) != len(used):
            record["reasons"].append(
                "duplicate_weights_used: weightsUsed names a path more than once"
            )
        else:
            weights_used = list(used)

    uploaded = value.get("weightsUploaded")
    receipts: List[Dict[str, Any]] = []
    if uploaded is not None:
        if not isinstance(uploaded, list):
            record["reasons"].append(
                "malformed_weights_uploaded: weightsUploaded must be a list or null"
            )
        else:
            seen_paths = set()
            for entry in uploaded:
                if not isinstance(entry, dict):
                    record["reasons"].append(
                        "malformed_weights_uploaded: each weightsUploaded entry must be an object"
                    )
                    continue
                path_name = entry.get("path")
                checksum = entry.get("sha256")
                size = entry.get("size")
                if not isinstance(path_name, str) or (
                    weights_used is None or path_name not in weights_used
                ):
                    record["reasons"].append(
                        "unscored_weight_receipt: weightsUploaded names {!r}, "
                        "which this report did not score".format(path_name)
                    )
                    continue
                seen_paths.add(path_name)
                if (
                    not isinstance(checksum, str)
                    or len(checksum) != 64
                    or any(character not in _HEX for character in checksum)
                ):
                    record["reasons"].append(
                        "bad_weight_receipt: weightsUploaded needs a SHA-256 "
                        "digest for {!r}".format(path_name)
                    )
                    continue
                if type(size) is not int or size < 0:
                    record["reasons"].append(
                        "bad_weight_receipt: weightsUploaded needs a byte "
                        "length for {!r}".format(path_name)
                    )
                    continue
                receipts.append({"path": path_name, "sha256": checksum, "size": size})
            if len({receipt["path"] for receipt in receipts}) != len(receipts):
                record["reasons"].append(
                    "duplicate_weight_receipt: weightsUploaded names a path more than once"
                )
            if weights_used is not None:
                captured = {receipt["path"] for receipt in receipts}
                missing_receipts = [
                    name for name in weights_used if name not in captured
                ]
                if missing_receipts:
                    record["reasons"].append(
                        "missing_weight_receipt: weightsUploaded is missing {}, "
                        "which this report scored".format(
                            ", ".join(sorted(missing_receipts))
                        )
                    )

    metrics: List[Dict[str, Any]] = []
    raw_metrics = value["metrics"]
    if not isinstance(raw_metrics, list):
        record["reasons"].append(
            "bad_field_type: metrics must be a list, not {!r}".format(raw_metrics)
        )
        raw_metrics = []
    seen_keys = set()
    for index, entry in enumerate(raw_metrics):
        if not isinstance(entry, dict):
            record["reasons"].append(
                "malformed_metrics: metrics[{}] must be an object".format(index)
            )
            continue
        entry_missing = [name for name in _REQUIRED_METRIC_FIELDS if name not in entry]
        if entry_missing:
            record["reasons"].append(
                "malformed_metrics: metrics[{}] missing {}".format(
                    index, ", ".join(entry_missing)
                )
            )
            continue
        metric_value = entry["value"]
        if type(metric_value) not in (int, float):
            record["reasons"].append(
                "bad_metric_value: metrics[{}].value must be a number, not {!r}".format(
                    index, metric_value
                )
            )
            continue
        shape_problem = None
        for name, kind, check in (
            ("higherIsBetter", "a boolean", _bool_field),
            ("primary", "a boolean", _bool_field),
            ("precision", "an integer", _int_field),
            ("key", "a non-empty string", _nonempty_str),
            ("label", "a string", lambda v: isinstance(v, str)),
        ):
            if not check(entry[name]):
                shape_problem = (
                    "bad_field_type: metrics[{}].{} must be {}, not {!r}".format(
                        index, name, kind, entry[name]
                    )
                )
                break
        if shape_problem is not None:
            record["reasons"].append(shape_problem)
            continue
        key = entry["key"]
        if key in seen_keys:
            record["reasons"].append(
                "duplicate_metric_key: metrics names {!r} more than once".format(key)
            )
            continue
        seen_keys.add(key)
        for name in ("unit", "help", "role", "relatesTo"):
            optional = entry.get(name)
            if optional is not None and not isinstance(optional, str):
                record["reasons"].append(
                    "bad_field_type: metrics[{}].{} must be a string or "
                    "omitted, not {!r}".format(index, name, optional)
                )
        metrics.append(
            {
                "key": key,
                "label": entry["label"],
                "value": float(metric_value),
                "unit": entry.get("unit"),
                "higher_is_better": entry["higherIsBetter"],
                "primary": entry["primary"],
                "precision": entry["precision"],
                "role": entry.get("role"),
                "relates_to": entry.get("relatesTo"),
            }
        )

    diagnostics = value.get("diagnostics", [])
    if not isinstance(diagnostics, list) or any(
        not isinstance(item, str) for item in diagnostics
    ):
        record["reasons"].append(
            "bad_field_type: diagnostics must be a list of strings"
        )
        diagnostics = []

    if record["reasons"]:
        return record

    record.update(
        {
            "accepted": True,
            "value": value,
            "source": {
                "repository": value.get("repositoryFullName"),
                "sha": value.get("sha"),
                "dirty": value["dirty"],
            },
            "dataset": {
                "benchmark_id": value["benchmarkId"],
                "benchmark_version": value["benchmarkVersion"],
                "command": command,
                "weights_used": tuple(weights_used) if weights_used is not None else None,
                "weights_uploaded": (
                    None if uploaded is None else tuple(receipts)
                ),
            },
            "scorer": {
                "contract": value["contractVersion"],
                "sdk": value["sdkVersion"],
                "plugin": value["pluginVersion"],
            },
            "metrics": metrics,
            "diagnostics": list(diagnostics),
        }
    )
    return record


def _source_verdict(a: Dict[str, Any], b: Dict[str, Any]) -> Tuple[str, str]:
    sa, sb = a["source"], b["source"]

    def pins(side: Dict[str, Any]) -> bool:
        return bool(side["sha"]) and not side["dirty"]

    if not (pins(sa) and pins(sb)):
        sides = " and ".join(
            name for name, side in (("run A", sa), ("run B", sb)) if not pins(side)
        )
        return (
            "unknown",
            "the source bytes cannot be pinned on {}".format(sides),
        )
    if sa["repository"] is None or sb["repository"] is None:
        sides = " and ".join(
            name
            for name, side in (("run A", sa), ("run B", sb))
            if side["repository"] is None
        )
        return ("unknown", "the repository is not recorded on " + sides)
    if sa["repository"] != sb["repository"]:
        return ("changed", "different repositories, both pinned")
    if sa["sha"] != sb["sha"]:
        return ("changed", "different commits")
    return ("same", "same repository and commit")


def _dataset_fields(
    a: Dict[str, Any], b: Dict[str, Any]
) -> List[Dict[str, str]]:
    da, db = a["dataset"], b["dataset"]
    fields: List[Dict[str, str]] = []

    if (
        da["benchmark_id"] != db["benchmark_id"]
        or da["benchmark_version"] != db["benchmark_version"]
    ):
        fields.append({"field": "benchmark", "verdict": "changed"})
    else:
        fields.append({"field": "benchmark", "verdict": "same"})

    ca, cb = da["command"], db["command"]
    if ca is None or cb is None:
        fields.append({"field": "case set (command)", "verdict": "unknown"})
    elif ca != cb:
        fields.append({"field": "case set (command)", "verdict": "changed"})
    else:
        fields.append({"field": "case set (command)", "verdict": "same"})

    wa, wb = da["weights_used"], db["weights_used"]
    if wa is None or wb is None:
        fields.append({"field": "weights", "verdict": "unknown"})
    elif sorted(wa) != sorted(wb):
        fields.append({"field": "weights", "verdict": "changed"})
    elif not wa:
        fields.append({"field": "weights", "verdict": "same"})
    else:
        capture_a, capture_b = da["weights_uploaded"], db["weights_uploaded"]
        if capture_a is None or capture_b is None:
            fields.append({"field": "weights", "verdict": "unknown"})
        else:
            index_a = {receipt["path"]: receipt for receipt in capture_a}
            index_b = {receipt["path"]: receipt for receipt in capture_b}
            differs = False
            unreceipted = False
            for used_path in sorted(wa):
                receipt_a = index_a.get(used_path)
                receipt_b = index_b.get(used_path)
                if receipt_a is None or receipt_b is None:
                    unreceipted = True
                elif (
                    receipt_a["sha256"] != receipt_b["sha256"]
                    or receipt_a["size"] != receipt_b["size"]
                ):
                    differs = True
            if differs:
                fields.append({"field": "weights", "verdict": "changed"})
            elif unreceipted:
                fields.append({"field": "weights", "verdict": "unknown"})
            else:
                fields.append({"field": "weights", "verdict": "same"})

    floors_a = {m["key"]: m for m in a["metrics"] if m["role"] == "floor"}
    floors_b = {m["key"]: m for m in b["metrics"] if m["role"] == "floor"}
    floor_keys = sorted(set(floors_a) | set(floors_b))
    if not floor_keys:
        fields.append({"field": "scoring floors", "verdict": "same"})
    else:
        floors_verdict = "same"
        for key in floor_keys:
            metric_a = floors_a.get(key)
            metric_b = floors_b.get(key)
            if metric_a is None or metric_b is None:
                if floors_verdict == "same":
                    floors_verdict = "unknown"
            elif (metric_a["value"], metric_a["precision"]) != (
                metric_b["value"],
                metric_b["precision"],
            ):
                floors_verdict = "changed"
        fields.append({"field": "scoring floors", "verdict": floors_verdict})
    return fields


def _scorer_verdict(a: Dict[str, Any], b: Dict[str, Any]) -> Tuple[str, str]:
    sa, sb = a["scorer"], b["scorer"]
    for name in ("contract", "sdk", "plugin"):
        if sa[name] != sb[name]:
            return ("changed", name + " version differs between the runs")
    return ("same", "contract, sdk and plugin versions all match")


def _identity(metric: Dict[str, Any]) -> Tuple[Any, ...]:
    return (
        metric["unit"],
        metric["higher_is_better"],
        metric["role"],
        metric["precision"],
        metric["relates_to"],
    )


def _derive_analysis(
    a: Dict[str, Any], b: Dict[str, Any]
) -> Dict[str, Any]:
    source = _source_verdict(a, b)
    scorer = _scorer_verdict(a, b)
    dataset_fields = _dataset_fields(a, b)
    if any(field["verdict"] == "changed" for field in dataset_fields):
        dataset = "changed"
    elif any(field["verdict"] == "unknown" for field in dataset_fields):
        dataset = "unknown"
    else:
        dataset = "same"
    comparable = (
        source[0] in ("same", "changed") and dataset == "same" and scorer[0] == "same"
    )

    a_by_key = {metric["key"]: metric for metric in a["metrics"]}
    b_by_key = {metric["key"]: metric for metric in b["metrics"]}
    shared: List[Dict[str, Any]] = []
    floors: List[Dict[str, Any]] = []
    for key in sorted(set(a_by_key) & set(b_by_key)):
        metric_a, metric_b = a_by_key[key], b_by_key[key]
        if metric_a["role"] == "floor" and metric_b["role"] == "floor":
            floors.append(
                {
                    "key": key,
                    "label": metric_a["label"] or key,
                    "value_a": _fmt(metric_a["value"], metric_a["precision"]),
                    "value_b": _fmt(metric_b["value"], metric_b["precision"]),
                    "differs": (metric_a["value"], metric_a["precision"])
                    != (metric_b["value"], metric_b["precision"]),
                    "relates_to": metric_a["relates_to"],
                }
            )
            continue
        direction = (
            "lower is better" if not metric_a["higher_is_better"] else "higher is better"
        )
        row: Dict[str, Any] = {
            "key": key,
            "label": metric_a["label"] or key,
            "run_a": _fmt(metric_a["value"], metric_a["precision"]),
            "run_b": _fmt(metric_b["value"], metric_b["precision"]),
            "direction": direction,
        }
        if not comparable:
            row["delta"] = None
            row["note"] = "not compared — the runs' conditions do not line up"
        elif _identity(metric_a) != _identity(metric_b):
            row["delta"] = None
            row["note"] = (
                "not compared — the metric's identity (unit, direction, role, "
                "precision or floor reference) differs between the runs"
            )
        else:
            row["delta"] = "{:+.{}f}".format(
                metric_b["value"] - metric_a["value"], metric_a["precision"]
            )
            row["note"] = direction
        shared.append(row)
    return {
        "comparable": comparable,
        "source": source[0],
        "scorer": scorer[0],
        "dataset": dataset,
        "dataset_fields": dataset_fields,
        "shared": shared,
        "floors": floors,
        "only_in_a": sorted(set(a_by_key) - set(b_by_key)),
        "only_in_b": sorted(set(b_by_key) - set(a_by_key)),
    }


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: List[Dict[str, Any]] = []
        self.items: List[Dict[str, Any]] = []
        self._table: Optional[Dict[str, Any]] = None
        self._row: Optional[Dict[str, Any]] = None
        self._cell: Optional[Dict[str, Any]] = None
        self._li: Optional[Dict[str, Any]] = None
        self.text_chunks: List[str] = []

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        attributes = dict(attrs)
        if tag == "table":
            self._table = {"header": [], "rows": []}
            self.tables.append(self._table)
        elif tag == "tr" and self._table is not None:
            self._row = {"attrs": attributes, "cells": []}
        elif tag in ("td", "th") and self._row is not None:
            self._cell = {"kind": tag, "parts": []}
        elif tag == "li":
            self._li = {"attrs": attributes, "parts": []}

    def handle_endtag(self, tag: str) -> None:
        if tag == "table":
            self._table = None
        elif tag == "tr" and self._row is not None:
            if self._table is not None:
                if self._row["cells"] and all(
                    cell["kind"] == "th" for cell in self._row["cells"]
                ):
                    self._table["header"] = [
                        " ".join("".join(cell["parts"]).split())
                        for cell in self._row["cells"]
                    ]
                else:
                    self._table["rows"].append(
                        {
                            "attrs": self._row["attrs"],
                            "cells": [
                                " ".join("".join(cell["parts"]).split())
                                for cell in self._row["cells"]
                            ],
                        }
                    )
            self._row = None
        elif tag in ("td", "th") and self._cell is not None:
            if self._row is not None:
                self._row["cells"].append(self._cell)
            self._cell = None
        elif tag == "li" and self._li is not None:
            self.items.append(
                {
                    "attrs": self._li["attrs"],
                    "text": " ".join("".join(self._li["parts"]).split()),
                }
            )
            self._li = None

    def handle_data(self, data: str) -> None:
        self.text_chunks.append(data)
        if self._cell is not None:
            self._cell["parts"].append(data)
        if self._li is not None:
            self._li["parts"].append(data)


def _table_by_header(
    tables: List[Dict[str, Any]], first: str, last: str
) -> Optional[Dict[str, Any]]:
    for table in tables:
        if table["header"] and table["header"][0] == first and table["header"][-1] == last:
            return table
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixtures",
        required=True,
        action="append",
        help="a fixture file or a directory of them (repeatable)",
    )
    parser.add_argument("--out", required=True, help="the build.py output directory")
    arguments = parser.parse_args()

    failures: List[str] = []
    files: List[Path] = []
    for item in arguments.fixtures:
        path = Path(item)
        if path.is_dir():
            files.extend(sorted(path.glob("*.json")))
        else:
            files.append(path)
    if not files:
        print("no fixture files found", file=sys.stderr)
        return 2

    parsed = [_parse_fixture(path) for path in files]
    accepted = [record for record in parsed if record["accepted"]]
    refused = [record for record in parsed if not record["accepted"]]
    if len(accepted) < 2:
        print("need at least two accepted reports to verify; found {}".format(len(accepted)), file=sys.stderr)
        return 2
    expected_compared = [record["file"] for record in accepted[:2]]
    expected_not_compared = [record["file"] for record in accepted[2:]]
    expected_excluded = [record["file"] for record in refused]

    out = Path(arguments.out)
    stem = "{}-vs-{}".format(Path(expected_compared[0]).stem, Path(expected_compared[1]).stem)
    html_path = out / "view-{}.html".format(stem)
    receipt_path = out / "view-receipts-{}.json".format(stem)
    if not html_path.exists():
        print("missing built view: {}".format(html_path), file=sys.stderr)
        return 2
    if not receipt_path.exists():
        print("missing built receipt: {}".format(receipt_path), file=sys.stderr)
        return 2
    html_bytes = html_path.read_bytes()
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except ValueError as error:
        print("misrendered: the receipt does not parse as JSON ({})".format(error), file=sys.stderr)
        return 1

    actual_inputs = {
        path.name: _sha_bytes(path.read_bytes()) for path in files
    }
    receipt_inputs = receipt.get("inputs")
    if not isinstance(receipt_inputs, list):
        _fail(failures, "the receipt records no inputs list")
    else:
        by_name: Dict[str, str] = {}
        for entry in receipt_inputs:
            if not isinstance(entry, dict) or "file" not in entry or "sha256" not in entry:
                _fail(failures, "a receipt inputs entry lacks file or sha256: {!r}".format(entry))
            else:
                by_name[entry["file"]] = entry["sha256"]
        if by_name != actual_inputs:
            _fail(
                failures,
                "receipt inputs do not match the fixture bytes: receipt {!r} vs actual {!r}".format(
                    by_name, actual_inputs
                ),
            )

    tool_path = Path(__file__).resolve().parent
    expected_tool_source = {
        name: _sha_bytes((tool_path / name).read_bytes())
        for name in _TOOL_SOURCE_FILES
        if (tool_path / name).exists()
    }
    recorded_tool_source = (receipt.get("tool_source") or {}).get("files")
    if recorded_tool_source != expected_tool_source:
        _fail(
            failures,
            "receipt tool_source digests do not match the current generator sources: "
            "receipt {!r} vs actual {!r}".format(recorded_tool_source, expected_tool_source),
        )

    recorded_html_sha = receipt.get("html_sha256")
    if recorded_html_sha != _sha_bytes(html_bytes):
        _fail(failures, "receipt html_sha256 does not match the built view bytes")

    compared = receipt.get("compared")
    if compared != expected_compared:
        _fail(
            failures,
            "receipt compared {!r} != independently derived {!r}".format(
                compared, expected_compared
            ),
        )
    not_compared = [entry["file"] for entry in (receipt.get("not_compared") or [])]
    if not_compared != expected_not_compared:
        _fail(
            failures,
            "receipt not_compared {!r} != independently derived {!r}".format(
                not_compared, expected_not_compared
            ),
        )
    excluded = [entry["file"] for entry in (receipt.get("excluded") or [])]
    if excluded != expected_excluded:
        _fail(
            failures,
            "receipt excluded {!r} != independently derived refusals {!r}".format(
                excluded, expected_excluded
            ),
        )

    a_record, b_record = accepted[0], accepted[1]
    derived = _derive_analysis(a_record, b_record)

    if receipt.get("pair_comparable") is not derived["comparable"]:
        _fail(
            failures,
            "receipt pair_comparable {!r} != derived {!r}".format(
                receipt.get("pair_comparable"), derived["comparable"]
            ),
        )

    conditions = receipt.get("conditions") or {}
    for axis, expected in (
        ("source", derived["source"]),
        ("dataset", derived["dataset"]),
        ("scorer", derived["scorer"]),
    ):
        verdict = (conditions.get(axis) or {}).get("verdict")
        if verdict != expected:
            _fail(
                failures,
                "receipt conditions.{} verdict {!r} != derived {!r}".format(
                    axis, verdict, expected
                ),
            )
    dataset_field_verdicts = {
        field["field"]: field["verdict"]
        for field in (conditions.get("dataset") or {}).get("fields", [])
    }
    expected_field_verdicts = {
        field["field"]: field["verdict"] for field in derived["dataset_fields"]
    }
    if dataset_field_verdicts != expected_field_verdicts:
        _fail(
            failures,
            "receipt dataset field verdicts {!r} != derived {!r}".format(
                dataset_field_verdicts, expected_field_verdicts
            ),
        )

    findings = receipt.get("findings")
    if not isinstance(findings, list) or not findings or any(
        not isinstance(line, str) or not line for line in findings
    ):
        _fail(failures, "receipt findings must be a non-empty list of non-empty strings")

    receipt_shared = (receipt.get("metrics") or {}).get("shared") or []
    if len(receipt_shared) != len(derived["shared"]):
        _fail(
            failures,
            "receipt shared rows ({}) != derived rows ({})".format(
                len(receipt_shared), len(derived["shared"])
            ),
        )
    for derived_row, receipt_row in zip(derived["shared"], receipt_shared):
        for field in ("key", "label", "run_a", "run_b", "direction"):
            if receipt_row.get(field) != derived_row[field]:
                _fail(
                    failures,
                    "receipt shared[{}].{} = {!r} != derived {!r}".format(
                        derived_row["key"], field, receipt_row.get(field), derived_row[field]
                    ),
                )
        if receipt_row.get("delta") != derived_row["delta"]:
            _fail(
                failures,
                "receipt shared[{}].delta = {!r} != derived {!r}".format(
                    derived_row["key"], receipt_row.get("delta"), derived_row["delta"]
                ),
            )

    receipt_floors = (receipt.get("metrics") or {}).get("floors")
    if not isinstance(receipt_floors, list):
        _fail(failures, "receipt metrics.floors is missing (the floors are not recorded)")
        receipt_floors = []
    if len(receipt_floors) != len(derived["floors"]):
        _fail(
            failures,
            "receipt floor rows ({}) != derived floor rows ({})".format(
                len(receipt_floors), len(derived["floors"])
            ),
        )
    for derived_row, receipt_row in zip(derived["floors"], receipt_floors):
        for field in ("key", "value_a", "value_b", "differs"):
            if receipt_row.get(field) != derived_row[field]:
                _fail(
                    failures,
                    "receipt floors[{}].{} = {!r} != derived {!r}".format(
                        derived_row["key"], field, receipt_row.get(field), derived_row[field]
                    ),
                )

    for side in ("only_in_a", "only_in_b"):
        receipt_keys = [
            entry["key"] for entry in ((receipt.get("metrics") or {}).get(side) or [])
        ]
        if receipt_keys != derived[side]:
            _fail(
                failures,
                "receipt {} {!r} != derived {!r}".format(side, receipt_keys, derived[side]),
            )

    page = _PageParser()
    page.feed(html_bytes.decode("utf-8"))
    html_text = " ".join("".join(page.text_chunks).split())

    conditions_table = _table_by_header(page.tables, "Axis", "Detail")
    if conditions_table is None:
        _fail(failures, "the conditions table (Axis..Detail) is not rendered")
        conditions_table = {"rows": []}
    rows_by_axis = {
        row["attrs"].get("data-axis"): row for row in conditions_table["rows"]
    }
    for axis, expected in (
        ("source", derived["source"]),
        ("dataset", derived["dataset"]),
        ("scorer", derived["scorer"]),
    ):
        row = rows_by_axis.get(axis)
        if row is None:
            _fail(failures, "the conditions table has no row bound to data-axis={!r}".format(axis))
            continue
        if row["attrs"].get("data-verdict") != expected:
            _fail(
                failures,
                "conditions row data-axis={} carries verdict {!r} != derived {!r}".format(
                    axis, row["attrs"].get("data-verdict"), expected
                ),
            )

    field_items = {
        item["attrs"].get("data-field"): item["attrs"].get("data-verdict")
        for item in page.items
        if item["attrs"].get("data-field") is not None
    }
    for field_name, expected in expected_field_verdicts.items():
        binding = "dataset." + field_name
        actual = field_items.get(binding)
        if actual is None:
            _fail(failures, "no rendered <li> is bound to data-field={!r}".format(binding))
        elif actual != expected:
            _fail(
                failures,
                "dataset field <li> {} carries verdict {!r} != derived {!r}".format(
                    binding, actual, expected
                ),
            )

    metric_table = _table_by_header(page.tables, "Metric", "Difference")
    if metric_table is None:
        _fail(failures, "the metric table (Metric..Difference) is not rendered")
        metric_table = {"rows": []}
    rendered_metrics = {
        row["attrs"].get("data-metric-key"): row for row in metric_table["rows"]
    }
    if len(metric_table["rows"]) != len(derived["shared"]):
        _fail(
            failures,
            "the metric table renders {} rows for {} derived shared metrics".format(
                len(metric_table["rows"]), len(derived["shared"])
            ),
        )
    for derived_row in derived["shared"]:
        row = rendered_metrics.get(derived_row["key"])
        if row is None:
            _fail(
                failures,
                "no rendered metric row is bound to data-metric-key={!r}".format(
                    derived_row["key"]
                ),
            )
            continue
        cells = row["cells"]
        if len(cells) != 4:
            _fail(
                failures,
                "metric row {} has {} cells, expected 4".format(derived_row["key"], len(cells)),
            )
            continue
        if cells[1] != derived_row["run_a"]:
            _fail(
                failures,
                "metric row {} run A cell {!r} != derived {!r}".format(
                    derived_row["key"], cells[1], derived_row["run_a"]
                ),
            )
        if cells[2] != derived_row["run_b"]:
            _fail(
                failures,
                "metric row {} run B cell {!r} != derived {!r}".format(
                    derived_row["key"], cells[2], derived_row["run_b"]
                ),
            )
        if derived_row["delta"] is None:
            expected_cell = "— not compared " + derived_row["note"]
        else:
            expected_cell = derived_row["delta"] + " " + derived_row["note"]
        if cells[3] != expected_cell:
            _fail(
                failures,
                "metric row {} difference cell {!r} != derived {!r}".format(
                    derived_row["key"], cells[3], expected_cell
                ),
            )

    floor_table = _table_by_header(page.tables, "Metric", "Reference for")
    if floor_table is None:
        _fail(failures, "the floor table (Metric..Reference for) is not rendered")
        floor_table = {"rows": []}
    rendered_floors = {
        row["attrs"].get("data-floor-key"): row for row in floor_table["rows"]
    }
    if len(floor_table["rows"]) != len(derived["floors"]):
        _fail(
            failures,
            "the floor table renders {} rows for {} derived floors".format(
                len(floor_table["rows"]), len(derived["floors"])
            ),
        )
    for derived_row in derived["floors"]:
        row = rendered_floors.get(derived_row["key"])
        if row is None:
            _fail(
                failures,
                "no rendered floor row is bound to data-floor-key={!r}".format(
                    derived_row["key"]
                ),
            )
            continue
        cells = row["cells"]
        if len(cells) != 4:
            _fail(
                failures,
                "floor row {} has {} cells, expected 4".format(derived_row["key"], len(cells)),
            )
            continue
        if cells[1] != derived_row["value_a"]:
            _fail(
                failures,
                "floor row {} run A cell {!r} != derived {!r}".format(
                    derived_row["key"], cells[1], derived_row["value_a"]
                ),
            )
        if cells[2] != derived_row["value_b"]:
            _fail(
                failures,
                "floor row {} run B cell {!r} != derived {!r}".format(
                    derived_row["key"], cells[2], derived_row["value_b"]
                ),
            )
        has_chip = "differs between the runs" in cells[3]
        if has_chip is not derived_row["differs"]:
            _fail(
                failures,
                "floor row {} differs chip is {} but the values {}".format(
                    derived_row["key"],
                    "shown" if has_chip else "absent",
                    "differ" if derived_row["differs"] else "match",
                ),
            )

    lowered = html_bytes.decode("utf-8", errors="replace").lower()
    for marker in ("<script", "<link", "http://", "https://"):
        if marker in lowered:
            _fail(failures, "the rendered view contains {!r} — it is not an offline artifact".format(marker))
    for phrase in _CAUSAL_PHRASES:
        if phrase in lowered:
            _fail(
                failures,
                "the rendered view contains the causal claim {!r}".format(phrase),
            )

    if findings and isinstance(findings, list):
        for line in findings:
            if isinstance(line, str) and line and line not in html_text:
                _fail(
                    failures,
                    "receipt finding {!r} does not appear in the rendered view".format(line),
                )

    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        print(
            "{} disagreement(s) between the view, the receipt and the fixtures".format(
                len(failures)
            ),
            file=sys.stderr,
        )
        return 1

    print(
        "verified: {} fixture files ({} accepted, {} refused); pair {} vs {}".format(
            len(files), len(accepted), len(refused), *expected_compared
        )
    )
    print(
        "comparable={}; shared metrics={}; floors={}; only in A={}; only in B={}".format(
            derived["comparable"],
            len(derived["shared"]),
            len(derived["floors"]),
            len(derived["only_in_a"]),
            len(derived["only_in_b"]),
        )
    )
    print(
        "receipt: inputs {}, tool sources {}, html sha256 bound".format(
            len(actual_inputs), len(expected_tool_source)
        )
    )
    print("html: conditions, metric, floor and field cells bound to parsed positions; offline output; no causal claim")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
