"""Showing a long search while it runs.

Finding a team's code takes as long as it takes. One repository in the 2026
corpus resolves in 35 attempts and another in 3962, and the slow one spends
about ninety seconds enrolling two songs and asking for one back, over and
over, until a pair of their functions answers correctly. A terminal that sits
silent for ninety seconds looks broken, and a student who thinks it is broken
kills it and never sees the answer.

So the search says what it is doing. Two rules keep that honest:

The total is counted, not guessed. Every number here comes from the search
itself: the pairings it will try, the ones it has tried. Nothing is
extrapolated from a benchmark run on someone else's laptop.

The estimate is an upper bound and says so. The search stops the moment a
pairing works, which can happen on the next attempt or not at all, so a
countdown that reads like a prediction would be wrong most of the time. It
reads "at most" because that is the only claim the number supports.

Nothing here renders unless the output is a terminal. Piped to a file or run
in CI, the spinner would be thousands of escape codes in a log, so it goes
quiet and only the report is printed.
"""

from __future__ import annotations

import sys
import time
from typing import IO, List, Optional

__all__ = ["Progress", "TerminalProgress", "Silent"]

#: Braille frames. They occupy one cell in every terminal font we care about,
#: so the line does not jitter as it turns.
_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

#: About twelve frames a second. Faster reads as noise and costs syscalls in a
#: loop that is already the slow part of the run.
_FRAME_SECONDS = 0.08

#: Below this, an estimate is noise: the search may well finish before the
#: student has read the line.
_WORTH_ESTIMATING_SECONDS = 3.0

#: Attempts to see before extrapolating from them. The first pairing carries
#: the cost of warming a student's imports and their first call into numba, so
#: one sample said "2m 06s" for a search that took 23 seconds. Waiting for a
#: few hundred costs a second of silence and stops the first number shown from
#: being the wrong one by a factor of five.
_ENOUGH_TO_EXTRAPOLATE = 200


class Progress:
    """What a search reports as it runs.

    The default does nothing, which is what a library call wants: ``resolve``
    is used by the Modal runner and the portal worker as well as the terminal,
    and neither of those has anywhere to put a spinner.
    """

    def phase(self, headline: str) -> None:
        """A new part of the search began."""

    def found(self, stage: str, label: str) -> None:
        """One stage of the pipeline was bound to one of their functions."""

    def attempts(self, done: int, total: int) -> None:
        """Progress through a search whose size is known in advance."""

    def note(self, text: str) -> None:
        """Something worth saying that is not a phase or a count."""

    def done(self) -> None:
        """The search ended, one way or another. Clean up any live line."""


Silent = Progress


class TerminalProgress(Progress):
    """A live line on a terminal, and nothing anywhere else.

    Lines that describe something settled are printed permanently. The line
    that changes is rewritten in place and erased when the phase ends, so what
    remains on screen afterwards is a record of what happened rather than the
    last frame of an animation.
    """

    def __init__(self, stream: Optional[IO[str]] = None, *, clock=time.monotonic) -> None:
        self._stream = stream if stream is not None else sys.stderr
        self._clock = clock
        self._live = False
        self._frame = 0
        self._last_draw = float("-inf")
        self._started = 0.0
        self._headline = ""

    @property
    def enabled(self) -> bool:
        """Whether anything is drawn at all.

        Progress goes to stderr so that ``cogworks check --json`` stays a
        clean pipe, but stderr can be redirected too, and a spinner in a log
        file is thousands of escape codes nobody reads.
        """

        return bool(getattr(self._stream, "isatty", lambda: False)())

    def phase(self, headline: str) -> None:
        self._erase()
        self._headline = headline
        self._started = self._clock()
        # Far enough back that the first attempt always draws. Starting at the
        # clock's own zero made the opening frame look like it had just been
        # drawn, so a fast search finished having shown nothing at all.
        self._last_draw = float("-inf")
        if self.enabled:
            self._write("{}\n".format(headline))

    def found(self, stage: str, label: str) -> None:
        self._erase()
        if self.enabled:
            self._write("  {:<14} {}\n".format(stage, label))

    def note(self, text: str) -> None:
        self._erase()
        if self.enabled:
            self._write("  {}\n".format(text))

    def attempts(self, done: int, total: int) -> None:
        if not self.enabled or total <= 0:
            return
        now = self._clock()
        # Always draw the last frame, so the line does not stop on 3961/3962
        # and leave a student wondering whether it hung on the final one.
        if done < total and now - self._last_draw < _FRAME_SECONDS:
            return
        self._last_draw = now
        self._frame = (self._frame + 1) % len(_FRAMES)

        elapsed = now - self._started
        line = "  {} {} {}".format(
            _FRAMES[self._frame], _bar(done, total), _count(done, total)
        )
        remaining = _estimate(done, total, elapsed)
        if remaining:
            line += "   {}".format(remaining)
        self._erase()
        self._write(line)
        self._live = True

    def done(self) -> None:
        self._erase()

    def _erase(self) -> None:
        if self._live and self.enabled:
            # Carriage return then clear-to-end-of-line. Writing spaces
            # instead wraps on a narrow terminal and eats the line above.
            self._write("\r\x1b[2K")
        self._live = False

    def _write(self, text: str) -> None:
        try:
            self._stream.write(text)
            self._stream.flush()
        except (ValueError, OSError):
            # A closed or broken stream must not take the run with it. The
            # report matters; the animation does not.
            self._live = False


#: Wide enough to show movement, narrow enough to leave room for the count and
#: the estimate inside eighty columns.
_BAR_CELLS = 24


def _bar(done: int, total: int) -> str:
    filled = int(_BAR_CELLS * min(done, total) / total) if total else 0
    return "[{}{}]".format("#" * filled, "." * (_BAR_CELLS - filled))


def _count(done: int, total: int) -> str:
    return "{:,}/{:,} attempts".format(done, total)


def _estimate(done: int, total: int, elapsed: float) -> str:
    """How much longer, at most, phrased as the bound it actually is.

    The search ends at the first pairing that works, so the remaining time is
    the most it can take and not what it will take. Saying "at most" is the
    difference between a number a student can trust and one that is wrong
    nine times out of ten.
    """

    if done < _ENOUGH_TO_EXTRAPOLATE or elapsed <= 0 or done >= total:
        return ""
    remaining = (elapsed / done) * (total - done)
    if remaining < _WORTH_ESTIMATING_SECONDS:
        return ""
    return "{} left at most".format(_duration(remaining))


def _duration(seconds: float) -> str:
    if seconds < 60:
        return "{:.0f}s".format(seconds)
    minutes, rest = divmod(int(seconds), 60)
    if minutes < 60:
        return "{}m {:02d}s".format(minutes, rest)
    hours, minutes = divmod(minutes, 60)
    return "{}h {:02d}m".format(hours, minutes)
