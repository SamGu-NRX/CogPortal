"""Resolve every week 1 and week 2 corpus repository and print the bindings.

Discovery is a search, and a change meant to unblock week 3 can quietly move
what week 1 and week 2 bind to. Diffing this file's output before and after a
change is the only way to see that: the unit tests prove a primitive works,
and this proves nothing else moved.

    python tools/corpus_bindings.py > /tmp/before.json

Read-only. Each repository resolves in its own subprocess so one that dies
takes only its own line with it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / ".cache" / "student-repos"

#: (benchmark, week directory, repository directory, subdirectory within it).
#: rutvim holds three weeks in one repository, so its week is a subdirectory.
CASES = [
    ("audio-identification", "week1", "CogWorks-2026-Team-Asterisk__Week1-Capstone-Shazam", ""),
    ("audio-identification", "week1", "Cog-gurts__Shazam-Project", ""),
    ("audio-identification", "week1", "KrazeeCoder__week1-capstone-team4", ""),
    ("audio-identification", "week1", "carti4ce__week1_capstone", ""),
    ("audio-identification", "week1", "rutvim2009__BWSI_CogWorks_Team_1", ""),
    ("vision-clustering", "week2", "CogWorks-2026-Team-Asterisk__Week2-Capstone", ""),
    ("vision-clustering", "week2", "Cog-gurts__CoggurtFilter", ""),
    ("vision-clustering", "week2", "LashikaKapoor28__Vision_Module_Capstone", ""),
    ("vision-clustering", "week2", "BagelBreaker__week2_capstone", ""),
    ("vision-clustering", "week2", "rutvim2009__BWSI_CogWorks_Team_1", ""),
]


CHILD = r'''
import json, os, sys
from pathlib import Path

root = Path(sys.argv[1])
benchmark, week, repo = sys.argv[2], sys.argv[3], sys.argv[4]
sys.path.insert(0, str(root / "python" / "cogbench" / "src"))
sys.path.insert(0, str(root / "benchmarks" / week))

from cogbench.plugins import load_benchmark
from cogbench.resolve import from_spec

plugin = load_benchmark(benchmark)
spec = plugin.discovery()
found = from_spec(Path(repo).resolve(), spec, benchmark=benchmark)
record = found.to_dict()
# The interpreter's hash seed is a property of this process, not of the
# binding, and the point here is to compare bindings. Both keys are dropped
# so a run under a different environment still diffs cleanly.
record.pop("hashRandomization", None)
record.pop("hashSeed", None)
print(json.dumps(record, indent=1, sort_keys=True, default=repr))
'''


def main() -> int:
    out = {}
    for benchmark, week, name, _sub in CASES:
        repo = CORPUS / name
        key = "{}::{}".format(week, name)
        if not repo.is_dir():
            out[key] = {"absent": True}
            continue
        done = subprocess.run(
            [sys.executable, "-c", CHILD, str(ROOT), benchmark, week, str(repo)],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            env={**os.environ, "PYTHONHASHSEED": "0"},
        )
        if done.returncode != 0:
            out[key] = {"crashed": done.stderr.strip().splitlines()[-3:]}
            continue
        try:
            out[key] = json.loads(done.stdout)
        except json.JSONDecodeError:
            out[key] = {"unparseable": done.stdout[-400:]}
    print(json.dumps(out, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
