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
import signal
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

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


@dataclass(frozen=True)
class Role:
    """A pipeline the benchmark needs: an ordered list of stages."""

    name: str
    stages: Tuple[Stage, ...]


class _Spread(tuple):
    """A tuple to pass as several arguments rather than as one value."""


class Fixtures(tuple):
    """Several forms of one benchmark input, tried in order.

    A plain tuple stays a single argument list, so nothing that passes one
    changes behavior. This subclass says "these are alternatives", which is
    the only way to tell the two apart without a flag.
    """


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

    _stage_names: Tuple[str, ...] = field(default=(), compare=False)
    _received: Tuple[str, ...] = field(default=(), compare=False)
    _returned: Tuple[str, ...] = field(default=(), compare=False)


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


def rebuilder_for(instance: Any) -> Optional[Callable[[], Any]]:
    """A way to build another object like this one, or None.

    Only for a class that constructs with no arguments, which is the only kind
    `instances_in` builds in the first place.
    """

    owner = type(instance)

    def _build() -> Any:
        return owner()

    return _build


def methods_of(label: str, instance: Any) -> List[Candidate]:
    """The bound methods of one constructed object, as candidates."""

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
                rebuild=_method_rebuilder(instance, name),
            )
        )
    return found


def _method_rebuilder(instance: Any, name: str) -> Callable[[], Any]:
    """Take the same method off a newly built object of the same class."""

    owner = type(instance)

    def _fresh() -> Any:
        return getattr(owner(), name)

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


def _call(candidate: Candidate, args: Sequence[Any]) -> Tuple[bool, Any]:
    """Call one candidate under a clock. Any failure is just a no."""

    try:
        inspect.signature(candidate.call).bind(*args)
    except (TypeError, ValueError):
        return False, None
    previous = signal.signal(signal.SIGALRM, _raise_timeout)
    signal.alarm(CALL_TIMEOUT_SECONDS)
    try:
        with _muted():
            return True, candidate.call(*args)
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
    stage: Stage, candidates: Sequence[Candidate], fixture: Sequence[Any]
) -> List[Tuple[Candidate, Any]]:
    """Which candidates accept the benchmark's own input and return something.

    Only the first stage of a role is probed this way, because only the first
    stage has an input the benchmark can honestly manufacture. Everything after
    it is reached by ``extend``.
    """

    accepted: List[Tuple[Candidate, Any]] = []
    # A benchmark may offer its input in more than one form. Week 2's photos
    # are arrays, and the capstone document tells students to write a function
    # taking image paths, so all three audited teams did. The same photos
    # either way; which form their function takes is theirs to decide, and
    # refusing the one the course taught would be our contract failing them.
    forms = fixture if isinstance(fixture, Fixtures) else (fixture,)
    for candidate in _order_for(stage, candidates):
        for form in forms:
            ok, value = _call(candidate, form)
            if ok and value is not None:
                break
            if stage.per_item:
                ok, value = _mapped(candidate, form)
                if ok and value is not None:
                    break
            for tuning in stage.tunings:
                ok, value = _call(candidate, tuple(form) + (tuning,))
                if ok and value is not None:
                    break
            if ok and value is not None:
                break
        if not ok or value is None:
            continue
        # The same reading `extend` applies downstream. One team's first
        # function returns `(peaks, freqs, times, spectrogram)`, so requiring
        # the whole return value to look like a spectrogram refused a
        # function that had plainly done the work.
        if stage.produces is None or _safe_produces(stage, value):
            accepted.append((candidate, value))
    return accepted


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
    for item in items:
        ok, value = _call(candidate, (item,) + rest)
        if not ok or value is None:
            return False, None
        produced.append(value)
    return True, produced


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
) -> List[Tuple[Candidate, Any, Any]]:
    """Feed one stage's real output to the next stage, unchanged.

    ``upstream`` is passed as it was returned, or as its first element when it
    is a tuple; see ``_handoffs``. Nothing is rescaled or reshaped.
    """

    accepted: List[Tuple[Candidate, Any]] = []
    for candidate in _order_for(stage, candidates):
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
            ok, value = _call(candidate, base)
            if (not ok or value is None) and stage.per_item and not isinstance(offered, _Spread):
                ok, value = _mapped(candidate, base)
            for tuning in stage.tunings:
                if ok and value is not None:
                    break
                ok, value = _call(candidate, base + (tuning,))
            if not ok or value is None:
                continue
            if accept_any or stage.produces is None or _safe(stage.produces, value):
                accepted.append(
                    (candidate, value, tuple(offered) if isinstance(offered, _Spread) else offered)
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
) -> Resolution:
    """Find a chain of the student's functions that performs ``role``.

    Search is a beam over real values: probe the first stage with the fixture,
    then extend each surviving partial chain by feeding its actual output
    forward. ``verify`` is the only thing that can accept a complete chain, and
    it is expected to run the benchmark's own end-to-end case.

    Returns the binding, or a refusal naming the furthest point reached.
    """

    with _scratch_cwd():
        return _resolve_chain(role, modules, fixture, verify=verify, beam=beam, seed=seed)


@contextlib.contextmanager
def _scratch_cwd():
    """Probe from a throwaway directory.

    Probing calls student functions, and their functions write: one audited
    repository rewrites a relative ``db.pkl`` on every add, and probing two
    repositories left ``db.pkl`` and ``songs.pkl`` in this checkout. Discovery
    already imports from scratch; the calls that follow it must too.
    """

    previous = os.getcwd()
    with tempfile.TemporaryDirectory(prefix="cogworks-probe-") as temporary:
        os.chdir(temporary)
        try:
            yield
        finally:
            os.chdir(previous)


def _resolve_chain(
    role: Role,
    modules: Sequence[Any],
    fixture: Sequence[Any],
    *,
    verify: Optional[Callable[[Sequence[Candidate]], bool]] = None,
    beam: int = BEAM_WIDTH,
    seed: int = 0,
) -> Resolution:
    random.seed(seed)
    candidates = callables_in(modules)
    if not candidates:
        return None, Refusal(role.name, (), role.stages[0].name, "no functions to try")

    first = role.stages[0]
    from .verdict import describe

    first_form = fixture[0] if isinstance(fixture, Fixtures) else fixture
    fixture_summary = ", ".join(describe(item) for item in first_form)

    # Each entry carries the chain, the value it last produced, and what every
    # step received and returned along the way. The trace is not decoration: a
    # chain that runs and answers wrongly is a bug in their pipeline, and the
    # only useful thing the platform can offer is the smallest reproduction it
    # has -- which of their functions ran, on what, and what came back.
    frontier: List[_Partial] = [
        _Partial((candidate,), value, (fixture_summary,), (describe(value),), (first.name,))
        for candidate, value in probe_sources(first, candidates, fixture)
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
        for candidate, value in probe_sources(second, candidates, fixture):
            if candidate.label in seen:
                continue
            frontier.append(
                _Partial(
                    (candidate,),
                    value,
                    (fixture_summary,),
                    (describe(value),),
                    ("{} + {}".format(first.name, second.name),),
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
            for candidate, produced, passed in extend(stage, candidates, partial.value):
                nxt.append(
                    _Partial(
                        partial.chain + (candidate,),
                        produced,
                        # What this step actually received, which is the whole
                        # upstream value or one element unpacked from it.
                        partial.received + (describe(passed),),
                        partial.returned + (describe(produced),),
                        partial.stages + (stage.name,),
                    )
                )
            if stage.in_place:
                # Their function ran on the graph and left the answer there.
                # The graph goes forward so one more of their own functions
                # can read it; nothing here inspects or rebuilds it.
                for candidate, _produced, passed in extend(
                    stage, candidates, partial.value, accept_any=True
                ):
                    nxt.append(
                        _Partial(
                            partial.chain + (candidate,),
                            passed,
                            partial.received + (describe(passed),),
                            partial.returned + ("the value it was given, updated in place",),
                            partial.stages + (stage.name,),
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
                        )
                    )
        # A chain that reached this stage's own answer goes first. Otherwise
        # the beam keeps whichever branch was found earliest, and one 2026
        # team's `whispers` -- which returns how the component count moved and
        # leaves the labels on the graph -- crowded out their
        # `connected_comps`, which returns the answer.
        nxt.sort(key=lambda p: 0 if _safe_produces(stage, p.value) else 1)
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

    for partial in frontier[:beam]:
        if verify is None or verify(partial.chain):
            return (
                Binding(
                    role.name,
                    partial.chain,
                    _stage_names=partial.stages,
                    _received=partial.received,
                    _returned=partial.returned,
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
