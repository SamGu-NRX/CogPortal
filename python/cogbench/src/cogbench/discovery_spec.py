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
    #:
    #: ``query_call`` may be None, and a week whose task ends in a database
    #: must answer that call: enroll the fixture and return ``(True, detail)``
    #: when all of it went in, ``(False, detail)`` when it did not, without
    #: querying anything. Whether a store takes an enrolment is a property of
    #: the store, the arrangement and the shape it is offered in -- the query
    #: is not one of its inputs -- so the resolver asks it once per store and
    #: then pairs only the stores that said yes, instead of re-asking it for
    #: every query it might be paired with.
    accepts: Callable[..., Any]

    #: The orders in which a store might want one item offered. Teams write
    #: ``add(fingerprints, song_id)`` and ``add(song_id, fingerprints)`` in
    #: roughly equal numbers, and neither is wrong.
    arrangements: Callable[..., Sequence[Callable[[], Any]]]

    #: How completely one answer answers the week's question, read off the
    #: answer alone: ``grades(answer) -> (grade, detail)``, the same pair
    #: ``accepts`` returns. Required by a week that declares ``readers``, and
    #: unused by one that does not. It sits here rather than beside ``accepts``
    #: only because a field with a default cannot precede one without.
    #:
    #: A reader reads a value and returns another, so whether it can read a
    #: given answer, and whether what it produced is better, are both settled
    #: by one call and one grading. Proving the same thing by re-running the
    #: whole acceptance test per candidate tail cost one 2026 repository
    #: 125,104 enrol-and-query runs.
    grades: Optional[Callable[[Any], Any]] = None

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

    #: The right answer to that test, in the week's own words, for the
    #: headline of a chain that ran end to end and answered something else.
    #: "one group per person" for week 2, "the enrolled song at rank 1" for
    #: week 1. The default is a sentence that is true of every week; the
    #: week 2 sentence was hard-coded in the resolver and a week 3 team read
    #: that their caption search "answered a different grouping".
    expects: str = "the answer the benchmark's own case has"
