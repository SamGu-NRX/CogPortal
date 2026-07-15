from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable, List, Optional

from . import __version__
from .models import LocalReport, Metric
from .plugins import load_benchmark, load_submission
from .project import repository_state


class ContractError(RuntimeError):
    pass


def _predict(adapter: Any, inputs: List[Any]) -> List[Any]:
    predictor = getattr(adapter, "predict", adapter if callable(adapter) else None)
    if not callable(predictor):
        raise ContractError("Submission adapter must be callable or expose predict(inputs).")
    predictions = predictor(inputs)
    if not isinstance(predictions, list):
        predictions = list(predictions)
    if len(predictions) != len(inputs):
        raise ContractError(
            "Submission returned {} predictions for {} inputs.".format(len(predictions), len(inputs))
        )
    try:
        json.dumps(predictions)
    except (TypeError, ValueError) as error:
        raise ContractError("Predictions must be JSON-serializable.") from error
    return predictions


def execute(
    benchmark: Any,
    adapter: Any,
    cwd: Path,
    smoke: bool = False,
    progress: Optional[Callable[[str], None]] = None,
) -> LocalReport:
    if progress:
        progress("contract_check")
    cases = list(benchmark.public_cases())
    if not cases:
        raise ContractError("The benchmark plugin has no public practice cases.")
    selected = cases[:1] if smoke else cases
    inputs = [case["input"] for case in selected]
    expected = [case["expected"] for case in selected]
    started_at = int(time.time() * 1000)
    if progress:
        progress("evaluating")
    predictions = _predict(adapter, inputs)
    if progress:
        progress("scoring")
    metrics, diagnostics = benchmark.score(predictions, expected)
    if not all(isinstance(metric, Metric) for metric in metrics):
        raise ContractError("Benchmark scorer returned an invalid metric.")
    finished_at = int(time.time() * 1000)
    return LocalReport.create(
        benchmark_id=str(benchmark.benchmark_id),
        benchmark_version=int(benchmark.benchmark_version),
        contract_version=str(benchmark.contract_version),
        sdk_version=__version__,
        plugin_version=str(benchmark.plugin_version),
        repository=repository_state(cwd),
        started_at=started_at,
        finished_at=finished_at,
        metrics=list(metrics),
        diagnostics=list(diagnostics),
        predictions=predictions,
    )


def execute_installed(
    benchmark_id: str,
    cwd: Path,
    smoke: bool = False,
    progress: Optional[Callable[[str], None]] = None,
) -> LocalReport:
    if progress:
        progress("preparing")
    return execute(
        load_benchmark(benchmark_id),
        load_submission(benchmark_id),
        cwd,
        smoke=smoke,
        progress=progress,
    )
