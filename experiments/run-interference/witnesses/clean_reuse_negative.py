"""Witness: clean_reuse_negative - a clean adapter's bounded reuse must NOT be flagged: appropriate reuse is not contamination (negative control).

Run: python experiments/run-interference/witnesses/clean_reuse_negative.py.py

Runs the clean_reuse fixture through the real runner in-process and checks the
detector's clean_reuse_negative verdict. Exits 0 when nothing is flagged, 1 otherwise.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import detector
from supervisor import Limits, RunSupervisor

SIGNAL = 'clean_reuse_negative'


def main() -> int:
    supervisor = RunSupervisor(limits=Limits(), log=lambda line: None)
    batch = supervisor.run_batch({
        "id": "witness-" + SIGNAL.replace("_", "-"),
        "mode": "inprocess",
        "adapters": ['clean_reuse'],
        "runs": 2,
        "concurrency": 1,
        "timeout_seconds": 10.0,
        "expect_flagged": [],
        "purpose": "witness: clean_reuse_negative",
    })
    evaluation = detector.evaluate(batch["runs"], batch["limits"], batch["module_state_series"])
    flagged = evaluation["flagged_signals"]
    ok = flagged == []
    print("witness {}: {} - flagged: {}".format(SIGNAL, "PASS" if ok else "FAIL", ", ".join(flagged) or "-"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
