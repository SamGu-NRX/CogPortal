from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class Metric:
    key: str
    label: str
    value: float
    unit: Optional[str]
    higher_is_better: bool
    primary: bool
    precision: int

    def to_wire(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "value": self.value,
            "unit": self.unit,
            "higherIsBetter": self.higher_is_better,
            "primary": self.primary,
            "precision": self.precision,
        }

    @classmethod
    def from_wire(cls, value: Dict[str, Any]) -> "Metric":
        return cls(
            key=str(value["key"]),
            label=str(value["label"]),
            value=float(value["value"]),
            unit=None if value.get("unit") is None else str(value["unit"]),
            higher_is_better=bool(value["higherIsBetter"]),
            primary=bool(value["primary"]),
            precision=int(value["precision"]),
        )


@dataclass(frozen=True)
class RepositoryState:
    repository_id: Optional[int]
    full_name: Optional[str]
    sha: Optional[str]
    dirty: bool


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
            diagnostics=[str(item)[:240] for item in diagnostics[:32]],
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
                dirty=bool(value["dirty"]),
            ),
            started_at=int(value["startedAt"]),
            finished_at=int(value["finishedAt"]),
            metrics=[Metric.from_wire(metric) for metric in value["metrics"]],
            diagnostics=[str(item) for item in value.get("diagnostics", [])],
            output_digest=str(value["outputDigest"]),
        )
