"""Remembering which of a team's functions were bound, until their code changes.

The search runs their code. One repository in the 2026 corpus needs 3962
pairings, each enrolling two songs and querying a clip, and the whole thing
takes about ninety seconds. That is a reasonable price for a graded run and a
bad one for ``cogworks check``, which a student wants to use as a ten-second
loop while they are fixing something.

So the answer is written down, under a key made from the bytes of every file
the search read. Editing any of those files changes the key and the search
runs again. This is the part that has to be right: a cache that returned a
stale binding would score code the student has already replaced, and they
would have no way to tell.

Only the names are stored. Rebinding those names is an import and a lookup,
which is fast, and it means a cache entry can never contain a live function
from a previous version of their code.

Nothing here fails loudly. A cache that cannot be read or written is a slow
check, not a broken one, so every error path falls through to searching.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

__all__ = ["fingerprint", "read", "write", "cache_path"]

#: Bumped when a change would make an old entry wrong: a different search
#: order, a different acceptance test, a different set of stages. The key
#: covers the student's code, and this covers ours.
FORMAT = 4


def cache_path(repository: Path) -> Path:
    return Path(repository) / ".cogbench" / "resolved.json"


def fingerprint(paths: Sequence[Path], *, benchmark: str) -> str:
    """A key that changes when anything the search read changes.

    Contents, not modification times: a checkout, a branch switch, and a
    ``git stash`` all rewrite timestamps without changing code, and all three
    happen constantly while a student works. Paths are included and sorted, so
    renaming or deleting a file is a change too.
    """

    digest = hashlib.sha256()
    digest.update("{}\x00{}\x00".format(FORMAT, benchmark).encode("utf-8"))
    for path in sorted(Path(p) for p in paths):
        digest.update(str(path).encode("utf-8", "replace"))
        digest.update(b"\x00")
        try:
            digest.update(path.read_bytes())
        except OSError:
            # A file that vanished between discovery and hashing is itself a
            # change, and recording that it could not be read makes the key
            # differ from the run where it could.
            digest.update(b"<unreadable>")
        digest.update(b"\x00")
    return digest.hexdigest()


def read(repository: Path, key: str) -> Optional[Dict[str, Any]]:
    """The stored binding, when it was made from exactly this code."""

    path = cache_path(repository)
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(stored, dict) or stored.get("key") != key:
        return None
    entry = stored.get("binding")
    return entry if isinstance(entry, dict) else None


def write(repository: Path, key: str, binding: Dict[str, Any]) -> None:
    """Store a binding, or give up quietly.

    A read-only checkout is a real case: the Modal sandbox mounts one. Failing
    the run over a cache write would turn a speed feature into an outage.
    """

    path = cache_path(repository)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(
            json.dumps({"key": key, "binding": binding}, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    except OSError:
        return


def source_paths(discovery: Any) -> List[Path]:
    """Every file the search read, including the ones it could not import.

    A module that failed to import is part of the key because fixing it is
    exactly the change that should invalidate the cache. A student who adds
    the missing package and re-runs must get a new search, not the refusal
    they were shown before.
    """

    paths: List[Path] = []
    for entry in list(getattr(discovery, "modules", [])) + list(
        getattr(discovery, "skipped", [])
    ):
        path = getattr(entry, "path", None)
        if path is not None:
            paths.append(Path(path))
    return paths
