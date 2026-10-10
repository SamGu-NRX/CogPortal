"""The owned supervisor for the run-interference study.

The supervisor runs fixture adapter batches through the repo's real local
runner (``cogbench.runner.execute``) and the repo's real isolation boundary
(``cogbench.isolate.run_isolated``). It does not reimplement or stub either:
in-process batches call the runner directly, which is precisely the
lifecycle condition under study — one process, many adapter runs, each
inheriting whatever the previous run left behind. Isolated batches hand a
closure to ``run_isolated`` and let that module install its rlimits, its
scratch-directory contract, and its process-group cleanup.

Two honest limits shape everything here. An in-process run cannot be killed
for running long or printing too much without killing the supervisor
itself, so in that mode time, memory, CPU, and output are OBSERVED, and the
only enforcement is after the fact: the supervisor reaps descendants the
run left behind and removes its scratch. A run inside ``run_isolated`` is
genuinely ENFORCED against wall clock, address space, and CPU time by that
module. The matrix is recorded verbatim on every batch; nothing in the
artifacts should claim more than was enforced.

All evidence this supervisor produces is JSON-able, and every number in it
is either measured (a snapshot, a sampler series, a reap record) or a
declared limit. The detector judges the evidence; the supervisor only
gathers it.
"""

from __future__ import annotations

import importlib
import os
import shutil
import signal
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
COGBENCH_SRC = REPO_ROOT / "python" / "cogbench" / "src"


def ensure_import_paths() -> None:
    """Put this directory and the cogbench source tree on sys.path.

    The study runs from a repository checkout, not an installed package, so
    the real modules are imported from ``python/cogbench/src``. Inserting is
    idempotent; the forked isolate children inherit the paths.
    """

    for path in (str(HERE), str(COGBENCH_SRC)):
        if path not in sys.path:
            sys.path.insert(0, path)


ensure_import_paths()

from cogbench import runner as real_runner  # noqa: E402 - path must exist first
from cogbench.isolate import run_isolated as real_run_isolated  # noqa: E402

import evidence as ev  # noqa: E402
from fixtures import (  # noqa: E402
    TinyBenchmark,
    load_adapter_module,
)

__all__ = ["Limits", "ENFORCEMENT", "RunSupervisor", "new_run_id"]


def new_run_id() -> str:
    """A directory name for one execution of the manifest."""

    return time.strftime("%Y%m%d-%H%M%S") + "-run-interference"


@dataclass(frozen=True)
class Limits:
    """Study-wide bounds. Every value is a declaration the artifacts carry."""

    #: Wall clock per isolated run; the isolate module kills past it.
    run_timeout_seconds: float = 10.0
    #: Address space for an isolated child (RLIMIT_AS via the isolate module).
    child_memory_bytes: int = 1024 * 1024 * 1024
    #: Per-run capture cap for stdout/stderr bytes. Past it, bytes are
    #: counted and dropped, not stored.
    capture_bytes: int = 256 * 1024
    #: A run whose captured output exceeds this is flagged as flooding.
    flood_bytes: int = 128 * 1024
    #: Sampler cadence for the during-series.
    sample_interval_seconds: float = 0.02

    def to_dict(self) -> Dict[str, Any]:
        return {
            "run_timeout_seconds": self.run_timeout_seconds,
            "child_memory_bytes": self.child_memory_bytes,
            "capture_bytes": self.capture_bytes,
            "flood_bytes": self.flood_bytes,
            "sample_interval_seconds": self.sample_interval_seconds,
        }


#: What is enforced versus observed, per execution mode. Recorded on every
#: batch so no reader has to infer it from the code.
ENFORCEMENT: Dict[str, Dict[str, str]] = {
    "inprocess": {
        "wall_clock": "observed",
        "memory": "observed",
        "cpu": "observed",
        "output": "observed (capped in the capture sink; cannot stop a flood in-process)",
        "handles": "observed (leaked descriptors recorded, not closed — they may belong to the host process)",
        "children": "enforced after the run (supervisor reaps descendants it owns)",
        "note": "an in-process run cannot be stopped or bounded without killing the supervisor itself; "
                "the process boundary is the only real enforcement and this mode deliberately has none",
    },
    "isolated": {
        "wall_clock": "enforced (cogbench.isolate kills the child at the deadline)",
        "memory": "enforced (RLIMIT_AS, when the platform honors it)",
        "cpu": "enforced (RLIMIT_CPU soft/hard via cogbench.isolate._cpu_limit)",
        "output": "observed in-child (capped); result payload bounded by the isolate transport",
        "handles": "observed in-child; the boundary destroys them with the child",
        "children": "enforced (child runs setsid; cogbench.isolate kills the process group, "
                    "which reaches children the child spawned)",
        "note": "a descendant that escapes the group (setsid of its own) is outside what "
                "cogbench.isolate claims to reach; the supervisor's sweep would still see it here",
    },
}


def _swap(obj: Any, name: str, value: Any) -> Any:
    old = getattr(obj, name)
    setattr(obj, name, value)
    return old


class RunSupervisor:
    """Runs batches, gathers evidence, reaps what runs leave behind."""

    def __init__(
        self,
        limits: Optional[Limits] = None,
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.limits = limits or Limits()
        self._log_callback = log
        self.log_lines: List[str] = []

    def _log(self, line: str) -> None:
        stamped = "{} {}".format(time.strftime("%H:%M:%S"), line)
        self.log_lines.append(stamped)
        if self._log_callback is not None:
            self._log_callback(stamped)

    # ---- batch execution -------------------------------------------------

    def _reset_shared_registry(self) -> Dict[str, Any]:
        """Restore the fixture registry to its pristine import state.

        ``shared_registry`` is cached in ``sys.modules`` for the life of the
        host process, so a second batch would otherwise inherit the
        contamination a previous batch wrote there — the study's own subject
        leaking into the measurement. Reloading re-executes the module body,
        which resets its globals; batches that never touch it are unaffected.
        """

        module = sys.modules.get("shared_registry")
        if module is None:
            return {"reset": False}
        importlib.reload(module)
        return {"reset": True}

    def run_batch(self, spec: Dict[str, Any]) -> Dict[str, Any]:
        """Run one manifest batch and return its full evidence record."""

        batch_id = str(spec["id"])
        mode = str(spec.get("mode", "inprocess"))
        if mode not in ENFORCEMENT:
            raise ValueError("unknown batch mode: {}".format(mode))
        registry_reset = self._reset_shared_registry()
        adapters_cycle = list(spec["adapters"])
        runs_planned = int(spec.get("runs", 1))
        concurrency = max(1, int(spec.get("concurrency", 1)))
        timeout_seconds = float(spec.get("timeout_seconds", self.limits.run_timeout_seconds))
        expect_flagged = sorted(spec.get("expect_flagged", []))
        expect_clean = sorted(spec.get("expect_clean", []))
        interrupt_after = spec.get("interrupt_after_seconds")

        self._log("batch {}: mode={} adapters={} runs={} concurrency={} timeout={}s".format(
            batch_id, mode, "+".join(adapters_cycle), runs_planned, concurrency, timeout_seconds))

        work_root = Path(tempfile.mkdtemp(prefix="ri-{}-".format(batch_id)))
        # Publish the batch's concurrency to the adapters BEFORE the fresh
        # baselines: a baseline must answer under the same published context
        # as the batch's runs, so drift measures contamination and not
        # context sensitivity (the mode-variant control answers per this
        # variable by design). Saved and restored around the batch so
        # nothing leaks into later batches or the host.
        concurrency_token = os.environ.get("RI_BATCH_CONCURRENCY")
        os.environ["RI_BATCH_CONCURRENCY"] = str(concurrency)
        baseline_timeout = min(timeout_seconds, self.limits.run_timeout_seconds)
        baselines = {name: self._fresh_baseline(name, baseline_timeout)
                     for name in dict.fromkeys(adapters_cycle)}

        processes_before = ev.descendant_pids()
        files_before = ev.dir_file_count(work_root)
        fds_before_batch = ev.fd_snapshot()

        runs: List[Dict[str, Any]] = []
        module_state_series: List[Dict[str, Any]] = []
        interruption: Optional[Dict[str, Any]] = None

        # In-process mode studies ONE module lifecycle across runs, so the
        # fixture modules are loaded exactly once here and reused. Isolated
        # mode loads fresh inside every child; there is no batch-wide module
        # object to snapshot, and the series stays empty.
        modules: Dict[str, Any] = {}
        if mode == "inprocess":
            for name in dict.fromkeys(adapters_cycle):
                modules[name] = load_adapter_module(name)
            module_state_series.append({"label": "before", "states": self._states(modules)})

        def run_one(index: int) -> Dict[str, Any]:
            adapter_name = adapters_cycle[index % len(adapters_cycle)]
            run_scratch = work_root / "run-{:03d}".format(index)
            run_scratch.mkdir(parents=True, exist_ok=True)
            if mode == "inprocess":
                record = self._run_inprocess(
                    modules[adapter_name], adapter_name, batch_id, index, run_scratch, timeout_seconds)
            else:
                record = self._run_isolated(
                    adapter_name, batch_id, index, run_scratch, timeout_seconds)
            record["baseline_output_digest"] = baselines.get(adapter_name, {}).get("output_digest")
            record["expect_flagged"] = expect_flagged
            record["expect_clean"] = expect_clean
            return record

        shared_capture = concurrency > 1 and mode == "inprocess"
        sink = ev.CaptureSink(self.limits.capture_bytes)
        guards: Tuple[Any, Any] = (None, None)
        if shared_capture:
            # One capture sink installed for the whole concurrent batch:
            # per-run swaps from two threads would clobber each other. The
            # sink keeps thread-local buffers, so per-run take() still splits
            # the stream at run boundaries on each worker thread.
            guards = (_swap(sys, "stdout", sink), _swap(sys, "stderr", sink))

        timer: Optional[threading.Timer] = None
        try:
            if interrupt_after is not None:
                timer = threading.Timer(float(interrupt_after), self._raise_sigint)
                timer.start()
            if concurrency > 1:
                from concurrent.futures import ThreadPoolExecutor

                with ThreadPoolExecutor(max_workers=concurrency) as pool:
                    records = list(pool.map(run_one, range(runs_planned)))
                runs.extend(records)
            else:
                for index in range(runs_planned):
                    runs.append(run_one(index))
                    if mode == "inprocess":
                        module_state_series.append({
                            "label": "after_run_{:03d}".format(index),
                            "states": self._states(modules),
                        })
        except KeyboardInterrupt:
            interruption = {
                "signal": "SIGINT",
                "completed_runs": len(runs),
                "planned_runs": runs_planned,
            }
            self._log("batch {}: interrupted by SIGINT after {} run(s)".format(batch_id, len(runs)))
        finally:
            if concurrency_token is None:
                os.environ.pop("RI_BATCH_CONCURRENCY", None)
            else:
                os.environ["RI_BATCH_CONCURRENCY"] = concurrency_token
            if timer is not None:
                timer.cancel()
            if shared_capture:
                _swap(sys, "stdout", guards[0])
                _swap(sys, "stderr", guards[1])

        reaped, remaining = self._sweep("post-batch " + batch_id)
        processes_after = ev.descendant_pids()
        files_after = ev.dir_file_count(work_root)
        fds_after_batch = ev.fd_snapshot()
        shutil.rmtree(work_root, ignore_errors=True)
        files_after_cleanup = ev.dir_file_count(work_root)

        record: Dict[str, Any] = {
            "batch_id": batch_id,
            "spec": {
                "id": batch_id, "mode": mode, "adapters": adapters_cycle,
                "runs": runs_planned, "concurrency": concurrency,
                "timeout_seconds": timeout_seconds,
                "interrupt_after_seconds": interrupt_after,
                "purpose": spec.get("purpose", "measurement"),
            },
            "limits": self.limits.to_dict(),
            "limits_enforcement": ENFORCEMENT[mode],
            "baselines": baselines,
            "runs": runs,
            "module_state_series": module_state_series,
            "counts": {
                "processes": {
                    "before": len(processes_before),
                    "during_max": self._max_descendants(runs),
                    "after": len(processes_after),
                },
                "files": {
                    "before": files_before,
                    "after": files_after,
                    "after_cleanup": files_after_cleanup,
                    "during_max_per_run": self._max_scratch_files(runs),
                },
                "fds": {
                    "before_batch": fds_before_batch.get("count"),
                    "after_batch": fds_after_batch.get("count"),
                },
            },
            "supervision": {"reaped": reaped, "remaining_after_sweep": remaining},
        }
        if interruption is not None:
            interruption.update({
                "orphans_found": [child for run in runs for child in run["children"]["after"]],
                "reaped_after_interrupt": reaped,
                "remaining_after_sweep": remaining,
            })
            record["interruption"] = interruption
        return record

    # ---- modes -----------------------------------------------------------

    def _run_inprocess(
        self,
        module: Any,
        adapter_name: str,
        batch_id: str,
        index: int,
        run_scratch: Path,
        timeout_seconds: float,
    ) -> Dict[str, Any]:
        """One run through the real runner, in this process. Observed, not bounded."""

        run_id = "{}/run-{:03d}".format(batch_id, index)
        benchmark = TinyBenchmark(run_scratch)
        inputs_before = benchmark.inputs_template()
        fd_before = ev.fd_snapshot()
        children_before = ev.descendant_pids()
        rss_before = ev.rss_kb()
        sampler = ev.Sampler(self.limits.sample_interval_seconds, scratch_dir=run_scratch)
        sink = ev.CaptureSink(self.limits.capture_bytes)
        sampler.start()
        stdout_guard = _swap(sys, "stdout", sink)
        stderr_guard = _swap(sys, "stderr", sink)
        started = time.monotonic()
        failure: Optional[Dict[str, str]] = None
        predictions_digest: Any = None
        metrics: List[Any] = []
        try:
            report = real_runner.execute(benchmark, module.Adapter(), run_scratch, smoke=False)
            predictions_digest = report.output_digest
            metrics = [metric.to_wire() for metric in report.metrics]
        except BaseException as error:  # noqa: BLE001 - a failed run is evidence, not a crash of the study
            failure = {"kind": type(error).__name__, "detail": str(error)[:300]}
        finally:
            _swap(sys, "stdout", stdout_guard)
            _swap(sys, "stderr", stderr_guard)
        wall_seconds = time.monotonic() - started
        samples = sampler.stop()
        fd_after = ev.fd_snapshot()
        children_after = ev.descendant_pids()  # pre-sweep: what the run left
        reaped, remaining = self._sweep(run_id)
        scratch_files = ev.dir_file_count(run_scratch)
        shutil.rmtree(run_scratch, ignore_errors=True)
        self._log("{}: {} in {:.3f}s, reaped {}".format(
            run_id, "raised" if failure else "completed", wall_seconds,
            [entry["pid"] for entry in reaped]))
        return {
            "run_id": run_id,
            "index": index,
            "adapter": adapter_name,
            "mode": "inprocess",
            "requested_timeout_seconds": timeout_seconds,
            "wall_seconds": round(wall_seconds, 4),
            "output": {
                "status": "raised" if failure else "completed",
                "detail": (failure or {}).get("detail", ""),
                "predictions_digest": predictions_digest,
                "metrics": metrics,
            },
            "inputs": {"before": inputs_before, "after": benchmark.inputs_served()},
            "fds": {"before": fd_before, "after": fd_after, "source": "in-supervisor"},
            "children": {
                "before_count": len(children_before),
                "after": children_after,
                "reaped": reaped,
                "remaining_after_sweep": remaining,
            },
            "scratch": {"after": scratch_files, "removed_by_supervisor": True},
            "capture": sink.take(),
            "memory": {"rss_before_kb": rss_before, "rss_after_kb": ev.rss_kb()},
            "during_samples": samples[:40],
        }

    def _run_isolated(
        self,
        adapter_name: str,
        batch_id: str,
        index: int,
        run_scratch: Path,
        timeout_seconds: float,
    ) -> Dict[str, Any]:
        """One run inside cogbench.isolate's process boundary."""

        run_id = "{}/run-{:03d}".format(batch_id, index)
        children_before = ev.descendant_pids()
        sampler = ev.Sampler(self.limits.sample_interval_seconds, scratch_dir=run_scratch)
        sampler.start()
        started = time.monotonic()
        outcome = real_run_isolated(
            lambda: self._child_work(adapter_name, run_scratch),
            timeout_seconds=int(timeout_seconds),
            memory_bytes=self.limits.child_memory_bytes,
            scratch=run_scratch,
        )
        wall_seconds = time.monotonic() - started
        samples = sampler.stop()
        children_after = ev.descendant_pids()  # pre-sweep: what survived isolation
        reaped, remaining = self._sweep(run_id)
        scratch_files = ev.dir_file_count(run_scratch)
        shutil.rmtree(run_scratch, ignore_errors=True)
        child = outcome.value if outcome.status == "completed" and isinstance(outcome.value, dict) else {}
        child_output = child.get("output", {}) if isinstance(child, dict) else {}
        empty_fds = {"available": False, "count": None, "by_kind": {}, "targets": {}}
        self._log("{}: {} in {:.3f}s, reaped {}".format(
            run_id, outcome.status, wall_seconds, [entry["pid"] for entry in reaped]))
        return {
            "run_id": run_id,
            "index": index,
            "adapter": adapter_name,
            "mode": "isolated",
            "requested_timeout_seconds": timeout_seconds,
            "wall_seconds": round(wall_seconds, 4),
            "output": {
                "status": outcome.status,
                "detail": outcome.detail,
                "predictions_digest": child_output.get("predictions_digest"),
                "metrics": child_output.get("metrics", []),
            },
            "inputs": child.get("inputs", {"before": None, "after": None}),
            "fds": {
                "before": child.get("fds", {}).get("before", empty_fds),
                "after": child.get("fds", {}).get("after", empty_fds),
                "source": "in-child",
            },
            "children": {
                "before_count": len(children_before),
                "after": children_after,
                "reaped": reaped,
                "remaining_after_sweep": remaining,
            },
            "scratch": {"after": scratch_files, "removed_by_supervisor": True},
            "capture": child.get("capture", {
                "bytes": 0, "dropped_bytes": 0, "lines": 0, "overflowed": False, "head": ""}),
            "memory": {"child_rss_series_kb": [
                sample["rss_kb"] for sample in child.get("child_samples", [])
                if isinstance(sample, dict) and sample.get("rss_kb") is not None]},
            "during_samples": samples[:40],
            "isolate_diagnostics": outcome.diagnostics(),
        }

    def _child_work(self, adapter_name: str, workspace: Path) -> Dict[str, Any]:
        """Everything inside the forked child. Returns JSON-able evidence.

        The fixture adapter is loaded from file HERE, so the child's module
        lifecycle starts empty — this is the fresh-import condition a fresh
        process gives, which is the comparison point for every in-process
        sequence.
        """

        module = load_adapter_module(adapter_name)
        benchmark = TinyBenchmark(workspace)
        inputs_before = benchmark.inputs_template()
        fd_before = ev.fd_snapshot()
        child_sampler = ev.Sampler(self.limits.sample_interval_seconds, scratch_dir=workspace)
        child_sampler.start()
        sink = ev.CaptureSink(self.limits.capture_bytes)
        stdout_guard = _swap(sys, "stdout", sink)
        stderr_guard = _swap(sys, "stderr", sink)
        started = time.monotonic()
        failure: Optional[Dict[str, str]] = None
        predictions_digest: Any = None
        metrics: List[Any] = []
        try:
            report = real_runner.execute(benchmark, module.Adapter(), workspace, smoke=False)
            predictions_digest = report.output_digest
            metrics = [metric.to_wire() for metric in report.metrics]
        except BaseException as error:  # noqa: BLE001 - the child owns every failure
            failure = {"kind": type(error).__name__, "detail": str(error)[:300]}
        finally:
            _swap(sys, "stderr", stderr_guard)
            _swap(sys, "stdout", stdout_guard)
        wall_seconds = time.monotonic() - started
        samples = child_sampler.stop()
        return {
            "child_samples": samples[:40],
            "wall_seconds": round(wall_seconds, 4),
            "output": {
                "status": "raised" if failure else "completed",
                "detail": (failure or {}).get("detail", ""),
                "predictions_digest": predictions_digest,
                "metrics": metrics,
            },
            "inputs": {"before": inputs_before, "after": benchmark.inputs_served()},
            "fds": {"before": fd_before, "after": ev.fd_snapshot()},
            "capture": sink.take(),
        }

    # ---- baselines and sweeps -------------------------------------------

    def _fresh_baseline(self, adapter_name: str, timeout_seconds: Optional[float] = None) -> Dict[str, Any]:
        """One fresh-import run of an adapter in its own isolated child.

        The baseline predictions are what a clean lifecycle answers. A batch
        run whose predictions differ from this inherited state from somewhere.
        Adapters that cannot complete (the sleepers) return their isolate
        status instead of predictions, and drift is simply not measured for
        them. The timeout is the batch's own so a tightly-bounded batch is
        not kept waiting on a baseline that would outlive it.
        """

        if timeout_seconds is None:
            timeout_seconds = self.limits.run_timeout_seconds
        workspace = Path(tempfile.mkdtemp(prefix="ri-baseline-"))
        try:
            outcome = real_run_isolated(
                lambda: self._child_work(adapter_name, workspace),
                timeout_seconds=int(timeout_seconds),
                memory_bytes=self.limits.child_memory_bytes,
                scratch=workspace,
            )
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
        completed = outcome.status == "completed" and isinstance(outcome.value, dict)
        output_digest = outcome.value["output"]["predictions_digest"] if completed else None
        return {"status": outcome.status, "output_digest": output_digest}

    def _sweep(self, label: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Kill and reap every descendant of this process. Returns (reaped, remaining)."""

        found = ev.descendant_pids()
        reaped: List[Dict[str, Any]] = []
        for row in found:
            try:
                os.kill(row["pid"], signal.SIGKILL)
            except OSError:
                continue  # already gone
            reaped.append({"pid": row["pid"], "cmdline": row["cmdline"]})
        # Zombies of our own stay in /proc until waited on. Anything here is
        # a child the fixtures created and never reaped.
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            try:
                done, _status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break  # no children left at all
            if done == 0:
                time.sleep(0.01)
        remaining = ev.descendant_pids()
        if reaped:
            self._log("{}: reaped {} descendant(s), {} remain".format(
                label, len(reaped), len(remaining)))
        return reaped, remaining

    @staticmethod
    def _raise_sigint() -> None:
        os.kill(os.getpid(), signal.SIGINT)

    # ---- rollups ---------------------------------------------------------

    @staticmethod
    def _max_descendants(runs: List[Dict[str, Any]]) -> int:
        per_run_max = [
            max((sample["descendant_count"] for sample in run.get("during_samples", [])), default=0)
            for run in runs
        ]
        return max(per_run_max, default=0)

    @staticmethod
    def _max_scratch_files(runs: List[Dict[str, Any]]) -> int:
        max_per_run = [
            max((sample["scratch_files"] or 0 for sample in run.get("during_samples", [])), default=0)
            for run in runs
        ]
        return max(max_per_run, default=0)

    def _states(self, modules: Dict[str, Any]) -> Dict[str, Any]:
        return {alias: ev.module_fingerprints(module) for alias, module in sorted(modules.items())}

