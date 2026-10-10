"""Witness: mutated_arrays - an adapter that edits its input arrays in place must be caught: the next run would otherwise consume a mutated input.

Run: python experiments/run-interference/witnesses/mutated_arrays.py.py

Runs the contaminated_all fixture through the real runner in-process and checks the
detector's mutated_arrays verdict. Exits 0 when the detector flags it, 1 otherwise.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import detector
from supervisor import Limits, RunSupervisor

SIGNAL = 'mutated_arrays'


def main() -> int:
    supervisor = RunSupervisor(limits=Limits(), log=lambda line: None)
    batch = supervisor.run_batch({
        "id": "witness-" + SIGNAL.replace("_", "-"),
        "mode": "inprocess",
        "adapters": ['contaminated_all'],
        "runs": 2,
        "concurrency": 1,
        "timeout_seconds": 10.0,
        "expect_flagged": ['mutated_arrays'],
        "purpose": "witness: mutated_arrays",
    })
    evaluation = detector.evaluate(batch["runs"], batch["limits"], batch["module_state_series"])
    flagged = evaluation["flagged_signals"]
    ok = SIGNAL in flagged
    print("witness {}: {} - flagged: {}".format(SIGNAL, "PASS" if ok else "FAIL", ", ".join(flagged) or "-"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
