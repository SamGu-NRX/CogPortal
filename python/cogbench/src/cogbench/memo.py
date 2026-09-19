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
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set

from .pipeline import _under_clock
from .storage import _checkout_path, _replace_text, workspace_dir

__all__ = ["fingerprint", "read", "write", "cache_path"]

#: Bumped when a change would make an old entry wrong: a different search
#: order, a different acceptance test, a different set of stages. The key
#: covers the student's code, and this covers ours.
#: 14: a step now records the keyword arguments it passes, as the parameter
#: and the slot filling it. A 13 entry does not carry them, so a step the
#: search called with a keyword-only argument would be replayed without it,
#: which is a different call and usually a `TypeError` from their own
#: function. Every trial also gets its own reading of the repository now, so
#: a pairing an earlier trial's module-level leftovers had made raise is
#: reachable, and a 13 entry can name a worse pairing than the search would
#: pick today.
FORMAT = 14


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
        _checkout_path(repository, path)
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
    try:
        workspace_dir(Path(repository))
        _replace_text(path, serialized)
    except OSError:
        return


def source_paths(discovery: Any) -> List[Path]:
    """Every file the search read, including the ones it could not import.

    A module that failed to import is part of the key because fixing it is
    exactly the change that should invalidate the cache. A student who adds
    the missing package and re-runs must get a new search, not the refusal
    they were shown before.

    The retained import context contributes transitive project sources beyond
    discovery's traversal depth. Its inventory replaces a separate process scan
    for package initializers and also covers ordinary imported modules.
    """

    paths: List[Path] = []
    for entry in list(getattr(discovery, "modules", [])) + list(
        getattr(discovery, "skipped", [])
    ):
        path = getattr(entry, "path", None)
        if path is not None:
            paths.append(Path(path))
    for source in discovery.imports().files:
        path = Path(source)
        if path not in paths:
            paths.append(path)
    return paths
