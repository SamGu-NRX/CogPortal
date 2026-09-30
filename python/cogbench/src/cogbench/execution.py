"""Private files for one local check or scored run, owned by its parent process."""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import warnings
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


class ExecutionCopyError(OSError):
    """The command cannot preserve the project while executing it."""


@dataclass(frozen=True)
class ExecutionPaths:
    execution: Path
    original: Path

    def source_path(self, path: Path) -> Path:
        try:
            return self.original / path.relative_to(self.execution)
        except ValueError:
            return path

    def environment_path(self, path: Path) -> bool:
        """An installed dependency belongs to its virtualenv, not the copy."""
        for folder in (path,) + tuple(path.parents):
            if folder == self.original:
                break
            if self.original not in folder.parents:
                return False
            if (folder / "pyvenv.cfg").is_file():
                return True
        return False

    def describe(self, value):
        """Show original locations in diagnostics, without claiming files exist.

        Student-created outputs are discarded, so their translated names may
        describe files that have never existed in the original project.
        """
        if isinstance(value, str):
            return value.replace(str(self.execution), str(self.original))
        if isinstance(value, list):
            return [self.describe(item) for item in value]
        if isinstance(value, dict):
            return {key: self.describe(item) for key, item in value.items()}
        return value


def _ignored(directory, names):
    # The running interpreter owns its environment, not the student submission.
    # Detect virtual environments by their marker, not by arbitrary folder names.
    ignored = set(names).intersection((".git", ".cogbench", "__pycache__"))
    for name in names:
        child = Path(directory) / name
        if not child.is_symlink() and (child / "pyvenv.cfg").is_file():
            ignored.add(name)
    return ignored


def _internal_links(root: Path):
    links = []
    for directory, folders, files in os.walk(str(root), followlinks=False):
        folders[:] = [name for name in folders if name not in _ignored(directory, folders)]
        for name in folders + [name for name in files if name not in _ignored(directory, files)]:
            path = Path(directory) / name
            if not path.is_symlink():
                continue
            try:
                target = path.resolve(strict=True)
                relative = target.relative_to(root)
                if any(part in _ignored(root.joinpath(*relative.parts[:index]), [part])
                       for index, part in enumerate(relative.parts)):
                    raise ValueError("link targets excluded metadata")
                links.append((path.relative_to(root), relative, target.is_dir()))
            except (OSError, RuntimeError, ValueError) as error:
                raise ExecutionCopyError(
                    "Cannot make a private execution copy: link {} points to {}. "
                    "Its target is missing, cyclic, outside the project, or excluded "
                    "metadata. Keep the resource inside the project before retrying."
                    .format(path, os.readlink(str(path)))
                ) from error
    return links


@contextmanager
def private_project(root: Path):
    """Copy once; never copy student-created outputs back to the project.

    The SDK still stores its own reports and binding cache under the original
    project's .cogbench directory. Linking writable files back to the original
    instead of copying them would let native SQLite and image writers change
    the student's data.
    """
    root = Path(root).resolve()
    temporary = None
    try:
        links = _internal_links(root)
        try:
            temporary = Path(tempfile.mkdtemp(prefix="cogworks-execution-")).resolve()
            execution = temporary / root.name
            # Preserve internal aliases without recursively copying a directory
            # link to its ancestor. Absolute links must point into the copy too.
            shutil.copytree(str(root), str(execution), ignore=_ignored, symlinks=True)
            for name, target, is_directory in links:
                link = execution / name
                link.unlink()
                link.symlink_to(
                    os.path.relpath(str(execution / target), str(link.parent)),
                    target_is_directory=is_directory,
                )
        except (OSError, shutil.Error) as error:
            raise ExecutionCopyError(
                "Could not copy the project for execution: {}. The original was not "
                "run. Check free space and file access, then retry.".format(error)
            ) from error
        yield ExecutionPaths(execution, root)
    finally:
        if temporary is not None:
            try:
                shutil.rmtree(str(temporary))
            except OSError as error:
                # A cleanup failure must not replace a scored result or the
                # original child failure. SIGKILL of the parent can also leak it.
                warnings.warn("Could not remove execution copy {}: {}".format(temporary, error))


@contextmanager
def entered_project(paths: ExecutionPaths):
    """Give the no-fork path the same cwd/import roots as the child backends."""
    previous_cwd = Path.cwd()
    previous_path = list(sys.path)
    try:
        kept = []
        for entry in sys.path:
            resolved = Path(entry or previous_cwd).resolve()
            if paths.environment_path(resolved):
                kept.append(entry)
                continue
            try:
                relative = resolved.relative_to(paths.original)
            except ValueError:
                kept.append(entry)
            else:
                kept.append(str(paths.execution / relative))
        sys.path[:] = [str(paths.execution)] + kept
        os.chdir(str(paths.execution))
        yield
    finally:
        os.chdir(str(previous_cwd))
        sys.path[:] = previous_path
