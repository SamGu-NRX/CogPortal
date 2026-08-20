"""Say what happened, in the one sentence a student can act on.

Discovery has five outcomes and they call for different things, so collapsing
them into "it failed" wastes the only information the student needs:

``scored``
    We wired your code and ran it. The number is yours, whatever it is. A low
    number here is a result, not an error, and the platform says so rather
    than implying something went wrong.

``wired_but_wrong``
    We wired your code, it ran end to end, and it returned the wrong answer on
    a case the benchmark made up and knows the answer to. This is the finding
    that matters most and the one a scoreboard cannot express. It is a bug in
    the pipeline, it is theirs to find, and the report's job is to hand them
    the smallest reproduction we have: which of their functions ran, in what
    order, on what input, and what came back.

``not_wired``
    We could not find a chain of your functions that performs this task. The
    report names the furthest point reached and the exact hand-off that failed,
    because "we could not read your repository" is not something a student can
    act on and "your peak finder returned a list of 440 single numbers where
    the next stage wanted pairs" is.

``not_read``
    We could not import your code at all, or the interpreter died trying. Names
    the module and the reason.

``nothing_here``
    There is no code in this repository. Rare, and worth saying plainly rather
    than dressing up as a failure.

What this module deliberately does not do is diagnose. A programmatic system
cannot tell a student why their fanout is wrong, and pretending to would be
worse than silence: a confident wrong explanation costs more than none. What it
can do is be specific about what it observed, which is what makes the bug
findable. The line is: report what ran and what came back, never why it is
wrong or what to change.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

__all__ = [
    "SCORED",
    "WIRED_BUT_WRONG",
    "NOT_WIRED",
    "NOT_READ",
    "NOTHING_HERE",
    "Observation",
    "Verdict",
    "wired_but_wrong",
    "not_wired",
    "not_read",
    "nothing_here",
    "scored",
]

SCORED = "scored"
WIRED_BUT_WRONG = "wired_but_wrong"
NOT_WIRED = "not_wired"
NOT_READ = "not_read"
NOTHING_HERE = "nothing_here"

#: How much of a value to show. Long enough to see a shape and a first element,
#: short enough that a report stays readable.
_SUMMARY_LIMIT = 160


def describe(value: Any) -> str:
    """What a value is, in the terms a student would recognise it by.

    Shape and length before contents. "a list of 5158 pairs" says more about a
    fingerprint list than its first two entries do, and an array preview is
    almost always noise: what a reader checks is whether the shape is the one
    their next function expects.
    """

    shape = getattr(value, "shape", None)
    if shape is not None:
        return "an array of shape {}".format(tuple(shape))
    if isinstance(value, (list, tuple, set)):
        name = {"list": "a list", "tuple": "a tuple", "set": "a set"}.get(
            type(value).__name__, "a " + type(value).__name__
        )
        if not value:
            return "an empty {}".format(type(value).__name__)
        first = next(iter(value))
        inner = getattr(first, "shape", None)
        if inner is not None:
            return "{} of {}, starting with an array of shape {}".format(
                name, len(value), tuple(inner)
            )
        head = repr(first)
        if len(head) > 48:
            head = head[:45] + "..."
        return "{} of {}, starting {}".format(name, len(value), head)
    if isinstance(value, dict):
        return "a dict of {} entries".format(len(value))
    if value is None:
        return "None"
    text = repr(value)
    return text if len(text) <= _SUMMARY_LIMIT else text[: _SUMMARY_LIMIT - 3] + "..."


@dataclass(frozen=True)
class Observation:
    """One step that ran: whose function, what went in, what came out."""

    stage: str
    #: ``module.function``, the way it appears in their repository.
    function: str
    received: str
    returned: str

    def line(self) -> str:
        return "{}: {} received {} and returned {}".format(
            self.stage, self.function, self.received, self.returned
        )


@dataclass(frozen=True)
class Verdict:
    """What happened, and the one thing worth doing about it."""

    status: str
    #: One sentence, largest type on the page. Never generated, always
    #: assembled from what was observed.
    headline: str
    #: The steps that ran, in order. Empty when nothing ran.
    trace: Tuple[Observation, ...] = ()
    #: The single next action, when there is one that is honestly ours to
    #: name. Absent for a bug in their code: which line is wrong is theirs.
    next_step: str = ""
    #: Anything a reader might want that does not belong in the headline.
    notes: Tuple[str, ...] = ()

    @property
    def is_failure(self) -> bool:
        return self.status in (NOT_WIRED, NOT_READ, NOTHING_HERE)

    @property
    def is_theirs_to_fix(self) -> bool:
        """Whether this is a bug in their code rather than a wiring problem.

        The distinction the whole module exists for. A wiring problem is ours
        to explain and often ours to fix; a wrong answer from a pipeline that
        ran is theirs, and saying so is more respectful of their work than
        implying the platform failed.
        """

        return self.status == WIRED_BUT_WRONG

    def to_dict(self) -> Dict[str, object]:
        return {
            "status": self.status,
            "headline": self.headline,
            "trace": [
                {
                    "stage": step.stage,
                    "function": step.function,
                    "received": step.received,
                    "returned": step.returned,
                }
                for step in self.trace
            ],
            "nextStep": self.next_step,
            "notes": list(self.notes),
        }

    def render(self) -> str:
        """The whole verdict as text, for the terminal and the run log."""

        lines = [self.headline]
        if self.trace:
            lines.append("")
            lines.append("What ran:")
            lines.extend("  " + step.line() for step in self.trace)
        for note in self.notes:
            lines.append("")
            lines.append(note)
        if self.next_step:
            lines.append("")
            lines.append(self.next_step)
        return "\n".join(lines)


def scored(primary: str, value: float, trace: Sequence[Observation] = ()) -> Verdict:
    """The ordinary outcome: their code ran and produced a number."""

    return Verdict(
        SCORED,
        "{} is {:.4f}.".format(primary, value),
        tuple(trace),
    )


def wired_but_wrong(
    task: str,
    expected: str,
    got: str,
    trace: Sequence[Observation],
    *,
    notes: Sequence[str] = (),
) -> Verdict:
    """Their pipeline ran end to end and returned the wrong answer.

    The headline states the case and both answers and stops. No guess at a
    cause: a system that cannot read their code cannot know whether the fanout
    is too narrow or the database key is wrong, and a confident wrong
    explanation is worse than none.

    What makes this actionable is the trace, which is the smallest failing
    reproduction the platform has: every step, every hand-off, in their own
    function names, on an input the benchmark can describe exactly.
    """

    return Verdict(
        WIRED_BUT_WRONG,
        "Your code ran end to end. On {}, it answered {} where the answer is {}.".format(
            task, got, expected
        ),
        tuple(trace),
        next_step="",
        notes=tuple(notes)
        + (
            "Every step above is your own function. The benchmark passed the "
            "input each one asked for and passed its result to the next.",
        ),
    )


def not_wired(
    task: str,
    stage: str,
    trace: Sequence[Observation],
    *,
    last_returned: str = "",
    next_step: str = "",
) -> Verdict:
    """No chain of their functions performs the task.

    The headline names the hand-off that failed rather than the task, because
    "we could not score you" is not usable and "nothing accepted what
    make_spectrogram returned" is.
    """

    if trace:
        headline = (
            "Nothing in your repository took {} for the {} step, which is what "
            "{} returned.".format(
                last_returned or "that", stage, trace[-1].function
            )
        )
    else:
        headline = (
            "Nothing in your repository accepted the input the {} step "
            "passes.".format(stage)
        )
    return Verdict(NOT_WIRED, headline, tuple(trace), next_step=next_step)


def not_read(module: str, reason: str, *, next_step: str = "") -> Verdict:
    """Their code could not be imported, or the interpreter died trying."""

    return Verdict(
        NOT_READ,
        "{} could not be imported: {}".format(module, reason),
        next_step=next_step,
    )


def nothing_here(repository: str) -> Verdict:
    return Verdict(
        NOTHING_HERE,
        "There is no Python in {} yet.".format(repository),
        next_step="Push your capstone code and run this again.",
    )
