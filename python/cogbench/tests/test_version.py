"""Version provenance follows imported code, even beside another distribution."""

from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
SOURCE = PACKAGE / "src"


def _declared_version() -> str:
    tree = ast.parse((SOURCE / "cogbench" / "__init__.py").read_text(encoding="utf-8"))
    values = [
        ast.literal_eval(node.value)
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "__version__"
                for target in node.targets)
    ]
    if len(values) != 1 or not isinstance(values[0], str):
        raise AssertionError("cogbench.__version__ must be one literal string")
    return values[0]


# Exercise the actual CLI parser and setup payload without a portal or GitHub call.
PROBE = """
import contextlib
import io
import json
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import cogbench
from cogbench import cli, runner

output = io.StringIO()
with contextlib.redirect_stdout(output):
    try:
        cli.main(["--version"])
    except SystemExit as exc:
        assert exc.code == 0, exc.code
with patch.object(cli, "repository_state", return_value=SimpleNamespace(full_name="fixture/team")), \\
     patch.object(cli, "plugin_names", return_value=[]):
    payload = cli._setup_payload(["environment"], Path.cwd())
try:
    installed = version("cogworks-benchmark")
except PackageNotFoundError:
    installed = None
print(json.dumps({"version": cogbench.__version__, "cli": output.getvalue().strip(),
                  "cliVersion": payload["cliVersion"], "runner": runner.__version__,
                  "installed": installed, "file": cogbench.__file__}))
"""


class ImportedVersion(unittest.TestCase):
    def _probe(self, paths, cwd):
        # Local editable installs can leave egg-info beside src/cogbench. Copy
        # only the package so each fixture controls all visible metadata.
        source = Path(cwd) / "source"
        shutil.copytree(SOURCE / "cogbench", source / "cogbench", ignore=shutil.ignore_patterns("__pycache__"))
        paths = [source if path == SOURCE else path for path in paths]
        env = dict(os.environ, PYTHONPATH=os.pathsep.join(map(str, paths)))
        result = subprocess.run(
            [sys.executable, "-S", "-c", PROBE], cwd=str(cwd), env=env,
            capture_output=True, text=True, timeout=30, check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual(Path(payload["file"]).resolve(), (source / "cogbench" / "__init__.py").resolve())
        return payload

    def _assert_consumers(self, result):
        for key in ("version", "cli", "cliVersion", "runner"):
            self.assertEqual(result[key], _declared_version(), key)

    def test_source_without_installed_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self._probe([SOURCE], directory)
        self.assertIsNone(result["installed"])
        self._assert_consumers(result)

    def test_source_shadowing_another_installed_distribution(self):
        with tempfile.TemporaryDirectory() as directory:
            installed = Path(directory) / "site-packages"
            metadata = installed / "cogworks_benchmark-9.9.9.dist-info"
            metadata.mkdir(parents=True)
            (metadata / "METADATA").write_text(
                "Metadata-Version: 2.1\nName: cogworks-benchmark\nVersion: 9.9.9\n",
                encoding="utf-8",
            )
            package = installed / "cogbench"
            package.mkdir()
            (package / "__init__.py").write_text('__version__ = "9.9.9"\n', encoding="utf-8")
            result = self._probe([SOURCE, installed], directory)
        # Prove metadata really resolves to the other release, not just that
        # imported code reports the expected number in an ordinary checkout.
        self.assertEqual(result["installed"], "9.9.9")
        self._assert_consumers(result)

    def test_build_configuration_uses_the_imported_literal(self):
        config = (PACKAGE / "pyproject.toml").read_text(encoding="utf-8")
        self.assertIn('dynamic = ["version"]', config)
        self.assertIn('[tool.setuptools.dynamic]\nversion = { attr = "cogbench.__version__" }', config)
        self.assertNotRegex(config, r'(?m)^version\s*=\s*["\']')
        _declared_version()


class ThePublishedVersionIsNotAlreadyTaken(unittest.TestCase):
    # Checked against TestPyPI on 2026-08-20. Keep this test offline.
    PUBLISHED = ("0.1.0",)

    def test_the_declared_version_is_new(self):
        self.assertNotIn(
            _declared_version(), self.PUBLISHED,
            "This version is already on TestPyPI; change cogbench.__version__ before publishing.",
        )


if __name__ == "__main__":
    unittest.main()
