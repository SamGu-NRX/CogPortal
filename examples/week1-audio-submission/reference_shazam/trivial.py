"""The floor: one averaged spectrum per song, cosine nearest neighbour.

No peaks, no fingerprints, no time information at all. It exists so that
"beats chance" can never be mistaken for "built a Shazam pipeline". Chance on
the evaluation tier is 1/30 = 0.033; this scores far above that while being
obviously not the assignment, which is exactly the gap the instrument has to
show.

The feature is deliberately the same one ``metrics.trivial_baseline_top1``
computes (``synth.mean_log_spectrum``), so the number this variant scores as a
submission and the number the scorer prints as a baseline can be compared
directly. They will not be identical: the scorer's baseline never sees an
enrollment failure and always uses the whole enrolled song, while this runs
through the real driver.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np
from matplotlib import mlab

from .pipeline import NFFT, NOVERLAP, _LOG_FLOOR


def mean_log_spectrum(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    """Whole-clip average log magnitude spectrum, one vector per clip."""

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
    spectrogram = np.log(np.clip(np.asarray(power, dtype=np.float64), _LOG_FLOOR, None))
    if spectrogram.shape[1] == 0:
        return np.zeros(spectrogram.shape[0], dtype=np.float64)
    return spectrogram.mean(axis=1)


class TrivialBaseline:
    """Cosine nearest neighbour over mean log spectra.

    Every song shares the same broad spectral tilt, so raw cosine similarities
    all sit near 0.99 and the ranking is decided by rounding. Both sides are
    therefore centred by the same vector: the catalog's per-bin mean spectrum.

    That "same vector" is the whole subtlety, and getting it wrong is not
    hypothetical. ``metrics.trivial_baseline_outcomes`` centres the reference
    matrix per bin (``reference.mean(axis=0)``, a 2049-vector) but centres each
    query by its own scalar mean (``vector - vector.mean()``, one number).
    Those are different spaces, and the resulting nearest neighbour is
    whichever catalog song has the largest residual rather than the closest
    one: on the evaluation tier it answers ``song-00`` for all 240 in-set
    queries and reports 0.033 (exactly chance) instead of the 0.242 the same
    features give when both sides are centred alike. See CALIBRATION.md; the
    fix belongs in the benchmark, and this class does not replicate the bug
    because its job is to be an honest floor.
    """

    def __init__(self, resources: object = None, top_k: int = 10) -> None:
        self.top_k = int(top_k)
        self._catalog: Dict[str, np.ndarray] = {}
        self._ids: List[str] = []
        self._matrix = None
        self._center = None

    def enroll(self, song_id: str, samples: np.ndarray, sample_rate: int) -> None:
        self._catalog[song_id] = mean_log_spectrum(samples, sample_rate)
        self._matrix = None

    def _build(self) -> None:
        self._ids = sorted(self._catalog)
        if not self._ids:
            self._matrix = np.zeros((0, 0))
            self._center = None
            return
        matrix = np.stack([self._catalog[song_id] for song_id in self._ids])
        self._center = matrix.mean(axis=0)
        matrix = matrix - self._center[np.newaxis, :]
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        self._matrix = matrix / np.where(norms == 0.0, 1.0, norms)

    def finalize_database(self) -> None:
        self._build()

    def identify(self, samples: np.ndarray, sample_rate: int) -> List[Tuple[str, float]]:
        if self._matrix is None:
            self._build()
        if self._matrix is None or self._matrix.shape[0] == 0 or self._center is None:
            return []
        vector = mean_log_spectrum(samples, sample_rate) - self._center
        norm = float(np.linalg.norm(vector))
        if norm == 0.0:
            return []
        similarity = self._matrix @ (vector / norm)
        order = np.argsort(-similarity)[: self.top_k]
        return [(self._ids[int(index)], float(similarity[int(index)])) for index in order]
