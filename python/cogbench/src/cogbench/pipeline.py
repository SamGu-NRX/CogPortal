"""Bind a benchmark's roles to a student's functions by running them.

The alternative was a table of names per role, extended every time a team
called something new. That is a list of the implementations we happened to
think of, and it rots between cohorts. What does not rot is the task: a week 1
submission enrolls songs and identifies a clip, whatever its functions are
called, and a chain of their functions either does that or it does not.

So names are a search order and nothing else. The evidence that binds is a
call: hand a candidate the input a stage receives, see whether what comes back
is the shape the next stage takes, and keep going. A chain is accepted only
when the whole thing runs end to end and returns the right answer on cases the
benchmark made up.

Why the running matters, from the corpus. ``carti4ce.find_peaks`` accepts raw
audio samples and returns an ndarray of shape ``(440, 1)``, which passes any
"is this a peak list" check you would write. Feeding that to their own
``make_fgp`` raises ``IndexError``. Their real spectrogram through the same two
functions gives 355 peaks and 5158 fingerprints. A shape check cannot tell
those apart, and a wrong binding does not fail loudly: it returns a number, and
a number is indistinguishable from a real result.

Two rules follow, and they are the reason this file is careful rather than
clever:

**A stage's output is passed to the next stage unchanged.** Never re-scaled,
re-shaped, or re-typed. ``carti4ce.make_spectrogram`` already returns a
log-scaled array; taking a log of it again produced NaNs and zero peaks. Their
threshold is tuned to their own scaling, and anything we do in between scores
our arithmetic instead of their code.

**A stage is probed only with input a benchmark can honestly make.** Audio
samples and a rate are canonical; "a peaks array" is not, because every team
represents peaks differently. So sources are probed with fixtures and every
later stage is reached by feeding it a real upstream result.
"""

from __future__ import annotations

import contextlib
import inspect
import io
import os
import random
import re
import signal
import sys
import tempfile
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Sequence, Tuple

from .raised import Raised, message_of, where_it_raised

__all__ = [
    "Stage",
    "Role",
    "Candidate",
    "Binding",
    "Refusal",
    "Resolution",
    "callables_in",
    "instances_in",
    "methods_of",
    "Fixtures",
    "probe_sources",
    "extend",
    "resolve_chain",
    "constructors_in",
    "identities_for",
]

#: A single probe call may not exceed this. Student code that legitimately
#: takes longer than this on a five-second fixture is reported as slow rather
#: than waited on: the whole discovery budget is minutes, not hours.
CALL_TIMEOUT_SECONDS = 10

#: How many partial chains stay alive at each step. Wide enough that a repo
#: with two plausible spectrogram functions keeps both, narrow enough that
#: discovery stays linear in practice.
BEAM_WIDTH = 4

#: Words that never hold a stage, whatever else the function looks like.
_NEVER = ("test", "plot", "show", "display", "demo", "main", "visuali")

#: One word of a name, splitting on underscores and camel-case boundaries.
_WORD = re.compile(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])")


def _named_for_something_else(name: str) -> bool:
    """True when one of `_NEVER` is the start of a word in `name`.

    A word and not a substring, because `domain` contains `main`, `remainder`
    contains `main`, and `latest` contains `test`. Matching those as
    substrings dropped a team's `domain_features` from the candidate pool
    before it was ever called, and the repository was then reported as having
    no pipeline for that stage.

    The start of a word and not the whole word, because the point is to skip
    `unit_tests` and `plotting` as well as `test` and `plot`.
    """

    return any(
        word.lower().startswith(never)
        for word in _WORD.findall(name)
        for never in _NEVER
    )

#: Words in a function's own source that mean calling it reaches outside this
#: process. Probing is speculative -- most candidates are the wrong function --
#: so a candidate that records audio, opens a file dialog, or reloads a native
#: audio backend is skipped rather than called.
#:
#: The third of those is not hypothetical: probing ``slicing.split_mp3`` in one
#: audited repository loads a second copy of soxr through pydub and aborts the
#: interpreter with a nanobind duplicate-key error. That is not an exception a
#: caller can catch, which is why this is a static check before the call rather
#: than a guard around it.
_SIDE_EFFECTING = (
    "record_audio",
    "input(",
    "pydub",
    "AudioSegment",
    "sounddevice",
    "askopenfilename",
    "os.remove",
    "shutil.rmtree",
    "os.system",
    "subprocess",
)


class _Timeout(Exception):
    pass


def _raise_timeout(signum, frame):  # noqa: ARG001 - signal handler shape
    raise _Timeout()


@dataclass(frozen=True)
class Stage:
    """One step of a week's pipeline, defined by what it does, not its name.

    ``accepts`` decides whether a value is plausible input for this stage, and
    ``produces`` whether a return value is plausible output. Both are pruning
    heuristics: they cut the search, and they are allowed to be loose, because
    the end-to-end check is the only thing with authority. A stage validator
    tight enough to reject an unusual but working representation would cost a
    team its score, which is the worse error.
    """

    name: str
    #: Ordered words that make a callable worth trying first. Never a gate: a
    #: function named nothing recognizable is still probed, just later.
    prefers: Tuple[str, ...] = ()
    accepts: Optional[Callable[[Any], bool]] = None
    produces: Optional[Callable[[Any], bool]] = None
    #: How many positional arguments this stage passes.
    arity: int = 1
    #: Whether this stage's answer may be left on the value it was given
    #: rather than returned.
    #:
    #: Week 2's course text is explicit about this: `propagate_label` "should
    #: update that node's label", and `whispers` calls it repeatedly while
    #: recording how the component count changes. So their `whispers` returns
    #: diagnostics and the labels are on the graph it was handed. Reading the
    #: answer means calling one more of their functions on that same graph.
    #:
    #: When set, a stage that ran and returned something this stage does not
    #: recognize also offers the value it was given, so the next stage can
    #: read it. Nothing is inspected or reconstructed; their own function is
    #: what turns the graph back into an answer.
    in_place: bool = False

    #: Values to try for a required tuning argument the function has no
    #: default for.
    #:
    #: Week 2's course text tells students to pick a cosine-distance cutoff by
    #: eye, so their graph builders take it as a required argument. The
    #: benchmark knows what range is meaningful for its own metric and the
    #: search does not, so the benchmark says: these are the numbers worth
    #: trying. A team that defaulted theirs is unaffected, because the plain
    #: call is tried first.
    #:
    #: This is not tuning their algorithm. Whichever value binds is the one
    #: their chain then runs with, and the benchmark scores that.
    tunings: Tuple[Any, ...] = ()

    #: Whether a function that handles one item may be called once per item.
    #:
    #: Week 2's capstone document hands students one photo at a time
    #: ("image = io.imread(str(path_to_image))"), and their descriptor
    #: functions take one path and return one vector. The benchmark works on a
    #: folder. Calling a per-photo function once per photo is not a
    #: transformation of their answer; it is the loop the course wrote around
    #: it, and refusing over its absence would refuse the whole corpus.
    per_item: bool = False
    #: Whether one function may do this step and the next one together.
    #:
    #: The course names five steps and one 2026 team wrote four functions:
    #: their `identifying_peaks(samples, rate)` computes a spectrogram and
    #: finds peaks in it, returning both. That is not a missing step, it is
    #: the same work in one function, and a search that insisted on a
    #: separate spectrogram would refuse a complete pipeline.
    #:
    #: Set on the step that may be absorbed, and only where fusing is a shape
    #: real teams write. The chain is still accepted only by the end-to-end
    #: test, so allowing the shorter path costs nothing but attempts.
    fusible: bool = False

    #: Names of side inputs every call of this stage also takes, looked up in
    #: the extras pool the search carries (benchmark resources, plus whatever
    #: a `fit` stage produced).
    #:
    #: A side input is data, never arithmetic. Week 3's
    #: `embed_captions_batch(texts, glove, idfs)` needs the course's GloVe
    #: vectors and an inverse-document-frequency table; the first is a
    #: benchmark artifact and the second is what THEIR own `compute_idfs`
    #: returned. Neither is a step of their algorithm and neither can be
    #: manufactured from the stage's value.
    #:
    #: Tried in three positions, in this order: after the value, before it,
    #: and by keyword where the signature names them. Both positions are
    #: needed and neither is guessable from names. Measured on the corpus:
    #: Lashika's week 3 `embed_captions_batch(texts, glove, idfs)` takes them
    #: last, and CoggurtFilter's week 2 `detect_and_describe(model, image)`
    #: takes the FaceNet model FIRST.
    extras: Tuple[str, ...] = ()

    #: Whether this stage is computed once from its own input and handed to
    #: later stages rather than being a link in the chain.
    #:
    #: Week 3 is the case. All four repositories compute an IDF table from the
    #: whole caption corpus (`compute_idfs`, `find_idfs`, `compute_idf`) and
    #: then pass it to every call of their text embedder. That table is not a
    #: stage value: nothing downstream consumes it as its input, everything
    #: downstream takes it alongside its input. So it runs once, against
    #: `fixture`, and joins the extras pool under this stage's name.
    fit: bool = False
    #: Whether the search may go on without this fit stage when nothing in
    #: the repository computes it. A stage that binds without the extra is
    #: then offered its input alone, which `_shapes` already does for any
    #: extra absent from the pool. Measured on one 2026 repository (Asterisk
    #: week 3): the IDF weighting lives inside their `CaptionVectorizer`,
    #: nothing maps a corpus to a word-to-idf table, and their embedder takes
    #: the caption alone; a required `idfs` fit refused the whole text side
    #: before that embedder was ever called.
    optional: bool = False

    #: This stage's own input, when it has one. A `fit` stage is called with
    #: it; a branch's first stage takes it from `Role.fixture` instead.
    fixture: Any = None

    #: Whether a required argument of this stage's call may be the item's own
    #: identity: the path the benchmark handed over, or its index.
    #:
    #: Week 2's Bagel repository writes `Whispers(vectors, names, threshold)`,
    #: where `names` is one label per descriptor and exists so their node
    #: objects can say which photo they came from. The benchmark knows which
    #: photo each descriptor came from -- it is the input it just passed -- so
    #: handing that back is input, not algorithm. Only parameters whose name
    #: asks for one (`name`, `id`, `label`, `path`, `file`, `image`, `photo`)
    #: are offered it, and only after the value, the extras, and the tunings
    #: have taken their slots.
    identity: bool = False

    #: Whether a candidate that reads a folder may be handed the benchmark's
    #: own files as that folder.
    #:
    #: Off by default for two reasons, both measured rather than assumed.
    #: Detecting the read needs `sys.addaudithook`, which cannot be removed
    #: once installed and taxes every `open` in the process for the rest of
    #: its life. And a stage that declares this starts calling zero-argument
    #: candidates, which the search never does otherwise, so a week that does
    #: not want that keeps the search it has.
    folder: bool = False


@dataclass(frozen=True)
class Role:
    """A pipeline the benchmark needs: an ordered list of stages."""

    name: str
    stages: Tuple[Stage, ...]

    #: Sub-chains resolved over one shared candidate pool, one shared extras
    #: pool, and one shared set of constructed instances.
    #:
    #: Week 3 is four surfaces rather than one line: captions become vectors,
    #: descriptors become vectors, ids and descriptors become a store, and a
    #: query returns ids. They share the IDF table, the GloVe vectors, and in
    #: three of the four repositories the store object itself. A single chain
    #: cannot say that, and running four independent searches would lose the
    #: sharing, which is the whole shape of the week.
    #:
    #: When set, `stages` is empty and the verifier is handed a dict of branch
    #: name to bound chain rather than one chain.
    branches: Tuple["Role", ...] = ()

    #: This role's own first-stage input. Only read for a branch; the outer
    #: fixture is used when it is None.
    #:
    #: May be a callable ``(pool, chains) -> fixture``, evaluated at the
    #: moment the branch is resolved rather than when the role was built.
    #: Week 3 needs that in both directions: the search branch is probed with
    #: the text branch's own chain applied to the query string, and the
    #: prepare branch is offered the image branch's projected matrix as its
    #: descriptor slot. Neither value exists when the role is constructed.
    #: A callable that raises, or returns None, means this branch cannot be
    #: probed yet on this pass; the fixpoint in `_resolve_branches` comes
    #: back to it once another branch has filled the pool.
    fixture: Any = None

    #: Whether the role still resolves when this branch does not.
    #:
    #: Week 3 with no trained weights in the repository is the case. The
    #: decided policy withholds the overall and the three image-side numbers
    #: rather than zeroing them (docs/design/discovery-v2-brief.md, "Absent
    #: weights"), which only means anything if the text branch still binds.
    #: Refusing the whole role over the image half reports "your code is not
    #: wired up" to a team whose caption embedding works.
    #:
    #: A required branch that never resolves refuses the role and names
    #: itself. An optional one is recorded on the binding under `missing`
    #: and the role goes on without it.
    optional: bool = False


class _Spread(tuple):
    """A tuple to pass as several arguments rather than as one value."""


class Fixtures(tuple):
    """Several forms of one benchmark input, tried in order.

    A plain tuple stays a single argument list, so nothing that passes one
    changes behavior. This subclass says "these are alternatives", which is
    the only way to tell the two apart without a flag.
    """

    def for_chain(self, chain: Sequence[Any]) -> Any:
        """The form the first step of ``chain`` was bound with.

        A chain from a single-form search carries no index and gets the
        first form, which is the only one there was.
        """

        index = getattr(chain[0], "form", None) if chain else None
        return self[index if index is not None else 0]


@dataclass(frozen=True)
class _Partial:
    """One chain under construction, and what happened along it.

    ``stages`` is carried rather than derived, because a fused step makes the
    chain shorter than the stage list and there is no way to work out
    afterwards which function absorbed which step. Recording it as it happens
    is the only version that is right.
    """

    chain: Tuple["Candidate", ...]
    value: Any
    received: Tuple[str, ...]
    returned: Tuple[str, ...]
    stages: Tuple[str, ...]
    #: Candidates only this partial can reach: the methods of every object a
    #: constructor stage built along it. Carried per partial rather than
    #: globally because two partials may have built two different stores, and
    #: a method of one is not a step of the other's chain.
    reach: Tuple["Candidate", ...] = ()
    #: How many stages were skipped by handing their INPUT to a later step
    #: (see the forward reading in `_resolve_chain`). Weaker evidence than a
    #: stage absorbed backward, where one of their functions was seen to
    #: produce the later stage's output; counted so the final ask tries such
    #: chains after the others.
    forward: int = 0


_MISSING_RECEIVER = object()
_RUNTIME_SCOPE = object()


@dataclass(eq=False)
class _Receiver:
    """One construction's owner, even after the chain carries a projection.

    Unscoped sequential replay keeps its owner here. Inside runtime_pool the
    same handle keys _RUNTIME, so nested runs can restore the outer owner.
    """

    value: Any = field(default=_MISSING_RECEIVER, compare=False, repr=False)

    def get(self) -> Any:
        if _RUNTIME_SCOPE in _RUNTIME:
            return _RUNTIME.get(self, _MISSING_RECEIVER)
        return self.value

    def put(self, value: Any) -> None:
        if _RUNTIME_SCOPE in _RUNTIME:
            _RUNTIME[self] = value
        else:
            self.value = value


@dataclass(frozen=True)
class Candidate:
    """One callable that might serve one stage."""

    label: str
    call: Callable[..., Any]
    module: str
    #: How to get this callable again from a newly built object, when it is a
    #: method rather than a plain function. The search fills one instance with
    #: fixture songs while proving a binding works, and scoring must not start
    #: from that: the fixture would sit in the database competing with the
    #: benchmark's own catalog. Given this, a fresh object can be built and the
    #: same method taken off it.
    rebuild: Optional[Callable[[], Any]] = field(default=None, compare=False)
    #: The tuning value the search bound this step with, or None when the
    #: plain call worked. Part of the binding, not of the search: whichever
    #: cutoff made their `adj_list(paths, threshold)` run is the cutoff their
    #: chain must run with when it is scored, and when the acceptance test
    #: runs it. Measured on one 2026 repository before this existed: the
    #: search bound `adj_list` at threshold 0.3, then handed the bare
    #: candidate to the acceptance test, which called it with one argument,
    #: got `TypeError: missing 1 required positional argument`, and reported
    #: "your code ran end to end and answered a different grouping". Their
    #: code had not run at all.
    tuning: Any = None
    #: Which form of the benchmark's input this first step accepted, as an
    #: index into the `Fixtures` it was probed with, or None when there was
    #: only one form. Week 2 offers the same photos as arrays and as paths.
    #: A function that took paths was then handed arrays by the acceptance
    #: test and by the scored run, because neither knew which one had bound.
    #: Measured on two 2026 repositories: `adj_list` did `p.parent` on an
    #: ndarray, `nodes_and_adj` did `imread` on one, and both were reported
    #: as having run and answered wrongly.
    form: Optional[int] = None
    #: Whether this step left its answer on the value it was given rather
    #: than returning it, so the chain must carry that value forward past
    #: it. The search knows this at the moment it happens (the `in_place`
    #: branch of `_resolve_chain`); a run that re-executes the chain later
    #: has no other way to know.
    in_place: bool = False

    #: The exact argument list this step was called with, one slot per
    #: positional argument. ``"value"`` is the value the chain carries,
    #: ``"tuning"`` is `tuning`, ``"identity"`` is the item's own name or
    #: index, and ``"extra:<name>"`` is a side input from the extras pool.
    #:
    #: Empty means the call the search has always made: the value, then the
    #: tuning if there is one. Keeping that as its own case is deliberate --
    #: a week that declares no extras and no identity gets byte-identical
    #: calls to the ones it got before this existed.
    #:
    #: A plan rather than a closure because a binding is written down and
    #: replayed. `tuning` and `form` are here for the same reason and for the
    #: same measured failure: a step re-called differently from the way the
    #: search called it is a different program, and the report then blames
    #: the student for a call they never made.
    plan: Tuple[str, ...] = ()
    #: Extras passed by keyword instead of by position, by parameter name.
    keywords: Tuple[str, ...] = ()
    #: What the plan's named slots hold. Not compared and not stored: the
    #: values are the benchmark's own resources, sometimes hundreds of
    #: megabytes, and a replay looks them up again by name.
    supplied: Dict[str, Any] = field(default_factory=dict, compare=False, repr=False)

    #: Whether this step is one call per item of the value it is given.
    #:
    #: The search already calls a per-item function once per item to prove a
    #: binding (`_mapped`). Without recording it, the acceptance test and the
    #: scored run hand the whole collection to a function that takes one
    #: photo, which raises on its first line and is reported as their bug.
    per_item: bool = False
    #: Which element of each per-item result is this stage's output, when
    #: their function returns several things per item.
    #:
    #: Week 2's Bagel repository returns `(boxes, probabilities, descriptors)`
    #: per photo. The descriptors are element 2, and gathering them is not a
    #: transformation of their answer: it is reading the part of what they
    #: returned that the next step takes, which is what `_handoffs` already
    #: does for a single return value.
    element: Optional[int] = None
    #: Whether this step is a method called with no arguments at all, because
    #: the value the chain carries is the object it is bound to. Week 2's
    #: Bagel `Whispers.create_matrix()` is this shape.
    self_only: bool = False
    #: The attribute name this candidate is, when it was taken off one of
    #: their objects, and the class it was taken off. Both are needed to take
    #: the same method off a DIFFERENT object of that class later; see
    #: `_rebound`. Neither is part of what a binding is, so neither is
    #: compared: `label` already says which method this is.
    attribute: Optional[str] = field(default=None, compare=False)
    owner: Optional[type] = field(default=None, compare=False, repr=False)
    #: The branch whose chain built the object this method is taken off,
    #: when the method is used from a DIFFERENT branch. A scored run builds
    #: that object again under this name (see `runtime_pool`), and the
    #: method has to be re-taken off the new one; the search-time object
    #: holds the fixture. Set by `_resolve_branches` as it carries methods
    #: forward; None for every method used inside its own chain.
    branch: Optional[str] = field(default=None, compare=False)
    #: Shared only by one constructor extension and its reached methods.
    #: Runtime ownership is not binding evidence or part of its record.
    receiver: Optional[_Receiver] = field(default=None, compare=False, repr=False)

    #: Which reading of the upstream value this step was called with, when
    #: the search took the value apart before handing it over: None for the
    #: whole value, "spread" for a tuple passed as several arguments,
    #: "reversed" for a two-tuple passed the other way round, and
    #: "element:<k>" for one part of it. The readings are `_handoffs`, and
    #: nothing here transforms a value: it is passed exactly as it was
    #: returned, or exactly one part of it is.
    #:
    #: Recorded for the same reason as `tuning`, `form`, and `in_place`. The
    #: search knows which reading bound at the moment it binds, and a run
    #: that re-executes the chain later has nothing to work it out from:
    #: rutvim's week 1 `spectrogram_conversion` returns `(log_spectrogram,
    #: peaks)` and their `generate_fingerprints` accepts either, returning
    #: 609 fingerprints and scoring 0.547 on the peaks and 2970 and 0.094 on
    #: the spectrogram (benchmarks/week1/tests/test_discovered_chain.py,
    #: `WhichPartOfATupleTheNextStepIsHanded`). Both readings run, so the
    #: difference is a score rather than an error.
    handoff: Optional[str] = None

    #: A lazy runtime mapper receives the original arguments and applies this
    #: recorded call plan once, after resolving the callable in its namespace.
    _runtime_call: Optional[Callable[..., Any]] = field(
        default=None, compare=False, repr=False,
    )

    @property
    def bound(self) -> Callable[..., Any]:
        """The callable, called the way the search called it.

        One code path for the search, the acceptance test, and the scored
        run. Every field above exists because those three drifted apart once
        and a chain that had been proved raised on its first call.
        """

        if self._runtime_call is not None:
            return self._runtime_call
        if (
            self.tuning is None
            and not self.plan
            and not self.keywords
            and not self.per_item
            and self.element is None
            and not self.self_only
            and self.handoff is None
            and self.attribute is None
            and not self.in_place
            and self.receiver is None
        ):
            return self.call
        return lambda *args: _invoke(self, args)

    def with_plan(
        self,
        plan: Sequence[str],
        supplied: Optional[Dict[str, Any]] = None,
        keywords: Sequence[str] = (),
    ) -> "Candidate":
        """The same candidate called a different way.

        What was already on `supplied` is kept underneath. A candidate that
        is itself one of the benchmark's own objects (see `_from_pool`)
        carries the note saying so, and building a shape out of it must not
        drop that note: it is the only record that the step the chain ran
        was not one of their functions.
        """

        merged = dict(self.supplied)
        merged.update(supplied or {})
        return replace(
            self,
            plan=tuple(plan),
            keywords=tuple(keywords),
            supplied=merged,
        )


#: Values that replace a step's remembered side inputs for the duration of one
#: run. Set by a week's discovered adapter before it runs a chain, so a step
#: whose extra was another branch's output takes THIS run's output rather
#: than the search fixture's. Measured before this existed: a prepare step
#: bound with supplied={"image": <fixture rows>} built the scored database
#: from the fixture's projected descriptors, not the run's.
_RUNTIME: Dict[Any, Any] = {}


@contextlib.contextmanager
def runtime_pool(values: Dict[Any, Any]):
    """Make ``values`` the live side inputs for every step called inside."""

    previous = dict(_RUNTIME)
    _RUNTIME.update(values)
    _RUNTIME[_RUNTIME_SCOPE] = True
    try:
        yield
    finally:
        _RUNTIME.clear()
        _RUNTIME.update(previous)


def _supplied_now(candidate: Candidate, name: str) -> Any:
    if name in _RUNTIME:
        return _RUNTIME[name]
    return candidate.supplied[name]


def _arguments(candidate: Candidate, positional: Sequence[Any], index: Optional[int] = None):
    """The exact positional arguments and keywords one call is made with.

    ``index`` names which item of a per-item call this is, so the identity
    slot holds that item's own name rather than the whole list. Their
    descriptor function takes one photo and one photo's name; the stage that
    builds a graph takes every descriptor and every name.
    """

    if not candidate.plan:
        args = tuple(positional)
        if candidate.tuning is not None:
            args = args + (candidate.tuning,)
        return args, {}

    values = list(positional)
    args: List[Any] = []
    for slot in candidate.plan:
        if slot == "value":
            if not values:
                raise TypeError("the plan asks for more values than there are")
            args.append(values.pop(0))
        elif slot == "tuning":
            args.append(candidate.tuning)
        elif slot == "identity":
            # This run's items, not the search's. The identity slot holds the
            # names of the photos the benchmark is passing, and the search
            # bound it on the fixture's copies; a scored run writes its own
            # and then reads the answer back by those names. Measured on week
            # 2's Bagel repository, whose `Whispers(vectors, names, threshold)`
            # stores each name on its node and whose `sorted_images` returns
            # the groups keyed by them: replaying the search's names made
            # every group name a photo this run had never seen, and placing
            # the answer raised instead of scoring.
            identities = (
                _RUNTIME["identity"]
                if "identity" in _RUNTIME
                else candidate.supplied.get("identity", ())
            )
            args.append(identities[index] if index is not None else list(identities))
        elif slot.startswith("extra:"):
            args.append(_supplied_now(candidate, slot[len("extra:"):]))
        else:  # pragma: no cover - a plan is built here and nowhere else
            raise TypeError("unknown argument slot {!r}".format(slot))
    keywords = {name: _supplied_now(candidate, name) for name in candidate.keywords}
    return tuple(args), keywords


def _rebound(candidate: Candidate, positional: Sequence[Any]) -> Callable[..., Any]:
    """Take the method off its runtime owner, without mistaking query data for it."""

    if candidate.attribute is None:
        return candidate.call

    def method(held: Any) -> Optional[Callable[..., Any]]:
        if candidate.owner is not None and not isinstance(held, candidate.owner):
            return None
        later = getattr(held, candidate.attribute, None)
        return later if callable(later) else None

    # A branch may return a projection of the owner's own type. Its populated
    # construction handle still identifies the owner that ran the earlier methods.
    if candidate.receiver is not None:
        held = candidate.receiver.get()
        if held is not _MISSING_RECEIVER:
            later = method(held)
            if later is None:
                raise TypeError("{} has no valid runtime receiver".format(candidate.label))
            return later
    # A named branch can supply an owner when no explicit runtime owner exists.
    # It still takes precedence over a same-type query for legacy candidates.
    if candidate.branch is not None and candidate.branch in _RUNTIME:
        later = method(_RUNTIME[candidate.branch])
        if later is not None:
            return later
    if candidate.receiver is not None:
        raise RuntimeError(
            "{} needs its constructor to run before this method".format(candidate.label)
        )
    # Legacy candidates have no construction handle. Keep their carried-owner
    # behavior, including never treating a named branch's query as its owner.
    if candidate.branch is None and positional:
        later = method(positional[0])
        if later is not None:
            return later
    return candidate.call


def _publish(candidate: Candidate, result: Any) -> Any:
    """Remember the actual constructor result, not a reconstructed fixture."""

    if candidate.receiver is not None and isinstance(candidate.call, type):
        candidate.receiver.put(result)
    return result


def _handed(candidate: Candidate, positional: Sequence[Any]) -> Tuple[Any, ...]:
    """The upstream value read the way the search read it when this bound.

    `extend` offers a stage's value whole and then taken apart (`_handoffs`),
    and whichever reading ran is recorded on the step. This applies that same
    reading to the value a later call carries, so the acceptance test and the
    scored run make the call the search made. Nothing is transformed: the
    value is passed as it was returned, spread as the arguments it already
    is, or one of its parts is passed as it was returned.

    A value the reading cannot be applied to raises, with the reading and
    the value named. The search bound this step on a value that had this
    part; a scored run that hands it one that does not has an upstream
    whose shape changed, which is their bug to see. Falling through to the
    whole value instead, which the first draft did, silently scored a
    different call from the one the search proved: measured with a step
    bound on "element:2" and handed a pair, it was called with the pair.
    """

    if candidate.handoff is None or not positional:
        return tuple(positional)
    value = positional[0]
    rest = tuple(positional[1:])
    try:
        # These readings were discovered on a tuple and mean nothing on
        # anything else. A list would spread and a string would index, and
        # either is a call the search never proved.
        if candidate.handoff in ("spread", "reversed") and not isinstance(value, tuple):
            raise TypeError("not a tuple")
        if candidate.handoff == "spread":
            return tuple(value) + rest
        if candidate.handoff == "reversed":
            return (value[1], value[0]) + rest
        if candidate.handoff.startswith("element:"):
            if not isinstance(value, tuple):
                raise TypeError("not a tuple")
            return (value[int(candidate.handoff[len("element:"):])],) + rest
    except (TypeError, IndexError, KeyError, ValueError) as error:
        raise TypeError(
            "{} was bound on {} of what the step before it returned, and this "
            "run's value has no such part: {}".format(
                candidate.label, candidate.handoff, type(error).__name__
            )
        ) from error
    return tuple(positional)


def _invoke(candidate: Candidate, positional: Sequence[Any]) -> Any:
    """Run one bound candidate on the arguments a chain hands it."""

    positional = _handed(candidate, positional)
    if candidate.self_only:
        result = _publish(candidate, _rebound(candidate, positional)())
        return _carried(candidate, positional, result)
    if candidate.per_item:
        if not positional:
            raise TypeError("a per-item step needs the items to run over")
        items = list(positional[0])
        rest = tuple(positional[1:])
        produced = []
        for index, item in enumerate(items):
            args, keywords = _arguments(candidate, (item,) + rest, index)
            call = _rebound(candidate, (item,) + rest)
            produced.append(_publish(candidate, call(*args, **keywords)))
        if candidate.in_place and all(row is None for row in produced):
            # Each item was changed where it sat; the items go forward.
            return items
        if candidate.element is not None:
            return [row[candidate.element] for row in produced]
        return produced
    args, keywords = _arguments(candidate, positional)
    return _carried(
        candidate, positional,
        _publish(candidate, _rebound(candidate, positional)(*args, **keywords)),
    )


def _carried(candidate: Candidate, positional: Sequence[Any], result: Any) -> Any:
    """What a step hands on: its result, or the object it changed in place.

    The search recorded an in-place step as answering on the object it was
    given (`extend`, the `stage.in_place` branch) and carried that object
    forward; a scored run has to carry the same thing. One helper for every
    call path, because the first version covered only the plain call and an
    independent review found the self-only and cross-branch paths handing
    the next step None.
    """

    if candidate.in_place and result is None and positional:
        return positional[0]
    return result

@dataclass(frozen=True)
class Binding:
    """A chain that ran end to end, and what it was made of."""

    role: str
    steps: Tuple[Candidate, ...]

    def describe(self) -> List[str]:
        return [
            "{} <- {}".format(stage, step.label)
            for stage, step in zip(self._stage_names, self.steps)
        ]

    def observations(self):
        """Every step that ran, with what it received and returned.

        This is the reproduction a student debugs from when the chain runs and
        answers wrongly. It is the platform's whole contribution to that case:
        it can say what ran and what came back, and it cannot say which line is
        wrong, so it says the first and stops.
        """

        from .verdict import Observation

        return tuple(
            Observation(stage, step.label, received, returned)
            for stage, step, received, returned in zip(
                self._stage_names, self.steps, self._received, self._returned
            )
        )

    #: The side inputs that were computed once and handed to later stages,
    #: as (stage name, candidate). Not chain links, and named separately so
    #: a report can say which of their functions produced each one.
    fits: Tuple[Tuple[str, Candidate], ...] = ()
    #: For a role made of branches, each branch's own bound chain. Empty for
    #: an ordinary single-chain role, which is every week before week 3.
    branches: Dict[str, Tuple[Candidate, ...]] = field(default_factory=dict)

    #: The branches this role declared optional that never resolved, by
    #: name, with the refusal each ended on. Empty for every role whose
    #: branches all bound, which is every role before week 3.
    missing: Dict[str, "Refusal"] = field(default_factory=dict)

    _stage_names: Tuple[str, ...] = field(default=(), compare=False)
    _received: Tuple[str, ...] = field(default=(), compare=False)
    _returned: Tuple[str, ...] = field(default=(), compare=False)
    #: What this chain's last step produced, kept so a later branch of the
    #: same role can be probed with it. Bagel's week 3
    #: `CaptionImageQuery(EMBEDDINGS, ids)` takes the image branch's
    #: projected matrix and Lashika's search takes the prepare branch's
    #: store; before this the value a branch produced was thrown away the
    #: moment the branch was accepted, so neither could be reached.
    #:
    #: Not part of the record and not compared: it is a live object out of
    #: their code, sometimes a large array, and two runs of the same
    #: repository are the same binding whatever it holds.
    _value: Any = field(default=None, compare=False, repr=False)
    #: The methods of every object this chain's constructor stages built.
    #: Carried out of the search so a later branch of the same role can call
    #: one; see `_resolve_branches`. Not part of the record and not compared.
    _reach: Tuple["Candidate", ...] = field(default=(), compare=False, repr=False)


@dataclass(frozen=True)
class Refusal:
    """Why nothing bound, in terms a student can act on.

    ``furthest`` is the longest chain that ran before something broke, which is
    the part of the report worth reading: it names their own functions, in
    their own order, and the exact point where the next one did not accept what
    the last one returned.
    """

    role: str
    furthest: Tuple[str, ...]
    stage: str
    detail: str
    #: What the last step that ran returned, described. Carried as its own
    #: field so a caller can put it in a sentence without parsing one.
    last_returned: str = ""
    #: Whether every stage bound and the assembled chain simply gave the wrong
    #: answer. A separate field rather than something a caller infers from
    #: `detail`, because the two refusals need opposite sentences and matching
    #: on prose is how they came to share one.
    ran_to_the_end: bool = False
    #: Anything the search learned about why nothing bound that the stage and
    #: the furthest chain do not say. A refusal names the hand-off that
    #: failed, which is the right headline and is sometimes not the reason:
    #: see `_folders_of_their_own`, where the reason is a constructor the
    #: search had to refuse three stages earlier.
    notes: Tuple[str, ...] = ()
    #: The candidates this search called that raised from inside their own
    #: code, in the order they were tried. "Nothing accepted the input" is
    #: what the search observed; these are the reasons underneath it, and on
    #: one 2026 repository the reason is a single bad import three files away
    #: from anything the headline names.
    errors: Tuple[Raised, ...] = ()


Resolution = Tuple[Optional[Binding], Optional[Refusal]]


def _reaches_outside(value: Any) -> bool:
    """Whether calling this would leave the process.

    Source is read when there is a file to read it from. A function lifted out
    of a notebook has none, and neither does anything else compiled from a
    string, so the names it references are checked too: ``__code__.co_names``
    holds every global and attribute the body mentions, which is enough to see
    ``AudioSegment`` or ``record_audio`` without running anything.
    """

    text = ""
    try:
        text = inspect.getsource(value)
    except (OSError, TypeError):
        pass
    code = getattr(value, "__code__", None)
    if code is not None:
        text += " ".join(code.co_names) + " " + " ".join(
            name for name in getattr(code, "co_consts", ()) if isinstance(name, str)
        )
    return any(word in text for word in _SIDE_EFFECTING)


def _is_probeable(name: str, value: Any, module_name: str) -> bool:
    if name.startswith("_"):
        return False
    if not callable(value) or isinstance(value, type):
        return False
    if getattr(value, "__module__", None) != module_name:
        return False
    if _named_for_something_else(name):
        return False
    return not _reaches_outside(value)


def callables_in(modules: Sequence[Any]) -> List[Candidate]:
    """Every function a stage could plausibly be, in a stable order.

    Functions the module imported from elsewhere are skipped: a team that does
    ``from scipy.ndimage import maximum_filter`` did not write a peak finder,
    and binding to scipy would score scipy.
    """

    found: List[Candidate] = []
    for module in modules:
        module_name = getattr(module, "__name__", "?")
        for name in sorted(dir(module)):
            value = getattr(module, name, None)
            if _is_probeable(name, value, module_name):
                found.append(
                    Candidate("{}.{}".format(module_name, name), value, module_name)
                )
                continue
            if isinstance(value, type) and getattr(value, "__module__", None) == module_name:
                found.extend(_namespaced_in(value, module_name, name))
    return found


def _namespaced_in(owner: type, module_name: str, class_name: str) -> List[Candidate]:
    """Plain functions a team parked inside a class, called unbound.

    A class whose functions take no `self` is a namespace, not a type: one
    2026 team keeps its whole week 1 pipeline under `class Spectogram:` and
    calls each piece as `Spectogram.match_fingerprint(fp, db, index)`.
    `methods_of` only ever exposes the bound copy, where the first argument
    is swallowed as `self`, so their matcher could take two arguments where
    it needs three and nothing in the repository answered the query. The
    first parameter not being named `self` is what separates such a
    function from a method, and every real method stays with `methods_of`.
    """

    found: List[Candidate] = []
    for name in sorted(vars(owner)):
        if name.startswith("_") or _named_for_something_else(name):
            continue
        value = vars(owner)[name]
        if isinstance(value, (staticmethod, classmethod)) or not inspect.isfunction(value):
            continue
        if getattr(value, "__module__", None) != module_name:
            continue
        try:
            parameters = list(inspect.signature(value).parameters)
        except (TypeError, ValueError):
            continue
        if not parameters or parameters[0] in ("self", "cls"):
            continue
        if _reaches_outside(value):
            continue
        found.append(
            Candidate("{}.{}.{}".format(module_name, class_name, name), value, module_name)
        )
    return found


def instances_in(modules: Sequence[Any]) -> List[Tuple[str, Any]]:
    """One live object per class the team wrote that can be built for free.

    A database is as often a class as a module. One team keeps ``add`` and
    ``query`` as module functions over a pickle; another writes
    ``AudioDatabase()`` with every argument defaulted and puts the same two
    operations on it. Both are the same answer to the same question, so a class
    that constructs with no required arguments is built once and its methods
    join the candidate list.

    Only no-required-argument constructors. A class that demands its data up
    front is not a store the benchmark can fill, and guessing what to pass it
    would be inventing the team's design rather than finding it.
    """

    built: List[Tuple[str, Any]] = []
    for module in modules:
        module_name = getattr(module, "__name__", "?")
        for name in sorted(dir(module)):
            value = getattr(module, name, None)
            if not isinstance(value, type):
                continue
            if getattr(value, "__module__", None) != module_name:
                continue
            if name.startswith("_") or _named_for_something_else(name):
                continue
            try:
                signature = inspect.signature(value)
                signature.bind()
            except (TypeError, ValueError):
                continue
            try:
                built.append(("{}.{}()".format(module_name, name), value()))
            except BaseException:  # noqa: BLE001 - a constructor may do anything
                continue
    return built


def constructors_in(modules: Sequence[Any]) -> List[Candidate]:
    """Every class the team wrote that demands its data up front.

    `instances_in` builds the classes that construct for free and is
    unchanged; this is the other half, and the two are deliberately
    separate because they answer different questions. A no-argument class is
    a container the benchmark can fill afterwards. A class with required
    arguments IS a step: the arguments are what the step takes, the instance
    is what it produces, and the only honest moment to build one is the
    moment the stage runs, with the value the previous stage returned.

    Measured on the corpus, three repositories are unreachable without this
    and all three are complete pipelines: Lashika's week 3
    `ImageDatabase(image_ids, descriptors, W)`, Bagel's week 3
    `CaptionImageQuery(embeddings, ids)`, and Bagel's week 2
    `Whispers(vectors, names, threshold)`. Under the old rule every one of
    them was skipped and their methods were never enumerated, so the search
    reported that nothing accepted the descriptors.

    Only for stage probing. `callables_in` still refuses classes, so the
    store-and-query pairing search sees exactly what it saw before.
    """

    found: List[Candidate] = []
    for module in modules:
        module_name = getattr(module, "__name__", "?")
        for name in sorted(dir(module)):
            value = getattr(module, name, None)
            if not isinstance(value, type):
                continue
            if getattr(value, "__module__", None) != module_name:
                continue
            if name.startswith("_") or _named_for_something_else(name):
                continue
            try:
                signature = inspect.signature(value)
            except (TypeError, ValueError):
                continue
            try:
                signature.bind()
            except TypeError:
                pass
            else:
                # It builds for free, so `instances_in` owns it.
                continue
            initializer = getattr(value, "__init__", None)
            if initializer is not None and _reaches_outside(initializer):
                continue
            found.append(
                Candidate("{}.{}".format(module_name, name), value, module_name)
            )
    return found


def folder_readers_in(modules: Sequence[Any]) -> List[Candidate]:
    """Every class the team wrote that builds with no arguments at all.

    `instances_in` builds these once, up front, to find a store the benchmark
    can fill; `constructors_in` leaves them alone for exactly that reason.
    Neither reaches a team who wrote their pipeline over a directory: week
    2's CoggurtFilter has `clusterCreator()`, whose `__init__` reads a folder
    of photos and describes every one of them, so the class IS the step and
    the folder is its input.

    Offered only to a stage that declared `Stage.folder`, since that is the
    stage that knows the benchmark's input can be handed over as a directory,
    and `_from_a_folder` is what decides whether the call read one.
    """

    found: List[Candidate] = []
    for module in modules:
        module_name = getattr(module, "__name__", "?")
        for name in sorted(dir(module)):
            value = getattr(module, name, None)
            if not isinstance(value, type):
                continue
            if getattr(value, "__module__", None) != module_name:
                continue
            if name.startswith("_") or _named_for_something_else(name):
                continue
            try:
                inspect.signature(value).bind()
            except (TypeError, ValueError):
                continue
            initializer = getattr(value, "__init__", None)
            if initializer is not None and _reaches_outside(initializer):
                continue
            found.append(
                Candidate("{}.{}".format(module_name, name), value, module_name)
            )
    return found


def rebuilder_for(instance: Any) -> Optional[Callable[[], Any]]:
    """A way to build another object like this one, or None.

    Only for a class that constructs with no arguments, which is the only kind
    `instances_in` builds in the first place.
    """

    owner = type(instance)

    def _build() -> Any:
        return owner()

    return _build


def methods_of(
    label: str, instance: Any, *, build: Optional[Callable[[], Any]] = None
) -> List[Candidate]:
    """The bound methods of one constructed object, as candidates.

    ``build`` makes another object like this one. It defaults to calling the
    class with no arguments, which is how `instances_in` made it. A class the
    search constructed AT a stage was given that stage's inputs, and the only
    way to build the same object again is to repeat that call, so the caller
    passes the way it did it.
    """

    found: List[Candidate] = []
    owner = type(instance)
    for name in sorted(dir(instance)):
        if name.startswith("_") or _named_for_something_else(name):
            continue
        if name not in vars(owner) and not any(name in vars(base) for base in owner.__mro__):
            continue
        if isinstance(inspect.getattr_static(instance, name, None), property):
            # Properties compute values; enumerating methods must not run them.
            continue
        try:
            value = getattr(instance, name, None)
        except BaseException:  # noqa: BLE001 - reading an attribute runs their code
            # A custom descriptor can also raise while returning a method.
            continue
        if not callable(value) or isinstance(value, type):
            continue
        if _reaches_outside(value):
            continue
        found.append(
            Candidate(
                "{}.{}".format(label, name),
                value,
                label,
                rebuild=_method_rebuilder(instance, name, build),
                attribute=name,
                owner=owner,
            )
        )
    return found


def _method_rebuilder(
    instance: Any, name: str, build: Optional[Callable[[], Any]] = None
) -> Callable[[], Any]:
    """Take the same method off a newly built object of the same class."""

    owner = type(instance)

    def _fresh() -> Any:
        return getattr(build() if build is not None else owner(), name)

    return _fresh


def _order_for(stage: Stage, candidates: Sequence[Candidate]) -> List[Candidate]:
    """Preferred names first. This changes speed, never the outcome.

    A test runs discovery with every preference emptied and requires the same
    bindings, so a name can never be the reason something resolved.
    """

    def rank(candidate: Candidate) -> Tuple[int, str]:
        short = candidate.label.rsplit(".", 1)[-1].lower()
        for index, word in enumerate(stage.prefers):
            if word in short:
                return (index, candidate.label)
        return (len(stage.prefers), candidate.label)

    return sorted(candidates, key=rank)


#: Where their code lives, for the search that is running now. Set from the
#: modules discovery loaded, because that is the one place the repository root
#: is known: this process probes from a scratch directory, so the working
#: directory says nothing about where their files are. None outside a search.
_THEIR_ROOT: Optional["Path"] = None

#: Every candidate this search called that raised from inside their own code,
#: in the order they were tried, one entry per candidate. Cleared with the
#: scratch directory.
#:
#: Resolved to a file and a line here rather than kept as exceptions: an
#: exception holds its traceback, a traceback holds its frames, and a frame
#: holds their locals, which on this corpus means spectrogram arrays staying
#: alive until the search ends.
_RAISED: List[Raised] = []


def _record_raise(candidate: Candidate, error: BaseException) -> None:
    """Write down a failure that came out of their code, and only that.

    The search calls candidates with input they may not take, so most of what
    lands here is the probe being wrong rather than their code being wrong: a
    call with the wrong arity raises TypeError from the calling frame, which
    is ours, and `where_it_raised` returns None for it. A timeout is ours too,
    since it is our clock rather than anything they wrote.

    One entry per candidate, because a stage calls the same function in
    several shapes and three lines differing only in which arguments we
    guessed say nothing a student can use. Which of those calls is kept is
    decided by whether it raised in the candidate's own file. Measured on
    rutvim's week 2 repository: `whispers.create_graph` was first offered the
    photos as arrays, which its own `jpg_to_rgb` tried to open as a path, and
    the FileNotFoundError that produced is about our probe. Offered the
    photos as paths it reaches its own line 66 and raises
    `module 'pyexpat.model' has no attribute 'detect'`, which is the bug in
    that repository. A raise it triggered in another of their files belongs
    to whichever function owns that file, and the search probes that one too.
    """

    if _THEIR_ROOT is None or isinstance(error, _Timeout):
        return
    spot = where_it_raised(error, _THEIR_ROOT)
    if spot is None:
        return
    found = Raised(
        spot[0], spot[1], candidate.label, _throwaway_paths_out(message_of(error))
    )
    for index, entry in enumerate(_RAISED):
        if entry.function != candidate.label:
            continue
        if _in_its_own_file(entry, candidate) or not _in_its_own_file(found, candidate):
            return
        _RAISED[index] = found
        return
    _RAISED.append(found)


def _in_its_own_file(entry: Raised, candidate: Candidate) -> bool:
    """Whether this raise happened in the file the candidate is defined in.

    `Candidate.module` is a module name for a plain function and the owning
    candidate's label for a method, so the file is matched against any
    segment of it rather than against the whole: `clustering.clusterCreator`
    is a class in `clustering.py`, and `model_tests.image_caption_model` is a
    module in `image_caption_model.py`.
    """

    return Path(entry.file).stem in candidate.module.split(".")


#: The throwaway directories a probe runs from and the week's fixtures live
#: in. Their names carry a fresh random suffix per run, so a message quoting
#: the path it was handed differs between two runs of the same repository.
#: Both spellings, because macOS reports the same directory as `/var/folders`
#: and `/private/var/folders` depending on who asked.
_THROWAWAY = re.compile(
    r"(?:{})[^\s'\"]*".format(
        "|".join(
            sorted(
                {
                    re.escape(str(Path(tempfile.gettempdir()))),
                    re.escape(str(Path(tempfile.gettempdir()).resolve())),
                }
            )
        )
    )
)


def _throwaway_paths_out(message: str) -> str:
    """The message with this run's temporary directories replaced.

    A verdict is compared byte for byte between two runs of the same
    repository (see `verdict.describe`), and a FileNotFoundError naming the
    scratch directory it was handed is the one thing in a message that cannot
    survive that.
    """

    return _THROWAWAY.sub("a temporary path", message)


#: How many raises a refusal carries. Five was the first number tried and it
#: hid the answer: on rutvim's week 2 repository twelve of their functions
#: raise, and the one that explains all of them (`whispers.py:66`, an
#: attribute taken off `pyexpat.model` because line 1 imports the wrong
#: `model`) is the ninth in candidate order. A repository this broken has a
#: dozen lines to report and a compiler would print all of them; the cap is
#: here to bound the block, not to choose for the reader. Under the protocol's
#: own limit of sixteen, which is what a stored refusal may carry.
_ERRORS_IN_A_REFUSAL = 12


def _raised_in_this_search() -> Tuple[Raised, ...]:
    """Everything their code raised while this search ran.

    Not scoped to the stage that refused, though that was the first thing
    tried. A stage after the first is reached by extending chains, and every
    candidate that was going to raise had already raised while the first
    stage probed it, so the per-stage slice was empty for every refusal
    except a first-stage one. Measured on week 2's CoggurtFilter, which
    stalls four stages in and reported nothing.

    One line per place, not per function: several of their functions calling
    one broken helper is one problem, and repeating it once per caller buries
    the rest.
    """

    kept: List[Raised] = []
    seen = set()
    for entry in _RAISED:
        where = (entry.file, entry.line, entry.message)
        if where in seen:
            continue
        seen.add(where)
        kept.append(entry)
        if len(kept) == _ERRORS_IN_A_REFUSAL:
            break
    return tuple(kept)


def _their_root(modules: Sequence[Any]) -> Optional["Path"]:
    """The directory holding the modules discovery read, or None.

    The common parent of their files. A repository that keeps a matcher at
    its root and descriptors under `core/` gives the root; one whose code all
    sits in `Week2/` gives `Week2/`, which is what a student would type.
    """

    folders = []
    for module in modules:
        where = getattr(module, "__file__", None)
        if not where:
            continue
        try:
            folders.append(str(Path(where).resolve().parent))
        except (OSError, ValueError):
            continue
    if not folders:
        return None
    return Path(os.path.commonpath(folders))


def _call(
    candidate: Candidate, positional: Sequence[Any], index: Optional[int] = None
) -> Tuple[bool, Any]:
    """Call one candidate under a clock. Any failure is just a no.

    ``positional`` is what the chain carries: the value, or the arguments a
    fixture is made of. Everything else the call needs -- the tuning, the
    side inputs, the item's identity -- is on the candidate as a plan, and is
    filled in here so that this call and the one a scored run makes later are
    produced by the same three lines.

    A no is still a no. What changes is that a no caused by their own code
    raising is written down first: see `_record_raise`. The search does not
    read it, and a refusal does.
    """

    if candidate.self_only:
        args, keywords = (), {}
    else:
        try:
            args, keywords = _arguments(candidate, positional, index)
        except (TypeError, KeyError, IndexError):
            return False, None
    try:
        inspect.signature(candidate.call).bind(*args, **keywords)
    except (TypeError, ValueError):
        return False, None
    # Windows has no SIGALRM. There the per-call clock is not enforced and
    # a probe that hangs is caught only by the whole-of-discovery wall clock
    # in `run_isolated`, which Windows also lacks; the CLI already says
    # discovery is not isolated there. Guarding here keeps the module
    # importable and the search running on the platforms it can run on.
    alarm = hasattr(signal, "SIGALRM")
    previous = signal.signal(signal.SIGALRM, _raise_timeout) if alarm else None
    if alarm:
        signal.alarm(CALL_TIMEOUT_SECONDS)
    try:
        # The alarm is cancelled inside the guarded block, not in the outer
        # `finally`. A call that returns just as the clock runs out has the
        # alarm land between the return and the cancel; when the cancel sat
        # in `finally`, that was outside the `except`, and the `_Timeout`
        # left this function and ended the whole search. Measured on one
        # 2026 repository whose constructor probe took ten seconds.
        try:
            with _muted():
                result = _publish(candidate, _rebound(candidate, positional)(*args, **keywords))
        finally:
            if alarm:
                signal.alarm(0)
    except BaseException as error:  # noqa: BLE001 - student code raises anything
        _record_raise(candidate, error)
        return False, None
    finally:
        if alarm:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
    return True, result


class _DiscardedOutput(io.StringIO):
    def write(self, text):
        if self.closed:
            raise ValueError("I/O operation on closed file")
        return len(text)


@contextlib.contextmanager
def _muted():
    """Probe without the student's console.

    Their functions narrate: one prints every fingerprint it built, which is
    thousands of lines per call and tens of thousands across a search. Their
    output belongs to their run, not to ours, so probing discards it without
    retaining it in memory. What a student sees is the report, which says what was
    tried and what came back.
    """

    saved_out, saved_err = sys.stdout, sys.stderr
    # Opening devnull here would be mistaken for a student read by _watching.
    with _DiscardedOutput() as out, _DiscardedOutput() as err:
        sys.stdout, sys.stderr = out, err
        try:
            yield
        finally:
            sys.stdout, sys.stderr = saved_out, saved_err


def probe_sources(
    stage: Stage,
    candidates: Sequence[Candidate],
    fixture: Sequence[Any],
    *,
    extras: Optional[Dict[str, Any]] = None,
    identities: Sequence[Any] = (),
    skip_forms: FrozenSet[int] = frozenset(),
) -> List[Tuple[Candidate, Any]]:
    """Which candidates accept the benchmark's own input and return something.

    Only the first stage of a role is probed this way, because only the first
    stage has an input the benchmark can honestly manufacture. Everything after
    it is reached by ``extend``.

    ``extras`` is the pool of side inputs a stage may declare (see
    ``Stage.extras``); ``identities`` names the items the benchmark is passing
    (see ``Stage.identity``). Both default to nothing, which is the search as
    it was.
    """

    accepted: List[Tuple[Candidate, Any]] = []
    # A benchmark may offer its input in more than one form. Week 2's photos
    # are arrays, and the capstone document tells students to write a function
    # taking image paths, so all three audited teams did. The same photos
    # either way; which form their function takes is theirs to decide, and
    # refusing the one the course taught would be our contract failing them.
    forms = fixture if isinstance(fixture, Fixtures) else (fixture,)
    pool = dict(extras or {})
    for candidate in _order_for(stage, candidates) + _from_pool(stage, pool):
        bound: Optional[Candidate] = None
        value: Any = None
        which = None
        for index, form in enumerate(forms):
            if index in skip_forms:
                # Ruled out by the caller: a branch bound on this form and a
                # later branch then found nothing to call (see the form
                # backtracking in `_resolve_branches`).
                continue
            bound, value = _bind_one(
                stage, candidate, tuple(form), pool, identities_for(identities, form)
            )
            if bound is not None:
                which = index if isinstance(fixture, Fixtures) else None
                break
        if bound is None:
            continue
        # The same reading `extend` applies downstream. One team's first
        # function returns `(peaks, freqs, times, spectrogram)`, so requiring
        # the whole return value to look like a spectrogram refused a
        # function that had plainly done the work.
        if stage.produces is None or _safe_produces(stage, value):
            accepted.append((replace(bound, form=which), value))
    return accepted


def _from_pool(stage: Stage, pool: Dict[str, Any]) -> List[Candidate]:
    """The side inputs this stage declared that are themselves callable.

    A side input is usually data. Bagel's week 3 image encoder is not: it is
    `ImageToCaption()`, built with no arguments, handed their own pickle
    through `.load(path)`, and then called. The object is theirs and the
    weights inside it are theirs; the only thing the benchmark supplied is
    the path. Nothing in the repository can serve that stage, because
    `methods_of` skips `__call__` along with every other underscore name and
    the loaded instance lives in the pool rather than in a module.

    Offered after every candidate the repository itself provides, so one of
    their functions always wins where one exists, and recorded as supplied so
    a run page can say the step was not one of their own functions.
    """

    found: List[Candidate] = []
    for name in stage.extras:
        value = pool.get(name)
        if value is None or not callable(value):
            continue
        label = "{} ({})".format(name, type(value).__name__)
        found.append(
            Candidate(
                label,
                value,
                name,
                supplied={
                    name: "{} handed to the chain as this step".format(label),
                    "pooled": name,
                },
            )
        )
    return found


def identities_for(identities: Sequence[Any], form: Sequence[Any]) -> Sequence[Any]:
    """The identity of each item the benchmark is passing, for this form.

    Given by the caller when it knows (the week hands over photo paths).
    Otherwise read off the input itself: a sequence of paths or strings
    identifies its items by name, anything else by position. Both are things
    the benchmark already knows about its own input, which is why offering
    one is input rather than an answer.
    """

    if identities:
        return tuple(identities)
    if not form:
        return ()
    items = form[0]
    if isinstance(items, (str, bytes)):
        return ()
    try:
        length = len(items)
    except TypeError:
        return ()
    if length == 0:
        return ()
    from pathlib import Path as _Path

    if all(isinstance(item, (str, _Path)) for item in items):
        return tuple(str(item) for item in items)
    return tuple(range(length))


def _bind_one(
    stage: Stage,
    candidate: Candidate,
    positional: Sequence[Any],
    pool: Dict[str, Any],
    identities: Sequence[Any],
    *,
    spread: bool = False,
) -> Tuple[Optional[Candidate], Any]:
    """The first way of calling this candidate that returns something.

    The order is the one the search has always used -- the plain call, then
    once per item, then the benchmark's tunings -- with the declared side
    inputs and the identity slot tried in between: after the plain call, so a
    team who needs none is unaffected, and before the tunings, so a required
    resource is not mistaken for a cutoff.
    """

    if isinstance(candidate.call, type):
        candidate = replace(candidate, receiver=_Receiver())
    if stage.folder:
        found = _from_a_folder(stage, candidate, positional)
        if found is not None:
            bound, value = found
            _publish(bound, value)
            return found
    shapes = _shapes(stage, candidate, len(positional), pool, identities)
    for shape in shapes:
        if "tuning" in shape.plan:
            # This shape reserved a slot for one of the benchmark's values,
            # so calling it before choosing one passes None into a required
            # argument. Their function may well accept None and return
            # something plausible, which is a binding that ran on a value
            # nobody chose.
            continue
        ok, value = _call(shape, positional)
        if ok and value is not None:
            if (
                not stage.per_item
                or spread
                or stage.produces is None
                or _safe_produces(stage, value)
            ):
                return shape, value
            # Their function took the whole list and answered, but not with
            # this stage's output. One 2026 tokenizer walks its argument
            # character by character, so handed 75 captions it treated each
            # caption as a character, joined them, and returned one flat
            # token list; the per-item form was never tried because the
            # whole call had "succeeded", and the branch refused. The
            # per-item form is tried before the whole answer is kept, and
            # kept only when it looks like this stage's output.
            ok, produced = _mapped(shape, positional)
            if ok and produced:
                element, offered = _pick_element(stage, produced)
                if _safe_produces(stage, offered):
                    return replace(shape, per_item=True, element=element), offered
            # Neither reading looks like this stage's output; the next
            # shape (side inputs, keywords, identity) may. Returning the
            # wrong whole answer here ended the candidate: a tokenizer that
            # returns nothing without its table never reached the shape
            # that supplies it.
            continue
        if stage.per_item and not spread:
            ok, produced = _mapped(shape, positional)
            if ok and produced:
                element, offered = _pick_element(stage, produced)
                # A failed whole call can also map to the wrong output.
                # Keep trying shapes so a declared side input can supply it.
                if _safe_produces(stage, offered):
                    return replace(shape, per_item=True, element=element), offered
    for shape in shapes:
        for tuning in stage.tunings:
            trial = _tuned(shape, tuning)
            ok, value = _call(trial, positional)
            if ok and value is not None:
                return trial, value
    return None, None


#: How many branch attempts a form search may make in one role. A guard for
#: a role with many multi-form branches, set with no evidence of being
#: reached: week 3 has one four-form branch and every other week has one
#: form per branch.
_FORM_ATTEMPTS = 32

#: Where a folder read is recorded while one dry probe runs, or None when
#: nothing is being watched. A module global because `sys.addaudithook` takes
#: a plain function and cannot be uninstalled: the hook is added at most once
#: per process and does nothing at all unless a probe is listening.
_WATCHED: Optional[List[str]] = None
_HOOK_INSTALLED = False

#: The throwaway directory the current search is probing from, and the only
#: directory anything here may write into. None outside a search.
_SCRATCH: Optional["Path"] = None

#: What one zero-argument constructor read and returned when dry-called
#: during this search, by constructor and fixture files. Cleared with the
#: scratch directory, because the answer is about files that live there.
#: The last entry is the folder of their own the call read instead of ours,
#: when it read one; see `_folder_of_their_own`.
_DRY_CALLS: Dict[
    Tuple[int, Tuple[str, ...]], Tuple[Optional[str], bool, Any, Optional[str]]
] = {}

#: The zero-argument constructors that answered out of a folder of their own,
#: by label, and the folder each one read. A refusal turns these into the one
#: sentence that says why a repository whose whole pipeline hangs off such a
#: constructor could not be wired up. Cleared with `_DRY_CALLS`.
_FOLDER_OF_THEIR_OWN: Dict[str, str] = {}

#: The audit events that mean "this code is reading a directory". `open` is
#: here because a folder read often ends in one, and its argument is what
#: names the folder.
_FOLDER_EVENTS = ("os.listdir", "os.scandir", "glob.glob", "pathlib.Path.glob", "open")


def _audit(event: str, arguments) -> None:  # pragma: no cover - process-wide hook
    if _WATCHED is None or event not in _FOLDER_EVENTS or not arguments:
        return
    try:
        _WATCHED.append(str(arguments[0]))
    except Exception:  # noqa: BLE001 - an audit hook must never raise
        pass


@contextlib.contextmanager
def _watching():
    """Record what one call reads, for the length of that call."""

    global _WATCHED, _HOOK_INSTALLED
    if not _HOOK_INSTALLED:
        sys.addaudithook(_audit)
        _HOOK_INSTALLED = True
    seen: List[str] = []
    _WATCHED = seen
    try:
        yield seen
    finally:
        _WATCHED = None


def _from_a_folder(
    stage: Stage, candidate: Candidate, positional: Sequence[Any]
) -> Optional[Tuple[Candidate, Any]]:
    """Hand a zero-argument step the benchmark's files as the folder it reads.

    Some teams wrote a pipeline over a folder rather than over arguments:
    their constructor takes nothing, reads a directory, and describes every
    photo in it. That is not a missing function, it is a different interface
    to the same work, and the honest answer is to give them a folder. The
    photos are the benchmark's own, which is input in exactly the sense the
    week 2 fixture already is when it writes the same photos out as paths.

    Nothing is guessed. The call is made once; if it raises, the audit hook
    says which directory it was reading; and the files are written under that
    directory's own name in the scratch working directory, which is the only
    place this ever writes.

    Two limits, both deliberate. A call that succeeds while reading a
    directory outside the scratch one answered about somebody else's data,
    so it is refused rather than bound: measured on one 2026 repository,
    `clusterCreator()` resolves `baseImages` from `Path(__file__)` and
    describes the 34 photos of their own team, and binding that would score
    their answer about their photos as if it were an answer about ours. And
    that same shape is not rescued either, because the folder their code
    computes is inside their checkout and writing there is not something a
    benchmark may do. Both cases end in a refusal that names the stage.
    """

    if _required_parameters(candidate.call) != []:
        return None
    files = _files_in(positional)
    if not files:
        return None
    # One dry call per constructor per search. The call is what decides
    # whether the class reads a folder, and its answer does not change
    # between the fixture forms or the stages that ask. Measured on one
    # 2026 repository: `clusterCreator()` builds a FaceNet model and
    # describes their own 34 photos on every call, about four seconds, and
    # was called once per form per folder-declaring stage, which is what
    # put that repository past the ten-minute budget.
    key = (id(candidate.call), tuple(str(f) for f in files))
    trial = replace(candidate, self_only=True)
    if key in _DRY_CALLS:
        folder, ok, value, theirs = _DRY_CALLS[key]
    else:
        folder, ok, value, theirs = _dry_call_over_a_folder(trial, files)
        _DRY_CALLS[key] = (folder, ok, value, theirs)
    if theirs is not None:
        # Refused just below, and the only place that knows both which
        # constructor it was and what it read. A repository whose pipeline
        # starts here has nothing else to offer, so the refusal that follows
        # is the one place a team will look; see `_folders_of_their_own`.
        _FOLDER_OF_THEIR_OWN[candidate.label] = theirs
    if folder is None or not ok or value is None:
        return None
    # The stage's own output check is applied per stage and never memoized:
    # the same constructor is offered to every folder-declaring stage, and
    # week 2's `Album()` is not descriptors but is a graph, so the
    # descriptors stage refuses it and the graph stage, one probe later,
    # binds it. A memo that stored the refusal lost the binding.
    if stage.produces is not None and not _safe_produces(stage, value):
        return None
    supplied = dict(trial.supplied)
    supplied["folder"] = folder
    return replace(trial, supplied=supplied), value


def _dry_call_over_a_folder(
    trial: Candidate, files: Sequence[Any]
) -> Tuple[Optional[str], bool, Any, Optional[str]]:
    """Call once, hand over the folder it asked for, and say what it read.

    Returns ``(folder, ok, value, theirs)``: the folder the call read here or
    was given, what it returned, and the folder of their own it answered out
    of instead. ``folder`` is None when the call read no folder, read one
    outside the scratch directory, or asked for one that could not be
    written; ``theirs`` is set only in the middle case, so that a refusal can
    say which folder it was. Memoized by the caller because the second call,
    made after the folder exists, cannot be repeated: replaying only the
    first half against a folder that now exists reads "nothing was wanted"
    and refuses a class the first pass had bound.
    """

    with _watching() as seen:
        ok, value = _call(trial, ())
    if ok and value is not None:
        if _read_elsewhere(seen):
            return None, ok, value, _folder_of_their_own(seen, trial.call)
        return _folder_read_here(seen), ok, value, None
    name = _folder_wanted(seen)
    if name is None or not _materialize(name, files):
        return None, False, None, None
    ok, value = _call(trial, ())
    if not ok or value is None:
        return None, False, None, None
    return name, ok, value, None


def _folder_of_their_own(seen: Sequence[str], call: Any) -> Optional[str]:
    """The folder of theirs, beside their own file, that this call listed.

    Two filters, and both are what make the sentence a refusal writes out of
    this true rather than merely plausible.

    Only a directory counts. The audit hook records the path of every event
    it watches and not which event it was, and a call that reads a folder of
    photos also opens a model's weights and whatever its imports touch. A
    listing names a directory; every one of those others names a file.

    And only a directory under their own file. `~/.cache/torch/checkpoints`
    is outside the scratch directory too, and saying their pipeline reads it
    next to its own file would be false. What is being reported is a folder
    they shipped, which is the one thing the benchmark cannot hand over and
    cannot write into.
    """

    from pathlib import Path as _Path

    if _SCRATCH is None:
        return None
    for read in seen:
        try:
            where = _Path(str(read)).resolve()
        except OSError:
            continue
        if not where.is_dir():
            continue
        try:
            where.relative_to(_SCRATCH)
        except ValueError:
            named = _their_name_for(where, call)
            if named is not None:
                return named
    return None


def _their_name_for(folder: "Path", call: Any) -> Optional[str]:
    """One folder of theirs, written the way the file that read it wrote it.

    Relative to whichever directory above their file holds it, which for a
    folder inside their checkout is the path they typed. None when no
    directory above their file holds it, and the folder's own name when it
    does but the path there is longer than anything they would have written.
    """

    from pathlib import Path as _Path

    # A class is a harder thing to place than a function: `inspect.getfile`
    # reads a class's file out of `sys.modules`, and a module discovery
    # imported under a name of its own making is not there under the name the
    # class remembers. Its `__init__` carries the filename in its own code
    # object, which is the file the class was written in either way.
    written = call if inspect.isfunction(call) else getattr(call, "__init__", call)
    try:
        theirs = _Path(inspect.getfile(written)).resolve().parent
    except (TypeError, OSError):
        return None
    for anchor in (theirs, *theirs.parents):
        if anchor == anchor.parent:
            # The filesystem root holds everything, which says nothing.
            break
        try:
            named = _Path(*folder.relative_to(anchor).parts)
        except ValueError:
            continue
        # The first anchor that holds it is the closest one, so this is the
        # shortest way to say where the folder is. Anything longer is a path
        # across the machine rather than a name out of their code.
        return str(named) if len(named.parts) <= 3 else folder.name
    return None


def _folder_read_here(seen: Sequence[str]) -> Optional[str]:
    """The scratch folder this call read, when it read one.

    Named as the top-level directory under the scratch working directory,
    which is the name `_materialize` writes the benchmark's files under and
    so the name a run page can put in a sentence.

    Returns None when the call touched no folder at all, which is the
    difference between a pipeline written over a directory and a function
    that happens to take no arguments.
    """

    from pathlib import Path as _Path

    if _SCRATCH is None:
        return None
    for read in seen:
        text = str(read)
        if "*" in text or "?" in text:
            text = text.split("*", 1)[0].split("?", 1)[0]
        text = text.rstrip("/\\")
        if not text:
            continue
        where = _Path(text)
        try:
            resolved = (where if where.is_absolute() else _SCRATCH / where).resolve()
        except OSError:
            continue
        # A listing names the folder; an `open` names a file inside it.
        folder = resolved if resolved.is_dir() else resolved.parent
        try:
            inside = folder.relative_to(_SCRATCH)
        except ValueError:
            continue
        if not inside.parts:
            continue
        return inside.parts[0]
    return None


def _read_elsewhere(seen: Sequence[str]) -> bool:
    """Whether this call got its data from outside the scratch directory.

    A zero-argument reader that succeeded because a folder it owns is full of
    its own photos has answered a question about its own data. That answer is
    not about the benchmark's input, however plausible its shape, so it is
    not a binding.
    """

    from pathlib import Path as _Path

    if _SCRATCH is None:
        return True
    for read in seen:
        try:
            where = _Path(str(read)).resolve()
        except OSError:
            continue
        if not where.exists():
            continue
        try:
            where.relative_to(_SCRATCH)
        except ValueError:
            return True
    return False


def _files_in(positional: Sequence[Any]) -> List[Any]:
    """The fixture's files, when this form of the input is paths on disk."""

    from pathlib import Path as _Path

    if not positional:
        return []
    items = positional[0]
    if isinstance(items, (str, bytes)):
        return []
    try:
        candidates = list(items)
    except TypeError:
        return []
    if not candidates:
        return []
    if not all(isinstance(item, (str, _Path)) for item in candidates):
        return []
    return [item for item in candidates if _Path(item).is_file()]


def _folder_wanted(seen: Sequence[str]) -> Optional[str]:
    """The name of a directory the failed call read and did not find here.

    The name only. A path is a location on the machine that wrote it, and the
    part of it that means anything to us is what the folder is called.
    """

    from pathlib import Path as _Path

    for read in seen:
        text = str(read)
        # A glob pattern names its directory in everything before the
        # wildcard.
        if "*" in text or "?" in text:
            text = text.split("*", 1)[0].split("?", 1)[0]
        name = _Path(text.rstrip("/\\")).name
        if not name or "." in name:
            continue
        here = _Path.cwd() / name
        if here.exists() and any(here.iterdir()):
            continue
        return name
    return None


def _materialize(name: str, files: Sequence[Any]) -> bool:
    """Write the benchmark's files into a folder of that name, here.

    Here means the scratch working directory the search already probes from,
    and nowhere else: the check below refuses any destination that is not
    under it, so a repository being read cannot be written to whatever a
    student's code asked for.
    """

    import shutil
    from pathlib import Path as _Path

    root = _Path.cwd().resolve()
    # The throwaway directory `_scratch_cwd` made, and nothing else. A
    # comparison against the working directory alone is not enough: a caller
    # that probes a stage without going through the search would then write
    # a folder of photos into whatever directory it happened to be in, which
    # during this change was a checkout of this repository.
    if _SCRATCH is None or root != _SCRATCH:
        return False
    folder = (root / name).resolve()
    try:
        folder.relative_to(root)
    except ValueError:
        return False
    try:
        folder.mkdir(parents=True, exist_ok=True)
        for source in files:
            shutil.copyfile(str(source), str(folder / _Path(source).name))
    except OSError:
        return False
    return True


def _pick_element(stage: Stage, produced: Sequence[Any]) -> Tuple[Optional[int], Any]:
    """Which part of each per-item result this stage produced."""

    for element, offered in _gathered(stage, produced):
        if stage.produces is None or _safe_produces(stage, offered):
            return element, offered
    return None, list(produced)


def _mapped(candidate: Candidate, fixture: Sequence[Any]) -> Tuple[bool, Any]:
    """Call a one-item function once per item of the first argument.

    Only the first argument is spread; anything after it is passed to every
    call unchanged, which is how a rate or a threshold behaves. A single
    failure fails the whole attempt, because a descriptor function that works
    on eleven photos of twelve has not done the job.
    """

    if not fixture:
        return False, None
    items = fixture[0]
    rest = tuple(fixture[1:])
    try:
        length = len(items)
    except TypeError:
        return False, None
    if length == 0 or isinstance(items, (str, bytes)):
        return False, None

    produced = []
    for index, item in enumerate(items):
        # The index goes with the call, because the only thing that differs
        # between items is which one's name the identity slot holds.
        ok, value = _call(candidate, (item,) + rest, index)
        if not ok or value is None:
            return False, None
        produced.append(value)
    return True, produced


def _gathered(stage: Stage, produced: Sequence[Any]) -> List[Tuple[Optional[int], Any]]:
    """The per-item result whole, then element k of every item.

    Their per-photo function returns everything it found. Week 2's Bagel
    repository returns `(boxes, probabilities, descriptors)` per photo, and
    the descriptors are what the next step takes; gathering element 2 across
    photos is the same reading `_handoffs` does for a single return value,
    applied once per item instead of once.

    Offered only for a per-item stage. Applying it to every value would
    rewrite week 1's fingerprint lists, which are thousands of tuples, into
    two gathered columns nobody asked for.
    """

    offers: List[Tuple[Optional[int], Any]] = [(None, list(produced))]
    if not stage.per_item or not produced:
        return offers
    first = produced[0]
    if not isinstance(first, tuple) or not first:
        return offers
    width = len(first)
    if any(not isinstance(row, tuple) or len(row) != width for row in produced):
        return offers
    for index in range(width):
        offers.append((index, [row[index] for row in produced]))
    return offers


#: Parameter names that ask for the item's own identity rather than for data.
#: Deliberately a small list of the words the corpus actually used: `names`
#: in Bagel's `Whispers(vectors, names, threshold)` and `file_path` in the
#: course's own Node. A wider list would start feeding photo paths to
#: arguments that wanted something else.
_IDENTITY_WORDS = ("name", "id", "label", "path", "file", "image", "photo", "title")

#: The noun forms of `id`, spelled out. Two letters is too short to match as
#: the start of a word without also taking `idle` and `identify`, so these
#: are listed rather than derived.
_IDENTITY_TOKENS = frozenset(("identity", "identities", "identifier", "identifiers"))


def _words_in(name: str) -> List[str]:
    """A parameter name split into words, on underscores and camel humps."""

    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name)
    return [part for part in re.split(r"[^A-Za-z]+", spaced) if part]


def _asks_for_identity(name: str) -> bool:
    """Whether this parameter is asking for the item's own name or index.

    Matched on whole words. The test here was `word in parameter.name.lower()`
    over `_IDENTITY_WORDS`, and `id` occurs inside `width`: `build(vectors,
    width)` was called with the list of photo identities as its width, and
    bound. `grid`, `valid`, and any size argument spelled with those three
    letters had the same problem, so a decoy could be bound by a substring of
    an argument it never asked for.

    A word of four letters or more may also begin a token, because
    `filename` and `filepath` are one token asking for exactly what
    `file_name` asks for.
    """

    for token in _words_in(name.lower()):
        forms = {token}
        if token.endswith("s"):
            forms.add(token[:-1])
        if token.endswith("es"):
            forms.add(token[:-2])
        if forms & _IDENTITY_TOKENS:
            return True
        for word in _IDENTITY_WORDS:
            if word in forms:
                return True
            if len(word) >= 4 and token.startswith(word):
                return True
    return False


def _parameter_names(call: Any) -> FrozenSet[str]:
    """Every parameter this call has a name for.

    Wider than `_required_parameters` on purpose: a side input passed by
    keyword is often keyword-only and often has a default, and neither
    disqualifies it. Week 3's embedders write `embed(texts, *, idfs)`.
    """

    try:
        signature = inspect.signature(call)
    except (TypeError, ValueError):
        return frozenset()
    return frozenset(signature.parameters)


def _required_parameters(call: Any) -> Optional[List[inspect.Parameter]]:
    """The positional parameters a call demands, or None if it cannot say."""

    try:
        signature = inspect.signature(call)
    except (TypeError, ValueError):
        return None
    kinds = (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    return [
        parameter
        for parameter in signature.parameters.values()
        if parameter.kind in kinds and parameter.default is inspect.Parameter.empty
    ]


def _shapes(
    stage: Stage,
    candidate: Candidate,
    values: int,
    pool: Dict[str, Any],
    identities: Sequence[Any],
) -> List[Candidate]:
    """Every honest way this stage's call can be made, in the order to try.

    The plain call first, always, so a team that defaulted everything is
    unaffected and a week that declares nothing gets exactly the search it
    had. Then the declared side inputs after the value, then before it, then
    by the names the signature uses. Then, last, the item's identity in any
    required slot still empty.
    """

    shapes: List[Candidate] = [candidate.with_plan(())]
    slots = ["value"] * values

    names = [name for name in stage.extras if name in pool]
    if names:
        supplied = {name: pool[name] for name in names}
        extras = ["extra:" + name for name in names]
        shapes.append(candidate.with_plan(slots + extras, supplied))
        shapes.append(candidate.with_plan(extras + slots, supplied))
        by_name = [name for name in names if name in _parameter_names(candidate.call)]
        if by_name:
            shapes.append(
                candidate.with_plan(
                    slots, {name: pool[name] for name in by_name}, keywords=by_name
                )
            )

    if stage.identity and identities:
        shape = _identity_shape(stage, candidate, values, pool, identities)
        if shape is not None:
            shapes.append(shape)
    return shapes


def _identity_shape(
    stage: Stage,
    candidate: Candidate,
    values: int,
    pool: Dict[str, Any],
    identities: Sequence[Any],
) -> Optional[Candidate]:
    """Fill this call's required slots, offering identity where it is asked for.

    Walks the signature rather than appending to the end, because the
    argument that wants a name sits in the middle: Bagel's
    `Whispers(vectors, names, threshold)` takes the descriptors, then one
    label per descriptor, then a cutoff.
    """

    parameters = _required_parameters(candidate.call)
    if parameters is None or len(parameters) <= values:
        return None
    plan: List[str] = ["value"] * values
    supplied: Dict[str, Any] = {"identity": tuple(identities)}
    used_tuning = False
    used_identity = False
    for parameter in parameters[values:]:
        if _asks_for_identity(parameter.name):
            plan.append("identity")
            used_identity = True
            continue
        if parameter.name in stage.extras and parameter.name in pool:
            plan.append("extra:" + parameter.name)
            supplied[parameter.name] = pool[parameter.name]
            continue
        if stage.tunings and not used_tuning:
            plan.append("tuning")
            used_tuning = True
            continue
        return None
    if not used_identity:
        return None
    return candidate.with_plan(plan, supplied)


def _tuned(candidate: Candidate, tuning: Any) -> Candidate:
    """The same shape, carrying a tuning value.

    A plain call keeps its empty plan, so the tuning lands where it always
    did: appended after the value. A shape that already reserved a slot for
    one fills that slot instead.
    """

    if not candidate.plan or "tuning" in candidate.plan:
        return replace(candidate, tuning=tuning)
    return replace(candidate, plan=candidate.plan + ("tuning",), tuning=tuning)


def _safe_produces(stage: Stage, value: Any) -> bool:
    """Whether the upstream value already looks like this stage's output.

    The test for a fused pair. Their combined function returned something; if
    that something passes this stage's own validator, the step is done and the
    chain moves on without adding a candidate for it.
    """

    if stage.produces is None:
        return True
    for offered, _note in _handoffs(value):
        if _safe(stage.produces, offered):
            return True
    return False


def _safe(predicate: Callable[[Any], bool], value: Any) -> bool:
    try:
        return bool(predicate(value))
    except BaseException:  # noqa: BLE001 - a validator must not crash discovery
        return False


def _handoffs(upstream: Any) -> List[Tuple[Any, Optional[str]]]:
    """The ways one stage's return value can be offered to the next.

    A stage's value is never altered, but it can be *unpacked*. Teams return a
    bare array, or the ``(spectrogram, freqs, times)`` triple matplotlib's
    ``specgram`` hands back, and their own next function takes whichever one
    they wrote for. Offering the whole tuple and then its first element covers
    both without transforming either: what the next stage receives is exactly
    what the last stage produced, or exactly one element of it.

    Anything else -- rescaling, transposing, re-typing -- would score our
    arithmetic instead of their code, and their thresholds are tuned to their
    own representation.
    """

    # The second half of each pair names the reading, and is what a bound
    # step records as its `handoff`. It used to be prose nobody read, which
    # is why a replay had to re-derive which part of a tuple had bound.
    offers: List[Tuple[Any, Optional[str]]] = [(upstream, None)]
    if isinstance(upstream, tuple) and upstream:
        # Spread, when the previous step returned exactly the arguments the
        # next one takes. One 2026 team's `adj_list` returns `(nodes, adj)`
        # and their `whispers(nodes, adj, iterations)` takes both, which is
        # the course's own design: "a list of nodes and an adjacency graph
        # ... together, represent your graph"
        # (docs/capstones/week2-vision-capstone.md:386). Nothing is
        # transformed; the tuple is handed over as the arguments it already
        # is.
        offers.append((_Spread(upstream), "spread"))
        if len(upstream) == 2:
            # The same two parts the other way round. One 2026 team's
            # `adj_list` returns `(nodes, adj)` and their own
            # `connected_comps(adj, nodes)` takes them reversed, which is
            # their choice of parameter order and not a different answer.
            offers.append((_Spread((upstream[1], upstream[0])), "reversed"))
        # Every element, not only the first. `specgram` returns
        # `(spectrogram, freqs, times)` and one team's combined peak finder
        # returns `(peaks, freqs, times, spectrogram)`, where the part the
        # next stage wants is last. Each element is offered exactly as it was
        # returned, and the stage's own validator decides.
        seen = set()
        for index, element in enumerate(upstream):
            marker = id(element)
            if marker in seen:
                continue
            seen.add(marker)
            offers.append((element, "element:{}".format(index)))
    return offers


def extend(
    stage: Stage,
    candidates: Sequence[Candidate],
    upstream: Any,
    extra: Sequence[Any] = (),
    *,
    accept_any: bool = False,
    extras: Optional[Dict[str, Any]] = None,
    identities: Sequence[Any] = (),
) -> List[Tuple[Candidate, Any, Any]]:
    """Feed one stage's real output to the next stage, unchanged.

    ``upstream`` is passed as it was returned, or as its first element when it
    is a tuple; see ``_handoffs``. Nothing is rescaled or reshaped.
    """

    pool = dict(extras or {})
    accepted: List[Tuple[Candidate, Any]] = []
    for candidate in _order_for(stage, candidates) + _from_pool(stage, pool):
        # A method of the object the chain is carrying is called with no
        # arguments at all: the object it is bound to IS the input. Week 2's
        # Bagel repository builds its graph with `Whispers(...)` and then
        # `w.create_matrix()`, and a call that passed the instance to its own
        # method would be handing it to itself twice.
        if getattr(candidate.call, "__self__", None) is upstream:
            trial = replace(candidate, self_only=True)
            ok, value = _call(trial, ())
            answered = ok and value is not None
            if answered and (accept_any or stage.produces is None or _safe(stage.produces, value)):
                accepted.append((trial, value, upstream))
                continue
            if ok and value is None and stage.in_place:
                # Their method returned nothing and changed the object. That
                # is the shape the course teaches for whispers, and the
                # object goes forward for one of their own functions to read.
                accepted.append((replace(trial, in_place=True), upstream, upstream))
                continue
        for offered, handoff in _handoffs(upstream):
            if (
                stage.accepts is not None
                and not isinstance(offered, _Spread)
                and not _safe(stage.accepts, offered)
            ):
                continue
            base = (
                tuple(offered) + tuple(extra)
                if isinstance(offered, _Spread)
                else (offered,) + tuple(extra)
            )
            bound, value = _bind_one(
                stage,
                candidate,
                base,
                pool,
                identities,
                spread=isinstance(offered, _Spread),
            )
            if bound is None:
                continue
            if accept_any or stage.produces is None or _safe(stage.produces, value):
                accepted.append(
                    (
                        # Which reading of the upstream value this call was
                        # made with, so the same call can be made again from
                        # the whole value alone.
                        replace(bound, handoff=handoff),
                        value,
                        tuple(offered) if isinstance(offered, _Spread) else offered,
                    )
                )
                break
    return accepted


def resolve_chain(
    role: Role,
    modules: Sequence[Any],
    fixture: Sequence[Any],
    *,
    verify: Optional[Callable[[Sequence[Candidate]], bool]] = None,
    beam: int = BEAM_WIDTH,
    seed: int = 0,
    extras: Optional[Dict[str, Any]] = None,
    identities: Sequence[Any] = (),
) -> Resolution:
    """Find a chain of the student's functions that performs ``role``.

    Search is a beam over real values: probe the first stage with the fixture,
    then extend each surviving partial chain by feeding its actual output
    forward. ``verify`` is the only thing that can accept a complete chain, and
    it is expected to run the benchmark's own end-to-end case.

    ``extras`` is the benchmark's own resources, by name, for stages that
    declare them. A role made of branches resolves each branch over this same
    pool, and hands ``verify`` a dict of branch name to bound chain rather
    than one chain.

    Returns the binding, or a refusal naming the furthest point reached.
    """

    global _THEIR_ROOT

    with _scratch_cwd():
        _THEIR_ROOT = _their_root(modules)
        resolve = _resolve_branches if role.branches else _resolve_chain
        binding, refusal = resolve(
            role,
            modules,
            fixture,
            verify=verify,
            beam=beam,
            seed=seed,
            extras=extras,
            identities=identities,
        )
        return _empty_receivers(binding) if binding is not None else None, refusal


def _empty_receivers(binding: Binding) -> Binding:
    """Detach public replay handles from probe owners, preserving their sharing.

    Internal branch searches still need their live associations. Only the public
    return resets them; _value remains the intentional discovery evidence.
    """

    receivers: Dict[_Receiver, _Receiver] = {}

    def clone(candidate: Candidate) -> Candidate:
        if candidate.receiver is None:
            return candidate
        if candidate.receiver not in receivers:
            receivers[candidate.receiver] = _Receiver()
        return replace(candidate, receiver=receivers[candidate.receiver])

    return replace(
        binding,
        steps=tuple(clone(step) for step in binding.steps),
        fits=tuple((name, clone(step)) for name, step in binding.fits),
        branches={
            name: tuple(clone(step) for step in chain)
            for name, chain in binding.branches.items()
        },
        _reach=tuple(clone(step) for step in binding._reach),
    )


@dataclass(frozen=True)
class _Attempt:
    """What one run of the branch fixpoint found, kept so it can be redone
    from the middle (see the form backtracking in `_resolve_branches`)."""

    chains: Dict[str, Tuple[Candidate, ...]]
    fits: Tuple[Tuple[str, Candidate], ...]
    #: Branches that did not bind, in declared order.
    pending: List[Role]
    refusals: Dict[str, Refusal]
    #: Per bound branch, the fixture form its first step bound with and how
    #: many forms it was offered.
    forms: Dict[str, Tuple[Optional[int], int]]
    #: Branches whose input existed and were searched, bound or not.
    searched: set
    #: Bound branches in the order they bound.
    order: List[str]
    values: Dict[str, Any]
    branch_fits: Dict[str, List[Tuple[str, Candidate]]]
    carried: Dict[str, List[Candidate]]


def _resolve_branches(
    role: Role,
    modules: Sequence[Any],
    fixture: Sequence[Any],
    *,
    verify: Optional[Callable[[Dict[str, Sequence[Candidate]]], bool]] = None,
    beam: int = BEAM_WIDTH,
    seed: int = 0,
    extras: Optional[Dict[str, Any]] = None,
    identities: Sequence[Any] = (),
) -> Resolution:
    """Resolve every branch over one shared pool, then verify them together.

    Shared is the point. Week 3's four surfaces are not four repositories:
    the text side and the search side use the same IDF table, and in three of
    the four audited repositories the store the prepare branch builds is the
    object the search branch calls a method on. Resolving them independently
    would find four chains that cannot be composed.

    Branches are resolved to a fixpoint rather than once in declared order,
    because the corpus needs opposite orders. Lashika's week 3 image step is
    `ImageDatabase(ids, descriptors, W).descriptor_to_embedding`, a method of
    the object the PREPARE branch builds, so image must come after prepare;
    declared in the week's order it refused with "nothing accepted the input
    the image step passes" (measured 2026-09-02). Bagel's
    `CaptionImageQuery(EMBEDDINGS, ids)` takes the IMAGE branch's projected
    matrix, so prepare must come after image. One declared order cannot
    serve both. So: walk the unresolved branches in declared order, bind
    whichever can bind now, and go round again until a whole pass binds
    nothing. A branch that resolved is never resolved again, and the order
    within each pass is the declared one, so the result is the same on every
    run.

    Each branch is verified only by the whole, because a branch on its own
    answers nothing the benchmark asked for.
    """

    pool: Dict[str, Any] = dict(extras or {})
    carried: List[Candidate] = []
    chains: Dict[str, Tuple[Candidate, ...]] = {}
    # The side inputs every branch shares are computed here, once, before any
    # branch runs. Week 3's IDF table is the case: putting it inside a branch
    # would compute it again per branch and, worse, let two branches bind two
    # different tables.
    candidates = callables_in(modules) + constructors_in(modules)
    fits, missing = _fits_of(role, candidates, pool, identities, values_in(modules))
    if missing is not None:
        return None, Refusal(
            role.name,
            (),
            missing,
            "nothing produced the {} the later steps need".format(missing),
        )

    def _attempt(
        banned: Dict[str, FrozenSet[int]],
        keep: Optional[_Attempt] = None,
        before: Optional[str] = None,
    ) -> _Attempt:
        """One run of the fixpoint, from scratch or from an earlier attempt.

        ``banned`` names, per branch, the fixture forms not to offer again.
        ``keep`` and ``before`` carry over every branch the earlier attempt
        bound before ``before`` in its own binding order: those bindings
        never saw the branch being retried, so running them again would
        find the same thing more slowly.
        """

        pool_now: Dict[str, Any] = dict(pool)
        carried_now: List[Candidate] = []
        chains_now: Dict[str, Tuple[Candidate, ...]] = {}
        fits_now: List[Tuple[str, Candidate]] = list(fits)
        forms_now: Dict[str, Tuple[Optional[int], int]] = {}
        values_now: Dict[str, Any] = {}
        branch_fits: Dict[str, List[Tuple[str, Candidate]]] = {}
        carried_by: Dict[str, List[Candidate]] = {}
        order: List[str] = []
        if keep is not None and before is not None:
            for name in keep.order:
                if name == before:
                    break
                chains_now[name] = keep.chains[name]
                pool_now[name] = keep.values[name]
                values_now[name] = keep.values[name]
                forms_now[name] = keep.forms[name]
                branch_fits[name] = list(keep.branch_fits[name])
                fits_now.extend(keep.branch_fits[name])
                carried_by[name] = list(keep.carried[name])
                carried_now.extend(keep.carried[name])
                order.append(name)
        pending = [branch for branch in role.branches if branch.name not in chains_now]
        refusals: Dict[str, Refusal] = {}
        searched: set = set()
        while pending:
            progressed = False
            waiting: List[Role] = []
            for branch in pending:
                own = _fixture_for(branch, fixture, pool_now, chains_now)
                if own is _UNREADY:
                    refusals[branch.name] = Refusal(
                        role.name,
                        (),
                        branch.stages[0].name if branch.stages else branch.name,
                        "the input this branch takes was not produced by any "
                        "other branch",
                    )
                    waiting.append(branch)
                    continue
                if isinstance(own, _Broken):
                    refusals[branch.name] = Refusal(
                        role.name,
                        (),
                        branch.stages[0].name if branch.stages else branch.name,
                        "the benchmark's own input for this branch could not be "
                        "made: {}: {}".format(
                            type(own.error).__name__, str(own.error)[:120]
                        ),
                    )
                    waiting.append(branch)
                    continue
                searched.add(branch.name)

                # The week's test judges each branch as it binds, with every
                # branch bound so far beside it, so a chain the test rejects
                # is passed over for the next one rather than ending the
                # search. Measured on Lashika: the image branch first bound
                # `triplet_utils.train_val_split`, whose per-row split
                # gathers into a (100, 409) matrix that passes the stage's
                # loose width check; the test refused it (409-d against
                # 200-d text) and the role was reported as ran-but-wrong
                # while their `descriptor_to_embedding` was never asked.
                def _judge(steps: Sequence[Candidate], _name: str = branch.name) -> bool:
                    if verify is None:
                        return True
                    trial = dict(chains_now)
                    trial[_name] = tuple(steps)
                    return bool(verify(trial))

                binding, refusal = _resolve_chain(
                    branch,
                    modules,
                    own,
                    verify=_judge,
                    beam=beam,
                    seed=seed,
                    extras=pool_now,
                    identities=identities,
                    carried=carried_now,
                    # The verifier receives every resolved branch, including ones
                    # whose owners this independent branch never calls itself.
                    verification_context=tuple(
                        step for chain in chains_now.values() for step in chain
                    ),
                    skip_forms=banned.get(branch.name, frozenset()),
                )
                if binding is None:
                    assert refusal is not None
                    # Not final. Another branch may still put the object or
                    # the matrix this one needs into the pool, and the loop
                    # comes back to it while any pass makes progress.
                    refusals[branch.name] = refusal
                    waiting.append(branch)
                    continue
                progressed = True
                refusals.pop(branch.name, None)
                chains_now[branch.name] = binding.steps
                branch_fits[branch.name] = list(binding.fits)
                fits_now.extend(binding.fits)
                # What this branch produced, under its own name, so a later
                # branch can name it in `Stage.extras` or read it out of the
                # pool in its own fixture.
                pool_now[branch.name] = binding._value
                values_now[branch.name] = binding._value
                total = len(own) if isinstance(own, Fixtures) else 1
                forms_now[branch.name] = (
                    binding.steps[0].form if binding.steps else None,
                    total,
                )
                # What this branch built, handed to the next one: only what
                # a constructor stage actually produced, and only after the
                # branch was accepted.
                mine: List[Candidate] = []
                for reached in binding._reach:
                    if not any(held.label == reached.label for held in carried_now):
                        stamped = replace(reached, branch=branch.name)
                        carried_now.append(stamped)
                        mine.append(stamped)
                carried_by[branch.name] = mine
                order.append(branch.name)
            pending = waiting
            if not progressed:
                break
        return _Attempt(
            chains_now,
            tuple(fits_now),
            pending,
            refusals,
            forms_now,
            searched,
            order,
            values_now,
            branch_fits,
            carried_by,
        )

    latest = _attempt({})
    best = latest

    def _covers(attempt: _Attempt) -> Tuple[int, int]:
        # Required branches first, then how many branches at all. An
        # independent review built a role where the earliest attempt bound
        # an optional branch and a later one bound the required branch
        # instead; counting chains alone kept the first and refused the
        # role with the required branch found.
        required_names = {branch.name for branch in role.branches if not branch.optional}
        return (len(required_names & set(attempt.chains)), len(attempt.chains))

    # Depth-first over the forms the bound branches were offered. A state
    # is the exact form forced on each branch of a prefix of the binding
    # order; every later branch keeps all its forms open, because a form
    # banned under one upstream state was never tried under another (the
    # review's A=2, B=0 case). A visited state ends that path; the cap
    # guards a role with many multi-form branches and no corpus repository
    # comes near it (week 3 has one four-form branch). The attempt that
    # covers the most required branches, then the most branches, wins.
    seen_states = {frozenset()}
    stack: List[Tuple[_Attempt, Dict[str, int]]] = [(latest, {})]
    attempts = 1
    while stack and attempts < _FORM_ATTEMPTS:
        attempt, forced = stack.pop()
        if not any(branch.name in attempt.searched for branch in attempt.pending):
            continue
        for name in reversed(attempt.order):
            used, total = attempt.forms[name]
            if used is None or total <= 1:
                continue
            position = attempt.order.index(name)
            prefix = {n: f for n, f in forced.items() if n in attempt.order[:position]}
            for form in range(total):
                if form == used:
                    continue
                choice = dict(prefix)
                choice[name] = form
                state = frozenset(choice.items())
                if state in seen_states:
                    continue
                seen_states.add(state)
                banned = {
                    n: frozenset(range(attempt.forms[n][1])) - {f} for n, f in choice.items()
                }
                attempts += 1
                fresh = _attempt(banned, attempt, name)
                if _covers(fresh) > _covers(best):
                    best = fresh
                stack.append((fresh, choice))
                if attempts >= _FORM_ATTEMPTS:
                    break
            if attempts >= _FORM_ATTEMPTS:
                break

    required = [branch for branch in best.pending if not branch.optional]
    if required:
        stuck_branch = required[0]
        return None, replace(
            best.refusals[stuck_branch.name],
            role="{}.{}".format(role.name, stuck_branch.name),
        )
    if not best.chains:
        first = role.branches[0]
        return None, replace(
            best.refusals[first.name], role="{}.{}".format(role.name, first.name)
        )
    # The optional branches that never bound, kept with the refusal each one
    # ended on. The week decides what a partial set means; discovery's job is
    # to say exactly which surface is absent and why. Every chain in the
    # answer passed the week's test beside the chains bound before it, and
    # the last one beside all of them, so the whole has been judged.
    absent = {branch.name: best.refusals[branch.name] for branch in best.pending}
    return (
        Binding(
            role.name,
            (),
            fits=best.fits,
            branches=dict(best.chains),
            missing=absent,
            _stage_names=tuple(best.chains),
            _received=tuple("" for _ in best.chains),
            _returned=tuple("" for _ in best.chains),
        ),
        None,
    )

#: What a branch fixture says when the value it needs is not in the pool yet.
#: Not None, because None is how a branch says "use the role's own fixture",
#: and the two must not be confused: one means come back next pass, the other
#: means probe now with what the role was given.
_UNREADY = object()


def _fixture_for(
    branch: Role,
    outer: Sequence[Any],
    pool: Dict[str, Any],
    chains: Dict[str, Tuple[Candidate, ...]],
) -> Any:
    """This branch's own input, made at the moment the branch is resolved.

    A plain fixture is used as it is, which is every branch before week 3. A
    callable is handed the pool and the branches bound so far and asked for
    one: week 3's search branch is probed with its own text chain applied to
    the query string, which does not exist until the text branch has bound,
    and its prepare branch is offered the image branch's projected matrix
    alongside the raw descriptors.

    Raising is how the week says "not yet". The pool and the chains are
    copies, so a week that reads them cannot change what the search is
    carrying.
    """

    own = branch.fixture
    if own is None:
        return outer
    if not callable(own):
        return own
    try:
        made = own(dict(pool), dict(chains))
    except (KeyError, LookupError):
        # The pool does not hold what this fixture reads yet. That is the
        # "not yet" this function exists for, and the fixpoint comes back.
        return _UNREADY
    except BaseException as error:  # noqa: BLE001 - a week's fixture may do anything
        # Anything else is the fixture itself failing, which no later pass
        # will change. Reported as such, because the first draft folded it
        # into "not produced by any other branch", which told a week author
        # to look at branch order when the bug was in the fixture they wrote.
        return _Broken(error)
    return _UNREADY if made is None else made


class _Broken:
    """A branch fixture that raised for a reason of its own, kept for the refusal."""

    def __init__(self, error: BaseException) -> None:
        self.error = error


def values_in(modules: Sequence[Any]) -> List[Tuple[str, str, Any]]:
    """Every module-scope value the team's code built when it loaded.

    As ``(label, module, value)`` in a stable order. Functions, classes,
    modules, and private names are left out; what remains is data their own
    statements produced at import: a table, a matrix, a loaded resource.
    One audited repository has no IDF function at all. Its `text_to_image`
    computes `idf` at module scope, in a loop over the course captions, and
    every embedding call reads that global. The computation is theirs and it
    ran; a fit stage that only looks for a function to call reports that
    nothing produced the table while the table sits in their namespace.
    """

    found: List[Tuple[str, str, Any]] = []
    for module in modules:
        module_name = getattr(module, "__name__", "?")
        for name in sorted(dir(module)):
            if name.startswith("_"):
                continue
            value = getattr(module, name, None)
            if value is None or callable(value) or inspect.ismodule(value):
                continue
            found.append(("{}.{}".format(module_name, name), module_name, value))
    return found


def _fits_of(
    role: Role,
    candidates: Sequence[Candidate],
    pool: Dict[str, Any],
    identities: Sequence[Any],
    values: Sequence[Tuple[str, str, Any]] = (),
) -> Tuple[List[Tuple[str, Candidate]], Optional[str]]:
    """Run this role's fit stages into the pool, or name the one that failed.

    The pool is filled as it goes, so a fit stage may use an earlier one: a
    week whose IDF table feeds a vocabulary table gets that for free and in
    the order it declared.
    """

    found: List[Tuple[str, Candidate]] = []
    for stage in role.stages:
        if not stage.fit:
            continue
        hit = _fit(stage, candidates, pool, identities, values)
        if hit is None:
            if stage.optional:
                continue
            return found, stage.name
        candidate, value = hit
        pool[stage.name] = value
        found.append((stage.name, candidate))
    return found, None


def _fit(
    stage: Stage,
    candidates: Sequence[Candidate],
    pool: Dict[str, Any],
    identities: Sequence[Any],
    values: Sequence[Tuple[str, str, Any]] = (),
) -> Optional[Tuple[Candidate, Any]]:
    """Run the one of their functions that produces this side input.

    Probed exactly like a first stage, against this stage's own fixture. It
    is not a link in the chain: nothing downstream takes its value as input,
    and everything downstream takes it alongside one. So it runs once and the
    result joins the pool under this stage's name.

    The corpus case is week 3's IDF table. All four repositories compute one
    from the caption corpus and pass it to every embedding call. The corpus
    is the benchmark's to supply and the formula is theirs; handing them
    their own table back is not a substitution.
    """

    hits = probe_sources(
        stage, candidates, stage.fixture, extras=pool, identities=identities
    )
    if hits:
        return hits[0]
    # No function of theirs produces it. A value their module built when it
    # loaded may be the same table (see `values_in`); it is offered only
    # after every function has been tried, so a team with a function is
    # bound to the call the search witnessed. Recorded as supplied by name,
    # because a scored run cannot recompute a value that was never a call.
    if stage.produces is None:
        return None
    for label, module_name, value in values:
        if not _safe_produces(stage, value):
            continue
        note = "read from {}, a value their module computes when it loads".format(label)

        def _held(value=value):
            return value

        return (
            Candidate(
                label,
                _held,
                module_name,
                self_only=True,
                supplied={"value": note},
            ),
            value,
        )
    return None


def _already_ran(candidate: Candidate, partial: _Partial) -> bool:
    """Whether this chain has already run this function on this object.

    Only for a step that answers in place. Such a step returns nothing and
    changes the value it was given, so the search cannot see what it did and
    every one of them looks equally good; taking the same one again is the
    same step twice rather than the next one.

    Measured on week 2's Bagel repository, whose graph object offers seven
    methods that return nothing. Without this the beam filled with
    `create_matrix` repeated at every stage -- the alphabetically first of
    them -- and their `train_sweeps`, which is the step that actually runs
    whispers, was never reached at any beam width.
    """

    if not candidate.in_place:
        return False
    return any(step.label == candidate.label for step in partial.chain)


def _shared_out(
    partials: Sequence[_Partial],
    parents: Sequence[int],
    rank: Callable[[_Partial], Any],
) -> List[_Partial]:
    """The next frontier, with the beam shared out between its parents.

    The rank still decides which of ONE chain's continuations is better, and
    a frontier grown from a single chain comes out in exactly the order the
    plain sort gave it. What changes is what happens between chains: every
    chain's best continuation is offered before any chain's second, so a
    branch cannot be cut before it has been tried once.

    Measured on week 2's Bagel repository. Their `Whispers(vectors, names,
    threshold)` accepts the raw photos as its vectors too, so the fused
    first-stage probe binds it on the fixture and that chain runs beside the
    real one through `get_descriptor`. The pixel chain then answers the
    graph stage with a method while the real one can only construct, which
    the rank puts last, and both go on to offer five in-place methods of the
    same object. At beam 4 every slot went to the pixel chain from the graph
    stage onwards: the chain running on their descriptors was built and
    thrown away at each stage, and the repository was refused.
    """

    grouped: Dict[int, List[Tuple[Any, int, _Partial]]] = {}
    for index, (partial, parent) in enumerate(zip(partials, parents)):
        grouped.setdefault(parent, []).append((rank(partial), index, partial))
    ordered: List[Tuple[Tuple[Any, ...], _Partial]] = []
    for parent in sorted(grouped):
        # Ranked within its own parent first, so which continuation of a
        # chain is best is decided exactly as before; the position in that
        # order is then what the parents take turns on.
        for nth, (score, index, partial) in enumerate(
            sorted(grouped[parent], key=lambda entry: (entry[0], entry[1]))
        ):
            ordered.append(((nth, score, parent, index), partial))
    return [partial for _key, partial in sorted(ordered, key=lambda pair: pair[0])]


def _reachable(
    candidate: Candidate, value: Any, positional: Sequence[Any]
) -> Tuple[Candidate, ...]:
    """The methods of an object a constructor stage just built.

    Only for a candidate that IS a class, and only for the object it just
    returned. A later stage of this chain can then be one of that object's
    own methods, which is how week 3's `ImageDatabase(ids, descriptors, W)`
    reaches `.query` and week 2's `Whispers(vectors, names, threshold)`
    reaches `.create_matrix`.

    Each method carries a way to build the object again the same way: the
    same class, called with the same arguments, through the same plan. That
    is the rule `Submission.fresh` already applies to the no-argument
    classes, and it exists for the same measured reason -- fixture data left
    in a store competes with the benchmark's own catalog -- but a store built
    from data cannot be rebuilt from nothing, so the arguments come with it.
    """

    if not isinstance(candidate.call, type) or value is None:
        return ()
    if not isinstance(value, candidate.call):
        return ()
    arguments = tuple(positional)
    # The arguments were already read out of the upstream value by the
    # handoff this step bound with, so rebuilding must not read them again:
    # a constructor bound on `element:1` would take element 1 of its own
    # argument the second time round.
    # This rebuild repeats fixture arguments only, not later method mutations.
    # It must not publish into the chain's runtime receiver.
    plain = replace(candidate, handoff=None, receiver=None)

    def _build() -> Any:
        return _invoke(plain, arguments)

    return tuple(
        replace(method, receiver=candidate.receiver)
        for method in methods_of(candidate.label, value, build=_build)
    )


@contextlib.contextmanager
def _scratch_cwd():
    """Probe from a throwaway directory.

    Probing calls student functions, and their functions write: one audited
    repository rewrites a relative ``db.pkl`` on every add, and probing two
    repositories left ``db.pkl`` and ``songs.pkl`` in this checkout. Discovery
    already imports from scratch; the calls that follow it must too.
    """

    global _SCRATCH, _THEIR_ROOT

    previous = os.getcwd()
    was = _SCRATCH
    with tempfile.TemporaryDirectory(prefix="cogworks-probe-") as temporary:
        os.chdir(temporary)
        _SCRATCH = Path(temporary).resolve()
        try:
            yield
        finally:
            _SCRATCH = was
            _THEIR_ROOT = None
            _DRY_CALLS.clear()
            _FOLDER_OF_THEIR_OWN.clear()
            _RAISED.clear()
            os.chdir(previous)


def _folders_of_their_own() -> Tuple[str, ...]:
    """Why a constructor that reads a folder of their own could not be used.

    A pipeline written over a directory is a shape the search supports: a
    constructor that takes nothing is handed the benchmark's photos in a
    folder of the name its code looks for. That only works while the folder
    it looks for is one the benchmark can write. A constructor that resolves
    its folder from its own file finds its own photos instead, succeeds, and
    has answered a question about their data rather than ours, so it is
    refused; writing the benchmark's photos into their checkout to make it
    ours is not something a benchmark may do.

    The refusal that follows names the hand-off that failed, which for such a
    repository is three stages downstream and true but useless. Measured on
    week 2's CoggurtFilter: nothing else there builds a graph from
    descriptors, so the search wandered through the two other classes and
    stalled at the labels step, and the report named a profile class the team
    never meant to be part of the pipeline.

    Sorted, so two runs of the same repository write the same report.
    """

    return tuple(
        "{}() reads {}/ next to its own file, which holds your photos rather "
        "than the benchmark's, so it cannot be given the benchmark's photos; "
        "a constructor that takes the folder path as an argument, or reads it "
        "relative to the working directory, can.".format(label, folder)
        for label, folder in sorted(_FOLDER_OF_THEIR_OWN.items())
    )


def _resolve_chain(
    role: Role,
    modules: Sequence[Any],
    fixture: Sequence[Any],
    *,
    verify: Optional[Callable[[Sequence[Candidate]], bool]] = None,
    beam: int = BEAM_WIDTH,
    seed: int = 0,
    extras: Optional[Dict[str, Any]] = None,
    identities: Sequence[Any] = (),
    carried: Optional[List[Candidate]] = None,
    verification_context: Sequence[Candidate] = (),
    skip_forms: FrozenSet[int] = frozenset(),
) -> Resolution:
    random.seed(seed)
    pool: Dict[str, Any] = dict(extras or {})
    candidates = callables_in(modules)
    # Classes that demand their data up front are steps, not containers, and
    # they only reach the search here. `callables_in` is untouched, so the
    # store-and-query pairing search below still sees plain functions only.
    candidates = candidates + constructors_in(modules)
    # A class that builds with no arguments is a container `instances_in`
    # fills, not a step -- unless a stage said its input can be handed over
    # as a directory, in which case a constructor that reads one is the step.
    # Only then, because it widens the candidate set to every no-argument
    # class in the repository.
    if any(stage.folder for stage in role.stages):
        candidates = candidates + folder_readers_in(modules)
    if carried:
        candidates = candidates + list(carried)
    if not candidates:
        return None, Refusal(role.name, (), role.stages[0].name, "no functions to try")

    # The side inputs their own code computes, once, before anything else
    # runs. Each joins the pool under its stage's name, which is how a later
    # stage asks for it (`Stage.extras`).
    fits, missing = _fits_of(role, candidates, pool, identities, values_in(modules))
    if missing is not None:
        return None, Refusal(
            role.name,
            (),
            missing,
            "nothing produced the {} the later steps need".format(missing),
        )
    stages = tuple(stage for stage in role.stages if not stage.fit)
    if not stages:
        return None, Refusal(role.name, (), role.name, "this role has no steps")
    role = replace(role, stages=stages)

    first = role.stages[0]
    from .verdict import describe

    first_form = fixture[0] if isinstance(fixture, Fixtures) else fixture
    fixture_summary = ", ".join(describe(item) for item in first_form)

    # Each entry carries the chain, the value it last produced, and what every
    # step received and returned along the way. The trace is not decoration: a
    # chain that runs and answers wrongly is a bug in their pipeline, and the
    # only useful thing the platform can offer is the smallest reproduction it
    # has -- which of their functions ran, on what, and what came back.
    forms = fixture if isinstance(fixture, Fixtures) else (fixture,)

    def _identities_of(partial: _Partial) -> Sequence[Any]:
        """The identity of each item, in the form this chain's first step took.

        `probe_sources` works this out per form and the first stage gets it;
        every stage after it was handed the caller's `identities`, which is
        empty for a week that lets the input name its own items. Week 2's
        Bagel repository needs it downstream rather than at the first step:
        `file_descriptors(photo)` takes only the photo, and it is
        `Whispers(vectors, names, threshold)` two stages later that asks
        which photo each descriptor came from. Without this the identity slot
        was never offered after the first stage and the constructor could not
        be called at all.
        """

        return identities_for(identities, forms[partial.chain[0].form or 0])

    frontier: List[_Partial] = [
        _Partial(
            (candidate,),
            value,
            (fixture_summary,),
            (describe(value),),
            (first.name,),
            _reachable(candidate, value, forms[candidate.form or 0]),
        )
        for candidate, value in probe_sources(
            first, candidates, fixture, extras=pool, identities=identities, skip_forms=skip_forms
        )
    ]

    # A first stage marked fusible may not exist as its own function. One 2026
    # team's `adj_list(image_paths, threshold)` reads every photo and builds
    # the graph together, so there is no separate descriptor step to find and
    # the second stage is what takes the benchmark's own input. Probing the
    # next stage against the fixture too is how that shape is reached; the
    # acceptance test still decides.
    if first.fusible and len(role.stages) > 1:
        second = role.stages[1]
        seen = {step.chain[0].label for step in frontier}
        for candidate, value in probe_sources(
            second, candidates, fixture, extras=pool, identities=identities, skip_forms=skip_forms
        ):
            if candidate.label in seen:
                continue
            frontier.append(
                _Partial(
                    (candidate,),
                    value,
                    (fixture_summary,),
                    (describe(value),),
                    ("{} + {}".format(first.name, second.name),),
                    _reachable(candidate, value, forms[candidate.form or 0]),
                    # The first stage's input handed to the second stage's
                    # function: the forward reading, asked after any chain
                    # that found a function for the first stage.
                    1,
                )
            )
    if not frontier:
        return None, Refusal(
            role.name,
            (),
            first.name,
            "nothing accepted the {} the benchmark passes".format(
                "arguments" if first.arity > 1 else "input"
            ),
            notes=_folders_of_their_own(),
            errors=_raised_in_this_search(),
        )

    furthest: Tuple[str, ...] = (frontier[0].chain[0].label,)
    last_returned = frontier[0].returned[-1]
    stalled_at = role.stages[1].name if len(role.stages) > 1 else first.name

    for stage in role.stages[1:]:
        nxt: List[_Partial] = []
        # Which frontier entry each new chain grew out of. The beam is then
        # shared between them rather than filled by whichever entry happened
        # to have the most children; see `_shared_out`.
        parents: List[int] = []
        # The last stage is what makes a chain askable, and the verifier
        # below already asks every chain that reaches it rather than the
        # beam's share of them. So the beam bounds how many chains are
        # BUILT, and the final step is where building one costs a single
        # call. Measured on week 2's Bagel repository: their `train_sweeps`
        # is the fourth of seven methods that answer in place, so the chain
        # that runs whispers sat outside the beam at the last stage at every
        # width up to 128 and was never asked, while the three ahead of it
        # were asked and refused for not having settled.
        growing = frontier if stage is role.stages[-1] else frontier[:beam]
        # A chain that already absorbed this stage while probing skips it.
        done = [p for p in growing if p.stages[-1].endswith("+ " + stage.name)]
        for where, partial in enumerate(growing):
            if any(p is partial for p in done):
                # It served this stage already (its last step's input was
                # read as this stage, see the forward reading below).
                # Running another of their functions on top would put two
                # steps at one stage: a chain grew a second
                # `fingerprint_recording` after the first had absorbed the
                # peaks stage.
                continue
            reachable = list(candidates) + list(partial.reach)
            mine = _identities_of(partial)
            for candidate, produced, passed in extend(
                stage, reachable, partial.value, extras=pool, identities=mine
            ):
                if _already_ran(candidate, partial):
                    continue
                nxt.append(
                    _Partial(
                        partial.chain + (candidate,),
                        produced,
                        # What this step actually received, which is the whole
                        # upstream value or one element unpacked from it.
                        partial.received + (describe(passed),),
                        partial.returned + (describe(produced),),
                        partial.stages + (stage.name,),
                        partial.reach
                        + _reachable(
                            candidate,
                            produced,
                            passed if isinstance(passed, tuple) else (passed,),
                        ),
                        partial.forward,
                    )
                )
                parents.append(where)
            if stage.in_place:
                # Their function ran on the graph and left the answer there.
                # The graph goes forward so one more of their own functions
                # can read it; nothing here inspects or rebuilds it.
                for candidate, produced, passed in extend(
                    stage,
                    reachable,
                    partial.value,
                    accept_any=True,
                    extras=pool,
                    identities=mine,
                ):
                    # A function whose return already answers this stage
                    # did not answer in place; it was recorded above. Marking
                    # it in place too doubled one 2026 team's
                    # `connected_components` in the chain, and let two
                    # decoys that return a labels-shaped list claim the
                    # in-place slot ahead of the function that settled the
                    # graph.
                    if stage.produces is not None and _safe_produces(stage, produced):
                        continue
                    if _already_ran(replace(candidate, in_place=True), partial):
                        continue
                    nxt.append(
                        _Partial(
                            partial.chain + (replace(candidate, in_place=True),),
                            passed,
                            partial.received + (describe(passed),),
                            partial.returned + ("the value it was given, updated in place",),
                            partial.stages + (stage.name,),
                            partial.reach,
                            partial.forward,
                        )
                    )
                    parents.append(where)
        # A step the previous function already did. Carrying the frontier
        # forward unchanged lets the next stage read what that function
        # returned, which is how a fused pair is found: their combined
        # function has already produced this stage's output. The stage name
        # joins the step that absorbed it, so the report names both.
        # A chain whose last step already produced this stage's answer is
        # complete. One 2026 team ends at `connected_comps`, which is both
        # their graph reader and their answer; requiring another function
        # after it would refuse a finished pipeline.
        #
        # Kept beside the beam rather than inside it. The beam bounds how
        # many chains are BUILT and no call is made to carry one forward, so
        # a chain that skipped this stage costs nothing and cannot be worth
        # a slot that a step of their code could have had. Measured on week
        # 2's Lashika repository: their `adj_list` does three of the week's
        # stages in one call, and at every stage the carry-forward was
        # appended after every candidate the search had tried and sorted out
        # of a beam of four, so their `whispers` was never reached.
        skipped: List[_Partial] = []
        skipped_parents: List[int] = []
        if stage.fusible:
            for where, partial in enumerate(growing):
                if _safe_produces(stage, partial.value):
                    skipped_parents.append(where)
                    skipped.append(
                        _Partial(
                            partial.chain,
                            partial.value,
                            partial.received,
                            partial.returned,
                            partial.stages[:-1]
                            + ("{} + {}".format(partial.stages[-1], stage.name),),
                            partial.reach,
                            partial.forward,
                        )
                    )
            # The other direction: a fusible stage absorbed by the step
            # AFTER it. The previous function did not do this stage's work,
            # but the next stage's function takes this stage's input and
            # does both. One 2026 team's `fingerprint_recording(spectrogram)`
            # finds the peaks and pairs them in one call, and their
            # `local_peak_locations` needs a neighbourhood array and an
            # amplitude floor no benchmark could honestly supply; folding
            # the peaks stage into the function before it (above) cannot
            # reach that, because the spectrogram is not peaks. So the next
            # stage is probed against this stage's input as well, and the
            # step that binds is recorded as having done both.
            following = role.stages[role.stages.index(stage) + 1] if stage is not role.stages[-1] else None
            # Only into a following stage whose own output check can say the
            # work was done. An in-place following step returns nothing, so
            # "their method did this stage's work and the next" could never
            # be checked, and on week 2's Bagel it was taken anyway:
            # `train_sweeps()` absorbed the `nodes` stage, `create_nodes`
            # was never called, and `sorted_images()` returned an empty
            # dict that the week's test read as "does not say which photos
            # go together".
            if following is not None and (following.in_place or following.produces is None):
                following = None
            if following is not None:
                # The value handed over is THIS stage's input, so this
                # stage's `accepts` governs the probe, not the following
                # stage's, which describes what it takes from this stage's
                # output. Week 1's fingerprints stage refuses a bare
                # spectrogram for that reason (rutvim's fingerprinter
                # accepts one and scores 0.094 on it), and that rule is
                # right for a chain that has peaks to offer and wrong for a
                # team whose fingerprinter finds them itself.
                absorbed = replace(following, accepts=stage.accepts)
                # Only where nothing of theirs served this stage from this
                # chain, and never with the function that just answered:
                # `fingerprint_recording -> fingerprint_recording` is the
                # same call made twice, not a stage absorbed.
                served = set(parents)
                for where, partial in enumerate(growing):
                    if any(p is partial for p in done) or where in served:
                        continue
                    if any(p.chain is partial.chain for p in skipped):
                        continue
                    reachable = list(candidates) + list(partial.reach)
                    mine = _identities_of(partial)
                    for candidate, produced, passed in extend(
                        absorbed, reachable, partial.value, extras=pool, identities=mine
                    ):
                        if partial.chain and candidate.label == partial.chain[-1].label:
                            continue
                        nxt.append(
                            _Partial(
                                partial.chain + (candidate,),
                                produced,
                                partial.received + (describe(passed),),
                                partial.returned + (describe(produced),),
                                partial.stages + ("{} + {}".format(stage.name, following.name),),
                                partial.reach
                                + _reachable(
                                    candidate,
                                    produced,
                                    passed if isinstance(passed, tuple) else (passed,),
                                ),
                                partial.forward + 1,
                            )
                        )
                        parents.append(where)
        # A chain that reached this stage's own answer goes first. Otherwise
        # the beam keeps whichever branch was found earliest, and one 2026
        # team's `whispers` -- which returns how the component count moved and
        # leaves the labels on the graph -- crowded out their
        # `connected_comps`, which returns the answer.
        #
        # At a stage declared in_place, a step that answered on the graph
        # ranks ahead of one whose return merely looks like the answer. The
        # in-place partial carries the graph, which by design does not look
        # like this stage's output, so the plain sort put it last and the
        # beam cut it. Measured on the same 2026 repository: at beam 4 their
        # `adj_list -> whispers -> connected_comps` never reached the
        # verifier; at beam 64 it did and passed.
        # A step that built one of their objects goes behind every step that
        # did not. Constructing something out of a value is a way of carrying
        # it, not a way of answering; when one of their functions has already
        # answered this stage, wrapping that answer in an object is not a
        # better reading of it.
        #
        # Measured on one 2026 repository the moment classes became stage
        # candidates: their `Profile(name)` accepted the groups their
        # `connected_components` had just returned, took the in-place slot at
        # `settle`, and added a step that builds a profile and throws it
        # away. The score was identical and the chain was a step longer,
        # which is a chain that says something untrue about their code.
        def _rank(p: _Partial) -> Tuple[int, int]:
            built = bool(
                p.stages[-1] == stage.name
                and p.chain
                and isinstance(p.chain[-1].call, type)
            )
            if stage.in_place and p.stages[-1] == stage.name and p.chain[-1].in_place:
                return (int(built), 0)
            return (int(built), 1 if _safe_produces(stage, p.value) else 2)

        # Rank no-call fused readings with actual continuations. A real
        # in-place call ranks ahead of the unchanged object, while a fused
        # reading wins ties against normal or constructed continuations. This
        # keeps multi-step mutations alive without displacing shorter chains.
        # One share-out over calls and skipped readings together, each with
        # its parent. A global sort after the share-out regrouped one
        # parent's children ahead of another parent's best, which is the
        # starvation `_shared_out` exists to prevent (found by review with
        # two parents at beam 2). Within a parent `_rank` still puts an
        # in-place call ahead of the unchanged object.
        # Skipped readings first in the combined list, so on a rank tie
        # within one parent the fused reading is offered before a call that
        # merely looks like this stage's output: Lashika's `whispers` returns
        # a list of ints that passes the labels check, and offered ahead of
        # the fused reading it ended the chain a step early and the run
        # reported every photo in its own group.
        nxt = done + _shared_out(skipped + nxt, skipped_parents + parents, _rank)
        if not nxt:
            return None, Refusal(
                role.name,
                furthest,
                stage.name,
                "nothing accepted what {} returned".format(
                    furthest[-1] if furthest else "the last step"
                ),
                last_returned=last_returned,
                notes=_folders_of_their_own(),
                errors=_raised_in_this_search(),
            )
        frontier = nxt
        furthest = tuple(step.label for step in frontier[0].chain)
        last_returned = frontier[0].returned[-1]
        stalled_at = stage.name

    # Every chain that reached the end is asked, not just the ones the beam
    # kept. `_order_for` puts preferred names first and the beam then cut at
    # four, so with six one-stage candidates that all ran, whether the
    # repository resolved at all depended on where its function sorted: with
    # `prefers=("good",)` the working one entered the beam and bound, and
    # with every preference emptied five alphabetically earlier decoys pushed
    # it out and the same role refused. A name decided an outcome, which is
    # the one thing this search may never let happen.
    #
    # The beam still bounds how many chains are BUILT, which is where the
    # cost is. It no longer bounds how many are asked, and asking more can
    # only turn a refusal into a binding: the chains the beam kept are still
    # tried first and in the same order.
    asked = set()
    # A chain that found one of their functions for every stage is asked
    # before one that read a stage as fused into a neighbour. A fusible
    # stage is declared as one their code MAY not have; when it does, and a
    # chain through it passes the week's test, that chain is their division
    # of the work and the fused reading is the fallback it was meant to be.
    # Measured on rutvim's week 3: `embed_text(tokens, glove, idf)` accepts
    # a raw caption too and iterates its characters, and that fused chain
    # passed the week's test ahead of `caption_processor -> embed_text`
    # (text MRR 0.54 against 0.83). Both are their code; only one is how
    # they wrote it.
    #
    # A stage read forward (its input handed to a later step, at the head
    # of the chain or in the middle) sorts after every other reading,
    # because nothing of theirs was seen to produce that stage's output.
    # Among the rest the beam's own order stands: `_rank` already puts a
    # chain that answered ahead of one that merely built an object.
    # Measured on week 2's fixture: sorting on fused count alone put
    # `group -> Profile` ahead of `group` fused with `settle`, a chain that
    # builds a profile and throws it away. The sort is stable.
    for partial in sorted(frontier, key=lambda p: p.forward):
        key = tuple(
            (
                step.label,
                step.plan,
                step.keywords,
                repr(step.tuning),
                step.form,
                step.per_item,
                step.element,
                step.self_only,
                step.in_place,
                step.handoff,
            )
            for step in partial.chain
        )
        if key in asked:
            continue
        asked.add(key)
        try:
            # Verifiers replay constructors on their own cases. Keep those
            # publications out of the probe owners later branches still need.
            # Read before entering the scope, which hides unscoped defaults.
            # This restores associations, not mutations to the objects themselves.
            receivers = {
                step.receiver: step.receiver.get()
                for step in tuple(verification_context) + partial.chain
                if step.receiver is not None
            }
            with runtime_pool(receivers):
                accepted = verify is None or bool(verify(partial.chain))
        except BaseException:
            # Verification can call student code or inspect its malformed answer.
            continue
        if accepted:
            return (
                Binding(
                    role.name,
                    partial.chain,
                    fits=tuple(fits),
                    _stage_names=partial.stages,
                    _received=partial.received,
                    _returned=partial.returned,
                    _reach=partial.reach,
                    _value=partial.value,
                ),
                None,
            )

    return None, Refusal(
        role.name,
        furthest,
        stalled_at,
        "the chain ran but did not return the right answer on the benchmark's own case",
        ran_to_the_end=True,
    )
