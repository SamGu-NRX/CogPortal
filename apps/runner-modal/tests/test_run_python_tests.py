"""The install line `scripts/run_python_tests.py` prints for a missing import."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))

import run_python_tests  # noqa: E402


class InstallAdvice(unittest.TestCase):
    def pip_line(self, absent):
        advice = run_python_tests._how_to_install(absent)
        prefix = "Install it with: {} -m pip install ".format(sys.executable)
        line = next(line for line in advice.splitlines() if line.startswith(prefix))
        return line[len(prefix):].split()

    def test_import_names_become_the_distributions_pip_installs(self):
        self.assertEqual(self.pip_line(["PIL", "skimage"]), ["Pillow", "scikit-image"])

    def test_names_that_match_their_distribution_are_installed_as_spelt(self):
        self.assertEqual(self.pip_line(["numpy", "librosa", "numba"]), ["numpy", "librosa", "numba"])

    def test_every_pypi_requirement_a_suite_probes_has_a_correct_install_name(self):
        # The probes and the mapping live in one file; a new probe whose import
        # name differs from its distribution has to be added to both.
        installable = {"numpy", "librosa", "numba", "Pillow", "scikit-image"}
        for _label, _argv, requirements, *_ in run_python_tests.SUITES:
            for name in requirements:
                if name in run_python_tests._LOCAL_PACKAGES:
                    continue
                with self.subTest(name=name):
                    self.assertIn(run_python_tests._DISTRIBUTIONS.get(name, name), installable)

    def test_repository_packages_still_point_at_their_directory_not_pypi(self):
        advice = run_python_tests._how_to_install(["facial_recognition_benchmark", "PIL"])
        self.assertEqual(self.pip_line(["facial_recognition_benchmark", "PIL"]), ["Pillow"])
        self.assertIn("-e benchmarks/week2", advice)


if __name__ == "__main__":
    unittest.main()
