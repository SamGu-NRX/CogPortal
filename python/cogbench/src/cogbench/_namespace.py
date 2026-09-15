"""A freshly read copy of their repository, and their own code taken off it.

Discovery imports a repository once. Every trial of the search then calls
functions that share those module objects and those class objects, so whatever
one trial put in a module-level dict is still there for the next one. Measured
on temporary projects under Python 3.8.20 and 3.13.12: a store that refuses a
song id it has already seen accepted one enrolment and refused the next nine,
in the module-global form and in the class-attribute form alike. Reading the
repository again for each trial produced ten successful enrolments in both.

So a trial owns a `Project`: one `discover()` of its own, and a map from the
candidates the search selected onto the same code inside that new namespace.
Three rules make the map trustworthy.

The map goes by source file and export identity, never by label. Discovery
names some modules from a counter that is never restarted, so two readings of
one file can disagree about its name while being the same file.

A name that is not there is a refusal with a category, never a fall back to
the callable the search held. Returning the stale one would hand a scored run
the object the search filled, which is the whole defect this exists to fix.

Their code runs inside `found.imports()`, which is the import context that
reading built, and only around the call itself. A function that imports a
sibling in its own body does that when it is called, and the names have to be
there for that one call and gone again afterwards.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import tempfile
from collections.abc import Mapping as _MappingABC, MutableMapping
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from types import ModuleType
from typing import (
    Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Set,
    Tuple, Union,
)

from . import memo
from .discover import Discovery, discover, _Redirects
from .pipeline import Candidate, _Described, _invoke, _write_folder, _Receiver

__all__ = [
    "Unmapped", "Closed", "CleanupFailed", "Project", "Bundle", "Handed",
    "declared_in", "reads_anything", "opened", "collides", "module_origins",
    "taken_as_data",
]

#: Read a missing attribute apart from one that is really None.
_ABSENT = object()


class Unmapped(Exception):
    """Their code is not in a freshly read copy, so this call has no binding.

    ``reason`` is the category, for a caller that reports failures by kind
    rather than by sentence:

    ``"no_source"``
        The candidate does not name a file of theirs that reading found.
    ``"file_missing"``
        The file it came from did not import this time.
    ``"export_missing"``
        The file imported and no longer holds that name.
    ``"kind_changed"``
        The name is there and is a different kind of thing, so calling it
        would not be the call the search proved.
    ``"construction_failed"``
        Their class would not build again.
    ``"benchmark_inputs"``
        The benchmark's own inputs could not be copied, so there is nothing
        unmutated to hand their code.

    The rest are raised by `resolve`, where a whole chain rather than one
    candidate is being put back on a new reading:

    ``"fit_failed"``, ``"branch_failed"``
        One of their functions raised while the chain was being rebuilt.
    ``"branch_input"``
        The benchmark's input for that branch could not be made again.
    ``"model_failed"``, ``"hook_contract"``
        The week's own `construct` raised, or did not yield what it said it
        would. Neither is the repository's fault, and a week reporting by
        kind needs to tell those apart from the six above.
    """

    def __init__(self, reason: str, label: str, detail: str = "") -> None:
        self.reason = reason
        self.label = label
        self.detail = detail
        super().__init__(
            "{} could not be taken off a freshly read copy of your repository "
            "({}{})".format(label, reason, ": " + detail if detail else "")
        )


class Closed(Exception):
    """This reading was closed. Nothing can be taken off it or called on it.

    Loud on purpose. A callable someone kept from before the close would
    otherwise answer out of a namespace nobody owns any more, which is the
    stale answer this whole module exists to prevent.
    """


def _also(primary: Any, secondary: BaseException) -> None:
    """Record a cleanup failure on the failure that was already travelling.

    Not raised over it and not dropped. `cogbench_cleanup` is read by
    `Submission.close`, so a run whose body failed AND whose loader would not
    let go reports both rather than trading one for the other.
    """

    if primary is None:
        return
    existing = list(getattr(primary, "cogbench_cleanup", ()))
    existing.append(str(secondary))
    try:
        primary.cogbench_cleanup = tuple(existing)
    except BaseException:  # noqa: BLE001 - some exceptions refuse attributes
        pass


class CleanupFailed(Exception):
    """Their model loader raised while being shut down.

    The reading is closed either way, so this never leaves a namespace half
    owned. It is raised rather than swallowed because a loader that cannot
    release its files is a real fact about the run, and reported rather than
    fatal because it happens after the work is done.
    """


def module_origins(found: Discovery) -> Dict[str, str]:
    """Where each module of theirs came from, by the name it answers to.

    Keyed on ``module.__name__`` rather than on `LoadedModule.name`, because
    that is the name a candidate carries: `pipeline.callables_in` labels a
    function with the module's own ``__name__``, and a package initializer is
    filed under ``__init__`` while calling itself ``pkg``.

    This is the whole of what a later reading needs from an earlier one, which
    is why a run keeps it rather than the discovery it came from.
    """

    where: Dict[str, str] = {}
    for entry in found.modules:
        name = getattr(entry.module, "__name__", None)
        if name and name not in where:
            where[name] = os.path.realpath(str(entry.path))
    for module in found.imports().modules.values():
        name = getattr(module, "__name__", None)
        origin = getattr(module, "__file__", None)
        if name and origin and name not in where:
            where[name] = os.path.realpath(str(origin))
    return where


def _by_origin(found: Discovery) -> Dict[str, ModuleType]:
    """Each module of theirs, by the file it was read from."""

    where: Dict[str, ModuleType] = {}
    for entry in found.modules:
        where.setdefault(os.path.realpath(str(entry.path)), entry.module)
    for module in found.imports().modules.values():
        origin = getattr(module, "__file__", None)
        if origin:
            where.setdefault(os.path.realpath(str(origin)), module)
    return where


@contextlib.contextmanager
def opened(
    construct: Callable[..., Any],
    found: Discovery,
    resource_files: Optional[Dict[str, Path]],
    inputs: Mapping[str, Any],
    inside: Optional[Callable[[], Any]] = None,
) -> Iterator[Mapping[str, Any]]:
    """Their models for one namespace, shut down in the world they were built in.

    Model values are not inspected to infer cleanup: no traversal, no
    guessing at a `close` method. What the hook yields is checked against the
    mapping contract by `_as_models` and nothing further. Both ends run under
    this namespace's own imports and course-file mapping, because shutting a
    loader down runs their code too. Separate blocks, so the hook does not
    hold their names open in between.

    ``inside`` is the reading's own working directory, when it has one, and
    both ends run in it for the same reason: a loader that reads a relative
    path when it opens reads one when it closes.

    A hook whose block opens and then yields something that is not a mapping
    is closed here rather than left to the collector. A hook written as a
    generator survived that by accident, since nothing referenced the
    exhausted generator and CPython ran its `finally`; one written as a class
    with `__enter__` and `__exit__` was entered and never exited at all.

    It is told what went wrong on the way out, because it is being shut down
    in the middle of a failure and a loader that releases a handle only when
    `exc_type` is set is written the way the language says to write one. What
    it returns is ignored: suppression is an answer about the body of a
    `with`, and the contract was broken before there was a body to run.
    """

    # `nullcontext` for a reading that owns no directory, which is every
    # binding with no folder step in it.
    stand = inside or contextlib.nullcontext
    with _Redirects(resource_files or {}), found.imports(), stand():
        holding = construct(found.root.path, found.namespace, inputs)
        entered = holding.__enter__()
        try:
            models = _as_models(entered)
        except BaseException as primary:
            try:
                holding.__exit__(type(primary), primary, primary.__traceback__)
            except BaseException as secondary:  # noqa: BLE001 - their loader
                # Worded the way `Project.close` words it, since a reader
                # meets the two in the same place and a bare message does not
                # say what raised.
                _also(primary, CleanupFailed(
                    "their model loader raised while closing: {}: {}".format(
                        type(secondary).__name__, str(secondary)[:160]
                    )
                ))
            raise
    try:
        yield models
    finally:
        with _Redirects(resource_files or {}), found.imports(), stand():
            holding.__exit__(None, None, None)


def _where_it_is(source: Any) -> Path:
    """One source of this call, absolute, still called what it was called.

    A relative name is made absolute against the caller's own directory,
    because `running` is about to stand somewhere else.

    Only the directory part is resolved. `Path.resolve()` follows the last
    component too, so a photo the benchmark handed over as `student-one.png`
    pointing at `target.png` was copied in under the target's name, and a week
    whose right answer is the name it handed over read a file it had never
    named. The copy reads through the link either way; only what it is called
    on the other side changes.
    """

    path = Path(source)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path.parent.resolve() / path.name


def _paths_handed(name: str, args: Sequence[Any]) -> List[Any]:
    """Every path this call was handed, refused rather than filtered.

    Discovery's `_files_in` answers a different question. It is choosing
    whether a form of the fixture is paths on disk at all, so it drops
    anything that is not, and that is right for a probe and wrong here: this
    step is bound, the folder is about to be replaced, and quietly leaving a
    missing photo out would run their code over a smaller batch than the
    benchmark handed over and score what came back.

    The shape is settled here and the files themselves by `_write_folder`,
    which is the one thing that knows what may go in a folder.
    """

    def refuse(detail: str) -> Unmapped:
        return Unmapped(
            "benchmark_inputs", name,
            "this step reads a folder of the benchmark's files, so it is "
            "called with one sequence of paths, and " + detail,
        )

    if len(args) != 1:
        raise refuse("this call handed it {} arguments".format(len(args)))
    handed = args[0]
    if isinstance(handed, (str, bytes)):
        raise refuse("this call handed it one {}".format(type(handed).__name__))
    try:
        paths = list(handed)
    except TypeError:
        raise refuse(
            "{} cannot be read as one".format(type(handed).__name__)
        ) from None
    wrong = sorted(repr(item) for item in paths if not isinstance(item, (str, Path)))
    if wrong:
        raise refuse("{} {} not a path".format(
            ", ".join(wrong), "is" if len(wrong) == 1 else "are"
        ))
    return paths


def _as_models(yielded: Any) -> Dict[str, Any]:
    """What a `construct` block yielded, checked before anything is called.

    Checked here rather than where a value is used: yielding None surfaced as
    `'NoneType' is not iterable` from the argument builder, and a non-string
    name as `keywords must be strings` from the call. Neither named the hook.
    Converting the mapping runs the week's code, so that is contained too.
    """

    if yielded is None:
        raise Unmapped(
            "hook_contract", "this week's models",
            "`construct` yielded nothing; it must yield a mapping of name to model",
        )
    if not isinstance(yielded, _MappingABC):
        raise Unmapped(
            "hook_contract", "this week's models",
            "`construct` yielded {}; it must yield a mapping of name to "
            "model".format(type(yielded).__name__),
        )
    try:
        made = dict(yielded)
    except BaseException as error:  # noqa: BLE001 - the week's own mapping
        raise Unmapped(
            "hook_contract", "this week's models",
            "its mapping could not be read: {}".format(type(error).__name__),
        ) from None
    wrong = sorted(repr(key) for key in made if not isinstance(key, str))
    if wrong:
        raise Unmapped(
            "hook_contract", "this week's models",
            "names must be strings, and {} {} not".format(
                ", ".join(wrong), "is" if len(wrong) == 1 else "are"
            ),
        )
    return made


def collides(models: Mapping[str, Any], data: Sequence[str]) -> Tuple[str, ...]:
    """Names a week's own hook claims that its benchmark data already holds.

    Refused rather than resolved. Either one could reasonably own such a
    name, and picking would be guessing which half of the week's own
    declaration to believe.
    """

    return tuple(sorted(set(models) & set(data)))


def _export(module: ModuleType, qualname: str, label: str) -> Any:
    """One export of a module, read by the path its qualified name spells.

    A function a team parked inside a class is reached the same way a module
    function is, because ``__qualname__`` already says which class it is in.
    A name defined inside another function cannot be reached at all, and
    saying so is better than guessing at a same-named module attribute.
    """

    if not qualname or "<locals>" in qualname:
        raise Unmapped("no_source", label, "defined inside another function")
    found: Any = module
    for part in qualname.split("."):
        found = getattr(found, part, _ABSENT)
        if found is _ABSENT:
            raise Unmapped(
                "export_missing", label,
                "{} has no {}".format(getattr(module, "__name__", "?"), part),
            )
    return found


class Project:
    """One fresh reading of their repository, and their code taken off it.

    Reading happens once, on first use, because a trial the search skips
    before it calls anything should cost nothing. Everything derived from it
    is shared for the life of this project and no longer: two candidates that
    came off one object during the search come off one new object here, and
    two projects share nothing at all.

    Whoever made a reading owns closing it: a trial at the end of its own
    pairing, the search when it returns, a returned submission when its caller
    is done. After that, anything still holding a callable off it raises
    `Closed`.

    A reading that is handed a folder of the benchmark's files also owns a
    directory to put them in; see `home`. It is made only when something asks
    for it, so a week whose acceptance test gives each attempt a working
    directory of its own is unaffected.

    `close` releases three things in order. The week's `construct` block exits
    first, under this reading's own imports and course-file mapping, since
    shutting a loader down runs their code and it may still want its files;
    then the directory goes; then the references. What their module body did
    at import beyond that is still theirs.
    """

    __slots__ = (
        "_repository", "_hints", "_declared_root", "_resource_files",
        "_origin", "_found", "_observed", "_fresh_modules", "_where",
        "_instances", "_pinned", "_receivers",
        "_models", "_holding", "_home", "_closed", "_calls", "_bindings",
    )

    def __init__(
        self,
        repository: Path,
        origin: Union[Discovery, Mapping[str, str]],
        *,
        hints: Sequence[str] = (),
        declared_root: Optional[str] = None,
        resource_files: Optional[Dict[str, Path]] = None,
        observed: Optional[Set[Path]] = None,
    ) -> None:
        #: Where each module the candidates came off was read from, by the
        #: name a candidate carries (`module_origins`). A discovery may be
        #: handed over instead and is read for that map on first use, never
        #: called into; the map is not taken in advance because a trial the
        #: search skips before calling anything should cost nothing. A run
        #: that has its own reading passes the map, so nothing of the search's
        #: is held here.
        self._origin = origin
        self._repository = Path(repository)
        self._hints = tuple(hints)
        self._declared_root = declared_root
        self._resource_files = dict(resource_files or {})
        #: A set the caller owns. Every file this project's reading and this
        #: project's own late imports touched is reported into it, which is how
        #: the memo key finds out about a source nobody hashed at lookup.
        self._observed = observed
        self._found: Optional[Discovery] = None
        self._where: Dict[str, str] = {}
        self._fresh_modules: Dict[str, ModuleType] = {}
        #: One new object per object the search took methods off, so a store
        #: and the query that read its table still share one database.
        self._instances: Dict[int, Any] = {}
        #: The originals those ids belong to, held so no id is ever reused.
        self._pinned: List[Any] = []
        #: One new construction handle per handle the search shared, so a
        #: constructor step publishes into the handle its own methods read.
        self._receivers: Dict[int, _Receiver] = {}
        #: Their models for this reading, and the block that owns shutting
        #: them down. Entered once, exited once, by `close`.
        self._models: Optional[Mapping[str, Any]] = None
        self._holding: Any = None
        #: This reading's own working directory, made on first ask by `home`
        #: and removed by `close`. None for a binding that never reads a
        #: folder, which is every binding the search has met so far.
        self._home: Optional[Path] = None
        self._closed = False
        self._calls: List[Candidate] = []
        self._bindings: List[Candidate] = []

    def home(self) -> Path:
        """This reading's own directory, made on first ask and removed by `close`.

        Once it exists, every call through `running` is made from inside it,
        so a relative name their code reads on its tenth call means what it
        meant on its first. `furnish` is the only thing that writes here.

        Made lazily and owned outright. Nothing registers it anywhere else, so
        the only thing that can delete it is the `close` of the reading that
        made it.
        """

        if self._closed:
            raise Closed("this reading was closed")
        if self._home is None:
            self._home = Path(tempfile.mkdtemp(prefix="cogworks-run-")).resolve()
        return self._home

    def furnish(self, name: str, files: Sequence[Any]) -> Path:
        """Put this call's own files under ``<home>/<name>``.

        Their reader takes no arguments and reads a directory, so the files
        this call was handed are what goes in it. Copies, made fresh for each
        call, so a step that writes to what it reads writes to ours and the
        benchmark's originals are untouched.

        The whole batch or none of it. `_write_folder` settles every source
        before it removes anything, so a call handed one photo that is not
        there leaves the last call's folder alone and says which path it was,
        rather than running their code over a folder holding some of this
        call's input.

        Called before the working directory changes, while a relative source
        name still means what the caller meant by it.
        """

        if not files:
            raise Unmapped(
                "benchmark_inputs", name,
                "this step reads a folder of the benchmark's files and this "
                "call handed it none",
            )
        sources = [_where_it_is(source) for source in files]
        home = self.home()
        reason = _write_folder(home, name, sources)
        if reason is not None:
            raise Unmapped("benchmark_inputs", name, reason)
        return home / name

    def models(
        self,
        construct: Callable[..., Any],
        inputs: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        """Their models, built once in this reading and kept until `close`.

        A model is not data. It is an object their own loader builds out of
        their own weights, and it belongs to the namespace that built it, so
        every reading builds its own and none is ever copied from another.
        Within this reading it is shared the way their code would share it.

        The hook owns cleanup. Its yielded mapping is validated, but model
        values are not inspected to infer how to release them.
        """

        if self._models is None:
            self._holding = opened(
                construct, self.found, self._resource_files, inputs, self._inside
            )
            self._models = self._holding.__enter__()
        return self._models

    def close(self) -> None:
        """Release this reading, shutting their loader down first.

        Order is the whole of it. The week's block exits while this reading's
        imports, its course-file mapping and its own directory still answer,
        because a loader closing its files is running their code and needs the
        world it was built in. The directory goes next, whether or not that
        loader complained: a reading that is being let go must not leave a
        folder of the benchmark's photos on the disk because their `__exit__`
        raised. Only then are the references dropped.

        Idempotent, and the reading is closed even when their shutdown
        raises: a namespace half owned is worse than a loader that complained
        on the way out, which is reported as `CleanupFailed` instead.
        """

        if self._closed:
            return
        self._closed = True
        holding, self._holding, self._models = self._holding, None, None
        complaints: List[str] = []
        if holding is not None:
            try:
                holding.__exit__(None, None, None)
            except BaseException as error:  # noqa: BLE001 - their loader
                complaints.append(
                    "their model loader raised while closing: {}: {}".format(
                        type(error).__name__, str(error)[:160]
                    )
                )
        home, self._home = self._home, None
        if home is not None:
            try:
                shutil.rmtree(str(home))
            except OSError as error:
                # A loader still holding a file open under it is the ordinary
                # cause, and it is the same kind of fact as the complaint
                # above: reported, not fatal, and not a reason to keep the
                # reading half open.
                complaints.append(
                    "this run's own folder would not delete: {}".format(error)
                )
        # What this reading imported, said before the reading is let go and
        # whether or not their loader complained. A file one of their
        # functions imported while it ran is the reason a memo key would be
        # unsafe, and dropping the reading first would take the only record
        # of it with us.
        self._report()
        self._found = None
        # Including where the candidates came from. A closed reading answers
        # nothing, and a caller that was handed a discovery rather than the
        # map would otherwise go on holding that discovery's modules through
        # a reading it has already let go.
        self._origin = {}
        self._fresh_modules = {}
        self._where = {}
        self._instances = {}
        self._pinned = []
        self._receivers = {}
        self._calls.clear()
        for binding in self._bindings:
            # A binding holds what the run says about the step and the handles
            # this reading needed to make the call. The second half is ours and
            # goes now, or a week whose model has no `close` of its own stays
            # in memory for as long as anything holds the record. `call`
            # becomes `_sealed`'s own closure, which `Candidate.bound` already
            # returns and which now refuses.
            object.__setattr__(binding, "call", binding._runtime_call)
            object.__setattr__(binding, "owner", None)
            object.__setattr__(binding, "receiver", None)
            # What stays is what the record renders: `resolve._given_to` reads
            # the folder name, the pooled name, the sentence
            # `pipeline._from_pool` wrote under it, and a module-value fit's
            # note. Every other entry is a live object of the week's.
            recorded = {key: binding.supplied[key]
                        for key in ("folder", "pooled", "value")
                        if key in binding.supplied}
            told = binding.supplied.get(recorded.get("pooled"))
            if isinstance(told, str):
                recorded[recorded["pooled"]] = told
            binding.supplied.clear()
            binding.supplied.update(recorded)
        self._bindings.clear()
        if complaints:
            raise CleanupFailed("; ".join(complaints))

    @property
    def closed(self) -> bool:
        return self._closed

    def __enter__(self) -> "Project":
        return self

    def __exit__(self, *exc: Any) -> None:
        """Close, without letting the loader's parting complaint take over.

        Leaving a `with` because something went wrong inside it means that
        something is what the caller came for. The reading closes either way,
        and the complaint rides on the exception as ``cogbench_cleanup``
        rather than replacing it. An explicit `close` with nothing in flight
        still raises, which is the only way anyone would hear about it.
        """

        try:
            self.close()
        except CleanupFailed as cleanup:
            if exc and exc[0] is not None:
                _also(exc[1], cleanup)
                return
            raise

    @property
    def found(self) -> Discovery:
        """This project's own reading, performed once."""

        if self._closed:
            raise Closed("this reading was closed")
        if self._found is None:
            found = discover(
                self._repository,
                hints=self._hints,
                declared_root=self._declared_root,
                resource_files=self._resource_files,
            )
            self._found = found
            self._where = (
                dict(self._origin) if isinstance(self._origin, _MappingABC)
                else module_origins(self._origin)
            )
            self._fresh_modules = _by_origin(found)
            self._report()
        return self._found

    def _report(self) -> None:
        """Tell the caller which files this reading actually touched."""

        if self._observed is None or self._found is None:
            return
        self._observed.update(memo.source_paths(self._found))

    @contextlib.contextmanager
    def running(self) -> Iterator[None]:
        """Their names in place, for the length of one call into their code.

        Read first and enter afterwards. Reading a repository inside an
        installed context would let this project import the other project's
        modules under their own names.

        Inside this reading's own directory too, once it has one, so every
        call of this run reads the same relative names: the constructor, a
        method reached off it later, a fit stage, a dependent branch.
        """

        found = self.found
        with found.imports(), self._inside():
            try:
                yield
            finally:
                # A lazy import inside that call is theirs as well, and the
                # context has just filed it. Report it before the key is
                # written rather than discovering it on a later run.
                self._report()

    @contextlib.contextmanager
    def _inside(self) -> Iterator[None]:
        """Stand in this reading's own directory, when it has one.

        Nothing happens when it has none, and that is the common case: only a
        binding that was handed a folder makes one. So a week whose acceptance
        test builds each attempt a working directory of its own still has
        their code run there, which `resolve` has relied on since before this
        existed.

        The change is process-wide for the length of the call, which is what
        `os.chdir` is. Anything else running in this process at the same time
        sees it, and nothing here isolates that.

        One consequence of the two suppressions below, observed rather than
        argued: when the caller's own directory is already gone, the call ends
        standing in this run's home, and `close` then removes that home, so the
        process is left with a working directory that does not exist and
        `os.getcwd()` raises from then on. Reproduced on 3.8.20 and 3.13.12.
        Which directory a process should be moved to instead is the caller's
        question, not this one's, so nothing here answers it.
        """

        if self._home is None:
            yield
            return
        try:
            was = os.getcwd()
        except OSError:
            # Their own teardown removed the directory we were called from.
            # There is nowhere to go back to, so this run's home is where we
            # stay rather than failing the call over it.
            was = str(self._home)
        os.chdir(str(self._home))
        try:
            yield
        finally:
            try:
                os.chdir(was)
            except OSError:
                # Same case, discovered on the way out. Raising here would
                # replace whatever the call was for with a complaint about a
                # directory the caller already deleted.
                pass

    def rebind(
        self,
        candidate: Candidate,
        finish: Optional[Callable[[Candidate], Candidate]] = None,
    ) -> Candidate:
        """The same code as ``candidate``, taken off this project.

        Everything about the call is preserved: the label the record carries,
        the plan, the tuning, the handoff, the per-item loop. Only where the
        code lives changes.

        ``finish`` is the caller's last word on the call, applied after the
        code has moved and before the candidate becomes callable. It exists
        because the two cannot be done in the other order. `Candidate.bound`
        runs through a closure over one exact candidate, so a caller that took
        a callable candidate and then changed what it is handed would have
        changed the record and not the call: the step would report this
        reading's side inputs and execute the search's. Sealing last is what
        makes those the same thing.
        """

        if "pooled" in candidate.supplied:
            # Not one of their functions. `pipeline._from_pool` offers the
            # benchmark's own object to a stage that declared it, so there is
            # no code of theirs to move; the caller still says what it is
            # handed, and it is still sealed here.
            return self._sealed(candidate, finish)
        provenance = getattr(candidate, "_fit_provenance", None)
        export = getattr(provenance, "export_attribute", None)
        if export is not None:
            return self._sealed(self._rebind_value(candidate, export), finish)
        if "value" in candidate.supplied:
            # A fit that bound to a value their module computed at import.
            # Which name it was is `_FitProvenance.export_attribute`; without
            # it the only other way to the value is the closure of the helper
            # the search built, and reading that binds to the old module's
            # object rather than to this one's.
            raise Unmapped(
                "no_source", candidate.label,
                "a module value fit carries no recorded export",
            )
        described = _Described.of(candidate)
        if described.kind == "method":
            return self._sealed(self._rebind_method(candidate, described), finish)
        return self._sealed(self._rebind_call(candidate, described), finish)

    def _module_for(self, module_name: str, label: str) -> ModuleType:
        """The module this project read from the same file as ``module_name``."""

        self.found  # noqa: B018 - reading fills the two maps below
        origin = self._where.get(module_name)
        if origin is None:
            raise Unmapped(
                "no_source", label, "{} is not a file of theirs".format(module_name)
            )
        module = self._fresh_modules.get(origin)
        if module is None:
            raise Unmapped(
                "file_missing", label,
                "{} did not import this time".format(os.path.basename(origin)),
            )
        return module

    def _rebind_call(self, candidate: Candidate, described: _Described) -> Candidate:
        """A plain function of theirs, or a class a stage constructs."""

        fresh = _export(
            self._module_for(described.module, candidate.label),
            described.qualname,
            candidate.label,
        )
        if (described.kind == "class") != isinstance(fresh, type):
            raise Unmapped("kind_changed", candidate.label, "no longer the same kind of name")
        if not callable(fresh):
            raise Unmapped("kind_changed", candidate.label, "no longer callable")
        # A constructor stage keeps the class itself as its call. `_publish`
        # tells a construction from an ordinary call by that, and `_reachable`
        # and `_rebound` both read the type to check a runtime owner.
        return self._pointed(candidate, fresh)

    def _rebind_value(self, candidate: Candidate, export: str) -> Candidate:
        """A fit that bound to a value their module computed when it loaded."""

        module = self._module_for(candidate.module, candidate.label)
        value = getattr(module, export, _ABSENT)
        if value is _ABSENT:
            raise Unmapped(
                "export_missing", candidate.label,
                "{} has no {}".format(getattr(module, "__name__", "?"), export),
            )

        def _held(value: Any = value) -> Any:
            return value

        return self._pointed(candidate, _held)

    def _rebind_method(self, candidate: Candidate, described: _Described) -> Candidate:
        """One of their methods, taken off this project's own object.

        The object comes from one of two places and never from the search. A
        class the search built for free is built again here, once, and shared
        by every candidate that came off that same object. A class a
        constructor stage built from a stage's inputs is built when that step
        runs, and its methods read it through the construction handle they
        share with the step; `pipeline._rebound` is what does that reading.
        """

        fresh_owner = _export(
            self._module_for(described.module, candidate.label),
            described.qualname,
            candidate.label,
        )
        if not isinstance(fresh_owner, type):
            raise Unmapped("kind_changed", candidate.label, "no longer a class")
        if candidate.receiver is not None:
            # Its object is whatever this project's own constructor step
            # returns. Nothing is built here, and the method is taken off the
            # fresh class so the attribute is looked up on the right type.
            attribute = getattr(fresh_owner, candidate.attribute or "", _ABSENT)
            if attribute is _ABSENT:
                raise Unmapped(
                    "export_missing", candidate.label,
                    "{} has no {}".format(fresh_owner.__name__, candidate.attribute),
                )
            return self._pointed(candidate, attribute, owner=fresh_owner)
        instance = self._instance_of(candidate, fresh_owner)
        method = getattr(instance, candidate.attribute or "", _ABSENT)
        if method is _ABSENT or not callable(method):
            raise Unmapped(
                "export_missing", candidate.label,
                "{} has no {}".format(fresh_owner.__name__, candidate.attribute),
            )
        return self._pointed(candidate, method, owner=fresh_owner)

    def _instance_of(self, candidate: Candidate, fresh_owner: type) -> Any:
        """One new object of their class, built once and shared in this trial.

        Keyed on the object the search took the method off, so two methods of
        one search-time object are two methods of one new object. A replayed
        step no longer holds that object and is keyed on this reading's own
        class instead, which is the same grouping: `pipeline.instances_in`
        builds one object per class of theirs, so the methods that shared an
        object are exactly the methods that share a class. Built inside the
        import context and inside whatever directory the caller is in, because
        a constructor of theirs both imports and writes.
        """

        original = getattr(candidate.call, "__self__", None)
        key = id(original) if original is not None else id(fresh_owner)
        if key in self._instances:
            return self._instances[key]
        try:
            with self.running():
                instance = fresh_owner()
        except BaseException as error:  # noqa: BLE001 - their constructor
            raise Unmapped(
                "construction_failed", candidate.label, type(error).__name__
            ) from None
        self._pinned.append(original if original is not None else fresh_owner)
        self._instances[key] = instance
        return instance

    def _receiver_for(self, original: _Receiver) -> _Receiver:
        """A new construction handle standing for one the search shared."""

        key = id(original)
        if key not in self._receivers:
            self._pinned.append(original)
            self._receivers[key] = _Receiver()
        return self._receivers[key]

    def _pointed(
        self, candidate: Candidate, call: Any, owner: Optional[type] = None
    ) -> Candidate:
        """``candidate`` pointed at this project's code, not yet callable."""

        return replace(
            candidate,
            call=call,
            owner=owner if owner is not None else candidate.owner,
            # There is nothing left for the old rebuild callback to do: it
            # built another object out of the search's own class, which is the
            # class this replaces.
            rebuild=None,
            receiver=(
                None if candidate.receiver is None
                else self._receiver_for(candidate.receiver)
            ),
            _runtime_call=None,
            # This one holds its code again, so it is no longer a description.
            _described=None,
        )

    def _sealed(
        self,
        candidate: Candidate,
        finish: Optional[Callable[[Candidate], Candidate]] = None,
    ) -> Candidate:
        """The last thing done to a candidate, making it callable through here.

        `Candidate.bound` runs through a closure, and a closure holds the one
        candidate it was made from. So this is the end of the line: whatever
        the caller still had to say about the call, it says in ``finish``
        first, and only then is the call sealed around the result. Sealing
        earlier and amending afterwards produced a step whose record named
        this reading's side inputs and whose call used the search's.

        Inside, the import context wraps the call and `pipeline._invoke`
        applies the recorded plan exactly once; the plan is not applied here
        and then again there.

        A step bound over a folder takes its files a moment earlier still.
        Such a step is called with no arguments, so the list it was handed is
        the only place this call's files exist; `furnish` puts them where its
        code looks before the call, and before the working directory changes.
        Each call replaces what the last one left, because the folder holds
        this call's input and not the history of the run.
        """

        final = candidate if finish is None else finish(candidate)
        final = replace(final, _runtime_call=None, supplied=dict(final.supplied))
        index = len(self._calls)
        self._calls.append(final)

        def run(*args: Any) -> Any:
            if self._closed:
                raise Closed("this reading was closed")
            payload = self._calls[index]
            folder = payload.supplied.get("folder")
            if folder is not None:
                self.furnish(folder, _paths_handed(folder, args))
            with self.running():
                return _invoke(payload, args)

        binding = replace(final, _runtime_call=run)
        self._bindings.append(binding)
        return binding


def taken_as_data(answer: Mapping[str, Any]) -> Dict[str, Any]:
    """One week's answer about one repository, in containers of our own.

    A week's `prepare` hook is called once per repository, and a plugin that
    resolves several in a row may fill the same nested dictionary each time:
    measured, a submission's ``prepared["weights_report"]["path"]`` read
    `second.pkl` once the next repository had been prepared.

    So the whole answer is taken here, once, under one identity map. Every
    plain dict, list, tuple and set in it is rebuilt, and two names that
    shared one container in the answer share one container here. Anything
    else is the object the week returned and not a copy: a matrix, a path, a
    model it loaded. Copying those is what `Bundle` does for the inputs their
    code is handed and may write to, and this is a report nobody hands to
    their code.

    The contract, for a week reading `Submission.prepared` back: the
    containers are the run's, so filling yours again cannot change what an
    earlier run reports; everything inside them is still yours, so writing
    into an array you returned changes what every run that holds it reports.
    A dict or list subclass is one of those objects, kept as it is. An answer
    that refers back to itself at any depth keeps that reference, pointing at
    the rebuilt container rather than at the week's.
    """

    shared: Dict[int, Any] = {}
    taken: Dict[str, Any] = {}
    # Registered before the walk, like the containers inside it: the answer
    # itself is one of the things the answer can refer to, and without this a
    # report that held itself came back holding a second copy of itself.
    shared[id(answer)] = taken
    for name, value in answer.items():
        taken[name] = _as_data(value, shared)
    return taken


def _as_data(value: Any, seen: Dict[int, Any]) -> Any:
    """One value of that answer. See `taken_as_data` for the contract."""

    if id(value) in seen:
        return seen[id(value)]
    kind = type(value)
    if kind is dict:
        made: Dict[Any, Any] = {}
        seen[id(value)] = made
        for key, inner in value.items():
            made[key] = _as_data(inner, seen)
        return made
    if kind is list:
        rows: List[Any] = []
        seen[id(value)] = rows
        for inner in value:
            rows.append(_as_data(inner, seen))
        return rows
    if kind is tuple:
        # Built after its contents rather than before, which a tuple has no
        # choice about, and reachable again during that walk through a list it
        # holds. The inner visit finishes first and registers the copy, so
        # taking that one keeps `rows = []; loop = (rows,); rows.append(loop)`
        # a single tuple. `copy.deepcopy` settles it in the same order.
        taken = tuple(_as_data(inner, seen) for inner in value)
        if id(value) in seen:
            return seen[id(value)]
        seen[id(value)] = taken
        return taken
    if kind in (set, frozenset):
        # Members are hashable, so none of them is a container this rebuilds.
        members = kind(value)
        seen[id(value)] = members
        return members
    return value


class Bundle:
    """Everything the benchmark hands their code, taken before any of it ran.

    The week's case, each fit stage's own fixture, the item names and the
    resources a stage declared are all live objects that end up as arguments
    to their functions, and their functions may write to what they are given.
    Read one back after probing and it is whatever the last probe left, so the
    copy is taken up front and every later use is reconstructed from it.

    One `deepcopy` memo covers all of them, so two inputs that were the same
    object stay the same object. A week that probes a fit stage with the same
    caption corpus its first stage takes means one table, and handing their
    code two tables would be a different program.

    What is NOT in here is anything their own code produced. A fit stage's
    value came out of their modules, and a copy of it is a copy of the
    namespace the search filled; those are recomputed by running the fit again
    on the new reading, never copied. See `resolve._renewed`.

    ``declared`` says which names of the extras pool this covers, and it has
    two shapes because roles do.

    A role whose branch fixtures are all plain values reaches a resource only
    through `Stage.extras`, so those declarations are the whole of it. An
    entry nobody declared is never handed to their code and is not copied.

    A role with a callable branch fixture has an open read set: the hook is
    handed the pool and may read any name in it, and nothing says in advance
    which. Every available name is snapshotted up front for such a role, and
    up front is the point, since after probing the values are whatever their
    code left.

    Either way a name that will not copy is recorded against that name alone
    and refuses only when something consumes it: `Unmapped` with reason
    ``"benchmark_inputs"``, naming that input. Snapshotting a name is not
    consuming it, so a week may leave an unreadable object in the pool and a
    repository whose code never reads it still resolves. Handing over the
    probed original instead would put the search's leftovers into a scored
    run, which is the thing this exists to stop.
    """

    CASE = "the benchmark's case"
    NAMES = "the benchmark's item names"

    __slots__ = ("_master", "_broken", "_names")

    def __init__(
        self,
        fixture: Any = (),
        extras: Optional[Dict[str, Any]] = None,
        identities: Sequence[Any] = (),
        declared: Sequence[str] = (),
        fits: Sequence[Tuple[Tuple[str, ...], int, Any]] = (),
    ) -> None:
        shared: Dict[int, Any] = {}
        #: Why one input could not be taken, by the name of that input. Kept
        #: per input rather than for the bundle, so one unreadable resource
        #: refuses the steps that take it and nothing else.
        self._broken: Dict[str, str] = {}
        #: Every consumed input by the name a refusal would use, so one pass
        #: reconstructs the whole of it. Fit fixtures are keyed by the
        #: declaring role path and the stage's original index, because a
        #: branch-local stage name repeats across branches and the two are
        #: different fixtures.
        self._master: Dict[Any, Any] = {}
        self._take(self.CASE, fixture, shared)
        self._take(self.NAMES, tuple(identities or ()), shared)
        pool = dict(extras or {})
        wanted = set(declared)
        #: The benchmark's own names this holds, in the order the caller
        #: supplied them. A week's fixture hook may iterate the pool it is
        #: given, and `_fixture_for` used to hand it a plain `dict` of the
        #: caller's own pool, so that order is part of what a week already
        #: sees. Derived here from the pool itself rather than recorded
        #: anywhere else; `declared` says which names, not what order.
        self._names: List[str] = [name for name in pool if name in wanted]
        for name in self._names:
            self._take(name, pool[name], shared)
        for role_path, index, value in fits:
            self._take((tuple(role_path), int(index)), value, shared)

    def _take(self, what: Any, value: Any, shared: Dict[int, Any]) -> None:
        """One input into the master copy, or the reason it could not go.

        A failure halfway through leaves the pieces it had already copied in
        the shared memo, and a later input that points at one of those pieces
        would then be handed a half-built object and no error. So the memo is
        put back to what it was, keeping only deepcopy's own keep-alive list,
        which holds those pieces long enough that no id is reused.

        One case this does not reach: a ``__deepcopy__`` of the week's own
        that catches an inner failure and returns anyway leaves a half-built
        piece behind while reporting success, and nothing here can tell that
        from a whole one. Detecting it would mean deciding what a complete
        copy of an arbitrary object looks like, which is the thing `deepcopy`
        is for.
        """

        before = set(shared)
        try:
            self._master[what] = deepcopy(value, shared)
        except BaseException as error:  # noqa: BLE001 - a week's own inputs
            for key in set(shared) - before:
                if key != id(shared):
                    del shared[key]
            self._broken[_named(what)] = "{}: {}".format(
                type(error).__name__, str(error)[:120]
            )

    def again(self) -> "Handed":
        """One reconstruction of the whole consumed graph, for one trial."""

        return Handed(self)


class Handed:
    """The benchmark's inputs as one trial receives them.

    One of these per trial and per run of a returned binding, because two
    trials must not share a mutable input and two steps of ONE trial must
    share exactly what the benchmark shares. Both halves matter: a week whose
    first stage takes the same caption table a later stage declares as a
    resource hands their code one table, and handing it two would be a
    different program from the one the week wrote.

    Both halves come from one `deepcopy` memo held here. Copying is still done
    per input on first ask, so an input this binding never consumes is never
    copied, but every ask after the first reuses whatever the memo already
    holds. That is what keeps the aliases.
    """

    __slots__ = ("_bundle", "_memo", "_spoiled")

    def __init__(self, bundle: Bundle) -> None:
        self._bundle = bundle
        self._memo: Dict[int, Any] = {}
        self._spoiled = ""

    def _copy(self, what: Any) -> Any:
        name = _named(what)
        if self._spoiled:
            # An earlier input failed partway and left pieces of itself in the
            # memo. Anything reconstructed after that could quietly be one of
            # those pieces, so this whole reconstruction is refused rather
            # than continued.
            raise Unmapped("benchmark_inputs", name, self._spoiled)
        if name in self._bundle._broken:
            raise Unmapped("benchmark_inputs", name, self._bundle._broken[name])
        if what not in self._bundle._master:
            raise Unmapped(
                "benchmark_inputs", name,
                "no stage of this role declares it and the pool has no value for it",
            )
        try:
            return deepcopy(self._bundle._master[what], self._memo)
        except BaseException as error:  # noqa: BLE001 - a week's own inputs
            self._spoiled = "{} could not be made again: {}".format(
                name, type(error).__name__
            )
            raise Unmapped(
                "benchmark_inputs", name, "{}: {}".format(type(error).__name__, error)
            ) from None

    def case(self) -> Any:
        """The week's own case, as it was before anything of theirs ran."""

        return self._copy(Bundle.CASE)

    def identities(self) -> Tuple[Any, ...]:
        """The names of the items the benchmark is handing over."""

        return self._copy(Bundle.NAMES)

    def extra(self, name: str) -> Any:
        """One resource a stage declared, made again for this trial."""

        return self._copy(name)

    def fit_case(self, role_path: Sequence[str], index: int) -> Any:
        """The fixture the stage that declared this fit was probed with."""

        return self._copy((tuple(role_path), int(index)))

    def names(self) -> Tuple[str, ...]:
        """The benchmark's own resource names, in the order they were taken."""

        return tuple(self._bundle._names)

    def pool(self, local: Optional[Dict[str, Any]] = None) -> _Pool:
        """The side inputs a week's own fixture hook may read.

        ``local`` is what their code produced for this trial, which overlays
        the benchmark's names exactly as `_resolve_branches` overlays them.
        """

        return _Pool(self, local, self._bundle._names)


class _Pool(MutableMapping):
    """The side inputs one trial's code can reach, without making them yet.

    A week's branch fixture is handed the pool and may read any name in it:
    week 3's prepare branch is offered the image branch's projected matrix
    alongside the raw descriptors, and the descriptors are the benchmark's.
    Handing it a plain dict means reconstructing every resource first, and one
    of them may be a thing no copy can be taken of. Refusing a repository over
    a resource its code never reads would be refusing it for our convenience,
    so nothing is made until it is asked for by name.

    Free: the names, iteration, length, membership, and taking an `items` or
    `values` view. Consuming: asking for a value, which `get` also does and so
    refuses rather than defaulting; iterating those views; and comparing to
    another mapping, since the inherited `Mapping.__eq__` builds `dict(self)`
    and an opaque entry makes it raise. That comparison is kept on purpose:
    comparing names alone would call two pools with different values equal.

    Writes, deletes and `copy` keep to this mapping. They do not reach the
    trial's reconstruction, which is shared, so a week that rearranges the
    pool it was given changes its own view and nothing else.
    """

    __slots__ = ("_handed", "_local", "_names", "_gone")

    def __init__(
        self,
        handed: "Handed",
        local: Optional[Dict[str, Any]] = None,
        names: Sequence[str] = (),
    ) -> None:
        #: Shared, so every value this hands out comes from the same
        #: reconstruction as the rest of the trial.
        self._handed = handed
        #: What their own code produced, plus anything written here since.
        self._local: Dict[str, Any] = dict(local or {})
        #: The benchmark's own names, in the order they were snapshotted.
        self._names = list(names)
        self._gone: Set[str] = set()

    def _keys(self) -> List[str]:
        order = [name for name in self._names if name not in self._gone]
        order.extend(
            name for name in self._local
            if name not in self._gone and name not in self._names
        )
        return order

    def __iter__(self) -> Iterator[str]:
        return iter(self._keys())

    def __len__(self) -> int:
        return len(self._keys())

    def __contains__(self, key: Any) -> bool:
        return key not in self._gone and (key in self._local or key in self._names)

    def __getitem__(self, key: str) -> Any:
        if key in self._gone:
            raise KeyError(key)
        if key in self._local:
            return self._local[key]
        if key in self._names:
            return self._handed.extra(key)
        raise KeyError(key)

    def __setitem__(self, key: str, value: Any) -> None:
        self._gone.discard(key)
        self._local[key] = value

    def __delitem__(self, key: str) -> None:
        if key not in self:
            raise KeyError(key)
        self._local.pop(key, None)
        self._gone.add(key)

    def __copy__(self) -> "_Pool":
        """Another view of the same reconstruction, with its own state.

        Every container this keeps is made again here rather than shared. A
        generic shallow copy would hand both views one ``_local`` dict and one
        ``_gone`` set, so a week that wrote into the pool it was given would
        be writing into the pool the search is carrying. The reconstruction
        itself IS shared, on purpose: it is this trial's, and a copy of the
        pool is still the same trial.
        """

        # The constructor takes its own `dict` of the overlay and its own
        # `list` of the names; the removed set is made again here.
        made = _Pool(self._handed, self._local, self._names)
        made._gone = set(self._gone)
        return made

    def copy(self) -> "_Pool":
        return self.__copy__()


def _named(what: Any) -> str:
    """How one consumed input is named in a refusal."""

    if isinstance(what, tuple):
        return "the fixture of {}[{}]".format(".".join(what[0]), what[1])
    return what


def declared_in(role: Any, path: Sequence[str] = ()) -> Tuple[List[str], List[Tuple[Tuple[str, ...], int, Any]]]:
    """Which resources this role's stages ask for, and each fit's own fixture.

    Read off the role before the search starts, which is the only moment they
    are certainly unmutated. The path distinguishes two branches that both
    declare a stage called ``fit``, which are two stages and two fixtures.
    """

    here = tuple(path) or (role.name,)
    names: List[str] = []
    fits: List[Tuple[Tuple[str, ...], int, Any]] = []
    for index, stage in enumerate(role.stages):
        names.extend(stage.extras)
        if stage.fit:
            fits.append((here, index, stage.fixture))
    for branch in getattr(role, "branches", ()) or ():
        inner_names, inner_fits = declared_in(branch, here + (branch.name,))
        names.extend(inner_names)
        fits.extend(inner_fits)
    return names, fits


def reads_anything(role: Any) -> bool:
    """Whether some branch of this role makes its own input from the pool.

    A `Stage.extras` name is a declaration: the week said which resources
    that stage takes, and nothing else can reach one. A branch fixture
    written as a callable is not. It is handed the pool and may read any name
    in it, so for such a role there is no smaller honest answer than every
    name the caller supplied.

    Read off the role's own fixtures, which is where the fact lives; nothing
    declares it separately and nothing infers it from what a week happens to
    read on one run.
    """

    for branch in getattr(role, "branches", ()) or ():
        if callable(getattr(branch, "fixture", None)) or reads_anything(branch):
            return True
    return False
