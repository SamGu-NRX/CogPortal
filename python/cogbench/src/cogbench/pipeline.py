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
import itertools
import os
import random
import re
import signal
import sys
import tempfile
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Sequence, Tuple

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

#: Names that never hold a stage, whatever else they look like.
_NEVER = ("test", "plot", "show", "display", "demo", "main", "visuali")

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
    fixture: Any = None


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

    @property
    def bound(self) -> Callable[..., Any]:
        """The callable, called the way the search called it.

        One code path for the search, the acceptance test, and the scored
        run. Every field above exists because those three drifted apart once
        and a chain that had been proved raised on its first call.
        """

        if (
            self.tuning is None
            and not self.plan
            and not self.keywords
            and not self.per_item
            and self.element is None
            and not self.self_only
        ):
            return self.call
        return lambda *args: _invoke(self, args)

    def with_plan(
        self,
        plan: Sequence[str],
        supplied: Optional[Dict[str, Any]] = None,
        keywords: Sequence[str] = (),
    ) -> "Candidate":
        """The same candidate called a different way."""

        return replace(
            self,
            plan=tuple(plan),
            keywords=tuple(keywords),
            supplied=dict(supplied or {}),
        )


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
            identities = candidate.supplied.get("identity", ())
            args.append(identities[index] if index is not None else list(identities))
        elif slot.startswith("extra:"):
            args.append(candidate.supplied[slot[len("extra:"):]])
        else:  # pragma: no cover - a plan is built here and nowhere else
            raise TypeError("unknown argument slot {!r}".format(slot))
    keywords = {name: candidate.supplied[name] for name in candidate.keywords}
    return tuple(args), keywords


def _rebound(candidate: Candidate, positional: Sequence[Any]) -> Callable[..., Any]:
    """This step's callable, taken off the object the chain is carrying now.

    A method reached through a constructor stage is stored as the bound
    method of the object the SEARCH built, out of the search's fixture. A
    scored run builds that object again from the benchmark's real input, and
    a step that kept calling the first one answers about the fixture:
    `Good([1]).read()` bound during the search still returned `[1]` after the
    constructor was replayed with `[9]`, so a run could report fixture state
    as the student's answer.

    The chain already carries the new object -- it is what the constructor
    step just returned and what this step is called with -- so the method is
    taken off that. Falls back to the stored callable whenever the carried
    value is not one of these objects, which is every step that is not a
    method of a constructor stage's instance, so nothing else changes.
    """

    if candidate.attribute is None or not positional:
        return candidate.call
    held = positional[0]
    if candidate.owner is not None and not isinstance(held, candidate.owner):
        return candidate.call
    later = getattr(held, candidate.attribute, None)
    return later if callable(later) else candidate.call


def _invoke(candidate: Candidate, positional: Sequence[Any]) -> Any:
    """Run one bound candidate on the arguments a chain hands it."""

    if candidate.self_only:
        return _rebound(candidate, positional)()
    if candidate.per_item:
        if not positional:
            raise TypeError("a per-item step needs the items to run over")
        items = list(positional[0])
        rest = tuple(positional[1:])
        produced = []
        for index, item in enumerate(items):
            args, keywords = _arguments(candidate, (item,) + rest, index)
            produced.append(candidate.call(*args, **keywords))
        if candidate.element is not None:
            return [row[candidate.element] for row in produced]
        return produced
    args, keywords = _arguments(candidate, positional)
    return candidate.call(*args, **keywords)


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

    _stage_names: Tuple[str, ...] = field(default=(), compare=False)
    _received: Tuple[str, ...] = field(default=(), compare=False)
    _returned: Tuple[str, ...] = field(default=(), compare=False)
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
    if any(word in name.lower() for word in _NEVER):
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
            if name.startswith("_") or any(word in name.lower() for word in _NEVER):
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
            if name.startswith("_") or any(word in name.lower() for word in _NEVER):
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
        if name.startswith("_") or any(word in name.lower() for word in _NEVER):
            continue
        if name not in vars(owner) and not any(name in vars(base) for base in owner.__mro__):
            continue
        value = getattr(instance, name, None)
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


def _call(
    candidate: Candidate, positional: Sequence[Any], index: Optional[int] = None
) -> Tuple[bool, Any]:
    """Call one candidate under a clock. Any failure is just a no.

    ``positional`` is what the chain carries: the value, or the arguments a
    fixture is made of. Everything else the call needs -- the tuning, the
    side inputs, the item's identity -- is on the candidate as a plan, and is
    filled in here so that this call and the one a scored run makes later are
    produced by the same three lines.
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
    previous = signal.signal(signal.SIGALRM, _raise_timeout)
    signal.alarm(CALL_TIMEOUT_SECONDS)
    try:
        with _muted():
            return True, candidate.call(*args, **keywords)
    except BaseException:  # noqa: BLE001 - student code raises anything
        return False, None
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


@contextlib.contextmanager
def _muted():
    """Probe without the student's console.

    Their functions narrate: one prints every fingerprint it built, which is
    thousands of lines per call and tens of thousands across a search. Their
    output belongs to their run, not to ours, so probing captures it and
    throws it away. What a student sees is the report, which says what was
    tried and what came back.
    """

    saved_out, saved_err = sys.stdout, sys.stderr
    sys.stdout = io.StringIO()
    sys.stderr = io.StringIO()
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
    for candidate in _order_for(stage, candidates):
        bound: Optional[Candidate] = None
        value: Any = None
        which = None
        for index, form in enumerate(forms):
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

    if stage.folder:
        found = _from_a_folder(stage, candidate, positional)
        if found is not None:
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
            return shape, value
        if stage.per_item and not spread:
            ok, produced = _mapped(shape, positional)
            if ok and produced:
                element, offered = _pick_element(stage, produced)
                return replace(shape, per_item=True, element=element), offered
    for shape in shapes:
        for tuning in stage.tunings:
            trial = _tuned(shape, tuning)
            ok, value = _call(trial, positional)
            if ok and value is not None:
                return trial, value
    return None, None


#: Where a folder read is recorded while one dry probe runs, or None when
#: nothing is being watched. A module global because `sys.addaudithook` takes
#: a plain function and cannot be uninstalled: the hook is added at most once
#: per process and does nothing at all unless a probe is listening.
_WATCHED: Optional[List[str]] = None
_HOOK_INSTALLED = False

#: The throwaway directory the current search is probing from, and the only
#: directory anything here may write into. None outside a search.
_SCRATCH: Optional["Path"] = None

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
    trial = replace(candidate, self_only=True)
    with _watching() as seen:
        ok, value = _call(trial, ())
    if ok and value is not None:
        if _read_elsewhere(seen):
            return None
        # It has to have gone looking for a folder. Without this a
        # zero-argument call that reads nothing at all was accepted whenever
        # its return value happened to pass `produces`: with `aaa_factory()`
        # returning `[]` and a real folder reader sorted after it, the search
        # bound the factory and recorded no folder. Turning `folder=True` on
        # then widened the candidate set to every zero-argument callable in
        # the repository, which is not what this primitive is for.
        here = _folder_read_here(seen)
        if here is None:
            return None
        if stage.produces is None or _safe_produces(stage, value):
            supplied = dict(trial.supplied)
            supplied["folder"] = here
            return replace(trial, supplied=supplied), value
        return None
    name = _folder_wanted(seen)
    if name is None:
        return None
    if not _materialize(name, files):
        return None
    ok, value = _call(trial, ())
    if not ok or value is None:
        return None
    if stage.produces is not None and not _safe_produces(stage, value):
        return None
    supplied = dict(trial.supplied)
    supplied["folder"] = name
    return replace(trial, supplied=supplied), value


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


def _handoffs(upstream: Any) -> List[Tuple[Any, str]]:
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

    offers: List[Tuple[Any, str]] = [(upstream, "")]
    if isinstance(upstream, tuple) and upstream:
        # Spread, when the previous step returned exactly the arguments the
        # next one takes. One 2026 team's `adj_list` returns `(nodes, adj)`
        # and their `whispers(nodes, adj, iterations)` takes both, which is
        # the course's own design: "a list of nodes and an adjacency graph
        # ... together, represent your graph"
        # (docs/capstones/week2-vision-capstone.md:386). Nothing is
        # transformed; the tuple is handed over as the arguments it already
        # is.
        offers.append((_Spread(upstream), " (both parts)"))
        if len(upstream) == 2:
            # The same two parts the other way round. One 2026 team's
            # `adj_list` returns `(nodes, adj)` and their own
            # `connected_comps(adj, nodes)` takes them reversed, which is
            # their choice of parameter order and not a different answer.
            offers.append((_Spread((upstream[1], upstream[0])), " (both parts, reversed)"))
        # Every element, not only the first. `specgram` returns
        # `(spectrogram, freqs, times)` and one team's combined peak finder
        # returns `(peaks, freqs, times, spectrogram)`, where the part the
        # next stage wants is last. Each element is offered exactly as it was
        # returned, and the stage's own validator decides.
        seen = set()
        for element in upstream:
            marker = id(element)
            if marker in seen:
                continue
            seen.add(marker)
            offers.append((element, " (part of what it returned)"))
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
    for candidate in _order_for(stage, candidates):
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
        for offered, _note in _handoffs(upstream):
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
                        bound,
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

    with _scratch_cwd():
        if role.branches:
            return _resolve_branches(
                role,
                modules,
                fixture,
                verify=verify,
                beam=beam,
                seed=seed,
                extras=extras,
                identities=identities,
            )
        return _resolve_chain(
            role,
            modules,
            fixture,
            verify=verify,
            beam=beam,
            seed=seed,
            extras=extras,
            identities=identities,
        )


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
    fits, missing = _fits_of(role, candidates, pool, identities)
    if missing is not None:
        return None, Refusal(
            role.name,
            (),
            missing,
            "nothing produced the {} the later steps need".format(missing),
        )
    for branch in role.branches:
        binding, refusal = _resolve_chain(
            branch,
            modules,
            branch.fixture if branch.fixture is not None else fixture,
            verify=None,
            beam=beam,
            seed=seed,
            extras=pool,
            identities=identities,
            carried=carried,
        )
        if binding is None:
            assert refusal is not None
            return None, replace(
                refusal, role="{}.{}".format(role.name, branch.name)
            )
        chains[branch.name] = binding.steps
        fits = fits + list(binding.fits)
        # What this branch built, handed to the next one. `carried` existed
        # and was read by `_resolve_chain`, but nothing ever put anything in
        # it, so the shared instance pool this function's docstring describes
        # was empty every time: a prepare branch that constructs `Shared(rows)`
        # left the search branch unable to reach `Shared.search`, which is the
        # whole prepare-to-search shape of week 3.
        #
        # Only what a constructor stage actually produced, and only after the
        # branch was accepted. A method of an object no branch bound is not
        # something a later branch may call.
        for reached in binding._reach:
            if not any(held.label == reached.label for held in carried):
                carried.append(reached)
    if verify is None or verify(dict(chains)):
        return (
            Binding(
                role.name,
                (),
                fits=tuple(fits),
                branches=dict(chains),
                _stage_names=tuple(chains),
                _received=tuple("" for _ in chains),
                _returned=tuple("" for _ in chains),
            ),
            None,
        )
    last = role.branches[-1]
    return None, Refusal(
        role.name,
        tuple(step.label for step in chains[last.name]),
        last.stages[-1].name if last.stages else last.name,
        "the chain ran but did not return the right answer on the benchmark's own case",
        ran_to_the_end=True,
    )


def _fits_of(
    role: Role,
    candidates: Sequence[Candidate],
    pool: Dict[str, Any],
    identities: Sequence[Any],
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
        hit = _fit(stage, candidates, pool, identities)
        if hit is None:
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
    return hits[0] if hits else None


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

    def _build() -> Any:
        return _invoke(candidate, arguments)

    return tuple(methods_of(candidate.label, value, build=_build))


@contextlib.contextmanager
def _scratch_cwd():
    """Probe from a throwaway directory.

    Probing calls student functions, and their functions write: one audited
    repository rewrites a relative ``db.pkl`` on every add, and probing two
    repositories left ``db.pkl`` and ``songs.pkl`` in this checkout. Discovery
    already imports from scratch; the calls that follow it must too.
    """

    global _SCRATCH

    previous = os.getcwd()
    was = _SCRATCH
    with tempfile.TemporaryDirectory(prefix="cogworks-probe-") as temporary:
        os.chdir(temporary)
        _SCRATCH = Path(temporary).resolve()
        try:
            yield
        finally:
            _SCRATCH = was
            os.chdir(previous)


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
) -> Resolution:
    random.seed(seed)
    pool: Dict[str, Any] = dict(extras or {})
    candidates = callables_in(modules)
    # Classes that demand their data up front are steps, not containers, and
    # they only reach the search here. `callables_in` is untouched, so the
    # store-and-query pairing search below still sees plain functions only.
    candidates = candidates + constructors_in(modules)
    if carried:
        candidates = candidates + list(carried)
    if not candidates:
        return None, Refusal(role.name, (), role.stages[0].name, "no functions to try")

    # The side inputs their own code computes, once, before anything else
    # runs. Each joins the pool under its stage's name, which is how a later
    # stage asks for it (`Stage.extras`).
    fits, missing = _fits_of(role, candidates, pool, identities)
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
            first, candidates, fixture, extras=pool, identities=identities
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
            second, candidates, fixture, extras=pool, identities=identities
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
        )

    furthest: Tuple[str, ...] = (frontier[0].chain[0].label,)
    last_returned = frontier[0].returned[-1]
    stalled_at = role.stages[1].name if len(role.stages) > 1 else first.name

    for stage in role.stages[1:]:
        nxt: List[_Partial] = []
        # A chain that already absorbed this stage while probing skips it.
        done = [p for p in frontier[:beam] if p.stages[-1].endswith("+ " + stage.name)]
        for partial in frontier[:beam]:
            reachable = list(candidates) + list(partial.reach)
            for candidate, produced, passed in extend(
                stage, reachable, partial.value, extras=pool, identities=identities
            ):
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
                    )
                )
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
                    identities=identities,
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
                    nxt.append(
                        _Partial(
                            partial.chain + (replace(candidate, in_place=True),),
                            passed,
                            partial.received + (describe(passed),),
                            partial.returned + ("the value it was given, updated in place",),
                            partial.stages + (stage.name,),
                            partial.reach,
                        )
                    )
        # A step the previous function already did. Carrying the frontier
        # forward unchanged lets the next stage read what that function
        # returned, which is how a fused pair is found: their combined
        # function has already produced this stage's output. The stage name
        # joins the step that absorbed it, so the report names both.
        # A chain whose last step already produced this stage's answer is
        # complete. One 2026 team ends at `connected_comps`, which is both
        # their graph reader and their answer; requiring another function
        # after it would refuse a finished pipeline.
        if stage.fusible:
            for partial in frontier[:beam]:
                if _safe_produces(stage, partial.value):
                    nxt.append(
                        _Partial(
                            partial.chain,
                            partial.value,
                            partial.received,
                            partial.returned,
                            partial.stages[:-1]
                            + ("{} + {}".format(partial.stages[-1], stage.name),),
                            partial.reach,
                        )
                    )
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

        nxt.sort(key=_rank)
        nxt = done + nxt
        if not nxt:
            return None, Refusal(
                role.name,
                furthest,
                stage.name,
                "nothing accepted what {} returned".format(
                    furthest[-1] if furthest else "the last step"
                ),
                last_returned=last_returned,
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
    for partial in frontier:
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
            )
            for step in partial.chain
        )
        if key in asked:
            continue
        asked.add(key)
        if verify is None or verify(partial.chain):
            return (
                Binding(
                    role.name,
                    partial.chain,
                    fits=tuple(fits),
                    _stage_names=partial.stages,
                    _received=partial.received,
                    _returned=partial.returned,
                    _reach=partial.reach,
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
