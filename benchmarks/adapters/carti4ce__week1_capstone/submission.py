"""Instructor-supplied adapter for carti4ce/week1_capstone.

The team wrote the whole pipeline: spectrogram, peak picking, fanout
hashing, the pickle-backed hash index, and the offset-aligned vote tally.
They never wrote a benchmark adapter, because the benchmark did not exist
when they submitted. This file is the missing wiring.

Three things here are worth reading before trusting a number this produces,
all of them recorded in ``PROVENANCE``:

``match.py`` does not import on Python 3.8. Its two functions are annotated
``list[tuple[tuple[int, int, int], int]]``, which is PEP 585 syntax that
3.9 introduced; on 3.8 the annotation is evaluated at definition time and
raises ``TypeError: 'type' object is not subscriptable``. The adapter first
imports it normally, and only if that exact failure occurs re-executes the
same source with the ``annotations`` future flag set, which is what a
``from __future__ import annotations`` line at the top of their file would
do. No source text is edited and no logic changes; annotations simply are
not evaluated. When the fallback fires it is recorded in
``compatibility_notes`` on the adapter and must be surfaced with the score,
because "this scored on 3.8" and "this scored on 3.8 under a compatibility
flag" are different claims.

``match.query`` returns only a song name, so the adapter calls
``query_details``, which returns ``(name, count, counts)`` where ``counts``
is their full ``Counter`` over ``(song_id, offset)``. The ranked list is
folded out of that Counter by taking each song's best offset bucket. Rank 1
is unchanged by this: their ``max(counts, key=counts.get)`` picks the song
owning the single largest ``(song, offset)`` cell, which is also the first
element of the folded ranking. Everything below rank 1 is diagnostic only
and never enters ``identification_score``.

``database.DB_PATH`` is the module-global relative string ``"db.pkl"``,
rewritten on every add and reloaded on every query. The benchmark driver
has already made a private scratch directory the working directory before
the factory runs, so that file lands in this run's own directory. The
adapter does not override the path; it relies on the working directory the
driver established, which is what their code has always assumed.
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

#: What this adapter added, and what it did not. The driver copies this into
#: the run result so the leaderboard can say which parts of a score belong to
#: the team. Nothing in ``we_supplied`` is signal processing or matching.
PROVENANCE = {
    "source": "instructor-supplied",
    "repo": "carti4ce/week1_capstone",
    "student_wrote": [
        "spectrogram.make_spectrogram: mlab.specgram, NFFT=4096, noverlap=2048, log-clipped",
        "fingerprint.find_peaks: maximum_filter local maxima, neighborhood_size=20, "
        "75th-percentile amplitude floor",
        "fingerprint.make_fgp: fanout=15 forward pairing, ((f1, f2, dt), t1) keys, no quantization",
        "database.add / database.load / database.export: the pickle-backed "
        "hash -> [(song_id, anchor_time)] index and its per-song rewrite",
        "match.query_details: offset tallying (time_clip - time_song, unbucketed) and the "
        "(song, offset) Counter this adapter ranks from",
        "every parameter above; the adapter passes no keyword arguments and overrides no default",
    ],
    "we_supplied": [
        "the enroll/identify method names and their signatures",
        "calling their four modules in the order database_creation.py calls them "
        "(spectrogram -> find_peaks -> make_fgp -> database.add)",
        "calling database.reset() once at construction so a run starts on an empty index",
        "using their song id as its own song name in database.add, so query_details returns the "
        "benchmark's id directly and no name table has to be inverted",
        "folding their (song_id, offset) Counter into a ranked list by each song's best offset "
        "bucket; rank 1 is identical to their own max(counts, key=counts.get), and ranks below 1 "
        "are diagnostic only and do not enter identification_score",
        "a guard that refuses a second enroll of the same song, because database.add appends "
        "unconditionally and re-enrolling doubles that song's votes",
        "a Python 3.8 import fallback for match.py, described in compatibility_notes and below",
        "locating the repository on sys.path",
    ],
    "not_used": [
        "song_input (librosa/microphone file loading; the benchmark hands over arrays)",
        "database_creation (walks a song_data folder at import time and calls database.reset)",
        "slicing, GUI, tests_manual (their evaluation and demo surface)",
        "match.query (returns a bare name; query_details returns the same winner plus the counts)",
    ],
    "known_issues": [
        "match.py uses PEP 585 annotations (list[...]) and raises TypeError on Python 3.8; "
        "see compatibility_notes on the adapter instance for whether the fallback fired",
        "database.add reloads and rewrites the entire pickle per song, so enrollment is O(N^2), "
        "and query_details reloads it on every query",
    ],
}

_REQUIRED_MODULES = ("spectrogram", "fingerprint", "database", "match")


def _repository_root() -> Path:
    """Where the student's modules live.

    The normal deployment copies this file to the root of a checkout, so the
    directory holding it is the repository. ``COGWORKS_STUDENT_REPO`` is the
    override for running the adapter in place, out of the adapters
    directory, without touching the student's tree.
    """

    override = os.environ.get("COGWORKS_STUDENT_REPO")
    if override:
        root = Path(override).expanduser().resolve()
        missing = [name for name in _REQUIRED_MODULES if not (root / (name + ".py")).is_file()]
        if missing:
            raise RuntimeError(
                "COGWORKS_STUDENT_REPO points at {}, which is missing {}. That is not a "
                "checkout of carti4ce/week1_capstone.".format(
                    root, ", ".join(name + ".py" for name in missing)
                )
            )
        return root

    here = Path(__file__).resolve().parent
    missing = [name for name in _REQUIRED_MODULES if not (here / (name + ".py")).is_file()]
    if missing:
        raise RuntimeError(
            "This adapter needs carti4ce/week1_capstone beside it, and {} has no {}. Copy "
            "submission.py to the root of a checkout, or set COGWORKS_STUDENT_REPO to one.".format(
                here, ", ".join(name + ".py" for name in missing)
            )
        )
    return here


def _is_pep585_failure(error: BaseException) -> bool:
    """Whether this is the 3.8 ``list[...]`` annotation failure and nothing else.

    Narrow on purpose. A broad ``except TypeError`` around a module import
    would let a genuine bug in their code be retried under a flag that
    cannot fix it, and the second traceback would be the one the student
    sees.
    """

    return isinstance(error, TypeError) and "not subscriptable" in str(error)


def _import_match(root: Path) -> Tuple[Any, List[str]]:
    """``match``, plus any note about how it had to be imported.

    Tried normally first, so on 3.9 and later this is an ordinary import and
    the note list is empty. The fallback re-executes the same file with
    ``__future__.annotations`` enabled, which stops annotations being
    evaluated at definition time; it is the documented compiler flag, not a
    source edit, and their runtime behaviour is unchanged.
    """

    try:
        return importlib.import_module("match"), []
    except TypeError as error:
        if not _is_pep585_failure(error):
            raise
    sys.modules.pop("match", None)

    import __future__ as future_features

    path = root / "match.py"
    source = path.read_text(encoding="utf-8")
    code = compile(
        source,
        str(path),
        "exec",
        flags=future_features.annotations.compiler_flag,
        dont_inherit=True,
    )
    spec = importlib.util.spec_from_file_location("match", str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules["match"] = module
    exec(code, module.__dict__)  # noqa: S102 - their file, their code, one flag changed
    note = (
        "match.py annotates its parameters with PEP 585 generics (list[...]), which Python "
        "{}.{} evaluates at definition time and rejects. It was imported with the "
        "__future__.annotations compiler flag so annotations are not evaluated; no source was "
        "changed. On Python 3.9 or later this repository imports normally.".format(
            sys.version_info[0], sys.version_info[1]
        )
    )
    return module, [note]


class Carti4ceWeek1Submission:
    """Their pipeline behind ``enroll`` and ``identify``."""

    def __init__(self, resources: Any = None) -> None:
        # Imports are deferred to construction rather than done at module
        # scope: scipy and matplotlib cost seconds, and the loader imports
        # this file before it decides to run anything.
        root = _repository_root()
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
        self._root = root

        import database
        from fingerprint import find_peaks, make_fgp
        from spectrogram import make_spectrogram

        match_module, notes = _import_match(root)

        self._database = database
        self._match = match_module
        self._make_spectrogram = make_spectrogram
        self._find_peaks = find_peaks
        self._make_fgp = make_fgp

        #: Anything the platform had to do to get this repository running.
        #: Empty when it imported normally. Reported with the score.
        self.compatibility_notes: List[str] = notes

        # db.pkl and songs.pkl are module-global relative paths in their
        # database.py. The driver has already made a private scratch
        # directory the working directory, so these land here; reset makes
        # the starting state explicit rather than inherited.
        self._database.reset()
        self._enrolled: Dict[str, bool] = {}

    # -- their pipeline, in their order ---------------------------------
    def _fingerprints(self, samples: Any, sample_rate: int) -> List[Any]:
        log_spec, _freqs, _times = self._make_spectrogram(samples, sample_rate)
        return self._make_fgp(self._find_peaks(log_spec))

    # -- the contract ----------------------------------------------------
    def enroll(self, song_id: str, samples: Any, sample_rate: int) -> None:
        if song_id in self._enrolled:
            # database.add appends without checking, so a second enrollment
            # leaves the key set unchanged and doubles this song's votes.
            raise RuntimeError(
                "song {} was already enrolled; enrolling it again would double its votes "
                "without changing the database keys.".format(song_id)
            )
        # song_ID and song_name are both the benchmark id, so query_details
        # hands back the id and nothing has to be inverted.
        self._database.add(self._fingerprints(samples, sample_rate), song_id, song_id)
        self._enrolled[song_id] = True

    def identify(self, samples: Any, sample_rate: int) -> List[Tuple[str, float]]:
        _name, _count, counts = self._match.query_details(
            self._fingerprints(samples, sample_rate)
        )
        if not counts:
            return []
        best_per_song: Dict[str, int] = {}
        for (song_id, _offset), votes in counts.items():
            if votes > best_per_song.get(song_id, 0):
                best_per_song[song_id] = votes
        ranked = sorted(best_per_song.items(), key=lambda item: item[1], reverse=True)
        return [(str(song_id), float(votes)) for song_id, votes in ranked]

    # -- optional, diagnostics only --------------------------------------
    def fingerprint(self, samples: Any, sample_rate: int) -> List[Any]:
        return self._fingerprints(samples, sample_rate)


def create_submission(resources: Any = None) -> Carti4ceWeek1Submission:
    return Carti4ceWeek1Submission(resources)
