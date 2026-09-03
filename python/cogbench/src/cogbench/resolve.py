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
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Sequence, Tuple

from . import memo
from .discover import Discovery, discover
from .isolate import hash_seed_in_effect as _hash_seed_in_effect
from .progress import Progress
from .pipeline import (
    Candidate,
    Fixtures,
    Role,
    callables_in,
    constructors_in,
    identities_for,
    instances_in,
    methods_of,
    resolve_chain,
)
from .verdict import (
    SCORED,
    Verdict,
    not_read,
    not_wired,
    nothing_here,
    wired_but_wrong,
)

__all__ = ["Submission", "Attempt", "resolve", "from_spec"]

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

    #: For a week whose role is several branches over one shared pool, each
    #: branch's bound chain. Empty for a single-chain week, which is every
    #: week before week 3.
    branches: Dict[str, Tuple[Candidate, ...]] = field(default_factory=dict)
    #: The side inputs their own code computed once, as (stage name,
    #: candidate). Recorded because they were supplied to every later call
    #: and a run page has to be able to say so.
    fits: Tuple[Tuple[str, Candidate], ...] = ()

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
        if (
            self._store.rebuild is None
            and self._ask.rebuild is None
            and self._factory is None
        ):
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
        # Their own empty database, made again. One 2026 team writes
        # `create_database()` and then `add_fingerprints(db, id, fps)` and
        # `query_database(db, fps)`, so the object is an argument rather than
        # a module global; scoring from the one the search filled would leave
        # the fixture songs competing with the benchmark's catalog.
        held = self._factory.call() if self._factory is not None else None
        readers = self._readers

        def _enroll(song_id: str, item: Any) -> Any:
            target = store if held is None else _leading(store, held)
            if arrange is None:
                return target(song_id, item)
            return arrange(target, song_id, item)[index]()

        def _query(item: Any) -> Any:
            answer = ask(item) if held is None else ask(held, item)
            for reader in readers:
                answer = reader.call(answer)
            return answer

        return replace(self, enroll=_enroll, query=_query)

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
        supplied = _supplied_by(self)
        if supplied:
            # Everything the benchmark handed their code that did not come out
            # of their code. A run page shows this under "supplied", because a
            # score computed with a resource we provided is a different claim
            # from one computed without it.
            record["supplied"] = supplied
        if self.branches:
            record["branches"] = {
                name: [step.label for step in steps]
                for name, steps in sorted(self.branches.items())
            }
        if self.fits:
            record["fits"] = [[name, step.label] for name, step in self.fits]
        if self._factory is not None:
            record["factory"] = self._factory.label
        if self._readers:
            record["readers"] = [reader.label for reader in self._readers]
        # Two runs of the same repository must agree, and a dict iteration
        # order that moves between processes is the one input to their code
        # nobody chose. Recorded rather than asserted: this interpreter's
        # randomisation cannot be changed after it started, so the honest
        # thing is to say what it was. `cogbench.isolate` pins it for the
        # child, which is where discovery actually runs.
        record["hashRandomization"] = bool(sys.flags.hash_randomization)
        # And the seed itself, because "randomization was off" is not enough
        # to reproduce a run: two pinned runs under different seeds are two
        # different programs. Null when the interpreter chose its own, which
        # it does not expose -- see `isolate.hash_seed_in_effect`. A reader
        # can then tell "pinned at 0" from "we do not know", which the
        # boolean alone could not.
        record["hashSeed"] = _hash_seed_in_effect()
        return record


def _leading(call: Callable[..., Any], held: Any) -> Callable[..., Any]:
    """Their function with their own database object as its first argument."""

    return lambda *args, **keywords: call(held, *args, **keywords)


def _supplied_by(submission: "Submission") -> List[Dict[str, object]]:
    """Everything a step was given beyond the value the chain carried.

    Read off the bindings rather than accumulated as the search runs, so it
    cannot drift from what was actually called: the plan on each step IS the
    argument list, and this is that list in words.
    """

    found: List[Dict[str, object]] = []
    steps = list(submission.chain)
    for chain in submission.branches.values():
        steps.extend(chain)
    for step in steps:
        found.extend(_given_to(step))
    for name, step in submission.fits:
        # A fit stage is a call like any other, and it takes side inputs like
        # any other: `fit(corpus, glove)` is how three of the four week 3
        # repositories compute their IDF table. Only the "computed once" line
        # was recorded here, so the GloVe vectors the benchmark handed that
        # call never appeared under "supplied" and the run page understated
        # what it had given the student's code.
        found.extend(_given_to(step))
        found.append({"step": step.label, "supplied": "computed once as {}".format(name)})
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

    A week now says more than it used to: which resources its stages take,
    which files it owns a copy of, what an empty database of its own looks
    like. Forwarding those one by one at every call site is how one of them
    quietly stops being passed, so there is one place that forwards all of
    them and every surface uses it.
    """

    arguments: Dict[str, Any] = {
        "chain_role": spec.chain_role,
        "fixture": spec.fixture,
        "accepts": spec.accepts,
        "arrangements": spec.arrangements,
        "hints": getattr(spec, "hints", ()),
        "extras": dict(getattr(spec, "extras", {}) or {}),
        "identities": tuple(getattr(spec, "identities", ()) or ()),
        "resource_files": dict(getattr(spec, "resource_files", {}) or {}),
        "factories": getattr(spec, "factories", None),
        "readers": int(getattr(spec, "readers", 0) or 0),
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

    ``extras`` is the benchmark's own resources, by name, for stages that
    declare them (``Stage.extras``). ``identities`` names the items the
    benchmark is handing over, for stages that declare ``Stage.identity``.
    ``resource_files`` maps a basename to the benchmark's copy of that file,
    so a module that opens the course artifact at a path this machine does
    not have still imports; see ``discover``.

    ``factories`` picks out the zero-argument functions whose return is the
    database their store and query both take first. One 2026 team writes
    `create_database()` and then `add_fingerprints(db, id, fps)`; without
    this, no pairing of their functions can be tried, because the first
    argument of both is an object nothing in the search produces. The
    predicate is the week's, because what counts as an empty database is the
    week's question.

    ``readers`` is how many of their own functions may be applied to what the
    query returned before the answer is read. The same team's
    `query_database` returns a vote tally, `get_sorted_matches` turns it into
    a ranking, and `get_sorted_songs` turns that into song ids -- three of
    their functions deep, all theirs, none of them ours to write.

    ``remember`` writes the binding into the repository and reuses it while
    their code is unchanged. It is off by default, because a graded run should
    search: the point of an official score is that it was computed, not
    recalled. ``cogworks check`` turns it on, since that is the command a
    student runs every few minutes.
    """

    watcher = progress or Progress()
    repository = Path(repository).resolve()

    watcher.phase("Reading your repository")
    found = discover(
        repository,
        hints=hints,
        declared_root=declared_root,
        resource_files=resource_files,
    )
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
        recalled = _replay(
            memo.read(repository, key),
            found,
            chain_role,
            arrangements,
            fixture=fixture,
            extras=extras,
            identities=identities,
        )
        if recalled is not None:
            watcher.done()
            return recalled

    watcher.phase("Looking for the functions that do the work")
    # A week with no database is complete when its chain is, so the week's
    # acceptance test is the verifier and there is nothing to pair afterwards.
    verify = None
    if arrangements is None:
        verify = lambda steps: bool(accepts(steps, *fixture)[0])  # noqa: E731
    chain, refusal = resolve_chain(
        chain_role,
        found.namespace,
        fixture,
        verify=verify,
        extras=extras,
        identities=identities,
    )
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
        # Two refusals wear one sentence otherwise. "Nothing accepted what
        # your last function returned" is a wiring problem and often ours to
        # explain. "Your chain ran end to end and gave the wrong answer" is
        # their algorithm, and saying the first when the second is true sends
        # a team to look for a missing function they already wrote.
        #
        # Measured on one 2026 repository: its chain runs, and hand-running
        # their own pipeline at every threshold the search tries produces 4,
        # 5, or 6 clusters where the fixture has 3. Nothing is unwired. Their
        # cutoff splits a person, which is a result worth having and the
        # opposite of what the report said.
        if refusal.ran_to_the_end:
            return Submission(
                wired_but_wrong(
                    chain_role.name,
                    "one group per person",
                    "a different grouping",
                    reached,
                    notes=(
                        "Every function above is yours, and the benchmark "
                        "passed each one the input it asked for. What comes "
                        "back is not the grouping the photos have, so the "
                        "difference is in what your code computes rather "
                        "than in how it was connected up.",
                    ),
                ),
                discovery=found,
            )
        return Submission(
            not_wired(
                chain_role.name,
                refusal.stage,
                reached,
                last_returned=refusal.last_returned,
                next_step=_next_step_for_stall(found, benchmark),
                coverage=_coverage_of(found, benchmark),
            ),
            discovery=found,
        )

    for step, stage in zip(chain.steps, chain_role.stages):
        watcher.found(stage.name, step.label)

    if arrangements is None:
        watcher.done()
        if key:
            memo.write(repository, key, dict(_remembered(chain), arrangement=-1))
        return Submission(
            _scored_placeholder(chain),
            discovery=found,
            chain=chain.steps,
            branches=dict(chain.branches),
            fits=chain.fits,
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
    best: Optional[Tuple[float, Candidate, Candidate, int, int, _Shape]] = None
    arrangement_count = len(arrangements(lambda *_: None, "", None))
    # The shapes a store and a query can have between them. The first is the
    # one the search has always tried -- two of their functions, nothing in
    # front and nothing after -- so a week that declares neither a factory nor
    # a reader budget runs exactly the search it ran before, in the same order
    # and for the same number of attempts.
    shapes = _shapes_for(candidates, factories, readers)
    # The whole search is enumerable before it starts, so the bar can be
    # honest: every ordered pair of distinct candidates, times the ways one
    # item can be handed to a store, times those shapes. Nothing here is
    # extrapolated.
    total = min(
        len(candidates)
        * max(len(candidates) - 1, 0)
        * arrangement_count
        * len(shapes),
        max_attempts,
    )
    watcher.phase(
        "Trying your functions to find which pair stores a song and names it back"
    )
    tried = 0
    for shape in shapes:
        for store, ask in itertools.product(candidates, candidates):
            if store is ask:
                continue
            for index in range(arrangement_count):
                if tried >= max_attempts:
                    break
                tried += 1
                watcher.attempts(tried, total)
                held = shape.hold()
                if held is _FAILED:
                    continue

                def _enroll(song_id: str, item: Any, _s=store, _i=index, _h=held) -> Any:
                    return arrangements(
                        _s.call if _h is None else _leading(_s.call, _h),
                        song_id,
                        item,
                    )[_i]()

                ok, _detail = accepts(
                    chain.steps,
                    _enroll,
                    lambda item, _a=ask, _h=held, _r=shape.readers: _read(_a, _h, _r, item),
                )
                grade = float(ok)
                if grade > 0 and (best is None or grade > best[0]):
                    best = (grade, store, ask, index, tried, shape)
                if best is not None and best[0] >= FULLY_ANSWERED:
                    break
            if best is not None and best[0] >= FULLY_ANSWERED:
                break
            if tried >= max_attempts:
                break
        if best is not None and best[0] >= FULLY_ANSWERED:
            break
        if tried >= max_attempts:
            break

    if best is not None:
        _grade, store, ask, index, at, shape = best
        held = shape.hold()

        def _enroll(song_id: str, item: Any, _s=store, _i=index, _h=held) -> Any:
            return arrangements(
                _s.call if _h is None else _leading(_s.call, _h), song_id, item
            )[_i]()

        watcher.attempts(tried, tried)
        watcher.done()
        if key:
            memo.write(
                repository,
                key,
                dict(
                    _remembered(chain),
                    enroll=store.label,
                    query=ask.label,
                    arrangement=index,
                    attemptsTried=at,
                    factory=shape.factory.label if shape.factory else None,
                    readers=[reader.label for reader in shape.readers],
                ),
            )
        return Submission(
            _scored_placeholder(chain),
            discovery=found,
            chain=chain.steps,
            branches=dict(chain.branches),
            fits=chain.fits,
            attempt=Attempt(store.label, ask.label, index),
            attempts_tried=at,
            enroll=_enroll,
            query=lambda item, _a=ask, _h=held, _r=shape.readers: _read(_a, _h, _r, item),
            _store=store,
            _ask=ask,
            _arrange=arrangements,
            _factory=shape.factory,
            _readers=shape.readers,
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
            coverage=_coverage_of(found, benchmark),
        ),
        discovery=found,
        chain=chain.steps,
        attempts_tried=tried,
    )


#: What a factory call returns when their own factory raised. Not None,
#: because None is the ordinary "no factory in this shape" value and the two
#: must not be confused: one means try the pairing without a database object,
#: the other means their factory is not usable and this attempt is over.
_FAILED = object()


@dataclass(frozen=True)
class _Shape:
    """One way a store and a query can be arranged around their database.

    The plain shape -- no factory, no readers -- is first and is what every
    week had before this existed. The others exist because one 2026 team's
    database is a dict their own `create_database()` returns and their answer
    is three of their own functions deep, and neither is expressible as a
    pair of callables.
    """

    factory: Optional[Candidate] = None
    readers: Tuple[Candidate, ...] = ()

    def hold(self) -> Any:
        """Their empty database, made fresh, or None when there is none."""

        if self.factory is None:
            return None
        try:
            return self.factory.call()
        except BaseException:  # noqa: BLE001 - student code raises anything
            return _FAILED


def _read(ask: Candidate, held: Any, readers: Sequence[Candidate], item: Any) -> Any:
    """Ask their query, then hand the answer to their own readers in turn."""

    answer = ask.call(item) if held is None else ask.call(held, item)
    for reader in readers:
        answer = reader.call(answer)
    return answer


def _shapes_for(
    candidates: Sequence[Candidate],
    factories: Optional[Callable[[Candidate], bool]],
    readers: int,
) -> List[_Shape]:
    """Every store-and-query arrangement worth trying, plainest first.

    Ordered so the search a week already had runs first and unchanged. A week
    that declares neither gets exactly one shape and one pass, which is why
    the attempt counts on the 2026 corpus are the same numbers as before.
    """

    shapes = [_Shape()]
    found = [c for c in candidates if factories and _safely(factories, c)] if factories else []
    tails: List[Tuple[Candidate, ...]] = [()]
    for depth in range(1, max(readers, 0) + 1):
        tails.extend(itertools.permutations(candidates, depth))
    for tail in tails:
        for factory in [None] + found:
            if factory is None and not tail:
                continue  # already first
            shapes.append(_Shape(factory, tuple(tail)))
    return shapes


def _safely(predicate: Callable[[Candidate], bool], candidate: Candidate) -> bool:
    try:
        return bool(predicate(candidate))
    except BaseException:  # noqa: BLE001 - a week's predicate must not break the search
        return False


def _remembered(chain) -> Dict[str, Any]:
    """The part of a binding a replay needs, as plain data.

    Every field a step was called with, not only which function it was. The
    two are different claims and the difference is measurable: a step replayed
    without the tuning, the input form, the side inputs, or the per-item loop
    that made it run is a call the student's code never received.
    """

    steps = list(chain.steps)
    return {
        "chain": [step.label for step in steps],
        "tunings": [step.tuning for step in steps],
        "form": steps[0].form if steps else None,
        "inPlace": [step.in_place for step in steps],
        "plans": [list(step.plan) for step in steps],
        "keywords": [list(step.keywords) for step in steps],
        "perItem": [step.per_item for step in steps],
        "elements": [step.element for step in steps],
        "selfOnly": [step.self_only for step in steps],
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
) -> Optional[Submission]:
    """Rebind a remembered result, or return None and let the search run.

    A stored entry is names, not functions, so this looks each one up in the
    namespace that was just imported. Any name that no longer resolves means
    their code moved, and the honest response is to search again rather than
    to report a binding that no longer exists.
    """

    if not stored:
        return None

    # A binding whose side inputs were computed by their own code, or whose
    # role is several branches, is searched again rather than replayed. The
    # names alone do not restore it: a fit stage's value has to be recomputed
    # by running their function, and a branch's later steps are methods of an
    # object that only exists once the branch before it has run. Re-running
    # all of that is the search, so there is nothing to save and a stale
    # replay would be worse than a slow check.
    if stored.get("fits") or stored.get("branches"):
        return None

    pool = dict(extras or {})
    forms = fixture if isinstance(fixture, Fixtures) else (fixture,)
    form = forms[stored.get("form") or 0] if forms else ()
    names = identities_for(identities, form)

    # A week with no database: the chain is the whole binding.
    if int(stored.get("arrangement", 0)) < 0:
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
        return Submission(
            _scored_placeholder(chain),
            discovery=found,
            chain=steps,
            recalled=True,
        )

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

    shape = _Shape(factory, readers)
    held = shape.hold()
    if held is _FAILED:
        return None

    def _enroll(song_id: str, item: Any) -> Any:
        return arrangements(
            store.call if held is None else _leading(store.call, held), song_id, item
        )[index]()

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
        query=lambda item: _read(ask, held, readers, item),
        recalled=True,
        _store=store,
        _ask=ask,
        _arrange=arrangements,
        _factory=factory,
        _readers=readers,
    )


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

    An entry written before tunings were remembered has none, and a chain
    that needed one would then raise on its first call. Refusing the entry
    (`KeyError`) sends that case back through the search, which is the
    honest answer: the record did not say how to call their code.

    The same rule now covers the argument plan, the per-item loop, and which
    part of each item's result the step produced. A side input is looked up
    again by name in the pool the caller passed, because the value is the
    benchmark's own resource and never belongs in a cache file.
    """

    labels = stored["chain"]
    tunings = _aligned(stored, "tunings", labels)
    in_place = _aligned(stored, "inPlace", labels)
    plans = _aligned(stored, "plans", labels)
    keywords = _aligned(stored, "keywords", labels)
    per_item = _aligned(stored, "perItem", labels)
    elements = _aligned(stored, "elements", labels)
    self_only = _aligned(stored, "selfOnly", labels)
    pool = dict(pool or {})

    steps = []
    for index, label in enumerate(labels):
        plan = tuple(str(slot) for slot in plans[index])
        supplied: Dict[str, Any] = {}
        for slot in plan:
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
                supplied=supplied,
                per_item=bool(per_item[index]),
                element=elements[index],
                self_only=bool(self_only[index]),
            )
        )
    if steps:
        steps[0] = replace(steps[0], form=stored.get("form"))
    return tuple(steps)


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
