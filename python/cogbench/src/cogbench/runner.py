"""The execution engine: one benchmark, one submission, one LocalReport.

``execute`` is the front door ``cogworks test`` and ``cogworks run`` share,
and it serves two contract generations behind that one signature. A v1
benchmark publishes flat public cases, and the submission predicts all of
them in one call. A v2 benchmark owns the loop instead: the plugin loads
tiered cases, drives the submission's factory scenario by scenario, and
returns raw scores the engine wraps as ``Metric`` objects.
``plugins.load_benchmark`` and ``plugins.load_submission`` find both sides;
the engine only runs what they return.

Nothing here touches the network. Local ``test`` and ``run`` have to work
offline, so the engine reads what is already installed: cases come from the
loaded plugin, and model checkpoints are verified on disk, never fetched.

Every contract violation raises :class:`ContractError` with a message the
student who hit it can act on. The CLI prints that message unchanged, so it
names what happened and one next action, never a bare traceback.
"""

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
    """A benchmark plugin or submission adapter broke the contract.

    The CLI prints these messages to the terminal unchanged, so the text is
    the student's whole explanation: what happened, then one next action.
    """


#: Display labels for the Week 2 metric keys. The Week 2 plugin predates
#: the ``metric_labels`` override in ``_execute_v2``, so the engine carries
#: its labels; a key with no entry here falls back to a title-cased form of
#: the key (see ``_metric``).
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
    """Whether ``callback`` can take ``(phase, current, total)`` updates.

    Sniffed from the signature so callers never declare a callback version:
    any ``*args`` parameter, or at least three named parameters, counts as
    yes, which keeps the old single-argument progress callbacks working
    (``list.append`` is a supported progress target). Callables that
    ``inspect.signature`` cannot read raise TypeError or ValueError; those
    count as no and get phase-only updates.
    """
    try:
        parameters = list(inspect.signature(callback).parameters.values())
        return any(parameter.kind == parameter.VAR_POSITIONAL for parameter in parameters) or len(parameters) >= 3
    except (TypeError, ValueError):
        return False


def _progress(callback: Callable[..., None], phase: str, current: Optional[int] = None, total: Optional[int] = None) -> None:
    """Emit one progress update, with counts when the callback takes them.

    Numberless phases (``contract_check``, ``scoring``) pass ``None`` for
    both counts and always arrive phase-only.
    """
    if _accepts_progress_counts(callback) and current is not None and total is not None:
        callback(phase, current, total)
    else:
        callback(phase)


def _predict(adapter: Any, inputs: List[Any]) -> List[Any]:
    """Run the submission over ``inputs`` and validate what comes back.

    The adapter is either callable itself or exposes ``predict(inputs)``,
    which lets a bare function and a stateful class serve the same v1
    contract. Predictions are coerced to a list, so a tuple or generator
    still passes. The length must match the inputs, and the values must
    survive ``json.dumps``, because the report digest hashes them; both
    checks exist so a wrong return becomes a readable ContractError here
    instead of a crash deep in report creation.
    """
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
) -> LocalReport:
    """Run one benchmark end to end and return the LocalReport.

    The front door for both contracts: a benchmark whose
    ``contract_version`` is ``cogworks.submissions.v2`` routes to the
    scenario path in ``_execute_v2``, and every other benchmark runs the
    v1 path here. That path asks the plugin for its public cases, predicts
    them all in one call, and scores. ``smoke`` (the ``cogworks test``
    command) keeps only the first case, enough to prove the wiring without
    a full run. Progress walks three phases, ``contract_check`` then
    ``evaluating`` with counts, then ``scoring``, so a run page can show
    where a slow run actually is. The plugin's ``score`` returns finished
    ``Metric`` objects; anything else in that list is a ContractError
    rather than a malformed report.
    """
    if str(getattr(benchmark, "contract_version", "")) == "cogworks.submissions.v2":
        return _execute_v2(benchmark, adapter, cwd, smoke, progress)
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
    )


def _model_lock() -> Any:
    """The parsed model-lock.json shipped inside the Week 2 benchmark package.

    The lock records the exact checkpoint the benchmark scores against, so
    the local copy can be checked against it instead of trusted. It is read
    through ``importlib.resources`` so it resolves wherever the package is
    installed. ``importlib.resources.files`` arrived in Python 3.9 and the
    course runs 3.8, hence the ``AttributeError`` fallback through the older
    ``open_text`` API. A missing or unparsable lock is a ContractError
    telling the student to reinstall, because a silently wrong lock would
    surface later as a checksum mismatch they cannot fix.
    """
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
    """Whether the Week 2 checkpoint is on disk and intact.

    The lock names the file, which lives in ``checkpoints/`` under
    ``TORCH_HOME`` (default ``~/.cache/torch``), the directory PyTorch uses
    for downloaded checkpoints. A present file is verified by size first,
    then sha256, because the size check is free and the hash has to read
    the whole file. Returns ``{'ready': bool, 'path': str, 'message': str}``.
    A ``False`` result carries the specific reason, so ``cogworks check``
    can say what is wrong instead of sending a student to re-download a
    checkpoint that was never the problem.
    """
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
    """Build the Week 2 FaceNet model on CPU.

    The heavy dependency is imported here instead of at module import, so
    every command that never runs a benchmark keeps working without it. A
    missing install raises ContractError pointing at the course setup guide
    rather than an ImportError traceback.
    """
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
) -> Metric:
    """Wrap one raw v2 score in a ``Metric``.

    The label comes from the plugin's map when it supplies one, otherwise
    from the engine's Week 2 labels, otherwise from a title-cased form of
    the key. Precision is fixed at 3 decimals, which is what the CLI
    formats to. ``lower_is_better`` holds the keys whose smaller value is
    the good direction, so ``higher_is_better`` is simply the key not
    being in it.
    """
    label_map = _V2_LABELS if labels is None else labels
    return Metric(
        key=key,
        label=label_map.get(key, key.replace("_", " ").title()),
        value=float(value),
        unit=None,
        higher_is_better=key not in lower_is_better,
        primary=key == primary_key,
        precision=3,
    )


def _execute_v2(
    benchmark: Any,
    factory: Any,
    cwd: Path,
    smoke: bool,
    progress: Optional[Callable[..., None]],
    model_factory: Callable[[], Any] = _facenet_model,
) -> LocalReport:
    """Run the scenario contract: the plugin drives, the engine audits.

    The tier is ``test`` when ``smoke`` else ``evaluation``, and the plugin
    loads its own cases for it. The submission arrives as its raw factory
    and is passed through un-instantiated, because the plugin decides when
    and how many times to call it. A plugin may override the engine
    defaults: a ``model_factory`` attribute replaces the FaceNet builder,
    and ``metric_labels`` and ``lower_is_better`` reshape metric
    presentation. Week 2 predates those attributes, so its FaceNet
    defaults stand. ``last_diagnostics``, when the plugin reports it,
    flows into the report as the run's notes.

    The scorer is held to a strict shape: a dict of string keys to
    numbers, and the ``primary_metric`` key must be among them, because a
    report with no primary metric has no headline finding.
    """
    tier = "test" if smoke else "evaluation"
    # Plugins may carry their own model factory and metric presentation;
    # Week 2 predates these attributes, so its FaceNet default stands.
    plugin_model_factory = getattr(benchmark, "model_factory", None)
    if callable(plugin_model_factory):
        model_factory = plugin_model_factory
    labels = getattr(benchmark, "metric_labels", None)
    lower_is_better = getattr(benchmark, "lower_is_better", ())
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
    primary_key = str(benchmark.primary_metric)
    metrics = [
        _metric(key, value, primary_key, labels, lower_is_better)
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
    )


def execute_installed(
    benchmark_id: str,
    cwd: Path,
    smoke: bool = False,
    progress: Optional[Callable[..., None]] = None,
) -> LocalReport:
    """Load the benchmark and its matching submission by id, then run them.

    For callers that hold only a benchmark id, instead of already-loaded
    objects. The submission is resolved under the benchmark's own contract
    version, so a v2 benchmark is never paired with a v1 adapter. The
    ``preparing`` phase is reported before either side loads, because
    first use can spend real time in discovery and a silent wait reads as
    a hang.
    """
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
