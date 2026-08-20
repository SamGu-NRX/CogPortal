"""Run every Python suite, and say plainly when one could not run at all.

`pnpm test:python` chained the suites with `&&` under whatever `python3`
resolves to. On a machine without numpy that meant five runner tests raised
ImportError, which unittest counts as errors rather than failures, and the
whole thing still needed someone to read the count to notice. A suite that
cannot import what it tests has not passed.

So this refuses to start when a suite's requirements are missing, and names
what to install. An interpreter is a normal thing to have wrong, and the fix
is one line; being told which line is the whole job here.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: Each suite, and what it must be able to import before it means anything.
SUITES = (
    ("cogbench", ["-m", "unittest", "discover", "-s", "python/cogbench/tests", "-p", "test_*.py"], ()),
    (
        "modal runner",
        ["-m", "unittest", "discover", "-s", "apps/runner-modal/tests", "-p", "test_*.py"],
        ("numpy",),
    ),
    ("template catalog", ["template-catalog/validate.py"], ()),
    ("week 2 submodule", ["scripts/validate_week2_submodule.py"], ()),
    ("week 3 submodule", ["scripts/validate_week3_submodule.py"], ()),
    ("week 1 submodule", ["scripts/validate_week1_submodule.py"], ()),
)


def _missing(requirements) -> list:
    absent = []
    for name in requirements:
        probe = subprocess.run(
            [sys.executable, "-c", "import {}".format(name)],
            capture_output=True,
        )
        if probe.returncode != 0:
            absent.append(name)
    return absent


def main() -> int:
    print("interpreter: {} ({})".format(sys.executable, sys.version.split()[0]))
    failed = []
    for label, argv, requirements in SUITES:
        absent = _missing(requirements)
        if absent:
            print(
                "\n{}: cannot run, because {} not importable here.\n"
                "  Install it with: {} -m pip install {}".format(
                    label,
                    " and ".join(absent) + (" is" if len(absent) == 1 else " are"),
                    sys.executable,
                    " ".join(absent),
                )
            )
            failed.append(label)
            continue
        print("\n--- {} ---".format(label))
        if subprocess.run([sys.executable, *argv], cwd=ROOT).returncode != 0:
            failed.append(label)

    if failed:
        print("\nDid not pass: {}".format(", ".join(failed)))
        return 1
    print("\nEvery suite passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
