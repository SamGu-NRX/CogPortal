/**
 * The Week 1 submission the suite's team repositories carry: a compact but
 * genuine fingerprint matcher written in the shape the benchmark's discovery
 * accepts — a factory class with enroll/identify — adapted from the
 * fingerprint-matching pattern the benchmark's own reference tests use.
 */
export const SUBMISSION_PY = `\"\"\"Team submission: song identification by spectral fingerprints.\"\"\"

from collections import Counter, defaultdict
from typing import Any, Dict, List, Tuple

import numpy as np


def _log_spectrogram(samples: np.ndarray) -> np.ndarray:
    # Frame the signal and keep a log magnitude spectrum per frame.
    frame = 2048
    hop = 512
    window = np.hanning(frame)
    frames = 1 + max(0, (len(samples) - frame) // hop)
    result = np.zeros((frames, frame // 2), dtype=np.float32)
    for index in range(frames):
        chunk = samples[index * hop : index * hop + frame] * window
        spectrum = np.abs(np.fft.rfft(chunk)[: frame // 2])
        result[index] = np.log1p(spectrum).astype(np.float32)
    return result


def _peaks(spec: np.ndarray, neighborhood: int = 10, percentile: float = 75.0) -> np.ndarray:
    # Local maxima above a percentile of their neighborhood's energy.
    from scipy.ndimage import maximum_filter

    floor = np.percentile(spec, percentile)
    mask = (spec == maximum_filter(spec, size=2 * neighborhood + 1)) & (spec > floor)
    found = np.argwhere(mask)
    return found[np.lexsort((found[:, 1], found[:, 0]))] if found.shape[0] else found


def _hashes(samples: np.ndarray, fanout: int = 15) -> List[Tuple[Tuple[int, int, int], int]]:
    peaks = _peaks(_log_spectrogram(samples))
    pairs: List[Tuple[Tuple[int, int, int], int]] = []
    for index in range(peaks.shape[0]):
        for other in range(index + 1, min(index + 1 + fanout, peaks.shape[0])):
            pairs.append(
                (
                    (int(peaks[index][1]), int(peaks[other][1]), int(peaks[other][0] - peaks[index][0])),
                    int(peaks[index][0]),
                )
            )
    return pairs


class SpectralMatcher:
    \"\"\"Enroll songs as fingerprint tables; identify clips by offset voting.\"\"\"

    def __init__(self, resources: Any = None) -> None:
        self._database: Dict[Tuple[int, int, int], List[Tuple[str, int]]] = defaultdict(list)

    def enroll(self, song_id: str, samples: np.ndarray, sample_rate: int) -> None:
        for key, time in _hashes(samples):
            self._database[key].append((song_id, time))

    def identify(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[str, float]]:
        votes: Counter = Counter()
        for key, time in _hashes(samples):
            for song_id, stored in self._database.get(key, ()):
                votes[(song_id, stored - time)] += 1
        best: Dict[str, int] = {}
        for (song_id, _offset), count in votes.items():
            best[song_id] = max(best.get(song_id, 0), count)
        ranked = sorted(best.items(), key=lambda item: (-item[1], item[0]))
        return [(song_id, float(count)) for song_id, count in ranked[:10]]
`;
