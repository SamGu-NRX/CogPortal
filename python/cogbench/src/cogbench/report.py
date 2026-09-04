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


def _wrapped(text: str, width: int = 78) -> List[str]:
    """A paragraph broken to terminal width.

    Every other line here is a label and a short value, so nothing needed
    wrapping before. A paragraph printed as one line wraps at whatever the
    terminal happens to be and breaks mid-package-name, which is the one part
    of this report a student is meant to read carefully.
    """

    import textwrap

    return textwrap.wrap(text, width=width) or [""]


def render_survey(record: Dict[str, object]) -> List[str]:
    """What discovery found in the repository, and what it could not read."""

    lines: List[str] = []
    modules = record.get("modules") or []
    skipped = record.get("skipped") or []

    root = str(record.get("root", ""))
    reason = str(record.get("rootReason", ""))
    if root:
        lines.append(_line("looked in", "{}  ({})".format(root.split("/")[-1] or root, reason)))

    # "We could not look" and "there was nothing to find" are different claims
    # and used to print the same line. A survey whose subprocess died returns
    # empty lists, which is exactly what an empty repository returns, so a
    # student whose module crashed the reader was told their repository held
    # nothing. Said first, because it changes how every line under it reads.
    if record.get("unread"):
        why = str(record.get("unreadReason", "")).strip()
        lines.append(
            _line(
                "could not finish",
                "reading this repository stopped early{}".format(
                    ": " + why if why else ""
                ),
            )
        )
        stopped_on = str(record.get("endedWhileReading", "")).strip()
        if stopped_on:
            lines.append(
                _line("stopped while reading", stopped_on.split("/")[-1] or stopped_on)
            )
        if modules or skipped:
            lines.append(
                _line(
                    "partial",
                    "what follows is what was read before it stopped, not the "
                    "whole repository",
                )
            )
        else:
            # Nothing survived, so there is nothing below to qualify. Saying
            # "read nothing" here would be the exact false statement this
            # branch exists to prevent.
            lines.append(_line("read", "unknown; nothing was reported before it stopped"))
            return lines

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
    local_gap_note: str = "",
    submission_source: Optional[str] = None,
) -> List[str]:
    """The whole report, in the order a person asks about it.

    ``submission`` is a ``cogbench.resolve.Submission`` when discovery ran.
    Passing ``None`` means it did not, which is itself worth saying rather
    than leaving the reader to infer it from a missing section.

    ``submission_source`` is how the CLI found a declared submission, when it
    found one: ``"file"`` or ``"entry_point"``. It decides which sentence
    explains a report with no search in it, because "your package was used
    as is" and "this benchmark cannot be searched for" are different facts
    and the reader acts differently on each.

    ``local_gap_note`` is one paragraph naming the graded run's packages this
    machine cannot import. It goes directly under the list of files that were
    read, because that list is the thing it qualifies: this command can only
    read modules whose imports resolve here, and the graded run resolves more
    of them.
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

    # The gap note is a caveat: "this report may have read less than the
    # graded run will." When the run actually stopped because of that gap the
    # verdict says so outright, and printing both makes the reader work out
    # that two paragraphs are one fact. The verdict wins, because it is
    # specific about which modules and this is general.
    verdict_covers_the_gap = (
        getattr(getattr(submission, "verdict", None), "status", "") == "could_not_look"
    )
    if local_gap_note and not verdict_covers_the_gap:
        lines.append("")
        lines.extend(_wrapped(local_gap_note))

    if submission is None:
        lines.append("")
        if not benchmark_ready:
            lines.append("Nothing was searched for, because {} is not installed here.".format(benchmark))
            lines.append("Install it, then run this again.")
        elif submission_source == "entry_point":
            # An installed submission package already answers for this
            # benchmark, so there was nothing to search for.
            lines.append("Your submission is registered as an installed package, so it was used as is.")
        elif submission_source == "file":
            lines.append("Your submission.py at the repository root was used, so nothing was searched for.")
        else:
            # Nothing declared and nothing searched: this benchmark does not
            # describe its task to the search. Before this branch existed the
            # sentence above printed here, and a Week 3 repository with no
            # package and no adapter was told its package "was used as is".
            lines.append(
                "Nothing was searched for: {} does not yet describe its task to "
                "the search, so a submission must be declared.".format(benchmark)
            )
            lines.append(
                "Add a benchmark_adapter.py at the repository root that defines "
                "create_search_adapter(resources), then run this again."
            )
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
        labels = [stage for stage, _ in steps]
        if attempt is not None:
            labels += ["store", "query"]
        # Sized to the widest label rather than fixed, because a function that
        # does two steps is named for both ("spectrogram + peaks") and a fixed
        # column put the rest of that row out of line with every other one.
        width = max([len(label) for label in labels] + [14])
        for stage, function in steps:
            lines.append("  {:<{}} {}".format(stage, width, function))
        if attempt is not None:
            lines.append("  {:<{}} {}".format("store", width, attempt.enroll))
            lines.append("  {:<{}} {}".format("query", width, attempt.query))

    lines.append("")
    if verdict is not None:
        lines.append(verdict.headline)
        for note in getattr(verdict, "notes", ()):
            lines.append(note)
        # The files that could not be read and the lines their code raised
        # on. Taken from the verdict rather than formatted here, so `cogworks
        # check` and a run page cannot come to print two different reports
        # out of one record.
        lines.extend(verdict.problems())
        if getattr(verdict, "next_step", ""):
            lines.append("")
            lines.append(verdict.next_step)

    if getattr(submission, "ready", False):
        lines.append("")
        lines.append(
            "Run `cogworks run --benchmark {}` to score it on your machine.".format(benchmark)
        )

    return lines
