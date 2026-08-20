"""What `cogworks check` prints.

The first thing a student saw was nine lines of ``False`` and no next step.
Every one of them was true and none of them said what to do, which is the
worst shape a diagnostic can take: it looks like the tool is working and
leaves the reader with nothing.

So this prints what was found, in the order a person asks about it. Where is
your code. Which files did we read, and which could we not. What did we wire
up. Then one line: either you are ready, or here is the single next thing.

Two rules hold. The report never claims more than it saw, so a module that was
skipped is named with the reason rather than folded into a count. And it never
guesses at a fix it does not know: a missing package is ours to name, and a
function that returns the wrong thing is theirs to read.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence

__all__ = ["render_check", "render_survey"]

#: Wide enough for the longest label, narrow enough to read on a laptop.
_LABEL = 22


def _line(label: str, value: str) -> str:
    return "{:<{}} {}".format(label, _LABEL, value)


def _plural(count: int, one: str, many: Optional[str] = None) -> str:
    return "{} {}".format(count, one if count == 1 else (many or one + "s"))


def render_survey(record: Dict[str, object]) -> List[str]:
    """What discovery found in the repository, and what it could not read."""

    lines: List[str] = []
    modules = record.get("modules") or []
    skipped = record.get("skipped") or []

    root = str(record.get("root", ""))
    reason = str(record.get("rootReason", ""))
    if root:
        lines.append(_line("looked in", "{}  ({})".format(root.split("/")[-1] or root, reason)))

    if modules:
        names = ", ".join(str(entry["name"]) for entry in modules)  # type: ignore[index]
        lines.append(_line("read", "{}: {}".format(_plural(len(modules), "file"), names)))
        from_notebooks = [
            str(entry["name"])  # type: ignore[index]
            for entry in modules
            if entry.get("origin") == "notebook"  # type: ignore[union-attr]
        ]
        if from_notebooks:
            lines.append(
                _line(
                    "from notebooks",
                    "{} (definitions only; the cells were not run)".format(
                        ", ".join(from_notebooks)
                    ),
                )
            )
    else:
        lines.append(_line("read", "nothing"))

    # A team's own scripts fail here for reasons that are not problems: they
    # read audio from a data/ directory this machine does not have. Listing
    # fifteen of those buries the one skip that matters, so they are counted
    # and the ones that could have held pipeline code are named.
    notable = [entry for entry in skipped if not _is_their_own_script(entry)]
    routine = len(skipped) - len(notable)

    for entry in notable:
        name = str(entry["name"])  # type: ignore[index]
        lines.append(_line("could not read", "{}: {}".format(name, entry["detail"])))  # type: ignore[index]
    if routine:
        lines.append(
            _line(
                "skipped",
                "{} that read files or a microphone this machine does not have"
                .format(_plural(routine, "script")),
            )
        )

    return lines


def _is_their_own_script(entry: Dict[str, object]) -> bool:
    """Whether a skipped file is a runner rather than part of the pipeline.

    A module that could not open an audio file it expects beside itself is a
    script the team runs by hand, not a stage. Naming every one of those
    drowns the skip that matters, which is a module the benchmark might have
    needed.
    """

    name = str(entry.get("name", "")).lower()
    detail = str(entry.get("detail", ""))
    if name.startswith("test") or name.startswith("run") or "demo" in name:
        return True
    return detail.startswith(("FileNotFoundError", "EOFError", "OSError"))


def render_check(
    *,
    benchmark: str,
    python_version: str,
    hosted_python: Optional[str],
    benchmark_ready: bool,
    repository: Optional[str],
    submission: Optional[object] = None,
    survey: Optional[Dict[str, object]] = None,
) -> List[str]:
    """The whole report, in the order a person asks about it.

    ``submission`` is a ``cogbench.resolve.Submission`` when discovery ran.
    Passing ``None`` means it did not, which is itself worth saying rather
    than leaving the reader to infer it from a missing section.
    """

    lines: List[str] = []
    lines.append(_line("benchmark", benchmark if benchmark_ready else benchmark + " (not installed)"))
    lines.append(_line("python", python_version))
    if hosted_python and hosted_python != python_version:
        lines.append(
            _line(
                "hosted python",
                "{} (the hidden evaluation runs on this)".format(hosted_python),
            )
        )
    lines.append(_line("repository", repository or "not a git repository"))

    if survey:
        lines.append("")
        lines.extend(render_survey(survey))

    if submission is None:
        lines.append("")
        if not benchmark_ready:
            lines.append("Nothing was searched for, because {} is not installed here.".format(benchmark))
            lines.append("Install it, then run this again.")
        else:
            # The other way to get here: an installed submission package
            # already answers for this benchmark, so there was nothing to
            # search for. Saying "not installed" would be a lie, and a
            # confusing one, since the benchmark plainly ran.
            lines.append("Your submission is registered as an installed package, so it was used as is.")
        return lines

    chain = getattr(submission, "chain", ())
    attempt = getattr(submission, "attempt", None)
    verdict = getattr(submission, "verdict", None)

    # The trace names each step by the stage it filled; the chain is the
    # fallback for a resolution that produced no trace. Either is enough to
    # show the section, and so is a store and query pair on its own.
    steps = [
        (step.stage, step.function)
        for step in (getattr(verdict, "trace", ()) or ())
    ] or [("", step.label) for step in chain]
    if steps or attempt is not None:
        lines.append("")
        lines.append("Wired up:")
        for stage, function in steps:
            lines.append("  {:<14} {}".format(stage, function))
        if attempt is not None:
            lines.append("  {:<14} {}".format("store", attempt.enroll))
            lines.append("  {:<14} {}".format("query", attempt.query))

    lines.append("")
    if verdict is not None:
        lines.append(verdict.headline)
        for note in getattr(verdict, "notes", ()):
            lines.append(note)
        if getattr(verdict, "next_step", ""):
            lines.append("")
            lines.append(verdict.next_step)

    if getattr(submission, "ready", False):
        lines.append("")
        lines.append(
            "Run `cogworks run --benchmark {}` to score it on your machine.".format(benchmark)
        )

    return lines
