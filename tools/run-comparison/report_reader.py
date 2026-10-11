"""Read saved CogPortal local run reports, without inventing anything.

A saved run is the JSON file the ``cogworks`` CLI writes for one local
scoring run: the ``LocalReport.to_wire`` payload, serialized by
``to_json`` with sorted keys (see ``python/cogbench/src/cogbench/
models.py``; reference specimen ``python/cogbench/tests/fixtures/
audio_no_weight_report.json``).

This module mirrors that writer's contract, including its provenance
doctrine, and adds nothing to it:

* A field the writer omits to say "not recorded" (``weightsUsed`` on a
  report that predates the field, ``command`` on a pre-0045 report)
  reads back as *unknown* here. It is never replaced with a default:
  unknown weight provenance does not become "used no weights", and an
  unrecorded case set does not become ``run``. Whether either report is
  comparable is decided downstream, on known values only.
* A value the writer's own rules refuse (a command outside
  ``test``/``run``, a weight receipt whose digest cannot describe the
  bytes it names) is refused here with the reason named. A refused
  report is recorded, never silently dropped and never compared.
* A contract this reader cannot interpret (any ``contractVersion``
  other than the one the writer emits today) is refused as
  incompatible. What a metric's role and direction mean cannot be
  trusted under a contract this reader cannot read.

The reader exposes four identities per report -- source, dataset,
scorer and metric -- so that a comparison can speak about each axis
separately instead of about "the run" as an undifferentiated blob.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

#: Contracts this reader can interpret. The writer emits exactly the v2
#: contract today (``LocalReport`` in cogbench models.py). Anything else is
#: refused: a different contract may change what a metric's role or
#: direction means, and reading an unknown contract's numbers as if they
#: were ours is exactly the guess this workbench exists to prevent.
SUPPORTED_CONTRACTS: Tuple[str, ...] = ("cogworks.submissions.v2",)

#: Commands that write a local report (REPORT_COMMANDS in cogbench models).
REPORT_COMMANDS: Tuple[str, ...] = ("test", "run")

#: Fields the writer always writes. Their absence means the file is not a
#: report this reader can interpret at all.
_REQUIRED_FIELDS: Tuple[str, ...] = (
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

#: Fields every metric entry must carry. The writer's ``Metric.to_wire``
#: always emits these; ``unit`` is on the wire too but reads back through
#: ``get``, so it stays optional here like it is there.
_REQUIRED_METRIC_FIELDS: Tuple[str, ...] = (
    "key",
    "label",
    "value",
    "higherIsBetter",
    "primary",
    "precision",
)

_STATUS_ACCEPTED = "accepted"
_STATUS_REFUSED = "refused"

_HEX_DIGITS = frozenset("0123456789abcdef")


@dataclass(frozen=True)
class Refusal:
    """Why one report was refused, in the reader's own vocabulary."""

    code: str
    detail: str

    def __str__(self) -> str:
        return "{}: {}".format(self.code, self.detail)


@dataclass(frozen=True)
class MetricRecord:
    """One measured metric, exactly as the writer recorded it."""

    key: str
    label: str
    value: float
    unit: Optional[str]
    higher_is_better: bool
    primary: bool
    precision: int
    help: Optional[str]
    role: Optional[str]
    relates_to: Optional[str]

    def identity(self) -> Tuple[Any, ...]:
        """What makes this metric *this metric* for comparison purposes.

        The label and help are prose: rewording them does not change what
        was measured. The direction, unit, role, precision and floor
        reference do -- a number whose meaning changed between two runs is
        a changed condition, not a delta.
        """

        return (
            self.key,
            self.unit,
            self.higher_is_better,
            self.role,
            self.precision,
            self.relates_to,
        )


@dataclass(frozen=True)
class WeightReceipt:
    """One captured weight file: path, digest, byte length."""

    path: str
    sha256: str
    size: int


@dataclass(frozen=True)
class SourceIdentity:
    """Whose code the run scored, and whether the run is pinned to it.

    ``dirty`` is the writer's honest admission that the working tree had
    uncommitted changes, so the ``sha`` cannot say what bytes ran. The
    repository name may be unknown on its own (a valid checkout with no
    GitHub origin); that does not stop the run from being pinned to a
    commit.
    """

    repository: Optional[str]
    sha: Optional[str]
    dirty: bool

    @property
    def pins_the_scored_bytes(self) -> bool:
        return bool(self.sha) and not self.dirty


@dataclass(frozen=True)
class DatasetIdentity:
    """What the run was measured against, as far as the report records it.

    A local report has no dataset digest to point at; what it does record
    is which benchmark definition ran, which case set the command scores
    (``test`` smoke cases or ``run`` the public practice set) and which
    weight files were scored. Each part is ``None`` exactly when the
    report does not record it -- never a stand-in value.
    """

    benchmark_id: str
    benchmark_version: int
    command: Optional[str]
    weights_used: Optional[Tuple[str, ...]]
    weights_uploaded: Optional[Tuple[WeightReceipt, ...]]


@dataclass(frozen=True)
class ScorerIdentity:
    """The three version strings that identify the scoring stack."""

    contract_version: str
    sdk_version: str
    plugin_version: str


@dataclass(frozen=True)
class ReadReport:
    """One file's read result: what it says, or why it cannot be read."""

    file: str
    file_sha256: str
    status: str
    refusals: Tuple[Refusal, ...]
    report_id: Optional[str]
    benchmark_id: Optional[str]
    benchmark_version: Optional[int]
    started_at: Optional[int]
    finished_at: Optional[int]
    diagnostics: Tuple[str, ...]
    output_digest: Optional[str]
    source: Optional[SourceIdentity]
    dataset: Optional[DatasetIdentity]
    scorer: Optional[ScorerIdentity]
    metrics: Tuple[MetricRecord, ...]

    @property
    def accepted(self) -> bool:
        return self.status == _STATUS_ACCEPTED


def read_report(path: Path) -> ReadReport:
    """Read one saved report file, refusing it with reasons if it must be."""

    return read_payload(path.read_bytes(), file=path.name)


def read_payload(raw: bytes, file: str) -> ReadReport:
    """Read one saved report from bytes, refusing it with reasons if it must be."""

    file_sha256 = hashlib.sha256(raw).hexdigest()
    refusals: List[Refusal] = []

    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        refusals.append(
            Refusal("not_json", "the file does not parse as JSON ({})".format(error))
        )
        return _refused(file, file_sha256, refusals)

    if not isinstance(value, dict):
        refusals.append(Refusal("not_an_object", "the file is JSON but not an object"))
        return _refused(file, file_sha256, refusals)

    missing = [name for name in _REQUIRED_FIELDS if name not in value]
    if missing:
        refusals.append(
            Refusal("missing_field", "missing {}".format(", ".join(missing)))
        )
        return _refused(file, file_sha256, refusals)

    for message in _bad_top_level_types(value):
        refusals.append(Refusal("bad_field_type", message))

    contract = value["contractVersion"]
    if isinstance(contract, str) and contract not in SUPPORTED_CONTRACTS:
        refusals.append(
            Refusal(
                "unsupported_contract",
                "{} cannot be interpreted by this reader; supported: {}".format(
                    contract, ", ".join(SUPPORTED_CONTRACTS)
                ),
            )
        )

    command = _read_command(value, refusals)
    weights_used, weights_uploaded = _read_weights(value, refusals)
    metrics = _read_metrics(value["metrics"], refusals)
    diagnostics = _read_diagnostics(value, refusals)

    if refusals:
        return _refused(file, file_sha256, refusals)

    assert value is not None and metrics is not None and diagnostics is not None
    return ReadReport(
        file=file,
        file_sha256=file_sha256,
        status=_STATUS_ACCEPTED,
        refusals=(),
        report_id=value["reportId"],
        benchmark_id=value["benchmarkId"],
        benchmark_version=value["benchmarkVersion"],
        started_at=value["startedAt"],
        finished_at=value["finishedAt"],
        diagnostics=diagnostics,
        output_digest=value["outputDigest"],
        source=SourceIdentity(
            repository=(
                value["repositoryFullName"]
                if isinstance(value.get("repositoryFullName"), str)
                else None
            ),
            sha=value["sha"] if isinstance(value.get("sha"), str) else None,
            dirty=value["dirty"],
        ),
        dataset=DatasetIdentity(
            benchmark_id=value["benchmarkId"],
            benchmark_version=value["benchmarkVersion"],
            command=command,
            weights_used=weights_used,
            weights_uploaded=weights_uploaded,
        ),
        scorer=ScorerIdentity(
            contract_version=contract,
            sdk_version=value["sdkVersion"],
            plugin_version=value["pluginVersion"],
        ),
        metrics=metrics,
    )


def _refused(file: str, file_sha256: str, refusals: List[Refusal]) -> ReadReport:
    return ReadReport(
        file=file,
        file_sha256=file_sha256,
        status=_STATUS_REFUSED,
        refusals=tuple(refusals),
        report_id=None,
        benchmark_id=None,
        benchmark_version=None,
        started_at=None,
        finished_at=None,
        diagnostics=(),
        output_digest=None,
        source=None,
        dataset=None,
        scorer=None,
        metrics=(),
    )


def _nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def _int_field(value: Any) -> bool:
    # `type(...) is int`, not isinstance: a JSON true/false parses to a
    # Python bool, which is an int subclass but not a version number.
    return type(value) is int


def _bool_field(value: Any) -> bool:
    return type(value) is bool


def _bad_top_level_types(value: Dict[str, Any]) -> List[str]:
    checks = (
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
    )
    return [
        "{} must be {}, not {!r}".format(name, kind, value[name])
        for name, kind, check in checks
        if not check(value[name])
    ]


def _read_command(value: Dict[str, Any], refusals: List[Refusal]) -> Optional[str]:
    """The producing command, or None for a report that predates it.

    Absence is the only legacy form, exactly as in the writer: a value
    that is present but not one of ours is refused, because reading it as
    either command would label the numbers as answering a question they
    were not produced by.
    """

    if "command" not in value:
        return None
    command = value["command"]
    if command not in REPORT_COMMANDS:
        refusals.append(
            Refusal(
                "unknown_command",
                "command must be one of {}, not {!r}".format(
                    ", ".join(REPORT_COMMANDS), command
                ),
            )
        )
        return None
    return str(command)


def _read_weights(
    value: Dict[str, Any], refusals: List[Refusal]
) -> Tuple[Optional[Tuple[str, ...]], Optional[Tuple[WeightReceipt, ...]]]:
    """Weight provenance, with every unknown kept unknown.

    ``weightsUsed`` absent -> not recorded. ``weightsUploaded`` absent or
    null -> the report predates capture, which says something about the
    writer, not about the weights; it never reads as "used no weights"
    and never as "nothing to upload". Receipt validation mirrors the
    writer's own ``LocalReport._weights_uploaded`` rules.
    """

    weights_used: Optional[Tuple[str, ...]] = None
    if "weightsUsed" in value:
        used = value["weightsUsed"]
        if not isinstance(used, list) or any(
            not isinstance(item, str) for item in used
        ):
            refusals.append(
                Refusal(
                    "malformed_weights_used",
                    "weightsUsed must be a list of weight paths",
                )
            )
        elif len(set(used)) != len(used):
            refusals.append(
                Refusal(
                    "duplicate_weights_used",
                    "weightsUsed names a path more than once; one name "
                    "cannot stand for two sets of bytes",
                )
            )
        else:
            weights_used = tuple(used)

    uploaded = value.get("weightsUploaded")
    if uploaded is None:
        return weights_used, None

    if not isinstance(uploaded, list):
        refusals.append(
            Refusal(
                "malformed_weights_uploaded",
                "weightsUploaded must be a list or null",
            )
        )
        return weights_used, None

    receipts: List[WeightReceipt] = []
    seen_paths = set()
    for entry in uploaded:
        if not isinstance(entry, dict):
            refusals.append(
                Refusal(
                    "malformed_weights_uploaded",
                    "each weightsUploaded entry must be an object",
                )
            )
            continue
        path = entry.get("path")
        checksum = entry.get("sha256")
        size = entry.get("size")
        if not isinstance(path, str):
            refusals.append(
                Refusal(
                    "unscored_weight_receipt",
                    "weightsUploaded names {!r}, which this report did not score".format(
                        path
                    ),
                )
            )
            continue
        seen_paths.add(path)
        if weights_used is None or path not in weights_used:
            refusals.append(
                Refusal(
                    "unscored_weight_receipt",
                    "weightsUploaded names {!r}, which this report did not score".format(
                        path
                    ),
                )
            )
            continue
        if (
            not isinstance(checksum, str)
            or len(checksum) != 64
            or any(character not in _HEX_DIGITS for character in checksum)
        ):
            refusals.append(
                Refusal(
                    "bad_weight_receipt",
                    "weightsUploaded needs a SHA-256 digest for {!r}".format(path),
                )
            )
            continue
        if type(size) is not int or size < 0:
            refusals.append(
                Refusal(
                    "bad_weight_receipt",
                    "weightsUploaded needs a byte length for {!r}".format(path),
                )
            )
            continue
        receipts.append(WeightReceipt(path=path, sha256=checksum, size=size))

    # A receipt that names a scored path but fails validation is one
    # problem; the weight is not *missing*. "Missing" fires only when no
    # entry names the path at all, so a broken receipt is not reported
    # twice under two different theories of what went wrong.
    if len({receipt.path for receipt in receipts}) != len(receipts):
        refusals.append(
            Refusal(
                "duplicate_weight_receipt",
                "weightsUploaded names a path more than once",
            )
        )
    if weights_used is not None:
        missing = [name for name in weights_used if name not in seen_paths]
        if missing:
            refusals.append(
                Refusal(
                    "missing_weight_receipt",
                    "weightsUploaded is missing {}, which this report scored".format(
                        ", ".join(sorted(missing))
                    ),
                )
            )
    return weights_used, tuple(receipts)


def _read_metrics(
    raw_metrics: Any, refusals: List[Refusal]
) -> Tuple[MetricRecord, ...]:
    if not isinstance(raw_metrics, list):
        return ()

    metrics: List[MetricRecord] = []
    seen_keys = set()
    for index, entry in enumerate(raw_metrics):
        if not isinstance(entry, dict):
            refusals.append(
                Refusal(
                    "malformed_metrics",
                    "metrics[{}] must be an object".format(index),
                )
            )
            continue
        missing = [
            name for name in _REQUIRED_METRIC_FIELDS if name not in entry
        ]
        if missing:
            refusals.append(
                Refusal(
                    "malformed_metrics",
                    "metrics[{}] missing {}".format(index, ", ".join(missing)),
                )
            )
            continue

        value = entry["value"]
        if type(value) not in (int, float):
            refusals.append(
                Refusal(
                    "bad_metric_value",
                    "metrics[{}].value must be a number, not {!r}".format(
                        index, value
                    ),
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
                shape_problem = Refusal(
                    "bad_field_type",
                    "metrics[{}].{} must be {}, not {!r}".format(
                        index, name, kind, entry[name]
                    ),
                )
                break
        if shape_problem is not None:
            refusals.append(shape_problem)
            continue

        key = entry["key"]
        if key in seen_keys:
            refusals.append(
                Refusal(
                    "duplicate_metric_key",
                    "metrics names {!r} more than once; a comparison keyed "
                    "by metric could not tell the two apart".format(key),
                )
            )
            continue
        seen_keys.add(key)

        for name in ("unit", "help", "role", "relatesTo"):
            # The writer emits these only as strings or omits them, so a
            # non-string value cannot have come from a report builder.
            optional = entry.get(name)
            if optional is not None and not isinstance(optional, str):
                refusals.append(
                    Refusal(
                        "bad_field_type",
                        "metrics[{}].{} must be a string or omitted, not {!r}".format(
                            index, name, optional
                        ),
                    )
                )

        metrics.append(
            MetricRecord(
                key=key,
                label=entry["label"],
                value=float(value),
                unit=entry.get("unit"),
                higher_is_better=entry["higherIsBetter"],
                primary=entry["primary"],
                precision=entry["precision"],
                help=entry.get("help"),
                role=entry.get("role"),
                relates_to=entry.get("relatesTo"),
            )
        )
    return tuple(metrics)


def _read_diagnostics(value: Dict[str, Any], refusals: List[Refusal]) -> Tuple[str, ...]:
    raw_diagnostics = value.get("diagnostics", [])
    if not isinstance(raw_diagnostics, list) or any(
        not isinstance(item, str) for item in raw_diagnostics
    ):
        refusals.append(
            Refusal(
                "bad_field_type",
                "diagnostics must be a list of strings, not {!r}".format(
                    raw_diagnostics
                ),
            )
        )
        return ()
    return tuple(raw_diagnostics)
