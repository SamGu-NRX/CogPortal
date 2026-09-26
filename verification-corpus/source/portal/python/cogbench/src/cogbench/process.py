"""The process layer: four signals computed from commits and runs, not scores.

See `docs/design/the-instrument-not-the-judge.md`, "The process layer", for
why these four exist. The short version: the owner named the real failure as
students "struggled with understanding beyond the individual level, since
some people do a lot of the work," and a leaderboard cannot see that. These
functions can, without turning into a second leaderboard.

Two rules hold everywhere in this module and are enforced by tests, not just
convention:

- No per-person totals, ever, in any form. `ownership_breadth` reports which
  distinct people touched a stage, never how many commits or how many lines
  came from any one of them. `stage_footprint` reports a stage-wide count of
  distinct authors, which is a bus-factor number, not a leaderboard for that
  stage's most active contributor.
- Never interpolate. A signal this module cannot compute returns `None`, an
  empty collection, or an explicit `unavailable_reason`, never a zero or a
  guess standing in for missing data.

This module takes data in and returns findings; it never calls the GitHub
API or a portal endpoint itself; see `docs/design/the-instrument-not-the-judge.md`
for why that split matters (it is also what keeps this module testable with
plain fixtures).
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# Input shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Commit:
    """One commit, shaped exactly like the GitHub commits API plus per-commit
    `files`. `insertions`/`deletions` are accepted because the API hands them
    over for free, but no function in this module reads them: the design doc
    is explicit that this instrument is indifferent to line counts, so a
    committed binary and a 400-line deletion both read correctly.
    """

    sha: str
    author_login: str
    authored_at: str
    files_changed: List[str]
    insertions: int
    deletions: int


@dataclass(frozen=True)
class Run:
    """One portal run record. Runs are the portal's own observation, not
    supplementary evidence with gaps the way commits are, so `first_light`
    below never checks history quality the way the commit-derived signals do.
    """

    run_id: str
    created_at: str
    status: str
    scored: bool


# ---------------------------------------------------------------------------
# History quality
# ---------------------------------------------------------------------------

#: `classify_history_quality` returns one of these three strings. Kept as
#: plain strings rather than an enum to match how the rest of this package
#: represents small closed vocabularies (see `cogbench.models`).
HISTORY_USABLE = "usable"
HISTORY_BULK_UPLOAD = "bulk_upload"
HISTORY_EMPTY = "empty"

#: A single commit holding more than this share of all changed files across
#: the whole history is treated as a bulk upload rather than real
#: development history. 60% is the threshold given in the spec; it is not a
#: number tuned against real data, so tighten it if a bulk upload is ever
#: seen to hide below it.
_BULK_UPLOAD_FILE_SHARE = 0.6


def classify_history_quality(commits: List[Commit]) -> str:
    """Decide whether `commits` supports per-commit attribution at all.

    Two of five real capstone teams pushed their whole project as one
    commit. For those repositories, "which stage did this commit touch" is
    meaningless (every stage, at the same instant, by whoever ran `git push`
    last) and reporting it anyway would fabricate a history that never
    happened. This function is the single place that notices, so every
    commit-derived signal in this module can call it and refuse to compute
    rather than guess.
    """

    if not commits:
        return HISTORY_EMPTY
    if len(commits) == 1:
        return HISTORY_BULK_UPLOAD
    total_files = sum(len(commit.files_changed) for commit in commits)
    if total_files > 0:
        largest = max(len(commit.files_changed) for commit in commits)
        if largest / total_files > _BULK_UPLOAD_FILE_SHARE:
            return HISTORY_BULK_UPLOAD
    return HISTORY_USABLE


def _unavailable_reason(commits: List[Commit], quality: str) -> Optional[str]:
    """The human-readable reason paired with a non-usable `quality`.

    Kept separate from `classify_history_quality` so that function can stay
    a pure classifier matching its name, while callers that need to explain
    "unavailable" to a reader still get a real sentence rather than a bare
    enum value.
    """

    if quality == HISTORY_EMPTY:
        return "this repository has no recorded commits"
    if quality == HISTORY_BULK_UPLOAD:
        if len(commits) == 1:
            return "the entire history is a single commit"
        return "one commit holds more than 60% of all changed files, so per-commit attribution would be noise"
    return None


# ---------------------------------------------------------------------------
# Path matching shared by stage_footprint, ownership_breadth, and boundary_churn
# ---------------------------------------------------------------------------


def _matches_any(path: str, patterns: List[str]) -> bool:
    """Case-insensitive match of `path` against `patterns`.

    A pattern containing a glob character (`*`, `?`, `[`) is matched with
    `fnmatch` against both the full path and the basename, so a caller can
    write either `find_peaks.py` or `**/find_peaks.py` and get the same
    result. Anything else is a plain substring test, which is the common
    case: stage maps below are mostly bare words like `"whisper"` meant to
    match `whispers.py`, `test_whispers.py`, and `core/whispers.py` alike.
    """

    lowered = path.lower()
    basename = lowered.rsplit("/", 1)[-1]
    for raw in patterns:
        pattern = raw.lower()
        if any(character in pattern for character in "*?["):
            if fnmatch.fnmatch(lowered, pattern) or fnmatch.fnmatch(basename, pattern):
                return True
        elif pattern in lowered:
            return True
    return False


def _parse_iso8601(value: str) -> datetime:
    """Parse a GitHub-style timestamp (`...Z` suffix) on Python 3.8.

    `datetime.fromisoformat` does not accept a trailing `Z` until Python
    3.11; students and CI both run 3.8, so this module cannot rely on that.
    Swapping `Z` for `+00:00` is the standard workaround and is exact for
    every timestamp this module receives, since GitHub always reports UTC.
    """

    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


# ---------------------------------------------------------------------------
# Signal 1: stage footprint
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StageActivity:
    """What was observed for one capstone stage.

    `commit_count` and `distinct_author_count` are `None`, not `0`, when
    `available` is `False`: a `0` would read as "we looked and nothing
    happened," which is a different, stronger claim than "we could not look."
    When `available` is `True`, `0` is a real finding (the stage really has
    no commits yet) and is reported as such.
    """

    commit_count: Optional[int]
    distinct_author_count: Optional[int]
    first_touch_at: Optional[str]
    last_touch_at: Optional[str]
    available: bool
    unavailable_reason: Optional[str] = None


def stage_footprint(commits: List[Commit], stage_map: Dict[str, List[str]]) -> Dict[str, StageActivity]:
    """Attribute commits to capstone stages by the files they touch.

    A commit that touches files in several stages is counted for each one;
    there is no single-winner rule, because an integration commit that wires
    the database to the query stage genuinely belongs to both, and forcing a
    single label would hide exactly the cross-stage work this signal exists
    to surface.
    """

    quality = classify_history_quality(commits)
    if quality != HISTORY_USABLE:
        reason = _unavailable_reason(commits, quality)
        return {
            stage: StageActivity(
                commit_count=None,
                distinct_author_count=None,
                first_touch_at=None,
                last_touch_at=None,
                available=False,
                unavailable_reason=reason,
            )
            for stage in stage_map
        }

    result: Dict[str, StageActivity] = {}
    for stage, patterns in stage_map.items():
        commit_count = 0
        authors = set()
        first_touch_dt: Optional[datetime] = None
        first_touch_at: Optional[str] = None
        last_touch_dt: Optional[datetime] = None
        last_touch_at: Optional[str] = None
        for commit in commits:
            if not any(_matches_any(path, patterns) for path in commit.files_changed):
                continue
            commit_count += 1
            authors.add(commit.author_login)
            touched_at = _parse_iso8601(commit.authored_at)
            if first_touch_dt is None or touched_at < first_touch_dt:
                first_touch_dt, first_touch_at = touched_at, commit.authored_at
            if last_touch_dt is None or touched_at > last_touch_dt:
                last_touch_dt, last_touch_at = touched_at, commit.authored_at
        result[stage] = StageActivity(
            commit_count=commit_count,
            distinct_author_count=len(authors),
            first_touch_at=first_touch_at,
            last_touch_at=last_touch_at,
            available=True,
        )
    return result


# ---------------------------------------------------------------------------
# Signal 2: first light
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FirstLight:
    """The integration instrument.

    `first_scored_at` is `None` when the team has never had a run make it
    all the way through scoring; that is the state the instructor called out
    as the single most useful thing to know about a team mid-week. It is run
    data, not commit data, so unlike the other three signals this one never
    checks `classify_history_quality`: a bulk-uploaded repository can still
    have run history, and that history is exactly as trustworthy as any
    other team's, because runs are the portal's own observation.
    """

    first_scored_at: Optional[str]
    scored_run_count: int


def first_light(runs: List[Run]) -> FirstLight:
    scored = [run for run in runs if run.scored]
    if not scored:
        return FirstLight(first_scored_at=None, scored_run_count=0)
    earliest = min(scored, key=lambda run: _parse_iso8601(run.created_at))
    return FirstLight(first_scored_at=earliest.created_at, scored_run_count=len(scored))


# ---------------------------------------------------------------------------
# Signal 3: boundary churn
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ChurnEvent:
    """A commit that touched a contract file after first light.

    `files` lists which of the boundary files were touched, not how many
    lines changed in them; a signature edit and a docstring edit both touch
    the file, and this signal is about the fact of the touch, not its size.
    """

    sha: str
    author_login: str
    authored_at: str
    files: List[str]


def boundary_churn(
    commits: List[Commit],
    boundary_files: List[str],
    first_light_at: Optional[str],
) -> List[ChurnEvent]:
    """Commits that touched a contract file after the team's first scored run.

    Before first light, a signature change is ordinary design work: the team
    has not agreed on an interface yet, because nothing has proven the
    pieces fit together. `first_light_at=None` means the team has no first
    light to measure churn against, so the honest answer is "nothing to
    report" (`[]`), not "everything counts."
    """

    if first_light_at is None:
        return []
    if classify_history_quality(commits) != HISTORY_USABLE:
        return []

    boundary_dt = _parse_iso8601(first_light_at)
    events: List[ChurnEvent] = []
    ordered = sorted(commits, key=lambda commit: _parse_iso8601(commit.authored_at))
    for commit in ordered:
        touched = sorted(path for path in commit.files_changed if _matches_any(path, boundary_files))
        if not touched:
            continue
        if _parse_iso8601(commit.authored_at) > boundary_dt:
            events.append(
                ChurnEvent(
                    sha=commit.sha,
                    author_login=commit.author_login,
                    authored_at=commit.authored_at,
                    files=touched,
                )
            )
    return events


# ---------------------------------------------------------------------------
# Signal 4: ownership breadth
# ---------------------------------------------------------------------------


def ownership_breadth(commits: List[Commit], stage_map: Dict[str, List[str]]) -> Dict[str, List[str]]:
    """Distinct author logins per stage: a bus-factor map, not a leaderboard.

    Deliberately a list of names with no counts attached anywhere, per
    stage. "Which stages has only one person ever touched" is the question
    this answers; "how much did each person do" is a question this module
    refuses to answer, in this function or any other (see the module
    docstring and `test_process.py::NoPerPersonTotals`).

    Returns `{}`, not per-stage empty lists, when the commit history is not
    usable: an empty dict is unambiguous evidence of "nothing was computed,"
    where a dict of empty lists could be misread as "computed, and no one
    touched any stage."
    """

    if classify_history_quality(commits) != HISTORY_USABLE:
        return {}

    result: Dict[str, List[str]] = {}
    for stage, patterns in stage_map.items():
        authors = {
            commit.author_login
            for commit in commits
            if any(_matches_any(path, patterns) for path in commit.files_changed)
        }
        result[stage] = sorted(authors)
    return result


# ---------------------------------------------------------------------------
# Finding sentences
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProcessSignals:
    """The four signals bundled together, for handing to `finding_sentences`."""

    history_quality: str
    stage_footprint: Dict[str, StageActivity]
    first_light: FirstLight
    boundary_churn: List[ChurnEvent]
    ownership_breadth: Dict[str, List[str]]


def _stem(path: str) -> str:
    """`src/audio/find_peaks.py` -> `find_peaks`, for naming a file in prose."""

    name = path.rsplit("/", 1)[-1]
    if "." in name:
        name = name.rsplit(".", 1)[0]
    return name


def _format_date(value: str) -> str:
    return _parse_iso8601(value).date().isoformat()


def finding_sentences(signals: ProcessSignals) -> List[str]:
    """Template-assembled sentences describing `signals`, in the course's register.

    Every sentence here is a fixed template selected by a condition on the
    data; nothing is generated. That is a hard requirement, not a style
    preference: a wrong generated claim about which teammate did what is
    socially expensive to a team of seventeen-year-olds in a way a wrong
    number is not (see `docs/design/the-instrument-not-the-judge.md`, "What
    this forbids"). Each sentence states one observation and stops; a stage
    with ordinary, spread-out activity gets no sentence at all, because an
    unremarkable stage is not a finding.
    """

    sentences: List[str] = []

    if signals.history_quality == HISTORY_BULK_UPLOAD:
        sentences.append(
            "The commit history is a single upload, so stage and ownership "
            "findings below aren't available; the runs are the portal's own "
            "observations and still count."
        )
    elif signals.history_quality == HISTORY_EMPTY:
        sentences.append(
            "There is no commit history yet, so stage and ownership findings aren't available."
        )

    if signals.first_light.first_scored_at is None:
        sentences.append(
            "No end-to-end run yet. Integration is the part the course says "
            "is hardest, and it usually takes longer than teams expect."
        )
    else:
        count = signals.first_light.scored_run_count
        sentences.append(
            "The first end-to-end run landed on {date}, with {count} scored run{plural} since.".format(
                date=_format_date(signals.first_light.first_scored_at),
                count=count,
                plural="" if count == 1 else "s",
            )
        )

    named_files = set()
    for event in signals.boundary_churn:
        for path in event.files:
            stem = _stem(path)
            if stem in named_files:
                continue
            named_files.add(stem)
            sentences.append("The {stem} signature changed after your pipeline first worked.".format(stem=stem))

    for stage in sorted(signals.ownership_breadth):
        authors = signals.ownership_breadth[stage]
        if len(authors) == 1:
            sentences.append("Only one person has touched the {stage} stage.".format(stage=stage))

    for stage in sorted(signals.stage_footprint):
        activity = signals.stage_footprint[stage]
        if activity.available and activity.commit_count == 0:
            sentences.append("No commits have touched the {stage} stage yet.".format(stage=stage))

    return sentences


# ---------------------------------------------------------------------------
# Default stage maps
# ---------------------------------------------------------------------------
#
# Patterns are bare word roots, matched as case-insensitive substrings by
# `_matches_any`, so `"peak"` matches `find_peaks.py`, `PeakFinding.ipynb`,
# and `test_peak_params.py` alike. Chosen against the course's own stage
# names in `docs/capstones/week{1,2,3}-*-capstone.md` and checked against
# file names actually used across real team repositories cached under
# `.cache/student-repos/` (13 repos spanning all three weeks): a spelling
# students actually reach for, like `Spectogram.py` or `find_matches.py`,
# is included even where it differs from the textbook term.

WEEK1_STAGE_MAP: Dict[str, List[str]] = {
    "spectrogram": ["spectrogram", "spectogram", "stft"],
    "peaks": ["peak", "local_max", "localmax", "find_peaks"],
    "fanout": ["fanout", "fan_out", "fingerprint"],
    "database": ["database", "song_metadata", "builddb", "build_database"],
    "query": ["quer", "match", "recogni", "retriev", "rerank", "identify"],
}

WEEK2_STAGE_MAP: Dict[str, List[str]] = {
    "descriptors": ["descriptor", "facenet"],
    "profiles": ["profile", "database", "vector_db", "builddb", "adddatabase"],
    "matching": ["match", "similarity", "threshold", "recogni", "distance", "cutoff"],
    "whispers": ["whisper", "cluster", "graph"],
}

WEEK3_STAGE_MAP: Dict[str, List[str]] = {
    "organizer": ["organiz", "coco", "idconversion"],
    "embedding": ["embed", "descriptor", "caption"],
    "training": ["train", "triplet", "margin_rank", "valid"],
    "search": ["search", "quer", "image_query", "text_to_image", "database"],
}

#: Convenience lookup from a week label to its default stage map. Week
#: labels match the directory names used elsewhere in this repository
#: (`benchmarks/week1`, `benchmarks/week2`, `benchmarks/week3`).
DEFAULT_STAGE_MAPS: Dict[str, Dict[str, List[str]]] = {
    "week1": WEEK1_STAGE_MAP,
    "week2": WEEK2_STAGE_MAP,
    "week3": WEEK3_STAGE_MAP,
}
