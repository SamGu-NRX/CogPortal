"""Measure which perturbation cells could grade a pipeline, and which cannot.

The shipped grid is eight cells: clean-long, clean-short, two SNRs, and four
integer pitch shifts. The calibration found that the first four saturate at
1.000 for every parameter setting tried and the last four sit at chance for
all of them, so ``identification_score`` is nearly a constant. This script
asks the follow-up question the recommendation needs an answer to: is there a
perturbation setting anywhere between "trivially easy" and "impossible" where
a good pipeline and a bad one actually differ?

It bypasses the manifest grid and calls ``synth.perturb`` directly, so it can
test cells that do not exist yet (sub-semitone shifts, sub-second clips, very
low SNR). Everything else, the corpus and the perturbation math, is the
benchmark's own code.

    /tmp/w1py38/bin/python probe_grid.py --tier evaluation
"""

from __future__ import annotations

import argparse
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from audio_identification_benchmark import synth
from audio_identification_benchmark.datasets import load_manifest, materialize_cases
from reference_shazam.pipeline import Fingerprinter, Params

#: Pipelines to compare. If a cell is going to rank teams, a good pipeline and
#: a visibly cruder one have to score differently on it.
PIPELINES: List[Tuple[str, Params]] = [
    ("tuned", Params()),
    ("detuned", Params(percentile=30.0, fanout=3)),
    ("fanout1", Params(fanout=1)),
    ("nbhd3", Params(neighborhood=3)),
    ("nbhd51", Params(neighborhood=51)),
    ("bag", Params(offset_vote=False)),
]


def cells(long_clip: float) -> List[Tuple[str, Dict[str, Any]]]:
    """Candidate grid cells: the shipped ones plus the untested in-between."""

    out: List[Tuple[str, Dict[str, Any]]] = []
    for seconds in (long_clip, 3.0, 1.0, 0.5, 0.25):
        out.append(("clip_{:g}s".format(seconds), dict(seconds=seconds)))
    for semitones in (0.05, 0.1, 0.15, 0.25, 0.5, 1.0, 2.0):
        out.append(
            ("pitch_+{:g}".format(semitones), dict(seconds=long_clip, pitch=semitones))
        )
    for snr in (10.0, 0.0, -5.0, -10.0, -15.0, -20.0):
        out.append(("snr_{:g}".format(snr), dict(seconds=long_clip, snr=snr)))
    return out


def build(params: Params, catalog: Dict[str, np.ndarray], rate: int) -> Fingerprinter:
    engine = Fingerprinter(params, top_k=10)
    for song_id in sorted(catalog):
        engine.enroll(song_id, catalog[song_id], rate)
    return engine


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", default="evaluation", choices=("test", "evaluation"))
    parser.add_argument("--songs", type=int, default=30, help="cap the catalog size")
    parser.add_argument("--queries", type=int, default=1, help="clips per song per cell")
    args = parser.parse_args(argv)

    manifest = load_manifest(args.tier)
    cases = materialize_cases(manifest)
    rate = int(manifest["sample_rate"])
    catalog = {
        case.song_id: case.samples
        for case in cases
        if getattr(case, "kind", "") == "enroll"
    }
    ids = sorted(catalog)[: args.songs]
    catalog = {song_id: catalog[song_id] for song_id in ids}
    long_clip = 10.0 if args.tier == "evaluation" else 6.0
    duration = float(manifest["songs"][0]["duration_seconds"])

    engines = [(name, build(params, catalog, rate)) for name, params in PIPELINES]
    print(
        "{} tier: {} songs, chance {:.3f}, {} clip(s) per song per cell\n".format(
            args.tier, len(ids), 1.0 / len(ids), args.queries
        )
    )
    names = [name for name, _ in PIPELINES]
    print("| cell | " + " | ".join(names) + " | spread |")
    print("| --- |" + " --- |" * (len(names) + 1))

    rng = np.random.default_rng(20260817)
    usable = max(duration - long_clip - 1.0, 0.5)
    for label, spec in cells(long_clip):
        seconds = float(spec["seconds"])
        hits = {name: [] for name in names}
        for song_id in ids:
            for _index in range(args.queries):
                offset = 1.0 + float(rng.uniform(0.0, usable))
                clip = synth.perturb(
                    catalog[song_id],
                    rate,
                    seconds,
                    offset,
                    float(spec.get("pitch", 0.0)),
                    spec.get("snr"),
                    int(rng.integers(1, 2 ** 31 - 1)),
                )
                for name, engine in engines:
                    ranked = engine.identify(clip, rate)
                    hits[name].append(
                        1.0 if ranked and ranked[0][0] == song_id else 0.0
                    )
        scores = [float(np.mean(hits[name])) for name in names]
        print(
            "| `{}` | ".format(label)
            + " | ".join("{:.3f}".format(value) for value in scores)
            + " | {:.3f} |".format(max(scores) - min(scores))
        )
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
