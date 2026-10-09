"""Study variants for the instrument-validity study.

Everything here speaks the benchmark's own submission contract and reuses the
reference pipeline's helpers, so any two variants differ in exactly the field
or policy named. The two new pipelines (`NfftFingerprinter`, `ChromaFinger
printer`) are honest alternative pipelines in the same family, not scorer
changes; the policy wrappers exist to measure what the instrument does with
guessing, abstention, and metadata recovery.

Staff-only, like the rest of this directory.
"""

from __future__ import annotations

import os
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import numpy as np
from matplotlib import mlab

from reference_shazam.pipeline import (
    BAG_OF_HASHES,
    DETUNED,
    SAMPLE_RATE_BUG,
    TUNED,
    Fingerprinter,
    Params,
    fanout_hashes,
    find_peaks,
    resample_to,
)
from reference_shazam.trivial import TrivialBaseline

# --------------------------------------------------------------------------
# NFFT-variant: the tuned pipeline with a coarser spectrogram
# --------------------------------------------------------------------------


class NfftFingerprinter(Fingerprinter):
    """The tuned pipeline with NFFT/NNOVERLAP as instance knobs.

    Same peak-picker, same fanout, same offset-histogram vote; only the
    spectrogram geometry changes, which is what a bin-crossing pitch shift
    cares about. Reimplemented enroll/identify rather than parameterizing the
    module, because the reference keeps NFFT as a module constant and the
    study must not edit reference files.
    """

    def __init__(
        self,
        params: Params = TUNED,
        nfft: int = 1024,
        noverlap: int = 512,
        top_k: int = 10,
    ) -> None:
        super().__init__(params, top_k=top_k)
        self.nfft = int(nfft)
        self.noverlap = int(noverlap)

    def _spec(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        signal = np.asarray(samples, dtype=np.float64).ravel()
        if signal.shape[0] < self.nfft:
            signal = np.concatenate([signal, np.zeros(self.nfft - signal.shape[0])])
        power, _f, _t = mlab.specgram(
            signal,
            NFFT=self.nfft,
            Fs=float(sample_rate),
            window=mlab.window_hanning,
            noverlap=self.noverlap,
            mode="magnitude",
        )
        return np.log(np.clip(np.asarray(power, dtype=np.float64), 1e-20, None))

    def _clip_hashes(self, samples: np.ndarray, sample_rate: int):
        peaks = find_peaks(self._spec(samples, sample_rate), self.params)
        return fanout_hashes(peaks, self.params.fanout), int(peaks.shape[0])

    def enroll(self, song_id: str, samples: np.ndarray, sample_rate: int) -> None:
        rate = sample_rate
        signal = samples
        if self.params.enroll_rate is not None:
            rate = int(self.params.enroll_rate)
            signal = resample_to(samples, sample_rate, rate)
        pairs, peak_count = self._clip_hashes(signal, rate)
        for key, time in pairs:
            self._database[key].append((song_id, time))
        self._enrolled.append(song_id)
        self.peaks_per_song[song_id] = peak_count
        self.hashes_per_song[song_id] = len(pairs)

    def identify(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[str, float]]:
        pairs, _peak_count = self._clip_hashes(samples, sample_rate)
        if not pairs:
            return []
        if self.params.offset_vote:
            aligned: Dict[Tuple[str, int], int] = defaultdict(int)
            for key, time in pairs:
                for song_id, stored in self._database.get(key, ()):
                    aligned[(song_id, stored - time)] += 1
            best: Dict[str, int] = {}
            for (song_id, _offset), votes in aligned.items():
                if votes > best.get(song_id, 0):
                    best[song_id] = votes
        else:
            best = defaultdict(int)
            for key, _time in pairs:
                for song_id, _stored in self._database.get(key, ()):
                    best[song_id] += 1
        ranked = sorted(best.items(), key=lambda item: (-item[1], item[0]))
        return [(song_id, float(votes)) for song_id, votes in ranked[: self.top_k]]


# --------------------------------------------------------------------------
# Chroma pipeline: pitch-class fingerprints with a transposition search
# --------------------------------------------------------------------------

_CHROMA_FMIN = 55.0  # A1
_CHROMA_FMAX = 8000.0
#: Frame energy drop below the frame's loudest class for a class to count,
#: capped at `_CHROMA_MAX_CLASSES` classes per frame (loudest first). Without
#: the cap a 10 dB window admits most of the 12 classes on dense frames and
#: the pair-key space makes the offset vote unusably slow; with it the key
#: space stays at a few hundred distinct pairs and specificity is what is
#: measured.
_CHROMA_DROP_DB = 10.0
_CHROMA_MAX_CLASSES = 3
#: Transposition search span, semitones. Covers the shipped grid's ±1/±2.
_CHROMA_SHIFTS = (-2, -1, 0, 1, 2)
#: Frame lags paired into keys, in frames (NFFT=4096 geometry, ~46 ms hop).
_CHROMA_LAGS = (1, 2, 3, 4)


def chroma_matrix(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """``(frames, 12)`` log-chroma: magnitude folded onto pitch classes.

    Integer-MIDI synthetic tones land on class centers exactly; real music
    does not, which is part of what the study measures.
    """

    signal = np.asarray(samples, dtype=np.float64).ravel()
    nfft = 4096
    if signal.shape[0] < nfft:
        signal = np.concatenate([signal, np.zeros(nfft - signal.shape[0])])
    power, _f, _t = mlab.specgram(
        signal,
        NFFT=nfft,
        Fs=float(sample_rate),
        window=mlab.window_hanning,
        noverlap=2048,
        mode="magnitude",
    )
    freqs = np.fft.rfftfreq(nfft, d=1.0 / float(sample_rate))
    band = (freqs >= _CHROMA_FMIN) & (freqs < _CHROMA_FMAX)
    magnitude = np.asarray(power, dtype=np.float64)[band, :]
    freqs_band = freqs[band]
    # Bin centers to the nearest pitch class; bins between classes (real
    # music, vibrato, stretch tuning) round somewhere and lose energy.
    pcs = np.mod(np.rint(12.0 * np.log2(freqs_band / 440.0)).astype(np.int64), 12)
    chroma = np.zeros((magnitude.shape[1], 12), dtype=np.float64)
    for pc in range(12):
        bins_of_class = np.flatnonzero(pcs == pc)
        if bins_of_class.size:
            # Sum over the class's bins (axis 0), one energy value per frame.
            chroma[:, pc] = magnitude[bins_of_class, :].sum(axis=0)
    return np.log10(np.clip(chroma, 1e-12, None) + 1e-12)


def _frame_classes(matrix: np.ndarray) -> List[List[int]]:
    """Per frame, the loudest pitch classes within `_CHROMA_DROP_DB`, capped
    at `_CHROMA_MAX_CLASSES`."""

    out: List[List[int]] = []
    if matrix.shape[0] == 0:
        return out
    floor = matrix.max(axis=1, keepdims=True) - _CHROMA_DROP_DB
    for index in range(matrix.shape[0]):
        row = matrix[index]
        loud = np.flatnonzero(row >= floor[index, 0])
        if loud.size == 0:
            classes = [int(np.argmax(row))]
        else:
            loud = loud[np.argsort(-row[loud])][: _CHROMA_MAX_CLASSES]
            classes = [int(pc) for pc in loud]
        out.append(classes)
    return out


class ChromaFingerprinter:
    """Pitch-class pair hashes with a ±2-semitone transposition search.

    The one representation in the study that is exactly invariant to the
    integer-semitone shifts the shipped grid tests: a resample-based shift
    adds n to every pitch class and rescales the frame clock by 2^(n/12),
    and the vote undoes both. Specificity is the empirical question — this
    representation throws away octave and timbre, so whether it can still
    tell thirty songs apart (synthetic or real) is a measurement, not an
    assumption.
    """

    def __init__(self, top_k: int = 10) -> None:
        self.top_k = int(top_k)
        self._database: Dict[Tuple[int, int, int], List[Tuple[str, int]]] = defaultdict(list)
        self._enrolled: List[str] = []

    def _hashes(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[Tuple[int, int, int], int]]:
        classes = _frame_classes(chroma_matrix(samples, sample_rate))
        out: List[Tuple[Tuple[int, int, int], int]] = []
        for index, classes_here in enumerate(classes):
            for lag in _CHROMA_LAGS:
                other = index + lag
                if other >= len(classes):
                    continue
                for pc1 in classes_here:
                    for pc2 in classes[other]:
                        out.append(((int(pc1), int(pc2), lag), index))
        return out

    def enroll(self, song_id: str, samples: np.ndarray, sample_rate: int) -> None:
        for key, time in self._hashes(samples, sample_rate):
            self._database[key].append((song_id, time))
        self._enrolled.append(song_id)

    def identify(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[str, float]]:
        query = self._hashes(samples, sample_rate)
        if not query:
            return []
        best: Dict[str, int] = {}
        for shift in _CHROMA_SHIFTS:
            # A query shifted up by `shift` semitones has every class +shift
            # and its frame clock compressed by 2^(shift/12); undo both
            # before looking the key up in the unshifted database.
            rate_factor = float(2.0 ** (shift / 12.0))
            aligned: Dict[Tuple[str, int], int] = defaultdict(int)
            for (pc1, pc2, lag), time in query:
                key = ((pc1 - shift) % 12, (pc2 - shift) % 12, int(round(lag * rate_factor)))
                for song_id, stored in self._database.get(key, ()):
                    aligned[(song_id, stored - time)] += 1
            for (song_id, _offset), votes in aligned.items():
                if votes > best.get(song_id, 0):
                    best[song_id] = votes
        ranked = sorted(best.items(), key=lambda item: (-item[1], item[0]))
        return [(song_id, float(votes)) for song_id, votes in ranked[: self.top_k]]

    def finalize_database(self) -> None:
        return None


# --------------------------------------------------------------------------
# Policy wrappers: guess, abstain, inert, and the metadata demonstration
# --------------------------------------------------------------------------


class InertSubmission:
    """Ignores the audio entirely and answers with the first enrolled id."""

    def __init__(self, resources: object = None, top_k: int = 10) -> None:
        self.top_k = int(top_k)
        self._first: Optional[str] = None

    def enroll(self, song_id: str, samples: np.ndarray, sample_rate: int) -> None:
        if self._first is None:
            self._first = song_id

    def identify(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[str, float]]:
        if self._first is None:
            return []
        return [(self._first, 1.0)]


class GuessUniform:
    """One uniformly random enrolled id per query, seeded for reproducibility."""

    def __init__(self, resources: object = None, top_k: int = 10, seed: int = 20261009) -> None:
        self.top_k = int(top_k)
        self._ids: List[str] = []
        self._seed = int(seed)
        self._calls = 0

    def enroll(self, song_id: str, samples: np.ndarray, sample_rate: int) -> None:
        self._ids.append(song_id)

    def identify(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[str, float]]:
        if not self._ids:
            return []
        rng = np.random.default_rng(self._seed + self._calls)
        self._calls += 1
        picks = rng.permutation(len(self._ids))[: self.top_k]
        return [(self._ids[int(index)], 1.0) for index in picks]


class AbstainAll:
    """Returns `[]` for every query: the always-abstain policy."""

    def __init__(self, resources: object = None, top_k: int = 10) -> None:
        self.top_k = int(top_k)

    def enroll(self, song_id: str, samples: np.ndarray, sample_rate: int) -> None:
        return None

    def identify(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[str, float]]:
        return []


class AbstainMargin:
    """The tuned pipeline, abstaining when its own top1/top2 margin is < tau.

    Threshold tau is chosen on tuning manifests (never measurement data) and
    injected here as a frozen constant by the runner.
    """

    def __init__(self, threshold: float, resources: object = None, top_k: int = 10) -> None:
        self.threshold = float(threshold)
        self._inner = Fingerprinter(TUNED, top_k=max(int(top_k), 10))
        self.abstained = 0
        self.answered = 0

    def enroll(self, song_id: str, samples: np.ndarray, sample_rate: int) -> None:
        self._inner.enroll(song_id, samples, sample_rate)

    def identify(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[str, float]]:
        ranked = self._inner.identify(samples, sample_rate)
        if not ranked:
            return []
        if len(ranked) == 1:
            self.answered += 1
            return ranked
        top, second = ranked[0][1], ranked[1][1]
        margin = (top - second) / max(abs(top), 1e-12)
        if margin < self.threshold:
            self.abstained += 1
            return []
        self.answered += 1
        return ranked


class MetadataOracle:
    """Inert to audio; replays gold from the scorer's own shipped manifest.

    The demonstration behind the audit claim: the manifest that pins every
    query's `source_song_id` ships inside the scorer package, in the same
    process the submission runs in, and the case order the driver presents
    is deterministic. This submission reads none of the audio. Warm-up
    (the driver's one-second zeros identify) is skipped by detecting the
    silence, which is exactly what a determined submission would do.
    """

    def __init__(self, resources: object = None, top_k: int = 10) -> None:
        self.top_k = int(top_k)
        self._tier = os.environ.get("COGWORKS_W1_TIER", "evaluation")
        self._golds: List[Optional[str]] = []
        self._in_set: List[bool] = []
        self._loaded = False
        self._seen_queries = 0
        self._warmup_seen = False
        self._first: Optional[str] = None

    def enroll(self, song_id: str, samples: np.ndarray, sample_rate: int) -> None:
        if self._first is None:
            self._first = song_id

    def _load(self) -> None:
        # The submission and the scorer share one process and one sys.path;
        # this import is the finding, not an accident of the study harness.
        from audio_identification_benchmark.datasets import load_manifest

        manifest = load_manifest(self._tier)
        for row in manifest["queries"]:
            self._in_set.append(bool(row["in_set"]))
            self._golds.append(str(row["source_song_id"]) if row["in_set"] else None)
        self._loaded = True

    def identify(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[str, float]]:
        if not self._loaded:
            self._load()
        if not self._warmup_seen:
            # The driver's warm-up is a one-second all-zeros clip, exactly once,
            # before the first real query.
            self._warmup_seen = True
            if not np.any(np.asarray(samples)):
                return []
        index = self._seen_queries
        self._seen_queries += 1
        if index >= len(self._golds):
            return [(self._first, 1.0)] if self._first else []
        gold = self._golds[index]
        if self._in_set[index]:
            return [(gold, 1.0)]
        # Out of set: the manifest says so; a submission gets to know this
        # too. It still must name some catalog song to be "confident".
        return [(self._first, 1.0)] if self._first else []


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------

#: Frozen at tuning time; see PROTOCOL.md. Placeholder replaced by the
#: frozen value before any measurement run.
ABSTAIN_TAU = 0.10


def _top_k(resources: object) -> int:
    """Same widening rule as the reference registry: return at least the
    benchmark's top-k so ranking can be observed below rank 1."""

    return max(int(getattr(resources, "top_k", 5) or 5) * 2, 10)


def _make_fanout40(resources: object):
    return Fingerprinter(Params(percentile=75.0, neighborhood=15, fanout=40), top_k=_top_k(resources))


def _make_nbhd3(resources: object):
    return Fingerprinter(Params(percentile=75.0, neighborhood=3, fanout=15), top_k=_top_k(resources))


def _make_nbhd51(resources: object):
    return Fingerprinter(Params(percentile=75.0, neighborhood=51, fanout=15), top_k=_top_k(resources))


def _make_nfft1024(resources: object):
    return NfftFingerprinter(TUNED, nfft=1024, noverlap=512, top_k=_top_k(resources))


def _make_chroma12(resources: object):
    return ChromaFingerprinter(top_k=_top_k(resources))


def _make_inert(resources: object):
    return InertSubmission(resources, top_k=_top_k(resources))


def _make_guess_uniform(resources: object):
    return GuessUniform(resources, top_k=_top_k(resources))


def _make_abstain_all(resources: object):
    return AbstainAll(resources, top_k=_top_k(resources))


def _make_abstain_margin(resources: object):
    tau = float(os.environ.get("COGWORKS_W1_ABSTAIN_TAU", ABSTAIN_TAU))
    return AbstainMargin(tau, resources, top_k=_top_k(resources))


def _make_metadata_oracle(resources: object):
    return MetadataOracle(resources, top_k=_top_k(resources))


#: Same shape as `reference_shazam.variants.VARIANTS`: name -> factory(resources).
#: The runner passes the factory directly, which exercises the identical code
#: path the env-var dispatch reaches.
STUDY_VARIANTS: Dict[str, object] = {
    "fanout40": _make_fanout40,
    "nbhd3": _make_nbhd3,
    "nbhd51": _make_nbhd51,
    "nfft1024": _make_nfft1024,
    "chroma12": _make_chroma12,
    "inert": _make_inert,
    "guess_uniform": _make_guess_uniform,
    "abstain_all": _make_abstain_all,
    "abstain_margin": _make_abstain_margin,
    "metadata_oracle": _make_metadata_oracle,
}
