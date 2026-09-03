"""How a benchmark says what to look for in a repository.

``resolve`` is generic on purpose. It knows how to import a repository, how to
search for a chain of functions by running them, and how to try pairings until
one works, and it knows none of that in terms of any particular week. What it
cannot know is what the week's task is: what goes into the first stage, what
counts as having done the job, and how a store might want an item handed to it.

That is the benchmark's to say, so the benchmark says it, here. A plugin
returns one of these from ``discovery()`` and every surface can then resolve
that week without containing a line of week-specific code. A benchmark with no
``discovery()`` is not broken, it just cannot be searched for automatically,
and the surfaces report exactly that rather than pretending.

The alternative was a table in the resolver naming each week's functions, which
does not survive the first team that names things differently and does not
survive a new week at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Sequence

__all__ = ["DiscoverySpec"]


@dataclass(frozen=True)
class DiscoverySpec:
    """One week's task, described so a repository can be searched against it."""

    #: The stages between the benchmark's input and the thing it stores, each
    #: described by what it accepts and returns rather than what it is called.
    chain_role: Any

    #: The arguments the first stage is called with. Manufactured by the
    #: benchmark, because only the benchmark knows what its own input looks
    #: like, and real enough that working code succeeds on it.
    fixture: Sequence[Any]

    #: The week's own end-to-end test. Given the bound chain, a way to enroll,
    #: and a way to query, it returns whether the answer was right. This is the
    #: only thing that can accept a binding.
    accepts: Callable[..., Any]

    #: The orders in which a store might want one item offered. Teams write
    #: ``add(fingerprints, song_id)`` and ``add(song_id, fingerprints)`` in
    #: roughly equal numbers, and neither is wrong.
    arrangements: Callable[..., Sequence[Callable[[], Any]]]

    #: Directory names worth preferring when a repository holds several weeks.
    #: A preference only: the import graph decides when these do not apply.
    hints: Sequence[str] = field(default_factory=tuple)

    #: The benchmark's own resources, by name, for stages that declare them
    #: (``Stage.extras``). Week 3's GloVe vectors are the case: their
    #: embedder takes them as an argument, the benchmark owns the file, and
    #: no amount of searching their repository produces one. Data, never
    #: arithmetic.
    extras: Mapping[str, Any] = field(default_factory=dict)

    #: What each item of the input is called, for stages that declare
    #: ``Stage.identity``. Left empty when the input says it itself: a list
    #: of photo paths already names its items, and the search reads that.
    identities: Sequence[Any] = field(default_factory=tuple)

    #: Basename to the benchmark's copy, for a course artifact a repository
    #: opens at a path this machine does not have. Only consulted after an
    #: import has already failed on that exact basename.
    resource_files: Mapping[str, Path] = field(default_factory=dict)

    #: Which of their zero-argument functions returns an empty database that
    #: their store and query both take as a first argument. A predicate, not
    #: a name, because the week knows what an empty database looks like for
    #: its own task and the resolver does not.
    factories: Optional[Callable[[Any], bool]] = None

    #: How many of their own functions may be applied to what the query
    #: returned before the answer is read. Zero for a week whose query
    #: answers directly, which is every week before this existed.
    readers: int = 0

    #: Side inputs that come from the REPOSITORY rather than the benchmark,
    #: read once the root is known: ``prepare(root, modules) -> dict`` is
    #: merged into the extras pool before the search, with their loaded
    #: modules alongside so a week can build one of their objects around a
    #: file. Week 3's trained projection is the case. It is a file the team
    #: committed, so `discovery()` cannot know it when it runs (before any
    #: repository is chosen), and without it every repository read as having
    #: no weights. A hook that raises refuses the search with its message,
    #: because a week that could not read what it needs from a repository
    #: has nothing honest to bind.
    prepare: Optional[Callable[[Path, Sequence[Any]], Mapping[str, Any]]] = None

    #: How the week puts its world back to empty, when part of that world is
    #: somewhere the resolver cannot reach. Called once per pairing trial,
    #: immediately before that trial's database is made, and again before a
    #: scored run is built from an accepted binding.
    #:
    #: The resolver can already make a store's own object again when the
    #: store is a method (``Candidate.rebuild``), call the week's factory
    #: again when there is one, and a week whose acceptance test gives each
    #: attempt a fresh working directory gets a file-backed database emptied
    #: for free. What none of those reach is state that is neither an object
    #: the search built nor a file: a repository that writes ``_DB = {}`` at
    #: module scope and fills it from a plain function keeps every item the
    #: search enrolled, so the two fixture items are still in the database
    #: when the benchmark's own catalog is scored against it, and every trial
    #: after the first enrolls into whatever the trials before it left.
    #:
    #: The resolver cannot know where that state lives or how to empty it,
    #: and guessing (clearing every module-level container it can see) would
    #: reach past the repository into the benchmark's own modules. So the
    #: week says how, and the resolver only says when.
    #:
    #: A week that needs the repository's own modules to do it gets them from
    #: ``prepare``, which is handed the loaded namespace before the search
    #: begins; the modules are not otherwise reachable, since discovery
    #: unregisters them from ``sys.modules`` once it has imported them. A week
    #: whose state is its own -- a cache it keeps between calls -- needs
    #: nothing but itself.
    #:
    #: Optional. A week that leaves it unset gets exactly the search it had
    #: before this field existed, which is why it is not required.
    reset: Optional[Callable[[], None]] = None

    #: The right answer to that test, in the week's own words, for the
    #: headline of a chain that ran end to end and answered something else.
    #: "one group per person" for week 2, "the enrolled song at rank 1" for
    #: week 1. The default is a sentence that is true of every week; the
    #: week 2 sentence was hard-coded in the resolver and a week 3 team read
    #: that their caption search "answered a different grouping".
    expects: str = "the answer the benchmark's own case has"
