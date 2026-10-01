"""The images install each benchmark from its source, never from a stale `build/`.

Every image copies a benchmark with `add_source_dir` and then runs
`python -m pip install --no-deps /opt/weekN`. Modal's copy layer keeps each
file's bytes and mode but not its mtime (`MountFile` in Modal's protocol has no
mtime field), so every copied file has the same one. setuptools only replaces a
file in `build/lib` with a strictly newer source, so a `build/` that reaches
the image wins over the source beside it. The beta v45 release found Week 3's
`build/` holding 94c7e64's `plugins.py` after the submodule had moved to
9e4dcff, and the exclusion meant to stop it matched nothing.

The install test lays a package down the way Modal does, using the predicate
the image definitions actually pass, runs the image's own pip command with the
interpreter running the tests, and compares the installed bytes with the
source. The same package laid down without the predicate has to install the
stale bytes, or the fixture proves nothing. Both installs build with pip's
default isolation, as the image does, so they fetch setuptools from the index.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_deployment_target as deployment_target  # noqa: E402

CURRENT = b"FINDING = 'what 9e4dcff says'\n"
STALE = b"FINDING = 'what 94c7e64 said'\n"
DELETED = b"GONE = 'a module the source no longer has'\n"

#: One timestamp for every file laid down, as a Modal copy layer leaves them.
LAYER_MTIME = 1_700_000_000


def _checkout(root: Path) -> Path:
    """A benchmark checkout with a stale local build beside its source."""

    project = root / "checkout"
    (project / "finding").mkdir(parents=True)
    (project / "pyproject.toml").write_text(
        "[build-system]\n"
        'requires = ["setuptools>=61"]\n'
        'build-backend = "setuptools.build_meta"\n'
        "\n"
        "[project]\n"
        'name = "stale-build-fixture"\n'
        'version = "0"\n'
        "\n"
        "[tool.setuptools]\n"
        'packages = ["finding"]\n'
    )
    (project / "finding" / "__init__.py").write_bytes(CURRENT)
    stale = project / "build" / "lib" / "finding"
    stale.mkdir(parents=True)
    (stale / "__init__.py").write_bytes(STALE)
    (stale / "deleted.py").write_bytes(DELETED)
    return project


def _lay_down(source: Path, destination: Path, ignore) -> Path:
    """Copy `source` the way an `add_local_dir(copy=True)` layer does.

    Modal walks every file, asks `ignore` about its path relative to the
    copied directory, and keeps bytes and mode for the rest.
    """

    for directory, _dirs, files in os.walk(source):
        for name in files:
            path = Path(directory) / name
            relative = path.relative_to(source)
            if ignore(relative):
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())
            os.chmod(target, path.stat().st_mode & 0o777)
    for directory, dirs, files in os.walk(destination):
        for name in dirs + files:
            os.utime(Path(directory) / name, (LAYER_MTIME, LAYER_MTIME))
    return destination


def _install(image_copy: Path, site: Path) -> Path:
    """The image's `pip install --no-deps /opt/weekN`, into `site`."""

    completed = subprocess.run(
        [
            sys.executable, "-m", "pip", "install", "--quiet", "--no-deps",
            "--disable-pip-version-check", "--target", str(site), str(image_copy),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError("pip install failed:\n" + completed.stdout)
    return site / "finding"


class SourceCopyExcludesBuildOutput(deployment_target.ControllerImport):
    def source_copies(self):
        """Every `add_local_dir` layer in every image either target builds."""

        images = (
            self.staging_app.benchmark_image,
            self.staging_app.week1_image,
            self.staging_app.week3_image,
            self.staging_app.controller_image,
            self.production_app.controller_image,
        )
        return [
            (args, kwargs)
            for image in images
            for name, args, kwargs in image.history
            if name == "add_local_dir"
        ]

    def test_every_source_copy_uses_the_build_junk_predicate(self):
        copies = self.source_copies()
        self.assertTrue(copies)
        for args, kwargs in copies:
            self.assertIs(kwargs.get("copy"), True, args)
            ignore = kwargs.get("ignore")
            self.assertEqual(getattr(ignore, "__name__", ignore), "is_build_junk", args)

    def test_the_image_install_reads_the_source_and_not_a_stale_build(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            checkout = _checkout(root)

            unfiltered = _install(
                _lay_down(checkout, root / "unfiltered", lambda _path: False),
                root / "site-unfiltered",
            )
            self.assertEqual(
                (unfiltered / "__init__.py").read_bytes(),
                STALE,
                "The fixture no longer reproduces a stale build, so the check "
                "below proves nothing. Has setuptools stopped reusing build/lib?",
            )

            installed = _install(
                _lay_down(checkout, root / "image", self.staging_app.is_build_junk),
                root / "site",
            )
            self.assertEqual((installed / "__init__.py").read_bytes(), CURRENT)
            self.assertFalse((installed / "deleted.py").exists())

    def test_excludes_build_output_at_any_depth(self):
        for path in (
            "build/lib/language_search_benchmark/plugins.py",
            "dist/cogworks_week3-0.1.0.tar.gz",
            "language_search_benchmark.egg-info/SOURCES.txt",
            "src/cogbench.egg-info/PKG-INFO",
            "language_search_benchmark/__pycache__/plugins.cpython-311.pyc",
            "language_search_benchmark/plugins.pyc",
            "tests/.pytest_cache/v/cache/lastfailed",
            ".ruff_cache/CACHEDIR.TAG",
            ".mypy_cache/3.11/cache.db",
            ".git",
            ".venv/bin/python",
            "face_recognition_app/build/lib/app.py",
        ):
            self.assertTrue(self.staging_app.is_build_junk(Path(path)), path)

    def test_keeps_source_and_package_data(self):
        for path in (
            "pyproject.toml",
            "language_search_benchmark/plugins.py",
            "language_search_benchmark/manifests/showcase.json",
            "language_search_benchmark/py.typed",
            "facial_recognition_benchmark/model-lock.json",
            "builder.py",
            "rebuild/module.py",
            "distance.py",
            "tools/build_manifest.py",
            ".gitignore",
        ):
            self.assertFalse(self.staging_app.is_build_junk(Path(path)), path)


if __name__ == "__main__":
    unittest.main()
