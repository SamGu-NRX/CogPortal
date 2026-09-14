"""A wheel built from the committed tree has to contain the source we publish.

`python/cogbench/build/lib/cogbench/` was committed: ten generated copies of
the package, frozen at 0.1.0. setuptools treats `build/lib` as its own output
cache and refreshes a module there only when the source file is newer.
`git archive` stamps every exported file with one timestamp, so no source
module was newer than its copy and setuptools reused all ten. The wheel was
still named 0.2.0, because that comes from `pyproject.toml`, which setuptools
reads from source either way; the package inside answered 0.1.0 and seven
modules did not match the source. Nothing in the build output said so.

These tests export with `git archive` rather than reading the working tree,
because a `build/` directory that is ignored, or deleted on one developer's
machine, is still in the tree for everyone else.

Revision defaults to HEAD, which is what CI wants. Set
COGBENCH_PACKAGING_REVISION to any tree-ish (including the output of
`git write-tree`) to accept staged deletions before they are committed.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]

#: What `[build-system] requires` in pyproject.toml declares.
_SETUPTOOLS_MINIMUM = (68, 0)

#: From 70.1 setuptools carries its own wheel writer and the separate `wheel`
#: package is no longer needed to produce one.
_SETUPTOOLS_WITH_BDIST_WHEEL = (70, 1)


def _revision() -> str:
    return os.environ.get("COGBENCH_PACKAGING_REVISION", "HEAD")


def _git(*args: str) -> str:
    return subprocess.run(
        ("git", "-C", str(ROOT)) + args,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def _export(destination: Path) -> Path:
    """Unpack `python/cogbench` from the revision, exactly as committed."""

    archive = destination / "export.tar"
    with archive.open("wb") as handle:
        subprocess.run(
            ("git", "-C", str(ROOT), "archive", _revision(), "python/cogbench"),
            check=True,
            stdout=handle,
        )
    tree = destination / "tree"
    with tarfile.open(archive) as tar:
        # `data` is the default from 3.14 and a DeprecationWarning before it;
        # the keyword does not exist on 3.8, which this package supports.
        if hasattr(tarfile, "data_filter"):
            tar.extractall(tree, filter="data")
        else:
            tar.extractall(tree)
    return tree / "python" / "cogbench"


def _declared_version(project: Path) -> str:
    for line in (project / "pyproject.toml").read_text(encoding="utf-8").splitlines():
        if line.startswith("version = "):
            return line.split("=", 1)[1].strip().strip('"')
    raise AssertionError("pyproject.toml declares no version")


def _installed(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def _unusable_backend() -> str:
    """Why this interpreter cannot build the wheel offline, or an empty string.

    The build runs with `--no-build-isolation --no-index`, so every tool it
    needs has to be here already. Reported rather than downloaded: a test that
    reaches an index fails for reasons that have nothing to do with the tree.
    """

    if not _installed("pip"):
        return "pip is not installed in this interpreter"
    # Read from distribution metadata rather than `import setuptools`. Once
    # pip has been looked up, setuptools' distutils shim resolves `distutils`
    # to the stdlib copy and asserts on it (setuptools #2355), so importing
    # setuptools after the pip check above raises instead of answering. The
    # metadata is also the version pip will actually build with.
    try:
        raw = importlib.metadata.version("setuptools")
    except importlib.metadata.PackageNotFoundError:
        return "setuptools is not installed in this interpreter"
    pieces = raw.split(".")[:2]
    if len(pieces) != 2 or not all(p.isdigit() for p in pieces):
        return f"cannot read a version from setuptools {raw!r}"
    found = (int(pieces[0]), int(pieces[1]))
    if found >= _SETUPTOOLS_WITH_BDIST_WHEEL:
        return ""
    if found < _SETUPTOOLS_MINIMUM:
        return f"setuptools {raw} is below the declared build requirement"
    if not _installed("wheel"):
        return f"setuptools {raw} needs the wheel package to write a wheel"
    return ""


def _build_wheel(project: Path, destination: Path) -> Path:
    finished = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            "--no-deps",
            "--no-build-isolation",
            "--no-index",
            "--wheel-dir",
            str(destination),
            str(project),
        ],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    if finished.returncode != 0:
        raise AssertionError(
            "building the exported package failed:\n"
            + finished.stdout
            + finished.stderr
        )
    wheels = sorted(destination.glob("cogworks_benchmark-*.whl"))
    if len(wheels) != 1:
        raise AssertionError(f"expected one wheel, found {[w.name for w in wheels]}")
    return wheels[0]


class TheTreeCarriesNoGeneratedCopyOfThePackage(unittest.TestCase):
    """The same rule stated cheaply, and it names the offending paths.

    Needs no build backend, so it holds on every lane even where the wheel
    tests below have to skip.
    """

    GENERATED = ("build", "dist")

    def test_only_src_holds_package_modules(self):
        listing = _git(
            "ls-tree", "-r", _revision(), "--name-only", "python/cogbench"
        ).splitlines()
        generated = [
            path
            for path in listing
            for part in Path(path).parts[:-1]
            if part in self.GENERATED or part.endswith(".egg-info")
        ]
        self.assertEqual(
            generated,
            [],
            "build output, which setuptools reuses in preference to src "
            "whenever the source file is not newer. Remove it from the tree; "
            ".gitignore does not untrack a file that is already committed.",
        )


class TheSkipReasonNamesTheMissingTool(unittest.TestCase):
    """pip is tooling here too, because the build shells out to it.

    An interpreter with new setuptools and no pip passed the backend check
    and then failed inside the build, which reads as a packaging defect
    rather than as the absent tool it is.

    Mocked, because the alternative is an interpreter without pip and there
    is no reason to build one.
    """

    def test_absent_pip_is_named_rather_than_found_by_failing(self):
        with mock.patch(f"{__name__}._installed", lambda name: name != "pip"):
            self.assertIn("pip", _unusable_backend())


class AWheelFromAnUntouchedExportCarriesTheSource(unittest.TestCase):
    """Build what the committed tree builds, and read what came out.

    The export is not cleaned first, on purpose: deleting `build/` inside the
    test would hide the defect this file exists to catch.
    """

    @classmethod
    def setUpClass(cls):
        reason = _unusable_backend()
        if reason:
            raise unittest.SkipTest(f"no offline wheel build here: {reason}")
        scratch = tempfile.TemporaryDirectory(prefix="cogbench-packaging-")
        cls.addClassCleanup(scratch.cleanup)
        cls.scratch = Path(scratch.name)
        cls.project = _export(cls.scratch)
        cls.source = cls.project / "src" / "cogbench"
        cls.wheel = _build_wheel(cls.project, cls.scratch / "wheelhouse")

    def _wheel_members(self) -> dict:
        with zipfile.ZipFile(self.wheel) as archive:
            return {
                name[len("cogbench/") :]: archive.read(name)
                for name in archive.namelist()
                if name.startswith("cogbench/")
            }

    def test_it_ships_every_source_module_and_nothing_else(self):
        expected = {path.name for path in self.source.iterdir() if path.is_file()}
        self.assertEqual(set(self._wheel_members()), expected)

    def test_every_shipped_module_is_the_source_byte_for_byte(self):
        members = self._wheel_members()
        differing = sorted(
            name
            for name, shipped in members.items()
            if shipped != (self.source / name).read_bytes()
        )
        self.assertEqual(
            differing,
            [],
            "the wheel carries something other than src/cogbench here",
        )

    def test_the_version_a_student_gets_is_the_declared_one(self):
        """Asked of the built package, not of the wheel's metadata.

        The metadata comes from `pyproject.toml`, so the defective wheel was
        named 0.2.0 while the package inside answered 0.1.0. Unpacked rather
        than installed, because the only thing under test is what the wheel
        contains.
        """

        declared = _declared_version(self.project)
        unpacked = self.scratch / "unpacked"
        with zipfile.ZipFile(self.wheel) as archive:
            archive.extractall(unpacked)
        probe = (
            "import json, cogbench;"
            "print(json.dumps([cogbench.__version__, cogbench.__file__]))"
        )
        finished = subprocess.run(
            [sys.executable, "-B", "-c", probe],
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "PYTHONPATH": str(unpacked),
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )
        self.assertEqual(finished.returncode, 0, finished.stderr)
        reported, imported_from = json.loads(finished.stdout)
        self.assertTrue(
            imported_from.startswith(str(unpacked)),
            f"imported {imported_from}, not the wheel under test",
        )
        self.assertEqual(reported, declared)


if __name__ == "__main__":
    unittest.main()
