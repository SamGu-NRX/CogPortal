"""One fingerprint pipeline, parameterized, so the ablations differ in one knob.

Every variant in ``variants.py`` runs this same code. That is the whole point
of the file: if the detuned variant used its own peak-picker, a difference in
score would not tell you whether the threshold mattered or whether the two
implementations simply disagree. Here the only thing that changes between
TunedShazam and DetunedShazam is a ``Params`` field.

The stages are the ones the Week 1 capstone describes:

1. spectrogram, ``matplotlib.mlab.specgram`` at NFFT=4096 / noverlap=2048,
   which is the call CogWeb puts in front of students;
2. local peaks, a maximum filter over a square neighborhood plus an amplitude
   floor taken as a percentile of the clip's own log magnitudes;
3. fanout hashes ``(f1, f2, dt)`` paired with the absolute time of the anchor;
4. voting, either offset-aligned (correct) or a bare count (the ablation).

Times are spectrogram column indices, not seconds. That is deliberate and it
is also the failure ``SampleRateBugShazam`` exists to reproduce: a database
built from 16 kHz columns and queried from 44.1 kHz columns has the same key
type and a disjoint key space, so the answer is wrong and nothing raises.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
from matplotlib import mlab
from scipy.ndimage import maximum_filter
from scipy.signal import resample_poly

#: The course's recommended spectrogram geometry. Changing either of these
#: changes the meaning of a stored time (a column index) and of a stored dt.
NFFT = 4096
NOVERLAP = 2048

#: Log floor, so silent regions do not become -inf and poison the percentile.
_LOG_FLOOR = 1e-20

#: Hard cap on peaks per clip, applied by descending amplitude before the
#: fanout. It exists so a permissive threshold cannot turn one clip into
#: minutes of Python-level pairing; whether it actually binds is measured and
#: reported in CALIBRATION.md rather than assumed.
MAX_PEAKS = 8000

Key = Tuple[int, int, int]


@dataclass(frozen=True)
class Params:
    """The knobs. One field differs between any two variants that differ.

    ``percentile``
        Amplitude floor for a peak, as a percentile of the clip's own log
        spectrogram. The course suggests the 75th; a much lower value admits
        noise-floor peaks that are not reproducible between an enrollment and
        a query of the same song.
    ``neighborhood``
        Side of the square maximum-filter window, in (bin, frame) units.
    ``fanout``
        How many later peaks each anchor pairs with.
    ``offset_vote``
        True for the offset histogram the capstone describes; False for the
        bag-of-hashes ablation that counts shared keys and throws the times
        away.
    ``enroll_rate``
        Rate the enrollment path resamples to before fingerprinting. ``None``
        means "use what you were handed". Only ``SampleRateBugShazam`` sets it.
    """

    percentile: float = 75.0
    neighborhood: int = 15
    fanout: int = 15
    offset_vote: bool = True
    enroll_rate: Optional[int] = None


TUNED = Params()
DETUNED = Params(percentile=30.0, fanout=3)
BAG_OF_HASHES = Params(offset_vote=False)
SAMPLE_RATE_BUG = Params(enroll_rate=16000)


def log_spectrogram(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """``(bins, frames)`` log magnitudes from the course's own specgram call."""

    signal = np.asarray(samples, dtype=np.float64).ravel()
    if signal.shape[0] < NFFT:
        signal = np.concatenate([signal, np.zeros(NFFT - signal.shape[0])])
    power, _frequencies, _times = mlab.specgram(
        signal,
        NFFT=NFFT,
        Fs=float(sample_rate),
        window=mlab.window_hanning,
        noverlap=NOVERLAP,
        mode="magnitude",
    )
    return np.log(np.clip(np.asarray(power, dtype=np.float64), _LOG_FLOOR, None))


def find_peaks(spectrogram: np.ndarray, params: Params) -> np.ndarray:
    """``(n, 2)`` array of ``(bin, frame)`` local maxima above the floor.

    Sorted by frame then bin, because the fanout pairs each anchor with the
    peaks that come after it and "after" has to mean something.
    """

    if spectrogram.size == 0:
        return np.zeros((0, 2), dtype=np.int64)
    dilated = maximum_filter(
        spectrogram, size=(params.neighborhood, params.neighborhood), mode="nearest"
    )
    threshold = float(np.percentile(spectrogram, params.percentile))
    mask = (spectrogram >= dilated) & (spectrogram > threshold)
    bins, frames = np.nonzero(mask)
    if bins.shape[0] > MAX_PEAKS:
        # Keep the loudest. Dropping by time instead would silently truncate
        # the tail of a clip and make late queries unmatchable.
        strength = spectrogram[bins, frames]
        keep = np.argpartition(-strength, MAX_PEAKS)[:MAX_PEAKS]
        bins, frames = bins[keep], frames[keep]
    order = np.lexsort((bins, frames))
    return np.stack([bins[order], frames[order]], axis=1)


def fanout_hashes(peaks: np.ndarray, fanout: int) -> List[Tuple[Key, int]]:
    """``((f1, f2, dt), t1)`` for each anchor and its next ``fanout`` peaks."""

    if peaks.shape[0] == 0:
        return []
    bins = peaks[:, 0].astype(np.int64)
    frames = peaks[:, 1].astype(np.int64)
    out: List[Tuple[Key, int]] = []
    count = peaks.shape[0]
    for index in range(count):
        stop = min(index + 1 + fanout, count)
        anchor_bin = int(bins[index])
        anchor_frame = int(frames[index])
        for other in range(index + 1, stop):
            out.append(
                (
                    (anchor_bin, int(bins[other]), int(frames[other]) - anchor_frame),
                    anchor_frame,
                )
            )
    return out


def clip_hashes(
    samples: np.ndarray, sample_rate: int, params: Params
) -> Tuple[List[Tuple[Key, int]], int]:
    """Hashes for one clip, plus the peak count, for diagnostics."""

    peaks = find_peaks(log_spectrogram(samples, sample_rate), params)
    return fanout_hashes(peaks, params.fanout), int(peaks.shape[0])


def resample_to(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    """Polyphase resample. Only the sample-rate-bug variant calls this."""

    if source_rate == target_rate:
        return np.asarray(samples, dtype=np.float64)
    from math import gcd

    divisor = gcd(int(target_rate), int(source_rate))
    return resample_poly(
        np.asarray(samples, dtype=np.float64),
        int(target_rate) // divisor,
        int(source_rate) // divisor,
    )


class Fingerprinter:
    """Enroll songs, identify clips. The behavior lives entirely in ``Params``.

    The database maps a hash key to the ``(song_id, anchor_frame)`` pairs that
    produced it. Identification re-fingerprints the clip, looks every key up,
    and tallies. With ``offset_vote`` the tally is per ``(song, database_time
    minus query_time)``, so a song only wins when many hashes agree on one
    alignment; without it, the tally is a bare count of shared keys.
    """

    def __init__(self, params: Params = TUNED, top_k: int = 10) -> None:
        self.params = params
        self.top_k = int(top_k)
        self._database: Dict[Key, List[Tuple[str, int]]] = defaultdict(list)
        self._enrolled: List[str] = []
        self.peaks_per_song: Dict[str, int] = {}
        self.hashes_per_song: Dict[str, int] = {}
        self.finalized = False

    # -- required surface -------------------------------------------------

    def enroll(self, song_id: str, samples: np.ndarray, sample_rate: int) -> None:
        rate = sample_rate
        signal = samples
        if self.params.enroll_rate is not None:
            # The bug, on purpose: the database is built from columns of a
            # 16 kHz spectrogram while queries will arrive as columns of a
            # 44.1 kHz one. Same key type, disjoint key space, no exception.
            rate = int(self.params.enroll_rate)
            signal = resample_to(samples, sample_rate, rate)
        pairs, peak_count = clip_hashes(signal, rate, self.params)
        for key, time in pairs:
            self._database[key].append((song_id, time))
        self._enrolled.append(song_id)
        self.peaks_per_song[song_id] = peak_count
        self.hashes_per_song[song_id] = len(pairs)

    def identify(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[str, float]]:
        pairs, _peak_count = clip_hashes(samples, sample_rate, self.params)
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

    # -- optional surface: diagnostics only, never scored -----------------

    def fingerprint(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[Key, int]]:
        return clip_hashes(samples, sample_rate, self.params)[0]

    def finalize_database(self) -> None:
        self.finalized = True

    # -- staff introspection ----------------------------------------------

    @property
    def key_count(self) -> int:
        return len(self._database)

    @property
    def entry_count(self) -> int:
        return sum(len(rows) for rows in self._database.values())
