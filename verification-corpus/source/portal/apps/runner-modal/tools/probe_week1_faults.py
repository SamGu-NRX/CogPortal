"""What do ordinary Week 1 mistakes do to the platform?

Not cheating. These are the things a high-schooler writes by accident on a
Tuesday, drawn from what the audited repositories actually do: a module that
records from a microphone at import, a database written relative to the
working directory, a committed pickle loaded on construction, an array
mutated in place, a bare `sys.exit()`, an `assert` that fires under `-O`.

For each one, the question that decides whether the platform is reliable:
does the benchmark return a scored result with a readable diagnostic, or does
the mistake propagate and take the scorer down with it?

Every variant should end in `scored`. A row reading `RUN RAISED` or
`SCORER RAISED` is a platform bug, not a student bug.

    python apps/runner-modal/tools/probe_week1_faults.py

Read-only: it writes only into a temporary directory it removes afterwards.
"""

from __future__ import annotations

import contextlib
import io
import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "benchmarks" / "week1"))

from cogbench.plugins import load_benchmark  # noqa: E402

TIER = "test"


class Working:
    """A minimally working submission. Each variant breaks exactly one thing.

    Deliberately not a good fingerprinter -- it stores the mean log spectrum
    per song and answers with the nearest one. It scores poorly and that is
    fine: these probes ask whether a failure is contained, not whether the
    answer is right.
    """

    def __init__(self, resources=None):
        self.catalog = {}

    @staticmethod
    def _signature(samples, sample_rate):
        block = np.asarray(samples, dtype=np.float64)
        size = 2048
        usable = (block.size // size) * size
        if usable < size:
            return np.zeros(size // 2)
        frames = block[:usable].reshape(-1, size)
        spectrum = np.abs(np.fft.rfft(frames, axis=1))[:, : size // 2]
        return np.log(np.clip(spectrum, 1e-20, None)).mean(axis=0)

    def enroll(self, song_id, samples, sample_rate):
        self.catalog[song_id] = self._signature(samples, sample_rate)

    def identify(self, samples, sample_rate):
        """Ranked `(song_id, score)` pairs, best first, or `[]` for no match."""

        if not self.catalog:
            return []
        query = self._signature(samples, sample_rate)
        ranked = [
            (song_id, -float(np.linalg.norm(query - reference)))
            for song_id, reference in self.catalog.items()
        ]
        ranked.sort(key=lambda row: row[1], reverse=True)
        return ranked


# --------------------------------------------------------------------------
# The faults
# --------------------------------------------------------------------------


class ExitsDuringEnroll(Working):
    """`sys.exit()` inside enroll. Raises SystemExit, not Exception."""

    def enroll(self, song_id, samples, sample_rate):
        if song_id.endswith("03"):
            sys.exit("no microphone found")
        super().enroll(song_id, samples, sample_rate)


class AssertsDuringIdentify(Working):
    """A bare assert, the usual stand-in for validation."""

    def identify(self, samples, sample_rate):
        assert len(samples) > 10_000_000, "clip too short"
        return super().identify(samples, sample_rate)


class MutatesOurArray(Working):
    """Normalizes in place. Our array; every later case would see it."""

    def enroll(self, song_id, samples, sample_rate):
        peak = float(np.max(np.abs(samples))) or 1.0
        samples /= peak
        super().enroll(song_id, samples, sample_rate)


class WritesRelativePickle(Working):
    """`db.pkl` relative to the working directory, as two repositories do."""

    def enroll(self, song_id, samples, sample_rate):
        import pickle

        super().enroll(song_id, samples, sample_rate)
        with open("db.pkl", "wb") as handle:
            pickle.dump(self.catalog, handle)


class LoadsMissingPickle(Working):
    """Loads a committed database that is not in the archive."""

    def __init__(self, resources=None):
        import pickle

        with open("committed_database.pkl", "rb") as handle:
            self.catalog = pickle.load(handle)


class ReturnsWrongType(Working):
    """Returns the whole ranking where one id was documented."""

    def identify(self, samples, sample_rate):
        return super().identify(samples, sample_rate)[0][0]


class ReturnsNumpyScalar(Working):
    """A numpy str_ rather than a str. Compares equal; is not JSON."""

    def identify(self, samples, sample_rate):
        return [(np.str_(song_id), np.float32(score))
                for song_id, score in super().identify(samples, sample_rate)]


class PrintsThousandsOfLines(Working):
    """Left a debug print in the query loop."""

    def identify(self, samples, sample_rate):
        for index in range(2000):
            print("checking candidate {} of 2000".format(index))
        return super().identify(samples, sample_rate)


class RaisesOnEveryQuery(Working):
    """The ordinary bug: a shape error in the hot path."""

    def identify(self, samples, sample_rate):
        raise ValueError("operands could not be broadcast together")


class ReturnsNothingEver(Working):
    """Answers None always -- the inert submission."""

    def identify(self, samples, sample_rate):
        return []


class NoIdentifyAtAll(Working):
    """Named their method `match` instead. Should be an adapter report."""

    match = Working.identify
    identify = None


class EnrollIsSlow(Working):
    """Quadratic enroll, the shape that times out on the real corpus."""

    def enroll(self, song_id, samples, sample_rate):
        for _ in range(len(self.catalog) + 1):
            np.fft.rfft(np.asarray(samples[:65536], dtype=np.float64))
        super().enroll(song_id, samples, sample_rate)


VARIANTS = [
    ("sys.exit() during enroll", ExitsDuringEnroll),
    ("assert fires during identify", AssertsDuringIdentify),
    ("mutates our samples in place", MutatesOurArray),
    ("writes db.pkl to the cwd", WritesRelativePickle),
    ("loads a pickle that is not there", LoadsMissingPickle),
    ("returns a bare id, not ranked pairs", ReturnsWrongType),
    ("returns numpy scalars", ReturnsNumpyScalar),
    ("prints 2000 lines per query", PrintsThousandsOfLines),
    ("raises on every query", RaisesOnEveryQuery),
    ("never answers", ReturnsNothingEver),
    ("no identify method at all", NoIdentifyAtAll),
    ("quadratic enroll", EnrollIsSlow),
]


def probe(name, adapter_class, benchmark, cases):
    """Run one variant. Returns the row to print."""

    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            outputs = benchmark.run(lambda resources: adapter_class(resources),
                                    benchmark.model_factory(), cases)
    except BaseException as error:  # noqa: BLE001 - that is the finding
        return "RUN RAISED", "{}: {}".format(type(error).__name__, str(error)[:90])
    try:
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            scores = benchmark.score(outputs, cases)
    except BaseException as error:  # noqa: BLE001
        return "SCORER RAISED", "{}: {}".format(type(error).__name__, str(error)[:90])

    import json

    try:
        json.dumps(scores)
    except (TypeError, ValueError) as error:
        return "NOT JSON", str(error)[:90]

    diagnostics = list(getattr(benchmark, "last_diagnostics", []))
    detail = diagnostics[0][:90] if diagnostics else "(no diagnostic)"
    return "scored {:.3f}".format(scores.get("identification_score", float("nan"))), detail


def main() -> int:
    benchmark = load_benchmark("audio-identification")
    cases = benchmark.load_cases(TIER)
    workspace = Path(tempfile.mkdtemp(prefix="cog-w1-probe-"))
    previous = Path.cwd()
    failures = 0
    try:
        # Run from a scratch directory: two variants write files, and the
        # probe must not leave them in the repository.
        os.chdir(workspace)
        print("{} cases, tier {}\n".format(len(cases), TIER))
        print("{:<34} {:<16} {}".format("fault", "outcome", "first diagnostic"))
        print("-" * 118)
        for name, adapter_class in VARIANTS:
            outcome, detail = probe(name, adapter_class, benchmark, cases)
            if not outcome.startswith("scored"):
                failures += 1
            print("{:<34} {:<16} {}".format(name, outcome, detail))
    finally:
        os.chdir(previous)
        shutil.rmtree(workspace, ignore_errors=True)

    print()
    if failures:
        print("{} variant(s) escaped containment. Each is a platform bug.".format(failures))
        return 1
    print("all {} variants contained".format(len(VARIANTS)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
