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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

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
from .verdict import Verdict, not_read, not_wired, nothing_here

__all__ = ["Submission", "Attempt", "resolve"]

#: How many (store, query, arrangement) pairings to try before giving up.
#: KrazeeCoder's database needs 3962 and carti4ce's 35, so the ceiling is set
#: well above both: a repository is refused for having no working pairing, not
#: for having an unusual one that sits late in the order.
MAX_ATTEMPTS = 20000


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

    @property
    def ready(self) -> bool:
        return self.enroll is not None and self.query is not None

    def to_dict(self) -> Dict[str, object]:
        """What the run records, and what every surface renders from."""

        record: Dict[str, object] = {
            "verdict": self.verdict.to_dict(),
            "attemptsTried": self.attempts_tried,
            "chain": [step.label for step in self.chain],
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
    arrangements: Callable[[Callable[..., Any], str, Any], Sequence[Callable[[], Any]]],
    hints: Sequence[str] = (),
    declared_root: Optional[str] = None,
    max_attempts: int = MAX_ATTEMPTS,
    progress: Optional[Progress] = None,
) -> Submission:
    """Resolve one repository against one week's task.

    ``chain_role`` and ``fixture`` describe the shared half of the pipeline --
    for Week 1, audio in and fingerprints out. ``accepts`` is the week's own
    end-to-end test, and ``arrangements`` enumerates the ways a store might
    want one item offered to it. Everything else is the same for every week.
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
                    next_step=_next_step_for(worst.reason, worst.missing),
                ),
                discovery=found,
            )
        return Submission(nothing_here(repository.name), discovery=found)

    watcher.phase("Looking for the functions that fingerprint a song")
    chain, refusal = resolve_chain(chain_role, found.namespace, fixture)
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
                next_step=_next_step_for_stall(found),
            ),
            discovery=found,
        )

    for step, stage in zip(chain.steps, chain_role.stages):
        watcher.found(stage.name, step.label)

    candidates = _store_candidates(found, chain)
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
            if ok:
                watcher.attempts(tried, tried)
                watcher.done()
                return Submission(
                    _scored_placeholder(chain),
                    discovery=found,
                    chain=chain.steps,
                    attempt=Attempt(store.label, ask.label, index),
                    attempts_tried=tried,
                    enroll=_enroll,
                    query=ask.call,
                )
        if tried >= max_attempts:
            break

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


def _next_step_for(reason: str, missing: Optional[str]) -> str:
    """The one thing worth doing about an import that failed.

    Named only where the platform honestly knows it. A missing package is ours
    to name; a module that raises is theirs to read, and pretending otherwise
    would be guessing at their code.
    """

    if reason == "missing_dependency" and missing:
        return (
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


def _next_step_for_stall(found: Discovery) -> str:
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
    if missing:
        modules = [entry.name for entry in found.skipped if entry.missing]
        return (
            "{} did not import, because {} not installed here. If the function "
            "the benchmark is looking for lives in one of them, add {} to a "
            "requirements.txt at the root of your repository."
        ).format(
            _listed(modules),
            "{} is".format(missing[0]) if len(missing) == 1 else "{} are".format(_listed(missing)),
            _listed(missing),
        )
    return ""


def _listed(items: Sequence[str]) -> str:
    """A readable list: one, two and three, or one, two, and three."""

    items = list(items)
    if len(items) <= 1:
        return items[0] if items else ""
    if len(items) == 2:
        return "{} and {}".format(*items)
    return "{}, and {}".format(", ".join(items[:-1]), items[-1])
