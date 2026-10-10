"""Tests for the digest-identity answer-agreement check.

The earlier sequential-versus-concurrent comparison counted DISTINCT
digests, so two different constant answers (X once in one leg, Y once in
the other) both read as 'no spread' and passed as identical. These tests
pin the strengthened comparison: actual digests must agree for every
matched adapter/input identity, the different-answer control must diverge
through the real supervisor, and a replay whose recorded verdict no longer
re-derives from the artifacts must FAIL.
"""

from __future__ import annotations

import hashlib
import json

import detector
import run as run_module
from supervisor import Limits, RunSupervisor


def make_answer_run(adapter, digest, inputs=None, run_id="unit/run-000"):
    """A minimal run record carrying an answer (digest) and its question."""

    return {
        "run_id": run_id,
        "adapter": adapter,
        "inputs": inputs if inputs is not None else {
            "before": [{"n": 1, "xs": [1]}],
            "after": [{"n": 1, "xs": [1]}],
        },
        "output": {"status": "completed", "detail": "", "predictions": [],
                   "metrics": [], "predictions_digest": digest},
        "fds": {"before": {"available": True, "count": 9, "by_kind": {"file": 9},
                           "targets": {"0": "/dev/null"}},
                "after": {"available": True, "count": 9, "by_kind": {"file": 9},
                          "targets": {"0": "/dev/null"}}},
        "children": {"before_count": 0, "after": [], "reaped": [],
                     "remaining_after_sweep": []},
        "capture": {"bytes": 0, "dropped_bytes": 0, "lines": 0,
                    "overflowed": False, "head": ""},
    }


def test_different_constant_answers_fail():
    # The reported trap: one distinct digest per leg (1 == 1) passed the old
    # count-based check even though the answers differ. Identity comparison
    # must fail it.
    sequential = [make_answer_run("clean_reuse", "a" * 64, run_id="s/0")]
    concurrent = [make_answer_run("clean_reuse", "b" * 64, run_id="c/0")]
    comparison = run_module.compare_batch_answers(sequential, concurrent)
    assert comparison["verdict"] == "differs"
    assert comparison["matched_identities"]
    assert not comparison["matched_identities"][0]["agree"]


def test_same_constant_answers_agree():
    digest = "a" * 64
    sequential = [make_answer_run("clean_reuse", digest, run_id="s/0")]
    concurrent = [make_answer_run("clean_reuse", digest, run_id="c/0"),
                  make_answer_run("clean_reuse", digest, run_id="c/1")]
    comparison = run_module.compare_batch_answers(sequential, concurrent)
    assert comparison["verdict"] == "identical"
    assert all(row["agree"] for row in comparison["matched_identities"])


def test_scratch_paths_are_not_identity():
    # Each run gets its own workspace tempdir; the same logical cases must
    # match regardless of where the scratch landed.
    inputs_a = {"before": [{"n": 1, "xs": [1], "workspace": "/tmp/ri-a/run-000"}],
                "after": [{"n": 1, "xs": [1], "workspace": "/tmp/ri-a/run-000"}]}
    inputs_b = {"before": [{"n": 1, "xs": [1], "workspace": "/tmp/ri-b/run-000"}],
                "after": [{"n": 1, "xs": [1], "workspace": "/tmp/ri-b/run-000"}]}
    comparison = run_module.compare_batch_answers(
        [make_answer_run("clean_reuse", "a" * 64, inputs=inputs_a)],
        [make_answer_run("clean_reuse", "a" * 64, inputs=inputs_b)])
    assert comparison["verdict"] == "identical"


def test_mutated_after_state_keeps_identity():
    # A mutating adapter changes the 'after' snapshot, not the question that
    # was asked; the 'before' state is the identity.
    inputs_mutated = {"before": [{"n": 1, "xs": [1]}],
                      "after": [{"n": 1, "xs": [999]}]}
    inputs_clean = {"before": [{"n": 1, "xs": [1]}],
                    "after": [{"n": 1, "xs": [1]}]}
    comparison = run_module.compare_batch_answers(
        [make_answer_run("mutator", "a" * 64, inputs=inputs_mutated)],
        [make_answer_run("mutator", "a" * 64, inputs=inputs_clean)])
    assert comparison["verdict"] == "identical"


def test_missing_digests_are_not_answers():
    # Timed-out or failed runs carry no digest; two such runs do not
    # constitute an agreement.
    sequential = [make_answer_run("clean_reuse", "", run_id="s/0")]
    concurrent = [make_answer_run("clean_reuse", "", run_id="c/0")]
    comparison = run_module.compare_batch_answers(sequential, concurrent)
    assert comparison["verdict"] == "no-shared-identities"


def test_no_shared_identity_is_not_agreement():
    comparison = run_module.compare_batch_answers(
        [make_answer_run("adapter_a", "a" * 64)],
        [make_answer_run("adapter_b", "a" * 64)])
    assert comparison["verdict"] == "no-shared-identities"


def test_mode_variant_control_diverges_through_supervisor():
    # Integration: the different-answer control through the real supervisor.
    # Both legs are clean to the detector (the fixture leaks nothing), yet
    # the same adapter with the same inputs must produce different constant
    # answers under concurrency 1 and 2 — and the comparison must say so.
    supervisor = RunSupervisor(limits=Limits(), log=lambda line: None)
    spec = {"id": "witness-control", "mode": "inprocess",
            "adapters": ["mode_variant"], "runs": 1, "concurrency": 1,
            "timeout_seconds": 10.0, "expect_flagged": []}
    seq_batch = supervisor.run_batch(dict(spec, concurrency=1))
    conc_batch = supervisor.run_batch(dict(spec, concurrency=2, id="witness-control-conc"))
    for batch in (seq_batch, conc_batch):
        evaluation = detector.evaluate(batch["runs"], batch["limits"],
                                       batch["module_state_series"])
        assert evaluation["flagged_signals"] == []
    comparison = run_module.compare_batch_answers(seq_batch["runs"], conc_batch["runs"])
    assert comparison["verdict"] == "differs"


def test_build_answer_agreements_matches_expectations():
    digest = "a" * 64
    records = {
        "seq-clean": {"runs": [make_answer_run("clean_reuse", digest, run_id="s/0")]},
        "conc-clean": {"runs": [make_answer_run("clean_reuse", digest, run_id="c/0")]},
        "seq-ctrl": {"runs": [make_answer_run("mode_variant", digest, run_id="s/1")]},
        "conc-ctrl": {"runs": [make_answer_run("mode_variant", "b" * 64, run_id="c/1")]},
    }
    pairs = [
        {"id": "clean", "sequential": "seq-clean", "concurrent": "conc-clean",
         "expect": "identical"},
        {"id": "different-answer-control", "sequential": "seq-ctrl",
         "concurrent": "conc-ctrl", "expect": "differs"},
    ]
    rows = run_module.build_answer_agreements(pairs, records)
    assert [row["verdict"] for row in rows] == ["identical", "differs"]
    assert all(row["agrees_with_expectation"] for row in rows)


def _write_batch_artifact(run_dir, batch_id, runs):
    batch = {
        "batch_id": batch_id,
        "spec": {"id": batch_id, "mode": "inprocess", "adapters": [], "runs": len(runs),
                 "concurrency": 1, "timeout_seconds": 10.0, "purpose": "replay test"},
        "limits": {"flood_bytes": 131072},
        "runs": runs,
        "module_state_series": [],
        "counts": {"processes": {"before": 0, "during_max": 0, "after": 0},
                   "files": {"before": 0, "after": 0, "after_cleanup": 0},
                   "fds": {}},
        "supervision": {"reaped": [], "remaining_after_sweep": []},
    }
    path = run_dir / "batch-{}.json".format(batch_id)
    path.write_text(json.dumps(batch, indent=1, sort_keys=True), encoding="utf-8")
    return path


def _write_summary(run_dir, recorded_verdict, recorded_agrees):
    batches = []
    for batch_id, digest in (("control-seq", "a" * 64), ("control-conc", "b" * 64)):
        artifact = "batch-{}.json".format(batch_id)
        batch_path = run_dir / artifact
        runs = [make_answer_run("mode_variant", digest, run_id=batch_id + "/0")]
        _write_batch_artifact(run_dir, batch_id, runs)
        batches.append({"id": batch_id, "artifact": artifact,
                        "artifact_sha256": hashlib.sha256(batch_path.read_bytes()).hexdigest(),
                        "flagged_signals": [], "agrees_with_expectation": True})
    summary = {
        "batches": batches,
        "answer_agreements": [{
            "id": "different-answer-control",
            "sequential": "control-seq", "concurrent": "control-conc",
            "verdict": recorded_verdict, "expect": recorded_verdict,
            "agrees_with_expectation": recorded_agrees,
        }],
    }
    summary_path = run_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=1, sort_keys=True), encoding="utf-8")


def test_replay_fails_when_recorded_verdict_stale(tmp_path):
    # A recorded 'identical' verdict that the artifacts contradict must fail
    # the replay agreement check — the exact hole the distinct-count
    # comparison left open.
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_summary(run_dir, recorded_verdict="identical", recorded_agrees=True)
    assert run_module.replay_results(run_dir) == 1
    replay = json.loads((run_dir / "replay.json").read_text(encoding="utf-8"))
    assert replay["all_match"] is False
    assert replay["answer_agreements"][0]["derived_verdict"] == "differs"
    assert replay["answer_agreements"][0]["matches"] is False


def test_replay_passes_when_recorded_verdict_honest(tmp_path):
    # The same artifacts recorded honestly as 'differs' re-derive and agree.
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    _write_summary(run_dir, recorded_verdict="differs", recorded_agrees=True)
    assert run_module.replay_results(run_dir) == 0
    replay = json.loads((run_dir / "replay.json").read_text(encoding="utf-8"))
    assert replay["all_match"] is True
    assert replay["answer_agreements"][0]["matches"] is True
