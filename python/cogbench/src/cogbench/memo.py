"""Remembering which of a team's functions were bound, until their code changes.

The search runs their code. One repository in the 2026 corpus needs 3962
pairings, each enrolling two songs and querying a clip, and the whole thing
takes about ninety seconds. That is a reasonable price for a graded run and a
bad one for ``cogworks check``, which a student wants to use as a ten-second
loop while they are fixing something.

So the answer is written down, under a key made from the bytes of every file
the search read and the current inputs the caller supplies. Changing either
changes the key and the search runs again. This is the part that has to be
right: a cache that returned a stale binding would score code the student
has already replaced, and they would have no way to tell.

Only binding descriptions are stored, never live functions. The resolver
looks up those names in current code and reruns the current acceptance test
before treating the entry as a hit.

Nothing here fails loudly. A cache that cannot be read or written is a slow
check, not a broken one, so every error path falls through to searching.
"""

from __future__ import annotations

import hashlib
import json
import math
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set

from .pipeline import _under_clock
from .storage import workspace_dir

__all__ = ["fingerprint", "read", "write", "cache_path"]

#: Bumped when a change would make an old entry wrong: a different search
#: order, a different acceptance test, a different set of stages. The key
#: covers the student's code, and this covers ours.
#: 5: entries carry the tuning each step was bound with. A 4 entry for a
#: chain that needed one replayed as a bare call and raised.
#: 6: entries also carry which input form bound the first step and which
#: steps answered in place, both of which a replay needs to call the chain
#: the way the search did.
#: 7: entries carry the whole argument plan of each step -- the side inputs
#: it was handed, the item identity it was given, whether it ran once per
#: item, and which part of each item's result it produced. A 6 entry for a
#: chain that needed any of those replayed as a plain one-argument call.
#: 8: entries carry which reading of the upstream value each step was
#: called with -- the whole thing, spread as arguments, reversed, or one
#: part of it. A 7 entry left a replay to work that out from the shapes,
#: and one 2026 repository's fused first step returns both a spectrogram
#: and its peaks, either of which their next function accepts.
#: 9: entries carry whether the query was handed the table their store
#: filled on its own object, and which attribute that was. An 8 entry for
#: such a binding replayed as `ask(item)`, which for the one 2026
#: repository with this shape means calling a three-argument matcher with
#: one argument: the replay raises instead of scoring, and it is a stored
#: entry, so it would keep raising until the cache was cleared.
#: 10 (2026-09-03): the search changed what it accepts and what it counts.
#: Every pairing trial now gets its own store object rather than sharing the
#: one instance the scan built, so a pairing an earlier trial's leftovers had
#: made raise is now reachable and a 9 entry can name a worse pairing than
#: the search would pick today. A store's pre-existing tables no longer count
#: toward the state form being ambiguous, which is the same kind of change in
#: the other direction. And `attemptsTried` is now the whole search rather
#: than the accepted chain's own ordinal, so a 9 entry replays a number that
#: understates the work by every chain tried before the one that bound.
#: 11: state snapshots and reader probes now preserve different candidate
#: state during search. Those changes can select different bindings, so a
#: version 10 decision must be searched again rather than replayed.
#: 12: the key now includes current input identity. Source bytes alone do
#: not distinguish searches given different fixtures, tunings, or resources.
#: 13: project modules now execute once per discovery and package bodies
#: enter its candidate namespace. Reconsider bindings chosen before that
#: loader change and the constructor screening/receiver repairs.
FORMAT = 13


def cache_path(repository: Path) -> Path:
    return Path(repository) / ".cogbench" / "resolved.json"


def _field(digest: Any, tag: bytes, payload: bytes) -> None:
    # Length framing keeps embedded separators from merging distinct values.
    digest.update(tag + str(len(payload)).encode("ascii") + b":")
    digest.update(payload)


def _inputs(digest: Any, value: Any, active: Set[int]) -> None:
    """Hash exact builtin values without invoking student serialization hooks."""

    kind = type(value)
    if value is None:
        digest.update(b"n")
    elif kind is bool:
        digest.update(b"b1" if value else b"b0")
    elif kind is int:
        # Binary magnitude also handles ints beyond Python's decimal digit limit.
        magnitude = abs(value)
        _field(digest, b"i-" if value < 0 else b"i+", magnitude.to_bytes(
            (magnitude.bit_length() + 7) // 8, "big",
        ))
    elif kind is float:
        if not math.isfinite(value):
            raise ValueError("nonfinite memo input")
        _field(digest, b"f", value.hex().encode("ascii"))
    elif kind is str:
        _field(digest, b"s", value.encode("utf-8", "surrogatepass"))
    elif kind is bytes:
        _field(digest, b"y", value)
    elif kind is list or kind is tuple or kind is dict:
        identity = id(value)
        if identity in active:
            raise ValueError("shared or cyclic mutable memo input")
        active.add(identity)
        try:
            tag = b"d" if kind is dict else b"l" if kind is list else b"t"
            digest.update(tag + str(len(value)).encode("ascii") + b":")
            if kind is dict:
                # Search code can iterate inputs, so insertion order is identity.
                for key, item in value.items():
                    if type(key) is not str:
                        raise ValueError("memo input keys must be exact strings")
                    _inputs(digest, key, active)
                    _inputs(digest, item, active)
            else:
                for item in value:
                    _inputs(digest, item, active)
        finally:
            # Equal contents do not identify shared mutable inputs. Rather
            # than encode object graphs, skip those inputs too. Tuples can be
            # shared safely, but remain tracked during traversal for cycles.
            if kind is tuple:
                active.remove(identity)
    else:
        raise ValueError("unsupported memo input type")


def fingerprint(paths: Sequence[Path], *, benchmark: str, inputs: Any = None) -> str:
    """Hash file paths, their bytes, and explicitly represented search inputs.

    Contents, not modification times: checkouts and branch switches rewrite
    timestamps without changing code. Paths are sorted; input dicts are not.
    Unsupported inputs or unreadable files return an empty key so the caller
    can skip the optional memo. Omitting inputs is equivalent to passing None.
    """

    try:
        digest = hashlib.sha256()
        _field(digest, b"v", str(FORMAT).encode("ascii"))
        _field(digest, b"b", benchmark.encode("utf-8"))
        _inputs(digest, inputs, set())
        for path in sorted(Path(p) for p in paths):
            if not path.is_file():
                return ""
            _field(digest, b"p", str(path).encode("utf-8", "surrogatepass"))
            contents = hashlib.sha256()
            # Resource/model files can be large; never allocate the whole file.
            with path.open("rb") as stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    contents.update(chunk)
            _field(digest, b"c", contents.digest())
        return digest.hexdigest()
    except Exception:
        # Missing bytes or an unrepresentable input cannot identify a search.
        return ""


def read(repository: Path, key: str) -> Optional[Dict[str, Any]]:
    """The stored binding, when it was made from exactly this code."""

    path = cache_path(repository)
    try:
        if path.parent.is_symlink() or path.is_symlink():
            return None
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

    # Container subclasses can run student code during JSON iteration. Use
    # the probe clock and failure boundary before making any workspace, and
    # reject nonfinite floats that strict JSON cannot represent.
    try:
        serialized = _under_clock(
            json.dumps, {"key": key, "binding": binding},
            indent=2, sort_keys=True, allow_nan=False,
        ) + "\n"
    except BaseException:  # noqa: BLE001 - student iteration can raise anything
        return

    path = cache_path(repository)
    temporary: Optional[Path] = None
    try:
        # Check before workspace_dir can write its ignore file, including a
        # dangling link. These checks do not protect against concurrent swaps.
        if path.parent.is_symlink() or (path.parent / ".gitignore").is_symlink():
            return
        workspace_dir(Path(repository))
        if path.parent.is_symlink() or not path.parent.is_dir():
            return
        # Exclusive creation avoids following a pre-existing temporary link.
        # Replacement also leaves any other hard link to the old entry intact.
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=str(path.parent),
            prefix=path.name + ".", suffix=".tmp", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(serialized)
        temporary.replace(path)
        temporary = None
    except OSError:
        return
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def source_paths(discovery: Any) -> List[Path]:
    """Every file the search read, including the ones it could not import.

    A module that failed to import is part of the key because fixing it is
    exactly the change that should invalidate the cache. A student who adds
    the missing package and re-runs must get a new search, not the refusal
    they were shown before.

    Retained package initializers also contribute, including transitive
    imports beyond discovery's traversal depth. Traversed initializers already
    have module records and should appear only once.
    """

    paths: List[Path] = []
    for entry in list(getattr(discovery, "modules", [])) + list(
        getattr(discovery, "skipped", [])
    ):
        path = getattr(entry, "path", None)
        if path is not None:
            paths.append(Path(path))
    for initializer in getattr(discovery, "initializers", []):
        path = Path(initializer)
        if path not in paths:
            paths.append(path)
    return paths
