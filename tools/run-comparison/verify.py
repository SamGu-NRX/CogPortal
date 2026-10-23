"""Independent verifier for the offline run-comparison workbench.

Re-derives every published decision -- refusals, comparability, source,
dataset, scorer, weight-byte and floor verdicts, shared metric rows and
floor rows -- straight from the raw fixture JSON with its own parser, then
binds the rendered HTML to parsed positions and cross-checks the builder's
receipt row by row and digest by digest, then requires the replay receipt
and re-checks its bindings: the exact fixture digests, the current
generator sources, and the byte digests of the view and receipt files it
attests. It imports neither build.py nor
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
import math
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

from input_naming import input_identities
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

# Elements that fetch or redirect: their presence in the rendered view is
# an offline-contract break even when the page also carries report text
# that merely NAMES a URL in its diagnostics.
_RESOURCE_TAGS = (
    "script",
    "link",
    "iframe",
    "frame",
    "object",
    "embed",
    "applet",
    "base",
)

_TOOL_SOURCE_FILES = ("build.py", "input_naming.py", "report_reader.py")

_REPLAY_GENERATOR = "tools/run-comparison/build.py --replay"


def _fail(failures: List[str], message: str) -> None:
    failures.append("misrendered: " + message)


def _sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _inputs_list(entries: Any) -> Optional[List[Tuple[str, str]]]:
    """The receipt inputs list as ordered (file, sha256) pairs, or None.

    Order-sensitive and duplicate-preserving on purpose: a name->digest
    map would collapse two same-named files from different --fixtures
    roots, and then changing the bytes of the earlier duplicate — while
    leaving its parsed disposition unchanged — would verify green against
    the later one's digest.
    """

    if not isinstance(entries, list):
        return None
    pairs: List[Tuple[str, str]] = []
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("file"), str)
            or not isinstance(entry.get("sha256"), str)
        ):
            return None
        pairs.append((entry["file"], entry["sha256"]))
    return pairs


#: The writer's MAX_WEIGHT_PATH (python/cogbench/src/cogbench/storage.py).
_WEIGHT_PATH_LIMIT = 500


def _usable_weight_path(name: str) -> bool:
    """The writer's ``_usable_name`` rules, mirrored from report_reader.

    The reason strings this verifier derives must match the reader's
    exactly — the receipt's recorded refusal reasons are compared to this
    derivation word for word.
    """

    if not name or len(name) > _WEIGHT_PATH_LIMIT:
        return False
    if name.startswith("/"):
        return False
    for part in name.split("/"):
        if part in ("", ".", ".."):
            return False
        if "\\" in part or any(ord(c) < 32 or ord(c) == 127 for c in part):
            return False
    return True


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
        "sha256": None,
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
    # The digest checked against the receipt comes from the same read as
    # the parse, so the two cannot describe different versions of a file.
    record["sha256"] = _sha_bytes(data)
    try:
        value = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        record["reasons"].append(
            "not_json: the file does not parse as JSON ({})".format(error)
        )
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

    # Mirrors of the reader's later refusals — same conditions, same
    # word-for-word strings: the verifier compares the receipt's recorded
    # refusal reasons to its own derivation, so the two implementations
    # must refuse with identical words, not merely the same labels.
    sha = value.get("sha")
    if sha is not None and (
        not isinstance(sha, str)
        or re.fullmatch(r"[a-f0-9]{40}", sha) is None
    ):
        record["reasons"].append(
            "bad_source_sha: sha must be a 40-character lowercase hex digest "
            "or absent, not {!r}".format(sha)
        )

    contract = value["contractVersion"]
    if isinstance(contract, str) and contract not in SUPPORTED_CONTRACTS:
        record["reasons"].append(
            "unsupported_contract: {} cannot be interpreted by this reader; "
            "supported: {}".format(contract, ", ".join(SUPPORTED_CONTRACTS))
        )

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
                "duplicate_weights_used: weightsUsed names a path more than "
                "once; one name cannot stand for two sets of bytes"
            )
        else:
            bad_paths = [name for name in used if not _usable_weight_path(name)]
            if bad_paths:
                record["reasons"].append(
                    "bad_weight_path: weightsUsed names {}, which is not a "
                    "path the writer could have keyed".format(
                        ", ".join(repr(name) for name in bad_paths)
                    )
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
                # "Missing" fires only when no receipt entry NAMES the path
                # at all (seen_paths holds every named path, validated or
                # not): a broken receipt is one problem, not two theories.
                missing_receipts = [
                    name for name in weights_used if name not in seen_paths
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
        # Already refused by the top-level type check above; the reader
        # names it once, so this derivation must too.
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
        if not math.isfinite(metric_value):
            record["reasons"].append(
                "bad_metric_value: metrics[{}].value must be a finite number, "
                "not {!r}".format(index, metric_value)
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
        if not 0 <= entry["precision"] <= 12:
            record["reasons"].append(
                "bad_precision: metrics[{}].precision must be between 0 and "
                "12, not {!r}".format(index, entry["precision"])
            )
            continue
        key = entry["key"]
        if key in seen_keys:
            record["reasons"].append(
                "duplicate_metric_key: metrics names {!r} more than once; "
                "a comparison keyed by metric could not tell the two apart".format(key)
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
            "bad_field_type: diagnostics must be a list of strings, not {!r}".format(
                value.get("diagnostics", [])
            )
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
        # The same rule the builder applies: matching id and version
        # labels are not a byte-level binding, and the writer's contract
        # records no dataset digest or benchmark commit to bind them.
        fields.append({"field": "benchmark", "verdict": "unknown"})

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
            elif (
                metric_a["unit"],
                metric_a["higher_is_better"],
                metric_a["relates_to"],
            ) != (
                metric_b["unit"],
                metric_b["higher_is_better"],
                metric_b["relates_to"],
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


def _identity_differences(a: Dict[str, Any], b: Dict[str, Any]) -> List[str]:
    """The builder's per-field identity wording, derived independently."""

    def plain(value: Any) -> str:
        if value is None:
            return "unrecorded"
        return "empty" if value == "" else str(value)

    def direction(value: bool) -> str:
        return "higher is better" if value else "lower is better"

    differences = []
    for label, field, text in (
        ("unit", "unit", plain),
        ("direction", "higher_is_better", direction),
        ("role", "role", plain),
        ("precision", "precision", plain),
        ("floor reference", "relates_to", plain),
    ):
        if a[field] != b[field]:
            differences.append(
                "{}: {} vs {}".format(label, text(a[field]), text(b[field]))
            )
    return differences


def _with_unit(value: str, unit: Optional[str]) -> str:
    return "{} {}".format(value, unit) if unit else value


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
    # A floor recorded by one report only still gets a floor row, with the
    # other side's value "not recorded".
    a_only_floors = {
        key for key, metric in a_by_key.items()
        if metric["role"] == "floor" and key not in b_by_key
    }
    b_only_floors = {
        key for key, metric in b_by_key.items()
        if metric["role"] == "floor" and key not in a_by_key
    }
    for key in sorted((set(a_by_key) & set(b_by_key)) | a_only_floors | b_only_floors):
        if key in a_only_floors or key in b_only_floors:
            metric = a_by_key[key] if key in a_only_floors else b_by_key[key]
            value = _fmt(metric["value"], metric["precision"])
            side_a = key in a_only_floors
            floors.append(
                {
                    "key": key,
                    "label": metric["label"] or key,
                    "value_a": value if side_a else "not recorded",
                    "value_b": value if not side_a else "not recorded",
                    "unit_a": (metric["unit"] or "") if side_a else "",
                    "unit_b": (metric["unit"] or "") if not side_a else "",
                    "relates_to_a": (metric["relates_to"] or "") if side_a else "",
                    "relates_to_b": (metric["relates_to"] or "") if not side_a else "",
                    "differs": True,
                    "value_differs": False,
                    "identity_differs": False,
                    "absent_on": "run B" if side_a else "run A",
                }
            )
            continue
        metric_a, metric_b = a_by_key[key], b_by_key[key]
        if (metric_a["role"] == "floor") != (metric_b["role"] == "floor"):
            value_differs = (metric_a["value"], metric_a["precision"]) != (
                metric_b["value"],
                metric_b["precision"],
            )
            floors.append(
                {
                    "key": key,
                    "label": (
                        metric_a if metric_a["role"] == "floor" else metric_b
                    )["label"]
                    or key,
                    "value_a": _fmt(metric_a["value"], metric_a["precision"]),
                    "value_b": _fmt(metric_b["value"], metric_b["precision"]),
                    "unit_a": metric_a["unit"] or "",
                    "unit_b": metric_b["unit"] or "",
                    "relates_to_a": metric_a["relates_to"] or "",
                    "relates_to_b": metric_b["relates_to"] or "",
                    "differs": True,
                    "value_differs": value_differs,
                    "identity_differs": True,
                }
            )
            continue
        if metric_a["role"] == "floor" and metric_b["role"] == "floor":
            value_differs = (metric_a["value"], metric_a["precision"]) != (
                metric_b["value"],
                metric_b["precision"],
            )
            identity_differs = (
                metric_a["unit"],
                metric_a["higher_is_better"],
                metric_a["relates_to"],
            ) != (
                metric_b["unit"],
                metric_b["higher_is_better"],
                metric_b["relates_to"],
            )
            floors.append(
                {
                    "key": key,
                    "label": metric_a["label"] or key,
                    "value_a": _fmt(metric_a["value"], metric_a["precision"]),
                    "value_b": _fmt(metric_b["value"], metric_b["precision"]),
                    "differs": value_differs or identity_differs,
                    "value_differs": value_differs,
                    "identity_differs": identity_differs,
                    "unit_a": metric_a["unit"] or "",
                    "unit_b": metric_b["unit"] or "",
                    "relates_to_a": metric_a["relates_to"] or "",
                    "relates_to_b": metric_b["relates_to"] or "",
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
            "unit_a": metric_a["unit"],
            "unit_b": metric_b["unit"],
            "identity_differences": _identity_differences(metric_a, metric_b),
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
        self.tags: List[Tuple[str, Dict[str, Any]]] = []

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        attributes = dict(attrs)
        self.tags.append((tag, attributes))
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


def _check_header(
    failures: List[str],
    table: Optional[Dict[str, Any]],
    name: str,
    expected: List[str],
) -> None:
    """Bind a table's full ordered header to the derived pair.

    Tables are located by their first and last header cells, which say
    nothing about which run each value column belongs to; a view with the
    run labels swapped would otherwise verify.
    """

    if table is not None:
        actual = [" ".join(cell.split()) for cell in table["header"]]
        normalized = [" ".join(cell.split()) for cell in expected]
        if actual != normalized:
            _fail(
                failures,
                "the {} header reads {!r} != derived {!r}".format(
                    name, actual, normalized
                ),
            )


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
    # The same one deterministic order across every --fixtures root the
    # builder applies, keyed by report name with the full path only
    # breaking same-name ties: the compared pair must not depend on
    # argument order or root layout.
    files.sort(key=lambda path: (path.name, path.resolve().as_posix()))
    if not files:
        print("no fixture files found", file=sys.stderr)
        return 2

    try:
        identities = input_identities(files)
    except ValueError as error:
        print("verify.py: refusing inputs: {}".format(error), file=sys.stderr)
        return 2
    parsed = [_parse_fixture(path) for path in files]
    for record, identity in zip(parsed, identities):
        record["file"] = identity
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
    receipt_bytes = receipt_path.read_bytes()
    try:
        receipt = json.loads(receipt_bytes.decode("utf-8"))
    except ValueError as error:
        print("misrendered: the receipt does not parse as JSON ({})".format(error), file=sys.stderr)
        return 1

    expected_inputs = [(record["file"], record["sha256"]) for record in parsed]
    receipt_inputs = _inputs_list(receipt.get("inputs"))
    if receipt_inputs is None:
        _fail(failures, "the receipt records no well-formed inputs list")
    elif receipt_inputs != expected_inputs:
        _fail(
            failures,
            "receipt inputs do not match the fixture bytes in order: receipt {!r} vs actual {!r}".format(
                receipt_inputs, expected_inputs
            ),
        )

    tool_path = Path(__file__).resolve().parent
    expected_tool_source = {
        name: _sha_bytes((tool_path / name).read_bytes())
        for name in _TOOL_SOURCE_FILES
        if (tool_path / name).exists()
    }
    recorded_tool = receipt.get("tool_source")
    recorded_tool_source = (
        recorded_tool.get("files") if isinstance(recorded_tool, dict) else None
    )
    if recorded_tool_source != expected_tool_source:
        _fail(
            failures,
            "receipt tool_source digests do not match the current generator sources: "
            "receipt {!r} vs actual {!r}".format(recorded_tool_source, expected_tool_source),
        )

    recorded_html_sha = receipt.get("html_sha256")
    if recorded_html_sha != _sha_bytes(html_bytes):
        _fail(failures, "receipt html_sha256 does not match the built view bytes")

    replay_path = out / "replay-{}.json".format(stem)
    if not replay_path.exists():
        _fail(
            failures,
            "the replay receipt {} is missing — evidence without its replay "
            "record is incomplete".format(replay_path.name),
        )
    else:
        try:
            replay = json.loads(replay_path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            _fail(
                failures,
                "the replay receipt does not parse as JSON ({})".format(error),
            )
        else:
            if replay.get("identical") is not True:
                _fail(
                    failures,
                    "the replay receipt does not record an identical rebuild (identical={!r})".format(
                        replay.get("identical")
                    ),
                )
            if replay.get("html_sha256") != _sha_bytes(html_bytes):
                _fail(
                    failures,
                    "replay receipt html_sha256 does not match the built view bytes",
                )
            if replay.get("rebuilt_html_sha256") != _sha_bytes(html_bytes):
                _fail(
                    failures,
                    "replay receipt rebuilt_html_sha256 does not match the built view bytes",
                )
            if replay.get("receipt_sha256") != _sha_bytes(receipt_bytes):
                _fail(
                    failures,
                    "replay receipt receipt_sha256 does not match the receipt bytes on disk",
                )
            replay_inputs = _inputs_list(replay.get("inputs"))
            if replay_inputs is None:
                _fail(failures, "the replay receipt records no well-formed inputs list")
            elif replay_inputs != expected_inputs:
                _fail(
                    failures,
                    "replay receipt inputs do not match the fixture bytes in order: receipt {!r} vs actual {!r}".format(
                        replay_inputs, expected_inputs
                    ),
                )
            replay_tool = replay.get("tool_source")
            replay_tool_source = (
                replay_tool.get("files") if isinstance(replay_tool, dict) else None
            )
            if replay_tool_source != expected_tool_source:
                _fail(
                    failures,
                    "replay receipt tool_source digests do not match the current generator sources: "
                    "receipt {!r} vs actual {!r}".format(
                        replay_tool_source, expected_tool_source
                    ),
                )
            if replay.get("compared") != expected_compared:
                _fail(
                    failures,
                    "replay receipt compared {!r} != independently derived {!r}".format(
                        replay.get("compared"), expected_compared
                    ),
                )
            if replay.get("generator") != _REPLAY_GENERATOR:
                _fail(
                    failures,
                    "replay receipt generator {!r} != expected {!r}".format(
                        replay.get("generator"), _REPLAY_GENERATOR
                    ),
                )

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
    excluded_entries = receipt.get("excluded")
    excluded = [entry["file"] for entry in (excluded_entries or [])]
    if excluded != expected_excluded:
        _fail(
            failures,
            "receipt excluded {!r} != independently derived refusals {!r}".format(
                excluded, expected_excluded
            ),
        )
    elif isinstance(excluded_entries, list):
        # The reasons the reader refused each file, word for word: a
        # receipt that paraphrases a refusal is evidence that the reader
        # did not write it. Matched by position, not by name: the file
        # list above already matched in order, and two roots may each
        # hold a refused file of the same name.
        for position, (entry, record) in enumerate(zip(excluded_entries, refused)):
            if not isinstance(entry, dict) or "reasons" not in entry:
                _fail(
                    failures,
                    "excluded entry {!r} does not record a reasons list".format(entry),
                )
                continue
            recorded_reasons = entry["reasons"]
            if not isinstance(recorded_reasons, list):
                _fail(
                    failures,
                    "excluded entry {!r} carries a malformed reasons list".format(
                        entry.get("file")
                    ),
                )
            elif recorded_reasons != record["reasons"]:
                _fail(
                    failures,
                    "receipt refusal reasons for {!r} (excluded[{}]): receipt {!r} != independently derived {!r}".format(
                        entry.get("file"),
                        position,
                        recorded_reasons,
                        record["reasons"],
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

    # The leading finding is a generated claim, so bind its wording to the
    # derived axis verdicts: a changed source may never be announced as an
    # all-conditions-match pair, and the all-match claim may never hide a
    # source change.
    axes_same = (
        derived["source"] == "same"
        and derived["dataset"] == "same"
        and derived["scorer"] == "same"
    )
    if axes_same:
        expected_leading = (
            "All recorded conditions match: source, dataset (benchmark, case "
            "set, weight bytes, scoring floors) and scorer identity."
        )
    elif derived["source"] == "changed":
        expected_leading = (
            "source differs between the runs; the metric deltas below "
            "are observations only and state no cause"
        )
    else:
        expected_leading = None
    if expected_leading is not None and isinstance(findings, list) and findings:
        if findings[0] != expected_leading:
            _fail(
                failures,
                "the leading finding reads {!r} != derived {!r}".format(
                    findings[0], expected_leading
                ),
            )

    receipt_shared = (receipt.get("metrics") or {}).get("shared") or []
    if len(receipt_shared) != len(derived["shared"]):
        _fail(
            failures,
            "receipt shared rows ({}) != derived rows ({})".format(
                len(receipt_shared), len(derived["shared"])
            ),
        )
    for derived_row, receipt_row in zip(derived["shared"], receipt_shared):
        for field in (
            "key",
            "label",
            "run_a",
            "run_b",
            "unit_a",
            "unit_b",
            "identity_differences",
            "direction",
        ):
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
        for field in (
            "key",
            "value_a",
            "value_b",
            "differs",
            "value_differs",
            "identity_differs",
            "unit_a",
            "unit_b",
            "relates_to_a",
            "relates_to_b",
            "absent_on",
        ):
            if receipt_row.get(field) != derived_row.get(field):
                _fail(
                    failures,
                    "receipt floors[{}].{} = {!r} != derived {!r}".format(
                        derived_row["key"], field, receipt_row.get(field), derived_row.get(field)
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
        visible_chip = row["cells"][1] if len(row["cells"]) > 1 else ""
        if visible_chip != expected:
            _fail(
                failures,
                "conditions row {} visible verdict chip reads {!r} != derived {!r}".format(
                    axis, visible_chip, expected
                ),
            )

    rendered_field_items = {
        item["attrs"].get("data-field"): item
        for item in page.items
        if item["attrs"].get("data-field") is not None
    }
    for field_name, expected in expected_field_verdicts.items():
        binding = "dataset." + field_name
        item = rendered_field_items.get(binding)
        if item is None:
            _fail(failures, "no rendered <li> is bound to data-field={!r}".format(binding))
            continue
        actual = item["attrs"].get("data-verdict")
        if actual != expected:
            _fail(
                failures,
                "dataset field <li> {} carries verdict {!r} != derived {!r}".format(
                    binding, actual, expected
                ),
            )
        # The chip text is what a reader sees; bind it to the derived
        # verdict too, not just the data-verdict attribute.
        visible = item["text"]
        visible_chip = (
            visible[len(field_name) + 1:].split(" ", 1)[0]
            if visible.startswith(field_name + " ")
            else ""
        )
        if visible_chip != expected:
            _fail(
                failures,
                "dataset field <li> {} visible verdict reads {!r} != derived {!r}".format(
                    binding, visible_chip, expected
                ),
            )

    run_columns = [
        "Run A ({})".format(expected_compared[0]),
        "Run B ({})".format(expected_compared[1]),
    ]
    metric_table = _table_by_header(page.tables, "Metric", "Difference")
    _check_header(
        failures, metric_table, "metric table", ["Metric", *run_columns, "Difference"]
    )
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
        # Each value cell carries its own run's unit.
        expected_a = _with_unit(derived_row["run_a"], derived_row["unit_a"])
        expected_b = _with_unit(derived_row["run_b"], derived_row["unit_b"])
        if cells[1] != expected_a:
            _fail(
                failures,
                "metric row {} run A cell {!r} != derived {!r}".format(
                    derived_row["key"], cells[1], expected_a
                ),
            )
        if cells[2] != expected_b:
            _fail(
                failures,
                "metric row {} run B cell {!r} != derived {!r}".format(
                    derived_row["key"], cells[2], expected_b
                ),
            )
        expected_sub = derived_row["key"]
        if derived_row["identity_differences"]:
            expected_sub += " · identity differs between the runs: " + "; ".join(
                derived_row["identity_differences"]
            )
        if not cells[0].endswith(expected_sub):
            _fail(
                failures,
                "metric row {} heading {!r} does not end with the derived "
                "key and identity line {!r}".format(
                    derived_row["key"], cells[0], expected_sub
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
    _check_header(
        failures, floor_table, "floor table", ["Metric", *run_columns, "Reference for"]
    )
    if floor_table is None:
        if derived["floors"]:
            _fail(failures, "the floor table (Metric..Reference for) is not rendered")
        floor_table = {"rows": []}
    elif not derived["floors"] and floor_table["rows"]:
        _fail(
            failures,
            "the floor table renders {} rows but no floors are derived".format(
                len(floor_table["rows"])
            ),
        )
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
        has_value_chip = "value differs between the runs" in cells[3]
        if has_value_chip is not derived_row["value_differs"]:
            _fail(
                failures,
                "floor row {} value-differs chip is {} but the values {}".format(
                    derived_row["key"],
                    "shown" if has_value_chip else "absent",
                    "differ" if derived_row["value_differs"] else "match",
                ),
            )
        absent_on = derived_row.get("absent_on")
        for side in ("run A", "run B"):
            has_absent_chip = "not recorded on {}".format(side) in cells[3]
            if has_absent_chip is not (absent_on == side):
                _fail(
                    failures,
                    "floor row {} 'not recorded on {}' chip is {} but the "
                    "floor is {}".format(
                        derived_row["key"],
                        side,
                        "shown" if has_absent_chip else "absent",
                        "missing there" if absent_on == side else "recorded there",
                    ),
                )
        has_identity_chip = "floor identity differs between the runs" in cells[3]
        if has_identity_chip is not derived_row["identity_differs"]:
            _fail(
                failures,
                "floor row {} identity-differs chip is {} but the floor identities {}".format(
                    derived_row["key"],
                    "shown" if has_identity_chip else "absent",
                    "differ" if derived_row["identity_differs"] else "match",
                ),
            )

    if not derived["floors"] and "No floor metrics recorded." not in html_text:
        _fail(
            failures,
            "the floorless pair does not render the 'No floor metrics recorded.' empty state",
        )

    # The recorded-provenance table: bind every cell to the independently
    # derived value, so a swapped report id, commit prefix, weight list or
    # scorer version cannot pass the digest checks unnoticed — those bind
    # whole files, not which report a row belongs to.
    provenance_table = None
    for table in page.tables:
        if (
            table["header"]
            and table["header"][0] == "Field"
            and len(table["header"]) == 3
        ):
            provenance_table = table
            break
    _check_header(
        failures, provenance_table, "provenance table", ["Field", *run_columns]
    )
    if provenance_table is None:
        _fail(failures, "the recorded-provenance table (Field..Run B) is not rendered")
        provenance_table = {"rows": []}
    rendered_provenance: Dict[str, Tuple[str, str]] = {}
    for row in provenance_table["rows"]:
        if len(row["cells"]) == 3:
            rendered_provenance[row["cells"][0]] = (row["cells"][1], row["cells"][2])

    def _prov_source_cell(record: Dict[str, Any]) -> str:
        sha = record["source"]["sha"]
        if sha is None:
            return "not recorded"
        pins = (
            "pins the scored bytes"
            if (bool(sha) and not record["source"]["dirty"])
            else "does not pin the scored bytes (dirty tree)"
        )
        return "{} — {}".format(sha[:12], pins)

    def _prov_benchmark(record: Dict[str, Any]) -> str:
        raw = record["value"]
        benchmark_id = raw["benchmarkId"]
        benchmark_version = raw["benchmarkVersion"]
        if benchmark_id is None:
            return "an unrecorded benchmark"
        if benchmark_version is None:
            return "{!r} (version unrecorded)".format(benchmark_id)
        return "{!r} v{}".format(benchmark_id, benchmark_version)

    def _prov_case_set(record: Dict[str, Any]) -> str:
        command = record["dataset"]["command"]
        return "`{}`".format(command) if command is not None else "not recorded"

    def _prov_weights_used(record: Dict[str, Any]) -> str:
        weights = record["dataset"]["weights_used"]
        if weights is None:
            return "not recorded — may predate weight recording"
        if not weights:
            return "none recorded"
        return ", ".join(weights)

    def _prov_weight_capture(record: Dict[str, Any]) -> str:
        capture = record["dataset"]["weights_uploaded"]
        if capture is None:
            return "not recorded — the report may predate weight capture"
        if not capture:
            return "recorded: nothing was uploaded"
        return "; ".join(
            "{} ({} bytes, sha256 {})".format(
                receipt["path"], receipt["size"], receipt["sha256"][:12]
            )
            for receipt in capture
        )

    expected_provenance = {
        "Report ID": (
            str(a_record["value"]["reportId"]),
            str(b_record["value"]["reportId"]),
        ),
        "Repository": (
            str(a_record["source"]["repository"]),
            str(b_record["source"]["repository"]),
        ),
        "Commit": (
            _prov_source_cell(a_record),
            _prov_source_cell(b_record),
        ),
        "Benchmark": (
            _prov_benchmark(a_record),
            _prov_benchmark(b_record),
        ),
        "Case set (command)": (
            _prov_case_set(a_record),
            _prov_case_set(b_record),
        ),
        "Weights used": (
            _prov_weights_used(a_record),
            _prov_weights_used(b_record),
        ),
        "Weight capture": (
            _prov_weight_capture(a_record),
            _prov_weight_capture(b_record),
        ),
        "Contract": (
            a_record["scorer"]["contract"] or "not recorded",
            b_record["scorer"]["contract"] or "not recorded",
        ),
        "SDK": (
            a_record["scorer"]["sdk"] or "not recorded",
            b_record["scorer"]["sdk"] or "not recorded",
        ),
        "Plugin": (
            a_record["scorer"]["plugin"] or "not recorded",
            b_record["scorer"]["plugin"] or "not recorded",
        ),
    }
    for label, expected_cells in expected_provenance.items():
        rendered = rendered_provenance.get(label)
        if rendered is None:
            _fail(failures, "the provenance table has no {!r} row".format(label))
        elif rendered != expected_cells:
            _fail(
                failures,
                "provenance {!r} cells {!r} != derived {!r}".format(
                    label, rendered, expected_cells
                ),
            )

    # The comparability banner: bind the derived condition to the words a
    # reader sees, including the comparable-with-a-changed-source case the
    # builder must not paper over with an all-clear.
    axes_all_same = (
        derived["source"] == "same"
        and derived["dataset"] == "same"
        and derived["scorer"] == "same"
    )
    if derived["comparable"] and axes_all_same:
        expected_banner = (
            "Conditions line up on every axis the reports record. The deltas "
            "below are observations only — this view states no cause for any "
            "difference."
        )
    elif derived["comparable"]:
        expected_banner = (
            "Comparable as conditions stand: the source difference above is "
            "the change under observation, and the dataset and scorer "
            "conditions the deltas depend on line up. The deltas below are "
            "observations only — this view states no cause for any difference."
        )
    else:
        expected_banner = "Not comparable as conditions stand."
    if derived["comparable"]:
        if expected_banner not in html_text:
            _fail(
                failures,
                "the rendered banner does not state the derived comparable "
                "condition ({!r}...)".format(expected_banner[:72]),
            )
        if "Not comparable as conditions stand." in html_text:
            _fail(
                failures,
                "the rendered banner claims the pair is not comparable while "
                "the derived conditions are comparable",
            )
    elif expected_banner not in html_text:
        _fail(
            failures,
            "the rendered banner does not state that the pair is not comparable",
        )

    expected_pair_note = (
        "Compared: {} and {} — the first two accepted reports in sorted order "
        "({} of {} fixture files accepted).".format(
            expected_compared[0], expected_compared[1], len(accepted), len(files)
        )
    )
    if " ".join(expected_pair_note.split()) not in html_text:
        _fail(
            failures,
            "the rendered pair note does not name the derived comparison scope",
        )

    # Offline scan, parser-based: the resource element itself and any
    # attribute value carrying a URL are what fetch. Report-sourced text
    # naming a URL in its diagnostics is data, not a resource, and is
    # exempt here.
    for tag, attributes in page.tags:
        if tag in _RESOURCE_TAGS:
            _fail(
                failures,
                "the rendered view contains a <{}> element — it is not an offline artifact".format(
                    tag
                ),
            )
        for value in attributes.values():
            if isinstance(value, str) and (
                "http://" in value.lower() or "https://" in value.lower()
            ):
                _fail(
                    failures,
                    "the rendered view carries a URL in an attribute of <{}> — it is not an offline artifact".format(
                        tag
                    ),
                )

    # The causal scan covers the claims the BUILDER authors — receipt
    # findings, the pair note, the comparability banner, and every rendered
    # detail cell the fixture data does not supply. Report-sourced text
    # (diagnostics, provenance values, labels) is exempt: a diagnostic may
    # repeat a producing tool's own "caused by" without the view claiming
    # anything.
    generated_claims: List[str] = [
        line
        for line in (findings if isinstance(findings, list) else [])
        if isinstance(line, str)
    ]
    pair_note_claim = expected_pair_note
    for name in expected_compared:
        pair_note_claim = pair_note_claim.replace(name, "")
    generated_claims.append(pair_note_claim)
    if derived["comparable"]:
        generated_claims.append(expected_banner)
    for table, column in ((conditions_table, 2), (metric_table, 3), (floor_table, 3)):
        for row in table["rows"]:
            cells = row["cells"]
            if len(cells) > column:
                generated_claims.append(cells[column])
    for item in page.items:
        if item["attrs"].get("data-field") is not None:
            generated_claims.append(item["text"])
    for claim in generated_claims:
        lowered_claim = claim.lower()
        for phrase in _CAUSAL_PHRASES:
            if phrase in lowered_claim:
                _fail(
                    failures,
                    "the generated claim {!r} contains the causal claim {!r}".format(
                        claim, phrase
                    ),
                )

    if findings and isinstance(findings, list):
        for line in findings:
            if isinstance(line, str) and line and line not in html_text:
                _fail(
                    failures,
                    "receipt finding {!r} does not appear in the rendered view".format(line),
                )

    if isinstance(excluded_entries, list):
        for entry in excluded_entries:
            if not isinstance(entry, dict):
                continue
            for reason in entry.get("reasons") or []:
                if isinstance(reason, str) and reason and reason not in html_text:
                    _fail(
                        failures,
                        "receipt exclusion reason {!r} does not appear in the rendered view".format(
                            reason
                        ),
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
            len(expected_inputs), len(expected_tool_source)
        )
    )
    print(
        "replay receipt: identical rebuild attested; view, receipt, fixture and generator-source digests all bound"
    )
    print("html: conditions, metric, floor and field cells bound to parsed positions; offline output; no causal claim")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
