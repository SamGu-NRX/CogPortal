"""Evidence gathering for the run-interference study.

This module produces and serializes the raw measurements the detector judges:
process-tree snapshots, file-descriptor snapshots, module-namespace
fingerprints, bounded output captures, and periodic samples of all of them
while a run is in flight. Nothing here decides whether something is a leak;
the detector (``detector.py``) owns that judgment and stays a pure function
of the dicts this module writes, so replay can re-derive every verdict from
saved artifacts without re-running anything.

Every function returns JSON-able data only. Evidence that cannot survive a
JSON round-trip cannot be replayed, so the constraint is load-bearing.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

__all__ = [
    "SIGNALS",
    "canonical_bytes",
    "fingerprint_value",
    "module_fingerprints",
    "fd_snapshot",
    "descendant_pids",
    "rss_kb",
    "dir_file_count",
    "CaptureSink",
    "Sampler",
]

#: The contamination signals this study measures. One finding per signal.
SIGNALS = (
    "mutated_arrays",
    "module_globals",
    "unclosed_handles",
    "leftover_children",
    "output_flooding",
)

#: Fingerprint inputs longer than this are hashed over their first 64 KiB. A
#: flooding adapter must not be able to make the evidence collector itself
#: the thing that runs out of memory.
_FINGERPRINT_INPUT_LIMIT = 64 * 1024

#: How many fd targets at most are recorded per snapshot. The count is the
#: signal; the targets are for reading the report.
_FD_TARGET_LIMIT = 200


def canonical_bytes(value: Any) -> bytes:
    """A stable byte encoding of a JSON-able value, for hashing.

    Sorted keys and no floating formatting slack: the same logical state must
    produce the same digest on two runs, or accumulation reads as noise.
    """

    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=repr).encode("utf-8")


def fingerprint_value(value: Any) -> Dict[str, Any]:
    """Describe a value by kind, size and digest, never by content.

    Fingerprints travel in saved artifacts, so they carry no payload: a large
    leaked cache shows up as a digest that changes, not as a copy of itself.
    """

    kind = type(value).__name__
    try:
        size = len(value)  # type: ignore[arg-type]
    except TypeError:
        size = None
    if isinstance(value, (str, bytes)):
        raw = value[:_FINGERPRINT_INPUT_LIMIT]  # type: ignore[union-attr]
    else:
        raw = canonical_bytes(value)[:_FINGERPRINT_INPUT_LIMIT]
    digest = hashlib.sha256(raw).hexdigest()[:16]
    return {"kind": kind, "size": size, "digest": digest}


def module_fingerprints(module: Any) -> Dict[str, Dict[str, Any]]:
    """Fingerprint the data state of one module namespace.

    Dunder names are machinery (``__name__``, ``__annotations__``) and are
    skipped; everything else is watched. Underscore-private DATA names are
    watched too — a module-level ``_CACHE`` or ``_CALL_LOG`` is exactly
    where adapter state accumulates, and privacy by underscore does not
    make it invisible to the next run. Modules, classes and functions are
    recorded as static markers: constant by construction, they can never
    read as accumulation, and their presence documents what the namespace
    held.
    """

    state: Dict[str, Dict[str, Any]] = {}
    for name, value in sorted(vars(module).items()):
        if name.startswith("__") and name.endswith("__"):
            continue
        if isinstance(value, type(os)) or callable(value) or isinstance(value, type):
            state[name] = {"kind": "static:" + type(value).__name__}
            continue
        try:
            state[name] = fingerprint_value(value)
        except Exception as error:  # noqa: BLE001 - evidence must not raise
            state[name] = {"kind": "unfingerprintable", "detail": type(error).__name__}
    return state


def _fd_target(fd: int) -> str:
    try:
        return os.readlink("/proc/self/fd/{}".format(fd))
    except OSError:
        return "unreadable"


def fd_snapshot() -> Dict[str, Any]:
    """Every open descriptor of this process, counted and classified.

    Linux-only by construction (/proc); on other platforms the study records
    the gap rather than pretending to have measured it.
    """

    if not os.path.isdir("/proc/self/fd"):
        return {"available": False, "count": None, "by_kind": {}, "targets": {}}
    targets: Dict[str, str] = {}
    unreadable = 0
    for entry in sorted(os.listdir("/proc/self/fd"))[:_FD_TARGET_LIMIT]:
        target = _fd_target(int(entry))
        if target == "unreadable":
            # The descriptor vanished between listing and readlink — a
            # snapshot race, not a handle anyone holds. Count it, never
            # classify it as a target a run left open.
            unreadable += 1
            continue
        targets[entry] = target
    by_kind: Dict[str, int] = {}
    for target in targets.values():
        kind = classify_fd_target(target)
        by_kind[kind] = by_kind.get(kind, 0) + 1
    return {"available": True, "count": len(os.listdir("/proc/self/fd")),
            "by_kind": by_kind, "targets": targets, "unreadable": unreadable}


def classify_fd_target(target: str) -> str:
    if target.startswith("socket:"):
        return "socket"
    if target.startswith("pipe:"):
        return "pipe"
    if target.startswith("anon_inode:"):
        return "anon_inode"
    return "file"


def _stat_fields(pid: int) -> Optional[Dict[str, Any]]:
    """ppid and cmdline for one pid, or None when it vanished mid-scan.

    A process can exit between the readdir and the read; a sampler that
    raised on that would report its own flakiness as the subject's.
    """

    try:
        with open("/proc/{}/stat".format(pid), "rb") as stream:
            stat = stream.read().decode("utf-8", "replace")
        with open("/proc/{}/cmdline".format(pid), "rb") as stream:
            cmdline = stream.read().decode("utf-8", "replace").replace("\0", " ").strip()
    except (OSError, ValueError):
        return None
    # comm is parenthesized and may contain spaces; the fields after the last
    # ')' start at state, and ppid is the second of them.
    tail = stat.rpartition(")")[2].split()
    if len(tail) < 2:
        return None
    return {"pid": pid, "ppid": int(tail[1]), "cmdline": cmdline[:120]}


def descendant_pids(root_pid: Optional[int] = None) -> List[Dict[str, Any]]:
    """Everything below ``root_pid`` in the process tree, with commands.

    Parentage, not process groups: a ``setsid`` descendant still shows here,
    while a group-kill would miss it. This is the observation; reaping is the
    supervisor's separate job.
    """

    root = root_pid if root_pid is not None else os.getpid()
    rows: List[Dict[str, Any]] = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        fields = _stat_fields(int(entry))
        if fields is not None:
            rows.append(fields)
    by_ppid: Dict[int, List[Dict[str, Any]]] = {}
    for row in rows:
        by_ppid.setdefault(row["ppid"], []).append(row)
    found: List[Dict[str, Any]] = []
    frontier = [root]
    while frontier:
        current = frontier.pop()
        for child in by_ppid.get(current, []):
            found.append({"pid": child["pid"], "ppid": child["ppid"], "cmdline": child["cmdline"]})
            frontier.append(child["pid"])
    return sorted(found, key=lambda row: row["pid"])


def rss_kb() -> Optional[int]:
    """Resident set of this process in KiB, from /proc when present."""

    try:
        with open("/proc/self/status", "r", encoding="utf-8") as stream:
            for line in stream:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def dir_file_count(root: Path) -> Dict[str, Any]:
    """Files under ``root``, counted and named, capped for report size."""

    if not root.exists():
        return {"count": 0, "names": []}
    names: List[str] = []
    for current, _dirs, files in os.walk(root):
        for name in files:
            names.append(str(Path(current).relative_to(root) / name))
    names.sort()
    return {"count": len(names), "names": names[:_FD_TARGET_LIMIT]}


class CaptureSink(io.TextIOBase):
    """A stdout/stderr stand-in with a hard byte cap and thread-local buffers.

    In-process runs cannot be killed for printing too much, so flooding is
    contained where it can be: each writer thread accumulates into its own
    buffer until the cap, after which bytes are counted but not stored. The
    cap bounds what a flooding adapter can take out from under the supervisor.
    """

    def __init__(self, cap_bytes: int) -> None:
        self._cap = cap_bytes
        self._local = threading.local()

    def _buffer(self) -> Dict[str, Any]:
        buffer = getattr(self._local, "buffer", None)
        if buffer is None:
            buffer = {"chunks": [], "bytes": 0, "dropped_bytes": 0, "lines": 0, "overflowed": False}
            self._local.buffer = buffer
        return buffer

    def write(self, text: str) -> int:  # type: ignore[override]
        buffer = self._buffer()
        buffer["lines"] += text.count("\n")
        remaining = self._cap - buffer["bytes"]
        if remaining > 0:
            kept = text[:remaining]
            buffer["chunks"].append(kept)
            buffer["bytes"] += len(kept)
        if len(text) > remaining:
            buffer["dropped_bytes"] += len(text) - max(remaining, 0)
            buffer["overflowed"] = True
        return len(text)

    def flush(self) -> None:
        pass

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return "utf-8"

    def isatty(self) -> bool:
        return False

    def take(self) -> Dict[str, Any]:
        """Return and reset this thread's capture stats.

        Per-run evidence reads this at a run boundary: runs on the same
        worker thread are sequential, so a take between them splits the
        stream without tagging every write.
        """

        buffer = self._buffer()
        self._local.buffer = None
        return {
            "bytes": buffer["bytes"],
            "dropped_bytes": buffer["dropped_bytes"],
            "lines": buffer["lines"],
            "overflowed": buffer["overflowed"],
            "head": "".join(buffer["chunks"])[:400],
        }


class Sampler:
    """Periodic before-during-after counts while a run is in flight.

    The series is the only way "during" is ever honest: end-point snapshots
    cannot show a transient orphan that died or was reaped between them.
    """

    def __init__(
        self,
        interval_seconds: float,
        root_pid: Optional[int] = None,
        scratch_dir: Optional[Path] = None,
    ) -> None:
        self._interval = interval_seconds
        self._root_pid = root_pid if root_pid is not None else os.getpid()
        self._scratch = scratch_dir
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.samples: List[Dict[str, Any]] = []

    def _sample_once(self) -> None:
        descendants = descendant_pids(self._root_pid)
        self.samples.append(
            {
                "t_ms": int((time.monotonic() - self._t0) * 1000),
                "descendant_count": len(descendants),
                "descendants": descendants[:8],
                "fd_count": fd_snapshot()["count"],
                "scratch_files": dir_file_count(self._scratch)["count"] if self._scratch else None,
                "rss_kb": rss_kb(),
            }
        )

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._sample_once()
            if self._stop.wait(self._interval):
                break

    def start(self) -> None:
        self._t0 = time.monotonic()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="ri-sampler")
        self._thread.start()

    def stop(self) -> List[Dict[str, Any]]:
        if self._thread is not None:
            self._stop.set()
            self._thread.join(timeout=2.0)
            self._thread = None
            self._sample_once()
        return self.samples
