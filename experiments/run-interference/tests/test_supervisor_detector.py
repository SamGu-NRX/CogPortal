"""Integration tests: real fixture batches through the supervisor.

Every test here runs actual adapter code through the repo's real
``cogbench.runner.execute`` and — for isolated batches —
``cogbench.isolate.run_isolated``. The controls are the point: the
contaminated adapter MUST be flagged on every signal it leaks and the
clean adapter MUST NOT be flagged at all. A detector that stays silent on
the contaminated control, or cries on the clean one, fails here.

The answer evidence is the real runner's own ``output_digest`` (sha256 over
the predictions — the runner does not retain the payload), so drift means
"different answers", read from the field the runner itself records.
"""

from __future__ import annotations

import detector
from supervisor import ENFORCEMENT, Limits, RunSupervisor

CONTAMINATED_ALL = ["mutated_arrays", "module_globals", "unclosed_handles",
                    "leftover_children", "output_flooding"]


def evaluate_batch(batch):
    return detector.evaluate(batch["runs"], batch["limits"], batch["module_state_series"])


def flagged(batch):
    return set(evaluate_batch(batch)["flagged_signals"])


def finding(batch, signal):
    return {f["signal"]: f for f in evaluate_batch(batch)["findings"]}[signal]


def make_supervisor() -> RunSupervisor:
    return RunSupervisor(limits=Limits(), log=lambda line: None)


# ---- the contaminated control: every leak visible ------------------------

def test_contaminated_control_flagged():
    supervisor = make_supervisor()
    batch = supervisor.run_batch({
        "id": "test-contaminated", "mode": "inprocess",
        "adapters": ["contaminated_all"], "runs": 4, "concurrency": 1,
        "timeout_seconds": 10.0, "purpose": "contaminated control",
        "expect_flagged": CONTAMINATED_ALL,
    })
    assert flagged(batch) == set(CONTAMINATED_ALL), evaluate_batch(batch)["findings"]
    assert evaluate_batch(batch)["agrees_with_expectation"] is True

    # The leak must be visible in the evidence, not just the verdicts.
    mutated = finding(batch, "mutated_arrays")
    assert mutated["measured"]["mutated_runs"], "in-place input edits must be recorded"
    accumulation = finding(batch, "module_globals")
    accumulating = set(accumulation["measured"]["accumulating_names"])
    assert any("_CALL_LOG" in name for name in accumulating), sorted(accumulating)

    # Drift: contaminated answers grow an offset per run, so runs 2..4 must
    # disagree with the fresh-import baseline digest.
    drifted = accumulation["measured"]["drifted_runs"]
    assert len(drifted) >= 1

    # The supervisor reaped the abandoned sleep child and nothing survived.
    assert batch["supervision"]["remaining_after_sweep"] == []
    # Per-run sweeps do the reaping (the batch-level sweep only catches
    # stragglers), so the reaped entries live on the run records.
    assert any(entry["pid"]
               for run in batch["runs"]
               for entry in run["children"]["reaped"])
    # The leaked file handles were recorded as new open descriptors.
    handles = finding(batch, "unclosed_handles")
    assert any(entry["delta"] > 0 for entry in handles["measured"]["per_run"])
    # The flood: bytes stored plus dropped exceed the budget.
    flood = finding(batch, "output_flooding")
    assert flood["measured"]["flooded_runs"], "the print flood must be counted"


def test_clean_control_not_flagged():
    supervisor = make_supervisor()
    batch = supervisor.run_batch({
        "id": "test-clean", "mode": "inprocess",
        "adapters": ["clean_reuse"], "runs": 3, "concurrency": 1,
        "timeout_seconds": 10.0, "purpose": "clean control",
        "expect_clean": CONTAMINATED_ALL,
    })
    assert flagged(batch) == set(), evaluate_batch(batch)["findings"]
    assert evaluate_batch(batch)["agrees_with_expectation"] is True
    # And the run itself succeeded through the real runner: every run's
    # answer digest matches what a fresh import answered, and no run left
    # a descriptor open.
    baseline_digest = batch["baselines"]["clean_reuse"]["output_digest"]
    assert baseline_digest is not None
    assert all(run["output"]["status"] == "completed" for run in batch["runs"])
    assert all(run["output"]["predictions_digest"] == baseline_digest
               for run in batch["runs"])
    assert all(run["fds"]["after"]["count"] == run["fds"]["before"]["count"]
               for run in batch["runs"])


# ---- the cross-adapter case: a clean adapter inherits contamination ------

def test_mixed_order_clean_adapter_drifts():
    supervisor = make_supervisor()
    batch = supervisor.run_batch({
        "id": "test-mixed", "mode": "inprocess",
        "adapters": ["contaminated_all", "clean_reuse", "clean_reuse", "clean_reuse"],
        "runs": 4, "concurrency": 1, "timeout_seconds": 10.0,
        "purpose": "cross-adapter inheritance", "expect_flagged": ["module_globals"],
    })
    assert "module_globals" in flagged(batch)
    drift = finding(batch, "module_globals")["measured"]["drifted_runs"]
    assert drift, "the clean adapter's answers must move after contamination"
    assert all(entry["adapter"] == "clean_reuse" for entry in drift)
    # The contaminated run's other leaks are flagged too (this is the same
    # contaminated adapter); the lifecycle signal must survive mixing.
    assert "leftover_children" in flagged(batch)


# ---- concurrency ---------------------------------------------------------

def test_concurrent_clean_batch_stays_clean():
    supervisor = make_supervisor()
    batch = supervisor.run_batch({
        "id": "test-concurrent", "mode": "inprocess",
        "adapters": ["clean_reuse"], "runs": 4, "concurrency": 2,
        "timeout_seconds": 10.0, "purpose": "concurrent clean control",
    })
    assert flagged(batch) == set(), evaluate_batch(batch)["findings"]
    assert all(run["output"]["status"] == "completed" for run in batch["runs"])
    assert batch["counts"]["files"]["after_cleanup"]["count"] == 0
    assert batch["counts"]["processes"]["after"] == batch["counts"]["processes"]["before"]


# ---- isolated mode: what the process boundary contains -------------------

def test_isolated_contaminated_is_contained():
    """Inside the boundary the in-run leaks still show; the lifecycle leaks do not.

    The leak file and the fd delta are visible because the evidence comes
    from inside the child, but the accumulating module state and the child
    process are destroyed by the fresh import and the process-group
    cleanup: no cross-run signal survives.
    """

    supervisor = make_supervisor()
    batch = supervisor.run_batch({
        "id": "test-isolated-contaminated", "mode": "isolated",
        "adapters": ["contaminated_all"], "runs": 3, "concurrency": 1,
        "timeout_seconds": 10.0, "purpose": "isolation containment",
        "expect_flagged": ["mutated_arrays", "unclosed_handles", "output_flooding"],
    })
    signals = flagged(batch)
    assert {"mutated_arrays", "unclosed_handles", "output_flooding"} <= signals, \
        evaluate_batch(batch)["findings"]
    assert "module_globals" not in signals
    assert "leftover_children" not in signals
    # Every run answered exactly what a fresh import answers.
    baseline_digest = batch["baselines"]["contaminated_all"]["output_digest"]
    assert baseline_digest is not None
    assert all(run["output"]["predictions_digest"] == baseline_digest
               for run in batch["runs"])
    assert batch["counts"]["files"]["after_cleanup"]["count"] == 0


def test_isolated_clean_batch_not_flagged():
    supervisor = make_supervisor()
    batch = supervisor.run_batch({
        "id": "test-isolated-clean", "mode": "isolated",
        "adapters": ["clean_reuse"], "runs": 3, "concurrency": 1,
        "timeout_seconds": 10.0, "purpose": "isolated clean control",
    })
    assert flagged(batch) == set(), evaluate_batch(batch)["findings"]


# ---- the timeout path ------------------------------------------------------

def test_timeout_batch_kills_and_cleans():
    supervisor = make_supervisor()
    batch = supervisor.run_batch({
        "id": "test-timeout", "mode": "isolated",
        "adapters": ["slow_sleeper"], "runs": 2, "concurrency": 1,
        "timeout_seconds": 2.0, "purpose": "timeout enforcement",
    })
    assert batch["spec"]["timeout_seconds"] == 2.0
    assert len(batch["runs"]) == 2
    for run in batch["runs"]:
        assert run["output"]["status"] == "timed_out", run
        assert run["wall_seconds"] >= 2.0
        assert run["output"]["predictions_digest"] is None
    # The wall-clock kill left nothing behind.
    assert batch["supervision"]["remaining_after_sweep"] == []
    assert "leftover_children" not in flagged(batch)
    assert batch["counts"]["files"]["after_cleanup"]["count"] == 0


# ---- the interruption path -------------------------------------------------

def test_sigint_batch_records_interruption_and_cleans():
    supervisor = make_supervisor()
    batch = supervisor.run_batch({
        "id": "test-sigint", "mode": "isolated",
        "adapters": ["quick_sleeper"], "runs": 6, "concurrency": 1,
        "timeout_seconds": 10.0, "interrupt_after_seconds": 0.5,
        "purpose": "SIGINT mid-batch",
    })
    interruption = batch.get("interruption")
    assert interruption is not None, "the SIGINT batch must record its interruption"
    assert interruption["signal"] == "SIGINT"
    assert interruption["completed_runs"] < 6
    assert interruption["orphans_found"] == []
    assert interruption["remaining_after_sweep"] == []
    assert batch["supervision"]["remaining_after_sweep"] == []
    assert batch["counts"]["files"]["after_cleanup"]["count"] == 0


# ---- the enforcement matrix is carried on every batch ----------------------

def test_enforcement_matrix_recorded():
    supervisor = make_supervisor()
    batch = supervisor.run_batch({
        "id": "test-matrix", "mode": "isolated",
        "adapters": ["clean_reuse"], "runs": 1, "concurrency": 1,
        "timeout_seconds": 10.0, "purpose": "matrix",
    })
    assert batch["limits_enforcement"] == ENFORCEMENT["isolated"]
    assert batch["limits"]["flood_bytes"] == Limits().flood_bytes
