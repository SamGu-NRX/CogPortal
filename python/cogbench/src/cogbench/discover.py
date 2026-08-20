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
audited repositories the only third-party modules the sandbox images lack are
``streamlit``, ``microphone``, ``pyaudio``, and ``networkx`` -- interface and
hardware packages that no scored path touches. Those four get a recording stub
so a module that mentions one at import scope still yields its functions. The
list is fixed, identical for every repository, and reported on every run;
growing it per repository would be hand-wiring under another name.
"""

from __future__ import annotations

import ast
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Dict, List, Optional, Sequence, Tuple

__all__ = [
    "STUBBED_MODULES",
    "SKIPPED_DIRECTORIES",
    "LoadedModule",
    "SkippedModule",
    "RootChoice",
    "Discovery",
    "Survey",
    "candidate_roots",
    "choose_root",
    "notebook_source",
    "load_modules",
    "discover",
    "survey",
]

#: Absent from the sandbox images and never on a scored path. Measured across
#: the thirteen 2026 repositories: ``streamlit`` appears in 13 module-scope
#: imports, ``microphone`` in 9, ``networkx`` in 5, ``pyaudio`` in 1. A stub
#: keeps a module importable when it mentions one of these for a demo or a
#: recording helper. Anything else missing is reported, never invented.
STUBBED_MODULES = ("streamlit", "microphone", "pyaudio", "networkx")

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

#: Wall clock for importing one module. The slowest legitimate import in the
#: corpus builds a FaceNet model; the ones that exceed this are blocking on
#: input() or opening a window.
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


@dataclass(frozen=True)
class RootChoice:
    """Which directory was searched, and why that one."""

    path: Path
    reason: str
    considered: Tuple[Path, ...]


@dataclass
class Discovery:
    """Everything found in one repository, and everything that was not."""

    root: RootChoice
    modules: List[LoadedModule] = field(default_factory=list)
    skipped: List[SkippedModule] = field(default_factory=list)
    stub_calls: List[str] = field(default_factory=list)

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
            "modules": [
                {"name": entry.name, "path": str(entry.path), "origin": entry.origin}
                for entry in self.modules
            ],
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
            "stubbed": list(STUBBED_MODULES),
            "stubCalls": sorted(set(self.stub_calls)),
        }


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
        for child in sorted(directory.iterdir()):
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
    """

    considered = tuple(candidate_roots(repository))

    if declared:
        path = (repository / declared).resolve()
        return RootChoice(path, "declared in cogworks.toml", considered)

    lowered = tuple(hint.lower() for hint in hints)
    if lowered:
        for path in considered:
            if path == repository:
                continue
            name = path.name.lower().replace(" ", "").replace("-", "").replace("_", "")
            if any(hint in name for hint in lowered):
                return RootChoice(path, "directory name matches this week", considered)

    scored = [(path, _root_score(path)) for path in considered]
    best, score = min(scored, key=lambda pair: (-pair[1], len(pair[0].parts)))
    if best == repository:
        return RootChoice(repository, "code sits at the repository root", considered)
    if score > 0:
        return RootChoice(best, "the rest of the code imports from here", considered)
    return RootChoice(best, "holds the most importable files", considered)


def _module_names(directory: Path) -> set:
    return {path.stem for path in _python_files(directory)} | {
        path.stem for path in _notebooks(directory)
    }


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

    try:
        tree = ast.parse("".join(lines))
    except SyntaxError:
        return None

    kept: List[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kept.append(node)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            kept.append(node)
        elif isinstance(node, ast.Assign) and isinstance(
            node.value, (ast.Constant, ast.Dict, ast.List, ast.Tuple, ast.Set)
        ):
            kept.append(node)
    if not any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        for node in kept
    ):
        return None

    return ast.unparse(ast.Module(body=kept, type_ignores=[]))


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

    Scoped to the stub list and nothing else: an unrelated missing package
    still fails, and is still named in the report.
    """

    def __init__(self, calls: List[str]) -> None:
        self._calls = calls

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

    @staticmethod
    def _owns(name: str) -> bool:
        return any(name.startswith(stub + ".") for stub in STUBBED_MODULES)


def _install_stubs(calls: List[str]) -> List[str]:
    installed = []
    for name in STUBBED_MODULES:
        if name in sys.modules:
            continue
        sys.modules[name] = _Stub(name, calls)
        installed.append(name)
    if not any(isinstance(finder, _StubFinder) for finder in sys.meta_path):
        sys.meta_path.insert(0, _StubFinder(calls))
    return installed


def _missing_module(error: BaseException) -> Optional[str]:
    return getattr(error, "name", None) if isinstance(error, ImportError) else None


#: How long one module may spend at import scope before it is abandoned.
#: Importing runs whatever a file does at module level, and files do real work
#: there: one 2026 repository tunes a threshold across 25 iterations while
#: being imported, which took 77 seconds of a 77-second run. Another could
#: loop forever and there would be nothing to report at all, because the
#: report is written after discovery finishes.
#:
#: Thirty seconds is well past anything a definition file needs and well short
#: of a student giving up. A module that exceeds it is skipped and named, so
#: the search continues without it and the report says which file it was.
IMPORT_TIMEOUT_SECONDS = 30


class _ImportTimeout(BaseException):
    """Raised inside the importing thread when a module runs too long.

    Deliberately a BaseException: student code catches Exception liberally,
    and a timeout a module can swallow is not a timeout.
    """


@contextlib.contextmanager
def _deadline(seconds: int, name: str):
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


def _import_one(
    name: str, path: Path, source: Optional[str], timeout: int = IMPORT_TIMEOUT_SECONDS
) -> Tuple[Optional[ModuleType], Optional[SkippedModule]]:
    try:
        if source is None:
            spec = importlib.util.spec_from_file_location(name, path)
            if spec is None or spec.loader is None:
                return None, SkippedModule(
                    name, path, "syntax", "Python could not read this file as a module."
                )
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            with _quiet_import(), _deadline(timeout, name):
                spec.loader.exec_module(module)
        else:
            module = ModuleType(name)
            module.__file__ = str(path)
            sys.modules[name] = module
            with _quiet_import(), _deadline(timeout, name):
                exec(compile(source, str(path), "exec"), module.__dict__)
        return module, None
    except _ImportTimeout:
        sys.modules.pop(name, None)
        return None, SkippedModule(
            name,
            path,
            "too_slow",
            "still running after {} seconds; it does work when imported rather "
            "than when called".format(timeout),
        )
    except SyntaxError as error:
        sys.modules.pop(name, None)
        return None, SkippedModule(
            name, path, "syntax", "line {}: {}".format(error.lineno, error.msg)
        )
    except BaseException as error:  # noqa: BLE001 - student code raises anything
        sys.modules.pop(name, None)
        missing = _missing_module(error)
        if missing:
            return None, SkippedModule(
                name,
                path,
                "missing_dependency",
                "imports {}, which is not installed here".format(missing),
                missing,
            )
        return None, SkippedModule(
            name,
            path,
            "raised",
            "{}: {}".format(type(error).__name__, str(error)[:200]),
        )


def load_modules(
    root: Path,
    *,
    extra: Sequence[Path] = (),
    import_timeout: int = IMPORT_TIMEOUT_SECONDS,
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
    """

    calls: List[str] = []
    _install_stubs(calls)

    loaded: List[LoadedModule] = []
    skipped: List[SkippedModule] = []
    taken: set = set()

    def _consume(directory: Path) -> None:
        for path in _python_files(directory):
            if path.stem in taken:
                continue
            module, failure = _import_one(path.stem, path, None, import_timeout)
            if module is not None:
                loaded.append(LoadedModule(path.stem, path, module, "file"))
                taken.add(path.stem)
            elif failure is not None:
                skipped.append(failure)
        for path in _notebooks(directory):
            if path.stem in taken:
                continue
            source = notebook_source(path)
            if source is None:
                skipped.append(
                    SkippedModule(
                        path.stem,
                        path,
                        "syntax",
                        "no importable definitions; its cells build what they use as they run",
                    )
                )
                continue
            module, failure = _import_one(path.stem, path, source, import_timeout)
            if module is not None:
                loaded.append(LoadedModule(path.stem, path, module, "notebook"))
                taken.add(path.stem)
            elif failure is not None:
                skipped.append(failure)

    _consume(root)
    for directory in extra:
        if directory != root:
            _consume(directory)

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


@contextlib.contextmanager
def _entered(root: Path, *, working: Optional[Path] = None):
    """Run with ``root`` first on the path and ``working`` as the directory.

    The two are separate on purpose. ``root`` is where their modules are found,
    so it must lead ``sys.path`` for their sibling imports to resolve. The
    working directory is where their relative writes land, and that is a
    scratch directory rather than their checkout.

    Afterwards the student's own modules are evicted so a second repository in
    the same process does not import a stale ``database``, and every other
    module stays exactly where it was.

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
    before = set(sys.modules)
    os.chdir(working if working is not None else root)
    sys.path.insert(0, str(root))
    try:
        yield
    finally:
        os.chdir(previous_cwd)
        sys.path[:] = previous_path
        for name in set(sys.modules) - before:
            module = sys.modules.get(name)
            if module is not None and _is_student_module(module, root):
                sys.modules.pop(name, None)


def discover(
    repository: Path,
    *,
    declared_root: Optional[str] = None,
    hints: Sequence[str] = (),
    scratch: Optional[Path] = None,
    import_timeout: int = IMPORT_TIMEOUT_SECONDS,
) -> Discovery:
    """Choose a root, import what imports, and report all of it.

    Never raises for a repository it cannot read. A repository with no
    importable code returns a ``Discovery`` with an empty namespace and a
    ``skipped`` list that says what stopped each file, because that report is
    the thing a student can act on.
    """

    repository = Path(repository).resolve()
    root = choose_root(repository, declared=declared_root, hints=hints)
    if not root.path.is_dir():
        return Discovery(root=root)

    # Everything else that holds code, so a capstone split between a root and a
    # package directory is found whole. The chosen root goes first; it owns
    # import precedence.
    #
    # Except when the root is a week directory. A repository holding Week1,
    # Week2, and Week3 has three capstones in it, and reading all of them while
    # scoring one offers the search functions from the wrong assignment. Only
    # what lives under the chosen week is read then.
    if "matches this week" in root.reason:
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
        with _entered(root.path, working=Path(scratch)):
            modules, skipped, calls = load_modules(
                root.path, extra=extra, import_timeout=import_timeout
            )
    else:
        with tempfile.TemporaryDirectory(prefix="cogworks-import-") as temporary:
            with _entered(root.path, working=Path(temporary)):
                modules, skipped, calls = load_modules(
                root.path, extra=extra, import_timeout=import_timeout
            )
    return Discovery(root=root, modules=modules, skipped=skipped, stub_calls=calls)


@dataclass(frozen=True)
class Survey:
    """What a repository holds, gathered in a process that may not survive it.

    ``discover`` imports student code in the calling process, which is right
    for a benchmark that is about to run that code anyway. ``survey`` is for
    everyone who only wants to look: ``cogworks check``, the portal, a report.
    It returns names and reasons rather than modules, so an import that takes
    the interpreter down with it costs a report instead of a run.
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
    def module_names(self) -> List[str]:
        modules = self.record.get("modules", [])
        return [str(entry["name"]) for entry in modules]  # type: ignore[index]


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
    """

    from .isolate import COMPLETED, run_isolated

    repository = Path(repository).resolve()

    def _work() -> Dict[str, object]:
        return discover(
            repository, declared_root=declared_root, hints=hints
        ).to_dict()

    outcome = run_isolated(_work, timeout_seconds=timeout_seconds)
    if outcome.status == COMPLETED and isinstance(outcome.value, dict):
        return Survey("ok", outcome.value)
    return Survey(
        outcome.status,
        {"root": str(repository), "modules": [], "skipped": []},
        outcome.detail,
    )
