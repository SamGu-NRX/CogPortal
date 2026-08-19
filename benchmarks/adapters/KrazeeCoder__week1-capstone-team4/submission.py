"""Instructor-supplied adapter for KrazeeCoder/week1-capstone-team4.

The team wrote a complete fingerprinter; they never wrote a benchmark
adapter, because the benchmark did not exist when they submitted. This file
is the missing wiring and nothing else. Every number the benchmark reports
comes out of their spectrogram, their peak picker, their fanout hashing, and
their offset-aligned vote tally, called with their own default parameters.

Two things needed a decision, both recorded in ``PROVENANCE``:

Their entry point is ``final_checker.identify_clip(samples, sample_rate,
database)``. It takes the database as a third argument, so it cannot be
bound as a two-argument ``identify``; the adapter has to hold the database
and pass it. It also returns only the winner, while
``AudioDatabase.query`` already computes ``ranked``, every song with at
least one hash hit, best first. Their own docstring says ``ranked`` exists
"for retrieval-vs-ranking evaluation (recall@k for any k)", so the adapter
reads that instead of the top-3 display percentages. Rank 1 is the same
either way: ``identify_clip`` takes the argmax of ``best_matches``, which is
``ranked[:3]`` rescaled, and rescaling by a positive constant does not move
the argmax.

The result is returned as ``(song_id, artist, score)`` triples, which is the
shape their ``identify_clip`` already returns, with the raw offset-aligned
vote count as the score rather than the normalized percentage their demo
prints.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

#: What this adapter added, and what it did not. The driver copies this into
#: the run result so the leaderboard can say which parts of a score belong to
#: the team. Nothing in ``we_supplied`` is signal processing or matching.
PROVENANCE = {
    "source": "instructor-supplied",
    "repo": "KrazeeCoder/week1-capstone-team4",
    "student_wrote": [
        "create_spectogram.create_spectrogram: mlab.specgram, NFFT=4096, 50% overlap, log-clipped",
        "find_peaks.find_peaks: numba local-maximum search, 20-iteration diamond neighborhood, "
        "60th-percentile amplitude floor",
        "create_fingerprints.peaks_to_fingerprints: fanout=15 anchor pairing, (f//4, f//4, dt//2) "
        "quantization",
        "database.AudioDatabase.store_fingerprints: the hash -> [(song_id, anchor_time)] index",
        "database.AudioDatabase.query: offset bucketing (offset // 4), per-song best-bucket vote "
        "count, and the 'ranked' list this adapter reads",
        "song_metadata: the integer song ids and the title/artist records",
        "every parameter above; the adapter passes no keyword arguments and overrides no default",
    ],
    "we_supplied": [
        "the enroll/identify method names and their signatures",
        "holding one AudioDatabase instance across calls, because identify_clip takes the "
        "database as a third argument and the contract's identify takes two",
        "calling their four modules in the order final_checker.identify_clip calls them "
        "(spectrogram -> peaks -> fingerprints -> query)",
        "reading query()['ranked'] rather than query()['best_matches'], so the full ranked list "
        "reaches the scorer instead of only the winner",
        "mapping their integer song ids back to the benchmark's string song ids through "
        "AudioDatabase.metadata",
        "a guard that refuses a second enroll of the same song, because store_fingerprints "
        "appends unconditionally and re-enrolling doubles that song's votes (measured: 118 -> 236)",
        "locating the repository on sys.path",
    ],
    "not_used": [
        "load_audio (the benchmark hands over arrays, so no file or microphone is read)",
        "save_data / load_data (the shipped data.pkl is never opened; the database is built "
        "fresh from the benchmark catalog every run)",
        "topological_rerank, evaluate_*, streamlit_demo, main (their demo and analysis surface)",
    ],
}

#: Modules that must sit next to the repository root for the import chain to
#: work. Used to tell "wrong directory" apart from "broken repository".
_REQUIRED_MODULES = (
    "create_spectogram",
    "find_peaks",
    "create_fingerprints",
    "database",
    "song_metadata",
)

#: Written into every metadata record. Their query path never reads it; it
#: rides along so ``inspect_database`` and the triple return shape stay
#: meaningful.
_ARTIST = "CogWorks Week 1 corpus"


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
                "checkout of KrazeeCoder/week1-capstone-team4.".format(
                    root, ", ".join(name + ".py" for name in missing)
                )
            )
        return root

    here = Path(__file__).resolve().parent
    missing = [name for name in _REQUIRED_MODULES if not (here / (name + ".py")).is_file()]
    if missing:
        raise RuntimeError(
            "This adapter needs KrazeeCoder/week1-capstone-team4 beside it, and {} has no {}. "
            "Copy submission.py to the root of a checkout, or set COGWORKS_STUDENT_REPO to "
            "one.".format(here, ", ".join(name + ".py" for name in missing))
        )
    return here


class KrazeeCoderTeam4Submission:
    """Their pipeline behind ``enroll`` and ``identify``."""

    def __init__(self, resources: Any = None) -> None:
        # Imports are deferred to construction rather than done at module
        # scope: numba, scipy and matplotlib together cost seconds, and the
        # loader imports this file before it decides to run anything.
        root = _repository_root()
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))

        from create_spectogram import create_spectrogram
        from create_fingerprints import peaks_to_fingerprints
        from database import AudioDatabase
        from find_peaks import find_peaks

        self._create_spectrogram = create_spectrogram
        self._find_peaks = find_peaks
        self._peaks_to_fingerprints = peaks_to_fingerprints

        # Their default db_filepath is "data.pkl" and their repository ships
        # one, but nothing opens it unless load_data is called, and this
        # adapter never calls it. The database starts empty every run.
        self._database = AudioDatabase()
        self._ids: Dict[str, int] = {}

    # -- their pipeline, in their order ---------------------------------
    def _fingerprints(self, samples: Any, sample_rate: int) -> List[Any]:
        spectrogram, _freqs, _times = self._create_spectrogram(samples, sample_rate)
        peaks = self._find_peaks(spectrogram)
        return self._peaks_to_fingerprints(peaks)

    # -- the contract ----------------------------------------------------
    def enroll(self, song_id: str, samples: Any, sample_rate: int) -> None:
        if song_id in self._ids:
            # store_fingerprints appends without checking, so a second
            # enrollment leaves the key count unchanged and doubles this
            # song's votes. Failing loudly marks one song; scoring it would
            # quietly advantage whichever song we sent twice.
            raise RuntimeError(
                "song {} was already enrolled; enrolling it again would double its votes "
                "without changing the database keys.".format(song_id)
            )
        internal_id = self._database.add_song(song_id, _ARTIST, song_id)
        self._ids[song_id] = internal_id
        self._database.store_fingerprints(internal_id, self._fingerprints(samples, sample_rate))

    def identify(self, samples: Any, sample_rate: int) -> List[Tuple[str, str, float]]:
        result = self._database.query(self._fingerprints(samples, sample_rate))
        candidates = []
        for internal_id, votes in result.get("ranked", []):
            info = self._database.metadata.get(internal_id)
            if info is None:
                continue
            candidates.append((info["title"], info["artist"], float(votes)))
        return candidates

    # -- optional, diagnostics only --------------------------------------
    def fingerprint(self, samples: Any, sample_rate: int) -> List[Any]:
        return self._fingerprints(samples, sample_rate)


def create_submission(resources: Any = None) -> KrazeeCoderTeam4Submission:
    return KrazeeCoderTeam4Submission(resources)
