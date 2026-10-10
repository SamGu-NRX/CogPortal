"""Unit tests for the contamination detector, on synthetic evidence.

No fixture adapter runs here and no process is spawned: the detector is a
pure function of evidence dicts, so the unit tests build those dicts by
hand and check each signal's judgment in isolation, including the judgment
calls (initialization versus accumulation, noise tolerance on fd counts).
"""

from __future__ import annotations

from copy import deepcopy

import detector


def make_run(**overrides):
    """One run's evidence in the exact shape the supervisor records."""

    run = {
        "run_id": "unit/run-000",
        "index": 0,
        "adapter": "clean_reuse",
        "mode": "inprocess",
        "output": {"status": "completed", "detail": "",
                   "predictions": [6, 100, 25], "metrics": []},
        "inputs": {"before": [{"xs": [1], "n": 1}], "after": [{"xs": [1], "n": 1}]},
        "fds": {
            "before": {"available": True, "count": 9, "by_kind": {"file": 9},
                       "targets": {"0": "/dev/null"}},
            "after": {"available": True, "count": 9, "by_kind": {"file": 9},
                      "targets": {"0": "/dev/null"}},
        },
        "children": {"before_count": 0, "after": [], "reaped": [],
                     "remaining_after_sweep": []},
        "capture": {"bytes": 5, "dropped_bytes": 0, "lines": 1,
                    "overflowed": False, "head": "ok\n"},
        "baseline_predictions": [6, 100, 25],
        "expect_flagged": [],
        "expect_clean": [],
    }
    for key, value in overrides.items():
        run[key] = value
    return run


def make_batch(runs, series=None, flood_bytes=128 * 1024,
               expect_flagged=(), expect_clean=()):
    # The supervisor stamps the batch's expectations onto every run record
    # and evaluate() reads them from there; mirror that shape exactly.
    for run in runs:
        run["expect_flagged"] = list(expect_flagged)
        run["expect_clean"] = list(expect_clean)
    return {
        "batch_id": "unit",
        "spec": {"id": "unit", "mode": "inprocess",
                 "adapters": [run["adapter"] for run in runs],
                 "runs": len(runs), "concurrency": 1, "timeout_seconds": 10.0,
                 "purpose": "unit test"},
        "limits": {"flood_bytes": flood_bytes},
        "runs": runs,
        "module_state_series": series or [],
        "expect_flagged": list(expect_flagged),
        "expect_clean": list(expect_clean),
    }


def evaluate(batch):
    return detector.evaluate(batch["runs"], batch["limits"], batch["module_state_series"])


def flagged_signals(batch):
    return set(evaluate(batch)["flagged_signals"])


def fingerprint(kind="dict", size=1, digest="d1"):
    return {"kind": kind, "size": size, "digest": digest}


def series_of(states_per_snapshot):
    """Snapshots from [(label, {module: {name: fingerprint}}), ...]."""

    return [{"label": label, "states": states} for label, states in states_per_snapshot]


# ---- mutated arrays ------------------------------------------------------

def test_mutated_inputs_flagged():
    run = make_run(inputs={"before": [{"xs": [1, 2], "n": 2}],
                           "after": [{"xs": [1, 2, 2], "n": 3}]})
    batch = make_batch([run], expect_flagged=["mutated_arrays"])
    assert "mutated_arrays" in flagged_signals(batch)
    assert evaluate(batch)["agrees_with_expectation"] is True


def test_clean_inputs_not_flagged():
    batch = make_batch([make_run(), make_run()])
    assert "mutated_arrays" not in flagged_signals(batch)


# ---- module globals ------------------------------------------------------

def test_module_accumulation_flagged():
    """A name whose digest keeps changing between post-run snapshots accumulates."""

    states = [
        ("before", {"adapter": {"DATA": fingerprint(digest="d0")}}),
        ("after_run_000", {"adapter": {"DATA": fingerprint(digest="d1")}}),
        ("after_run_001", {"adapter": {"DATA": fingerprint(digest="d2")}}),
        ("after_run_002", {"adapter": {"DATA": fingerprint(digest="d3")}}),
    ]
    batch = make_batch([make_run() for _ in range(3)], series_of(states))
    finding = {f["signal"]: f for f in evaluate(batch)["findings"]}["module_globals"]
    assert finding["flagged"] is True
    assert "adapter/DATA" in finding["measured"]["accumulating_names"]


def test_module_initialization_not_flagged():
    """State that fills on the first run and then holds is the clean shape."""

    states = [
        ("before", {"adapter": {"DATA": fingerprint(digest="d_empty")}}),
        ("after_run_000", {"adapter": {"DATA": fingerprint(digest="d_full")}}),
        ("after_run_001", {"adapter": {"DATA": fingerprint(digest="d_full")}}),
        ("after_run_002", {"adapter": {"DATA": fingerprint(digest="d_full")}}),
    ]
    batch = make_batch([make_run() for _ in range(3)], series_of(states))
    finding = {f["signal"]: f for f in evaluate(batch)["findings"]}["module_globals"]
    assert finding["flagged"] is False
    assert finding["measured"]["initialized_names"] == {"adapter/DATA": ["d_empty", "d_full"]}


def test_prediction_drift_flagged():
    """A run answering differently from its fresh-import baseline inherited state."""

    run = make_run(output={"status": "completed", "detail": "",
                           "predictions_digest": "digest-drifted", "metrics": []},
                   baseline_output_digest="digest-run")
    batch = make_batch([run])
    assert "module_globals" in flagged_signals(batch)


def test_prediction_drift_skipped_without_baseline():
    """No baseline (a sleeper adapter) means no drift claim, not a false one."""

    run = make_run(output={"status": "timed_out", "detail": "wall clock",
                           "predictions_digest": None, "metrics": []},
                   baseline_output_digest=None)
    batch = make_batch([run])
    assert "module_globals" not in flagged_signals(batch)


# ---- unclosed handles ----------------------------------------------------

def test_unclosed_handles_flagged():
    fds_after = {"available": True, "count": 12, "by_kind": {"file": 12},
                 "targets": {"0": "/dev/null", "11": "/tmp/leak.txt", "12": "/tmp/leak2.txt"}}
    run = make_run(fds={"before": {"available": True, "count": 9, "by_kind": {"file": 9},
                                   "targets": {"0": "/dev/null"}},
                        "after": fds_after})
    batch = make_batch([run])
    finding = {f["signal"]: f for f in evaluate(batch)["findings"]}["unclosed_handles"]
    assert finding["flagged"] is True
    assert finding["measured"]["per_run"][0]["delta"] == 3


def test_unclosed_handles_stable_not_flagged():
    batch = make_batch([make_run(), make_run(), make_run()])
    assert "unclosed_handles" not in flagged_signals(batch)


def test_unclosed_handles_absent_counts_not_flagged():
    """Platforms without /proc self-report the gap instead of a verdict."""

    no_fd = {"available": False, "count": None, "by_kind": {}, "targets": {}}
    run = make_run(fds={"before": no_fd, "after": no_fd})
    batch = make_batch([run])
    finding = {f["signal"]: f for f in evaluate(batch)["findings"]}["unclosed_handles"]
    assert finding["flagged"] is False
    assert "not measurable" in finding["detail"]

def test_unclosed_handles_pseudo_fs_targets_not_flagged():
    """A new /proc descriptor is the harness's own transient read, not a leak."""

    fds_after = {"available": True, "count": 10, "by_kind": {"file": 10},
                 "targets": {"0": "/dev/null", "9": "/proc/4882/stat"}}
    run = make_run(fds={"before": {"available": True, "count": 9, "by_kind": {"file": 9},
                                   "targets": {"0": "/dev/null"}},
                        "after": fds_after})
    batch = make_batch([run])
    finding = {f["signal"]: f for f in evaluate(batch)["findings"]}["unclosed_handles"]
    assert finding["flagged"] is False
    assert finding["measured"]["transient"], "the jitter must be recorded, not hidden"


def test_unclosed_handles_count_jitter_without_new_targets_not_flagged():
    """A count moving with no new path is snapshot jitter, not a leak."""

    fds_after = {"available": True, "count": 10, "by_kind": {"file": 10},
                 "targets": {"0": "/dev/null", "9": "/tmp/workdir/data.bin"}}
    run = make_run(fds={"before": {"available": True, "count": 9, "by_kind": {"file": 9},
                                   "targets": {"0": "/dev/null", "12": "/tmp/workdir/data.bin"}},
                        "after": fds_after})
    batch = make_batch([run])
    finding = {f["signal"]: f for f in evaluate(batch)["findings"]}["unclosed_handles"]
    assert finding["flagged"] is False




def test_unclosed_handles_pseudo_fs_root_and_sentinel_not_flagged():
    """Bare pseudo-fs roots and the vanish-race sentinel are not leaked handles."""

    fds_after = {"available": True, "count": 12, "by_kind": {"file": 12},
                 "targets": {"0": "/dev/null", "5": "/proc", "9": "unreadable"}}
    run = make_run(fds={"before": {"available": True, "count": 9, "by_kind": {"file": 9},
                                   "targets": {"0": "/dev/null"}},
                        "after": fds_after})
    batch = make_batch([run])
    finding = {f["signal"]: f for f in evaluate(batch)["findings"]}["unclosed_handles"]
    assert finding["flagged"] is False
    assert finding["measured"]["transient"], "the kernel-owned targets must be recorded, not hidden"


# ---- leftover children ---------------------------------------------------

def test_leftover_children_flagged_with_reap_record():
    run = make_run(children={
        "before_count": 0,
        "after": [{"pid": 4242, "ppid": 99, "cmdline": "sleep 5"}],
        "reaped": [{"pid": 4242, "cmdline": "sleep 5"}],
        "remaining_after_sweep": [],
    })
    batch = make_batch([run])
    finding = {f["signal"]: f for f in evaluate(batch)["findings"]}["leftover_children"]
    assert finding["flagged"] is True
    assert finding["measured"]["leftovers"][0]["pid"] == 4242
    assert finding["measured"]["reaped_by_supervisor"][0]["pid"] == 4242


def test_no_leftover_children_not_flagged():
    batch = make_batch([make_run(), make_run()])
    assert "leftover_children" not in flagged_signals(batch)


# ---- output flooding -----------------------------------------------------

def test_output_flood_flagged():
    run = make_run(capture={"bytes": 256 * 1024, "dropped_bytes": 900 * 1024,
                            "lines": 30000, "overflowed": True, "head": "flood line"})
    batch = make_batch([run], flood_bytes=128 * 1024)
    assert "output_flooding" in flagged_signals(batch)


def test_output_within_budget_not_flagged():
    run = make_run(capture={"bytes": 100, "dropped_bytes": 0, "lines": 3,
                            "overflowed": False, "head": "ok\n"})
    batch = make_batch([run])
    assert "output_flooding" not in flagged_signals(batch)


def test_output_flood_flagged_even_below_stored_cap():
    """Dropped bytes count: a flood is a flood whether it was stored or not."""

    run = make_run(capture={"bytes": 100, "dropped_bytes": 500 * 1024, "lines": 30000,
                            "overflowed": True, "head": ""})
    batch = make_batch([run], flood_bytes=128 * 1024)
    assert "output_flooding" in flagged_signals(batch)


# ---- expectation rollup --------------------------------------------------

def test_expectation_rollup_agreement():
    run = make_run(capture={"bytes": 256 * 1024, "dropped_bytes": 0, "lines": 30000,
                            "overflowed": False, "head": ""})
    batch = make_batch([run], flood_bytes=128 * 1024, expect_flagged=["output_flooding"])
    evaluation = evaluate(batch)
    assert evaluation["agrees_with_expectation"] is True
    assert evaluation["flagged_signals"] == ["output_flooding"]


def test_expectation_rollup_mismatch():
    batch = make_batch([make_run()], expect_flagged=["leftover_children"])
    assert evaluate(batch)["agrees_with_expectation"] is False


def test_unit_suite_uses_copy_safe_helpers():
    """Guard against a helper bug where overrides share nested state."""

    first = make_run()
    second = make_run()
    first["inputs"]["after"][0]["xs"].append(9)
    assert second["inputs"]["after"][0]["xs"] == [1]
    assert deepcopy(first)["inputs"]["after"] != first["inputs"]["before"]
