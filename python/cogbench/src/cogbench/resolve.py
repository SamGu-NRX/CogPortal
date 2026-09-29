"""One call that turns a repository into a scoreable submission, or a report.

Every surface asks the same question and must get the same answer. A student
runs ``cogworks check`` in their terminal, the portal shows a run page, the
Discord bot posts a result, and the Modal runner scores the official attempt.
If those disagree about whether a repository resolves, the platform is lying to
somebody. So they all call this, and it is the only place that knows how the
pieces fit together:

``discover`` finds their modules, ``pipeline`` searches those modules for a
chain of functions that performs the week's task, the week's own acceptance
test decides whether the chain is right, and ``verdict`` says what happened in
a sentence a student can act on.

The search is bounded by attempts rather than by names. Every run of the week's
acceptance test is counted and reported, so a repository that takes two
thousand attempts and one that takes fifty are both explicable, and a search
that gives up says how hard it looked.
"""

from __future__ import annotations

import contextlib
import inspect
import sys
from collections.abc import Mapping as _MappingABC, Sequence as _SequenceABC
from copy import deepcopy
from dataclasses import dataclass, field, replace
from pathlib import Path
from types import GetSetDescriptorType, MemberDescriptorType
from typing import (
    Mapping, Any, Callable, Dict, FrozenSet, Iterator, List, Optional, Sequence,
    Set, Tuple,
)

from . import memo, storage
from ._namespace import (
    Bundle, CleanupFailed, Closed, Handed, Project, Unmapped, _also,
    collides, declared_in, module_origins, opened, reads_anything,
    taken_as_data,
)
from .discover import Discovery, discover, _Redirects
from .execution import ExecutionPaths
from .isolate import hash_seed_in_effect as _hash_seed_in_effect
from .progress import Progress
from .pipeline import (
    Binding,
    Candidate,
    Fixtures,
    Role,
    _Described,
    _Receiver,
    callables_in,
    constructors_in,
    identities_for,
    instances_in,
    methods_of,
    resolve_chain,
    _sequential_owners,
    _under_clock,
    _scratch_cwd,
)
from .verdict import (
    SCORED,
    Verdict,
    not_read,
    not_wired,
    nothing_here,
    wired_but_wrong,
)

__all__ = [
    "Submission",
    "SubmissionReport",
    "NoDatabase",
    "Attempt",
    "resolve",
    "from_spec",
]

#: How many attempts to make before giving up. An attempt is one run of the
#: week's acceptance test, and `_pair` makes two kinds: a probe asking whether
#: one of their functions takes an enrolment at all, and a pairing asking
#: whether a store and a query answer together.
#:
#: Measured on the 2026 week 1 corpus, a whole search costs 48 attempts for
#: the repository with no database, 203 for carti4ce, 275 for KrazeeCoder,
#: 1,230 for Cog-gurts and 1,956 for rutvim2009. The ceiling is well above all
#: of them: a repository is refused for having no working pairing, not for
#: being large.
#:
#: Reader probes are not attempts and are not counted here. `_read_further`
#: enumerates orderings of their one-argument functions, so one pairing over a
#: pool of `P` at depth `d` costs `P + P(P-1) + ...` calls: 820 at the 2026
#: corpus median of ten such functions, 14,425 at its maximum of twenty-five
#: (BagelBreaker week 2, counted by AST on 2026-09-11). That recurs per
#: partially-graded pairing and nothing bounds the total. Charging probes to
#: this ceiling was tried and withdrawn: it spent all 20,000 on one repository
#: and refused the later chains untried, where the same repository binds in 54
#: attempts without it. Each probe runs under the per-call clock, which bounds
#: one call of theirs and neither how many calls are made nor how long they
#: take together, and which is not enforced at all on Windows or off the main
#: thread. Bounding the enumeration itself needs a run of the weeks against
#: the corpus that has not happened.
MAX_ATTEMPTS = 20000

#: What `accepts` returns when a pairing answered the question completely.
#: A week's acceptance test may return a plain True, which is this; or a
#: number between 0 and 1 for a pairing that named the right song but told the
#: benchmark less than it asked for, so the search keeps looking for a better
#: one among their own functions.
FULLY_ANSWERED = 1.0


@dataclass(frozen=True)
class Attempt:
    """One pairing that was tried, kept only when it is the one that worked."""

    enroll: str
    query: str
    arrangement: int

    def to_dict(self) -> Dict[str, object]:
        return {"enroll": self.enroll, "query": self.query, "arrangement": self.arrangement}

    @classmethod
    def from_dict(cls, record: Dict[str, object]) -> "Attempt":
        return cls(enroll=record["enroll"], query=record["query"], arrangement=record["arrangement"])


@dataclass(frozen=True)
class SubmissionReport:
    """What a report needs from a ``Submission``, with no live callables in it.

    Reading a repository runs the student's own import statements, and one of
    those can end the interpreter outright rather than raise (see
    ``tests/test_isolate.py``), so the reading happens in a child process. A
    ``Submission`` holds functions bound out of their modules and cannot leave
    that child; this is the part that comes back.
    """

    ready: bool
    verdict: Verdict
    chain: Tuple[str, ...] = ()
    attempt: Optional[Attempt] = None
    #: ``Submission.to_dict()``, for ``check --json`` and the portal.
    record: Optional[Dict[str, object]] = None

    def to_dict(self) -> Dict[str, object]:
        return {"ready": self.ready, "verdict": self.verdict.to_dict(),
                "chain": list(self.chain),
                "attempt": None if self.attempt is None else self.attempt.to_dict(),
                "record": self.record}

    @classmethod
    def from_dict(cls, record: Dict[str, object]) -> "SubmissionReport":
        return cls(ready=record["ready"], verdict=Verdict.from_dict(record["verdict"]),
                   chain=tuple(record["chain"]),
                   attempt=None if record["attempt"] is None else Attempt.from_dict(record["attempt"]),
                   record=record["record"])


@dataclass
class Submission:
    """A repository resolved into something the benchmark can run.

    ``verdict`` is always present. ``ready`` says whether there is anything to
    score; everything else is the evidence behind that.
    """

    verdict: Verdict
    #: The search's own reading, until the binding is handed a reading of its
    #: own. `fresh` lets it go at that handoff and keeps `_origin_files` and
    #: `_discovered` instead, because the modules in here are the ones the
    #: search filled and one of their files may have parked a model in a
    #: global of them. A submission that never binds keeps it while it is
    #: open, since it is the evidence behind the refusal, and `close` reduces
    #: it to the record the same way.
    discovery: Optional[Discovery] = None
    chain: Tuple[Candidate, ...] = ()
    attempt: Optional[Attempt] = None
    attempts_tried: int = 0
    #: Bound callables the driver uses, once resolution succeeded.
    enroll: Optional[Callable[..., Any]] = None
    query: Optional[Callable[..., Any]] = None
    #: Whether this came from a stored binding rather than a fresh search.
    #: Reported, because a student who is told their code is wired up deserves
    #: to know whether that was decided just now or remembered.
    recalled: bool = False

    #: For a week whose role is several branches over one shared pool, each
    #: branch's bound chain. Empty for a single-chain week, which is every
    #: week before week 3.
    branches: Dict[str, Tuple[Candidate, ...]] = field(default_factory=dict)
    #: The side inputs their own code computed once, as (stage name,
    #: candidate). Recorded because they were supplied to every later call
    #: and a run page has to be able to say so.
    fits: Tuple[Tuple[str, Candidate], ...] = ()
    #: The branches the week declared optional that did not bind, by name,
    #: with the refusal each ended on. What a partial set is worth is the
    #: week's to decide; this says which surface is absent and why.
    missing: Dict[str, Any] = field(default_factory=dict)
    #: What could not be released cleanly, in the order it happened. A
    #: week's model hook raising on its way out is a real fact about the run
    #: and belongs on the run, not only on a terminal that may not be there:
    #: `Silent` is the default `Progress` and its `note` does nothing, so a
    #: hosted run used to drop these entirely. It does not change the verdict,
    #: because the scoring already happened and retracting it would be a
    #: worse answer than reporting the leak beside it.
    cleanup: Tuple[str, ...] = ()

    #: Repository-relative POSIX paths of the trained-weights files the
    #: week's `prepare` hook loaded for this run, sorted; empty when none.
    #: Recorded here rather than left in the extras pool because `cogworks
    #: sync` uploads exactly these files so the hosted run can fetch them,
    #: and the upload must name the files discovery actually used, not the
    #: files a directory listing happens to contain. Relative to the project
    #: root the command was given, even when discovery searched below it.
    weights_used: Tuple[str, ...] = ()
    #: One receipt per entry in ``weights_used``, in the same order:
    #: ``{"path", "sha256", "size"}``, measured from the bytes retained
    #: before the week loaded them. The report carries these so `cogworks
    #: sync` uploads the retained bytes rather than whatever the file holds
    #: later.
    #:
    #: Three states, and the middle one is the point. ``()`` is a run with no
    #: weights. A tuple is a run whose week established that its binding
    #: consumed them. ``None`` is a run that scored with weights whose
    #: consumption the week could not establish: the names stay and the
    #: receipts do not exist, because a receipt says which bytes were read
    #: and nothing here can say that on the week's behalf.
    weights_captured: Optional[Tuple[Dict[str, Any], ...]] = ()

    #: What the week's ``prepare`` hook returned for this repository, by name.
    #: The hook is called once per resolution and its answer describes that
    #: repository alone, so a plugin that resolves several in turn cannot keep
    #: it on itself: week 3's report of which weights file it chose, and why
    #: the image side is unmeasured, belongs to the run it was read for.
    #: ``construct`` is already handed this pool; this is the same answer, on
    #: the run the caller got back.
    #:
    #: The containers are this run's own, so preparing the next repository
    #: cannot change what this one reports, and what is inside them is still
    #: the week's. `_namespace.taken_as_data` states that contract in full.
    prepared: Mapping[str, Any] = field(
        default_factory=dict, compare=False, repr=False,
    )

    #: The candidates behind ``enroll`` and ``query``, kept so a scoring run
    #: can start from an empty database. Not part of the record.
    _store: Optional[Candidate] = None
    _ask: Optional[Candidate] = None
    _arrange: Optional[Callable[..., Sequence[Callable[[], Any]]]] = None
    #: Their own zero-argument factory whose return the store and the query
    #: both take first, when that is the shape their database has.
    _factory: Optional[Candidate] = None
    #: Their own functions applied to what the query returned, in order.
    _readers: Tuple[Candidate, ...] = ()
    #: Whether their query is handed the table their store filled on its own
    #: object, plus an id-to-name table over the songs enrolled.
    _state: bool = False
    #: Which attribute of that object the table turned out to be. Recorded
    #: for the run page; a scoring run reads the fresh object again rather
    #: than trusting this, because it is describing what happened during the
    #: search and the scored run is a different object.
    _state_attribute: Optional[str] = None
    #: Lazy construction runs after resolve's resource redirects have closed.
    _resource_files: Dict[str, Path] = field(default_factory=dict)
    #: How to read this repository again. `fresh` gives each run of a binding
    #: its own module objects, which means reading the repository again rather
    #: than reusing the namespace the search filled, and reading it needs the
    #: same three arguments `resolve` was given.
    _repository: Optional[Path] = None
    _hints: Tuple[str, ...] = ()
    _declared_root: Optional[str] = None
    #: The role this bound to, by name, and the benchmark's own inputs taken
    #: before any of their code ran. Both are what `_renewed` needs to put the
    #: binding back on a new reading: the name roots the scope a fit stage was
    #: declared under, and the bundle is where a resource comes from.
    _role: Optional[Role] = field(default=None, compare=False, repr=False)
    _bundle: Optional[Bundle] = field(default=None, compare=False, repr=False)
    #: The binding as the search found it, kept so every run of it is made
    #: from the same original rather than from the last run.
    #:
    #: `fresh` returns a submission whose chain is this reading's, so making
    #: another one from THAT would map a mapped candidate: its module is the
    #: previous reading's module, and a name discovery built from a counter
    #: is not the name the next reading builds. Keeping the original means
    #: the tenth run maps the same candidates against the same discovery as
    #: the first.
    _source: Optional[Binding] = field(default=None, compare=False, repr=False)
    #: Where each module the search read came from, and the discovery section
    #: of the record, both taken at the handoff. They are what `discovery` was
    #: still being held for: a reading of its own needs the file each module
    #: name belongs to (`module_origins`), and `to_dict` needs the record.
    #: Keeping the discovery instead would keep its module objects, and a
    #: model one of their files parked in a global lives in one of those.
    _origin_files: Optional[Mapping[str, str]] = field(
        default=None, compare=False, repr=False,
    )
    #: The record alone, which is also what `close` keeps for a refusal. Every
    #: run of one binding shares this dictionary, so `to_dict` copies out of it
    #: rather than handing it over.
    _discovered: Optional[Dict[str, object]] = field(
        default=None, compare=False, repr=False,
    )
    #: The reading this run of the binding owns, for every shape of week: a
    #: chain-only week has no trial and still has a namespace and, if the week
    #: declares one, a loaded model to release.
    _owned: Optional[Project] = field(default=None, compare=False, repr=False)
    #: The pairing behind ``enroll`` and ``query``, for a week whose task ends
    #: in a database. Held because closing the reading is not the whole of
    #: closing the run: the trial also holds their database, the store and
    #: query it took off that reading, and the table it read back off their
    #: object, and the week's adapter goes on holding the trial through those
    #: two bound calls.
    _trial: Optional["_Trial"] = field(default=None, compare=False, repr=False)
    #: The week's model hook, carried so each run can build its own.
    _construct: Optional[Callable[..., Any]] = field(
        default=None, compare=False, repr=False,
    )
    #: The set `resolve` keys its memo entry against. A run of this binding can
    #: import a file of theirs that nothing had imported when the key was
    #: written, and the key is only safe if it knows about that file.
    _observed: Optional[Set[Path]] = field(default=None, compare=False, repr=False)

    @property
    def ready(self) -> bool:
        """Whether there is something to score.

        A week whose task ends in a database needs a bound store and query. A
        week that is a straight pipeline, like Week 2's clustering, is ready
        as soon as its chain is: photos in, one label per photo out, nothing
        kept between calls.
        """

        if self.attempt is not None or self.enroll is not None:
            return self.enroll is not None and self.query is not None
        if self.branches:
            # A role made of branches leaves `chain` empty on purpose; the
            # branches are the binding.
            return self.verdict.status == SCORED
        return bool(self.chain) and self.verdict.status == SCORED

    def fresh(self) -> "Submission":
        """Another run of this binding, over a repository read again for it.

        The whole binding moves together: the chain, the store, the query and
        their readers all come off one new reading, so a value the chain
        computes is handed to a store that shares its module objects. Two
        submissions made fresh separately share nothing, which is what lets a
        caller alternate between them.

        Reading happens here. Their database does not: a constructor or a
        factory of theirs runs on first use, inside the caller's working
        directory, rather than while resolution is returning from its own
        scratch directory.
        """

        if self._owned is not None and self._owned.closed:
            # Reopening would quietly build a second namespace under a
            # submission whose handles the caller has already given up.
            raise Closed("this submission was closed; resolve again for a new run")
        if self._repository is None or self._bundle is None:
            return self
        let_go: Dict[str, Any] = {}
        if self._source is None:
            # The first run of a binding the search has just found. The search
            # binds against modules it imported itself rather than through a
            # `Project`, so no reading owns what it left on the steps or the
            # discovery it read them off, and both would be held for as long
            # as this submission is. What is kept to replay from is a
            # description; see `_replayed`. Described while the originals are
            # still here, so the record and the file each module name belongs
            # to are read off them once and the reading is then let go.
            stand_in: Dict[int, _Receiver] = {}
            source = _replayable(self._binding(), stand_in)
            store = _replayed(self._store, stand_in)
            ask = _replayed(self._ask, stand_in)
            factory = _replayed(self._factory, stand_in)
            readers = tuple(_replayed(one, stand_in) for one in self._readers)
            assert self.discovery is not None
            let_go = {
                "discovery": None,
                "_origin_files": module_origins(self.discovery),
                "_discovered": self.discovery.to_dict(),
            }
            files = let_go["_origin_files"]
        else:
            source = self._source
            store, ask = self._store, self._ask
            factory, readers = self._factory, self._readers
            files = self._origin_files
        # Off the map rather than off the discovery, so this reading does not
        # become the next thing holding the one the search made.
        project = self._reading(files)
        # One reconstruction for this run of the binding. Another `fresh`
        # gets its own, which is what keeps two runs apart.
        #
        # Under the same course-file mapping the search ran under. A fit
        # stage runs one of their functions here, and a function that opens
        # the week's artifact needs the same answer it got during the search.
        try:
            with _Redirects(self._resource_files):
                renewed = _renewed(
                    source, project, self._bundle.again(), self._role,
                    construct=self._construct,
                )
        except BaseException as primary:
            # This run owns the reading it just made, including whatever its
            # model hook had already built, so a failure part way through
            # releases it rather than leaving it to nobody. What went wrong
            # first is what the caller came for, so a loader that also
            # complains on the way out rides along on it rather than
            # replacing it, and rather than being dropped: `Submission.close`
            # reads `cogbench_cleanup`, and a loader that could not let go of
            # its files is a real fact about the run either way.
            try:
                project.close()
            except CleanupFailed as cleanup:
                _also(primary, cleanup)
            raise
        put = replace(
            self,
            chain=renewed.steps,
            branches=dict(renewed.branches),
            fits=renewed.fits,
            _source=source,
            _store=store,
            _ask=ask,
            _factory=factory,
            _readers=readers,
            _owned=project,
            _trial=None,
            **let_go,
        )
        if store is None or ask is None:
            # A week with no database: the chain is the whole binding, and it
            # is now on a reading of its own. It owns that reading too, which
            # is why this is not the trial's to hold.
            return put
        trial = _Trial(
            _Shape(factory, readers, self._state, self._state_attribute),
            store,
            ask,
            self._arrange,
            self.attempt.arrangement if self.attempt else 0,
            project=project,
            renew=lambda _project: renewed.steps,
            resource_files=self._resource_files,
        )
        return replace(put, enroll=trial.enroll, query=trial.query(), _trial=trial)

    def close(self) -> None:
        """Release this run's reading, and whatever its models hold.

        What the run recorded stays readable: the verdict, the step labels,
        the attempt, `to_dict`. What stops is running their code. `enroll`,
        `query` and any bound step raise `Closed` afterwards, because the
        namespace they would answer from is gone.

        A week whose task ends in a database is closed through its trial
        rather than through the reading directly. The reading is the trial's,
        and the trial is holding more than the reading: their database, and
        the calls it took off that reading to fill it.

        A refusal has no reading of its own and still has the search's, as
        the evidence behind it; closing one lets that go. See
        `_let_the_search_go`.

        Idempotent. Raises `CleanupFailed` only when the week's own model
        hook raised on its way out, which is worth hearing about and does not
        change the fact that the reading is closed.
        """

        try:
            if self._trial is not None:
                self._trial.close()
            elif self._owned is not None:
                self._owned.close()
        finally:
            # After the reading, and whether or not it complained: a run that
            # would not release is still a run the caller has finished with.
            self._let_the_search_go()

    def __enter__(self) -> "Submission":
        return self

    def __exit__(self, *exc: Any) -> None:
        """Close, without letting the loader's parting complaint take over.

        A body that raised is what the caller came for. The reading closes
        either way, and the complaint rides on that exception as
        ``cogbench_cleanup`` rather than replacing it. An explicit `close`
        with nothing already in flight still raises `CleanupFailed`, which is
        the only way anyone would hear about it.
        """

        try:
            self.close()
        except CleanupFailed as cleanup:
            if exc and exc[0] is not None:
                _also(exc[1], cleanup)
                return
            raise

    def _let_the_search_go(self) -> None:
        """Keep the search's reading as a record and let the reading go.

        A submission that bound nothing keeps `discovery` as the evidence
        behind the refusal, and the modules in it are the search's: a model
        one of their files parked in a global lives in one of those, so
        closing the refusal released nothing. `fresh` performs this same
        handoff for a run that binds.

        The chain goes the same way. A refusal that ran their pipeline to the
        end and found no database names the chain it found, and a step holds
        their own function, so the modules the discovery just let go of stay
        reachable through it. `_replayed` keeps what the record renders (the
        label, the folder, the pooled name) and takes their code off; a call
        afterwards says the reading closed.

        Only the record. `_origin_files` is what a reading of its own needs,
        and a refusal has no binding to put on one.

        Idempotent, and `to_dict` answers from the record afterwards.
        """

        found = self.discovery
        if found is None:
            return
        if self._discovered is None:
            self._discovered = found.to_dict()
        self.discovery = None
        stand_in: Dict[int, _Receiver] = {}
        self.chain = tuple(
            replace(_replayed(step, stand_in), _runtime_call=_closed_reading)
            for step in self.chain
        )

    def _binding(self) -> Binding:
        """This submission's binding, in the shape `_renewed` reads.

        A submission keeps the same pieces a `Binding` does and keeps them
        flat, because that is what the record renders from. This puts them
        back together for the one caller that needs the whole thing at once.
        """

        return Binding(
            self._role.name if self._role is not None else "",
            tuple(self.chain),
            fits=self.fits,
            branches=dict(self.branches),
            _stage_names=tuple("" for _ in self.chain),
            _received=tuple("" for _ in self.chain),
            _returned=tuple("" for _ in self.chain),
        )

    def _reading(self, origin: Optional[Mapping[str, str]]) -> Project:
        """A reading of their repository that belongs to one run of this.

        ``origin`` is the file each module name of the search's belongs to,
        which is the whole of what a reading needs from the reading before it.
        """

        assert self._repository is not None and origin is not None
        return Project(
            self._repository,
            origin,
            hints=self._hints,
            declared_root=self._declared_root,
            resource_files=self._resource_files,
            observed=self._observed,
        )

    def report(self) -> SubmissionReport:
        """This submission with the live callables left behind.

        The one value that may cross a process boundary. See
        ``SubmissionReport`` for why there is a boundary at all.
        """

        return SubmissionReport(
            ready=self.ready,
            verdict=self.verdict,
            chain=tuple(step.label for step in self.chain),
            attempt=self.attempt,
            record=self.to_dict(),
        )

    def to_dict(self) -> Dict[str, object]:
        """What the run records, and what every surface renders from."""

        record: Dict[str, object] = {
            "verdict": self.verdict.to_dict(),
            "attemptsTried": self.attempts_tried,
            "chain": [step.label for step in self.chain],
            "recalled": self.recalled,
        }
        if self.attempt is not None:
            record["enroll"] = self.attempt.enroll
            record["query"] = self.attempt.query
            record["arrangement"] = self.attempt.arrangement
        # Rendered from the reading itself while the run still holds it, and
        # from what the handoff read off it once it does not. Copied either
        # way: the snapshot is one dictionary shared by every run of this
        # binding, and a caller that emptied `report().record["discovery"]`
        # emptied what its siblings report.
        if self.discovery is not None:
            record["discovery"] = self.discovery.to_dict()
        elif self._discovered is not None:
            record["discovery"] = taken_as_data(self._discovered)
        record["weightsUsed"] = list(self.weights_used)
        # `null` where consumption was not established, which is a different
        # answer from the empty list a run with no weights carries.
        record["weightsCaptured"] = (
            None if self.weights_captured is None
            else [dict(item) for item in self.weights_captured]
        )
        if self.cleanup:
            record["cleanup"] = list(self.cleanup)
        supplied = _supplied_by(self)
        if supplied:
            # Everything the benchmark handed their code that did not come
            # out of their code: a score computed with a resource we provided
            # is a different claim from one computed without it.
            record["supplied"] = supplied
        if self.branches:
            record["branches"] = {
                name: [step.label for step in steps]
                for name, steps in sorted(self.branches.items())
            }
        if self.fits:
            record["fits"] = [[name, step.label] for name, step in self.fits]
        if self.missing:
            # Sorted so two runs of the same repository write the same
            # bytes.
            record["missing"] = {
                name: {"stage": refusal.stage, "detail": refusal.detail}
                for name, refusal in sorted(self.missing.items())
            }
        if self._factory is not None:
            record["factory"] = self._factory.label
        if self._readers:
            record["readers"] = [reader.label for reader in self._readers]
        # A dict iteration order that moves between processes is an input to
        # their code nobody chose. Recorded rather than asserted, because this
        # interpreter's randomisation cannot be changed after it started;
        # `cogbench.isolate` pins it for the child, where discovery runs.
        record["hashRandomization"] = bool(sys.flags.hash_randomization)
        # And the seed itself, because two pinned runs under different seeds
        # are two different programs. Null when the interpreter chose its own,
        # which it does not expose (see `isolate.hash_seed_in_effect`), so a
        # reader can tell "pinned at 0" from "we do not know".
        record["hashSeed"] = _hash_seed_in_effect()
        return record


def _leading(call: Callable[..., Any], held: Any) -> Callable[..., Any]:
    """Their function with their own database object as its first argument."""

    return lambda *args, **keywords: call(held, *args, **keywords)


def _onto(
    tentative: Binding,
    bundle: Bundle,
    role: Role,
    stopped: Callable[[Unmapped], None],
    asked: Dict[str, bool],
    construct: Optional[Callable[..., Any]] = None,
) -> Callable[[Project], Any]:
    """How a trial puts this binding onto its own reading.

    ``stopped`` is told why a reconstruction could not happen, so the caller
    can report that rather than let it read as a pairing their code failed.
    """

    def renew(project: Project) -> Any:
        try:
            # One reconstruction per trial: two steps of one trial share what
            # the benchmark shares, and two trials share nothing.
            put = _renewed(tentative, project, bundle.again(), role, construct)
        except Unmapped as error:
            stopped(error)
            raise
        asked["ever"] = True
        return dict(put.branches) if put.branches else put.steps

    return renew


class _Held:
    """The search's own model block, closed once and never twice.

    Closed before the run is handed back, so a complaint reaches the record
    the caller gets. Also on the exit stack, for the ways out that have no
    handoff.
    """

    __slots__ = ("_holding", "_watcher", "_cleanup", "_closed")

    def __init__(self, holding: Any, watcher: Any, cleanup: List[str]) -> None:
        self._holding = holding
        self._watcher = watcher
        self._cleanup = cleanup
        self._closed = False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._holding.__exit__(None, None, None)
        except BaseException as error:  # noqa: BLE001 - their loader
            _complained(
                "their model loader raised while closing: {}: {}".format(
                    type(error).__name__, str(error)[:160]
                ),
                self._watcher,
                self._cleanup,
            )


def _complained(text: str, watcher: Any, cleanup: List[str]) -> None:
    """Record that something would not release, and echo it to the watcher.

    The record is the channel: the default `Progress` is `Silent` and its
    `note` does nothing, so a hosted run has no terminal to hear this.
    """

    if text not in cleanup:
        cleanup.append(text)
    watcher.note(text)


def _released(owner: Any, watcher: Any, cleanup: List[str]) -> None:
    """Close a reading from a `finally`, keeping any failure already in flight.

    A loader that will not let go is worth reporting and is not the run's
    result, so it is recorded rather than raised over what brought us here.
    """

    try:
        owner.close()
    except CleanupFailed as error:
        _complained(str(error), watcher, cleanup)


def _published(
    submission: "Submission", hook: Optional[Callable[["Submission"], bool]]
) -> "Submission":
    """Decide what this run may claim about the weights it scored with.

    A true answer is honoured only where capture produced receipts, so a
    mistaken hook cannot mint provenance for a run that retained nothing.
    """

    if not submission.weights_used:
        return submission
    established = False
    if submission.weights_captured and hook is not None:
        try:
            established = bool(hook(submission))
        except Exception:  # noqa: BLE001 - a week's hook must not fail a score
            established = False
    return submission if established else replace(submission, weights_captured=None)


def _handed_over(
    submission: "Submission",
    found: Discovery,
    weights_used: Sequence[str],
    cleanup: List[str],
) -> "Submission":
    """A bound submission on a reading of its own, or why it could not be.

    The search proved this binding on a reading it has already thrown away.
    Handing it over means putting it on one more, and the one thing that can
    stop that is an input the benchmark cannot give their code again. Saying
    so names that input, because the alternative is a scored run quietly
    reusing whatever the last probe left in it.
    """

    try:
        return replace(submission.fresh(), cleanup=tuple(cleanup))
    except Unmapped as error:
        return Submission(
            not_read(found.root.path.name, str(error)),
            discovery=found,
            # The declared names survive a failed handoff; the receipts do
            # not, because nothing attested that this binding consumed them
            # and an empty tuple would say there were none.
            weights_used=tuple(weights_used),
            weights_captured=None if weights_used else (),
            cleanup=tuple(cleanup),
        )


def _accepts_capture(hook: Callable[..., Any]) -> bool:
    """Whether this week's `prepare` wants the retention callback.

    A week that declares no weights never asks for it and is called exactly
    as before, so offering the argument does not disturb the other three.

    Opting in means naming the parameter. A `**kwargs` hook does not count:
    it would swallow the callback without loading through it, and the run
    would then describe bytes that nothing retained.
    """

    try:
        parameters = inspect.signature(hook).parameters
    except (TypeError, ValueError):
        return False
    wanted = parameters.get("capture")
    return wanted is not None and wanted.kind in (
        inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY,
    )


def _visible(values: Dict[Tuple[str, ...], Dict[str, Any]], scope: Tuple[str, ...]):
    """The side inputs a step in ``scope`` can see, outermost first.

    A branch's own fits shadow the role's, which is how the search itself
    carries them: `_resolve_branches` fills one pool for the role and hands
    each branch a copy that its own fits then add to.
    """

    seen: Dict[str, Any] = {}
    for depth in range(1, len(scope) + 1):
        seen.update(values.get(scope[:depth], {}))
    return seen


def _handing(
    handed: Handed,
    values: Dict[Tuple[str, ...], Dict[str, Any]],
    scope: Tuple[str, ...],
    models: Mapping[str, Any] = {},
) -> Callable[[Candidate], Candidate]:
    """The last word on one step's call: what this reading hands it.

    A step records what it was handed as a plan of slots, and the values
    behind the named slots live on the step itself. Two kinds live there and
    they are renewed in opposite ways. A benchmark resource is reconstructed
    from ``handed``, because it is ours and their code may have written to it,
    and every step of one trial reconstructs from that same one so two steps
    taking one resource take one object. A fit stage's value is one of THEIR
    objects, so it is not copied at all: `_renewed` has already run that fit
    again on this reading and what goes on the step is the value that run
    produced.

    Returned as a callable rather than applied here, because `Project.rebind`
    has to seal the call around the finished candidate. A step amended after
    sealing keeps the record and loses the call.
    """

    def given(step: Candidate, name: str) -> Any:
        """One side input, from whichever of the three places owns it.

        In the order the search itself resolves them. A fit stage's table or
        an earlier branch's output wins, because those are computed last and
        the search lets them override. Then a model, which their own loader
        built in this reading. Then the benchmark's data.
        """

        known = _visible(values, scope)
        if name in known:
            # Something of theirs, recomputed on this reading by `_renewed`
            # and never copied.
            return known[name]
        if name in models:
            # Also theirs, built by their loader in this reading. Shared
            # within it the way their code would share it, and never handed
            # to another reading.
            return models[name]
        return handed.extra(name)

    def finish(step: Candidate) -> Candidate:
        # Positional and keyword slots are the same four slots and are filled
        # from the same line in `pipeline._slot_value`, so both are read here.
        # A step whose only extra arrives by keyword was otherwise handed the
        # search's value while every positional one was renewed.
        slots = tuple(step.plan) + tuple(slot for _name, slot in step.keyword_plan)
        wanted = [slot[len("extra:"):] for slot in slots if slot.startswith("extra:")]
        wanted.extend(step.keywords)
        supplied = dict(step.supplied)
        for name in wanted:
            supplied[name] = given(step, name)
        if "identity" in slots:
            supplied["identity"] = tuple(handed.identities())
        put = replace(step, supplied=supplied)
        if "pooled" in step.supplied:
            # This step is not one of their functions: it is the object the
            # week put in the pool, offered because a stage declared it and it
            # turned out to be callable. That object is renewed like any other
            # declared input, and so is everything else this step takes, which
            # returning here early used to skip.
            call = given(step, step.supplied["pooled"])
            if not callable(call):
                raise Unmapped("kind_changed", step.label, "no longer callable")
            return replace(put, call=call)
        return put

    return finish


def _built_by(
    construct: Optional[Callable[..., Any]], owner: Any, handed: Handed
) -> Mapping[str, Any]:
    """Their models for one reading, or nothing when the week loads none.

    The hook is given this owner's own data pool, so a model built out of the
    benchmark's caption table is built out of the same table its stages are
    handed. A name the hook claims that the data already holds is refused:
    either could own it, and choosing would be guessing which half of the
    week's own declaration to believe.
    """

    if construct is None:
        return {}
    try:
        models = owner.models(construct, handed.pool())
    except Unmapped:
        # Already categorized, by `_as_models`: the hook yielded something
        # that is not a mapping of names to models. Wrapping it again would
        # report a broken contract as a loader that raised.
        raise
    except BaseException as error:  # noqa: BLE001 - the week's own loader
        raise Unmapped(
            "model_failed", "this week's models",
            "{}: {}".format(type(error).__name__, str(error)[:160]),
        ) from None
    clash = collides(models, handed.names())
    if clash:
        raise Unmapped(
            "hook_contract", "this week's models",
            "{} named by both `construct` and the benchmark's own inputs".format(
                ", ".join(clash)
            ),
        )
    return models


def _taken_by(binding: Binding) -> FrozenSet[str]:
    """Every branch some step of this binding depends on, by name.

    Two ways a step depends on a branch, and only one of them is written in
    its call. The visible one is a side input: a stage declared the branch's
    name and `_resolve_branches` put what that branch produced into the pool
    under it.

    The other leaves no slot at all. A method carried out of an earlier
    branch is a method OF the object that branch's constructor stage built,
    and it finds that object through the construction handle it shares with
    the step that built it (`pipeline._rebound`). On a fresh reading that
    handle starts empty and is filled by running the constructor, so a branch
    that owns a carried method has to run even though nothing asks for its
    value. Without this the carried method raised, because its own branch was
    never run and its handle was never filled.
    """

    wanted = set()
    chains = list(binding.branches.values()) + [binding.steps, binding._reach]
    for steps in chains:
        for step in steps:
            slots = tuple(step.plan) + tuple(slot for _name, slot in step.keyword_plan)
            wanted.update(
                slot[len("extra:"):] for slot in slots if slot.startswith("extra:")
            )
            wanted.update(step.keywords)
            if "pooled" in step.supplied:
                wanted.add(step.supplied["pooled"])
            if step.branch:
                wanted.add(step.branch)
    return frozenset(wanted)


def _declares_a_folder(role: Any) -> bool:
    """Whether any stage of this role offers its files as a folder.

    Read off the role rather than off a binding, because the memo key is
    written before there is a binding to look at.
    """

    if any(getattr(stage, "folder", False) for stage in getattr(role, "stages", ())):
        return True
    return any(
        _declares_a_folder(branch) for branch in getattr(role, "branches", ()) or ()
    )


def _reads_a_folder(binding: Binding) -> bool:
    """Whether any step of this binding is handed a folder of our files.

    Every chain the binding holds, the way `_taken_by` walks them, because the
    step that reads the folder may be in a branch or be a method reached off a
    constructor rather than in the chain itself.
    """

    chains = list(binding.branches.values()) + [binding.steps, binding._reach]
    chains.append(tuple(step for _name, step in binding.fits))
    return any(
        "folder" in step.supplied for steps in chains for step in steps
    )


def _renewed(
    binding: Binding,
    project: Project,
    handed: Handed,
    role: Optional[Role] = None,
    construct: Optional[Callable[..., Any]] = None,
) -> Binding:
    """One whole binding, taken off one fresh reading of their repository.

    Everything the binding is made of moves together onto the new reading: the
    chain, every branch, the methods a constructor stage reached, and the side
    inputs their own code computes. They have to move together, because a
    method reached off a constructor answers from the object that constructor
    built, and a step that takes a fit's table has to take the table this
    reading's code produced.

    Nothing of theirs is carried over, and that covers two kinds of value.

    A fit stage's table came out of the modules the search filled, so the
    fit's own function is called again here, on the fixture its stage
    declared. Values are scoped by the role path the fit was declared under
    (`_FitProvenance.role_path`), because two branches of one role may both
    declare a stage called ``fit`` and those are two different values.

    A branch's output is the same kind of thing. `_resolve_branches` puts what
    each branch produced into the pool under that branch's own name, and a
    later branch may declare it: Bagel's week 3 `CaptionImageQuery(EMBEDDINGS,
    ids)` takes the image branch's projected matrix. So a branch whose output
    some step asks for has its renewed chain run again here, on its own
    reconstructed fixture, and the value that produces is what the later step
    is handed. A branch nobody asks for is not run, because running it would
    be calling their code for a value nothing reads.

    All of it in the order the binding records, which is the order the search
    bound it in, so a fit that reads an earlier fit and a branch that reads an
    earlier branch both still can.
    """

    values: Dict[Tuple[str, ...], Dict[str, Any]] = {}
    here = (binding.role,)
    # A binding that reads a folder needs this run's own directory to exist
    # before anything runs in it, their model loader included: it may read a
    # relative path of its own, and a fit stage runs before the chain does.
    # Keyed on what the binding records rather than on which call happens to
    # come first.
    if _reads_a_folder(binding):
        project.home()
    # Their models, built in this reading before anything else runs, because
    # a fit stage may take one. The hook reads this owner's own data pool, so
    # what it sees is aliased exactly as the benchmark shared it and is never
    # the caller's original.
    models = _built_by(construct, project, handed)
    wanted = _taken_by(binding)
    by_name = {branch.name: branch for branch in getattr(role, "branches", ()) or ()}
    renewed_fits: List[Tuple[str, Candidate]] = []
    fits_at: Dict[Tuple[str, ...], List[Tuple[str, Candidate]]] = {}
    for name, fit in binding.fits:
        where = fit._fit_provenance
        if where is None:
            raise Unmapped(
                "no_source", fit.label,
                "the binding does not say which stage declared it",
            )
        fits_at.setdefault(tuple(where.role_path), []).append((name, fit))

    def run_fits(scope: Tuple[str, ...]) -> None:
        for name, fit in fits_at.get(scope, ()):
            where = fit._fit_provenance
            step = project.rebind(fit, _handing(handed, values, scope, models))
            case = handed.fit_case(scope, where.stage_index)
            forms = case if isinstance(case, Fixtures) else (case,)
            try:
                produced = step.bound(*tuple(forms[fit.form or 0]))
            except BaseException as error:  # noqa: BLE001 - their function
                raise Unmapped(
                    "fit_failed", fit.label,
                    "{} on this reading".format(type(error).__name__),
                ) from None
            values.setdefault(scope, {})[name] = produced
            renewed_fits.append((name, step))

    def renew(steps: Sequence[Candidate], scope: Tuple[str, ...]):
        return tuple(
            project.rebind(step, _handing(handed, values, scope, models)) for step in steps
        )

    run_fits(here)
    branches: Dict[str, Tuple[Candidate, ...]] = {}
    # In the order the binding records, which `_resolve_branches` fills as
    # each branch binds, so a branch that reads an earlier branch's output
    # finds it already made.
    for name, chain in binding.branches.items():
        scope = here + (name,)
        run_fits(scope)
        branches[name] = renew(chain, scope)
        if name in wanted and name in by_name:
            values.setdefault(here, {})[name] = _produced_by(
                by_name[name], branches[name], handed, values, here, branches
            )

    # Which branch this binding's own chain belongs to, by identity: the
    # tentative branch is the one the verifier put into the trial dict.
    mine = next(
        (name for name, chain in binding.branches.items() if chain is binding.steps),
        None,
    )
    scope = here if mine is None else here + (mine,)
    for left in fits_at:
        # A fit declared under a branch that did not bind, or under a role
        # path no chain here belongs to, still has to run: a step may take it.
        if left != here and left not in {here + (name,) for name in binding.branches}:
            run_fits(left)
    return replace(
        binding,
        steps=branches[mine] if mine is not None else renew(binding.steps, scope),
        fits=tuple(renewed_fits),
        branches=branches,
        _reach=tuple(
            project.rebind(
                step,
                _handing(
                    handed, values,
                    here + (step.branch,) if step.branch else scope, models,
                ),
            )
            for step in binding._reach
        ),
    )


def _produced_by(
    branch: Role,
    chain: Sequence[Candidate],
    handed: Handed,
    values: Dict[Tuple[str, ...], Dict[str, Any]],
    here: Tuple[str, ...],
    bound: Dict[str, Tuple[Candidate, ...]],
) -> Any:
    """What one branch's renewed chain produces, run on this reading.

    The search kept the value the branch produced and put it in the pool; that
    value belongs to the modules the search filled, so it is made again here
    instead of being carried. The branch's own input is made the way the
    search made it, through `pipeline._fixture_for`: a plain fixture as it is,
    a callable one asked for a fixture with this reading's pool and this
    reading's chains, because a week whose branch input is its own text chain
    applied to a query string cannot be given the search's answer.
    """

    from .pipeline import _Broken, _UNREADY, _fixture_for

    try:
        # What the week's fixture hook can read: the benchmark's own
        # resources and their own products together, the way the search's
        # pool held both. Made only as it is asked for, because the hook may
        # read any name and a resource nobody reads must not decide the run.
        # `_fixture_for` copies this rather than calling `dict()` on it, so
        # taking it never reads it.
        pool = handed.pool(_visible(values, here))
        case = _fixture_for(branch, handed.case(), pool, dict(bound))
    except Unmapped:
        raise
    except BaseException as error:  # noqa: BLE001 - a week's own fixture hook
        raise Unmapped(
            "branch_input", branch.name,
            "its input could not be made again: {}".format(type(error).__name__),
        ) from None
    if isinstance(case, _Broken):
        # `_fixture_for` reports a fixture that raised by wrapping the error,
        # so this has to be read before the value is used. Unwrapped it is a
        # tuple of one `_Broken`, their chain is called with it, and a
        # `TypeError` from their own first line is then reported as their
        # branch failing. Two different failures wearing one sentence again.
        if isinstance(case.error, Unmapped):
            # Ours, already named: a resource the week's fixture read and
            # this reading could not make again. It keeps its own reason.
            raise case.error
        raise Unmapped(
            "branch_input", branch.name,
            "its input could not be made again: {}".format(type(case.error).__name__),
        ) from None
    if case is _UNREADY or not chain:
        raise Unmapped(
            "branch_input", branch.name,
            "its input is not available on this reading",
        )
    forms = case if isinstance(case, Fixtures) else (case,)
    try:
        value = chain[0].bound(*tuple(forms[chain[0].form or 0]))
        for step in chain[1:]:
            value = step.bound(value)
    except BaseException as error:  # noqa: BLE001 - their own chain
        raise Unmapped(
            "branch_failed", branch.name,
            "{} on this reading".format(type(error).__name__),
        ) from None
    return value


def _taken_from_the_pool(*_args: Any) -> Any:
    """Stands where a pool object was, on a binding kept only to be replayed."""

    raise RuntimeError(
        "this step is one of the benchmark's own objects; a run of this "
        "binding takes it from the pool again rather than from the search"
    )


def _found_again_by_name(*_args: Any) -> Any:
    """Stands where their own code was, on a binding kept only to be replayed."""

    raise RuntimeError(
        "this step is a description of a call; a run of this binding takes "
        "their code off its own reading rather than from the search"
    )


def _closed_reading(*_args: Any) -> Any:
    """Stands where their code was, on a refusal the caller has closed."""

    raise Closed("this reading was closed")


def _replayed(
    step: Optional[Candidate], stand_in: Dict[int, _Receiver]
) -> Optional[Candidate]:
    """One step of the search's binding, as a description of the call to make.

    `Project.rebind` finds the same code again by name, so a description is
    the step with the live things taken off it. Four of them, and none is the
    submission's to keep: their own function or class, which holds the module
    the search read and so whatever one of their files parked in a global; the
    named slots, which hold the resources the call was handed and the week's
    models among them; the construction handle a method shares with the step
    that built its object; and ``rebuild``, a closure over one of their
    objects that nothing reads any more.

    `_Described` is what replaces the first: the module and qualified name
    `rebind` looks the code up by, which is all it ever read off the objects
    themselves. ``_handing`` fills every named slot again from the reading the
    run is on, and ``stand_in`` gives each handle an empty one, so which steps
    share a handle survives and what it was filled with does not.

    What stays is what the record renders (`_given_to`): the folder name, the
    pooled name and the sentence written under it, and a module-value fit's
    note.
    """

    if step is None:
        return None
    recorded = {name: step.supplied[name]
                for name in ("folder", "pooled", "value") if name in step.supplied}
    pooled = recorded.get("pooled")
    told = step.supplied.get(pooled)
    if isinstance(told, str):
        recorded[pooled] = told
    receiver = step.receiver
    if receiver is not None:
        receiver = stand_in.setdefault(id(receiver), _Receiver())
    return replace(
        step,
        # A pooled step is not their code at all: `rebind` takes the object out
        # of this reading's pool by the name above and never reads this.
        call=_taken_from_the_pool if pooled is not None else _found_again_by_name,
        owner=None,
        supplied=recorded,
        rebuild=None,
        receiver=receiver,
        _described=None if pooled is not None else _Described.of(step),
    )


def _replayable(binding: Binding, stand_in: Dict[int, _Receiver]) -> Binding:
    """The whole binding as a description, sharing one set of stand-in handles.

    One map across every chain, because a method carried out of one branch
    shares its construction handle with the step in another branch that built
    the object.
    """

    def described(step: Candidate) -> Candidate:
        return _replayed(step, stand_in)

    return replace(
        binding,
        steps=tuple(described(step) for step in binding.steps),
        fits=tuple((name, described(step)) for name, step in binding.fits),
        branches={
            name: tuple(described(step) for step in chain)
            for name, chain in binding.branches.items()
        },
    )


def _supplied_by(submission: "Submission") -> List[Dict[str, object]]:
    """Everything a step was given beyond the value the chain carried.

    Read off the bindings rather than accumulated as the search runs, so it
    cannot drift from what was actually called: the plan on each step IS the
    argument list.
    """

    found: List[Dict[str, object]] = []
    steps = list(submission.chain)
    for chain in submission.branches.values():
        steps.extend(chain)
    for step in steps:
        found.extend(_given_to(step))
    for name, step in submission.fits:
        # A fit stage is a call like any other and takes side inputs like any
        # other, so its own inputs belong here beside the "computed once"
        # line.
        found.extend(_given_to(step))
        found.append({"step": step.label, "supplied": "computed once as {}".format(name)})
    if submission._state and submission.attempt is not None:
        # Their query was handed two things it did not compute: the table
        # their own store filled, named so a reader can see which of their
        # attributes was passed, and an id-to-name table, which is the one
        # value here the benchmark invented rather than read off their code.
        where = submission.attempt.query
        if submission._state_attribute:
            found.append({"step": where, "supplied": submission._state_attribute})
        found.append(
            {"step": where, "supplied": "an id-to-name table over the enrolled songs"}
        )
    return found


def _given_to(step: Any) -> List[Dict[str, object]]:
    """Everything one call was handed beyond the value the chain carried."""

    found: List[Dict[str, object]] = []
    for slot in step.plan:
        if slot == "identity":
            found.append({"step": step.label, "supplied": "the name of each item"})
        elif slot.startswith("extra:"):
            found.append({"step": step.label, "supplied": slot[len("extra:"):]})
    for name in step.keywords:
        found.append({"step": step.label, "supplied": name})
    if step.tuning is not None:
        found.append({"step": step.label, "supplied": repr(step.tuning)})
    if "pooled" in step.supplied:
        # This step was not one of their functions at all: it was one of the
        # benchmark's own objects, offered because the stage named it and it
        # turned out to be callable (`pipeline._from_pool`).
        name = step.supplied["pooled"]
        found.append({"step": step.label, "supplied": step.supplied.get(name, name)})
    if "value" in step.supplied:
        found.append({"step": step.label, "supplied": step.supplied["value"]})
    if "folder" in step.supplied:
        found.append(
            {
                "step": step.label,
                "supplied": "their {}/ was pointed at the benchmark's files".format(
                    step.supplied["folder"]
                ),
            }
        )
    return found


def from_spec(repository: Path, spec: Any, **overrides: Any) -> Submission:
    """Resolve one repository against everything a week's spec declares.

    Forwarding a week's declarations one by one at every call site is how one
    of them quietly stops being passed, so there is one place that forwards
    all of them and every surface uses it.
    """

    arguments: Dict[str, Any] = {
        "chain_role": spec.chain_role,
        "fixture": spec.fixture,
        "accepts": spec.accepts,
        "grades": getattr(spec, "grades", None),
        "arrangements": spec.arrangements,
        "hints": getattr(spec, "hints", ()),
        "extras": dict(getattr(spec, "extras", {}) or {}),
        "identities": tuple(getattr(spec, "identities", ()) or ()),
        "resource_files": dict(getattr(spec, "resource_files", {}) or {}),
        "factories": getattr(spec, "factories", None),
        "readers": int(getattr(spec, "readers", 0) or 0),
        "prepare": getattr(spec, "prepare", None),
        # A week that loads its own models declares this instead of returning
        # them from `prepare`. Absent on every data-only and no-weight
        # adapter, which is why it is read rather than required.
        "construct": getattr(spec, "construct", None),
        # Whether the selected binding consumed what `prepare` retained. Which
        # bindings count is the week's question, so the week answers it.
        "weights_consumed": getattr(spec, "weights_consumed", None),
        "expects": getattr(spec, "expects", None),
    }
    arguments.update(overrides)
    return resolve(repository, **arguments)


def _coverage_of(found, benchmark: str = ""):
    """What the run read, and who owns each thing it could not.

    Built here rather than in discovery because ownership depends on which
    graded environment the repository is being read for, and discovery does
    not know the benchmark.
    """

    from .discover import owner_of_skip
    from .verdict import Coverage

    return Coverage(
        read=tuple(module.name for module in found.modules),
        skipped=tuple(
            (entry.name, entry.detail, owner_of_skip(entry, benchmark))
            for entry in found.skipped
        ),
    )


def resolve(
    repository: Path,
    *,
    chain_role: Role,
    fixture: Sequence[Any],
    accepts: Callable[..., Tuple[bool, str]],
    grades: Optional[Callable[[Any], Tuple[Any, str]]] = None,
    arrangements: Optional[
        Callable[[Callable[..., Any], str, Any], Sequence[Callable[[], Any]]]
    ] = None,
    hints: Sequence[str] = (),
    declared_root: Optional[str] = None,
    max_attempts: int = MAX_ATTEMPTS,
    progress: Optional[Progress] = None,
    remember: bool = False,
    benchmark: str = "",
    extras: Optional[Dict[str, Any]] = None,
    identities: Sequence[Any] = (),
    resource_files: Optional[Dict[str, Path]] = None,
    factories: Optional[Callable[[Candidate], bool]] = None,
    readers: int = 0,
    prepare: Optional[Callable[[Path, Sequence[Any]], Mapping[str, Any]]] = None,
    construct: Optional[Callable[..., Any]] = None,
    weights_consumed: Optional[Callable[["Submission"], bool]] = None,
    expects: Optional[str] = None,
    project: Optional[ExecutionPaths] = None,
) -> Submission:
    """Resolve one repository against one week's task.

    ``chain_role`` and ``fixture`` describe the pipeline the week asks for.
    ``accepts`` is the week's own end-to-end test, and it is the only thing
    that can accept a binding. It is also asked the smaller question, with
    ``query_call=None``: can this store take the fixture at all. See
    `DiscoverySpec.accepts` and `_pair`.

    ``grades`` reads a grade off one answer, with no store and no query
    involved. A week that declares ``readers`` must supply it, because a
    reader is chosen by grading what it returned.

    ``arrangements`` is for a week whose task ends in a database: it enumerates
    the ways a store might want one item offered to it, and the search then
    tries pairs of their functions until one stores a thing and names it back.
    A week without one is complete when its chain is, which is Week 2: photos
    in, one label per photo out, nothing kept between calls.

    ``extras`` is the benchmark's own resources, by name, for stages that
    declare them (``Stage.extras``). ``identities`` names the items the
    benchmark is handing over, for stages that declare ``Stage.identity``.
    ``resource_files`` maps a basename to the benchmark's copy of that file,
    so a module that opens the course artifact at a path this machine does
    not have still imports; see ``discover``.

    ``factories`` picks out the zero-argument functions whose return is the
    database their store and query both take first. Without it, no pairing of
    such a team's functions can be tried, because the first argument of both
    is an object nothing in the search produces. The predicate is the week's,
    because what counts as an empty database is the week's question.

    ``readers`` is how many of their own functions may be applied to what the
    query returned before the answer is read. One team's `query_database`
    returns a vote tally, `get_sorted_matches` turns it into a ranking, and
    `get_sorted_songs` turns that into song ids.

    ``remember`` writes the binding into the repository. A hit requires
    unchanged identified inputs and a fully answered current acceptance test.
    Opaque inputs skip the memo; a hit avoids searching alternative bindings,
    not running their code. It is off by default for graded runs.
    ``cogworks check`` turns it on for repeated local checks.
    """

    # Keep deferred imports and candidate calls under the same course-file
    # mapping as module imports. Captured aliases retain only this mapping.
    #
    # `lifetime` owns anything opened for the search itself, so every way out
    # of this function closes it: the returns, the refusals, and an exception.
    with _Redirects(resource_files or {}), contextlib.ExitStack() as lifetime:
        if readers > 0 and grades is None:
            # Said here rather than discovered as an empty reader search, which
            # refuses the repository that needed readers for a reason nobody
            # could see.
            raise ValueError(
                "this week allows {} function(s) after the query and gives no "
                "`grades`; a reader is chosen by grading what it returned".format(readers)
            )

        watcher = progress or Progress()

        #: What would not release cleanly during this resolution, carried onto
        #: whatever it returns. See `Submission.cleanup`.
        cleanup: List[str] = []
        #: What the week's `prepare` hook said about this repository, carried
        #: the same way. See `Submission.prepared`.
        prepared: Dict[str, Any] = {}
        #: The search's own model block, if this week declares one, so it can
        #: be closed before the run is handed back rather than after.
        searching_held: List[Any] = []

        def finish(submission: Submission) -> Submission:
            """The one way out of this function, for every normal return.

            Closes the search's own model block, attaches what could not be
            released, then settles what may be said about the weights. A
            refusal carries weight names too, so it cannot bypass the
            decision. The exit stack stays for the exception, which has no
            return.
            """

            for held in searching_held:
                held.close()
            return _published(
                replace(submission, cleanup=tuple(cleanup), prepared=prepared),
                weights_consumed,
            )

        repository = Path(repository).resolve()
        project = project or ExecutionPaths(repository, repository)

        watcher.phase("Reading your repository")
        found = discover(
            repository,
            hints=hints,
            declared_root=declared_root,
            resource_files=resource_files,
            private_copy=project.execution != project.original,
        )
        weights_used: Tuple[str, ...] = ()
        weights_captured: Optional[Tuple[Dict[str, Any], ...]] = ()
        if prepare is not None:
            # Capture records selected files. Publication also requires the
            # week's confirmation that the returned binding consumed them.
            retained: Dict[Path, storage.RetainedInput] = {}

            def capture(original: Path) -> Path:
                """Copy the selected input and return its retained path.

                The week must load from that path. Retention does not redirect
                code that reads the original or prove which bytes it consumed.
                """

                resolved = Path(original).resolve()
                if resolved not in retained:
                    retained[resolved] = storage.retain_input(
                        project.original, original, source_root=repository
                    )
                return retained[resolved].retained

            offered = {"capture": capture} if _accepts_capture(prepare) else {}
            # What this repository itself supplies to the search: week 3's
            # trained projection, read off the chosen root. Merged under the
            # benchmark's own extras so a week cannot be overridden by a file.
            try:
                # From the same throwaway directory the search probes from:
                # prepare selects benchmark data and files from the chosen
                # root. Student model construction belongs in `construct`;
                # this boundary does not enforce what a defective hook runs.
                with _scratch_cwd():
                    # Taken in one step rather than copied shallowly here and
                    # taken later: a report that refers back to itself would
                    # otherwise come back holding the week's original. The
                    # clock bounds this one call where SIGALRM exists, and
                    # nothing here sandboxes the hook: a benchmark that hangs
                    # or damages this process is the week's own defect, and
                    # only one that raises becomes the refusal below.
                    from_repository = _under_clock(
                        lambda: taken_as_data(
                            prepare(found.root.path, found.namespace, **offered) or {}
                        )
                    )
                declared = [str(p) for p in from_repository.pop("weights_used", ())]
                if offered:
                    # Capture is the declaration. A hook that also returns a
                    # list is giving a second answer to the same question, and
                    # dropping it would hide a disagreement rather than settle
                    # one. Refused rather than reconciled at runtime.
                    if declared:
                        raise storage.RetentionError(
                            "This benchmark both captures its weights and returns a "
                            "`weights_used` list. Capture is the declaration; remove "
                            "the list: {}".format(", ".join(sorted(declared)))
                        )
                    weights_captured = tuple(
                        {"path": item.path, "sha256": item.sha256, "size": item.size}
                        for item in sorted(retained.values(), key=lambda r: r.path)
                    )
                    weights_used = tuple(item["path"] for item in weights_captured)
                elif declared:
                    # A week that names weights without retaining them still
                    # scores locally. The names are canonicalised against the
                    # project the same way a captured one is, by path only,
                    # and the run publishes no receipt for them.
                    weights_used = tuple(sorted(
                        storage.canonical_weight_path(repository, found.root.path / name)
                        for name in declared
                    ))
                    weights_captured = None
            except Exception as error:  # noqa: BLE001 - the week's hook may refuse
                watcher.done()
                return finish(Submission(
                    not_read(
                        found.root.path.name,
                        "{}: {}".format(type(error).__name__, str(error)[:200]),
                    ),
                    discovery=found,
                    weights_used=weights_used,
                    weights_captured=weights_captured,
                ))
            # The hook's own answer, kept whole so the week can read back what
            # it said about THIS repository. A plugin resolving several in turn
            # otherwise has only its own last answer to report from, and a
            # plugin that fills the same nested dictionary each time would
            # rewrite this one's report while preparing the next; the
            # containers here are the run's own. See `taken_as_data`.
            prepared = from_repository
            extras = dict(from_repository, **(extras or {}))
        if found.modules:
            watcher.note(
                "read {} file{} in {}".format(
                    len(found.modules),
                    "" if len(found.modules) == 1 else "s",
                    found.root.path.name or found.root.path,
                )
            )

        if not found.modules:
            watcher.done()
            if found.skipped:
                worst = found.skipped[0]
                return finish(Submission(
                    not_read(
                        worst.name,
                        worst.detail,
                        next_step=_next_step_for(worst.reason, worst.missing, benchmark),
                    ),
                    discovery=found,
                    weights_used=weights_used,
                    weights_captured=weights_captured,
                ))
            return finish(Submission(nothing_here(repository.name), discovery=found))

        # Every file any reading of this repository touched, including the ones
        # a lazy import inside one of their functions reaches while a trial
        # runs. A key written without one of those files is a key that cannot
        # see the change that should invalidate it, so the readings report
        # here and `_memo_key`'s inventory is checked against this afterwards.
        observed: Set[Path] = set()

        def reading() -> Project:
            """One reading of their repository, for one trial. See `_Trial`."""

            return Project(
                repository,
                found,
                hints=hints,
                declared_root=declared_root,
                resource_files=resource_files,
                observed=observed,
            )

        #: Everything the benchmark hands their code, taken now, before any of
        #: their functions has been called and so before any of it can have
        #: been written to. Every later use is reconstructed from this.
        declared, fit_cases = declared_in(chain_role)
        #: The names a stage actually asks for, kept before `declared` widens
        #: to the whole pool, so a resource nobody declares can be skipped
        #: while one that is declared refuses by name.
        declared_by = list(declared)
        if reads_anything(chain_role) or construct is not None:
            # Something of this week's reads the pool by name without saying
            # which name: a callable branch fixture, or the `construct` hook,
            # which is handed the data pool to build its models from. Nothing
            # declares what they read, so every name the caller supplied is
            # snapshotted. An entry that will not copy is still only a refusal
            # if something reads it.
            declared = list(extras or {})
        bundle = Bundle(
            fixture, extras, identities, declared=declared, fits=fit_cases
        )

        # The search is an owner like any other, so it takes one
        # reconstruction and takes everything from it: the case its stages are
        # probed with, the item names, and the resources they declare. Reading
        # its models out of one graph and its inputs out of another made the
        # search the one caller whose model was built from a copy while its
        # steps were handed the caller's originals.
        search_handed = bundle.again()
        # What the search itself probes with, off one reconstruction, so a
        # model built from the caption table and a step handed the caption
        # table are handed one table. Kept beside `extras` rather than
        # replacing it: the memo key identifies the inputs the CALLER passed,
        # and fingerprinting a reconstruction would let an opaque resource
        # look identifiable when it is exactly the thing that is not.
        try:
            searched_fixture = search_handed.case()
            searched_identities = search_handed.identities()
        except Unmapped as error:
            # The week's own case, which every stage is probed with, so there
            # is nothing to search with and nothing to guess. Named here for
            # the same reason a declared resource is: the alternative is this
            # leaving `resolve` as an exception, which no caller of ours is
            # written to read.
            watcher.done()
            return finish(Submission(
                not_read(found.root.path.name, str(error)),
                discovery=found,
                weights_used=weights_used,
                weights_captured=weights_captured,
                cleanup=tuple(cleanup),
            ))
        searching: Dict[str, Any] = {}
        for name in search_handed.names():
            try:
                searching[name] = search_handed.extra(name)
            except Unmapped as error:
                if name in set(declared_by):
                    # A stage asks for this one, so their code is going to be
                    # handed it, and there is nothing honest to probe with.
                    watcher.done()
                    return finish(Submission(
                        not_read(found.root.path.name, str(error)),
                        discovery=found,
                        weights_used=weights_used,
                        weights_captured=weights_captured,
                        cleanup=tuple(cleanup),
                    ))
                # Nobody declared it, so nothing will read it. Left out rather
                # than forced, which is what keeps an unreadable resource a
                # deliberate memo miss instead of a refused repository.

        # Their models for the search's own namespace. The search reads their
        # repository like any trial does, so it builds its own models like any
        # trial does, out of that same pool. They overlay the extras the
        # search carries and never go near the bundle: a model is not data and
        # is never copied.
        if construct is not None:
            try:
                holding = opened(
                    construct, found, resource_files, search_handed.pool()
                )
                models = holding.__enter__()
            except BaseException as error:  # noqa: BLE001 - their loader
                # Two facts, and the refusal is only the first. `opened` shuts
                # a hook down that broke its contract, and records what that
                # shutdown raised on the failure it is already carrying; this
                # is the one return that reads it, so dropping it here is the
                # last place the loader's complaint could go.
                for complaint in getattr(error, "cogbench_cleanup", ()):
                    _complained(str(complaint), watcher, cleanup)
                watcher.done()
                return finish(Submission(
                    not_read(
                        found.root.path.name,
                        "this week's models could not be built: {}: {}".format(
                            type(error).__name__, str(error)[:160]
                        ),
                    ),
                    discovery=found,
                    weights_used=weights_used,
                    weights_captured=weights_captured,
                ))
            held = _Held(holding, watcher, cleanup)
            lifetime.callback(held.close)
            searching_held.append(held)
            clash = collides(models, search_handed.names())
            if clash:
                watcher.done()
                return finish(Submission(
                    not_read(
                        found.root.path.name,
                        "hook_contract: {} named by both `construct` and the "
                        "benchmark's own inputs".format(", ".join(clash)),
                    ),
                    discovery=found,
                    weights_used=weights_used,
                    weights_captured=weights_captured,
                ))
            searching = dict(searching, **models)

        #: How a submission of this resolution runs again: where to read the
        #: repository, and what the benchmark hands their code.
        again: Dict[str, Any] = {
            "_repository": repository,
            "_hints": tuple(hints),
            "_declared_root": declared_root,
            "_observed": observed,
            "_role": chain_role,
            "_bundle": bundle,
            # Each run of the binding builds its own models, so it needs the
            # hook rather than anything the search built with it.
            "_construct": construct,
            # Every returned submission carries these, not only the ones with
            # a database. A fit stage runs one of their functions on each run,
            # and a function that opens the week's artifact needs the same
            # answer on the tenth run as on the search.
            "_resource_files": dict(resource_files or {}),
        }

        # A week that loads its own models does not use the memo, and says so
        # rather than remembering something it cannot check. What a hook built
        # is not in the key and could not be: the key identifies inputs by
        # their bytes, and a model is an object their loader made, with no
        # representation here that a later run could be compared against.
        # Storing a binding chosen with one model and replaying it against
        # another is the wrong-binding case the whole key exists to prevent,
        # so this is a deliberate miss. Data-only weeks are unaffected.
        remember = remember and construct is None
        # A week that hands a folder to a zero-argument reader does not use it
        # either, for the same reason and with the same evidence. `_remembered`
        # records `selfOnly` but has no field for the folder name a step was
        # bound over, so a replayed step would be called with no arguments and
        # nothing put where its code looks. The reader then finds whatever the
        # caller's own directory holds: probed here with a same-named folder
        # beside the caller, the replayed step returned that folder's contents
        # and reported success. Adding a field for the name would make the
        # entry replayable; nothing needs that yet, and a wrong answer that
        # looks right is the thing to avoid first.
        remember = remember and not _declares_a_folder(chain_role)
        key = (
            _memo_key(
                found, benchmark=benchmark, chain_role=chain_role, fixture=fixture,
                extras=extras, identities=identities, resource_files=resource_files,
                weights_used=weights_used, readers=readers, max_attempts=max_attempts,
                arrangements=arrangements is not None, factories=factories is not None,
                project=project,
            )
            if remember else ""
        )
        keyed_sources = set(memo.source_paths(found)) if key else set()
        stored = memo.read(project.original, key) if key else None
        if stored:
            # Validation runs project code. Its namespace and mutable supplied
            # values must not become the returned submission or a cold search.
            try:
                with _scratch_cwd():
                    validation_found = discover(
                        repository, hints=hints, declared_root=declared_root,
                        resource_files=resource_files,
                        private_copy=project.execution != project.original,
                    )
                    validation = _under_clock(lambda: _replay(
                        deepcopy(stored), validation_found, chain_role, arrangements,
                        fixture=deepcopy(fixture), extras=deepcopy(extras),
                        identities=deepcopy(identities), resource_files=resource_files,
                        again=dict(again, _observed=observed),
                    ))
            except BaseException:  # copying or constructing an optional replay may fail
                validation = None
            try:
                valid = validation is not None and _valid_replay(
                    validation, accepts, fixture, factories=factories, readers=readers,
                )
            finally:
                # Validation built a whole run of their binding, models and
                # all, to answer one question. It is released here whether
                # that question was answered, refused or raised.
                if validation is not None:
                    _released(validation, watcher, cleanup)
            if validation is not None and (
                set(memo.source_paths(validation_found)) | observed != keyed_sources
            ):
                # A late import was not hashed at lookup. Acceptance cannot make
                # that incomplete key safe, including for a subsequent cold
                # search. Validation's own trial reads this repository again and
                # reports what it imported into `observed`, so a file reached
                # only from inside one of their functions counts here too.
                key = ""
            if valid and key:
                recalled = _replay(
                    stored, found, chain_role, arrangements, fixture=fixture,
                    extras=extras, identities=identities, resource_files=resource_files,
                    again=again,
                )
                if recalled is not None:
                    watcher.done()
                    # The current call validated one binding, not the original
                    # search's remembered attempt count. The weights are this
                    # run's too: a stored binding carries no receipts, and
                    # what `prepare` retained a moment ago is what this run
                    # scored with. Through `finish` like every other return,
                    # so the week answers for a replayed binding as well.
                    return finish(replace(
                        recalled,
                        attempts_tried=1,
                        weights_used=weights_used,
                        weights_captured=weights_captured,
                    ))

        watcher.phase("Looking for the functions that do the work")
        # What the week's test said about the last chain it rejected, kept so a
        # chain that ran end to end is reported in the week's words rather than
        # in a sentence written for another week.
        last_said: Dict[str, str] = {}
        # The pairing the verifier accepted, kept so the chain it belongs to is
        # not paired a second time on the way out.
        paired: Dict[str, Any] = {"tried": 0, "chains": 0}

        #: An input of ours that could not be given to their code again, and
        #: separately their code that could not be read again. Kept rather
        #: than reported where they happen, because they happen inside the
        #: verifier, and a verifier that says no makes the search report that
        #: their chain answered wrongly. Neither of these is that.
        #:
        #: Both are only worth reporting if nothing else bound. A chain the
        #: search could not put back is not a reason to refuse a repository
        #: whose next chain went through.
        refused: Dict[str, Unmapped] = {}
        unreadable: Dict[str, Unmapped] = {}
        #: Whether the week's own test was ever actually reached. If it never
        #: was, nothing can be said about what their code answered, because
        #: nothing of theirs was asked.
        asked: Dict[str, bool] = {"ever": False}

        def stopped(error: Unmapped) -> None:
            """Record why one verification could not proceed."""

            if error.reason == "benchmark_inputs":
                refused.setdefault("why", error)
            else:
                unreadable.setdefault("why", error)

        def handed(tentative: Binding) -> Any:
            """What the week's acceptance test is given for this binding.

            A role made of branches is judged on every branch visible so far,
            by name; every other role is judged on its one chain.
            """

            return dict(tentative.branches) if tentative.branches else tentative.steps

        if arrangements is None:
            # A week with no database is complete when its chain is, so the week's
            # acceptance test is the whole verifier.
            def verify(tentative: Binding) -> bool:
                # One reconstruction for the whole verification, so the case
                # the week's test is given and the resources its steps take
                # are the same objects wherever the benchmark shared them.
                given = bundle.again()
                owner = reading()
                try:
                    # Renewed and judged with the ownership the run this
                    # returns will have, so a week whose test drives its own
                    # adapter is judged on the database that adapter built.
                    with _sequential_owners():
                        try:
                            case = given.case()
                            put = _renewed(
                                tentative, owner, given, chain_role, construct
                            )
                        except Unmapped as error:
                            # Neither of these is the week's test saying no, so
                            # neither goes into `last_said`: that is the
                            # sentence the report quotes when it says their
                            # chain answered wrongly, and their chain was not
                            # asked.
                            stopped(error)
                            return False
                        asked["ever"] = True
                        ok, detail = accepts(handed(put), *case)
                finally:
                    # The chain this verification renewed answers out of this
                    # reading, so the reading lives exactly as long as the
                    # week's test is using it, and no longer, whether that
                    # test accepted, refused or raised.
                    _released(owner, watcher, cleanup)
                last_said["detail"] = str(detail or "")
                return bool(ok)

        else:
            # A week with a database is not complete when its chain is. The
            # question that decides a chain is whether some pair of their own
            # functions can store a song through it and name it back, so that
            # search is the verifier and `resolve_chain` keeps offering chains
            # until one of them pairs.
            #
            # Passing None here is what let names decide. The first chain the
            # frontier produced was accepted whatever it was, and the pairing
            # search only ever saw that one, so the stage preferences -- which
            # exist to order the search, not to judge it -- picked the chain.
            # Measured on the fixture repository in `test_discovered_chain`:
            # with the preferences emptied the accepted chain became
            # `make_spectrogram -> find_peaks -> find_peaks`, which pairs with
            # nothing that answers, and the run scored 0.125 instead of 0.640625.
            def verify(tentative: Binding) -> bool:
                # The first complete chain, kept for the report when none of them
                # pairs. "We found your fingerprinting and no database" has to be
                # able to name the fingerprinting it found; `Submission.close`
                # reduces these to the labels the record renders.
                paired.setdefault("steps", tuple(tentative.steps))
                # The ceiling is on the search, not on one chain of it. Restarting
                # it per chain meant a repository offering twelve complete chains
                # could try twelve times `max_attempts` pairings, so the number
                # that exists to bound how long a student waits bounded nothing.
                remaining = max_attempts - paired["tried"]
                if remaining <= 0:
                    return False
                # Every trial in here renews onto its own reading and hands
                # that to the week's test, so it owns what it builds the same
                # way the run this returns will.
                with _sequential_owners():
                    best, tried = _pair(
                        tentative,
                        found,
                        arrangements,
                        accepts,
                        grades,
                        factories,
                        readers,
                        remaining,
                        watcher,
                        reading,
                        _onto(tentative, bundle, chain_role, stopped, asked, construct),
                        cleanup,
                        offset=paired["tried"],
                    )
                paired["tried"] += tried
                paired["chains"] += 1
                if best is None:
                    return False
                paired["best"] = best
                return True

        chain, refusal = resolve_chain(
            chain_role,
            found.namespace,
            searched_fixture,
            verify_binding=verify,
            extras=searching,
            identities=searched_identities,
        )
        if chain is None and (refused or (unreadable and not asked["ever"])):
            # Nothing bound, and the reason is not their algorithm: the
            # week's test was never able to ask. Every sentence below says
            # their chain ran and answered. Only when nothing bound, because
            # a chain the search could not put back says nothing about the
            # next one.
            why = refused.get("why") or unreadable["why"]
            watcher.done()
            return finish(Submission(
                not_read(found.root.path.name, str(why)),
                discovery=found,
                weights_used=weights_used,
                weights_captured=weights_captured,
            ))

        if chain is None:
            watcher.done()
            assert refusal is not None
            # The refusal carries how far the search got. Reporting only the
            # stage that stalled would say "the spectrogram step found
            # nothing" for a repository whose spectrogram was found.
            reached = tuple(
                _step_note(stage, label)
                for stage, label in zip(
                    (stage.name for stage in chain_role.stages), refusal.furthest
                )
            )
            # Two refusals wear one sentence otherwise. "Nothing accepted
            # what your last function returned" is a wiring problem and often
            # ours to explain. "Your chain ran end to end and gave the wrong
            # answer" is their algorithm, and saying the first when the second
            # is true sends a team to look for a function they already wrote.
            if refusal.ran_to_the_end and arrangements is not None:
                # For a week with a database, "the chain ran to the end" means
                # every chain the frontier offered was complete and none of them
                # could be paired with a store and a query. Saying their
                # algorithm returned the wrong answer would be wrong twice over:
                # nothing of theirs was asked for an answer, and the missing
                # piece is a database rather than better work in the step
                # before it.
                #
                # Week 1 stores a song and Week 2 a face, so naming either told
                # the other week's team about the wrong course. Their own
                # function is the handle both weeks share, and the headline
                # already prints it.
                made = reached[-1].function
                return finish(Submission(
                    not_wired(
                        "identification",
                        "database",
                        reached,
                        next_step=(
                            "Check that two of your functions take what {} "
                            "returns: one that stores it under a name, and one "
                            "that looks up a new one and returns the name.".format(made)
                        ),
                        coverage=_coverage_of(found, benchmark),
                    ),
                    discovery=found,
                    weights_used=weights_used,
                    weights_captured=weights_captured,
                    chain=paired.get("steps", ()),
                    attempts_tried=paired["tried"],
                ))
            if refusal.ran_to_the_end:
                said = last_said.get("detail", "")
                return finish(Submission(
                    wired_but_wrong(
                        chain_role.name,
                        expects or "the answer the benchmark's own case has",
                        "a different answer ({})".format(said[:160]) if said else "a different answer",
                        reached,
                        notes=(
                            "Every function above is yours, and the benchmark "
                            "passed each one the input it asked for. What comes "
                            "back is not the answer the benchmark's own case has, "
                            "so the difference is in what your code computes "
                            "rather than in how it was connected up.",
                        ),
                    ),
                    discovery=found,
                    weights_used=weights_used,
                    weights_captured=weights_captured,
                ))
            return finish(Submission(
                not_wired(
                    chain_role.name,
                    refusal.stage,
                    reached,
                    last_returned=refusal.last_returned,
                    next_step=_next_step_for_stall(found, benchmark),
                    coverage=_coverage_of(found, benchmark),
                    notes=refusal.notes,
                    errors=refusal.errors,
                ),
                discovery=found,
                weights_used=weights_used,
                weights_captured=weights_captured,
            ))

        if key and set(memo.source_paths(found)) | observed != keyed_sources:
            # Search can discover additional project sources too, and so can a
            # trial that reads the repository again and runs a function of
            # theirs that imports a sibling. Do not persist this choice under
            # the earlier, incomplete inventory.
            key = ""

        for step, stage in zip(chain.steps, chain_role.stages):
            watcher.found(stage.name, step.label)

        if arrangements is None:
            watcher.done()
            if key:
                memo.write(project.original, key, dict(_remembered(chain), arrangement=-1))
            # `fresh` puts the whole binding on a reading of its own, so a
            # scored run starts from their modules as their file wrote them
            # rather than as the search left them.
            #
            # Before the handoff, not in `finish`: `_handed_over` builds that
            # reading and its models, and `finish` runs after it returns, so
            # leaving it to `finish` holds the search's models and the run's
            # at once. Closing twice is a no-op.
            for held in searching_held:
                held.close()
            return finish(_handed_over(
                Submission(
                    _scored_placeholder(chain),
                    discovery=found,
                    weights_used=weights_used,
                    weights_captured=weights_captured,
                    chain=chain.steps,
                    branches=dict(chain.branches),
                    fits=chain.fits,
                    missing=dict(chain.missing),
                    attempts_tried=0,
                    enroll=None,
                    query=None,
                    **again,
                ),
                found,
                weights_used,
                cleanup,
            ))

        # The accepted pairing's ordinal within its own chain is not how much
        # work this took: every chain before it was searched too.
        _grade, store, ask, index, _at, shape = paired["best"]
        watcher.attempts(paired["tried"], paired["tried"])
        watcher.done()
        if key:
            memo.write(
                project.original,
                key,
                dict(
                    _remembered(chain),
                    enroll=store.label,
                    query=ask.label,
                    arrangement=index,
                    attemptsTried=paired["tried"],
                    factory=shape.factory.label if shape.factory else None,
                    readers=[reader.label for reader in shape.readers],
                    state=shape.state,
                    stateAttribute=shape.state_attribute,
                ),
            )
        # Before the handoff builds this run's own reading and models; see
        # the same close above the chain-only return.
        for held in searching_held:
            held.close()
        return finish(_handed_over(
            Submission(
                _scored_placeholder(chain),
                discovery=found,
                weights_used=weights_used,
                weights_captured=weights_captured,
                chain=chain.steps,
                branches=dict(chain.branches),
                fits=chain.fits,
                missing=dict(chain.missing),
                attempt=Attempt(store.label, ask.label, index),
                attempts_tried=paired["tried"],
                _store=store,
                _ask=ask,
                _arrange=arrangements,
                _factory=shape.factory,
                _readers=shape.readers,
                _state=shape.state,
                _state_attribute=shape.state_attribute,
                **again,
            ),
            found,
            weights_used,
            cleanup,
        ))


def _pair(
    tentative: Binding,
    found: Discovery,
    arrangements: Callable[..., Any],
    accepts: Callable[..., Tuple[Any, str]],
    grades: Optional[Callable[[Any], Tuple[Any, str]]],
    factories: Optional[Callable[[Candidate], bool]],
    readers: int,
    max_attempts: int,
    watcher: Any,
    reading: Callable[[], Project],
    renew: Callable[[Project], Any],
    cleanup: List[str],
    offset: int = 0,
) -> Tuple[Optional[Tuple[float, Candidate, Candidate, int, int, "_Shape"]], int]:
    """The best pair of their functions that stores a song through ``steps``
    and names it back, or None when no pair does.

    Two questions, asked separately, because they have separate answers.

    Whether a store takes an enrolment is a property of the store, of the
    arrangement it is offered in, and of the shape around it. The query is not
    one of its inputs and cannot change the answer, so it is asked once per
    (shape, store, arrangement) with ``query_call=None`` and only the stores
    that said yes are paired at all.

    Whether a pair answers is the week's whole acceptance test, and it is run
    once per accepted store and query candidate whose signature can take the
    call that shape makes.

    Asking the first question inside the second is what made this quadratic in
    the size of a repository: on one 59-candidate corpus repository it ran
    19,152 pairings plus 125,104 reader trials, 1,244 seconds against a
    900-second hosted limit, where two candidates take an enrolment and six
    can be asked, which is 12 pairings.

    Returns the pairing and how many attempts it took, probes included: both
    halves run the week's test on their code, and a bar that counted only one
    of them would sit still through the other.

    ``max_attempts`` is what is LEFT of the search's ceiling, and ``offset``
    is what the chains before this one already spent. Both exist because the
    ceiling belongs to the search rather than to one chain of it, and because
    a progress bar that restarts at zero for every chain reads as no progress
    at all.

    ``reading`` gives each attempt its own reading of their repository and
    ``renew`` puts the chain and its side inputs onto that reading; see
    `_Trial` and `_renewed`. Which of their functions can be a store, a query
    or a reader is still decided once here, off the search's own candidates,
    because those are signature questions and a second reading answers them
    the same way.
    """

    steps = tentative.steps
    candidates = _store_candidates(found, steps)
    arrangement_count = len(arrangements(lambda *_: None, "", None))
    # The shapes a store and a query can have between them. The first is two
    # of their functions, nothing in front and nothing after.
    shapes = _shapes_for(candidates, factories, readers)
    watcher.phase(
        "Trying your functions to find which pair stores a song and names it back"
    )
    # Which of their functions could take the state form at all, and which
    # could be handed what each shape's query call passes. Both are properties
    # of the candidate rather than of a pairing, and both read a signature,
    # which is the expensive part, so each is answered once here.
    holds_state = {c.label for c in candidates if _FromTheirStore.possible(c.call)}
    asking = {
        arity: [c for c in candidates if _accepts_n(c, arity)]
        for arity in {shape.query_arity for shape in shapes}
    }
    # A reader takes what the query returned and nothing else, so only a
    # function with exactly one required positional argument can be one.
    readable = [c for c in candidates if _takes_one(c)] if readers > 0 else []

    probes = [
        (at, shape, store, index)
        for at, shape in enumerate(shapes)
        for store in candidates
        for index in range(arrangement_count)
        if not shape.state or store.label in holds_state
    ]
    probe_total = offset + min(len(probes), max_attempts)
    tried = 0
    # Every arrangement one store took, grouped by the (shape, store) it took
    # them in and in the order the probes tried them, so the pairings below
    # are enumerated one store, then every query, then every arrangement.
    accepted: List[Tuple["_Shape", Candidate, List[int]]] = []
    by_store: Dict[Tuple[int, str], List[int]] = {}
    for at, shape, store, index in probes:
        if tried >= max_attempts:
            break
        tried += 1
        watcher.attempts(offset + tried, probe_total)
        # A probe gets its own reading for the same reason a pairing does,
        # and no query, because there is nothing here a query could answer.
        probe = _Trial(shape, store, None, arrangements, index, reading(), renew)
        try:
            try:
                chain = probe.steps()
            except NoDatabase:
                # Their chain is not in this reading, so there is nothing to
                # probe this store with. Counted as the attempt it was.
                continue
            enrolled, _detail = accepts(chain, probe.enroll, None)
        finally:
            _released(probe, watcher, cleanup)
        if not enrolled:
            continue
        indexes = by_store.get((at, store.label))
        if indexes is None:
            indexes = []
            by_store[(at, store.label)] = indexes
            accepted.append((shape, store, indexes))
        indexes.append(index)

    pairings = [
        (shape, store, ask, index)
        for shape, store, indexes in accepted
        for ask in asking[shape.query_arity]
        if ask is not store
        for index in indexes
    ]
    total = offset + min(len(probes) + len(pairings), max_attempts)

    # More than one of their functions can pass: a `query` that returns the
    # winning song and a `query_details` that returns the same winner plus the
    # vote tally both name the right song, and the benchmark asks for a ranked
    # list, so taking whichever was reached first costs every metric below
    # rank 1.
    #
    # The week's own acceptance test says how completely a pairing answered,
    # by returning a number rather than a bare pass. The search keeps the best
    # it has seen and stops as soon as one answers fully. This decides which
    # of their functions to ask, never what the answer should be.
    best: Optional[Tuple[float, Candidate, Candidate, int, int, _Shape]] = None
    for shape, store, ask, index in pairings:
        if tried >= max_attempts:
            break
        tried += 1
        watcher.attempts(offset + tried, total)

        # A trial gets its own reading. Sharing one across trials let the
        # second trial enrol into a database the first had already filled, so
        # a store that refuses a song id it has seen raised on every trial
        # after the first and the tail that would have answered was recorded
        # as one that raised.
        trial = _Trial(shape, store, ask, arrangements, index, reading(), renew)
        try:
            ok = _paired_once(
                trial, accepts, grades, readable, readers, store, ask, shape,
            )
        finally:
            # Whatever this pairing did, its reading and its models stop here.
            # The accepted pairing is named by the search's own candidates, so
            # nothing that survives this loop holds a closed reading.
            _released(trial, watcher, cleanup)
        if ok is None:
            continue
        grade, bound = ok
        if grade > 0 and (best is None or grade > best[0]):
            best = (grade, store, ask, index, tried, bound)
        if best is not None and best[0] >= FULLY_ANSWERED:
            break

    return best, tried


def _paired_once(
    trial: "_Trial",
    accepts: Callable[..., Tuple[Any, str]],
    grades: Optional[Callable[[Any], Tuple[Any, str]]],
    readable: Sequence[Candidate],
    readers: int,
    store: Candidate,
    ask: Candidate,
    shape: "_Shape",
) -> Optional[Tuple[float, "_Shape"]]:
    """Run one pairing and say what it earned, or None when it never ran.

    Its own function so the trial that owns the reading can be released by one
    `finally` around the whole of it, rather than at each of the places this
    used to return or fall through.
    """

    try:
        chain = trial.steps()
    except NoDatabase:
        return None
    asked = _Asked(trial.query())
    ok, _detail = accepts(chain, trial.enroll, asked)
    grade = float(ok)
    # The shape this pairing bound with, kept apart from the one the loop
    # is iterating. Assigning readers back onto `shape` rewrote the loop
    # variable, so every later pairing in the same pass was then run
    # through readers chosen for an earlier one.
    bound = shape
    if trial.state is not None:
        # Which attribute their query was actually handed, now that a
        # pairing has run and found out.
        bound = replace(bound, state_attribute=trial.state.chosen)
    # The bare query's grade is banked before any reader is tried, so a
    # reader search that finds nothing cannot cost the pairing the grade
    # it already earned (measured on one 2026 repository whose one working
    # pairing earns exactly 0.5).
    if grade < FULLY_ANSWERED and readers > 0 and asked.ran:
        # Their query answered something the benchmark could not read as a
        # ranking. Before giving that a lower grade, try up to `readers`
        # more of their own functions on what it returned: rutvim2009
        # Week1's `query_database` returns a vote tally keyed by
        # `(song_id, offset)`, and its `get_sorted_matches` then
        # `get_sorted_songs` are what turn that into song names.
        #
        # `asked.ran` is the whole rule: a reader reads what the query
        # returned, so a pairing whose query raised never reached the
        # point where one could be applied. An empty answer is not
        # excluded, because turning an empty tally into a ranking is a
        # thing one of their readers can do, and excluding it made that
        # reader unreachable.
        better = _read_further(
            grades,
            asked.answer,
            trial,
            [c for c in readable if c is not store and c is not ask],
            readers,
            grade,
        )
        if better is not None:
            grade, bound = better[0], replace(bound, readers=better[1])
    return grade, bound


@dataclass(frozen=True)
class _Shape:
    """One way a store and a query can be arranged around their database.

    The plain shape -- no factory, no readers, no state -- is first. The
    others exist because one team's database is a dict their own
    `create_database()` returns and their answer is three of their own
    functions deep, and another's matcher is a pure function that has to be
    handed the table their store filled. Neither is expressible as a pair of
    callables.
    """

    factory: Optional[Candidate] = None
    readers: Tuple[Candidate, ...] = ()
    #: Whether the query is handed the store object's own filled table and a
    #: table of song ids, rather than being asked with the item alone.
    state: bool = False
    #: Which attribute of the store object that table was, once a pairing has
    #: run and found out. Recorded rather than chosen in advance, because
    #: nothing about the object says which of its attributes the store fills
    #: until the store has filled one.
    state_attribute: Optional[str] = None

    @property
    def query_arity(self) -> int:
        """How many positional arguments `_read` hands their query here.

        The three branches of `_read` are these three numbers: the plain shape
        asks with the item alone, a factory shape puts their own database in
        front of it, and the state shape adds the table their store filled and
        an id-to-name table beside it. A candidate whose signature cannot take
        that many is not a query of this shape.
        """

        if self.state:
            return 3
        return 1 if self.factory is None else 2


class NoDatabase(Exception):
    """This pairing could not be given a database of its own.

    Their factory raised, their class would not build, or the code a binding
    names is not in a freshly read copy of their repository. Construction
    happens on first enrollment or query, in the caller's working directory.
    Acceptance tests treat this as a failed pairing; callers of a returned
    submission receive the same error.
    """


class _Trial:
    """One pairing over a repository read again for it alone.

    Three things have to be true at once and none of them was.

    The state their code keeps has to be this pairing's alone, and rebuilding
    the store's object is not enough to make it so. Measured on temporary
    projects under Python 3.8.20 and 3.13.12: a store keeping its songs in a
    module-level dict, or in an attribute of its class rather than of its
    instance, accepted one enrolment and refused the next nine, because every
    trial shared one reading of the repository. Nothing a trial can do to an
    object fixes that, so the trial reads the repository again and takes the
    whole binding off the new modules. `_namespace.Project` is that reading.

    The chain has to come from the same reading as the store. The week's
    acceptance test is handed both, and a fingerprinter whose module global
    the store also reads is one program; running the two halves in two
    namespaces would be another.

    And their database has to be built where the week's acceptance test runs.
    A week may give each attempt a world of its own: week 1 changes to an
    empty directory inside `accepts`, which is after the search would already
    have called their factory or their constructor. So nothing of theirs is
    built here. The first enrolling call builds it, and the query reads
    whatever that call built.
    """

    __slots__ = (
        "_shape",
        "_store",
        "_ask",
        "_arrange",
        "_index",
        "_begun",
        "_refused",
        "_held",
        "_call",
        "_asking",
        "_reading",
        "_project",
        "_renew",
        "_chain",
        "_resource_files",
        "state",
    )

    def __init__(
        self,
        shape: "_Shape",
        store: Candidate,
        ask: Optional[Candidate],
        arrange: Optional[Callable[..., Sequence[Callable[[], Any]]]],
        index: int,
        project: Project,
        renew: Optional[Callable[[Project], Any]] = None,
        resource_files: Optional[Dict[str, Path]] = None,
    ) -> None:
        #: None for the enrolment probe, which asks whether this store takes
        #: the fixture at all and so has no query to bind.
        self._ask = ask
        self._shape = shape
        self._store = store
        self._arrange = arrange
        self._index = index
        self._begun = False
        self._refused = ""
        self._held: Any = None
        self._call: Any = store.call
        self._asking = ask
        self._reading = shape.readers
        #: This trial's own reading of their repository. Nothing is shared
        #: with any other trial, including the module objects.
        self._project = project
        #: How to put the chain and its side inputs onto that reading. None
        #: for a caller that has no chain to hand the acceptance test.
        self._renew = renew
        self._chain: Any = None
        self._resource_files = dict(resource_files or {})
        #: Set once the database exists, so a caller that needs to know which
        #: attribute their store filled reads it after the pairing has run.
        self.state: Optional["_FromTheirStore"] = None

    def close(self) -> None:
        """Release this trial's reading, and everything made out of it.

        The reading first, and then what this trial took off it: their
        database, the store and query it enrolled through, their readers, and
        the table it read back off their object. Those are the SDK's
        references, not the week's, and nothing else drops them -- the week's
        adapter goes on holding this trial through `enroll` and `query` for as
        long as it lives, and both refuse once the reading is closed.

        Idempotent, and it raises `CleanupFailed` only when the week's own
        model hook raised on the way out; the handles go either way.
        """

        try:
            self._project.close()
        finally:
            self._held = None
            self._call = None
            self._asking = None
            self._reading = ()
            self._chain = None
            self.state = None

    def steps(self) -> Any:
        """The chain the week's acceptance test is handed for this trial.

        Taken off this trial's own reading, so the chain and the store share
        their module objects and a fit stage's value is the one this reading's
        code computed. Reading happens here rather than in `_begin` because
        the acceptance test needs the chain before it calls anything, and
        reading builds none of their objects.
        """

        if self._chain is None:
            if self._renew is None:
                return ()
            with _Redirects(self._resource_files):
                try:
                    self._chain = self._renew(self._project)
                except Unmapped as error:
                    raise NoDatabase(str(error)) from None
        return self._chain

    def _map(self, candidate: Candidate) -> Candidate:
        """One selected callable, taken off this trial's own reading."""

        try:
            return self._project.rebind(candidate)
        except Unmapped as error:
            raise NoDatabase(str(error)) from None

    def _begin(self) -> None:
        """Make this trial's database, once, at the moment it is first used.

        Asked of a closed run, this is where the refusal comes from, before
        anything reaches for a handle `close` has already dropped.
        """

        if self._project.closed:
            raise Closed("this submission was closed; resolve again for a new run")
        if self._begun:
            if self._refused:
                raise NoDatabase(self._refused)
            return
        self._begun = True
        try:
            with _Redirects(self._resource_files), self._project.running():
                self._held = self._empty_database()
                self._call = self._map(self._store).call
                if self._ask is not None:
                    self._asking = self._map(self._ask)
                self._reading = tuple(
                    self._map(reader) for reader in self._shape.readers
                )
                # Read before anything is enrolled, and on this trial's own
                # object: what their store filled is the difference between
                # the object now and the object afterwards.
                self.state = _FromTheirStore(self._call) if self._shape.state else None
        except NoDatabase as error:
            # Only selected callables refuse the trial. A speculative reader
            # that cannot be taken off this reading must leave the later
            # readers available to the search.
            self._refused = str(error)
            raise

    def _empty_database(self) -> Any:
        """Their own empty database, or None when this shape has no factory."""

        if self._shape.factory is None:
            return None
        factory = self._map(self._shape.factory)
        try:
            return factory.call()
        except BaseException:  # noqa: BLE001 - student code raises anything
            raise NoDatabase(
                "their factory raised, so this pairing has no database"
            ) from None

    def enroll(self, song_id: str, item: Any) -> Any:
        """Put one item in this trial's database, the week's way round."""

        self._begin()
        if self.state is not None:
            self.state.enrolling(song_id)
        target = self._call if self._held is None else _leading(self._call, self._held)
        with self._project.running():
            if self._arrange is None:
                return target(song_id, item)
            return self._arrange(target, song_id, item)[self._index]()

    def query(self) -> Callable[[Any], Any]:
        """Their query over this trial's database."""

        def _ask(item: Any) -> Any:
            self._begin()
            with self._project.running():
                return _read(self._asking, self._held, self._reading, item, self.state)

        return _ask

    def reading(self, candidate: Candidate) -> Callable[[Any], Any]:
        """One of their functions, taken off this trial's own reading.

        A reader is one of their functions and can be a method like any other.
        One that came off the object the store came off has to come off this
        trial's object, or it reads the database an earlier trial filled
        rather than this one's.

        A reader the search is only speculating about is mapped here rather
        than in `_begin`, so one that cannot be taken off this reading is not
        a reader of this value and the trial stays usable.
        """

        self._begin()
        with _Redirects(self._resource_files):
            call = self._map(candidate).call

        def _run(value: Any) -> Any:
            with self._project.running():
                return call(value)

        return _run


class AmbiguousStore(Exception):
    """Their store object holds more than one filled table after enrolling.

    Raised rather than guessed. Two filled mappings mean two answers to "what
    did the store fill", and picking the first by name would be picking one of
    their data structures at random and calling the result their score.
    """


class _FromTheirStore:
    """The table their store filled, and an id-to-name table beside it.

    One corpus team fills `self.hash_map` from a method and matches with a
    pure `match_fingerprint(recording_fp, database, song_index)` that takes
    that table as an argument. The database is neither an argument their store
    took nor a module global: it is state on the object their store is a
    method of, and the only way to hand it to the matcher is to read it off
    that object once the store has run.

    Which attribute it is, is not asked in advance and never read from a
    name. After enrolling, exactly one attribute holding a non-empty mapping
    is the table their store filled. More than one is `AmbiguousStore`.

    ``song_index`` is the one thing here the benchmark supplies rather than
    reads: their matcher looks a song id up in it and returns what it finds,
    so an identity table over the ids just enrolled returns their own answer
    unchanged. Anything else would be putting words in their matcher's mouth.
    """

    __slots__ = ("_instance", "_enrolled", "_before", "chosen")

    def __init__(self, store_call: Callable[..., Any]) -> None:
        self._instance = getattr(store_call, "__self__", None)
        self._enrolled: List[str] = []
        self.chosen: Optional[str] = None
        # Every mapping the object already had, and how big it was, read
        # before anything is enrolled. What their store filled is the
        # difference between this and the object afterwards; see `_filled_here`.
        self._before = _mappings_on(self._instance)

    @staticmethod
    def possible(store_call: Callable[..., Any]) -> bool:
        """Whether there is an object to read state off at all."""

        return getattr(store_call, "__self__", None) is not None

    def enrolling(self, song_id: str) -> None:
        self._enrolled.append(song_id)

    def _filled_here(self, name: str, value: Any) -> bool:
        """Whether enrolling is what put something in this mapping.

        A store object arrives with mappings that have nothing to do with
        songs: a database class whose constructor makes a metadata table
        beside its fingerprint table is in the corpus. Counting any non-empty
        mapping as a candidate made such an object ambiguous and refused a
        pairing that works.

        So the comparison is the object before enrolling against the object
        after. Identity and size detect replacement and growth; a deep copy
        detects nested in-place changes. Failed copying or equality leaves a
        table possibly changed, so it cannot rule out an ambiguous store.

        When their store filled nothing at all there is no difference to
        read, and `arguments` falls back to naming what the object holds.
        """

        before = self._before.get(name)
        if before is None:
            # An attribute their store created while enrolling.
            return True
        was, size, contents = before
        if value is not was or len(value) != size:
            return True
        if contents is _UNCOPIED:
            return True
        try:
            # Deep snapshots reach nested student equality methods too.
            return _under_clock(lambda: not bool(dict(value) == contents))
        except BaseException:  # noqa: BLE001 - their mapping, their equality
            return True

    def arguments(self) -> Tuple[Any, Dict[str, str]]:
        """The filled table and the id-to-name table, in that order."""

        holds = [
            (name, value)
            for name, value in sorted(_stored_attributes(self._instance), key=lambda pair: pair[0])
            if isinstance(value, _MappingABC) and len(value) > 0
        ]
        filled = [pair for pair in holds if self._filled_here(*pair)]
        if not filled:
            # Their store put nothing anywhere this query could read, so
            # there is no difference to tell their table from their settings
            # by, and what the object holds is the whole of what can be said.
            filled = holds
        if not filled:
            raise AmbiguousStore("their store filled nothing this query could read")
        if len(filled) > 1:
            raise AmbiguousStore(
                "their store filled more than one table ({}), so which one their "
                "query wants is not something this can read off the object".format(
                    ", ".join(name for name, _ in filled)
                )
            )
        self.chosen = filled[0][0]
        return filled[0][1], {song_id: song_id for song_id in self._enrolled}


#: Copying failed, so unchanged identity and size cannot prove unchanged contents.
_UNCOPIED = object()


def _stored_attributes(instance: Any) -> Iterator[Tuple[str, Any]]:
    """Read actual instance storage without executing properties or __getattr__."""

    if instance is None:
        return
    classes = type(instance).__mro__
    for cls in classes:
        descriptor = vars(cls).get("__dict__")
        if isinstance(descriptor, GetSetDescriptorType):
            yield from descriptor.__get__(instance, type(instance)).items()
            break
    for cls in classes:
        for name, descriptor in vars(cls).items():
            if isinstance(descriptor, MemberDescriptorType):
                try:
                    value = descriptor.__get__(instance, type(instance))
                except AttributeError:  # An uninitialized slot has no stored value.
                    continue
                yield name, value


def _mappings_on(instance: Any) -> Dict[str, Tuple[Any, int, Any]]:
    """Mapping storage, retaining reference and size as well as deep contents.

    Nested built-in containers must not share a snapshot with live state.
    This is not a general arbitrary-object snapshot guarantee: custom copying
    and equality control what can be observed. If either raises, the table
    remains possibly changed rather than being excluded from consideration.
    """

    found: Dict[str, Tuple[Any, int, Any]] = {}
    for name, value in _stored_attributes(instance):
        if not isinstance(value, _MappingABC):
            continue
        try:
            size = len(value)
        except BaseException:  # noqa: BLE001 - their mapping, their __len__
            continue
        try:
            # Both mapping conversion and copying may run student code.
            contents: Any = _under_clock(lambda: deepcopy(dict(value)))
        except BaseException:  # noqa: BLE001 - a mapping that cannot be read whole
            contents = _UNCOPIED
        found[name] = (value, size, contents)
    return found


def _read(
    ask: Candidate,
    held: Any,
    readers: Sequence[Candidate],
    item: Any,
    state: Optional[_FromTheirStore] = None,
) -> Any:
    """Ask their query, then hand the answer to their own readers in turn.

    The three branches below are what `_Shape.query_arity` counts, and a
    candidate is only offered as a query of a shape whose count its signature
    can take.
    """

    if state is not None:
        answer = ask.call(item, *state.arguments())
    elif held is None:
        answer = ask.call(item)
    else:
        answer = ask.call(held, item)
    for reader in readers:
        answer = reader.call(answer)
    return answer


#: No call was made, as distinct from a call that returned None. The week's
#: acceptance test may never reach the query -- enrolling raises first for
#: most pairings -- and "the query returned nothing" and "the query never ran"
#: must not read the same, because only the first could have readers.
_UNASKED = object()


class _Asked:
    """One pairing's query, remembering whether it came back with anything.

    The week's acceptance test owns the call, so the search cannot see the
    answer by asking for it; it sees it by being the thing that was called.
    """

    __slots__ = ("_ask", "answer")

    def __init__(self, ask: Callable[[Any], Any]) -> None:
        #: The trial's own query. A callable rather than the pieces of one,
        #: because the trial builds its database when it is first used and so
        #: does not have those pieces until then.
        self._ask = ask
        self.answer: Any = _UNASKED

    def __call__(self, item: Any) -> Any:
        self.answer = self._ask(item)
        return self.answer

    @property
    def ran(self) -> bool:
        """Whether the query was reached and returned rather than raised.

        Anything narrower is a guess about their code: requiring a non-empty
        answer makes a reader that turns an empty tally into an empty ranking
        unreachable.
        """

        return self.answer is not _UNASKED


def _shapes_for(
    candidates: Sequence[Candidate],
    factories: Optional[Callable[[Candidate], bool]],
    readers: int,
) -> List[_Shape]:
    """Every store-and-query arrangement worth trying, plainest first.

    Ordered plainest first, so a week that declares neither a factory nor
    readers gets exactly one shape and one pass.
    """

    shapes = [_Shape()]
    found = [c for c in candidates if factories and _safely(factories, c)] if factories else []
    for factory in found:
        shapes.append(_Shape(factory, ()))
    # One more, last: their store's own filled table handed to their query,
    # with an id-to-name table beside it. Checked per pairing rather than
    # enumerated here, because whether an object has a filled table is not
    # knowable until a store has run.
    shapes.append(_Shape(state=True))
    # Readers are not enumerated here. Every ordered pair of candidates times
    # every reader permutation is past any budget: 50 candidates and two
    # reader slots make 13,525 shapes and about 200 million attempts against a
    # ceiling of 20,000. Readers are looked for afterwards, and only for a
    # pairing whose query returned something to read; see `_read_further`.
    return shapes


def _reader_input(value: Any) -> Any:
    """Detach a probe input, preserving built-in dictionary view types.

    Python's deepcopy cannot copy these views. Rebuild their visible contents
    in a detached dictionary, keeping iteration order and repeated values.
    Other inputs still depend on their own deepcopy support; this does not
    reconstruct arbitrary objects or views nested inside them.
    """

    if type(value) is type({}.items()):
        return deepcopy(dict(value)).items()
    if type(value) is type({}.keys()):
        return deepcopy(dict.fromkeys(value)).keys()
    if type(value) is type({}.values()):
        return deepcopy(dict(enumerate(value))).values()
    return deepcopy(value)


def _read_further(
    grades: Callable[[Any], Tuple[Any, str]],
    answer: Any,
    trial: "_Trial",
    pool: Sequence[Candidate],
    readers: int,
    floor: float = 0.0,
) -> Optional[Tuple[float, Tuple[Candidate, ...]]]:
    """The shortest run of their readers that turns ``answer`` into something
    the benchmark can read, or None when none of them improves on it.

    A reader reads a value, so whether it can read this one is a property of
    the reader and the value and costs one call to settle: ``reader(answer)``
    either returns or raises, and one that raises is not a reader of that
    value and is not extended. What it returned is graded by the week off the
    answer alone (`DiscoverySpec.grades`), which is the same reading the week
    gave the bare query, so a tail that scores higher scores higher for the
    same reason.

    Settling it by rebuilding the database, re-enrolling the fixture and
    re-querying it once per candidate tail is what this replaces: on one
    corpus repository that was 125,104 such runs after the pairing search.

    Shortest tails first, stopping at the first tail the week grades as fully
    answered. ``floor`` is the grade the query already earned on its own, and
    a tail has to beat it rather than match it: a reader that leaves the grade
    where it was changed nothing the benchmark can see, and binding it would
    put one of their functions in the record for a run whose answer it did not
    alter.

    How much this costs is not bounded here, and the note on `MAX_ATTEMPTS`
    says why that is still open. Tails are orderings of the pool without
    repetition, so one pairing at depth `d` over a pool of `P` costs
    `P + P(P-1) + ... ` calls: 1,464 for twelve readers at depth three, and
    that recurs for every pairing that graded short of fully answered.
    """

    best: Optional[Tuple[float, Tuple[Candidate, ...]]] = None
    frontier: List[Tuple[Tuple[Candidate, ...], Any]] = [((), answer)]
    for _depth in range(max(readers, 0)):
        onward: List[Tuple[Tuple[Candidate, ...], Any]] = []
        for tail, value in frontier:
            for reader in pool:
                if reader in tail:
                    continue
                try:
                    # The clock every other call into their code already had.
                    # `reading` is inside it because it rebinds onto their
                    # object and that is their code too. A reader that does not
                    # return is not a reader of this value, which is what the
                    # `except` below already says about one that raises.
                    # A mutating reader must not poison its siblings or the
                    # next frontier. Copy failures skip this probe too.
                    produced = _under_clock(
                        lambda c=reader, v=value: trial.reading(c)(_reader_input(v))
                    )
                except BaseException:  # noqa: BLE001 - not a reader of this value
                    continue
                tail_with = tail + (reader,)
                onward.append((tail_with, produced))
                grade = float(grades(produced)[0])
                if grade <= floor:
                    continue
                if best is None or grade > best[0]:
                    best = (grade, tail_with)
                if grade >= FULLY_ANSWERED:
                    return best
        frontier = onward
        if not frontier:
            break
    return best


def _accepts_n(candidate: Candidate, count: int) -> bool:
    """Whether a query declares enough positional slots for this call."""

    try:
        signature = inspect.signature(candidate.call)
        positionals = [p for p in signature.parameters.values() if p.kind in (
            inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD,
        )]
        # Optional positionals are supported; extra variadic slots remain deferred.
        if count > len(positionals):
            return False
        signature.bind(*([None] * count))
    except (TypeError, ValueError):
        return False
    return True


def _takes_one(candidate: Candidate) -> bool:
    """Whether this callable takes exactly one required positional argument."""

    return _takes_n(candidate, 1)


def _takes_n(candidate: Any, count: int) -> bool:
    """Whether this callable takes exactly ``count`` required positionals.

    Accepts a `Candidate` or a callable. Reader enumeration retains this exact
    required-argument filter; widening query signatures must not enlarge its pool.
    """

    try:
        parameters = inspect.signature(
            getattr(candidate, "call", candidate)
        ).parameters.values()
    except (TypeError, ValueError):
        return False
    required = [
        p for p in parameters
        if p.default is inspect.Parameter.empty
        and p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    return len(required) == count


def _safely(predicate: Callable[[Candidate], bool], candidate: Candidate) -> bool:
    try:
        return bool(predicate(candidate))
    except BaseException:  # noqa: BLE001 - a week's predicate must not break the search
        return False


def _on_this_reading(submission: Submission) -> Candidate:
    """This run's own factory, for the week's predicate to ask about.

    A week answers "is this what an empty database looks like" by calling the
    candidate, and what a submission keeps is a description of the call rather
    than the search's own function. So it is taken off the reading this run
    already owns, which is also the code the run would use.
    """

    factory = submission._factory
    assert factory is not None  # only asked for when there is one
    return factory if submission._owned is None else submission._owned.rebind(factory)


def _valid_replay(
    submission: Submission, accepts: Callable[..., Tuple[Any, str]],
    fixture: Sequence[Any], *, factories: Optional[Callable[[Candidate], bool]],
    readers: int,
) -> bool:
    """A remembered binding is only a suggestion to the current acceptance test.

    A partial grade cannot establish that it is still the best pairing, so
    only a fully answered validation can avoid the search.
    """

    if len(submission._readers) > readers:
        return False
    try:
        with _scratch_cwd():
            def validate():
                if submission._factory is not None and (
                    factories is None
                    or not _safely(factories, _on_this_reading(submission))
                ):
                    return False
                # _replay already built this validation-only submission.
                if submission.attempt is None:
                    grade, _detail = accepts(submission.chain, *deepcopy(fixture))
                else:
                    grade, _detail = accepts(submission.chain, submission.enroll, submission.query)
                return float(grade) >= FULLY_ANSWERED

            return _under_clock(validate)
    except BaseException:  # a failed cache validation is a miss, not a refusal
        return False


def _memo_key(
    found: Discovery, *, benchmark: str, chain_role: Role, fixture: Sequence[Any],
    extras: Optional[Dict[str, Any]], identities: Sequence[Any],
    resource_files: Optional[Dict[str, Path]], weights_used: Sequence[str],
    readers: int, max_attempts: int, arrangements: bool, factories: bool,
    project: Optional[ExecutionPaths] = None,
) -> str:
    """Identify supported search inputs; opaque inputs deliberately skip caching.

    Acceptance callbacks are rerun, not identified by their source or repr:
    closures and module variables can change without changing either string.
    Declared model and course files participate by contents alongside source.
    """

    # Branch/fit replay is unsupported already. Do not try to identify its
    # dynamically computed fixtures or retain a record that cannot be reused.
    if chain_role.branches or any(stage.fit for stage in chain_role.stages):
        return ""
    paths = memo.source_paths(found)
    try:
        root = found.root.path.resolve()
        for name in weights_used:
            path = root / name
            path.resolve().relative_to(root)
            if Path(name).is_absolute():
                return ""
            paths.append(path)
        resources = []
        for name, path in sorted((resource_files or {}).items()):
            paths.append(Path(path))
            resources.append((name, str(path)))
    except (OSError, TypeError, ValueError):
        return ""
    inputs = {
        "role": chain_role.name,
        "stages": [
            {name: value for name, value in vars(stage).items()
             if name not in ("accepts", "produces")}
            for stage in chain_role.stages
        ],
        "fixture": tuple(fixture) if type(fixture) is Fixtures else fixture,
        "forms": type(fixture) is Fixtures,
        "extras": extras if extras is not None else {},
        "identities": identities,
        "resources": resources,
        "weights": tuple(weights_used),
        "readers": readers,
        "maxAttempts": max_attempts,
        "arrangements": arrangements,
        "factories": factories,
    }
    return memo.fingerprint(paths, benchmark=benchmark, inputs=inputs, project=project)


def _remembered(chain) -> Dict[str, Any]:
    """The part of a binding a replay needs, as plain data.

    Every field a step was called with, not only which function it was: a
    step replayed without the tuning, the input form, the side inputs, or the
    per-item loop that made it run is a call the student's code never
    received.
    """

    steps = list(chain.steps)
    return {
        "chain": [step.label for step in steps],
        "tunings": [step.tuning for step in steps],
        "form": steps[0].form if steps else None,
        "inPlace": [step.in_place for step in steps],
        "plans": [list(step.plan) for step in steps],
        "keywords": [list(step.keywords) for step in steps],
        # The keyword arguments this step passes, as parameter and slot. Not
        # derivable from `keywords`, which is only a list of extras passed
        # under their own names: a keyword argument may hold a tuning or the
        # item's own identity, and a required keyword-only parameter is
        # unfillable without this. A step replayed without it is called a
        # different way from the way the search proved.
        "keywordPlans": [
            [[name, slot] for name, slot in step.keyword_plan] for step in steps
        ],
        "perItem": [step.per_item for step in steps],
        "elements": [step.element for step in steps],
        "selfOnly": [step.self_only for step in steps],
        # Which reading of the upstream value each step was called with: a
        # fused step that returns both a spectrogram and its peaks offers two
        # readings their next function accepts. See `Candidate.handoff`.
        "handoffs": [step.handoff for step in steps],
        "fits": [[name, step.label] for name, step in chain.fits],
        "branches": {
            name: [step.label for step in branch]
            for name, branch in sorted(chain.branches.items())
        },
    }


def _replay(
    stored: Optional[Dict[str, Any]],
    found: Discovery,
    chain_role: Role,
    arrangements: Callable[..., Sequence[Callable[[], Any]]],
    fixture: Sequence[Any] = (),
    extras: Optional[Dict[str, Any]] = None,
    identities: Sequence[Any] = (),
    resource_files: Optional[Dict[str, Path]] = None,
    again: Optional[Dict[str, Any]] = None,
) -> Optional[Submission]:
    """Rebind a remembered result, or return None and let the search run.

    A stored entry is names, not functions, so this looks each one up in the
    namespace that was just imported. Any name that no longer resolves means
    their code moved, and the honest response is to search again rather than
    to report a binding that no longer exists.

    ``again`` says how to read the repository for each run of the binding; see
    `Submission.fresh`. A replay without it has no bound calls at all, because
    a run of a remembered binding is a run like any other and gets its own
    reading rather than the namespace the lookup happened to import.
    """

    if not stored:
        return None

    # A binding whose side inputs were computed by their own code, or whose
    # role is several branches, is searched again rather than replayed. The
    # names alone do not restore it: a fit stage's value has to be recomputed
    # by running their function, and a branch's later steps are methods of an
    # object that only exists once the branch before it has run.
    if stored.get("fits") or stored.get("branches"):
        return None

    pool = dict(extras or {})
    forms = fixture if isinstance(fixture, Fixtures) else (fixture,)
    # An entry this version cannot read is a miss, the same as a name that no
    # longer resolves. The key fingerprints their source and not this package,
    # so a cogbench upgrade that changes what a binding holds meets an entry
    # whose key still matches and whose fields no longer parse. Raising here
    # would tell a student their repository could not be read, over our cache.
    try:
        arrangement = int(stored.get("arrangement", 0))
        attempts_tried = int(stored.get("attemptsTried", 0))
        form = forms[int(stored.get("form") or 0)] if forms else ()
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    names = identities_for(identities, form)

    # A week with no database: the chain is the whole binding.
    if arrangement < 0:
        by_label = _by_label(found)
        try:
            steps = _retuned(by_label, stored, pool, names)
        except (KeyError, TypeError):
            return None
        from .pipeline import Binding

        chain = Binding(
            chain_role.name,
            steps,
            _stage_names=tuple(stage.name for stage in chain_role.stages),
            _received=tuple("" for _ in steps),
            _returned=tuple("" for _ in steps),
        )
        recalled = Submission(
            _scored_placeholder(chain),
            discovery=found,
            chain=steps,
            recalled=True,
            **(again or {}),
        )
        # A remembered chain is run like a searched one, so it goes back on a
        # reading of its own rather than on the lookup's namespace. A binding
        # that cannot be put back is a miss: the search is the honest answer,
        # not a replay over the modules the lookup happened to import.
        try:
            return recalled.fresh()
        except Unmapped:
            return None

    by_label = _by_label(found)

    try:
        steps = _retuned(by_label, stored, pool, names)
        store = by_label[stored["enroll"]]
        ask = by_label[stored["query"]]
        index = int(stored["arrangement"])
        factory = by_label[stored["factory"]] if stored.get("factory") else None
        readers = tuple(by_label[label] for label in stored.get("readers") or ())
    except (KeyError, TypeError, ValueError):
        return None

    shape = _Shape(factory, readers, bool(stored.get("state")), stored.get("stateAttribute"))
    if arrangements is None:
        return None

    from .pipeline import Binding

    chain = Binding(
        chain_role.name,
        steps,
        _stage_names=tuple(stage.name for stage in chain_role.stages),
        _received=tuple("" for _ in steps),
        _returned=tuple("" for _ in steps),
    )
    # Construct on first use, as on a cold result. A construction failure is
    # NoDatabase in the caller's directory, not a cache miss in our scratch dir.
    remembered = Submission(
        _scored_placeholder(chain),
        discovery=found,
        chain=steps,
        attempt=Attempt(store.label, ask.label, index),
        attempts_tried=attempts_tried,
        recalled=True,
        _store=store,
        _ask=ask,
        _arrange=arrangements,
        _factory=factory,
        _readers=readers,
        _state=shape.state,
        _state_attribute=shape.state_attribute,
        **(again or {}),
    )
    try:
        return remembered.fresh()
    except Unmapped:
        return None


def _by_label(found: Discovery) -> Dict[str, Candidate]:
    """Every candidate a stored name could refer to, by that name.

    Constructors are here for the same reason the chain search has them: a
    class that demands its data up front is a step, and a binding that names
    one has to find it again. Its methods are not, because an object built
    from a stage's inputs does not exist until that stage has run, which is
    why a binding with branches is searched again instead.
    """

    by_label = {c.label: c for c in callables_in(found.namespace)}
    by_label.update({c.label: c for c in constructors_in(found.namespace)})
    for label, instance in instances_in(found.namespace):
        by_label.update({c.label: c for c in methods_of(label, instance)})
    return by_label


def _retuned(
    by_label: Dict[str, Candidate],
    stored: Dict[str, Any],
    pool: Optional[Dict[str, Any]] = None,
    identities: Sequence[Any] = (),
) -> Tuple[Candidate, ...]:
    """The remembered chain, each step carrying how it was called.

    An entry that does not say how a step was called is refused (`KeyError`)
    and sent back through the search. A side input is looked up again by name
    in the pool the caller passed, because the value is the benchmark's own
    resource and never belongs in a cache file.
    """

    labels = stored["chain"]
    tunings = _aligned(stored, "tunings", labels)
    in_place = _aligned(stored, "inPlace", labels)
    plans = _aligned(stored, "plans", labels)
    keywords = _aligned(stored, "keywords", labels)
    keyword_plans = _aligned(stored, "keywordPlans", labels)
    per_item = _aligned(stored, "perItem", labels)
    elements = _aligned(stored, "elements", labels)
    self_only = _aligned(stored, "selfOnly", labels)
    handoffs = _aligned(stored, "handoffs", labels)
    pool = dict(pool or {})

    steps = []
    for index, label in enumerate(labels):
        plan = tuple(str(slot) for slot in plans[index])
        by_keyword = _pairs(keyword_plans[index])
        supplied: Dict[str, Any] = {}
        # Both kinds of slot are filled the same way, because `_slot_value`
        # reads them the same way. Only `extra:<name>` is a pool lookup: a
        # tuning is on the step, and the identity slot is this run's items
        # rather than the search's, so neither is stored or looked up.
        for slot in plan + tuple(slot for _name, slot in by_keyword):
            if slot == "identity":
                supplied["identity"] = tuple(identities)
            elif slot.startswith("extra:"):
                name = slot[len("extra:"):]
                supplied[name] = pool[name]
        for name in keywords[index]:
            supplied[str(name)] = pool[str(name)]
        steps.append(
            replace(
                by_label[label],
                tuning=tunings[index],
                in_place=bool(in_place[index]),
                plan=plan,
                keywords=tuple(str(name) for name in keywords[index]),
                keyword_plan=by_keyword,
                supplied=supplied,
                per_item=bool(per_item[index]),
                element=elements[index],
                self_only=bool(self_only[index]),
                handoff=handoffs[index] or None,
            )
        )
    if steps:
        steps[0] = replace(steps[0], form=stored.get("form"))
    return tuple(steps)


def _pairs(recorded: Any) -> Tuple[Tuple[str, str], ...]:
    """One step's keyword arguments, as the parameter and the slot filling it.

    A record is JSON, so a pair comes back as a two-element list. Anything
    that is not a parameter and a slot is a record this version cannot read,
    and reading it loosely would call their function with a keyword argument
    the search never passed. `TypeError` is what `_replay` already treats as
    a miss, which sends the binding back through the search.
    """

    found: List[Tuple[str, str]] = []
    if isinstance(recorded, (str, bytes)) or not isinstance(recorded, _SequenceABC):
        raise TypeError("a step's keyword plan is not a list of pairs")
    for pair in recorded:
        if (
            isinstance(pair, (str, bytes))
            or not isinstance(pair, _SequenceABC)
            or len(pair) != 2
        ):
            raise TypeError("a keyword argument is not a parameter and a slot")
        name, slot = pair
        if not isinstance(name, str) or not isinstance(slot, str):
            raise TypeError("a keyword argument names something that is not a name")
        found.append((name, slot))
    return tuple(found)


def _aligned(stored: Dict[str, Any], name: str, labels: Sequence[Any]) -> List[Any]:
    """One entry per step, or refuse the record.

    An entry that does not say how every step was called cannot be replayed
    into the same calls, and a chain replayed differently is a different
    program. Refusing sends it back through the search.
    """

    values = stored.get(name)
    if values is None or len(values) != len(labels):
        raise KeyError(name)
    return list(values)


def _scored_placeholder(chain) -> Verdict:
    """Resolution succeeded; the benchmark supplies the real verdict.

    Kept plain: what the code is worth is the scorer's sentence to write, not
    discovery's.
    """

    from .verdict import SCORED, Verdict as _Verdict

    return _Verdict(
        SCORED,
        "Your code is wired up and ready to score.",
        chain.observations(),
    )


def _store_candidates(found: Discovery, steps: Sequence[Candidate]) -> List[Candidate]:
    """Everything that could be a database, minus the pipeline already bound.

    Module functions first, then the methods of any class the team wrote that
    builds with no arguments. The chain's own steps are excluded: a
    fingerprinter is not a database, and trying it as one wastes attempts on
    a pairing that cannot work.
    """

    used = {step.label for step in steps}
    # Methods are excluded by the class they came off and the attribute they
    # are, not by their label: the same method is named
    # `audio.Engine().find_peaks` when `instances_in` built the object and
    # `audio.Engine.find_peaks` when a constructor stage did, so matching
    # strings filters one spelling and misses the other.
    used_methods = {
        (step.owner, step.attribute)
        for step in steps
        if step.owner is not None and step.attribute is not None
    }
    candidates = [c for c in callables_in(found.namespace) if c.label not in used]
    for label, instance in instances_in(found.namespace):
        # A team whose peak finder is a method on the same class as their
        # store had that method offered back as a database, spending attempts
        # proving a fingerprinter cannot store a song. Attempts are the scarce
        # thing here: one corpus repository resolves at 3,962 of them.
        candidates.extend(
            c
            for c in methods_of(label, instance)
            if c.label not in used and (c.owner, c.attribute) not in used_methods
        )
    return candidates


def _graded_packages(benchmark: str) -> FrozenSet[str]:
    """Import names the graded run installs for this benchmark.

    Read from `cogbench.environment`, which restates the versions the
    images install rather than keeping a second list here. It used
    to be a hand-maintained global frozenset named COURSE_PACKAGES, and being
    global was the bug: it drove the message "the graded run has it", which
    cannot be true of all three tracks at once. Checked against the images,
    most of its entries were wrong somewhere. `nltk` is prescribed for Week 3
    and installed by no image, so a Week 3 student was told the graded run had
    a package it does not. `torch` and `cv2` are Week 2 only, `librosa` is
    Week 1 only, and `ipython`, `jupyter`, `opencv`, and `scikit-learn` could
    never match anything, being lowercase or distribution-name spellings of
    import names.

    An unknown benchmark yields an empty set, so the advice falls back to
    "declare it", which is the safe direction: telling a student to add a
    package to their requirements.txt costs them a line, while telling them
    the graded run already has it costs them the run.
    """

    from .environment import student_modules, track_for

    track = track_for(benchmark)
    return student_modules(track) if track else frozenset()


def _local_gap(missing: Optional[str], benchmark: str = "") -> str:
    """What to say when the missing package is one this track's image carries.

    Their code is fine and the graded run has this package, so the step is to
    install it here, not to declare it.
    """

    if not missing:
        return ""
    top = missing.split(".")[0]
    if top not in _graded_packages(benchmark):
        return ""
    return (
        "{} is part of the environment the course has you install, and the "
        "graded run has it. This machine does not, so install it here and run "
        "this again."
    ).format(top)


def _next_step_for(reason: str, missing: Optional[str], benchmark: str = "") -> str:
    """The one thing worth doing about an import that failed.

    Named only where the platform honestly knows it. A missing package is ours
    to name; a module that raises is theirs to read, and pretending otherwise
    would be guessing at their code.

    ``benchmark`` decides which image's package list the missing name is
    checked against, since the advice inverts between the two cases: install it
    here, or declare it so the graded run gets it.
    """

    if reason == "missing_dependency" and missing:
        return _local_gap(missing, benchmark) or (
            "Add {} to a requirements.txt at the root of your repository, or move "
            "the code the benchmark needs into a module that does not import it."
        ).format(missing)
    if reason == "syntax":
        return "Fix the syntax error above, then push again."
    return ""


def _step_note(stage: str, label: str):
    """A step the search reached, for a refusal that stalled after it."""

    from .verdict import Observation

    return Observation(stage, label, "", "")


def _next_step_for_stall(found: Discovery, benchmark: str = "") -> str:
    """The one thing worth doing when the chain stalled part way.

    Only when the platform honestly knows it. A module the search could not
    read is a real lead and worth naming, because the function it wanted may
    well be in there. When every module read cleanly, the missing piece is a
    function that does not exist yet or returns something nothing takes, and
    which of those it is belongs to the student.
    """

    missing = sorted(
        {entry.missing for entry in found.skipped if entry.missing},
    )
    if not missing:
        return ""

    modules = [entry.name for entry in found.skipped if entry.missing]
    opening = "{} did not import, because {} not installed here.".format(
        _listed(modules),
        "{} is".format(missing[0]) if len(missing) == 1 else "{} are".format(_listed(missing)),
    )

    # Split the two cases, because they call for opposite things. A package
    # this track's image carries is missing from this laptop and present in
    # the graded run, so the fix is to install it. Anything else is theirs to
    # declare. Per track, not global; see `_graded_packages`.
    graded = _graded_packages(benchmark)
    local = [name for name in missing if name.split(".")[0] in graded]
    theirs = [name for name in missing if name.split(".")[0] not in graded]

    advice = []
    if local:
        advice.append(
            "{} part of the environment the course has you install, and the "
            "graded run has {}. Install {} here and run this again.".format(
                "{} is".format(_listed(local)) if len(local) == 1 else "{} are".format(_listed(local)),
                "it" if len(local) == 1 else "them",
                "it" if len(local) == 1 else "them",
            )
        )
    if theirs:
        advice.append(
            "If the function the benchmark is looking for lives in one of "
            "them, add {} to a requirements.txt at the root of your "
            "repository.".format(_listed(theirs))
        )
    return " ".join([opening] + advice)


def _listed(items: Sequence[str]) -> str:
    """A readable list: one, two and three, or one, two, and three."""

    items = list(items)
    if len(items) <= 1:
        return items[0] if items else ""
    if len(items) == 2:
        return "{} and {}".format(*items)
    return "{}, and {}".format(", ".join(items[:-1]), items[-1])
