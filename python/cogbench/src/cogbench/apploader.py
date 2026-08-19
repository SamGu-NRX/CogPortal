"""Load a student submission from a file in their repository.

Entry points require the repository to be an installable package, and the
audited student repositories are not: none of the thirteen carries a
``pyproject.toml`` or ``setup.py``, so entry-point discovery finds nothing in
them. Installing them to find out is also the wrong shape for the hosted
runner, because ``pip install -e`` executes a ``setup.py`` in the prepare
sandbox, which still has network access. Reading one file by path moves every
line of student code behind the network block.

This module imports exactly one file. It does not install anything, does not
walk the repository, and never calls the factory it finds; the caller decides
when student code runs.
"""

from __future__ import annotations

import importlib.util
import re
import sys
import traceback
from pathlib import Path
from types import ModuleType
from typing import Any, List, Optional, Tuple

__all__ = [
    "CANDIDATE_FILENAMES",
    "SubmissionFileError",
    "SubmissionFileMissing",
    "SubmissionImportFailed",
    "SubmissionFactoryMissing",
    "SubmissionSource",
    "factory_names",
    "load_submission_file",
    "resolve_submission_file",
]

#: Searched in order at the repository root. ``submission.py`` is the name we
#: document; ``benchmark_adapter.py`` is what the two reference repositories in
#: ``examples/`` and ``benchmarks/week2/face_recognition_app`` already use.
CANDIDATE_FILENAMES = ("submission.py", "benchmark_adapter.py")


class SubmissionFileError(RuntimeError):
    """Base for every failure of file-path submission discovery."""


class SubmissionFileMissing(SubmissionFileError):
    """No candidate adapter file exists at the repository root."""

    def __init__(self, message: str, repo_root: Path) -> None:
        super().__init__(message)
        self.repo_root = repo_root
        self.filenames = tuple(CANDIDATE_FILENAMES)


class SubmissionImportFailed(SubmissionFileError):
    """The adapter file raised while it was being imported."""

    def __init__(
        self,
        message: str,
        path: Path,
        traceback_line: Optional[str] = None,
        source_line: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.path = path
        #: ``"/abs/path/submission.py:12"`` for the deepest frame inside the
        #: student's own repository, so the message points at their line
        #: rather than at ``importlib``.
        self.traceback_line = traceback_line
        self.source_line = source_line


class SubmissionFactoryMissing(SubmissionFileError):
    """The adapter file imported, but defines no factory we recognize."""

    def __init__(self, message: str, path: Path, looked_for: Tuple[str, ...]) -> None:
        super().__init__(message)
        self.path = path
        self.looked_for = looked_for


class SubmissionSource:
    """What resolved, and how, so ``cogworks check`` can say it out loud."""

    def __init__(self, path: Path, attribute: str, factory: Any) -> None:
        self.path = path
        self.filename = path.name
        self.attribute = attribute
        self.factory = factory

    def describe(self) -> str:
        return "{}:{}".format(self.filename, self.attribute)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "SubmissionSource({!r})".format(self.describe())


def factory_names(contract_name: str) -> List[str]:
    """Factory names looked for, in resolution order.

    ``create_submission`` is contract-independent and is what we document for
    new repositories. The two contract-shaped names exist because one file can
    serve several contracts: ``benchmarks/week2/face_recognition_app`` defines
    both ``create_recognition_adapter`` and ``create_clustering_adapter`` in one
    module, and the shipped entry points name the trailing word of the contract
    (``vision-recognition`` to ``create_recognition_adapter``,
    ``language-search`` to ``create_search_adapter``), so the trailing-word form
    is checked as well as the full one.
    """

    slug = re.sub(r"[^0-9a-zA-Z]+", "_", contract_name or "").strip("_")
    names = ["create_submission"]
    if slug:
        names.append("create_{}_adapter".format(slug))
        tail = slug.rsplit("_", 1)[-1]
        if tail and tail != slug:
            names.append("create_{}_adapter".format(tail))
    return names


def _candidate_path(repo_root: Path) -> Path:
    for filename in CANDIDATE_FILENAMES:
        path = repo_root / filename
        if path.is_file():
            return path
    raise SubmissionFileMissing(
        "We look for your adapter at the repository root, and {} has neither {} nor {}. "
        "Create {} there, define create_submission, and return your adapter from it.".format(
            repo_root, CANDIDATE_FILENAMES[0], CANDIDATE_FILENAMES[1], CANDIDATE_FILENAMES[0]
        ),
        repo_root,
    )


def _ensure_importable(repo_root: Path) -> None:
    """Put the repository root first on ``sys.path`` and leave it there.

    The adapter file imports the student's own modules, and it often does so
    lazily inside the factory, which runs long after this function returns.
    Removing the entry afterwards would break exactly those repositories.
    """

    entry = str(repo_root)
    if entry not in sys.path:
        sys.path.insert(0, entry)


def _student_frame(error: BaseException, repo_root: Path) -> Tuple[Optional[str], Optional[str]]:
    """The deepest traceback frame that belongs to the student, not to us."""

    root = str(repo_root)
    chosen = None
    for frame in traceback.extract_tb(error.__traceback__):
        if frame.filename and frame.filename.startswith(root):
            chosen = frame
    if chosen is None:
        return None, None
    return "{}:{}".format(chosen.filename, chosen.lineno), (chosen.line or None)


def _import_file(path: Path, repo_root: Path) -> ModuleType:
    name = path.stem
    cached = sys.modules.get(name)
    cached_file = getattr(cached, "__file__", None)
    if cached is not None and cached_file and Path(cached_file).resolve() == path:
        return cached
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise SubmissionImportFailed(
            "{} is not importable as a Python module. Check that it is a plain .py file "
            "at the repository root.".format(path.name),
            path,
        )
    module = importlib.util.module_from_spec(spec)
    # Registered before execution so a module that refers to itself by name
    # (dataclasses and pickle both do) resolves during its own import.
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    # SystemExit is caught with Exception on purpose: a stray exit() at import
    # would otherwise take the runner down quietly and tell the student nothing.
    # KeyboardInterrupt is deliberately not caught.
    except (Exception, SystemExit) as error:
        sys.modules.pop(name, None)
        location, source = _student_frame(error, repo_root)
        detail = "{}: {}".format(type(error).__name__, error).strip().rstrip(":. ")
        message = "{} raised while we imported it. {}.".format(path.name, detail)
        if location:
            message += " The failing line is {}".format(location)
            if source:
                message += ", {!r}".format(source)
            message += "."
        message += " Fix that, then run this again."
        raise SubmissionImportFailed(message, path, location, source) from error
    return module


def resolve_submission_file(repo_root: Path, contract_name: str) -> SubmissionSource:
    """Import the repository's adapter file and return what resolved.

    Raises :class:`SubmissionFileMissing`, :class:`SubmissionImportFailed`, or
    :class:`SubmissionFactoryMissing`; each names the file and one next action.
    """

    root = Path(repo_root).resolve()
    path = _candidate_path(root)
    _ensure_importable(root)
    module = _import_file(path, root)
    names = factory_names(contract_name)
    for attribute in names:
        candidate = getattr(module, attribute, None)
        if callable(candidate):
            return SubmissionSource(path, attribute, candidate)
    submission = getattr(module, "Submission", None)
    if isinstance(submission, type):
        return SubmissionSource(path, "Submission", submission)
    looked_for = tuple(names) + ("Submission",)
    raise SubmissionFactoryMissing(
        "{} imported cleanly, but it defines none of the names we look for: {}. "
        "Add one of them to {} and return your adapter from it.".format(
            path.name, ", ".join(looked_for), path
        ),
        path,
        looked_for,
    )


def load_submission_file(repo_root: Path, contract_name: str) -> Any:
    """The factory from the repository's adapter file. Never calls it."""

    return resolve_submission_file(repo_root, contract_name).factory
