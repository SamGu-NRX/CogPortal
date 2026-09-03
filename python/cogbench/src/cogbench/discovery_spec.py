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
