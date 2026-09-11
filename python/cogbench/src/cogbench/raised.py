"""Where in a repository's own code an exception was raised.

A student reads a compiler error by its location: file, line, message. The
platform holds that location on every exception their code raises during a
search, and until now dropped it. One 2026 repository whose ``create_graph``
raises ``AttributeError`` at ``whispers.py:66`` (its first line is
``from pyexpat import model``, so ``model.detect`` is a module attribute that
does not exist) was told only that nothing accepted the input the descriptors
step passes. True, and nothing a team can act on.

The rule is one sentence and is the whole of this module: **their frame is the
innermost traceback frame whose file is inside their repository**. A raise
whose traceback never enters their repository at all is not theirs and is not
reported; a raise that passes through numpy, torch or the standard library on
its way out of their code still is. That second part is what keeps probe noise
out of the report: the search calls candidates with input they may not take, and a
call with the wrong arity raises ``TypeError`` from the calling frame, which is
ours.
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Tuple

__all__ = [
    "Raised",
    "location",
    "message_of",
    "their_line",
    "where_it_raised",
    "root_of_their_code",
]

#: How much of an exception's own words to keep. A first line at this length
#: still holds a key name, a shape, or an attribute; anything longer is a
#: traceback pasted into a message.
MESSAGE_LIMIT = 200


@dataclass(frozen=True)
class Raised:
    """One exception out of their code, in the shape a compiler reports."""

    #: Repository-relative, POSIX separators, so two machines print the same
    #: line for the same file.
    file: str
    #: Zero when the file has no line a reader could open to; see `location`.
    line: int
    #: Which of their functions the search was calling. Their own label, the
    #: same string the trace and the chain use.
    function: str
    #: Exception type and its first line.
    message: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "file": self.file,
            "line": self.line,
            "function": self.function,
            "message": self.message,
        }

    @classmethod
    def from_dict(cls, record: Dict[str, object]) -> "Raised":
        return cls(file=record["file"], line=record["line"],
                   function=record["function"], message=record["message"])

    def line_text(self) -> str:
        """The compiler-style line: where, what, and in whose function."""

        return "{}: {} (in {})".format(
            location(self.file, self.line), self.message, self.function
        )


def location(file: str, line: int) -> str:
    """``file:line``, or the file alone when the line points nowhere.

    A notebook is not a module, so cogbench builds one out of the cells that
    hold definitions and compiles it under the notebook's own path. The
    filename is right and the line number counts lines of that synthesized
    module: on a small fixture, line 2 of the traceback is `"cells": [` in
    the .ipynb itself. Printing it would send a team to a line of JSON.
    """

    return "{}:{}".format(file, line) if line else file


def message_of(error: BaseException) -> str:
    """The exception's type and first line, capped.

    Type first because a bare ``'song_list'`` says nothing and
    ``KeyError: 'song_list'`` says what happened.
    """

    try:
        message = str(error)
        start, end = 0, len(message)
        while start < end and message[start].isspace():
            start += 1
        while end > start and message[end - 1].isspace():
            end -= 1
        # Slice before splitting: a multiline error must not allocate a list
        # proportional to its length just to display at most MESSAGE_LIMIT chars.
        text = message[start:min(end, start + MESSAGE_LIMIT)].splitlines()
    except BaseException:
        # A student's __str__ must not replace the error we are reporting.
        text = []
    head = text[0] if text else ""
    whole = "{}: {}".format(type(error).__name__, head) if head else type(error).__name__
    return whole[:MESSAGE_LIMIT]


def where_it_raised(error: BaseException, root: Path) -> Optional[Tuple[str, int]]:
    """The innermost frame of this traceback that lies inside ``root``.

    ``None`` when the raise never entered their code, which is the ordinary
    case for a probe the callee refused before running.
    """

    # Resolved, because the frame paths are: a caller that hands over
    # `/var/folders/...` and a traceback that says `/private/var/folders/...`
    # are naming one directory on macOS, and comparing them unresolved says
    # nothing in the repository raised.
    root = Path(root).resolve()
    for frame in reversed(traceback.extract_tb(error.__traceback__)):
        if frame.filename.startswith("<") and frame.filename.endswith(">"):
            continue
        try:
            where = Path(frame.filename).resolve()
        except (OSError, ValueError):
            # Other invalid filename labels must not break error reporting.
            continue
        try:
            inside = where.relative_to(root)
        except ValueError:
            continue
        # A notebook's line number belongs to the module cogbench built
        # out of its cells, not to the file; see `location`.
        line = 0 if where.suffix == ".ipynb" else int(frame.lineno or 0)
        return inside.as_posix(), line
    return None


def root_of_their_code(error: BaseException, ours: Path) -> Optional[Path]:
    """Where their code starts, for a caller that has no checkout path.

    Discovery knows the repository root and passes it. A scored run does not:
    the benchmark's driver holds their adapter, not the directory their files
    were read from. What it does know exactly is where its own code ends, so
    the outermost frame below ``ours`` is their entry point and its directory
    is the tree to report against.
    """

    ours = Path(ours).resolve()
    entered_ours = False
    for frame in traceback.extract_tb(error.__traceback__):
        if frame.filename.startswith("<") and frame.filename.endswith(">"):
            continue
        try:
            where = Path(frame.filename).resolve()
        except (OSError, ValueError):
            # See `where_it_raised`: a frame's filename is a label.
            continue
        try:
            where.relative_to(ours)
        except ValueError:
            if entered_ours:
                return where.parent
            continue
        entered_ours = True
    return None


def their_line(error: BaseException, ours: Path) -> Optional[str]:
    """``Type: message at file:line``, when this came out of their own code.

    What a benchmark driver wants in one call. A scored run reports a raised
    case as wrong and counts each distinct message, and the message is worth
    much more with a place attached: `identify raised 'x'` names almost
    nothing, `identify raised KeyError: 'x' at match.py:41` names a line.

    ``ours`` is the directory holding the caller's own package. ``None`` when
    the raise never reached their code, which is every failure a driver
    reports about itself.
    """

    root = root_of_their_code(error, ours)
    if root is None:
        return None
    spot = where_it_raised(error, root)
    if spot is None:
        return None
    return "{} at {}".format(message_of(error), location(*spot))
