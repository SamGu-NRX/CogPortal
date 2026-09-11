"""Build one interpreter that can run every Python suite in this repository.

`pnpm test:python` refuses a suite whose requirements are missing, which is
right, but it leaves you to work out what to install. On a fresh checkout
that is four separate answers: cogbench needs nothing, the runner needs
numpy, and each of the three benchmarks needs its own package plus that
week's science stack. Getting it wrong is quiet: the suite says it cannot
run, and the natural reading is that something is broken.

    python scripts/make_test_env.py
    .venv-test/bin/python scripts/run_python_tests.py

Versions come from `cogbench.environment`, which is the same data the hosted
images are built from, so this interpreter matches the graded run rather than
approximating it. That is not tidiness. Installing an unpinned scikit-image
here pulled numpy 2.4 over the pinned 1.24, and every module in a student
repository that imports numpy stopped importing with

    ImportError: numpy.core.multiarray failed to import

which discovery correctly recorded as a skip and which read, from the
outside, as five real repositories suddenly failing to resolve. The pin is
load-bearing and the reason is worth the two minutes it costs to build this.

The environment is deliberately not the union of all three graded images: it
carries Week 1's librosa and Week 2's torch in one interpreter, which no
graded run does. It is for running tests, not for standing in for a sandbox.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import environment  # noqa: E402

VENV = ROOT / ".venv-test"

#: Python 3.11. The graded images run student code on 3.8 for Weeks 1 and 3
#: and 3.11 for Week 2, but the suites themselves are not version-pinned and
#: 3.8 is past end of life, so building on it invites its own problems.
PYTHON = "3.11"

#: Not in any image's package list, and needed to run the suites rather than
#: to run student code.
TOOLING = ("pytest",)

#: The reference application two Week 2 suites import lives in a directory
#: rather than a package, and its own scikit-image import is what makes the
#: pin above matter.
BENCHMARKS = ("benchmarks/week1", "benchmarks/week2", "benchmarks/week3")


def run(*argv: str) -> None:
    print("  " + " ".join(argv[:6]) + (" ..." if len(argv) > 6 else ""))
    result = subprocess.run(argv, cwd=ROOT)
    if result.returncode != 0:
        raise SystemExit("failed: {}".format(" ".join(argv)))


def main() -> int:
    if not _has_uv():
        print(
            "uv is not on PATH. It builds the pinned interpreter this needs.\n"
            "  https://docs.astral.sh/uv/getting-started/installation/"
        )
        return 1

    print("building {}".format(VENV.relative_to(ROOT)))
    run("uv", "venv", "--python", PYTHON, str(VENV), "-q")
    python = str(VENV / "bin" / "python")

    # Every requirement from every track, at the versions the images pin.
    requirements = sorted(
        {
            spec
            for track in ("week1", "week2", "week3")
            for spec in environment.requirement_strings(track)
        }
    )
    print("installing {} pinned requirements from cogbench.environment".format(len(requirements)))
    run("uv", "pip", "install", "--python", python, "-q", *requirements, *TOOLING)

    print("installing the three benchmark packages")
    for directory in BENCHMARKS:
        run("uv", "pip", "install", "--python", python, "-q", "--no-deps", "-e", directory)

    print("\nBuilt. Run every suite with:\n  {} scripts/run_python_tests.py".format(python))
    return 0


def _has_uv() -> bool:
    try:
        subprocess.run(["uv", "--version"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


if __name__ == "__main__":
    raise SystemExit(main())
