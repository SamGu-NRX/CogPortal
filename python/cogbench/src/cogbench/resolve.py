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
from collections.abc import Mapping as _MappingABC
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Mapping, Any, Callable, Dict, FrozenSet, List, Optional, Sequence, Tuple

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
    #: The branches the week declared optional that did not bind, by name,
    #: with the refusal each ended on. A week 3 repository with no trained
    #: weights is the case: its text branch binds, its image surfaces do
    #: not, and the run reports the half it measured rather than refusing
    #: the whole thing. What a partial set is worth is the week's to decide;
    #: this says which surface is absent and why.
    missing: Dict[str, Any] = field(default_factory=dict)

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
            # branches are the binding. Before this line every week 3
            # submission read as not ready and the CLI refused to score a
            # repository the search had just bound.
            return self.verdict.status == SCORED
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
        # Read off the object this run just built, never off the one the
        # search filled. The attribute name on the record says what happened
        # during the search; a scored run enrols different songs into a
        # different object, and asking it the same question again is what
        # makes the two runs the same program rather than the same guess.
        state = _FromTheirStore(store) if self._state else None

        def _enroll(song_id: str, item: Any) -> Any:
            if state is not None:
                state.enrolling(song_id)
            target = store if held is None else _leading(store, held)
            if arrange is None:
                return target(song_id, item)
            return arrange(target, song_id, item)[index]()

        def _query(item: Any) -> Any:
            if state is not None:
                answer = ask(item, *state.arguments())
            else:
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
        if self.missing:
            # The surface that is not there, and the furthest the search got
            # looking for it. Sorted so two runs of the same repository write
            # the same bytes.
            record["missing"] = {
                name: {"stage": refusal.stage, "detail": refusal.detail}
                for name, refusal in sorted(self.missing.items())
            }
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
        # turned out to be callable (`pipeline._from_pool`). That is the
        # largest thing a run can supply, so it is the one thing that must
        # never be missing from this list.
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
        "prepare": getattr(spec, "prepare", None),
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
    expects: Optional[str] = None,
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
    if prepare is not None:
        # What this repository itself supplies to the search: week 3's
        # trained projection, read off the chosen root. Merged under the
        # benchmark's own extras so a week cannot be overridden by a file.
        try:
            # From the same throwaway directory the search probes from:
            # the hook runs their code (a model's constructor and loader),
            # and their code writes relative files.
            with _scratch_cwd():
                from_repository = dict(prepare(found.root.path, found.namespace) or {})
        except Exception as error:  # noqa: BLE001 - the week's hook may refuse
            watcher.done()
            return Submission(
                not_read(
                    found.root.path.name,
                    "{}: {}".format(type(error).__name__, str(error)[:200]),
                ),
                discovery=found,
            )
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
    # What the week's test said about the last chain it rejected, kept so a
    # chain that ran end to end is reported in the week's words rather than
    # in a sentence written for another week.
    last_said: Dict[str, str] = {}
    # The pairing the verifier accepted, kept so the chain it belongs to is
    # not paired a second time on the way out.
    paired: Dict[str, Any] = {"tried": 0, "chains": 0}

    if arrangements is None:
        # A week with no database is complete when its chain is, so the week's
        # acceptance test is the whole verifier.
        def verify(steps: Any) -> bool:
            ok, detail = accepts(steps, *fixture)
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
        def verify(steps: Any) -> bool:
            best, tried = _pair(
                steps,
                found,
                arrangements,
                accepts,
                factories,
                readers,
                max_attempts,
                watcher,
            )
            paired["tried"] += tried
            paired["chains"] += 1
            # The first complete chain, kept for the report when none of them
            # pairs. "We found your fingerprinting and no database" has to be
            # able to name the fingerprinting it found, and a refusal carries
            # labels rather than the bound steps.
            paired.setdefault("steps", tuple(steps))
            if best is None:
                return False
            paired["best"] = best
            return True

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
        if refusal.ran_to_the_end and arrangements is not None:
            # For a week with a database, "the chain ran to the end" means
            # every chain the frontier offered was complete and none of them
            # could be paired with a store and a query. Saying their
            # algorithm returned the wrong answer would be wrong twice over:
            # nothing of theirs was asked for an answer, and the missing
            # piece is a database rather than a better fingerprint.
            return Submission(
                not_wired(
                    "identification",
                    "database",
                    reached,
                    next_step=(
                        "The benchmark found your fingerprinting but no pair of "
                        "functions that stores a song and then names it back."
                    ),
                    coverage=_coverage_of(found, benchmark),
                ),
                discovery=found,
                chain=paired.get("steps", ()),
                attempts_tried=paired["tried"],
            )
        if refusal.ran_to_the_end:
            said = last_said.get("detail", "")
            return Submission(
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
            )
        return Submission(
            not_wired(
                chain_role.name,
                refusal.stage,
                reached,
                last_returned=refusal.last_returned,
                next_step=_next_step_for_stall(found, benchmark),
                coverage=_coverage_of(found, benchmark),
                notes=refusal.notes,
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
            missing=dict(chain.missing),
            attempts_tried=0,
            enroll=None,
            query=None,
        )

    _grade, store, ask, index, at, shape = paired["best"]
    held = shape.hold()
    call = store.rebuild() if shape.state and store.rebuild else store.call
    state = _FromTheirStore(call) if shape.state else None

    def _enroll(song_id: str, item: Any, _i=index, _h=held, _c=call) -> Any:
        if state is not None:
            state.enrolling(song_id)
        return arrangements(_c if _h is None else _leading(_c, _h), song_id, item)[_i]()

    watcher.attempts(paired["tried"], paired["tried"])
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
                state=shape.state,
                stateAttribute=shape.state_attribute,
            ),
        )
    return Submission(
        _scored_placeholder(chain),
        discovery=found,
        chain=chain.steps,
        branches=dict(chain.branches),
        fits=chain.fits,
        missing=dict(chain.missing),
        attempt=Attempt(store.label, ask.label, index),
        attempts_tried=at,
        enroll=_enroll,
        query=lambda item, _a=ask, _h=held, _r=shape.readers, _s=state: _read(
            _a, _h, _r, item, _s
        ),
        _store=store,
        _ask=ask,
        _arrange=arrangements,
        _factory=shape.factory,
        _readers=shape.readers,
        _state=shape.state,
        _state_attribute=shape.state_attribute,
    )


def _pair(
    steps: Sequence[Candidate],
    found: Discovery,
    arrangements: Callable[..., Any],
    accepts: Callable[..., Tuple[Any, str]],
    factories: Optional[Callable[[Candidate], bool]],
    readers: int,
    max_attempts: int,
    watcher: Any,
) -> Tuple[Optional[Tuple[float, Candidate, Candidate, int, int, "_Shape"]], int]:
    """The best pair of their functions that stores a song through ``steps``
    and names it back, or None when no pair does.

    Returns the pairing and how many were tried. This is the week's real
    question about a chain, which is why `resolve` hands it to `resolve_chain`
    as the verifier rather than running it on whichever chain came back first.
    """

    candidates = _store_candidates(found, steps)
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
    # Which of their functions could take the state form at all. Both are
    # properties of the candidate rather than of the attempt, so they are
    # answered once each here instead of per pairing: `_takes_n` reads a
    # signature, which is the expensive part, and there are as many pairings
    # as candidates squared.
    holds_state = {c.label for c in candidates if _FromTheirStore.possible(c.call)}
    takes_three = {c.label for c in candidates if _takes_n(c, 3)}
    tried = 0
    for shape in shapes:
        for store, ask in itertools.product(candidates, candidates):
            if store is ask:
                continue
            if shape.state and (
                store.label not in holds_state or ask.label not in takes_three
            ):
                continue
            for index in range(arrangement_count):
                if tried >= max_attempts:
                    break
                tried += 1
                watcher.attempts(tried, total)

                # A trial gets its own database and its own enroll closure
                # over it. Sharing one across trials let the second trial
                # enrol into a database the first had already filled, so a
                # store that refuses a song id it has seen raised on every
                # trial after the first and the tail that would have answered
                # was recorded as one that raised.
                def _trial(_s=store, _i=index, _shape=shape):
                    held = _shape.hold()
                    if held is _FAILED:
                        return None, None, None
                    # A trial that reads state needs its own object as well
                    # as its own database, and the song ids to build the
                    # id-to-name table from are the ones this trial enrols.
                    call = _s.rebuild() if _shape.state and _s.rebuild else _s.call
                    state = _FromTheirStore(call) if _shape.state else None

                    def _enroll(song_id: str, item: Any, _h=held, _c=call) -> Any:
                        if state is not None:
                            state.enrolling(song_id)
                        return arrangements(
                            _c if _h is None else _leading(_c, _h), song_id, item
                        )[_i]()

                    return _enroll, held, state

                _enroll, held, state = _trial()
                if _enroll is None:
                    continue

                asked = _Asked(ask, held, shape.readers, state)
                ok, _detail = accepts(steps, _enroll, asked)
                grade = float(ok)
                # The shape this pairing bound with, kept apart from the one
                # the loop is iterating. Assigning readers back onto `shape`
                # rewrote the loop variable, so every later pairing in the
                # same pass was then run through readers chosen for an
                # earlier one.
                bound = shape
                if grade < FULLY_ANSWERED and readers > 0 and asked.ran:
                    # Their query answered something the benchmark could not
                    # read as a ranking. Before giving that a lower grade, try
                    # up to `readers` more of their own functions on what it
                    # returned: rutvim2009 Week1's `query_database` returns a
                    # vote tally keyed by `(song_id, offset)`, and its
                    # `get_sorted_matches` then `get_sorted_songs` are what
                    # turn that into song names.
                    #
                    # `asked.ran` is what keeps this affordable, and it is
                    # the whole rule: a reader reads what the query returned,
                    # so a pairing whose query raised never reached the point
                    # where one could be applied. An empty answer is not
                    # excluded, because turning an empty tally into a ranking
                    # is a thing one of their readers can do, and excluding it
                    # made that reader unreachable. Gating on a factory being
                    # in play instead, which is what stood here, let all 2,724
                    # pairings before the right one on rutvim2009 Week1 start
                    # a 576-run reader search, and the repository timed out at
                    # ten minutes having spent all of it re-reading answers
                    # that were not there.
                    better = _read_further(
                        accepts, steps, _trial, ask, candidates, readers, grade
                    )
                    if better is not None:
                        grade, bound = better[0], replace(shape, readers=better[1])
                if grade > 0 and (best is None or grade > best[0]):
                    if state is not None:
                        # Which attribute their query was actually handed, now
                        # that a pairing has run and found out.
                        bound = replace(bound, state_attribute=state.chosen)
                    best = (grade, store, ask, index, tried, bound)
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

    return best, tried


#: What a factory call returns when their own factory raised. Not None,
#: because None is the ordinary "no factory in this shape" value and the two
#: must not be confused: one means try the pairing without a database object,
#: the other means their factory is not usable and this attempt is over.
_FAILED = object()


@dataclass(frozen=True)
class _Shape:
    """One way a store and a query can be arranged around their database.

    The plain shape -- no factory, no readers, no state -- is first and is
    what every week had before this existed. The others exist because one
    2026 team's database is a dict their own `create_database()` returns and
    their answer is three of their own functions deep, and another's matcher
    is a pure function that has to be handed the table their store filled.
    None of those is expressible as a pair of callables.
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

    def hold(self) -> Any:
        """Their empty database, made fresh, or None when there is none."""

        if self.factory is None:
            return None
        try:
            return self.factory.call()
        except BaseException:  # noqa: BLE001 - student code raises anything
            return _FAILED


class AmbiguousStore(Exception):
    """Their store object holds more than one filled table after enrolling.

    Raised rather than guessed. Two filled mappings mean two answers to "what
    did the store fill", and picking the first by name would be picking one of
    their data structures at random and calling the result their score.
    """


class _FromTheirStore:
    """The table their store filled, and an id-to-name table beside it.

    One 2026 team (Cog-gurts Week 1) writes `AudioDatabase.add_hash(key, id,
    offset)` to fill `self.hash_map`, and matches with a pure function
    `match_fingerprint(recording_fp, database, song_index)` that takes that
    table as an argument and returns `song_index[best]`. The database is
    neither an argument their store took nor a module global: it is state on
    the object their store is a method of, and the only way to hand it to the
    matcher is to read it off that object once the store has run.

    Which attribute it is, is not asked in advance and never read from a
    name. After enrolling, exactly one attribute holding a non-empty mapping
    is the table their store filled. More than one is `AmbiguousStore`.

    ``song_index`` is the one thing here the benchmark supplies rather than
    reads: their matcher looks a song id up in it and returns what it finds,
    so an identity table over the ids just enrolled returns their own answer
    unchanged. Anything else would be putting words in their matcher's mouth.
    """

    __slots__ = ("_instance", "_enrolled", "chosen")

    def __init__(self, store_call: Callable[..., Any]) -> None:
        self._instance = getattr(store_call, "__self__", None)
        self._enrolled: List[str] = []
        self.chosen: Optional[str] = None

    @staticmethod
    def possible(store_call: Callable[..., Any]) -> bool:
        """Whether there is an object to read state off at all."""

        return getattr(store_call, "__self__", None) is not None

    def enrolling(self, song_id: str) -> None:
        self._enrolled.append(song_id)

    def arguments(self) -> Tuple[Any, Dict[str, str]]:
        """The filled table and the id-to-name table, in that order."""

        filled = [
            (name, value)
            for name, value in sorted(vars(self._instance).items())
            if isinstance(value, _MappingABC) and len(value) > 0
        ]
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


def _read(
    ask: Candidate,
    held: Any,
    readers: Sequence[Candidate],
    item: Any,
    state: Optional[_FromTheirStore] = None,
) -> Any:
    """Ask their query, then hand the answer to their own readers in turn."""

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
    That is the only evidence available for whether looking for readers is
    worth doing, and it is exactly the right evidence: readers read what the
    query returned.
    """

    __slots__ = ("_ask", "_held", "_readers", "_state", "answer")

    def __init__(
        self,
        ask: Candidate,
        held: Any,
        readers: Sequence[Candidate] = (),
        state: Optional["_FromTheirStore"] = None,
    ) -> None:
        self._ask = ask
        self._held = held
        self._readers = tuple(readers)
        self._state = state
        self.answer: Any = _UNASKED

    def __call__(self, item: Any) -> Any:
        self.answer = _read(self._ask, self._held, self._readers, item, self._state)
        return self.answer

    @property
    def ran(self) -> bool:
        """Whether the query was reached and returned rather than raised.

        That is the whole condition, and anything narrower is a guess about
        their code. Requiring a non-empty answer looked safe and was not: a
        reader whose job is to turn an empty tally into an empty ranking is
        exactly the function that makes such a pairing answer, and skipping
        it meant no repository whose query returns `{}` before its readers
        run could ever be paired.
        """

        return self.answer is not _UNASKED


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
    for factory in found:
        shapes.append(_Shape(factory, ()))
    # One more, last, and only ever tried for a store that is a method of one
    # of their objects and a query that takes three arguments: their store's
    # own filled table handed to their query, with an id-to-name table beside
    # it. Both of those are checked per pairing rather than enumerated here,
    # because whether an object has a filled table is not knowable until a
    # store has run. A week that declares no readers and no factories still
    # gets this shape, but every pairing in it is skipped before their code
    # runs unless the store and the query have those two properties.
    shapes.append(_Shape(state=True))
    # Readers are not enumerated here. Every ordered pair of candidates
    # times every reader permutation multiplied the pairing search past any
    # budget: measured on rutvim2009 Week1, 50 candidates and two reader
    # slots make 13,525 shapes and about 200 million attempts against a
    # ceiling of 20,000, so the search would never reach the shape that
    # binds. Readers are looked for afterwards, and only for a pairing whose
    # query actually returned something to read; see `_read_further` and
    # `_Asked`.
    return shapes


def _read_further(
    accepts: Callable[..., Tuple[Any, str]],
    steps: Sequence[Candidate],
    trial: Callable[
        [], Tuple[Optional[Callable[..., Any]], Any, Optional["_FromTheirStore"]]
    ],
    ask: Candidate,
    candidates: Sequence[Candidate],
    readers: int,
    floor: float = 0.0,
) -> Optional[Tuple[float, Tuple[Candidate, ...]]]:
    """The shortest run of their readers that turns a named song into a ranking.

    Depth-first over the candidates, shortest tails first, stopping at the
    first tail the week's acceptance test grades as fully answered. A reader
    is any of their functions that takes the previous answer and returns
    something; a step that raises is not a reader of that value. Returns
    the grade and the tail, or None when no tail improved on the bare query.

    ``trial`` builds a fresh database and a fresh enroll closure over it, and
    is called once per tail. Reusing one database across tails let each tail
    enrol into whatever the tails before it had already stored: a store that
    rejects a song id it has already seen then raised on every tail but the
    first, and the tail that would have answered was graded as one that
    raised.

    ``floor`` is the grade the query already earned on its own, and a tail
    has to beat it rather than match it. A reader that leaves the grade where
    it was changed nothing the benchmark can see, and binding it would put
    one of their functions in the record for a run whose answer it did not
    alter.
    """

    best: Optional[Tuple[float, Tuple[Candidate, ...]]] = None
    # A reader takes what the query returned and nothing else, so only a
    # function with exactly one required positional argument can be one.
    # Measured on the notebook-only 2026 repository that needs readers: 52
    # candidates, 25 reader-shaped; at depth two the difference is 2,550
    # acceptance runs against 600, each an enroll of two songs and a query.
    pool = [c for c in candidates if c is not ask and _takes_one(c)]
    frontier: List[Tuple[Candidate, ...]] = [()]
    for _depth in range(max(readers, 0)):
        nxt: List[Tuple[Candidate, ...]] = []
        for tail in frontier:
            for reader in pool:
                if reader in tail:
                    continue
                tail_with = tail + (reader,)
                enroll, held, state = trial()
                if enroll is None:
                    continue
                ok, _detail = accepts(
                    steps,
                    enroll,
                    lambda item, _a=ask, _h=held, _r=tail_with, _s=state: _read(
                        _a, _h, _r, item, _s
                    ),
                )
                grade = float(ok)
                if grade <= floor:
                    nxt.append(tail_with)
                    continue
                if best is None or grade > best[0]:
                    best = (grade, tail_with)
                if grade >= FULLY_ANSWERED:
                    return best
                nxt.append(tail_with)
        frontier = nxt
        if not frontier:
            break
    return best


def _takes_one(candidate: Candidate) -> bool:
    """Whether this callable takes exactly one required positional argument."""

    return _takes_n(candidate, 1)


def _takes_n(candidate: Candidate, count: int) -> bool:
    """Whether this callable takes exactly ``count`` required positionals."""

    import inspect

    try:
        parameters = inspect.signature(candidate.call).parameters.values()
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
        # Which reading of the upstream value each step was called with.
        # Without it a replay has to work that out from the shapes again,
        # and a fused step that returns both a spectrogram and its peaks
        # offers two readings their next function accepts; see
        # `Candidate.handoff`.
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

    shape = _Shape(factory, readers, bool(stored.get("state")), stored.get("stateAttribute"))
    held = shape.hold()
    if held is _FAILED:
        return None
    call = store.rebuild() if shape.state and store.rebuild else store.call
    state = _FromTheirStore(call) if shape.state else None

    def _enroll(song_id: str, item: Any) -> Any:
        if state is not None:
            state.enrolling(song_id)
        return arrangements(
            call if held is None else _leading(call, held), song_id, item
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
        query=lambda item: _read(ask, held, readers, item, state),
        recalled=True,
        _store=store,
        _ask=ask,
        _arrange=arrangements,
        _factory=factory,
        _readers=readers,
        _state=shape.state,
        _state_attribute=shape.state_attribute,
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
    handoffs = _aligned(stored, "handoffs", labels)
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
                handoff=handoffs[index] or None,
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


def _store_candidates(found: Discovery, steps: Sequence[Candidate]) -> List[Candidate]:
    """Everything that could be a database, minus the pipeline already bound.

    Module functions first, then the methods of any class the team wrote that
    builds with no arguments. The chain's own steps are excluded: a
    fingerprinter is not a database, and trying it as one wastes attempts on
    a pairing that cannot work.
    """

    used = {step.label for step in steps}
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
