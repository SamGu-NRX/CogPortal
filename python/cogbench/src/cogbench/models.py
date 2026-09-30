from __future__ import annotations

import hashlib
import json
import re
import textwrap
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


def _diagnostic_lines(value: Any, limit: int = 240) -> List[str]:
    """Keep notes within the wire limit without cutting ordinary words.

    Benchmark notes are prose. Sentence boundaries make the best split; a
    sentence longer than the protocol limit falls back to word boundaries.
    """

    text = str(value).strip()
    if not text:
        return [""]
    sentences = re.split(r"(?<=[.!?])\s+", text)
    lines: List[str] = []
    current = ""
    for sentence in sentences:
        candidate = "{} {}".format(current, sentence).strip()
        if current and len(candidate) > limit:
            lines.append(current)
            current = ""
        if len(sentence) <= limit:
            current = "{} {}".format(current, sentence).strip()
            continue
        if current:
            lines.append(current)
            current = ""
        lines.extend(
            textwrap.wrap(
                sentence,
                width=limit,
                break_long_words=True,
                break_on_hyphens=False,
            )
        )
    if current:
        lines.append(current)
    return lines


@dataclass(frozen=True)
class Metric:
    key: str
    label: str
    value: float
    unit: Optional[str]
    higher_is_better: bool
    primary: bool
    precision: int
    #: One or two sentences saying what this measures, in the course's own
    #: vocabulary, and which part of the capstone it corresponds to. A number
    #: a student cannot trace back to something they were taught is a black
    #: box, and a black box teaches nothing. Optional so older plugins that
    #: predate it keep working; a plugin supplies it through `metric_help`.
    help: Optional[str] = None

    def to_wire(self) -> Dict[str, Any]:
        wire = {
            "key": self.key,
            "label": self.label,
            "value": self.value,
            "unit": self.unit,
            "higherIsBetter": self.higher_is_better,
            "primary": self.primary,
            "precision": self.precision,
        }
        # Omitted rather than sent as null, so a reader can distinguish "this
        # benchmark has no explanation for this metric" from "the explanation
        # is the empty string".
        if self.help:
            wire["help"] = self.help
        return wire

    @classmethod
    def from_wire(cls, value: Dict[str, Any]) -> "Metric":
        help_text = value.get("help")
        return cls(
            key=str(value["key"]),
            label=str(value["label"]),
            value=float(value["value"]),
            unit=None if value.get("unit") is None else str(value["unit"]),
            higher_is_better=bool(value["higherIsBetter"]),
            primary=bool(value["primary"]),
            precision=int(value["precision"]),
            help=None if help_text is None else str(help_text),
        )


@dataclass(frozen=True)
class RepositoryState:
    repository_id: Optional[int]
    full_name: Optional[str]
    sha: Optional[str]
    dirty: bool
    branch: Optional[str] = None


@dataclass(frozen=True)
class LocalReport:
    report_id: str
    benchmark_id: str
    benchmark_version: int
    contract_version: str
    sdk_version: str
    plugin_version: str
    repository: RepositoryState
    started_at: int
    finished_at: int
    metrics: List[Metric]
    diagnostics: List[str]
    output_digest: str

    @classmethod
    def create(
        cls,
        benchmark_id: str,
        benchmark_version: int,
        contract_version: str,
        sdk_version: str,
        plugin_version: str,
        repository: RepositoryState,
        started_at: int,
        finished_at: int,
        metrics: List[Metric],
        diagnostics: List[str],
        predictions: List[Any],
    ) -> "LocalReport":
        encoded = json.dumps(predictions, sort_keys=True, separators=(",", ":")).encode("utf-8")
        retained = diagnostics[:32]
        # The wire allows 32 lines. Reserve one for each retained record before
        # spending spare lines on wrapping, so an early note cannot hide a cause.
        spare = 32 - len(retained)
        notes: List[str] = []
        for item in retained:
            lines = _diagnostic_lines(item)
            extra = min(spare, len(lines) - 1)
            notes.extend(lines[:1 + extra])
            spare -= extra
        return cls(
            report_id="local_" + uuid.uuid4().hex,
            benchmark_id=benchmark_id,
            benchmark_version=benchmark_version,
            contract_version=contract_version,
            sdk_version=sdk_version,
            plugin_version=plugin_version,
            repository=repository,
            started_at=started_at,
            finished_at=finished_at,
            metrics=metrics,
            diagnostics=notes,
            output_digest=hashlib.sha256(encoded).hexdigest(),
        )

    def to_wire(self) -> Dict[str, Any]:
        return {
            "reportId": self.report_id,
            "benchmarkId": self.benchmark_id,
            "benchmarkVersion": self.benchmark_version,
            "contractVersion": self.contract_version,
            "sdkVersion": self.sdk_version,
            "pluginVersion": self.plugin_version,
            "repositoryId": self.repository.repository_id,
            "repositoryFullName": self.repository.full_name,
            "sha": self.repository.sha,
            "dirty": self.repository.dirty,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "metrics": [metric.to_wire() for metric in self.metrics],
            "diagnostics": list(self.diagnostics),
        }

    def to_json(self) -> str:
        payload = self.to_wire()
        payload["outputDigest"] = self.output_digest
        return json.dumps(payload, indent=2, sort_keys=True)

    @classmethod
    def from_json(cls, raw: str) -> "LocalReport":
        value = json.loads(raw)
        return cls(
            report_id=str(value["reportId"]),
            benchmark_id=str(value["benchmarkId"]),
            benchmark_version=int(value["benchmarkVersion"]),
            contract_version=str(value["contractVersion"]),
            sdk_version=str(value["sdkVersion"]),
            plugin_version=str(value["pluginVersion"]),
            repository=RepositoryState(
                repository_id=value.get("repositoryId"),
                full_name=value.get("repositoryFullName"),
                sha=value.get("sha"),
                branch=value.get("branch"),
                dirty=bool(value["dirty"]),
            ),
            started_at=int(value["startedAt"]),
            finished_at=int(value["finishedAt"]),
            metrics=[Metric.from_wire(metric) for metric in value["metrics"]],
            diagnostics=[str(item) for item in value.get("diagnostics", [])],
            output_digest=str(value["outputDigest"]),
        )
