"""Find the student's code in a repository that was never packaged for us.

``apploader`` imports one file the student wrote for us. This module handles
the repositories that predate that arrangement, and the ones next year whose
authors never read the template: it picks a root, imports what will import,
and hands the surviving modules to a benchmark's resolver.

Three measured facts shape everything here.

**Their sibling imports must work.** ``carti4ce/match.py`` does
``from database import load``, which resolves under ``sys.path`` and breaks
under ``pip install -e``. So a root is chosen and inserted at the front of
``sys.path``, and modules are imported by path, so a directory named
``Individual stuff`` never has to be a valid package name.

**Their writes must land somewhere else.** ``database.py`` in the same
repository writes ``DB_PATH = "db.pkl"`` relative to the working directory and
rewrites it on every add. Importing is therefore done from a scratch directory
rather than from the checkout: their code is right about wanting a working
directory, and it does not get to be the student's repository or ours.

**Importing runs their code.** Two of the audited repositories print a prompt
and block on ``input()`` at module scope; others build a model or read a file.
Import therefore happens with stdin closed and output captured, under a wall
clock, and a module that fails is recorded and skipped rather than aborting the
repository. What was skipped, and why, reaches the student.

**Some imports cannot succeed and are not their fault.** Across the thirteen
audited repositories, the third-party modules a sandbox image can lack are
``streamlit``, ``microphone``, and ``pyaudio``: interface and hardware
packages that no scored path touches. Those get a recording stub so a module
that mentions one at import scope still yields its functions. The list is
fixed, identical for every repository, and reported on every run; growing it
per repository would be hand-wiring under another name.

A stub is only ever installed for a package that is genuinely not importable
here, which is checked at the moment discovery runs rather than assumed from
the list. That check exists because the assumption was wrong once and cost a
team their score: ``networkx`` was on this list while the Week 2 image
installed ``networkx==3.1``, so a real package was replaced by a stand-in and
the team's clustering module was reported as their bug. See ``STUBBED_MODULES``
for the measurement.

**A module inside a package must be imported as part of that package.** A
package here means a directory Python treats as one unit rather than as a pile
of unrelated files. A file inside one may write ``from .profile import
Profile``, where the leading dot means "the directory I am in". Python
resolves that dot from the importing module's ``__package__`` attribute and
never from ``sys.path``. Importing the file under a bare name leaves
``__package__`` empty, the dot has nothing to resolve against, and Python
raises ``ImportError: attempted relative import with no known parent package``
about a file that is correct. That is our failure wearing the student's name,
and no ``sys.path`` entry can repair it, because a relative import does not
consult ``sys.path`` at all.

So a directory that looks like a package is imported as one, under a synthetic
package name that no student file can collide with. Two directories both named
``core``, in one repository or in two, get different synthetic names, so
neither can shadow the other.

Looking like a package does not require ``__init__.py``. Measured across the
thirteen 2026 repositories on 2026-08-20: zero contain an ``__init__.py``
anywhere, and one (``LashikaKapoor28/Vision_Module_Capstone``) has a ``core/``
directory whose ``database.py`` imports its neighbours with dots. Requiring
the marker file would have recovered nothing that is actually broken. A
directory therefore qualifies when it holds an ``__init__.py`` **or** when one
of its files uses a relative import, because the second is a student declaring
a package in the only other way Python accepts.
"""

from __future__ import annotations

import __future__
import ast
import builtins
import contextlib
import importlib.machinery
import importlib.util
import io
import itertools
import json
import os
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

__all__ = [
    "STUBBED_MODULES",
    "stubbed_now",
    "SKIPPED_DIRECTORIES",
    "LoadedModule",
    "SkippedModule",
    "RootChoice",
    "Discovery",
    "Survey",
    "candidate_roots",
    "choose_root",
    "is_package_directory",
    "notebook_source",
    "load_modules",
    "discover",
    "survey",
]

#: Absent from every sandbox image and never on a scored path. Measured across
#: the thirteen 2026 repositories: ``streamlit`` appears in 13 module-scope
#: imports, ``microphone`` in 9, ``pyaudio`` in 1. A stub keeps a module
#: importable when it mentions one of these for a demo or a recording helper.
#: Anything else missing is reported, never invented.
#:
#: ``networkx`` was the fourth entry and was removed on 2026-08-20. The Week 2
#: image installs ``networkx==3.1`` (see `cogbench.environment.WEEK2_TRACK`; it
#: is a scikit-image runtime dependency, named there so a scikit-image bump
#: cannot drop it), and the Week 2 capstone's own Whispers code imports it
#: (docs/capstones/week2-vision-capstone.md:408). So on the one track that has
#: the package and uses it for scored clustering, a working install was being
#: replaced by a stand-in. Measured on a repository whose module does
#: ``import networkx as nx``: the module's ``nx`` resolved to a ``_Stub`` with
#: no ``__file__``, and calling its clustering function raised
#: "networkx.Graph is not available here, and this used what it returned". The
#: same repository with the real package returns the right clusters. That is a
#: fabricated failure attributed to the student.
#:
#: Removing it is not free, and the cost is the reason `_install_stubs` now
#: checks rather than assumes. networkx is genuinely absent from the Week 1 and
#: Week 3 images, so on those two tracks the stub was honest, and a plain
#: removal would turn a module that imports networkx from readable into
#: skipped. The check gives both tracks the right answer from one list: stub
#: where the package is missing, stand aside where it is installed.
#: ``camera`` joined on 2026-09-02 for the same reason as ``microphone``: it
#: is the course's webcam helper, it is absent from all three images, and no
#: scored path takes a picture. A module that imports it for a demo now yields
#: its functions instead of being skipped.
STUBBED_MODULES = ("streamlit", "microphone", "pyaudio", "camera")

#: Never searched for student code.
SKIPPED_DIRECTORIES = frozenset(
    {
        ".git",
        ".github",
        "__pycache__",
        ".ipynb_checkpoints",
        "venv",
        ".venv",
        "env",
        "node_modules",
        "site-packages",
        "build",
        "dist",
        ".pytest_cache",
        ".mypy_cache",
    }
)

#: How deep below the repository root a code directory may sit. Two covers
#: every audited layout: ``code/``, ``Individual stuff/``, ``Week1/``, and
#: ``src/cogworks/``.
MAX_ROOT_DEPTH = 2

#: Wall clock for importing one module. Importing runs whatever a file does at
#: module level, and files do real work there: one 2026 repository tunes a
#: threshold across 25 iterations while being imported, which took 77 seconds
#: of a 77-second run, and another could loop forever with nothing to report at
#: all, because the report is written after discovery finishes.
#:
#: Thirty seconds is well past anything a definition file needs -- the slowest
#: legitimate import in the corpus builds a FaceNet model -- and well short of
#: a student giving up. A module that exceeds it is skipped and named, so the
#: search continues without it and the report says which file it was.
IMPORT_TIMEOUT_SECONDS = 30.0


class _Stub(ModuleType):
    """Stands in for an absent interface or hardware package.

    Every attribute is a callable returning ``None``, and every call is
    recorded. A module that only mentions one of these at import scope loads;
    one that depends on a return value fails later, in its own frame, and the
    record says which stub it reached for.

    Submodules stand in too. ``from microphone.config import settings`` is the
    real line in one 2026 repository, and stubbing only the top name left that
    import failing with the package supposedly stubbed, which cost that team
    their spectrogram module and their score.
    """

    def __init__(self, name: str, calls: List[str]) -> None:
        super().__init__(name)
        self._Stub__calls = calls
        # importlib refuses a module whose __spec__ is None with
        # "ValueError: networkx.__spec__ is None", which student code hits when
        # it imports a submodule of a stubbed package.
        self.__spec__ = importlib.machinery.ModuleSpec(name, None)
        self.__path__: List[str] = []

    def records_into(self, calls: List[str]) -> None:
        """Record later calls into this run's list rather than an earlier one.

        A stub outlives the discovery that made it, and the callables it hands
        out close over whichever list they were given. See ``_install_stubs``.
        """

        self._Stub__calls = calls

    def __getattr__(self, attribute: str):  # noqa: D105 - see class docstring
        if attribute.startswith("__"):
            raise AttributeError(attribute)
        name = "{}.{}".format(self.__name__, attribute)

        def _recorded(*_args, **_kwargs):
            self._Stub__calls.append(name)
            return _Absent(name)

        _recorded.__name__ = attribute
        return _recorded


class _Absent:
    """What a stubbed call returns, so a later failure names the stub.

    Returning ``None`` made a module doing ``frames, rate = record_audio(5)``
    fail with "cannot unpack non-iterable NoneType object". True, and useless:
    it describes our stand-in rather than the microphone that is not here, and
    a student reading it would go looking for a bug in their own unpacking.
    """

    __slots__ = ("_origin",)

    def __init__(self, origin: str) -> None:
        self._origin = origin

    def _complain(self, *_args, **_kwargs):
        raise RuntimeError(
            "{} is not available here, and this used what it returned".format(
                self._origin
            )
        )

    __iter__ = _complain
    __call__ = _complain
    __len__ = _complain
    __getitem__ = _complain
    __add__ = _complain
    __sub__ = _complain
    __mul__ = _complain
    __array__ = _complain

    def __getattr__(self, attribute: str):
        if attribute.startswith("_"):
            raise AttributeError(attribute)
        return self._complain()

    def __repr__(self) -> str:
        return "<{} is not available here>".format(self._origin)

    def __bool__(self) -> bool:
        # A module guarding with `if record_audio(...)` should take the false
        # branch rather than raise: that branch is the one that runs on a
        # machine with no microphone.
        return False


@dataclass(frozen=True)
class LoadedModule:
    """One module that imported, and where it came from."""

    name: str
    path: Path
    module: ModuleType
    #: ``"file"`` for a ``.py``, ``"notebook"`` for definitions lifted out of
    #: an ``.ipynb``. A notebook module never ran the notebook's statements,
    #: which matters when explaining why one of its functions failed.
    origin: str

    #: The directory this module was imported from, when importing it from
    #: the working directory failed and importing it from its own folder
    #: worked. Recorded because it changes what their relative reads found,
    #: and a student reading the report should know we moved.
    cwd_hint: Optional[Path] = None
    #: Whether this module was compiled with ``from __future__ import
    #: annotations`` after a name in one of its type annotations turned out
    #: not to exist. Their functions behave identically; only the annotation
    #: stops being evaluated.
    future_annotations: bool = False
    #: Basenames whose path was answered from the benchmark's own copy,
    #: because the path their code names is not on this machine.
    redirected: Tuple[str, ...] = ()


@dataclass(frozen=True)
class SkippedModule:
    """One module that did not import, in words a student can act on."""

    name: str
    path: Path
    #: ``"missing_dependency"``, ``"raised"``, ``"timeout"``, or ``"syntax"``.
    reason: str
    detail: str
    #: The import that was not satisfiable, when that is what went wrong.
    missing: Optional[str] = None


def owner_of_skip(entry: "SkippedModule", benchmark: str = "") -> str:
    """Whose problem a skipped module is: ours, the environment's, or theirs.

    The distinction decides what the platform is allowed to say. A module we
    could not read because this machine lacks a package the graded run
    installs is an absence we manufactured, and a verdict blaming the
    repository for it is false. One genuinely absent from the graded run too
    is worth naming, because the graded run fails the same way. A syntax
    error is theirs.

    ``benchmark`` selects the graded environment, because there are three and
    they differ: Week 2 runs on Python 3.11 with torch and opencv, Week 1 and
    Week 3 on a pinned 3.8 with their own package sets. Without it, the union
    is used, which errs toward calling a skip ours. That is the safe
    direction: it withholds a verdict rather than asserting a wrong one.
    """

    if entry.reason == "missing_dependency" and entry.missing:
        from . import environment

        if benchmark:
            graded = environment.student_modules(environment.track_for(benchmark))
        else:
            graded = environment.all_student_modules()
        root = entry.missing.split(".", 1)[0]
        return "ours" if root in graded else "environment"
    return "theirs"


#: How a root was chosen. `kind` is what code branches on; `reason` is the
#: sentence the report prints. They were one field, and a caller downstream
#: decided whether to read sibling folders by searching the sentence for
#: "matches this week", so rewording the report changed which files were
#: imported. They are separate now.
ROOT_DECLARED = "declared"
ROOT_HINTED = "hinted"
ROOT_REPOSITORY = "repository"
ROOT_IMPORTED_FROM = "imported_from"
ROOT_MOST_FILES = "most_files"

#: The kinds that mean "the student pointed at one week's folder", so the other
#: weeks in the same repository are not this week's code.
WEEK_SCOPED_ROOTS = frozenset({ROOT_DECLARED, ROOT_HINTED})


@dataclass(frozen=True)
class RootChoice:
    """Which directory was searched, and why that one."""

    path: Path
    reason: str
    considered: Tuple[Path, ...]
    kind: str = ROOT_REPOSITORY


@dataclass
class Discovery:
    """Everything found in one repository, and everything that was not."""

    root: RootChoice
    modules: List[LoadedModule] = field(default_factory=list)
    skipped: List[SkippedModule] = field(default_factory=list)
    stub_calls: List[str] = field(default_factory=list)
    #: The packages this run actually stood in for, which is not the same as
    #: the packages it was willing to. A listed package that turned out to be
    #: installed is not stubbed and must not be reported as though it were.
    stubbed: List[str] = field(default_factory=list)

    @property
    def namespace(self) -> List[ModuleType]:
        """What a benchmark's resolver walks. Order is deterministic."""

        return [entry.module for entry in self.modules]

    def to_dict(self) -> Dict[str, object]:
        """A record for the run, small enough to store and read."""

        return {
            "root": str(self.root.path),
            "rootReason": self.root.reason,
            "considered": [str(path) for path in self.root.considered],
            "modules": [_module_record(entry) for entry in self.modules],
            "skipped": [
                {
                    "name": entry.name,
                    "path": str(entry.path),
                    "reason": entry.reason,
                    "detail": entry.detail,
                    "missing": entry.missing,
                }
                for entry in self.skipped
            ],
            # What was replaced on this run, not what the list allows. The two
            # differ whenever a listed package is installed here, and reporting
            # the constant claimed an absence that was not real.
            "stubbed": list(self.stubbed),
            "stubCalls": sorted(set(self.stub_calls)),
        }


def _module_record(entry: "LoadedModule") -> Dict[str, object]:
    """One module in the record, and anything unusual it took to read it.

    The optional keys are absent when nothing unusual happened, so the record
    for an ordinary repository is exactly the one it produced before any of
    this existed.
    """

    record: Dict[str, object] = {
        "name": entry.name,
        "path": str(entry.path),
        "origin": entry.origin,
    }
    if entry.cwd_hint is not None:
        record["importedFrom"] = str(entry.cwd_hint)
        record["note"] = "imported from its own folder"
    if entry.future_annotations:
        record["futureAnnotations"] = True
    if entry.redirected:
        record["redirected"] = list(entry.redirected)
        record["redirectNote"] = [
            "their path to {} was redirected to the benchmark's copy".format(name)
            for name in entry.redirected
        ]
    return record


def _python_files(directory: Path) -> List[Path]:
    return sorted(
        path
        for path in directory.glob("*.py")
        if path.is_file() and not path.name.startswith(".")
    )


def _notebooks(directory: Path) -> List[Path]:
    return sorted(
        path
        for path in directory.glob("*.ipynb")
        if path.is_file() and ".ipynb_checkpoints" not in path.parts
    )


def candidate_roots(repository: Path, *, max_depth: int = MAX_ROOT_DEPTH) -> List[Path]:
    """Every directory that could hold the week's code, shallowest first.

    A directory qualifies by holding at least one importable file. The
    repository root is always considered, even when empty, so a repository
    with no code at all still produces a root to report rather than an
    exception.
    """

    found: List[Path] = []
    seen = set()

    def _visit(directory: Path, depth: int) -> None:
        if directory in seen:
            return
        seen.add(directory)
        if _python_files(directory) or _notebooks(directory):
            found.append(directory)
        if depth >= max_depth:
            return
        try:
            children = sorted(directory.iterdir())
        except OSError:
            # Measured on a fixture holding one mode-000 folder: the
            # PermissionError left `choose_root` and ended `discover`, so the
            # whole repository was lost over a directory that could not have
            # held code we were able to read anyway.
            return
        for child in children:
            if not child.is_dir():
                continue
            if child.name in SKIPPED_DIRECTORIES or child.name.startswith("."):
                continue
            _visit(child, depth + 1)

    _visit(repository, 0)
    if repository not in found:
        found.insert(0, repository)
    return found


def choose_root(
    repository: Path,
    *,
    declared: Optional[str] = None,
    hints: Sequence[str] = (),
) -> RootChoice:
    """Pick the directory to search, and say why.

    ``declared`` wins outright: a team that named its root has answered the
    question. Otherwise a directory whose name matches one of ``hints`` (the
    week's own words, supplied by the benchmark) wins, because a folder called
    ``Week1`` is a statement of intent. Failing that, the directory holding the
    most importable files wins, ties going to the shallower one, because the
    alternative is guessing between two equally plausible roots.

    Hints are tried in the order the benchmark listed them, which is most
    specific first: week 3 supplies ``("week3", "week 3", "language",
    "search", "capstone")``. Any hint used to match any folder, so in a
    repository holding ``week1_capstone`` and ``week3``, a week 3 search took
    ``week1_capstone`` on the generic ``capstone`` hint because that folder
    sorts first. A named week now beats a shared word.
    """

    considered = tuple(candidate_roots(repository))

    if declared:
        path = (repository / declared).resolve()
        return RootChoice(path, "declared in cogworks.toml", considered, ROOT_DECLARED)

    for hint in (hint.lower() for hint in hints):
        for path in considered:
            if path == repository:
                continue
            name = path.name.lower().replace(" ", "").replace("-", "").replace("_", "")
            if hint in name:
                return RootChoice(
                    path, "directory name matches this week", considered, ROOT_HINTED
                )

    scored = [(path, _root_score(path)) for path in considered]
    best, score = min(scored, key=lambda pair: (-pair[1], len(pair[0].parts)))
    if best == repository:
        return RootChoice(
            repository, "code sits at the repository root", considered, ROOT_REPOSITORY
        )
    if score > 0:
        return RootChoice(
            best, "the rest of the code imports from here", considered, ROOT_IMPORTED_FROM
        )
    return RootChoice(best, "holds the most importable files", considered, ROOT_MOST_FILES)


def _module_names(directory: Path) -> set:
    return {path.stem for path in _python_files(directory)} | {
        path.stem for path in _notebooks(directory)
    }


def _uses_relative_import(path: Path) -> bool:
    """Whether this file imports a neighbour with a leading dot.

    Read with ``ast`` rather than imported, because deciding how to import a
    file cannot require importing it first. A file this cannot parse is not a
    package signal: it is a file with a syntax error, and it is reported as
    one later.
    """

    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, SyntaxError, ValueError):
        return False
    return any(
        isinstance(node, ast.ImportFrom) and (node.level or 0) > 0
        for node in ast.walk(tree)
    )


def is_package_directory(directory: Path) -> bool:
    """Whether this directory must be imported as one unit rather than as files.

    Two signals, either one sufficient:

    ``__init__.py`` is the declaration Python has always recognised. A student
    who wrote one meant a package, and the file itself may run setup the rest
    of the directory depends on.

    A relative import is the same statement made a different way. ``from
    .profile import Profile`` cannot resolve unless the importing module has a
    package, so a directory containing one is a package whether or not it was
    marked. Measured on the 2026 corpus: zero of thirteen repositories carry
    an ``__init__.py``, and the single directory using relative imports has
    none, so requiring the marker would recover nothing.

    Notebooks are not consulted. A notebook is imported from lifted
    definitions rather than from its file, so it has no package to belong to.
    """

    if (directory / "__init__.py").is_file():
        return True
    return any(_uses_relative_import(path) for path in _python_files(directory))


def _imported_names(path: Path) -> set:
    """Top-level module names this file imports, without importing it."""

    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, SyntaxError, ValueError):
        return set()
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


def _root_score(directory: Path) -> int:
    """How much of this directory's own code the directory itself supplies.

    A pipeline imports itself: ``match.py`` does ``from database import load``.
    A scratch or test directory imports the pipeline instead, and supplies
    little of what it uses. Counting satisfied sibling imports separates the
    two without knowing any project's vocabulary, which raw file counts do not:
    one audited repository keeps fifteen throwaway scripts in ``tests_manual``
    beside the seven files that are the capstone.
    """

    local = _module_names(directory)
    if not local:
        return 0
    satisfied = 0
    for path in _python_files(directory):
        satisfied += len((_imported_names(path) & local) - {path.stem})
    return satisfied


def notebook_source(path: Path) -> Optional[str]:
    """The definitions in a notebook, as module source, or ``None``.

    A notebook is a transcript of an exploration, not a module: across the
    audited repositories only four of thirty-five hold nothing but definitions,
    so importing the cells as written would run training loops and plots. What
    is wanted is the part a module would have: imports, functions, classes, and
    assignments of plain literals (a notebook that opens with ``database = {}``
    means it).

    Everything else is dropped. That is why a function lifted out of a notebook
    can still fail with ``NameError`` on a global its cells built at run time,
    and why the skip record says the module came from a notebook.
    """

    try:
        document = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return None

    cells = document.get("cells")
    if not isinstance(cells, list):
        return None

    lines: List[str] = []
    for cell in cells:
        if not isinstance(cell, dict) or cell.get("cell_type") != "code":
            continue
        source = cell.get("source")
        if isinstance(source, list):
            text = "".join(str(part) for part in source)
        elif isinstance(source, str):
            text = source
        else:
            continue
        # Shell escapes and magics are notebook syntax, not Python.
        lines.extend(
            line
            for line in text.splitlines(keepends=True)
            if not line.lstrip().startswith(("!", "%", "?"))
        )
        # A cell boundary is a line break. A notebook stores a cell without a
        # trailing newline whenever its last line has none, and joining the
        # cells as written glues the last line of one onto the first line of
        # the next. Counted on the 2026 corpus on 2026-09-02: 118 such
        # boundaries in Cog-gurts' week 1 repository, 174 in their week 2 one,
        # 11 in rutvim's. One of rutvim's produces `import uuidclass
        # SongMetadata:`, which was reported to that team as a syntax error in
        # a file they wrote correctly.
        if lines and not lines[-1].endswith("\n"):
            lines[-1] = lines[-1] + "\n"

    text = "".join(lines)
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return None

    kept: List[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kept.append(node)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            kept.append(node)
        elif isinstance(node, ast.Assign) and _is_plain_literal(node.value):
            kept.append(node)
    if not any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        for node in kept
    ):
        return None

    # Their own text for each kept node rather than `ast.unparse`, which is
    # 3.9+ while this package declares 3.8 and the hosted week 1 and week 3
    # venvs run CPython 3.8.20; measured on CI, every notebook test errored
    # there. Keeping the source also keeps their comments and formatting.
    source_lines = text.splitlines(keepends=True)
    return "\n".join(
        segment
        for segment in (_lifted_segment(text, source_lines, node) for node in kept)
        if segment
    )


def _is_plain_literal(node: ast.expr) -> bool:
    """Whether an assigned value is one a module can hold without running code.

    Python has no negative literals: ``THRESHOLD = -1`` parses as a unary
    minus over ``1``. Rejecting that dropped the constant while keeping the
    function that reads it, and the function then failed with ``NameError:
    name 'THRESHOLD' is not defined`` on a line the student wrote correctly.
    """

    if isinstance(node, (ast.Constant, ast.Dict, ast.List, ast.Tuple, ast.Set)):
        return True
    return (
        isinstance(node, ast.UnaryOp)
        and isinstance(node.op, (ast.USub, ast.UAdd))
        and isinstance(node.operand, ast.Constant)
        and isinstance(node.operand.value, (int, float, complex))
    )


def _lifted_segment(
    text: str, lines: Sequence[str], node: ast.stmt
) -> Optional[str]:
    """One kept statement's own text, decorators and all.

    The statement comes from ``ast.get_source_segment``, which gives its exact
    span. Taking whole lines instead was wrong: a cell can put two statements
    on one line, and ``import math; plt.show()`` then carried the call the
    filter had just discarded back into the lifted module, which is the one
    thing lifting exists to prevent.

    Decorators have to be put back in front, because that span starts at the
    ``def`` or ``class`` line. A lifted ``@dataclass class Song`` came out as
    a plain class with annotations and no ``__init__``, so the team's own
    ``Song("Hey")`` raised ``TypeError: Song() takes no arguments`` against a
    notebook that is correct. A decorator sits on its own line, so those lines
    are taken whole.
    """

    segment = ast.get_source_segment(text, node)
    if segment is None:
        return None
    decorators = getattr(node, "decorator_list", ())
    if not decorators:
        return segment
    first = min(decorator.lineno for decorator in decorators)
    # The ``@`` belongs to no node. It shares the decorator's line in the
    # ordinary case; for ``@(\n    deco\n)``, which 3.9 allows, the
    # expression starts a line later and slicing from there left a stray
    # closing bracket that would not compile.
    while first > 1 and not lines[first - 1].lstrip().startswith("@"):
        first -= 1
    if first >= node.lineno:
        return segment
    return "".join(lines[first - 1:node.lineno - 1]) + segment


@contextlib.contextmanager
def _quiet_import():
    """Import with no console of its own.

    One audited repository prints ``Please play the song now!`` and then blocks
    on ``input()`` at module scope. Closing stdin turns that block into an
    ``EOFError`` the loader records, which is a skipped module rather than a
    hung run.
    """

    saved = (sys.stdin, sys.stdout, sys.stderr)
    sys.stdin = io.StringIO()
    sys.stdout = io.StringIO()
    sys.stderr = io.StringIO()
    try:
        yield
    finally:
        sys.stdin, sys.stdout, sys.stderr = saved


class _StubFinder:
    """Answers for any submodule of a stubbed package.

    ``from microphone.config import settings`` is a real line in the 2026
    corpus. Stubbing only the top-level name left that import failing, which
    cost one team the module holding their spectrogram. The submodule cannot
    be registered up front because there is no way to know which ones a
    repository will ask for, so this answers on demand, at the point the
    import machinery looks.

    Scoped to the packages this run actually stood in for, and nothing else:
    an unrelated missing package still fails and is still named in the report,
    and a listed package that turned out to be installed keeps its own real
    submodules.
    """

    def __init__(self, calls: List[str], installed: Sequence[str]) -> None:
        self._calls = calls
        #: Only the top-level names this run actually stood in for. See _owns.
        self._installed = tuple(installed)

    def find_module(self, name: str, path=None):  # Python 3.8 compatibility
        return self if self._owns(name) else None

    def load_module(self, name: str):
        module = sys.modules.get(name)
        if module is None:
            module = sys.modules[name] = _Stub(name, self._calls)
        return module

    def find_spec(self, name: str, path=None, target=None):
        if not self._owns(name):
            return None
        return importlib.machinery.ModuleSpec(name, self)

    def create_module(self, spec):
        return _Stub(spec.name, self._calls)

    def exec_module(self, module):
        return None

    def _owns(self, name: str) -> bool:
        """Whether this is a submodule of a package we actually stood in for.

        The parent check is the load-bearing half. This finder sits first on
        ``sys.meta_path``, so it answers before the real path finder, and
        matching on the name alone meant it shadowed submodules of a package
        that is really installed. Measured with the real networkx present and
        imported: ``networkx.algorithms.approximation.tests.test_clique``
        resolved to a ``_Stub`` even though the file is on disk, and the local
        install has 294 such submodules. Only the top-level names this run
        actually replaced are owned here.
        """

        return any(name.startswith(stub + ".") for stub in self._installed)


def _install_stubs(calls: List[str]) -> List[str]:
    """Stand in for the listed packages, but only where they are truly absent.

    The check is the point. A stub reproduces an absence the scoring
    environment has; standing in for a package that is installed does the
    opposite, and turns working code into a failure the student gets blamed
    for. That is not hypothetical: ``networkx`` sat on the list while the Week
    2 image installed it, so real clustering code was fabricated into a
    RuntimeError. See ``STUBBED_MODULES``.

    ``find_spec`` locates a package without running it, so a heavy install is
    not imported just to find out it is there. A name already in
    ``sys.modules`` is left alone, as before: something imported it, so it
    exists in whatever form the process already has.

    Deliberately no coupling to `cogbench.environment` here. That module says
    what each image declares, and this needs to know what this interpreter can
    actually import, which also covers transitive packages no manifest lists
    and covers a student's laptop, which no manifest describes.
    """

    for name in STUBBED_MODULES:
        if name in sys.modules:
            continue
        try:
            present = importlib.util.find_spec(name) is not None
        except Exception:  # noqa: BLE001 - any finder on the path may raise
            # A broken installation cannot be imported either, so standing in
            # for it is still the honest answer. Every exception, not a list
            # of four: a finder already on `sys.meta_path` raising `OSError`
            # ended the whole discovery before a single module was read, and
            # what a third-party finder raises is not ours to enumerate.
            present = False
        if present:
            continue
        sys.modules[name] = _Stub(name, calls)

    # Every stub in the process records into this run's list. A stub is
    # reused across discoveries in one interpreter, and its callables closed
    # over whichever list was passed the first time: the second repository's
    # stub calls were appended to the first repository's record and missing
    # from its own. Submodule stubs are reached the same way, and they are
    # built by the finder rather than by the loop above.
    for module in list(sys.modules.values()):
        if isinstance(module, _Stub):
            module.records_into(calls)

    # What the finder owns is read back from the process rather than taken
    # from the loop above, and the difference is a bug that was caught here.
    # Discovery runs more than once per interpreter (`cogworks check` resolves,
    # then the benchmark resolves again), and the second run adds nothing
    # because the stubs are already in `sys.modules`. Owning only the newly
    # added names left the second run with no finder at all, so
    # `from microphone.config import settings` failed on every repository
    # after the first.
    stubbed = stubbed_now()
    # Rebuilt rather than reused: a finder from an earlier run owns whatever
    # that run stubbed, which is not necessarily what this one did.
    sys.meta_path[:] = [
        finder for finder in sys.meta_path if not isinstance(finder, _StubFinder)
    ]
    if stubbed:
        sys.meta_path.insert(0, _StubFinder(calls, stubbed))
    return stubbed


def stubbed_now() -> List[str]:
    """Which listed packages are standing in right now, read from the process.

    Asked after the imports rather than returned from `_install_stubs` because
    `load_modules` is exported and widening its return tuple would break a
    caller that unpacks three values. `sys.modules` is where the answer already
    lives, and reading it there cannot drift from what actually happened.
    """

    return [
        name
        for name in STUBBED_MODULES
        if isinstance(sys.modules.get(name), _Stub)
    ]


def _said(error: BaseException) -> str:
    """What an exception says, when asking it is safe.

    Formatting the failure runs the student's own ``__str__``. One that
    raises, or returns something that is not a string, carried the exception
    back out of the import and ended the whole discovery, while the record
    being built was the thing meant to contain it.
    """

    try:
        return str(error)[:200]
    except Exception:  # noqa: BLE001 - their exceptions format however they like
        return "(its message could not be read)"


def _missing_module(error: BaseException) -> Optional[str]:
    return getattr(error, "name", None) if isinstance(error, ImportError) else None


class _ImportTimeout(BaseException):
    """Raised inside the importing thread when a module runs too long.

    Deliberately a BaseException: student code catches Exception liberally,
    and a timeout a module can swallow is not a timeout.
    """


@contextlib.contextmanager
def _deadline(seconds: float, name: str):
    """Interrupt an import that will not finish.

    Uses a timer that raises in the main thread, which is where the import
    runs. It cannot stop a call that never returns to the interpreter, such as
    one blocked in a C extension, so it is a limit on ordinary Python work
    rather than a guarantee. `cogbench.isolate` is the guarantee, and the
    hosted runner puts the whole resolution inside it.
    """

    import ctypes
    import threading

    done = threading.Event()

    def _interrupt() -> None:
        if done.is_set():
            return
        ctypes.pythonapi.PyThreadState_SetAsyncExc(
            ctypes.c_ulong(threading.main_thread().ident or 0),
            ctypes.py_object(_ImportTimeout),
        )

    timer = threading.Timer(seconds, _interrupt)
    timer.daemon = True
    timer.start()
    try:
        yield
    finally:
        done.set()
        timer.cancel()


#: Prefix for the synthetic package names discovery invents. A student file
#: cannot collide with it: a module name has to be a Python identifier, this
#: one starts with an underscore and carries a counter, and nothing in the
#: 2026 corpus is named anything like it. The counter is what keeps two
#: directories called ``core`` apart, in one repository or across two.
_PACKAGE_PREFIX = "_cogbench_pkg_"

#: Modules a student's file displaced from `sys.modules` during one
#: discovery, by name, put back when it leaves. Filled by `_import_one`.
_DISPLACED: Dict[str, ModuleType] = {}

#: The names in `sys.modules` when discovery entered: the real modules a
#: student's file may not take a dotted name from.
_PREEXISTING: set = set()


def _is_installed(module: ModuleType) -> bool:
    """Whether a module belongs to the interpreter or its site-packages.

    A builtin or frozen module has no file. Anything else is installed
    when its file sits under one of the interpreter's own library paths,
    which is what separates `json` from a `database.py` some other code
    imported by bare name.
    """

    import sysconfig

    file = getattr(module, "__file__", None)
    if not file:
        return True
    where = str(Path(file).resolve())
    roots = {str(Path(p).resolve()) for p in sysconfig.get_paths().values() if p}
    roots.update(str(Path(p).resolve()) for p in (sys.prefix, sys.base_prefix))
    return any(where.startswith(root + os.sep) or where == root for root in roots)

#: Never restarted within a process. Restarting it would let the second
#: repository scored in one interpreter reuse the first one's package names,
#: which is the shadowing this whole mechanism exists to prevent.
_package_counter = itertools.count()


class _PackageLoader(importlib.machinery.SourceFileLoader):
    """Runs one student file as a member of a synthetic package.

    Two names are in play and they are deliberately different.

    ``__spec__.name`` is the dotted synthetic one
    (``_cogbench_pkg_0_core.database``). The import machinery uses it, and it
    is what makes ``__package__`` non-empty, which is the entire reason a
    relative import can resolve.

    ``__name__`` is the bare stem (``database``). Everything a student reads
    uses that: the skip report, the wiring log, and
    ``pipeline.callables_in``, which keeps a function only when
    ``function.__module__`` equals the module's ``__name__``. Leaving the
    dotted name on ``__name__`` would make every function in a package look
    imported from elsewhere, and the resolver would discard all of them.
    Setting ``__name__`` in ``create_module`` is enough, because the function
    objects read it out of the module globals as they are defined.

    Subclassing ``SourceFileLoader`` rather than compiling the text here keeps
    the standard reader: source encoding declarations, ``\r\n`` line endings,
    and ``SyntaxError`` line numbers all stay exactly as they were.
    """

    #: The module this file had already produced, when it had. Recorded in
    #: `create_module` because that is the last moment the two can be told
    #: apart: by `exec_module` the import machinery has given the new module
    #: this file's `__file__` as well.
    _reused: Optional[ModuleType] = None

    def create_module(self, spec):
        # One module object per source file, the rule `_import_one` applies.
        # This loader is the other place a repository file is executed. A
        # member reached first by a sibling's `import core.b`, which the
        # ordinary import system serves under the directory's own name, is
        # reached again as `<synthetic>.b` by a relative import, and running
        # it twice gave the directory two copies with independent globals.
        self._reused = _already_executed(Path(self.path))
        module = ModuleType(spec.name.rpartition(".")[2])
        # The dotted parent is what a leading dot resolves against.
        module.__package__ = spec.parent
        return module

    def exec_module(self, module) -> None:
        if self._reused is not None:
            # The import machinery re-reads `sys.modules[spec.name]` once this
            # returns, which is how a loader hands back the object that
            # already exists instead of a second copy of it.
            sys.modules[self.name] = self._reused
            return
        # self.name, not module.__name__: the base class checks the code it
        # hands back against the name the loader was built with, and the bare
        # stem fails that check with "loader cannot handle database".
        exec(self.get_code(self.name), module.__dict__)


class _PackageFinder:
    """Answers for the modules of one synthetic package, and nothing else.

    Scoped to a single directory and a single package name. A relative import
    inside that package asks the import machinery for
    ``_cogbench_pkg_0_core.normalize``; nothing else in the process can ask
    for that name, so this finder cannot affect any other import.
    """

    def __init__(self, package: str, directory: Path) -> None:
        #: Public so the teardown in `_entered` can drop a finder whose
        #: package it just evicted. A finder that outlives its package
        #: answers for a name whose module no longer exists.
        self.package = package
        self._directory = directory

    def find_spec(self, name: str, path=None, target=None):
        parent, _, stem = name.rpartition(".")
        if parent != self.package or not stem:
            return None
        source = self._directory / (stem + ".py")
        if not source.is_file():
            return None
        return importlib.util.spec_from_file_location(
            name, source, loader=_PackageLoader(name, str(source))
        )


def _register_package(directory: Path) -> str:
    """Create the package object a directory's modules will belong to.

    The package's own ``__name__`` stays synthetic, which looks wrong and is
    load-bearing. CPython resolves ``from . import sibling`` by formatting
    ``"{}.{}".format(package.__name__, "sibling")`` and importing that.
    Measured on 2026-08-20 with a friendly ``__name__`` of ``core``: the
    import machinery was asked for the top-level name ``core`` and raised
    ``ModuleNotFoundError: No module named 'core'``, because the synthetic
    package is registered under the synthetic name. The synthetic name is
    never shown to a student; only module ``__name__`` values are, and those
    are bare stems.

    An ``__init__.py`` is executed as the package body, so a package whose
    setup lives there gets that setup. A failure there is deliberately not
    caught: the caller records it against ``__init__`` like any other module,
    and the directory's modules are then imported without it.
    """

    package = "{}{}_{}".format(
        _PACKAGE_PREFIX, next(_package_counter), _safe_suffix(directory.name)
    )
    module = ModuleType(package)
    spec = importlib.machinery.ModuleSpec(package, None, is_package=True)
    spec.submodule_search_locations = [str(directory)]
    module.__spec__ = spec
    module.__path__ = [str(directory)]
    module.__package__ = package
    # Set before the body runs, because the body may read it: an
    # ``__init__.py`` doing ``Path(__file__).parent`` to find a data file
    # beside it is ordinary, and without this it died with ``NameError: name
    # '__file__' is not defined``.
    initializer = directory / "__init__.py"
    if initializer.is_file():
        module.__file__ = str(initializer)
    sys.modules[package] = module
    sys.meta_path.insert(0, _PackageFinder(package, directory))
    return package


def _already_executed(path: Path) -> Optional[ModuleType]:
    """The module this file has already produced during this discovery.

    Judged against the modules present before discovery entered, so a module
    the interpreter already had, or a previous repository left behind, is
    never mistaken for this run's.

    Read out of ``__dict__`` rather than with ``getattr``: a module may define
    its own ``__getattr__``, and comparing two paths is not a reason to run a
    student's code.
    """

    wanted = os.path.realpath(str(path))
    basename = path.name
    for name, module in list(sys.modules.items()):
        if name in _PREEXISTING or module is None:
            continue
        try:
            namespace = getattr(module, "__dict__", None)
            origin = namespace.get("__file__") if isinstance(namespace, dict) else None
            # The cheap comparison first: this runs once per file against
            # every module in the process.
            if not origin or os.path.basename(str(origin)) != basename:
                continue
            if os.path.realpath(str(origin)) == wanted:
                return module
        except Exception:  # noqa: BLE001 - anything can be put in sys.modules
            continue
    return None


def _live_package(directory: Path) -> Optional[str]:
    """The package a student's own import already made for this directory.

    A root script's ``import core.database`` loads ``core`` through the
    ordinary import system, and that is a real package holding this directory
    on its ``__path__``. Registering a synthetic one beside it gave every
    member two module objects, so the file ran twice and the copy discovery
    reported was the one that never saw their setup.

    Reusing theirs is also what keeps their relative imports resolving to the
    objects discovery reports, since the members are then looked up under one
    package name rather than two.
    """

    wanted = os.path.realpath(str(directory))
    for name, module in list(sys.modules.items()):
        if name in _PREEXISTING or module is None:
            continue
        try:
            namespace = getattr(module, "__dict__", None)
            locations = namespace.get("__path__") if isinstance(namespace, dict) else None
            if not locations:
                continue
            entries = [str(entry) for entry in locations]
        except Exception:  # noqa: BLE001 - anything can be put in sys.modules
            continue
        # Exactly this directory, not merely among its locations. A package
        # with no ``__init__.py`` is a namespace package, and Python merges
        # every ``core/`` it finds across ``sys.path`` into one ``__path__``.
        # Adopting it for each of them in turn filed two different files under
        # one dotted name, and the second overwrote the first.
        if len(entries) == 1 and os.path.realpath(entries[0]) == wanted:
            return name
    return None


def _dotted(package: str, path: Path) -> str:
    """The name a package member is filed under.

    Always the file's stem, never the folder-qualified name the report may
    show, so the loader, `_execute` and `_forget` agree on one key.
    """

    return "{}.{}".format(package, path.stem)


def _safe_suffix(name: str) -> str:
    """The directory name reduced to something legal in a module name.

    Only for reading: a traceback that says ``_cogbench_pkg_0_core`` is easier
    to place than one that says ``_cogbench_pkg_0``. Directories in this
    corpus are called things like ``Individual stuff`` and ``Day 4``, which
    are not identifiers, so anything else becomes an underscore. The counter
    in front already guarantees uniqueness, so a collision here is harmless.
    """

    cleaned = "".join(character if character.isalnum() else "_" for character in name)
    return cleaned or "dir"


def _forget(name: str, package: Optional[str], path: Path) -> None:
    """Remove a failed module under both names it could have been filed under.

    A module that raised is half-executed, and leaving it in ``sys.modules``
    would let the next importer receive that half. The bare name is removed
    only when it points at this module: on a stem collision it belongs to the
    chosen root's copy, which is still good.

    The dotted name is built from the file's stem, the same way ``_execute``
    built it. ``name`` can be folder-qualified while the module inside the
    package is filed under its stem, and popping the qualified spelling left
    the half-executed module in place.
    """

    if package is not None:
        failed = sys.modules.pop(_dotted(package, path), None)
        if failed is not None and sys.modules.get(name) is failed:
            sys.modules.pop(name, None)
        return
    sys.modules.pop(name, None)


#: Where a retry that changed the working directory is reading from, as
#: (scratch mirror, the folder that may not be written into). None outside
#: such a retry, which is what makes `_write_guard` free the rest of the time.
_GUARDED: Optional[Tuple[Path, Path]] = None
_GUARD_INSTALLED = False

#: `open` modes that create or truncate. `r` alone is absent on purpose.
_WRITING = ("w", "a", "x", "+")

#: The same intent in the flags `os.open` reports, which arrive instead of a
#: mode string and were read as "no mode, so not a write" until they were not.
_WRITING_FLAGS = (
    os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
)


def _write_guard(event: str, arguments) -> None:  # pragma: no cover - process-wide hook
    """Refuse an `open` for writing that would land in the repository.

    The mirror `_reading_from` builds keeps every directory on its own side,
    so a path cannot traverse into their checkout; only the leaf files point
    at theirs. That leaves one way to change a file they already have, which
    is to open it for writing through its link, and this refuses it.

    The list is short because the directories did the rest. `os.remove`,
    `os.rename`, `os.rmdir` and `os.mkdir` act on a directory, and every
    directory the retry can reach is one `_mirror_into` made, so none of them
    needs an answer here. What acts on a file is what is left, and through a
    link that set is closed: `open` for writing in either form, and the path
    form of `truncate`.

    Covered, then, is anything reaching `builtins.open` or `os.open`, which
    includes `numpy.save`, `pickle`, `torch.save` and Pillow. Not covered is
    a writer that opens the file in C and raises no event, and this course
    supplies several: `soundfile.write` in week 1, `cv2.imwrite` in week 2,
    `h5py`, `sqlite3`. Nor a mode or timestamp change, which does not alter
    what a read returns. Nor an `os.link` they make here, which gives their
    bytes a second name on this side that these path tests then approve.
    Chasing those with more entries here is the list that grows with the
    standard library, and the hardlink one would want inode identity rather
    than a path; none of it is worth starting for code no student writes at
    import scope.

    `isolate.py` is a different promise. It keeps a crash or a hang inside a
    child process; it does not keep that child out of the checkout.
    """

    if _GUARDED is None or len(arguments) < 2:
        return
    if event == "open":
        target, mode = arguments[0], arguments[1]
        if mode is None:
            # `os.open` reports flags here and leaves the mode empty.
            flags = arguments[2] if len(arguments) > 2 else 0
            if not isinstance(flags, int) or not flags & _WRITING_FLAGS:
                return
        elif not any(letter in str(mode) for letter in _WRITING):
            return
    elif event == "os.truncate":
        target = arguments[0]
        if isinstance(target, int):
            # A descriptor, which the `open` that produced it already answered.
            return
    else:
        return
    mirror, protected = _GUARDED
    try:
        where = Path(os.fsdecode(target)).resolve()
    except (TypeError, ValueError, OSError):
        return
    if _inside(where, mirror) or not _inside(where, protected):
        return
    try:
        named = where.relative_to(protected)
    except ValueError:  # pragma: no cover - `where` is inside by this point
        named = where
    # Their report shows this as the reason the module was skipped, so it says
    # what happened and what to do, and names their file the way they wrote it.
    raise PermissionError(
        "this module was run from a copy of its folder, so writing "
        "{} would have changed your repository. Write it from a function "
        "rather than at import, or write to a new name.".format(named)
    )


def _inside(where: Path, root: Path) -> bool:
    try:
        where.relative_to(root)
    except ValueError:
        return False
    return True


def _mirror_into(source: Path, destination: Path) -> None:
    """Rebuild `source`'s directories under `destination` and link its files.

    A directory is made, not linked, so that every path a module writes
    resolves to this side. A file is linked, so a relative read gets their
    bytes without copying a checkout that can run to gigabytes: the largest
    2026 capstone is 1.8 GB, nearly all of it committed audio.

    One of their own links to a directory inside the tree is rebuilt too,
    because linking it as it stands would point back through their checkout
    and `os.remove("cache/stale.pkl")` would land there again. A link out of
    the tree stays a link, pointing where they aimed it.

    The walk is a loop rather than a recursion because a deep tree would
    otherwise raise `RecursionError` past about 990 directories, and the
    caller catches only `OSError`, so one repository would end the survey
    instead of one module. `seen` is what keeps a cycle of their own links
    from walking forever.
    """

    root = source.resolve()
    seen = {root}
    pending = [(source, destination)]
    while pending:
        here, mirror = pending.pop()
        try:
            entries = sorted(here.iterdir())
        except OSError:
            continue
        for entry in entries:
            target = mirror / entry.name
            try:
                if entry.is_dir():
                    resolved = entry.resolve()
                    inside = resolved == root or _inside(resolved, root)
                    if entry.is_symlink() and not inside:
                        os.symlink(entry, target)
                        continue
                    if resolved in seen:
                        continue
                    seen.add(resolved)
                    target.mkdir()
                    pending.append((entry, target))
                else:
                    os.symlink(entry, target)
            except OSError:
                continue


@contextlib.contextmanager
def _reading_from(folder: Path):
    """Work from a throwaway copy of the module's own folder, not from it.

    The retry below re-executes a module with its own directory as the
    working directory, because a module that reads ``data/trumpet.wav`` at
    import scope is right about where that file is and wrong only about the
    working directory the platform chose.

    Doing that with a plain ``os.chdir(folder)`` put the student's checkout
    under the student's own ``open(..., "w")``. Measured: a module that wrote
    ``marker.txt`` before reading ``data.txt`` failed the scratch import,
    succeeded on this retry, and left ``marker.txt`` in the repository. The
    loader's rule is that student writes land in scratch, and discovery may
    not modify a tree it was asked to read.

    So the working directory is a temporary directory that repeats their
    directory structure and symlinks their files. A relative read at any
    depth resolves through a file link to the real bytes. A relative rename,
    delete or mkdir, and a write to a name they do not already have, land on
    a directory this function made. A write to a file they do have would go
    through its link, so `_write_guard` refuses it and the module is skipped
    with that as the reason.

    The first draft linked the top-level entries only, directories included.
    A directory link is a doorway: `os.remove("data/stale.pkl")` through one
    resolves into their checkout and deletes their file, and so do rename,
    rmdir, mkdir and rmtree. Measured on a disposable fixture, six ordinary
    operations reached the original tree and only `open(..., "w")` was
    refused, because `open` was the one event the hook read. Rebuilding the
    directories removes the doorway instead of growing that list, which is
    the better trade because `f.truncate()` carries only a descriptor and a
    C extension raises no event at all.

    What remains is the file links themselves, and `_write_guard` says what
    it does and does not cover there.

    What this does not change is the reach of an absolute path. A module that
    builds one from `__file__`, or calls `os.chdir` to its own folder, writes
    where it says, on this attempt exactly as on the first one. The rule the
    retry holds is narrower than "the repository is untouched": it is that
    the retry hands student code no path into the checkout that the ordinary
    import did not already hand it.
    """

    global _GUARDED, _GUARD_INSTALLED

    with tempfile.TemporaryDirectory(prefix="cogworks-import-") as temporary:
        mirror = Path(temporary).resolve()
        _mirror_into(folder, mirror)
        if not _GUARD_INSTALLED:
            sys.addaudithook(_write_guard)
            _GUARD_INSTALLED = True
        was = _GUARDED
        previous = os.getcwd()
        _GUARDED = (mirror, folder.resolve())
        try:
            os.chdir(mirror)
            yield
        finally:
            _GUARDED = was
            os.chdir(previous)


@dataclass
class _Notes:
    """What it took to read one module, beyond opening the file.

    Every entry here is something the platform did that the student did not
    ask for, so every entry is reported. A module that imported the ordinary
    way carries none of them and its record is unchanged.
    """

    cwd_hint: Optional[Path] = None
    future_annotations: bool = False
    redirected: Tuple[str, ...] = ()


def _run_body_in(
    module: ModuleType,
    name: str,
    path: Path,
    source: Optional[str],
    timeout: float,
    future_annotations: bool,
) -> ModuleType:
    """Execute a file as the body of ``module``, in ``module``'s own namespace.

    This is how CPython runs a package's ``__init__.py``: the statements land
    in the package object, so ``__package__`` and ``__path__`` are the ones in
    scope and ``from .core import Detector`` has a parent to resolve against.
    Running the file as a standalone module instead, which is what this did,
    failed every relative import in an initializer with "attempted relative
    import with no known parent package" and lost everything the file offered.

    ``SourceFileLoader`` for the ordinary case rather than a plain ``compile``,
    so source encodings, line endings and ``SyntaxError`` line numbers stay the
    standard ones. The recompile below is only for the postponed-annotation
    retry, which needs its own flags.
    """

    if source is None and not future_annotations:
        loader = importlib.machinery.SourceFileLoader(module.__name__, str(path))
        with _quiet_import(), _deadline(timeout, name):
            loader.exec_module(module)
        return module
    text = source if source is not None else path.read_text(
        encoding="utf-8", errors="replace"
    )
    flags = __future__.annotations.compiler_flag if future_annotations else 0
    with _quiet_import(), _deadline(timeout, name):
        exec(
            compile(text, str(path), "exec", flags=flags, dont_inherit=True),
            module.__dict__,
        )
    return module


def _execute(
    name: str,
    path: Path,
    source: Optional[str],
    timeout: float,
    package: Optional[str],
    *,
    future_annotations: bool = False,
    into: Optional[ModuleType] = None,
) -> Tuple[Optional[ModuleType], Optional[BaseException], Optional[SkippedModule]]:
    """Run one module's body once, and hand back what happened.

    Three returns rather than two because the caller now has to decide
    whether the failure is one it can honestly retry, and deciding that needs
    the exception rather than a sentence about it.

    ``into`` is a module to run the body in rather than one to build: a
    package and its own ``__init__.py``. Nothing is registered or forgotten
    for it, because the package is already in ``sys.modules`` and its members
    still need it there when its body fails.
    """

    try:
        if into is not None:
            body = _run_body_in(into, name, path, source, timeout, future_annotations)
            return body, None, None
        if source is None and not future_annotations:
            if package is not None:
                # Built from the file in hand rather than looked up by stem.
                # A file read under a folder-qualified name, because the root
                # already owns the bare one, sent that lookup after
                # `model_tests.image_caption_model.py`, which does not exist,
                # and their perfectly good file was reported as "Python could
                # not read this file as a module". The dotted name keeps the
                # stem: that is what a relative import inside the package
                # resolves, and what `__name__` has to be.
                dotted = _dotted(package, path)
                spec = importlib.util.spec_from_file_location(
                    dotted, path, loader=_PackageLoader(dotted, str(path))
                )
            else:
                spec = importlib.util.spec_from_file_location(name, path)
            if spec is None or spec.loader is None:
                return (
                    None,
                    None,
                    SkippedModule(
                        name,
                        path,
                        "syntax",
                        "Python could not read this file as a module.",
                    ),
                )
            module = importlib.util.module_from_spec(spec)
            # Registered under both names deliberately. The dotted name is
            # what a relative import resolves, and registering it before
            # execution is what makes a cycle between two package members
            # terminate. The bare name is what a sibling's `import database`
            # finds, which is how every flat repository in the corpus works.
            # `setdefault` for the bare name so the chosen root keeps
            # precedence on a stem collision, which `_consume` relies on.
            displaced = sys.modules.get(spec.name)
            if (
                displaced is not None
                and spec.name not in _DISPLACED
                and _is_installed(displaced)
            ):
                # Put back when discovery leaves (`_entered`); evicting the
                # student's module alone left the real one gone for the
                # rest of the process. Only an installed module is put
                # back: a bare `database` left behind by another
                # repository's hand adapter is not one, and restoring it
                # handed the next adapter the wrong team's code (measured:
                # carti4ce's oracle scored 0.0 after KrazeeCoder's test).
                _DISPLACED[spec.name] = displaced
            sys.modules[spec.name] = module
            sys.modules.setdefault(name, module)
            with _quiet_import(), _deadline(timeout, name):
                spec.loader.exec_module(module)
            return module, None, None

        # A notebook module is built from lifted definitions rather than
        # executed from its file, so it has no package to belong to and
        # relative imports in a notebook cannot be made to work here.
        # `setdefault` keeps it from displacing a .py of the same stem
        # that already loaded, which `_consume` also guards.
        text = source if source is not None else path.read_text(
            encoding="utf-8", errors="replace"
        )
        # The same identity the loader gives a package member on the first
        # attempt: the bare stem, with the dotted name for the import
        # machinery. A member whose stem the root already owns is read under
        # a folder-qualified `name`, and building the retry from that gave one
        # file two different `__name__` values depending on whether it had
        # needed a retry, under a key `_forget` would not find.
        member = path.stem if package is not None else name
        module = ModuleType(member)
        module.__file__ = str(path)
        if package is not None:
            module.__package__ = package
            sys.modules[_dotted(package, path)] = module
        sys.modules.setdefault(name, module)
        flags = __future__.annotations.compiler_flag if future_annotations else 0
        # `dont_inherit` because this file declares `from __future__ import
        # annotations` and `compile` otherwise takes that from the frame it is
        # called in. Every lifted notebook was silently getting postponed
        # annotations while its record said `futureAnnotations: false`, which
        # is a claim about their module that was not true, and it made
        # notebooks behave differently from the `.py` files beside them.
        with _quiet_import(), _deadline(timeout, name):
            exec(
                compile(text, str(path), "exec", flags=flags, dont_inherit=True),
                module.__dict__,
            )
        return module, None, None
    except _ImportTimeout:
        if into is None:
            _forget(name, package, path)
        return (
            None,
            None,
            SkippedModule(
                name,
                path,
                "too_slow",
                "still running after {} seconds; it does work when imported rather "
                "than when called".format(timeout),
            ),
        )
    except SyntaxError as error:
        if into is None:
            _forget(name, package, path)
        return (
            None,
            error,
            SkippedModule(
                name, path, "syntax", "line {}: {}".format(error.lineno, error.msg)
            ),
        )
    except BaseException as error:  # noqa: BLE001 - student code raises anything
        if into is None:
            _forget(name, package, path)
        missing = _missing_module(error)
        if missing:
            return (
                None,
                error,
                SkippedModule(
                    name,
                    path,
                    "missing_dependency",
                    "imports {}, which is not installed here".format(missing),
                    missing,
                ),
            )
        return (
            None,
            error,
            SkippedModule(
                name, path, "raised", "{}: {}".format(type(error).__name__, _said(error))
            ),
        )


def _import_one(
    name: str,
    path: Path,
    source: Optional[str],
    timeout: float = IMPORT_TIMEOUT_SECONDS,
    package: Optional[str] = None,
    redirects: Optional["_Redirects"] = None,
    *,
    into: Optional[ModuleType] = None,
) -> Tuple[Optional[ModuleType], Optional[SkippedModule], _Notes]:
    """Import one module, retrying only where the failure is ours to answer.

    Three retries, each for a failure that is not a bug in their code and
    each disclosed on the module record. In order:

    Their own folder. A module that reads ``data/trumpet.wav`` at import
    scope is right about where that file is relative to itself and wrong only
    about the working directory the platform chose. Retried once with the
    module's own directory as the working directory, and only for a relative
    path: an absolute path names a machine, and answering for one would be
    inventing a file.

    A name in an annotation. ``def f(x) -> Tuple[Dict[DatabaseKey, int]]``
    with ``DatabaseKey`` undefined kills a module at import even though no
    line of it would ever run that expression. Recompiled once with
    ``from __future__ import annotations``, which makes Python keep the
    annotation as text. Their functions are unchanged; nothing in the corpus
    reads ``__annotations__``.

    A course artifact at a path this machine does not have. See
    ``_Redirects``.
    """

    notes = _Notes()
    # One module object per source file, for the whole of one discovery. A
    # file is reachable more than once: a package member pulled in early by a
    # neighbour's relative import, a root script's own `import helpers`, a
    # notebook reached through `ipynb.fs.full` before the notebook pass gets
    # to it. Executing it again produces a second object with independent
    # globals, and the two then diverge. Measured on a fixture where
    # `main.py` calls `helpers.register(...)`: the copy discovery reported
    # had an empty registry while the copy `main.py` holds had the entry, so
    # the search bound functions to a module that never saw their own setup.
    # Class identity goes the same way, and an `isinstance` across the two
    # copies is false.
    # Not when `into` says where to run: the caller has already decided which
    # module this file's statements belong in, and a package carries its
    # initializer's `__file__` from the moment it is registered.
    if into is None:
        already = _already_executed(path)
        if already is not None:
            return already, None, notes

    # The remedies compose, and one module can need more than one. One 2026
    # file (Cog-gurts, `Day 4/pipeline.py`) reads `data/trumpet.wav` at
    # import scope AND annotates a return type with a name it never defines.
    # Fixing the working directory reveals the NameError; fixing the
    # NameError alone still cannot find the file. Applied once each from the
    # ORIGINAL error, as the first draft did, neither remedy ever saw the
    # failure it was for, and the module stayed skipped while every function
    # the chain needed sat inside it. So each remedy stays on once applied
    # and the import is retried until no remedy applies to the failure in
    # hand. Each applies at most once, so this ends after at most three
    # retries.
    folder: Optional[Path] = None
    future = False
    # A retry into an existing module starts from the namespace the first
    # attempt started from, the way a fresh module object does for every
    # other retry. Measured on an `__init__.py` that appends to a module
    # global once and then fails on an annotation: the successful retry came
    # back having appended twice.
    pristine = dict(into.__dict__) if into is not None else None
    module, error, failure = _execute(name, path, source, timeout, package, into=into)
    while module is None:
        found = _own_folder(error, path) if folder is None else None
        if found is not None:
            folder = found
        elif not future and _annotation_only(error, path, source):
            future = True
        else:
            basename = redirects.wanted(error) if redirects is not None else None
            if basename is None:
                return None, failure, notes
            redirects.install(basename)
            notes.redirected = notes.redirected + (basename,)
        if pristine is not None:
            into.__dict__.clear()
            into.__dict__.update(pristine)
        try:
            if folder is not None:
                with _reading_from(folder):
                    module, error, failure = _execute(
                        name, path, source, timeout, package,
                        future_annotations=future, into=into,
                    )
            else:
                module, error, failure = _execute(
                    name, path, source, timeout, package,
                    future_annotations=future, into=into,
                )
        except OSError:
            return None, failure, notes
    if folder is not None:
        notes.cwd_hint = folder
    if future:
        notes.future_annotations = True
    return module, None, notes


def _own_folder(error: Optional[BaseException], path: Path) -> Optional[Path]:
    """The module's own directory, when a relative read is what stopped it.

    Only for a relative path. An absolute one names a location on some
    machine, and if it is not here then no working directory makes it appear;
    retrying would only hide the real answer, which is that the file is not
    on this machine.
    """

    if not isinstance(error, (FileNotFoundError, IsADirectoryError)):
        return None
    named = str(getattr(error, "filename", None) or "")
    if not named or os.path.isabs(named) or _absolute_on_windows(named):
        return None
    folder = path.parent
    return folder if folder.is_dir() else None


def _absolute_on_windows(named: str) -> bool:
    """Whether a path is absolute on the machine that wrote it, not on this one.

    ``os.path.isabs`` reads ``C:\\Users\\student\\glove.kv`` as relative when
    this process runs on POSIX, so the retry above read it from the module's
    own folder, where it also is not, and the module record then said we
    imported from a folder we had no reason to move to.
    """

    return named.startswith("\\\\") or (
        len(named) > 2
        and named[0].isalpha()
        and named[1] == ":"
        and named[2] in "\\/"
    )


def _annotation_only(
    error: Optional[BaseException], path: Path, source: Optional[str]
) -> bool:
    """Whether a NameError came from a type annotation and nowhere else.

    Both halves are required. The traceback's innermost frame has to be a
    ``def`` line, because that is where an annotation is evaluated; and every
    mention of the missing name in the file has to be inside an annotation,
    because a name their code actually uses is a real error and recompiling
    would only move the failure to the first call.
    """

    if not isinstance(error, NameError):
        return False
    missing = getattr(error, "name", None)
    if not missing:
        # NameError.name was added after Python 3.8. The 3.8 runners still
        # carry the missing identifier in this stable interpreter message.
        message = str(error)
        prefix = "name '"
        suffix = "' is not defined"
        if message.startswith(prefix) and message.endswith(suffix):
            missing = message[len(prefix) : -len(suffix)]
    if not missing:
        return False
    trace = error.__traceback__
    if trace is None:
        return False
    while trace.tb_next is not None:
        trace = trace.tb_next
    lineno = trace.tb_lineno
    text = source
    if text is None:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return False
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return False

    on_a_def_line = False
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            if node.lineno <= lineno < node.body[0].lineno:
                on_a_def_line = True
                break
            # `def f(x: Missing): return 1` puts the body on the def line, so
            # there is no line strictly between the two. The annotation is
            # still evaluated there, and refusing the remedy lost the module.
            if node.lineno == node.body[0].lineno == lineno:
                on_a_def_line = True
                break
    if not on_a_def_line:
        return False

    annotated = set()
    for node in ast.walk(tree):
        holders = []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            holders.append(node.returns)
            arguments = node.args
            every = (
                list(arguments.args)
                + list(arguments.posonlyargs)
                + list(arguments.kwonlyargs)
                + [arguments.vararg, arguments.kwarg]
            )
            holders.extend(item.annotation for item in every if item is not None)
        elif isinstance(node, ast.AnnAssign):
            holders.append(node.annotation)
        for holder in holders:
            if holder is None:
                continue
            for inner in ast.walk(holder):
                annotated.add(id(inner))

    mentions = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Name) and node.id == missing
    ]
    if not mentions:
        return False
    return all(id(node) in annotated for node in mentions)


def _note(
    journal: Optional[Callable[[str, object], None]], kind: str, entry: object
) -> None:
    """Report one outcome to the caller's journal, if it wants one.

    Wrapped in a try so a broken journal cannot cost a repository its
    discovery. The journal exists to preserve a report; it must never be the
    reason there is nothing to report.
    """

    if journal is None:
        return
    try:
        journal(kind, entry)
    except Exception:  # noqa: BLE001 - bookkeeping may not break the search
        pass


def _run_package_body(
    package: str,
    path: Path,
    timeout: float,
    redirects: Optional["_Redirects"],
) -> Tuple[Optional[ModuleType], Optional[SkippedModule], _Notes]:
    """Execute an ``__init__.py`` as the body of its package.

    The package object already exists, and the file's statements run in it,
    which is what CPython does. That is the whole reason ``from .core import
    Detector`` can resolve: the namespace being executed is the package, so
    the relative import has a parent. Running the file as a standalone module
    and copying its globals across afterwards, which is what this did, failed
    every such line with "attempted relative import with no known parent
    package", and the copy meant the package and the body disagreed about
    what the package held.

    A failure is reported like any other module's, under the name
    ``__init__``, and the directory's other modules are still imported. Their
    relative imports keep working, because those resolve through the package
    object rather than through anything the body defines. Reporting it as a
    skip rather than swallowing it is the point: an ``__init__.py`` that
    raises is the student's file failing, and pretending otherwise hides it.

    Whatever the body defined before it failed stays in the package. It is
    the state the file actually reached, the members may depend on it, and
    the skip record is what says the file did not finish.
    """

    module = sys.modules.get(package)
    notes = _Notes()
    if module is None:  # _register_package always registers it; belt and braces
        return None, None, notes
    # _import_one for the whole failure vocabulary: the same caller timeout,
    # the same missing-dependency wording, the same syntax line numbers and
    # the same three retries. `package=None` because the body is not a member
    # of the package, it is the package; `into` is where it runs.
    body, failure, notes = _import_one(
        "__init__", path, None, timeout, None, redirects, into=module
    )
    return body, failure, notes


#: The two package paths the `ipynb` package exposes. ``full`` runs a
#: notebook's cells; ``defs`` keeps only its definitions. Discovery answers
#: for both with the definitions it already lifts, because running the cells
#: is exactly what the lifter exists to avoid: the notebook one 2026 team
#: imports this way reads a wav file out of a Music/ directory at cell scope.
_NOTEBOOK_PACKAGES = ("ipynb", "ipynb.fs", "ipynb.fs.full", "ipynb.fs.defs")


class _NotebookFsFinder:
    """Answers ``ipynb.fs.full.<stem>`` with the lifted notebook of that stem.

    ``from ipynb.fs.full.metadata import SongMetadata`` is a real line in the
    2026 corpus and means "the definitions in metadata.ipynb", which is the
    module discovery already builds. Without this it is reported as the
    missing dependency ``ipynb``, and the team loses every module that
    imports it.

    Installed even when the real ``ipynb`` package is present. Its importer
    executes the notebook's script cells, and a scored run does not get to
    run a training loop because of how a file was imported.

    A stem with no notebook beside it is not answered for, so an import of
    something that genuinely is not there still fails and is still named.
    """

    def __init__(
        self,
        directories: Sequence[Path],
        import_timeout: float,
        redirects: Optional["_Redirects"] = None,
    ) -> None:
        self._directories = list(directories)
        self._timeout = import_timeout
        self._redirects = redirects
        self._made: List[str] = []
        #: What it took to read each notebook, by file. The notebook pass
        #: reuses the module this finder built and would otherwise report a
        #: module that needed a remedy as though it had needed none.
        self._notes: Dict[str, _Notes] = {}

    def find_spec(self, name: str, path=None, target=None):
        if name in _NOTEBOOK_PACKAGES:
            return importlib.machinery.ModuleSpec(name, self, is_package=True)
        stem = self._stem(name)
        if stem is None or self._notebook(stem) is None:
            return None
        return importlib.machinery.ModuleSpec(name, self)

    def create_module(self, spec):
        if spec.name in _NOTEBOOK_PACKAGES:
            self._made.append(spec.name)
            shell = ModuleType(spec.name)
            shell.__path__ = []
            return shell
        stem = self._stem(spec.name)
        notebook = self._notebook(stem)
        source = notebook_source(notebook)
        if source is None:
            raise ImportError(
                "{}.ipynb holds no definitions to import".format(stem), name=spec.name
            )
        # The same import path the notebook pass uses, so a notebook is one
        # module however it is reached. Reached both ways it used to be two:
        # `from ipynb.fs.full.metadata import SongMetadata` lifted one
        # `SongMetadata` and the bare notebook lifted another, and an
        # `isinstance` between a team's own objects was false. Going through
        # `_import_one` is also what gives this path the import deadline this
        # finder was handed and never used, and the same retries.
        module, failure, notes = _import_one(
            stem, notebook, source, self._timeout, None, self._redirects
        )
        if module is None:
            if failure is not None and failure.reason == "too_slow":
                # The deadline is a `BaseException` on purpose: a timeout a
                # module can catch and ignore is not a timeout. Handing the
                # importing module an `ImportError` let its own `except
                # Exception` swallow it and run on past its deadline, with
                # the notebook recorded as loaded and no timer left.
                raise _ImportTimeout(failure.detail)
            raise ImportError(
                "{}.ipynb: {}".format(
                    stem, failure.detail if failure is not None else "did not import"
                ),
                name=spec.name,
            )
        self._notes[os.path.realpath(str(notebook))] = notes
        self._made.append(spec.name)
        return module

    def notes_for(self, notebook: Path) -> Optional[_Notes]:
        """What it took to read this notebook here, when this read it."""

        return self._notes.get(os.path.realpath(str(notebook)))

    def exec_module(self, module):
        return None

    def withdraw(self) -> None:
        """Take this finder and everything it answered for back out.

        The package shells have no ``__file__``, so `_entered` cannot see
        that they came from this repository, and a finder that outlives its
        run would answer for a notebook in a directory the process has
        finished with.
        """

        sys.meta_path[:] = [finder for finder in sys.meta_path if finder is not self]
        for name in self._made:
            sys.modules.pop(name, None)

    def _stem(self, name: str) -> Optional[str]:
        for prefix in ("ipynb.fs.full.", "ipynb.fs.defs."):
            if name.startswith(prefix):
                stem = name[len(prefix):]
                return stem if stem and "." not in stem else None
        return None

    def _notebook(self, stem: Optional[str]) -> Optional[Path]:
        if not stem:
            return None
        for directory in self._directories:
            candidate = directory / (stem + ".ipynb")
            if candidate.is_file():
                return candidate
        return None


class _Redirects:
    """Answer a course artifact from the benchmark's copy of it.

    One 2026 repository loads GloVe from ``C:\\Users\\...\\glove.6B.200d.kv``
    at module scope. The file is the same course artifact the benchmark
    already owns; the path is a machine that is not this one. Every module in
    that repository is skipped as "raised", so the week has nothing to search.

    The benchmark supplies the validated paths. Ordinary file opens are
    redirected only after a failure names a mapped basename. The course's
    loader is patched before a from-import captures its alias, because the
    Language corpus first calls that alias later in prep_data. That loader
    does not honor COGWORKS_LANGUAGE_DATA and otherwise fetches another copy.

    Each captured loader closes over this repository's map, never a global
    current map. Module attributes and import hooks are restored on leave;
    an alias already captured by student code keeps its own validated paths.
    The environment hint remains for student loaders that do read it.
    """

    def __init__(self, mapping: Mapping[str, Path]) -> None:
        self._map = {str(name): Path(where) for name, where in mapping.items()}
        self._live: Dict[str, Path] = {}
        self._open = None
        self._loader = None
        self._course = None
        self._w2v = None
        self._previous_env = None
        self._import = None

    def enter(self) -> None:
        if not self._map:
            return
        # Patch before a from-import captures its alias, even when the first
        # resource read happens later in a candidate call.
        self._import = builtins.__import__
        original_import = self._import

        def importing(name, globals=None, locals=None, fromlist=(), level=0):
            module = original_import(name, globals, locals, fromlist, level)
            if (name == "cogworks_data" or name.startswith("cogworks_data.")
                    or name == "gensim" or name.startswith("gensim.")):
                self._patch_course_loader()
            return module

        self._previous_env = os.environ.get("COGWORKS_LANGUAGE_DATA")
        builtins.__import__ = importing
        try:
            self._patch_course_loader()
            folders = {str(where.parent) for where in self._map.values()}
            if len(folders) == 1:
                os.environ["COGWORKS_LANGUAGE_DATA"] = folders.pop()
        except BaseException:
            self.leave()
            raise

    def __enter__(self):
        self.enter()
        return self

    def __exit__(self, *exc):
        self.leave()

    def leave(self) -> None:
        if self._import is not None:
            builtins.__import__ = self._import
            self._import = None
        if self._open is not None:
            builtins.open = self._open
            self._open = None
        if self._loader is not None:
            owner, name, original = self._loader
            setattr(owner, name, original)
            self._loader = None
        if self._course is not None:
            owner, name, original = self._course
            setattr(owner, name, original)
            self._course = None
        if self._w2v is not None:
            owner, name, original = self._w2v
            setattr(owner, name, original)
            self._w2v = None
        if self._map:
            if self._previous_env is None:
                os.environ.pop("COGWORKS_LANGUAGE_DATA", None)
            else:
                os.environ["COGWORKS_LANGUAGE_DATA"] = self._previous_env
        self._live.clear()

    def wanted(self, error: Optional[BaseException]) -> Optional[str]:
        """The basename this failure was about, when the benchmark has it."""

        if not self._map or error is None:
            return None
        # Git LFS leaves a small text pointer in a clone without downloaded
        # objects. Course loaders report that as a parse ValueError rather
        # than as a missing file, but the student's failing line still names
        # the exact benchmark artifact before any redirect is allowed.
        if not isinstance(error, (OSError, NotImplementedError, ValueError)):
            return None
        for token in self._tokens(error):
            name = token.replace("\\", "/").rsplit("/", 1)[-1]
            if name in self._map and name not in self._live:
                return name
        return None

    def install(self, basename: str) -> None:
        """Answer for this one basename for the rest of discovery."""

        self._live[basename] = self._map[basename]
        if self._open is None:
            self._open = builtins.open
            builtins.open = self._opened
        self._patch_gensim()
        self._patch_course_loader()

    def _tokens(self, error: BaseException) -> List[str]:
        found = [str(getattr(error, "filename", "") or "")]
        text = str(error)
        for separator in ("'", '"', " ", ":", ","):
            text = text.replace(separator, "\n")
        found.extend(text.split("\n"))
        # The path is not always in the message. One 2026 file loads GloVe
        # from `r"C:\\Users\\...\\glove.6B.200d.kv"`; on POSIX the loader
        # reads `C:` as a URL scheme and raises "Unable to handle scheme
        # 'c'", which names no file. The student's own line does, so the
        # string constants on the frames of THEIR files are read too. Only
        # their files: a frame inside a library names the library's paths.
        import linecache
        import traceback

        for frame in traceback.extract_tb(error.__traceback__ or None):
            line = frame.line or linecache.getline(frame.filename, frame.lineno or 0)
            for quote in ('"', "'"):
                parts = line.split(quote)
                found.extend(parts[1::2])
        # A path assembled in a module variable leaves no string literal on
        # the failing call. Loader frames still carry that exact path as a
        # local, so inspect path-like locals and keep the same basename match
        # in `wanted` as the final gate.
        current = error.__traceback__
        while current is not None:
            for value in current.tb_frame.f_locals.values():
                if isinstance(value, str):
                    found.append(value)
                    continue
                # Reading their locals is a hint, not a contract. An object
                # can claim to be a path and raise from `__fspath__`, or hand
                # back something that is not one. Measured on a fixture: that
                # exception left `_import_one`, left `load_modules`, and
                # ended the discovery, so a repository reported nothing at
                # all because of one object in one frame.
                try:
                    if not isinstance(value, os.PathLike):
                        continue
                    token = os.fspath(value)
                except Exception:  # noqa: BLE001 - their objects raise anything
                    continue
                if isinstance(token, str):
                    found.append(token)
            current = current.tb_next
        return [token for token in found if token]

    def _redirected(self, target):
        try:
            name = os.path.basename(str(target)).replace("\\", "/").rsplit("/", 1)[-1]
        except Exception:  # noqa: BLE001 - a path-like may be anything
            return target
        where = self._live.get(name)
        if where is None:
            return target
        if os.path.exists(target) and not self._is_lfs_pointer(target):
            return target
        return str(where)

    def _is_lfs_pointer(self, target: Any) -> bool:
        """Whether an existing course file is only a Git LFS pointer."""

        opener = self._open or builtins.open
        try:
            with opener(target, "rb") as stream:
                return stream.read(42) == b"version https://git-lfs.github.com/spec/v1"
        except (OSError, TypeError, ValueError):
            return False

    def _opened(self, file, *args, **keywords):
        return self._open(self._redirected(file), *args, **keywords)

    def _patch_course_loader(self) -> None:
        """Point ``cogworks_data.language.get_data_path`` at the benchmark's files.

        Three of the four 2026 Week 3 repositories call it at module scope
        for the captions, the descriptors, and the GloVe text file. On a
        machine with the course cache that is a 15-second parse of a 693 MB
        file per import and on the sandbox it is a download. The benchmark
        owns the same three files, and hands over its pre-parsed GloVe
        (`.kv`) for the text one, which `KeyedVectors.load_word2vec_format`
        cannot read; so that call is answered through `KeyedVectors.load`
        when the mapped file is a `.kv`. Only when their code already
        imported the loader, for the reason `_patch_gensim` gives.
        """

        language = sys.modules.get("cogworks_data.language")
        original = getattr(language, "get_data_path", None)
        if original is None:
            return
        live = self._map

        def _get_data_path(file_name, *args, **keywords):
            name = str(file_name).replace("\\", "/").rsplit("/", 1)[-1]
            if name.endswith(".zip"):
                name = name[: -len(".zip")]
            if name in live:
                self._live[name] = live[name]
                return str(live[name])
            # Pooch's cache is not a second authority for benchmark inputs.
            # Unknown course files are explicit failures, not hidden downloads.
            raise FileNotFoundError(
                "course file {!r} has no validated benchmark input. "
                "Ask your instructor to check whether this file belongs in the benchmark inputs.".format(str(file_name))
            )

        if self._course is None:
            self._course = (language, "get_data_path", original)
            language.get_data_path = _get_data_path

        models = sys.modules.get("gensim.models")
        owner = getattr(models, "KeyedVectors", None)
        text_loader = getattr(owner, "load_word2vec_format", None)
        if callable(text_loader) and self._w2v is None:

            def _load_w2v(path, *args, **keywords):
                target = str(path)
                if target.endswith(".kv"):
                    return owner.load(target, mmap="r")
                return text_loader(target, *args, **keywords)

            self._w2v = (owner, "load_word2vec_format", text_loader)
            owner.load_word2vec_format = _load_w2v

    def _patch_gensim(self) -> None:
        """Point ``KeyedVectors.load`` at the benchmark's file.

        Only when their code already imported gensim. Importing it here to
        patch it would spend seconds on a package this repository may not
        use, and would report a dependency it does not have.
        """

        if self._loader is not None:
            return
        models = sys.modules.get("gensim.models")
        owner = getattr(models, "KeyedVectors", None)
        if owner is None:
            return
        original = owner.load
        redirect = self._redirected

        def _load(cls_or_path, *args, **keywords):
            return original(redirect(cls_or_path), *args, **keywords)

        self._loader = (owner, "load", original)
        owner.load = _load


def _qualified(path: Path, directory: Path, directories: Sequence[Path]) -> Optional[str]:
    """``folder.stem`` for a file whose bare stem is already taken, or None.

    Relative to the outermost directory being read that contains it, so
    the name is the one a student would write in an import from the root.
    A folder that is not a valid identifier (`Day 4`) has no such name and
    the file keeps being skipped, as before.
    """

    for base in directories:
        try:
            relative = path.relative_to(base)
        except ValueError:
            continue
        parts = list(relative.parts[:-1]) + [path.stem]
        if all(part.isidentifier() for part in parts) and len(parts) > 1:
            return ".".join(parts)
        return None
    return None


#: Why a notebook produced nothing to import, when the reason is the file
#: rather than its cells. The general sentence below is about a notebook that
#: is a transcript; these two are about a notebook that is not a notebook.
def _why_no_module(path: Path) -> str:
    """What is wrong with this .ipynb, in the terms its author would check.

    Measured on one 2026 repository: `master.ipynb` is a zero-byte file, in
    the checkout and at origin, and was reported as having "no importable
    definitions; its cells build what they use as they run", which describes
    a notebook it is not. A team reading that goes looking for the cell that
    built something, and there are no cells.
    """

    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        # `notebook_source` read the same file a moment ago and guards this
        # too. The general sentence stays true when the read fails.
        return _CELLS_BUILD_WHAT_THEY_USE
    if not text.strip():
        return "is empty"
    try:
        json.loads(text)
    except ValueError:
        return "is not a notebook this can read (not JSON)"
    return _CELLS_BUILD_WHAT_THEY_USE


_CELLS_BUILD_WHAT_THEY_USE = (
    "no importable definitions; its cells build what they use as they run"
)


def load_modules(
    root: Path,
    *,
    extra: Sequence[Path] = (),
    import_timeout: float = IMPORT_TIMEOUT_SECONDS,
    journal: Optional[Callable[[str, object], None]] = None,
    resource_files: Optional[Mapping[str, Path]] = None,
) -> Tuple[List[LoadedModule], List[SkippedModule], List[str]]:
    """Import every module in ``root``, then in each of ``extra``.

    The caller is expected to have made ``root`` the working directory and put
    it on ``sys.path`` already (see ``discover``), because a student module
    that writes ``db.pkl`` relative to the working directory is right about
    where it wants to be.

    ``extra`` holds the other directories in the repository that also carry
    code. Teams split a capstone across a root and a package directory often
    enough that picking one and ignoring the other loses half the pipeline:
    one audited repository keeps its matcher in ``recognizer.py`` at the root
    and its descriptors, profiles, and clustering under ``core/``. A root is
    still chosen, because it decides the working directory and import
    precedence, but discovery does not stop there.

    ``.py`` files come before notebooks so that a repository holding both is
    resolved from the code the team maintained rather than the notebook they
    explored in.

    A directory that looks like a package (see ``is_package_directory``) is
    imported as one, so its members' relative imports resolve. Every other
    directory is imported exactly as before, under bare module names, because
    that is what the flat repositories in the corpus need and changing it
    would break them for no gain.

    ``journal`` is called with ``("module", entry)`` or ``("skipped", entry)``
    the moment each outcome is known, before the next file is touched. It
    exists so a caller running this behind a process boundary can keep what
    was learned before a module killed the interpreter. Nothing here depends
    on it, and the return value is unchanged.
    """

    calls: List[str] = []
    _install_stubs(calls)
    directories = [root] + [path for path in extra if path != root]
    redirects = _Redirects(resource_files or {})
    redirects.enter()
    notebooks = _NotebookFsFinder(directories, import_timeout, redirects)
    sys.meta_path.insert(0, notebooks)

    loaded: List[LoadedModule] = []
    skipped: List[SkippedModule] = []
    taken: set = set()

    def _consume(directory: Path) -> None:
        # Decided once per directory rather than per file, because a package
        # is a property of the directory: a file with no relative import of
        # its own still belongs to the package its neighbours declared, and
        # importing it outside would give the directory two copies of it.
        #
        # Their own package when Python has already made one. A root script's
        # `import core.database` loads `core` through the ordinary import
        # system, and a synthetic package registered beside it gives every
        # member a second module object.
        package = None
        adopted = False
        if is_package_directory(directory):
            live = _live_package(directory)
            adopted = live is not None
            package = live if adopted else _register_package(directory)

        files = _python_files(directory)
        if package is not None:
            # The package body first, so a member that relies on setup in
            # __init__.py finds it done. It is reported like any other module
            # under the name a student would recognise.
            initializer = directory / "__init__.py"
            if initializer.is_file():
                files = [path for path in files if path != initializer]
                _note(journal, "reading", initializer)
                if adopted:
                    # Their own import ran the body already; running it again
                    # would repeat whatever it does on the way through.
                    body, failure, notes = sys.modules.get(package), None, _Notes()
                else:
                    body, failure, notes = _run_package_body(
                        package, initializer, import_timeout, redirects
                    )
                if failure is not None:
                    skipped.append(failure)
                    _note(journal, "skipped", failure)
                elif body is not None:
                    # Recorded like any other module, so a name the package
                    # offers is in the namespace a benchmark searches. Not
                    # added to `taken`: `__init__` is the name a student
                    # reads, and a repository with two package directories
                    # has two of them.
                    entry = LoadedModule(
                        "__init__",
                        initializer,
                        body,
                        "file",
                        cwd_hint=notes.cwd_hint,
                        future_annotations=notes.future_annotations,
                        redirected=notes.redirected,
                    )
                    loaded.append(entry)
                    _note(journal, "module", entry)

        for path in files:
            # A file whose stem an earlier directory already owns is read
            # under its folder-qualified name rather than skipped. The root
            # keeps the bare name, which is import precedence; the other
            # file is still their code. Measured on one 2026 repository:
            # `image_caption_model.py` at the root has no `load`, and
            # `model_tests/image_caption_model.py`, the one their scripts
            # import and the only one that reads their trained weights, was
            # never read at all.
            name = path.stem
            if name in taken:
                name = _qualified(path, directory, directories)
                if name is None or name in taken or name in _PREEXISTING:
                    # A dotted name that was a real module before discovery
                    # began (`json.tool`) is not one their file may take; an
                    # independent review loaded a fixture as `json.tool` and
                    # a later import in the same process received student
                    # code. Judged against the modules present BEFORE entry,
                    # not the live table: their own scripts import their own
                    # files, so `model_tests.image_caption_model` is in the
                    # table by the time its file is reached, and reading the
                    # live table skipped the one encoder that loads their
                    # weights.
                    continue
            # Announced before the attempt, not after. A module that takes the
            # interpreter down produces no outcome at all, so this line is the
            # only evidence that it was the one being read.
            _note(journal, "reading", path)
            module, failure, notes = _import_one(
                name, path, None, import_timeout, package, redirects
            )
            if module is not None:
                entry = LoadedModule(
                    name,
                    path,
                    module,
                    "file",
                    cwd_hint=notes.cwd_hint,
                    future_annotations=notes.future_annotations,
                    redirected=notes.redirected,
                )
                loaded.append(entry)
                taken.add(name)
                _note(journal, "module", entry)
            elif failure is not None:
                skipped.append(failure)
                _note(journal, "skipped", failure)
        for path in _notebooks(directory):
            if path.stem in taken:
                continue
            source = notebook_source(path)
            if source is None:
                unreadable = SkippedModule(
                    path.stem, path, "syntax", _why_no_module(path)
                )
                skipped.append(unreadable)
                _note(journal, "skipped", unreadable)
                continue
            _note(journal, "reading", path)
            module, failure, notes = _import_one(
                path.stem, path, source, import_timeout, None, redirects
            )
            # When an earlier `from ipynb.fs.full...` already read it, that
            # read is the one that happened and these notes are empty.
            already = notebooks.notes_for(path)
            if already is not None:
                notes = already
            if module is not None:
                entry = LoadedModule(
                    path.stem,
                    path,
                    module,
                    "notebook",
                    cwd_hint=notes.cwd_hint,
                    future_annotations=notes.future_annotations,
                    redirected=notes.redirected,
                )
                loaded.append(entry)
                taken.add(path.stem)
                _note(journal, "module", entry)
            elif failure is not None:
                skipped.append(failure)
                _note(journal, "skipped", failure)

    try:
        _consume(root)
        for directory in extra:
            if directory != root:
                _consume(directory)
    finally:
        notebooks.withdraw()
        redirects.leave()

    return loaded, skipped, calls


def _is_student_module(module: object, root: Path) -> bool:
    """Whether this module was loaded out of the repository being searched."""

    origin = getattr(module, "__file__", None)
    if not origin:
        return False
    try:
        Path(origin).resolve().relative_to(root)
    except (ValueError, OSError):
        return False
    return True


def _searches_inside(module: object, directories: Sequence[Path]) -> bool:
    """Whether this is a package whose search path is in the repository.

    A package Python built for a directory with no ``__init__.py`` has no
    ``__file__``, so `_is_student_module` cannot see it, and it outlived the
    run holding a ``__path__`` into a checkout the process had finished with.
    The next repository's ``import core.database`` then found the last one's.
    """

    locations = getattr(module, "__path__", None)
    if not locations:
        return False
    try:
        entries = [Path(os.path.realpath(str(entry))) for entry in locations]
    except Exception:  # noqa: BLE001 - a __path__ may be anything
        return False
    return any(
        entry == directory.resolve() or _inside(entry, directory)
        for entry in entries
        for directory in directories
    )


@contextlib.contextmanager
def _entered(
    root: Path, *, working: Optional[Path] = None, also: Sequence[Path] = ()
):
    """Run with ``root`` first on the path and ``working`` as the directory.

    The two are separate on purpose. ``root`` is where their modules are found,
    so it must lead ``sys.path`` for their sibling imports to resolve. The
    working directory is where their relative writes land, and that is a
    scratch directory rather than their checkout.

    ``also`` is every other directory discovery reads code from. A team with
    ``buildSongDatabase.py`` and ``pipeline.py`` side by side in ``Day 4/``
    wrote ``from pipeline import local_peak_locations``, which is correct where
    they run it and failed here, because only the root was on the path. The
    report then told them to add "pipeline" to a requirements.txt, which is
    advice to pip-install their own file. Reading from a directory and being
    able to import from it are the same permission.

    Afterwards the student's own modules are evicted so a second repository in
    the same process does not import a stale ``database``, and every other
    module stays exactly where it was.

    The synthetic packages go too, along with the finders that answer for
    them. A package object has ``__file__`` set only when the directory had an
    ``__init__.py``, so eviction by file location alone would leave the rest
    behind, holding a ``__path__`` that points into a repository this process
    has finished with. The finder is removed with it: a finder outliving its
    package answers for a name whose module is gone.

    That second half is load-bearing rather than tidy. Evicting a third-party
    module does not unload it: its C extension is still in the process, and the
    next import re-runs the registration that extension already did. numba
    answers with ``cannot augment Function(pos) with Function(pos)`` and soxr
    aborts the interpreter outright with a nanobind duplicate-key error, which
    is not something a caller can catch. Both were hit here, by student code
    that does nothing stranger than importing librosa.
    """

    previous_cwd = Path.cwd()
    previous_path = list(sys.path)
    previous_backend = os.environ.get("MPLBACKEND")
    before = set(sys.modules)
    _DISPLACED.clear()
    _PREEXISTING.clear()
    _PREEXISTING.update(before)
    # Draw to memory, never to a window. Student code plots: one 2026 team's
    # whispers calls plt.show() inside its iteration loop, which is a
    # reasonable thing to write for a notebook and blocks forever when the
    # search calls that function. Measured here: with no MPLBACKEND set the
    # default on this machine is MacOSX, and plt.show() on it waits for a
    # human to close the window.
    #
    # Set before their first import, because matplotlib reads this once when
    # it is imported and ignores it afterwards. The hosted Week 1 image sets
    # the same variable; this is the same protection for every other place
    # discovery runs, including a student's own laptop.
    os.environ["MPLBACKEND"] = "Agg"
    # And no `.pyc` files. Importing a module writes `__pycache__` next to it,
    # which is the platform, not the student, changing a tree it was asked to
    # read: `git status` in a 2026 checkout that ran `cogworks check` came back
    # with untracked `Week2/__pycache__/`. Discovery imports each file once, so
    # the cache it writes is never read back and buys nothing.
    previous_bytecode = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    os.chdir(working if working is not None else root)
    # Root first: it owns precedence when two directories hold the same name.
    for directory in reversed([root, *also]):
        sys.path.insert(0, str(directory))
    try:
        yield
    finally:
        os.chdir(previous_cwd)
        sys.dont_write_bytecode = previous_bytecode
        sys.path[:] = previous_path
        if previous_backend is None:
            os.environ.pop("MPLBACKEND", None)
        else:
            os.environ["MPLBACKEND"] = previous_backend
        for name, original in list(_DISPLACED.items()):
            sys.modules[name] = original
        _DISPLACED.clear()
        for name in set(sys.modules) - before:
            module = sys.modules.get(name)
            if module is None:
                continue
            # Matched by name rather than by file, because a package built for
            # a directory with no __init__.py has no __file__ for
            # _is_student_module to test.
            if name.startswith(_PACKAGE_PREFIX):
                sys.modules.pop(name, None)
                continue
            if any(
                _is_student_module(module, directory) for directory in (root, *also)
            ) or _searches_inside(module, (root, *also)):
                sys.modules.pop(name, None)
        sys.meta_path[:] = [
            finder
            for finder in sys.meta_path
            if not (
                isinstance(finder, _PackageFinder)
                and finder.package not in sys.modules
            )
        ]


def discover(
    repository: Path,
    *,
    declared_root: Optional[str] = None,
    hints: Sequence[str] = (),
    scratch: Optional[Path] = None,
    import_timeout: float = IMPORT_TIMEOUT_SECONDS,
    journal: Optional[Callable[[str, object], None]] = None,
    resource_files: Optional[Mapping[str, Path]] = None,
) -> Discovery:
    """Choose a root, import what imports, and report all of it.

    Never raises for a repository it cannot read. A repository with no
    importable code returns a ``Discovery`` with an empty namespace and a
    ``skipped`` list that says what stopped each file, because that report is
    the thing a student can act on.

    ``journal`` receives each module outcome as it happens. ``survey`` uses it
    to keep what was learned when a module ends the process, which no return
    value can carry.

    ``resource_files`` maps a basename to the benchmark's copy of that file.
    A module that fails at import because it opens a course artifact at a
    path this machine does not have is retried once with that basename
    answered from the benchmark's copy, and the module record says so. See
    ``_Redirects``; nothing is redirected that the week did not name and that
    a failure did not ask for.
    """

    repository = Path(repository).resolve()
    root = choose_root(repository, declared=declared_root, hints=hints)
    _note(journal, "root", root)
    if not root.path.is_dir():
        return Discovery(root=root)

    # Everything else that holds code, so a capstone split between a root and a
    # package directory is found whole. The chosen root goes first; it owns
    # import precedence.
    #
    # Except when the root is a week directory, matched or declared. A
    # repository holding Week1, Week2, and Week3 has three capstones in it,
    # and reading all of them while scoring one offers the search functions
    # from the wrong assignment. Only what lives under the chosen week is
    # read then. The declared case was measured: with `Week3` declared, the
    # week 2 `facerecognizer.cosine_threshold` was read alongside and bound
    # as the week 3 store, a function from another assignment on a week 3
    # run page.
    inside_a_week = root.path != repository and root.kind in WEEK_SCOPED_ROOTS
    if inside_a_week:
        extra = [
            path
            for path in root.considered
            if path != root.path and root.path in path.parents
        ]
    else:
        extra = [path for path in root.considered if path != root.path]

    # Importing writes. One audited repository keeps a module-global relative
    # db.pkl and rewrites it on every add, and importing two repositories in
    # one session left db.pkl and songs.pkl in this checkout. Their code is
    # right about wanting a working directory; it does not get to be this one.
    if scratch is not None:
        with _entered(root.path, working=Path(scratch), also=extra):
            modules, skipped, calls = load_modules(
                root.path,
                extra=extra,
                import_timeout=import_timeout,
                journal=journal,
                resource_files=resource_files,
            )
            stubbed = stubbed_now()
    else:
        with tempfile.TemporaryDirectory(prefix="cogworks-import-") as temporary:
            with _entered(root.path, working=Path(temporary), also=extra):
                modules, skipped, calls = load_modules(
                    root.path,
                    extra=extra,
                    import_timeout=import_timeout,
                    journal=journal,
                    resource_files=resource_files,
                )
                stubbed = stubbed_now()
    return Discovery(
        root=root,
        modules=modules,
        skipped=skipped,
        stub_calls=calls,
        stubbed=stubbed,
    )


@dataclass(frozen=True)
class Survey:
    """What a repository holds, gathered in a process that may not survive it.

    ``discover`` imports student code in the calling process, which is right
    for a benchmark that is about to run that code anyway. ``survey`` is for
    everyone who only wants to look: ``cogworks check``, the portal, a report.
    It returns names and reasons rather than modules, so an import that takes
    the interpreter down with it costs a report instead of a run.

    When the child does not survive, ``record`` carries ``"unread": True``
    rather than empty lists. The two states are different claims and used to
    render as the same sentence: an empty ``modules`` and an empty ``skipped``
    is exactly what a repository holding no Python produces, so a crashed
    survey read as "there is nothing in this repository", which is a
    confident wrong answer about a student's work. ``looked`` is the
    distinguishing question, and every reader must ask it before reading a
    count.
    """

    #: ``"ok"`` when the child finished, otherwise the isolate status:
    #: ``"crashed"``, ``"timed_out"``, ``"out_of_memory"``, ``"raised"``.
    status: str
    record: Dict[str, object]
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    @property
    def looked(self) -> bool:
        """Whether the repository was actually read.

        False means the counts below describe nothing that happened. A caller
        that reports "0 modules" without checking this is stating a fact about
        the repository that it did not observe.
        """

        return not self.record.get("unread", False)

    @property
    def module_names(self) -> List[str]:
        modules = self.record.get("modules", [])
        return [str(entry["name"]) for entry in modules]  # type: ignore[index]


def _survey_work(repository, declared_root, hints, trail) -> Dict[str, object]:
    # A fatal signal cannot flush Python buffers, so journal each module as
    # soon as it is observed. The parent salvages this same file after exec.
    with trail.open("a", encoding="utf-8") as sink:
        def record(kind, entry):
            sink.write(json.dumps(_journal_line(kind, entry)) + "\n")
            sink.flush()
            os.fsync(sink.fileno())
        return discover(repository, declared_root=declared_root, hints=hints,
                        journal=record).to_dict()


def survey(
    repository: Path,
    *,
    declared_root: Optional[str] = None,
    hints: Sequence[str] = (),
    timeout_seconds: int = 300,
) -> Survey:
    """Look at a repository without risking the caller.

    A student's module can abort the interpreter outright: one repository's
    audio helper loads a second copy of a native backend and dies with a
    nanobind error that no ``except`` clause can see. That must cost this
    repository's report and nothing else, the way one failing CI step leaves
    the rest of the run standing.

    What was learned before the death is kept. The child appends one JSON line
    per module outcome to a file in the parent's scratch directory and flushes
    it, so a module that ends the process costs its own result and not the
    twenty files read before it. Without this the report said "read nothing",
    which is a sentence about the repository that nobody observed.
    """

    from . import isolate
    from .isolate import COMPLETED

    repository = Path(repository).resolve()

    with tempfile.TemporaryDirectory(prefix="cogworks-survey-") as scratch:
        trail = Path(scratch) / "outcomes.jsonl"

        def _work() -> Dict[str, object]:
            return _survey_work(repository, declared_root, hints, trail)

        backend = isolate._isolation_backend()
        if backend is None:
            # Windows has no fork, so there is no isolation to offer. Running
            # the same work here is what the platform can do: the caller loses
            # the protection above, and gains a report. Refusing instead told
            # every Windows student their repository could not be read, which
            # is a sentence about their code that nothing observed.
            return Survey("ok", _work())
        if backend is isolate.run_operation:
            outcome = backend("survey", {
                "repository": str(repository), "declared_root": declared_root,
                "hints": list(hints), "trail": str(trail),
            }, timeout_seconds=timeout_seconds)
        else:
            outcome = backend(_work, timeout_seconds=timeout_seconds)
        if outcome.status == COMPLETED and isinstance(outcome.value, dict):
            return Survey("ok", outcome.value)

        # The child did not report. Everything below is reconstructed from
        # what it managed to write, and is labelled as such: `unread` says the
        # repository was not fully read, so no caller can mistake a partial
        # list for a complete one.
        salvaged = _replay_journal(trail)
        record: Dict[str, object] = {
            "root": salvaged.get("root", str(repository)),
            "rootReason": salvaged.get("rootReason", ""),
            "considered": salvaged.get("considered", []),
            "modules": salvaged.get("modules", []),
            "skipped": salvaged.get("skipped", []),
            # Both are true and neither implies the other: the repository was
            # not fully read, and here is the part that was. A caller that
            # reports a count from this without saying so is claiming an
            # observation it does not have.
            "unread": True,
            "unreadReason": outcome.detail
            or "the process reading this repository ended before it reported",
        }
        last = salvaged.get("lastAttempted")
        if last:
            # The file being read when the process died is the single most
            # useful thing here: it is the likeliest cause, and it is the one
            # the student can go and look at.
            record["endedWhileReading"] = last
        return Survey(outcome.status, record, outcome.detail)


def _journal_line(kind: str, entry: object) -> Dict[str, object]:
    """One journal record, in the same shape ``Discovery.to_dict`` produces.

    Same shape on purpose: a reader that already handles a completed record
    handles a salvaged one without a second code path, and a divergence
    between the two would be a bug nobody notices until a crash.
    """

    if kind == "root":
        return {
            "kind": "root",
            "root": str(getattr(entry, "path", "")),
            "rootReason": str(getattr(entry, "reason", "")),
            "considered": [str(path) for path in getattr(entry, "considered", ())],
        }
    if kind == "reading":
        # A bare path, because nothing else is known yet: the file has not
        # been executed, so there is no outcome to describe.
        return {"kind": "reading", "path": str(entry)}
    if kind == "module":
        return {
            "kind": "module",
            "name": str(getattr(entry, "name", "")),
            "path": str(getattr(entry, "path", "")),
            "origin": str(getattr(entry, "origin", "file")),
        }
    return {
        "kind": "skipped",
        "name": str(getattr(entry, "name", "")),
        "path": str(getattr(entry, "path", "")),
        "reason": str(getattr(entry, "reason", "")),
        "detail": str(getattr(entry, "detail", "")),
        "missing": getattr(entry, "missing", None),
    }


def _replay_journal(trail: Path) -> Dict[str, object]:
    """Rebuild what the child reported before it stopped reporting.

    The last line may be half-written: the process can die between the write
    and the flush. A line that will not parse is dropped rather than guessed
    at, because half a record is not a fact about a module.
    """

    salvaged: Dict[str, object] = {"modules": [], "skipped": []}
    try:
        raw = trail.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return salvaged
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        kind = record.pop("kind", "")
        if kind == "root":
            salvaged.update(record)
        elif kind == "reading":
            salvaged["lastAttempted"] = record.get("path", "")
        elif kind in ("module", "skipped"):
            # Its outcome arrived, so it is not what the process died on.
            salvaged.pop("lastAttempted", None)
            salvaged[  # type: ignore[union-attr]
                "modules" if kind == "module" else "skipped"
            ].append(record)
    return salvaged
