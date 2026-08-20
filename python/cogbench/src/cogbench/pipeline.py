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

import inspect
import itertools
import random
import signal
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


@dataclass(frozen=True)
class Role:
    """A pipeline the benchmark needs: an ordered list of stages."""

    name: str
    stages: Tuple[Stage, ...]


@dataclass(frozen=True)
class Candidate:
    """One callable that might serve one stage."""

    label: str
    call: Callable[..., Any]
    module: str


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
        return True, candidate.call(*args)
    except BaseException:  # noqa: BLE001 - student code raises anything
        return False, None
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def probe_sources(
    stage: Stage, candidates: Sequence[Candidate], fixture: Sequence[Any]
) -> List[Tuple[Candidate, Any]]:
    """Which candidates accept the benchmark's own input and return something.

    Only the first stage of a role is probed this way, because only the first
    stage has an input the benchmark can honestly manufacture. Everything after
    it is reached by ``extend``.
    """

    accepted: List[Tuple[Candidate, Any]] = []
    for candidate in _order_for(stage, candidates):
        ok, value = _call(candidate, fixture)
        if not ok or value is None:
            continue
        if stage.produces is None or _safe(stage.produces, value):
            accepted.append((candidate, value))
    return accepted


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
        offers.append((upstream[0], " (first element)"))
    return offers


def extend(
    stage: Stage,
    candidates: Sequence[Candidate],
    upstream: Any,
    extra: Sequence[Any] = (),
) -> List[Tuple[Candidate, Any, Any]]:
    """Feed one stage's real output to the next stage, unchanged.

    ``upstream`` is passed as it was returned, or as its first element when it
    is a tuple; see ``_handoffs``. Nothing is rescaled or reshaped.
    """

    accepted: List[Tuple[Candidate, Any]] = []
    for candidate in _order_for(stage, candidates):
        for offered, _note in _handoffs(upstream):
            if stage.accepts is not None and not _safe(stage.accepts, offered):
                continue
            ok, value = _call(candidate, (offered,) + tuple(extra))
            if not ok or value is None:
                continue
            if stage.produces is None or _safe(stage.produces, value):
                accepted.append((candidate, value, offered))
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

    random.seed(seed)
    candidates = callables_in(modules)
    if not candidates:
        return None, Refusal(role.name, (), role.stages[0].name, "no functions to try")

    first = role.stages[0]
    from .verdict import describe

    fixture_summary = ", ".join(describe(item) for item in fixture)

    # Each entry carries the chain, the value it last produced, and what every
    # step received and returned along the way. The trace is not decoration: a
    # chain that runs and answers wrongly is a bug in their pipeline, and the
    # only useful thing the platform can offer is the smallest reproduction it
    # has -- which of their functions ran, on what, and what came back.
    frontier: List[Tuple[Tuple[Candidate, ...], Any, Tuple[str, ...], Tuple[str, ...]]] = [
        ((candidate,), value, (fixture_summary,), (describe(value),))
        for candidate, value in probe_sources(first, candidates, fixture)
    ]
    if not frontier:
        return None, Refusal(
            role.name,
            (),
            first.name,
            "nothing accepted the {} the benchmark passes".format(
                "arguments" if first.arity > 1 else "input"
            ),
        )

    furthest: Tuple[str, ...] = (frontier[0][0][0].label,)
    last_returned = frontier[0][3][-1]
    stalled_at = role.stages[1].name if len(role.stages) > 1 else first.name

    for stage in role.stages[1:]:
        nxt: List[Tuple[Tuple[Candidate, ...], Any, Tuple[str, ...], Tuple[str, ...]]] = []
        for chain, value, received, returned in frontier[:beam]:
            for candidate, produced, passed in extend(stage, candidates, value):
                nxt.append(
                    (
                        chain + (candidate,),
                        produced,
                        # What this step actually received, which is the whole
                        # upstream value or the element unpacked from it.
                        received + (describe(passed),),
                        returned + (describe(produced),),
                    )
                )
        if not nxt:
            return None, Refusal(
                role.name,
                furthest,
                stage.name,
                "nothing accepted what {} returned ({})".format(
                    furthest[-1] if furthest else "the last step", last_returned
                ),
            )
        frontier = nxt
        furthest = tuple(step.label for step in frontier[0][0])
        last_returned = frontier[0][3][-1]
        stalled_at = stage.name

    stage_names = tuple(stage.name for stage in role.stages)
    for chain, _value, received, returned in frontier[:beam]:
        if verify is None or verify(chain):
            return (
                Binding(
                    role.name,
                    chain,
                    _stage_names=stage_names,
                    _received=received,
                    _returned=returned,
                ),
                None,
            )

    return None, Refusal(
        role.name,
        furthest,
        stalled_at,
        "the chain ran but did not return the right answer on the benchmark's own case",
    )
