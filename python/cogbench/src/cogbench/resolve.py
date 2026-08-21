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

The search is bounded by attempts rather than by names. Every pairing tried is
counted and reported, so a repository that takes four thousand attempts and one
that takes thirty-five are both explicable, and a search that gives up says how
hard it looked.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Sequence, Tuple

from . import memo
from .discover import Discovery, discover
from .progress import Progress
from .pipeline import (
    Candidate,
    Role,
    callables_in,
    instances_in,
    methods_of,
    resolve_chain,
)
from .verdict import SCORED, Verdict, not_read, not_wired, nothing_here

__all__ = ["Submission", "Attempt", "resolve"]

#: How many (store, query, arrangement) pairings to try before giving up.
#: KrazeeCoder's database needs 3962 and carti4ce's 35, so the ceiling is set
#: well above both: a repository is refused for having no working pairing, not
#: for having an unusual one that sits late in the order.
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


@dataclass
class Submission:
    """A repository resolved into something the benchmark can run.

    ``verdict`` is always present. ``ready`` says whether there is anything to
    score; everything else is the evidence behind that.
    """

    verdict: Verdict
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

    #: The candidates behind ``enroll`` and ``query``, kept so a scoring run
    #: can start from an empty database. Not part of the record.
    _store: Optional[Candidate] = None
    _ask: Optional[Candidate] = None
    _arrange: Optional[Callable[..., Sequence[Callable[[], Any]]]] = None

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
        return bool(self.chain) and self.verdict.status == SCORED

    def fresh(self) -> "Submission":
        """The same binding, against a database with nothing in it yet.

        Proving a binding works means enrolling two fixture songs into it, and
        when a team's database is an object rather than a file, those songs are
        still in it afterwards. Scoring from there put `fixture_a` in the
        ranked results for real queries and cost one 2026 team half its score.

        A new object is built and both methods are taken off that same one, so
        what stores and what answers are the same database. When the binding is
        plain module functions there is nothing to rebuild and this returns
        itself: a module-level dict or a pickle file is emptied by the driver's
        own scratch directory, which is where their file already lands.
        """

        if self._store is None or self._ask is None:
            return self
        if self._store.rebuild is None and self._ask.rebuild is None:
            return self

        store = self._store.rebuild() if self._store.rebuild else self._store.call
        ask = self._ask.rebuild() if self._ask.rebuild else self._ask.call
        # One object, not two. Rebuilding each separately gives a store and a
        # query looking at different databases, which answers nothing.
        owner = getattr(store, "__self__", None)
        if owner is not None and self._ask.rebuild is not None:
            ask = getattr(owner, self._ask.label.rsplit(".", 1)[-1], ask)

        index = self.attempt.arrangement if self.attempt else 0
        arrange = self._arrange

        def _enroll(song_id: str, item: Any) -> Any:
            if arrange is None:
                return store(song_id, item)
            return arrange(store, song_id, item)[index]()

        return replace(self, enroll=_enroll, query=ask)

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
        if self.discovery is not None:
            record["discovery"] = self.discovery.to_dict()
        return record


def resolve(
    repository: Path,
    *,
    chain_role: Role,
    fixture: Sequence[Any],
    accepts: Callable[..., Tuple[bool, str]],
    arrangements: Optional[
        Callable[[Callable[..., Any], str, Any], Sequence[Callable[[], Any]]]
    ] = None,
    hints: Sequence[str] = (),
    declared_root: Optional[str] = None,
    max_attempts: int = MAX_ATTEMPTS,
    progress: Optional[Progress] = None,
    remember: bool = False,
    benchmark: str = "",
) -> Submission:
    """Resolve one repository against one week's task.

    ``chain_role`` and ``fixture`` describe the pipeline the week asks for.
    ``accepts`` is the week's own end-to-end test, and it is the only thing
    that can accept a binding.

    ``arrangements`` is for a week whose task ends in a database: it enumerates
    the ways a store might want one item offered to it, and the search then
    tries pairs of their functions until one stores a thing and names it back.
    A week without one is complete when its chain is, which is Week 2: photos
    in, one label per photo out, nothing kept between calls.

    ``remember`` writes the binding into the repository and reuses it while
    their code is unchanged. It is off by default, because a graded run should
    search: the point of an official score is that it was computed, not
    recalled. ``cogworks check`` turns it on, since that is the command a
    student runs every few minutes.
    """

    watcher = progress or Progress()
    repository = Path(repository).resolve()

    watcher.phase("Reading your repository")
    found = discover(repository, hints=hints, declared_root=declared_root)
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
            return Submission(
                not_read(
                    worst.name,
                    worst.detail,
                    next_step=_next_step_for(worst.reason, worst.missing, benchmark),
                ),
                discovery=found,
            )
        return Submission(nothing_here(repository.name), discovery=found)

    key = (
        memo.fingerprint(memo.source_paths(found), benchmark=benchmark)
        if remember
        else ""
    )
    if key:
        recalled = _replay(memo.read(repository, key), found, chain_role, arrangements)
        if recalled is not None:
            watcher.done()
            return recalled

    watcher.phase("Looking for the functions that do the work")
    # A week with no database is complete when its chain is, so the week's
    # acceptance test is the verifier and there is nothing to pair afterwards.
    verify = None
    if arrangements is None:
        verify = lambda steps: bool(accepts(steps, *fixture)[0])  # noqa: E731
    chain, refusal = resolve_chain(chain_role, found.namespace, fixture, verify=verify)
    if chain is None:
        watcher.done()
        assert refusal is not None
        # The refusal carries how far the search got. Reporting only the stage
        # that stalled would say "the spectrogram step found nothing" for a
        # repository whose spectrogram was found and whose peak finder was not.
        reached = tuple(
            _step_note(stage, label)
            for stage, label in zip(
                (stage.name for stage in chain_role.stages), refusal.furthest
            )
        )
        return Submission(
            not_wired(
                chain_role.name,
                refusal.stage,
                reached,
                last_returned=refusal.last_returned,
                next_step=_next_step_for_stall(found, benchmark),
            ),
            discovery=found,
        )

    for step, stage in zip(chain.steps, chain_role.stages):
        watcher.found(stage.name, step.label)

    if arrangements is None:
        watcher.done()
        if key:
            memo.write(
                repository,
                key,
                {"chain": [step.label for step in chain.steps], "arrangement": -1},
            )
        return Submission(
            _scored_placeholder(chain),
            discovery=found,
            chain=chain.steps,
            attempts_tried=0,
            enroll=None,
            query=None,
        )

    candidates = _store_candidates(found, chain)
    # More than one of their functions can pass. One 2026 team wrote `query`,
    # which returns the winning song, and `query_details`, which returns the
    # same winner plus the full vote tally. Both name the right song, so both
    # pass, and the benchmark asks for a ranked list -- so taking whichever
    # was reached first cost that team every metric that reads below rank 1.
    #
    # The week's own acceptance test says how completely a pairing answered,
    # by returning a number rather than a bare pass. The search keeps the best
    # it has seen and stops as soon as one answers fully. Their algorithm is
    # untouched: this decides which of their functions to ask, never what the
    # answer should be.
    best: Optional[Tuple[float, Candidate, Candidate, int, int]] = None
    arrangement_count = len(arrangements(lambda *_: None, "", None))
    # The whole search is enumerable before it starts, so the bar can be
    # honest: every ordered pair of distinct candidates, times the ways one
    # item can be handed to a store. Nothing here is extrapolated.
    total = min(
        len(candidates) * max(len(candidates) - 1, 0) * arrangement_count, max_attempts
    )
    watcher.phase(
        "Trying your functions to find which pair stores a song and names it back"
    )
    tried = 0
    for store, ask in itertools.product(candidates, candidates):
        if store is ask:
            continue
        for index in range(arrangement_count):
            if tried >= max_attempts:
                break
            tried += 1
            watcher.attempts(tried, total)

            def _enroll(song_id: str, item: Any, _s=store, _i=index) -> Any:
                return arrangements(_s.call, song_id, item)[_i]()

            ok, _detail = accepts(chain.steps, _enroll, lambda item, _a=ask: _a.call(item))
            grade = float(ok)
            if grade > 0 and (best is None or grade > best[0]):
                best = (grade, store, ask, index, tried)
            if best is not None and best[0] >= FULLY_ANSWERED:
                break
        if best is not None and best[0] >= FULLY_ANSWERED:
            break
        if tried >= max_attempts:
            break

    if best is not None:
        _grade, store, ask, index, at = best

        def _enroll(song_id: str, item: Any, _s=store, _i=index) -> Any:
            return arrangements(_s.call, song_id, item)[_i]()

        watcher.attempts(tried, tried)
        watcher.done()
        if key:
            memo.write(
                repository,
                key,
                {
                    "chain": [step.label for step in chain.steps],
                    "enroll": store.label,
                    "query": ask.label,
                    "arrangement": index,
                    "attemptsTried": at,
                },
            )
        return Submission(
            _scored_placeholder(chain),
            discovery=found,
            chain=chain.steps,
            attempt=Attempt(store.label, ask.label, index),
            attempts_tried=at,
            enroll=_enroll,
            query=ask.call,
            _store=store,
            _ask=ask,
            _arrange=arrangements,
        )

    watcher.done()
    return Submission(
        not_wired(
            "identification",
            "database",
            chain.observations(),
            next_step=(
                "The benchmark found your fingerprinting but no pair of functions "
                "that stores a song and then names it back."
            ),
        ),
        discovery=found,
        chain=chain.steps,
        attempts_tried=tried,
    )


def _replay(
    stored: Optional[Dict[str, Any]],
    found: Discovery,
    chain_role: Role,
    arrangements: Callable[..., Sequence[Callable[[], Any]]],
) -> Optional[Submission]:
    """Rebind a remembered result, or return None and let the search run.

    A stored entry is names, not functions, so this looks each one up in the
    namespace that was just imported. Any name that no longer resolves means
    their code moved, and the honest response is to search again rather than
    to report a binding that no longer exists.
    """

    if not stored:
        return None

    # A week with no database: the chain is the whole binding.
    if int(stored.get("arrangement", 0)) < 0:
        by_label = {c.label: c for c in callables_in(found.namespace)}
        for label, instance in instances_in(found.namespace):
            by_label.update({c.label: c for c in methods_of(label, instance)})
        try:
            steps = tuple(by_label[label] for label in stored["chain"])
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
        return Submission(
            _scored_placeholder(chain),
            discovery=found,
            chain=steps,
            recalled=True,
        )

    by_label = {c.label: c for c in callables_in(found.namespace)}
    for label, instance in instances_in(found.namespace):
        by_label.update({c.label: c for c in methods_of(label, instance)})

    try:
        steps = tuple(by_label[label] for label in stored["chain"])
        store = by_label[stored["enroll"]]
        ask = by_label[stored["query"]]
        index = int(stored["arrangement"])
    except (KeyError, TypeError, ValueError):
        return None

    def _enroll(song_id: str, item: Any) -> Any:
        return arrangements(store.call, song_id, item)[index]()

    from .pipeline import Binding

    chain = Binding(
        chain_role.name,
        steps,
        _stage_names=tuple(stage.name for stage in chain_role.stages),
        _received=tuple("" for _ in steps),
        _returned=tuple("" for _ in steps),
    )
    return Submission(
        _scored_placeholder(chain),
        discovery=found,
        chain=steps,
        attempt=Attempt(store.label, ask.label, index),
        attempts_tried=int(stored.get("attemptsTried", 0)),
        enroll=_enroll,
        query=ask.call,
        recalled=True,
        _store=store,
        _ask=ask,
        _arrange=arrangements,
    )


def _scored_placeholder(chain) -> Verdict:
    """Resolution succeeded; the benchmark supplies the real verdict.

    Kept deliberately plain: this module found the code, and what the code is
    worth is the scorer's sentence to write, not discovery's.
    """

    from .verdict import SCORED, Verdict as _Verdict

    return _Verdict(
        SCORED,
        "Your code is wired up and ready to score.",
        chain.observations(),
    )


def _store_candidates(found: Discovery, chain) -> List[Candidate]:
    """Everything that could be a database, minus the pipeline already bound.

    Module functions first, then the methods of any class the team wrote that
    builds with no arguments. The chain's own steps are excluded: a
    fingerprinter is not a database, and trying it as one wastes attempts on
    a pairing that cannot work.
    """

    used = {step.label for step in chain.steps}
    candidates = [c for c in callables_in(found.namespace) if c.label not in used]
    for label, instance in instances_in(found.namespace):
        candidates.extend(methods_of(label, instance))
    return candidates


def _graded_packages(benchmark: str) -> FrozenSet[str]:
    """Import names the graded run installs for this benchmark.

    Read from `cogbench.environment`, which is generated from the same data
    the images are built from, rather than kept as a second list here. It used
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

    Their code is fine and the graded run has this package. What they are
    looking at is their own environment, so the step is to install it, not to
    declare it.
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
    # this track's image carries is missing from this laptop and present in the
    # graded run, so the fix is to install it. Anything else is theirs to
    # declare, and declaring it is what makes the graded run work.
    #
    # Per track, not global: the graded environment is three different images,
    # and "the graded run has it" is false for at least one of them for almost
    # any package. See `_graded_packages`.
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
