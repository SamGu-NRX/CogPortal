"""Installed entry-point imports and cache probes leave one check document."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / "src"


class InstalledBenchmarkChecks(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="cogworks-plugin-check-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        metadata = self.root / "check_fixture-0.0.1.dist-info"
        metadata.mkdir()
        (metadata / "METADATA").write_text(
            "Metadata-Version: 2.1\nName: check-fixture\nVersion: 0.0.1\n"
        )
        (metadata / "entry_points.txt").write_text(
            "[cogworks.benchmarks.v1]\n"
            "noisy = check_fixture:Noisy\n"
            "broken = check_fixture:Broken\n"
            "[cogworks.benchmarks.v2]\n"
            "cache-broken = check_fixture:CacheBroken\n"
        )
        (self.root / "check_fixture.py").write_text(
            "import os\n"
            "print('plugin print')\n"
            "os.write(1, b'plugin native write\\n')\n"
            "if os.name == 'posix':\n"
            "    import ctypes\n"
            "    ctypes.CDLL(None).printf(b'plugin buffered native write\\n')\n"
            "class Noisy:\n"
            "    contract_version = 'cogworks.submissions.v1'\n"
            "class Broken:\n"
            "    def __init__(self):\n"
            "        import missing_check_fixture_dependency\n"
            "class CacheBroken:\n"
            "    def model_cache_status(self):\n"
            "        return {'ready': True}\n"
            "    def cache_status(self, tier):\n"
            "        raise RuntimeError('unreadable cache manifest')\n"
        )
        (self.root / "submission.py").write_text(
            "def create_submission():\n    return object()\n"
        )

    def check(self, name, as_json=True):
        command = [sys.executable, "-m", "cogbench", "check", "--benchmark", name]
        if as_json:
            command.append("--json")
        return subprocess.run(
            command, cwd=self.root, capture_output=True, text=True, timeout=20,
            env=dict(os.environ, PYTHONHASHSEED="0",
                     PYTHONPATH=os.pathsep.join((str(SOURCE), str(self.root)))),
        )

    def test_python_and_native_plugin_output_stay_off_json_stdout(self):
        result = self.check("noisy")
        self.assertEqual(result.returncode, 2, result.stderr)  # no Git checkout
        record = json.loads(result.stdout)
        self.assertTrue(record["benchmarkLoadable"])
        self.assertTrue(record["submissionLoadable"])
        self.assertIn("plugin print", result.stderr)
        self.assertIn("plugin native write", result.stderr)
        if os.name == "posix":
            self.assertIn("plugin buffered native write", result.stderr)

    def test_import_and_cache_failures_are_check_errors_not_tracebacks(self):
        for name, reason in (("broken", "ModuleNotFoundError"),
                             ("cache-broken", "RuntimeError: unreadable cache manifest")):
            with self.subTest(name=name):
                result = self.check(name)
                self.assertEqual(result.returncode, 2, result.stderr)
                record = json.loads(result.stdout)
                self.assertTrue(record["benchmarkInstalled"])
                self.assertFalse(record["benchmarkLoadable"])
                self.assertFalse(record["submissionLoadable"])
                self.assertIn(reason, record["benchmarkError"])
                self.assertNotIn("Traceback", result.stderr)

    def test_text_names_the_broken_installation_instead_of_an_absent_package(self):
        result = self.check("broken", as_json=False)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("(could not load)", result.stdout)
        self.assertIn("missing_check_fixture_dependency", result.stdout)
        self.assertNotIn("not installed", result.stdout)
        self.assertNotIn("Traceback", result.stderr)
