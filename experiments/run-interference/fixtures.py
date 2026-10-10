"""Synthetic benchmark and adapter fixtures for the interference study.

Everything here is offline and tiny: a three-case benchmark whose inputs are
small integer arrays, and adapters that answer ``sum(xs)``. The adapters are
the subjects — one clean control and one that leaks every signal the
detector watches — and the benchmark exists so their runs go through the
repo's real runner (``cogbench.runner.execute``) rather than a harness
written for this study.

The adapters are loaded from file with ``importlib`` and deliberately NOT
registered under a stable name in ``sys.modules``: loading one twice must
produce two independent module objects, because a fresh import is what a
fresh process would see. The shared registry, by contrast, is a normal
module — it is the shared surface through which one adapter's leftovers can
reach the next adapter in the same process.
"""

from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from cogbench.models import Metric

__all__ = ["TinyBenchmark", "ADAPTER_NAMES", "load_adapter_module", "lifecycle_modules",
           "shared_registry_module", "adapters_dir"]

HERE = Path(__file__).resolve().parent
ADAPTERS_DIR = HERE / "fixtures" / "adapters"

#: The fixture adapters, by module name in fixtures/adapters/.
ADAPTER_NAMES = ("clean_reuse", "contaminated_all", "slow_sleeper", "quick_sleeper", "mode_variant")

#: Module name under which the shared registry imports itself. Adapters do
#: ``import shared_registry``; the loader puts the adapters directory on
#: sys.path so that import resolves to this file.
SHARED_REGISTRY_STEM = "shared_registry"


def adapters_dir() -> Path:
    return ADAPTERS_DIR


def load_adapter_module(name: str) -> Any:
    """Load one fixture adapter as a fresh module object.

    The caller owns the lifecycle: reusing the returned object across runs
    reuses one module instance (the in-process condition under study);
    discarding it and loading again is the fresh-import condition.
    """

    path = ADAPTERS_DIR / "{}.py".format(name)
    if not path.is_file():
        raise FileNotFoundError("unknown fixture adapter: {} (no {})".format(name, path))
    _ensure_adapters_on_path()
    spec = importlib.util.spec_from_file_location("_ri_fixture_{}".format(name), path)
    if spec is None or spec.loader is None:
        raise ImportError("could not load fixture adapter: {}".format(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _ensure_adapters_on_path() -> None:
    path = str(ADAPTERS_DIR)
    if path not in sys.path:
        sys.path.insert(0, path)


def shared_registry_module() -> Any:
    """The shared registry as it currently exists in this process.

    Importing it is what creates it (or returns the pollution a previous
    adapter left); the call is deliberately ordinary, because that
    ordinariness is the point — a shared helper is inherited state by
    definition.
    """

    _ensure_adapters_on_path()
    import shared_registry  # noqa: PLC0415 - dynamic by design

    return sys.modules["shared_registry"]


def lifecycle_modules(adapter_name: str, adapter_module: Any) -> Dict[str, Any]:
    """Every module whose lifecycle state this batch must watch.

    The adapter module itself plus any shared helper it imports: an adapter
    can leak through its own namespace or through one they share.
    """

    return {adapter_name: adapter_module, SHARED_REGISTRY_STEM: shared_registry_module()}


class TinyBenchmark:
    """A three-case benchmark over small integer arrays.

    Each case's input carries the payload (``xs``, ``n``) and the run's
    workspace path, which is how an adapter finds its scratch directory
    without global state. ``public_cases`` serves fresh deep copies of the
    template and remembers the exact list it served, so the detector can
    compare template against served after the run: any in-place mutation the
    adapter made is visible as a difference between the two.
    """

    benchmark_id = "run-interference-tiny"
    benchmark_version = 1
    contract_version = "cogworks.submissions.v1"
    plugin_version = "0"

    def __init__(self, workspace: Path) -> None:
        self._workspace = str(workspace)
        self._template = [
            {"input": {"xs": [1, 2, 3], "n": 3, "workspace": self._workspace}, "expected": 6},
            {"input": {"xs": [10, 20, 30, 40], "n": 4, "workspace": self._workspace}, "expected": 100},
            {"input": {"xs": [5, 5, 5, 5, 5], "n": 5, "workspace": self._workspace}, "expected": 25},
        ]
        self.last_served: Optional[List[Dict[str, Any]]] = None

    def public_cases(self) -> List[Dict[str, Any]]:
        served = copy.deepcopy(self._template)
        self.last_served = served
        return served

    def inputs_served(self) -> List[Dict[str, Any]]:
        """The exact input objects the adapter received, post-run."""

        if self.last_served is None:
            return []
        return [case["input"] for case in self.last_served]

    def inputs_template(self) -> List[Dict[str, Any]]:
        return copy.deepcopy([case["input"] for case in self._template])

    def score(self, predictions: List[Any], expected: List[Any]) -> Any:
        matches = sum(1 for prediction, answer in zip(predictions, expected) if prediction == answer)
        metric = Metric(
            key="prediction_match",
            label="Prediction match",
            value=matches / max(1, len(expected)),
            unit=None,
            higher_is_better=True,
            primary=True,
            precision=4,
            role="diagnostic",
            help="Share of cases where the adapter's answer equaled the array sum.",
        )
        return [metric], []
