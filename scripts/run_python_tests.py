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
        # numpy only. The payload tests each put their own benchmark on
        # sys.path and skip themselves when it is genuinely unavailable, so
        # requiring the benchmark packages here would refuse to run a suite
        # that can in fact run. numpy is different: it has no such fallback,
        # and without it these tests raise ImportError, which unittest counts
        # as an error rather than a skip.
        ("numpy",),
    ),
    ("template catalog", ["template-catalog/validate.py"], ()),
    ("week 2 submodule", ["scripts/validate_week2_submodule.py"], ()),
    ("week 3 submodule", ["scripts/validate_week3_submodule.py"], ()),
    ("week 1 submodule", ["scripts/validate_week1_submodule.py"], ()),
)


#: The benchmark packages live in this repository as submodules, so telling
#: someone to `pip install facial_recognition_benchmark` sends them to PyPI for
#: a package that is not there. Each one is installed from its own directory.
_LOCAL_PACKAGES = {
    "facial_recognition_benchmark": "benchmarks/week2",
    "language_search_benchmark": "benchmarks/week3",
    "audio_identification_benchmark": "benchmarks/week1",
}


def _how_to_install(absent) -> str:
    """The command that actually fixes it, which differs by where it lives."""

    lines = []
    from_pypi = [name for name in absent if name not in _LOCAL_PACKAGES]
    if from_pypi:
        lines.append(
            "Install it with: {} -m pip install {}".format(
                sys.executable, " ".join(from_pypi)
            )
        )
    for name in absent:
        directory = _LOCAL_PACKAGES.get(name)
        if directory:
            # `pip install -e` is the usual advice and it fails on the venvs in
            # this repository, which were built by uv and carry no pip. Putting
            # the directory on PYTHONPATH needs nothing installed and is what
            # the test files themselves do, so it is the instruction least
            # likely to send someone down a second dead end.
            lines.append(
                "{} is in this repository, not on PyPI. Either install it with\n"
                "    uv pip install --python {} -e {}\n"
                "  or run the suite with it on the path:\n"
                "    PYTHONPATH={} {} -m pytest ...".format(
                    name, sys.executable, directory, directory, sys.executable
                )
            )
    return "\n  ".join(lines)


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
                "  {}".format(
                    label,
                    " and ".join(absent) + (" is" if len(absent) == 1 else " are"),
                    _how_to_install(absent),
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
