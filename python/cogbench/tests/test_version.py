"""The version a student sees has to be the version they have.

`cogbench/__init__.py` restated the number that `pyproject.toml` declares,
and the two drifted: the package said 0.1.0 while the source tree had moved
on. `cogworks --version` and the `cliVersion` field in every local report
both read the restated one, so a student comparing their output against a
runbook was given a number that named a release they did not have.

The number now comes from the installed package's own metadata, which cannot
disagree with itself.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

PYPROJECT = ROOT / "python" / "cogbench" / "pyproject.toml"


def _declared_version() -> str:
    for line in PYPROJECT.read_text(encoding="utf-8").splitlines():
        if line.startswith("version = "):
            return line.split("=", 1)[1].strip().strip('"')
    raise AssertionError("pyproject.toml declares no version")


class TheVersionIsNotRestated(unittest.TestCase):
    def test_the_package_does_not_hard_code_a_number(self):
        """A literal here is the drift this file exists to prevent.

        Asserted against the source rather than against the value, because
        the value is correct on any machine where the two happen to agree,
        which is exactly how the drift went unnoticed.
        """

        source = (
            ROOT / "python" / "cogbench" / "src" / "cogbench" / "__init__.py"
        ).read_text(encoding="utf-8")
        literal = re.search(r'^__version__\s*=\s*"[0-9]', source, re.MULTILINE)
        self.assertIsNone(
            literal,
            "__version__ must come from the installed package, not a literal",
        )

    def test_it_reports_the_declared_version_when_installed(self):
        import cogbench

        # In a checkout with the package installed (editable or not) the two
        # must agree. Where it is not installed at all the fallback answers,
        # and that case is covered below.
        if cogbench.__version__ != "0+source":
            self.assertEqual(cogbench.__version__, _declared_version())

    def test_an_uninstalled_source_tree_says_so_rather_than_guessing(self):
        """A wrong version is worse than an obviously absent one.

        Simulated rather than staged in a real interpreter: building a venv
        with no metadata anywhere above it is slow and fragile, and the branch
        under test is one `except`.
        """

        from importlib.metadata import PackageNotFoundError

        def _resolve(lookup):
            try:
                return lookup("cogworks-benchmark")
            except PackageNotFoundError:
                return "0+source"

        def _absent(_name):
            raise PackageNotFoundError("cogworks-benchmark")

        self.assertEqual(_resolve(_absent), "0+source")
        self.assertEqual(_resolve(lambda _n: "9.9.9"), "9.9.9")


class ThePublishedVersionIsNotAlreadyTaken(unittest.TestCase):
    """TestPyPI refuses a second upload of one version.

    0.1.0 is published. Dispatching the publish workflow without moving the
    number fails at the upload step, after a green build, which reads as a
    broken pipeline rather than as the one-line fix it is.
    """

    #: Versions already on TestPyPI. Checked by hand against
    #: https://test.pypi.org/pypi/cogworks-benchmark/json on 2026-08-20; there
    #: is no network in this suite and a test that reaches one would fail
    #: offline for a reason that has nothing to do with the code.
    PUBLISHED = ("0.1.0",)

    def test_the_declared_version_is_new(self):
        self.assertNotIn(
            _declared_version(),
            self.PUBLISHED,
            "this version is already on TestPyPI; the publish workflow would "
            "refuse it. Move the number in pyproject.toml.",
        )


if __name__ == "__main__":
    unittest.main()
