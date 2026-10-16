"""Miniature song-search adapter: four small stages, numpy only."""
from __future__ import annotations
import numpy as np

WINDOW = 1024
HOP = 512
TOP = 5


def song_spectrogram(samples, sample_rate):
    frames = [samples[i:i + WINDOW] for i in range(0, max(1, len(samples) - WINDOW), HOP)]
    spec = np.abs(np.fft.rfft(np.hanning(WINDOW) * np.array(frames), axis=1))
    return spec


def pick_peaks(spec):
    peaks = []
    for t in range(spec.shape[0]):
        for f in np.argpartition(spec[t], -4)[-4:]:
            peaks.append((t, int(f), float(spec[t][f])))
    return peaks


def make_fingerprints(peaks):
    out = []
    for a in range(len(peaks)):
        for b in range(a + 1, min(a + 4, len(peaks))):
            t1, f1, _ = peaks[a]
            t2, f2, _ = peaks[b]
            out.append(((f1, f2, t2 - t1), t1))
    return out


class MiniSearch:
    def __init__(self, resources):
        self.rate = resources.sample_rate
        self.db = {}

    def enroll(self, song_id, samples, sample_rate):
        spec = song_spectrogram(samples, sample_rate)
        self.db[song_id] = make_fingerprints(pick_peaks(spec))

    def identify(self, samples, sample_rate):
        spec = song_spectrogram(samples, sample_rate)
        probe = make_fingerprints(pick_peaks(spec))
        votes = {}
        for song_id, prints in self.db.items():
            pset = {(f1, f2, dt) for (f1, f2, dt), _ in prints}
            hits = sum(1 for k, _ in probe if k in pset)
            votes[song_id] = hits
        ranked = sorted(votes.items(), key=lambda kv: kv[1], reverse=True)
        return [(sid, float(v)) for sid, v in ranked[:TOP]]


def create_submission(resources):
    return MiniSearch(resources)
