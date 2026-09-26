from __future__ import annotations

import hashlib
import inspect
import json
import os
import time
from pathlib import Path
from typing import Any, Callable, List, Optional

from . import __version__
from .models import LocalReport, Metric
from .plugins import load_benchmark, load_submission
from .project import repository_state


class ContractError(RuntimeError):
    pass


_V2_LABELS = {
    "known_identification": "Known identification",
    "unknown_rejection_recall": "Unknown rejection recall",
    "post_enrollment_accuracy": "Post-enrollment accuracy",
    "unknown_lifecycle": "Unknown lifecycle",
    "recognition_score": "Recognition score",
    "clustering_pairwise_f1": "Pairwise F1",
    "adjusted_rand_index": "Adjusted Rand index",
}


def _accepts_progress_counts(callback: Callable[..., None]) -> bool:
    try:
        parameters = list(inspect.signature(callback).parameters.values())
        return any(parameter.kind == parameter.VAR_POSITIONAL for parameter in parameters) or len(parameters) >= 3
    except (TypeError, ValueError):
        return False


def _progress(callback: Callable[..., None], phase: str, current: Optional[int] = None, total: Optional[int] = None) -> None:
    if _accepts_progress_counts(callback) and current is not None and total is not None:
        callback(phase, current, total)
    else:
        callback(phase)


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
    progress: Optional[Callable[..., None]] = None,
    weights: Optional[List[str]] = None,
) -> LocalReport:
    if str(getattr(benchmark, "contract_version", "")) == "cogworks.submissions.v2":
        return _execute_v2(benchmark, adapter, cwd, smoke, progress, weights)
    if progress:
        _progress(progress, "contract_check")
    cases = list(benchmark.public_cases())
    if not cases:
        raise ContractError("The benchmark plugin has no public practice cases.")
    selected = cases[:1] if smoke else cases
    inputs = [case["input"] for case in selected]
    expected = [case["expected"] for case in selected]
    started_at = int(time.time() * 1000)
    if progress:
        _progress(progress, "evaluating", 0, len(inputs))
    predictions = _predict(adapter, inputs)
    if progress and _accepts_progress_counts(progress):
        _progress(progress, "evaluating", len(inputs), len(inputs))
    if progress:
        _progress(progress, "scoring")
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
        weights_used=weights,
    )


def _model_lock() -> Any:
    try:
        from importlib import resources

        try:
            text = (
                resources.files("facial_recognition_benchmark")
                .joinpath("model-lock.json")
                .read_text(encoding="utf-8")
            )
        except AttributeError:
            with resources.open_text(
                "facial_recognition_benchmark", "model-lock.json", encoding="utf-8"
            ) as stream:
                text = stream.read()
        return json.loads(text)
    except (ImportError, OSError, ValueError) as error:
        raise ContractError("The Week 2 model lock is missing or invalid. Reinstall the benchmark package.") from error


def model_cache_status() -> Any:
    lock = _model_lock()
    checkpoint = lock["checkpoint"]
    root = Path(os.environ.get("TORCH_HOME", str(Path.home() / ".cache" / "torch")))
    path = root / "checkpoints" / checkpoint["name"]
    if not path.is_file():
        return {"ready": False, "path": str(path), "message": "checkpoint is not downloaded"}
    if path.stat().st_size != int(checkpoint["size"]):
        return {"ready": False, "path": str(path), "message": "checkpoint size does not match the lock"}
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    if digest != checkpoint["sha256"]:
        return {"ready": False, "path": str(path), "message": "checkpoint checksum does not match the lock"}
    return {"ready": True, "path": str(path), "message": "ready"}


def _facenet_model() -> Any:
    try:
        from facenet_models import FacenetModel
    except ImportError as error:
        raise ContractError(
            "FaceNet is not installed. Install the Week 2 model dependencies from the course setup guide."
        ) from error
    return FacenetModel(device="cpu")


def _metric(
    key: str,
    value: float,
    primary_key: str,
    labels: Optional[dict] = None,
    lower_is_better: Any = (),
    help_text: Optional[str] = None,
    role: Optional[str] = None,
    relates_to: Optional[str] = None,
) -> Metric:
    label_map = _V2_LABELS if labels is None else labels
    return Metric(
        key=key,
        label=label_map.get(key, key.replace("_", " ").title()),
        value=float(value),
        unit=None,
        higher_is_better=key not in lower_is_better,
        primary=key == primary_key,
        # The primary is the leaderboard number and teams differ in the fourth
        # place (0.5375 against 0.5292 on two real week 1 repositories), so it
        # keeps four; the rest are read for shape, not rank.
        precision=4 if key == primary_key else 3,
        help=help_text,
        # Same story as `help` above: the model and `to_wire` have carried
        # these since roles existed and the hosted path sends them, but this
        # local builder never set them, so `cogworks run` reported a floor as
        # an ordinary scored number with an arrow on it. A local report and a
        # hosted one describe the same run and have to say the same thing
        # about it.
        role=role,
        relates_to=relates_to,
    )


def _execute_v2(
    benchmark: Any,
    factory: Any,
    cwd: Path,
    smoke: bool,
    progress: Optional[Callable[..., None]],
    weights: Optional[List[str]] = None,
    model_factory: Callable[[], Any] = _facenet_model,
) -> LocalReport:
    tier = "test" if smoke else "evaluation"
    # Plugins may carry their own model factory and metric presentation;
    # Week 2 predates these attributes, so its FaceNet default stands.
    plugin_model_factory = getattr(benchmark, "model_factory", None)
    if callable(plugin_model_factory):
        model_factory = plugin_model_factory
    labels = getattr(benchmark, "metric_labels", None)
    lower_is_better = getattr(benchmark, "lower_is_better", ())
    # What each number means, in the course's vocabulary. The hosted path has
    # passed this through since metric_help existed (modal_app.py `_wire`),
    # but this local path never did, so `cogbench run` dropped every
    # explanation and a student debugging on their own laptop saw bare
    # numbers while the portal explained them. Absent on plugins that predate
    # metric_help, which is why it reads as a plain dict lookup.
    help_text = getattr(benchmark, "metric_help", None) or {}
    roles = getattr(benchmark, "metric_roles", None) or {}
    relations = getattr(benchmark, "metric_relations", None) or {}
    if progress:
        _progress(progress, "contract_check")
    try:
        cases = list(benchmark.load_cases(tier))
    except Exception as error:
        raise ContractError("Benchmark data could not be prepared: {}".format(error)) from error
    if not cases:
        raise ContractError("The benchmark plugin has no {} cases.".format(tier))
    started_at = int(time.time() * 1000)
    if progress:
        _progress(progress, "evaluating", 0, len(cases))
    try:
        outputs = list(benchmark.run(factory, model_factory(), cases))
    except ContractError:
        raise
    except Exception as error:
        raise ContractError("Student adapter execution failed: {}".format(error)) from error
    if len(outputs) != len(cases):
        raise ContractError(
            "Submission returned {} scenario outputs for {} cases.".format(
                len(outputs), len(cases)
            )
        )
    if progress and _accepts_progress_counts(progress):
        _progress(progress, "evaluating", len(cases), len(cases))
    if progress:
        _progress(progress, "scoring")
    scores = benchmark.score(outputs, cases)
    if not isinstance(scores, dict) or not all(
        isinstance(key, str) and isinstance(value, (int, float))
        for key, value in scores.items()
    ):
        raise ContractError("Benchmark scorer returned invalid v2 metrics.")
    # A plugin may say which metric is primary for THIS run, after scoring.
    # Week 3 withholds `overall` when the image side was never measured and
    # names `text_mrr` instead; the class attribute stays the general answer.
    primary_key = str(getattr(benchmark, "primary_metric_for_run", None) or benchmark.primary_metric)
    metrics = [
        _metric(
            key,
            value,
            primary_key,
            labels,
            lower_is_better,
            help_text.get(key),
            roles.get(key),
            relations.get(key),
        )
        for key, value in scores.items()
    ]
    if not any(metric.primary for metric in metrics):
        raise ContractError("Benchmark scorer omitted its primary metric.")
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
        metrics=metrics,
        diagnostics=list(getattr(benchmark, "last_diagnostics", [])),
        predictions=outputs,
        weights_used=weights,
    )


def execute_installed(
    benchmark_id: str,
    cwd: Path,
    smoke: bool = False,
    progress: Optional[Callable[..., None]] = None,
) -> LocalReport:
    if progress:
        _progress(progress, "preparing")
    benchmark = load_benchmark(benchmark_id)
    return execute(
        benchmark,
        load_submission(benchmark_id, str(benchmark.contract_version)),
        cwd,
        smoke=smoke,
        progress=progress,
    )
