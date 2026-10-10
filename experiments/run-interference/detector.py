"""The contamination detector: five pure checks over saved evidence.

Every check takes the evidence dicts the supervisor records and returns a
finding. No check imports the adapters, touches the filesystem, or looks at
a process: the same functions judge live evidence in ``run.py`` and saved
artifacts in replay, which is what makes replay a re-derivation rather than
a re-run.

The one judgment call the detector makes everywhere: state that appears once
and then holds is *initialization or appropriate reuse*; state that keeps
changing after the first run is *accumulation*, and accumulation is the leak.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from evidence import SIGNALS

__all__ = ["Finding", "check_mutated_arrays", "check_module_globals", "check_unclosed_handles",
           "check_leftover_children", "check_output_flooding", "evaluate"]

#: Descriptor targets under these prefixes are harness/kernel artifacts (the
#: sampler and the process scan hold /proc and /sys reads at snapshot time),
#: not handles an adapter opened. Only new targets on real paths count as
#: leaks; count jitter with no new real path is recorded as transient noise.
_PSEUDO_FS_PREFIXES = ("/proc/", "/sys/", "/dev/")


@dataclass(frozen=True)
class Finding:
    """One signal's verdict over one batch of runs."""

    signal: str
    flagged: bool
    detail: str
    measured: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {"signal": self.signal, "flagged": self.flagged, "detail": self.detail,
                "measured": self.measured}


def check_mutated_arrays(runs: List[Dict[str, Any]]) -> Finding:
    """Inputs handed to a run must come back byte-identical.

    The runner passes case inputs to the adapter by reference; an adapter
    that sorts or appends in place edits every later reader's data. Evidence
    is the template snapshot the benchmark kept versus the served list after
    the run.
    """

    mutated: List[Dict[str, Any]] = []
    for run in runs:
        before = run["inputs"]["before"]
        after = run["inputs"]["after"]
        if before != after:
            mutated.append({
                "run_id": run["run_id"],
                "before": before,
                "after": after,
            })
    return Finding(
        signal="mutated_arrays",
        flagged=bool(mutated),
        detail=("inputs changed in place during runs: " + ", ".join(m["run_id"] for m in mutated))
        if mutated else "inputs identical before and after every run",
        measured={"mutated_runs": mutated},
    )


def check_module_globals(
    runs: List[Dict[str, Any]],
    module_state_series: List[Dict[str, Any]],
) -> Finding:
    """Module-level state must hold still after its first run completes.

    The evidence is a series of namespace snapshots taken at batch scope:
    once before the first run, once after each run. A name whose fingerprint
    differs between two post-run snapshots accumulated during runs, and the
    next run inherits it. Predictions on identical inputs that drift from
    the run's own fresh-import baseline are the behavioral face of the same
    leak — including the cross-adapter case, where the drifted run is a
    clean adapter inheriting a previous adapter's leftovers through shared
    state.
    """

    series = module_state_series
    # Per name: fingerprint observed at each snapshot position, absence as
    # None. Position 0 is the pre-run snapshot; the judgment uses only the
    # post-run positions, because state that initializes on the first run
    # and then holds is the designed clean shape.
    observed: Dict[str, Dict[int, str]] = {}
    for position, snapshot in enumerate(series):
        for module_name, state in snapshot["states"].items():
            for key, fp in state.items():
                digest = fp.get("digest") if isinstance(fp, dict) else None
                value = digest if digest is not None else fp.get("kind", "?")
                observed.setdefault("{}/{}".format(module_name, key), {})[position] = value
    accumulating: Dict[str, List[str]] = {}
    initialized: Dict[str, List[str]] = {}
    for name, observations in observed.items():
        post_run = [observations.get(position) for position in range(1, len(series))]
        if len(set(post_run)) > 1:
            accumulating[name] = post_run
        elif observations.get(0) is not None and post_run and observations[0] != post_run[0]:
            # Changed once, between the pre-run snapshot and the first run's
            # end, then held: initialization, recorded but not flagged.
            initialized[name] = [observations[0], post_run[0]]
    drifted: List[Dict[str, Any]] = []
    for run in runs:
        baseline = run.get("baseline_output_digest")
        digest = run["output"].get("predictions_digest")
        if baseline is not None and digest is not None and digest != baseline:
            drifted.append({"run_id": run["run_id"], "adapter": run.get("adapter"),
                            "predictions_digest": digest, "baseline_digest": baseline})
    flagged = bool(accumulating) or bool(drifted)
    if not series:
        detail = ("no in-process module lifecycle observed (every run imported fresh in its "
                  "own process); only the prediction-drift check applies")
    else:
        detail_parts: List[str] = []
        if accumulating:
            detail_parts.append("module state kept changing between post-run snapshots: "
                                + ", ".join(sorted(accumulating)))
        if drifted:
            detail_parts.append("predictions on identical inputs drift from the fresh-import baseline: "
                                + ", ".join(d["run_id"] for d in drifted))
        detail = "; ".join(detail_parts) if detail_parts else \
            "module state stable after initialization; predictions match the fresh-import baseline"
    return Finding(
        signal="module_globals",
        flagged=flagged,
        detail=detail,
        measured={"accumulating_names": accumulating, "initialized_names": initialized,
                  "drifted_runs": drifted, "snapshot_count": len(series)},
    )


def check_unclosed_handles(runs: List[Dict[str, Any]]) -> Finding:
    """Descriptors a run opens must be gone when the run ends.

    The judgment is target-based: a run leaked a handle when the post-run
    descriptor table contains a target on a real path that was not open
    before the run (a leaked workspace file, a socket). Counts alone are
    noise-prone — the harness's own sampler and process scan transiently
    hold /proc descriptors at snapshot time — so count-only jitter is
    recorded as transient, not flagged. In isolated mode the snapshots come
    from inside the child, so the finding names a leak that the process
    boundary then destroys with the child — contained, but real.
    """

    per_run: List[Dict[str, Any]] = []
    leaked: List[Dict[str, Any]] = []
    transient: List[Dict[str, Any]] = []
    after_counts: List[int] = []
    for run in runs:
        fds = run["fds"]
        before = fds["before"]["count"]
        after = fds["after"]["count"]
        if before is None or after is None:
            return Finding(
                signal="unclosed_handles",
                flagged=False,
                detail="fd counts unavailable on this platform; signal not measurable",
                measured={},
            )
        after_counts.append(after)
        delta = after - before
        new_targets = sorted(set(fds["after"]["targets"].values())
                             - set(fds["before"]["targets"].values()))
        # Pseudo-filesystem reads are the harness's own (the sampler and the
        # process scan hold /proc and /sys handles at snapshot time); only a
        # descriptor a run opens onto a real path is a leak. Count jitter
        # with no new path is the same noise wearing a different sign.
        leaked_targets = [t for t in new_targets
                          if not t.startswith(_PSEUDO_FS_PREFIXES)]
        entry = {"run_id": run["run_id"], "before": before, "after": after,
                 "delta": delta, "new_targets": new_targets[:8],
                 "leaked_targets": leaked_targets[:8]}
        if leaked_targets:
            leaked.append(entry)
        elif delta != 0:
            transient.append(entry)
        per_run.append(entry)
    spread = (max(after_counts) - min(after_counts)) if after_counts else 0
    flagged = bool(leaked)
    if flagged:
        detail = "descriptors left open onto real paths: " + ", ".join(
            "{} -> {}".format(r["run_id"], ",".join(r["leaked_targets"]))
            for r in leaked)
    else:
        detail = ("no descriptors left open onto real paths"
                  + ("; count jitter on pseudo-fs handles only (transient harness reads)"
                     if transient else "")
                  + "; after-counts spread {} over the batch".format(spread))
    return Finding(
        signal="unclosed_handles",
        flagged=flagged,
        detail=detail,
        measured={"per_run": per_run, "leaked": leaked, "transient": transient,
                  "after_counts": after_counts, "spread": spread},
    )


def check_leftover_children(runs: List[Dict[str, Any]]) -> Finding:
    """A run's child processes must not outlive the run.

    The after-scan is the parent's process tree taken before the supervisor
    reaps anything: any descendant still there when the runner returned was
    left behind by the run. The supervisor's reap record rides in the same
    evidence, so the finding can say what was cleaned up.
    """

    leftovers: List[Dict[str, Any]] = []
    reaped: List[Dict[str, Any]] = []
    for run in runs:
        for child in run["children"]["after"]:
            leftovers.append({"run_id": run["run_id"], **child})
        for entry in run["children"].get("reaped", []):
            if isinstance(entry, dict):
                reaped.append({"run_id": run["run_id"], "pid": entry.get("pid"),
                               "cmdline": entry.get("cmdline", "")})
            else:
                reaped.append({"run_id": run["run_id"], "pid": entry, "cmdline": ""})
    return Finding(
        signal="leftover_children",
        flagged=bool(leftovers),
        detail=("descendants still alive when runs returned: " + ", ".join(
            "{} pid {} ({})".format(l["run_id"], l["pid"], l["cmdline"] or "unknown")
            for l in leftovers)) if leftovers
        else "no descendant survived a run",
        measured={"leftovers": leftovers, "reaped_by_supervisor": reaped},
    )


def check_output_flooding(runs: List[Dict[str, Any]], flood_bytes: int) -> Finding:
    """A run's output must stay inside the flood budget.

    The capture cap makes the measurement safe, not the adapter legal: once
    bytes exceed the budget the run is flagged, whether the sink dropped the
    excess or the process boundary did.
    """

    flooded: List[Dict[str, Any]] = []
    for run in runs:
        capture = run["capture"]
        total = capture["bytes"] + capture.get("dropped_bytes", 0)
        if total > flood_bytes or capture.get("overflowed"):
            flooded.append({
                "run_id": run["run_id"],
                "bytes": capture["bytes"],
                "dropped_bytes": capture.get("dropped_bytes", 0),
                "lines": capture["lines"],
                "head": capture.get("head", "")[:200],
            })
    return Finding(
        signal="output_flooding",
        flagged=bool(flooded),
        detail=("output beyond the {}-byte flood budget: ".format(flood_bytes) + ", ".join(
            "{} ({} bytes + {} dropped, {} lines)".format(
                f["run_id"], f["bytes"], f["dropped_bytes"], f["lines"]) for f in flooded))
        if flooded else "every run stayed inside the flood budget",
        measured={"flooded_runs": flooded, "flood_bytes": flood_bytes},
    )


def evaluate(
    runs: List[Dict[str, Any]],
    limits: Dict[str, Any],
    module_state_series: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """All five findings for one batch, plus the expected-verdict rollup.

    This is the entry point both live runs and replay call. The expected
    verdict states what the manifest promised for this batch so the summary
    can compare promise against measurement instead of leaving the reading
    to the person reading the JSON.
    """

    findings = [
        check_mutated_arrays(runs),
        check_module_globals(runs, module_state_series or []),
        check_unclosed_handles(runs),
        check_leftover_children(runs),
        check_output_flooding(runs, int(limits["flood_bytes"])),
    ]
    flagged = sorted({finding.signal for finding in findings if finding.flagged})
    expected_flag = sorted({signal for run in runs for signal in run.get("expect_flagged", [])})
    expected_clean = sorted({signal for run in runs for signal in run.get("expect_clean", [])})
    return {
        "findings": [finding.to_dict() for finding in findings],
        "flagged_signals": flagged,
        "expected_flagged": expected_flag,
        "expected_clean": expected_clean,
        "agrees_with_expectation": flagged == expected_flag,
    }
