"""Reusable runner for the Week 1 instrument-validity study.

Runs the study's submission variants through the benchmark's own driver and
scorer against the corpora defined in PROTOCOL.md, and retains per-query
predictions plus full input hashes so every number can be recomputed and
checked independently.

Arms:
  official    shipped manifests (test / evaluation), official grid, official
              scoring identities preserved
  seeds       evaluation-geometry manifests rebuilt at fresh master seeds
  probe       shipped evaluation corpus plus diagnostic cells: time shifts,
              clipping, resampling roundtrips, fine pitch
  ambiguity   shipped evaluation catalog plus two twin songs (identical audio
              under distinct ids) — identical permitted inputs, competing
              compatible answers
  real        the staged real-audio set (see real_audio/MANIFEST.json)

Parallelism: one subprocess per variant (the driver chdirs the process), so
variants run concurrently without sharing state.

    python run_study.py --arm official --tier test --jobs 6
    python run_study.py --arm seeds --seed 801000007 --jobs 6
    python run_study.py --arm probe --jobs 6
    python run_study.py --arm real --real-dir ../real_audio --jobs 6
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pickle
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

VALIDITY_DIR = Path(__file__).resolve().parent
EXAMPLES_DIR = VALIDITY_DIR.parent
REPO = EXAMPLES_DIR.parent.parent
BENCH_DIR = REPO / "benchmarks" / "week1"

# Owned files for local parity: the study runs against the pinned submodule
# checkout in this repository, never against a pip-installed copy.
sys.path.insert(0, str(BENCH_DIR))
sys.path.insert(0, str(EXAMPLES_DIR))

import audio_identification_benchmark  # noqa: E402
from audio_identification_benchmark.datasets import (  # noqa: E402
    EnrollCase,
    QueryCase,
    build_manifest,
    load_manifest,
    materialize_cases,
)
from audio_identification_benchmark.drivers import run_cases  # noqa: E402
from audio_identification_benchmark.metrics import (  # noqa: E402
    _cell_of,
    classify_outcome,
    score_outputs,
    trivial_baseline_outcomes,
)
from audio_identification_benchmark.plugins import (  # noqa: E402
    AudioIdentificationBenchmark,
)
from audio_identification_benchmark import synth  # noqa: E402

import reference_shazam.variants as reference_variants  # noqa: E402
from study_pipeline import STUDY_VARIANTS  # noqa: E402

ALL_VARIANTS = list(reference_variants.VARIANTS) + list(STUDY_VARIANTS)

#: The metadata oracle reads the shipped manifest for its tier, which is only
#: the manifest actually being scored on the official arm; elsewhere its
#: number would be a harness artifact, not a measurement.
ORACLE_ARM = "official"

#: Evaluation-tier geometry, mirroring tools/build_manifests.py so a fresh
#: seed manifest is the same size as the shipped one.
EVALUATION_GEOMETRY = dict(
    song_count=30,
    out_of_set_count=6,
    duration_seconds=45.0,
    long_clip=10.0,
    short_clip=3.0,
)
TEST_GEOMETRY = dict(
    song_count=8,
    out_of_set_count=2,
    duration_seconds=12.0,
    long_clip=6.0,
    short_clip=2.0,
)

#: Frozen measurement seeds for the seeds arm (PROTOCOL.md).
MEASUREMENT_SEEDS = (801000007, 801000013, 801000031)
#: Frozen tuning seeds (test geometry, tuning phase only).
TUNING_SEEDS = (800000019, 800000037)

CACHE_DIR = Path(os.environ.get("W1VALIDITY_CACHE", "/home/user/work/w1validity-cache"))
BOOTSTRAP_SEED = 20261009

#: The metadata oracle only means something where a shipped manifest exists.
MANIFEST_ARMS = ("official", "seeds", "probe", "ambiguity")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def sha256_manifest(manifest: Dict[str, Any]) -> str:
    text = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def submodule_pin() -> str:
    out = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(BENCH_DIR), capture_output=True, text=True
    )
    return out.stdout.strip() if out.returncode == 0 else "unknown"


def runner_file_hashes() -> Dict[str, str]:
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(VALIDITY_DIR.glob("*.py"))
    }


def versions() -> Dict[str, str]:
    import matplotlib
    import scipy

    return {
        "python": sys.version.split()[0],
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "matplotlib": matplotlib.__version__,
        "benchmark_package": audio_identification_benchmark.__version__,
        "benchmark_pin": submodule_pin(),
    }


def assert_owned_package() -> None:
    """Local parity guard: the imported scorer must be this repo's own files."""

    package_path = Path(audio_identification_benchmark.__file__).resolve()
    if not str(package_path).startswith(str(BENCH_DIR.resolve())):
        raise SystemExit(
            "audio_identification_benchmark resolved to {}, not the pinned "
            "submodule at {}. Refusing to run against a foreign copy.".format(
                package_path, BENCH_DIR
            )
        )


# --------------------------------------------------------------------------
# Corpus loading with cache
# --------------------------------------------------------------------------


def load_corpus(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Render (once) and cache the corpus for a manifest, keyed by its hash.

    First render goes through materialize_cases, which verifies every pinned
    sha256 before anything is cached; the cache stores the verified arrays so
    parallel variant processes share one render. On this Python/numpy the
    render is bit-reproducible via exactmath — a cache built on a machine
    that fails verification never gets created.
    """

    key = sha256_manifest(manifest)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / "corpus-{}.pkl".format(key[:16])
    if path.exists():
        with open(path, "rb") as handle:
            blob = pickle.load(handle)
        return blob
    cases = materialize_cases(manifest, verify=True)
    blob = {
        "manifest": manifest,
        "manifest_sha256": key,
        "catalog": {
            case.song_id: case.samples for case in cases if isinstance(case, EnrollCase)
        },
        "out_of_set": {
            case.source_song_id: case._source
            for case in cases
            if isinstance(case, QueryCase) and case.kind == "out_of_set"
        },
    }
    tmp = path.with_suffix(".tmp")
    with open(tmp, "wb") as handle:
        pickle.dump(blob, handle, protocol=4)
    os.replace(tmp, path)
    return blob


def cases_from_corpus(blob: Dict[str, Any]) -> List[Any]:
    """Rebuild the driver's exact case order from a cached corpus."""

    manifest = blob["manifest"]
    sample_rate = int(manifest["sample_rate"])
    catalog = blob["catalog"]
    out_of_set = blob["out_of_set"]
    cases: List[Any] = [
        EnrollCase(song_id=song_id, samples=catalog[song_id], sample_rate=sample_rate)
        for song_id in sorted(catalog)
    ]
    for row in manifest["queries"]:
        source_id = str(row["source_song_id"])
        in_set = bool(row["in_set"])
        source = catalog.get(source_id) if in_set else out_of_set.get(source_id)
        if source is None:
            raise RuntimeError("query {} sources unknown song {}".format(row.get("query_id"), source_id))
        snr = row.get("snr_db")
        cases.append(
            QueryCase(
                query_id=str(row["query_id"]),
                sample_rate=sample_rate,
                clip_seconds=float(row["clip_seconds"]),
                pitch_semitones=float(row["pitch_semitones"]),
                snr_db=None if snr is None else float(snr),
                gold_song_id=source_id if in_set else None,
                kind="in_set" if in_set else "out_of_set",
                offset_seconds=float(row["offset_seconds"]),
                noise_seed=int(row["noise_seed"]),
                source_song_id=source_id,
                _source=source,
            )
        )
    return cases


# --------------------------------------------------------------------------
# Study cells beyond the shipped grid
# --------------------------------------------------------------------------


class StudyQueryCase(QueryCase):
    """A study-only query the benchmark driver can execute.

    Subclasses the benchmark's ``QueryCase`` so the shared driver's
    ``isinstance(case, QueryCase)`` gate runs it through the identical
    enroll/warm-up/query path as official cases; there is exactly one
    execution path in this study. ``samples`` shadows the parent's
    derived-audio property (study cells carry precomputed clips directly),
    and ``study_cell``/``cellset`` ride along for the retained predictions.
    Official scoring never sees one of these objects: official runs walk the
    manifest's own ``QueryCase`` instances only.
    """

    def __init__(
        self,
        query_id: str,
        samples: np.ndarray,
        sample_rate: int,
        gold_song_id: Optional[str],
        kind: str,
        study_cell: str,
        cellset: str,
    ) -> None:
        super().__init__(
            query_id,
            sample_rate,
            float(samples.shape[0]) / float(sample_rate),
            0.0,
            None,
            gold_song_id,
            kind,
        )
        self._samples = np.ascontiguousarray(samples, dtype=np.float32)
        self.study_cell = study_cell
        self.cellset = cellset

    @property
    def samples(self) -> np.ndarray:
        return self._samples


def _renorm(signal: np.ndarray, level: float = 0.89) -> np.ndarray:
    peak = float(np.max(np.abs(signal))) if signal.shape[0] else 0.0
    if peak > 0.0:
        return np.ascontiguousarray(signal * (level / peak), dtype=np.float32)
    return np.ascontiguousarray(signal, dtype=np.float32)


def _resample_roundtrip(signal: np.ndarray, inner_rate: int, outer_rate: int = 44100) -> np.ndarray:
    from math import gcd

    down = gcd(inner_rate, outer_rate)
    inner = signal  # 16k roundtrip: 44100 -> 16000 -> 44100, band-limited
    from scipy.signal import resample_poly

    a = resample_poly(np.asarray(signal, dtype=np.float64), inner_rate // down, outer_rate // down)
    back = resample_poly(a, outer_rate // down, inner_rate // down)
    del inner
    if back.shape[0] >= signal.shape[0]:
        back = back[: signal.shape[0]]
    else:
        back = np.concatenate([back, np.zeros(signal.shape[0] - back.shape[0])])
    return np.ascontiguousarray(back, dtype=np.float32)


def probe_query_cases(
    blob: Dict[str, Any], cellset: str = "probe"
) -> List[StudyQueryCase]:
    """Diagnostic cells over the shipped corpus: time shift, clipping,
    resampling, fine pitch. One query per catalog song per cell; offsets are
    fixed rules (no fit), noise seeds derive from a frozen study seed."""

    manifest = blob["manifest"]
    rate = int(manifest["sample_rate"])
    duration = float(manifest["songs"][0]["duration_seconds"])
    long_clip = 10.0
    catalog = blob["catalog"]
    usable = max(duration - long_clip - 1.0, 0.5)
    mid_1 = 1.0 + 0.35 * usable
    mid_2 = 1.0 + 0.70 * usable

    cells = [
        ("time_early", dict(offset=1.0)),
        ("time_late", dict(offset=duration - long_clip - 0.5)),
        ("hardclip_025", dict(offset=mid_1, clip_stage="hard")),
        ("softclip_025", dict(offset=mid_1, clip_stage="soft")),
        ("resample_16k", dict(offset=mid_2, resample=16000)),
        ("resample_48k", dict(offset=mid_2, resample=48000)),
        ("pitch_fine_005", dict(offset=mid_1, pitch=0.05)),
        ("pitch_fine_010", dict(offset=mid_1, pitch=0.10)),
        ("pitch_fine_015", dict(offset=mid_1, pitch=0.15)),
        ("pitch_fine_025", dict(offset=mid_1, pitch=0.25)),
        ("pitch_fine_050", dict(offset=mid_1, pitch=0.50)),
    ]
    out: List[StudyQueryCase] = []
    counter = 0
    for song_id in sorted(catalog):
        for cell_name, spec in cells:
            seed_material = "{}|{}|{}".format(cell_name, song_id, BOOTSTRAP_SEED).encode()
            noise_seed = int.from_bytes(hashlib.sha256(seed_material).digest()[:8], "big") % (2**31 - 1)
            clip = synth.perturb(
                catalog[song_id],
                rate,
                long_clip,
                float(spec.get("offset", mid_1)),
                float(spec.get("pitch", 0.0)),
                spec.get("snr_db"),
                noise_seed,
            ).astype(np.float64)
            if spec.get("clip_stage") == "hard":
                clip = _renorm(np.clip(clip, -0.25, 0.25))
            elif spec.get("clip_stage") == "soft":
                clip = _renorm(0.25 * np.tanh(clip / 0.25))
            elif spec.get("resample"):
                clip = _resample_roundtrip(clip, int(spec["resample"]))
            out.append(
                StudyQueryCase(
                    query_id="probe-{:05d}".format(counter),
                    samples=np.ascontiguousarray(clip, dtype=np.float32),
                    sample_rate=rate,
                    gold_song_id=song_id,
                    kind="in_set",
                    study_cell=cell_name,
                    cellset=cellset,
                )
            )
            counter += 1
    return out


def ambiguity_cases(blob: Dict[str, Any]) -> List[Any]:
    """Shipped cases plus two twin songs: identical audio, distinct ids.

    The driver enrolls each song id exactly once, and twins are distinct ids,
    so this is a set of permitted inputs where one clip has two fully
    compatible answers and the scorer recognizes only the original. Gold and
    queries are unchanged; only the catalog grows."""

    cases = cases_from_corpus(blob)
    manifest = blob["manifest"]
    rate = int(manifest["sample_rate"])
    for twin_id, original in (("song-30", "song-00"), ("song-31", "song-01")):
        cases.append(
            EnrollCase(song_id=twin_id, samples=blob["catalog"][original], sample_rate=rate)
        )
    return cases


# --------------------------------------------------------------------------
# Real-audio arm
# --------------------------------------------------------------------------


def real_audio_cases(real_dir: Path) -> Dict[str, Any]:
    """Build catalog and study cells from the staged real-audio set.

    Catalog: every track except the two highest sorted track ids, which are
    held out to supply out-of-set queries. Offsets are fixed fractions of the
    track duration; noise seeds derive from the frozen study seed.
    """

    from scipy.io import wavfile

    manifest_path = real_dir / "MANIFEST.json"
    tracks_dir = real_dir / "tracks"
    manifest = json.loads(manifest_path.read_text())
    tracks = sorted(manifest["tracks"], key=lambda row: row["track_id"])
    holdout_ids = {row["track_id"] for row in tracks[-2:]}

    catalog: Dict[str, np.ndarray] = {}
    durations: Dict[str, float] = {}
    holdout: Dict[str, np.ndarray] = {}
    holdout_durations: Dict[str, float] = {}
    for row in tracks:
        samples, rate = wavfile.read(str(tracks_dir / row["wav"]))
        signal = np.asarray(samples, dtype=np.float32)
        if signal.ndim > 1:
            signal = signal.mean(axis=1)
        if rate != 44100:
            raise SystemExit("track {} is not 44100 Hz; restage it".format(row["track_id"]))
        duration = signal.shape[0] / float(rate)
        if row["track_id"] in holdout_ids:
            holdout[row["track_id"]] = signal
            holdout_durations[row["track_id"]] = duration
        else:
            catalog[row["track_id"]] = signal
            durations[row["track_id"]] = duration

    rate = 44100
    long_clip, short_clip = 10.0, 3.0
    cells = [
        ("clean_10s", long_clip, 2),
        ("clean_3s", short_clip, 2),
        ("time_early", long_clip, 1),
        ("time_late", long_clip, 1),
        ("pitch_up_1", long_clip, 2),
        ("pitch_down_1", long_clip, 1),
        ("pitch_fine_015", long_clip, 2),
        ("snr_minus10", long_clip, 2),
        ("snr_minus20", long_clip, 1),
        ("resample_16k", long_clip, 1),
        ("resample_48k", long_clip, 1),
        ("hardclip_025", long_clip, 1),
        ("softclip_025", long_clip, 1),
    ]
    cell_spec = {
        "clean_10s": dict(),
        "clean_3s": dict(clip=short_clip),
        "time_early": dict(offset=0.5),
        "time_late": dict(offset=None),  # resolved per track: dur - clip - 0.5
        "pitch_up_1": dict(pitch=1.0),
        "pitch_down_1": dict(pitch=-1.0),
        "pitch_fine_015": dict(pitch=0.15),
        "snr_minus10": dict(snr_db=-10.0),
        "snr_minus20": dict(snr_db=-20.0),
        "resample_16k": dict(resample=16000),
        "resample_48k": dict(resample=48000),
        "hardclip_025": dict(clip_stage="hard"),
        "softclip_025": dict(clip_stage="soft"),
    }

    enroll_cases = [
        EnrollCase(song_id=song_id, samples=catalog[song_id], sample_rate=rate)
        for song_id in sorted(catalog)
    ]
    query_cases: List[StudyQueryCase] = []
    counter = 0
    for song_id in sorted(catalog):
        duration = durations[song_id]
        usable = max(duration - long_clip - 1.0, 0.5)
        offsets = {"rep0": 1.0 + 0.30 * usable, "rep1": 1.0 + 0.65 * usable}
        for cell_name, clip_seconds, reps in cells:
            spec = cell_spec[cell_name]
            for rep in range(reps):
                seed_material = "real|{}|{}|{}".format(cell_name, song_id, rep).encode()
                noise_seed = int.from_bytes(hashlib.sha256(seed_material).digest()[:8], "big") % (2**31 - 1)
                if spec.get("offset") is not None:
                    offset = float(spec["offset"])
                elif cell_name == "time_late":
                    offset = max(duration - clip_seconds - 0.5, 0.0)
                else:
                    offset = offsets["rep{}".format(rep)]
                clip = synth.perturb(
                    catalog[song_id],
                    rate,
                    clip_seconds,
                    offset,
                    float(spec.get("pitch", 0.0)),
                    spec.get("snr_db"),
                    noise_seed,
                ).astype(np.float64)
                if spec.get("clip_stage") == "hard":
                    clip = _renorm(np.clip(clip, -0.25, 0.25))
                elif spec.get("clip_stage") == "soft":
                    clip = _renorm(0.25 * np.tanh(clip / 0.25))
                elif spec.get("resample"):
                    clip = _resample_roundtrip(clip, int(spec["resample"]))
                query_cases.append(
                    StudyQueryCase(
                        query_id="real-{:05d}".format(counter),
                        samples=np.ascontiguousarray(clip, dtype=np.float32),
                        sample_rate=rate,
                        gold_song_id=song_id,
                        kind="in_set",
                        study_cell=cell_name,
                        cellset="real",
                    )
                )
                counter += 1
    for song_id in sorted(holdout):
        duration = holdout_durations[song_id]
        usable = max(duration - long_clip - 1.0, 0.5)
        for rep, fraction in enumerate((0.25, 0.60)):
            seed_material = "real|oos|{}|{}".format(song_id, rep).encode()
            noise_seed = int.from_bytes(hashlib.sha256(seed_material).digest()[:8], "big") % (2**31 - 1)
            clip = synth.perturb(
                holdout[song_id], rate, long_clip, 1.0 + fraction * usable, 0.0, None, noise_seed
            )
            query_cases.append(
                StudyQueryCase(
                    query_id="real-{:05d}".format(counter),
                    samples=np.ascontiguousarray(clip, dtype=np.float32),
                    sample_rate=rate,
                    gold_song_id=None,
                    kind="out_of_set",
                    study_cell="out_of_set",
                    cellset="real",
                )
            )
            counter += 1

    return {
        "enroll_cases": enroll_cases,
        "query_cases": query_cases,
        "catalog": catalog,
        "holdout_ids": sorted(holdout_ids),
        "track_manifest": manifest,
    }


# --------------------------------------------------------------------------
# Running one variant
# --------------------------------------------------------------------------


def variant_config_hash(name: str) -> str:
    material = json.dumps({"variant": name, "registry": sorted(ALL_VARIANTS)}, sort_keys=True)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def variant_factory(name: str):
    if name in reference_variants.VARIANTS:
        return reference_variants.VARIANTS[name]
    return STUDY_VARIANTS[name]


def run_single_variant(
    variant: str,
    cases: Sequence[Any],
    out_dir: Path,
    arm: str,
    manifest_id: str,
    master_seed: Optional[int],
    tier: Optional[str],
    corpus_sha: str,
    song_hashes: Dict[str, str],
) -> Dict[str, Any]:
    """One variant through the official driver; predictions retained."""

    assert_owned_package()
    out_dir.mkdir(parents=True, exist_ok=True)
    benchmark = AudioIdentificationBenchmark()
    resources = benchmark.model_factory()
    original_cwd = os.getcwd()
    started = time.time()
    try:
        outputs = run_cases(variant_factory(variant), resources, cases)
    finally:
        os.chdir(original_cwd)

    enroll_rows: List[Dict[str, Any]] = []
    prediction_rows: List[Dict[str, Any]] = []
    for case, output in zip(cases, outputs):
        if getattr(case, "kind", "") == "enroll":
            enroll_rows.append(
                {
                    "song_id": getattr(case, "song_id", "?"),
                    "ok": bool(output.get("ok")),
                    "seconds": output.get("seconds"),
                    "error": output.get("error"),
                }
            )
            continue
        gold = getattr(case, "gold_song_id", None)
        study_cell = getattr(case, "study_cell", None)
        cellset = getattr(case, "cellset", None)
        if study_cell is None:
            # A benchmark QueryCase: official cell applies.
            study_cell = _cell_of(case) if hasattr(case, "pitch_semitones") else "out_of_set"
            cellset = "official_grid"
        candidates = output.get("candidates", [])
        # The official scorer derives outcomes from the returned ranked list
        # (metrics.classify_outcome); the runner mirrors that here so the
        # retained predictions carry the outcome, and the independent
        # checker recomputes it from the same fields.
        if output.get("ok"):
            if getattr(case, "kind", "") == "out_of_set" or gold is None:
                outcome = "out_of_set_confident" if candidates else "out_of_set_abstain"
            else:
                outcome = classify_outcome([str(c) for c in candidates], gold)
        else:
            outcome = str(output.get("outcome") or "error")
        prediction_rows.append(
            {
                "arm": arm,
                "manifest_id": manifest_id,
                "master_seed": master_seed,
                "tier": tier,
                "corpus_sha256": corpus_sha,
                "variant": variant,
                "query_id": getattr(case, "query_id", "?"),
                "study_cell": study_cell,
                "cellset": cellset,
                "official_cell": (_cell_of(case) if hasattr(case, "pitch_semitones") else None),
                "gold": gold,
                "kind": getattr(case, "kind", "?"),
                "ok": bool(output.get("ok")),
                "candidates": candidates,
                "scores": output.get("scores"),
                "shape": output.get("shape"),
                "seconds": output.get("seconds"),
                "outcome": outcome,
                "error": output.get("error"),
            }
        )

    mappings: List[str] = []
    for output in outputs:
        for note in output.get("mappings", []) or []:
            if note not in mappings:
                mappings.append(str(note))

    predictions_path = out_dir / "predictions-{}.jsonl.gz".format(variant)
    with gzip.open(predictions_path, "wt") as stream:
        for row in prediction_rows:
            stream.write(json.dumps(row, sort_keys=True, default=float) + "\n")

    run_record = {
        "arm": arm,
        "manifest_id": manifest_id,
        "master_seed": master_seed,
        "tier": tier,
        "corpus_sha256": corpus_sha,
        "song_sha256": song_hashes,
        "variant": variant,
        "variant_config_sha256": variant_config_hash(variant),
        "versions": versions(),
        "runner_files": runner_file_hashes(),
        "adapter_mappings": mappings,
        "enroll": enroll_rows,
        "query_count": len(prediction_rows),
        "wall_seconds": round(time.time() - started, 2),
        "predictions": predictions_path.name,
    }
    (out_dir / "run-{}.json".format(variant)).write_text(json.dumps(run_record, indent=1, sort_keys=True))
    return run_record


def song_hash_rows(blob: Dict[str, Any]) -> Dict[str, str]:
    return {
        song_id: synth.sha256_signal(signal)
        for song_id, signal in blob["catalog"].items()
    }


# --------------------------------------------------------------------------
# Arms
# --------------------------------------------------------------------------


def build_arm(arm: str, tier: Optional[str], seed: Optional[int], real_dir: Optional[Path]):
    """Return (cases, manifest_id, master_seed, tier, corpus_sha, song_hashes)."""

    if arm == "official":
        manifest = load_manifest(tier)
        blob = load_corpus(manifest)
        return cases_from_corpus(blob), str(manifest["manifest_id"]), int(manifest["master_seed"]), tier, blob["manifest_sha256"], song_hash_rows(blob)
    if arm == "seeds":
        geometry = EVALUATION_GEOMETRY if tier == "evaluation" else TEST_GEOMETRY
        manifest = build_manifest(
            manifest_id="study-{}-seed-{}".format(tier, seed),
            master_seed=int(seed),
            with_stats=False,
            **geometry
        )
        blob = load_corpus(manifest)
        return cases_from_corpus(blob), manifest["manifest_id"], int(seed), tier, blob["manifest_sha256"], song_hash_rows(blob)
    if arm == "probe":
        manifest = load_manifest("evaluation")
        blob = load_corpus(manifest)
        cases = cases_from_corpus(blob) + probe_query_cases(blob)
        return cases, str(manifest["manifest_id"]), int(manifest["master_seed"]), "evaluation", blob["manifest_sha256"], song_hash_rows(blob)
    if arm == "ambiguity":
        manifest = load_manifest("evaluation")
        blob = load_corpus(manifest)
        cases = ambiguity_cases(blob)
        hashes = song_hash_rows(blob)
        hashes["song-30"] = hashes["song-00"]
        hashes["song-31"] = hashes["song-01"]
        return cases, str(manifest["manifest_id"]) + "+twins", int(manifest["master_seed"]), "evaluation", blob["manifest_sha256"], hashes
    if arm == "real":
        if real_dir is None or not (real_dir / "MANIFEST.json").exists():
            raise SystemExit(
                "real-audio arm requested but no staged set at {}; the arm stays "
                "unmeasured unless the set exists.".format(real_dir)
            )
        built = real_audio_cases(real_dir)
        hashes = {
            case.song_id: synth.sha256_signal(case.samples) for case in built["enroll_cases"]
        }
        return (
            list(built["enroll_cases"]) + list(built["query_cases"]),
            "real-audio",
            None,
            None,
            "real:" + hashlib.sha256(
                json.dumps(built["track_manifest"], sort_keys=True).encode()
            ).hexdigest()[:16],
            hashes,
        )
    raise SystemExit("unknown arm: {}".format(arm))


def orchestrate(
    arm: str,
    tier: Optional[str],
    seed: Optional[int],
    variant_names: Sequence[str],
    out_root: Path,
    jobs: int,
    real_dir: Optional[Path],
) -> Path:
    cases, manifest_id, master_seed, resolved_tier, corpus_sha, song_hashes = build_arm(
        arm, tier, seed, real_dir
    )
    out_dir = out_root / arm / manifest_id
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_record = {
        "arm": arm,
        "manifest_id": manifest_id,
        "master_seed": master_seed,
        "tier": resolved_tier,
        "corpus_sha256": corpus_sha,
        "song_sha256": song_hashes,
        "versions": versions(),
        "variants": list(variant_names),
        "case_count": len(cases),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest_record, indent=1, sort_keys=True))

    # Cache the case list for subprocesses: the arrays are the verified corpus.
    cache_path = CACHE_DIR / "cases-{}-{}.pkl".format(arm, hashlib.sha256(manifest_id.encode()).hexdigest()[:12])
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if not cache_path.exists():
        tmp = cache_path.with_suffix(".tmp")
        with open(tmp, "wb") as handle:
            pickle.dump(cases, handle, protocol=4)
        os.replace(tmp, cache_path)

    env = dict(os.environ)
    env["COGWORKS_W1_TIER"] = resolved_tier or ""
    env["W1STUDY_CASE_CACHE"] = str(cache_path)
    env["W1STUDY_OUT_DIR"] = str(out_dir)
    env["W1STUDY_ARM"] = arm
    env["W1STUDY_MANIFEST_ID"] = manifest_id
    env["W1STUDY_MASTER_SEED"] = "" if master_seed is None else str(master_seed)
    env["W1STUDY_TIER"] = resolved_tier or ""
    env["W1STUDY_CORPUS_SHA"] = corpus_sha
    env["W1STUDY_SONG_HASHES"] = json.dumps(song_hashes)
    env["W1STUDY_REAL_DIR"] = str(real_dir or "")

    running: List[subprocess.Popen] = []
    queue = list(variant_names)
    while queue or running:
        while queue and len(running) < jobs:
            name = queue.pop(0)
            log_path = out_dir / "log-{}.txt".format(name)
            log = open(log_path, "w")
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--single", name],
                stdout=log,
                stderr=subprocess.STDOUT,
                env=env,
                cwd=str(VALIDITY_DIR),
            )
            running.append(process)
            # The child inherited the handle; the parent's copy is dropped.
            log.close()
        running = [p for p in running if p.poll() is None]
        if queue and len(running) < jobs:
            continue
        if running:
            time.sleep(2)
    failed = [name for name in variant_names if not (out_dir / "run-{}.json".format(name)).exists()]
    if failed:
        raise SystemExit("variant subprocesses failed: {}; see logs in {}".format(failed, out_dir))
    print("arm {} manifest {} -> {}".format(arm, manifest_id, out_dir))
    return out_dir


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arm", default="official", choices=("official", "seeds", "probe", "ambiguity", "real"))
    parser.add_argument("--tier", default="", help="test|evaluation (official/seeds)")
    parser.add_argument("--seed", type=int, default=0, help="master seed for the seeds arm")
    parser.add_argument("--variants", default=",".join(ALL_VARIANTS))
    parser.add_argument("--jobs", type=int, default=5)
    parser.add_argument("--out", default=str(VALIDITY_DIR / "results"))
    parser.add_argument("--real-dir", default="")
    parser.add_argument("--single", default="", help=argparse.SUPPRESS)  # subprocess mode
    args = parser.parse_args(argv)

    if args.single:
        # Subprocess mode: load the cached case list, run one variant.
        cases = pickle.load(open(os.environ["W1STUDY_CASE_CACHE"], "rb"))
        out_dir = Path(os.environ["W1STUDY_OUT_DIR"])
        song_hashes = json.loads(os.environ["W1STUDY_SONG_HASHES"])
        real_dir = Path(os.environ["W1STUDY_REAL_DIR"]) if os.environ["W1STUDY_REAL_DIR"] else None
        run_single_variant(
            args.single,
            cases,
            out_dir,
            os.environ["W1STUDY_ARM"],
            os.environ["W1STUDY_MANIFEST_ID"],
            int(os.environ["W1STUDY_MASTER_SEED"]) if os.environ["W1STUDY_MASTER_SEED"] else None,
            os.environ["W1STUDY_TIER"] or None,
            os.environ["W1STUDY_CORPUS_SHA"],
            song_hashes,
        )
        del real_dir
        return 0

    tier = args.tier or None
    if args.arm == "official" and tier not in ("test", "evaluation"):
        parser.error("--tier test|evaluation required for the official arm")
    if args.arm == "seeds" and tier not in ("test", "evaluation"):
        parser.error("--tier required for the seeds arm")
    real_dir = Path(args.real_dir) if args.real_dir else None
    names = [name.strip() for name in args.variants.split(",") if name.strip()]
    unknown = [name for name in names if name not in ALL_VARIANTS]
    if unknown:
        parser.error("unknown variants: {}".format(unknown))
    if args.arm != ORACLE_ARM and "metadata_oracle" in names:
        names.remove("metadata_oracle")
        print("note: metadata_oracle runs on the official arm only; dropped for {}".format(args.arm))
    if args.arm not in ("official", "seeds") and "call_order" in names:
        names.remove("call_order")
        print("note: call_order needs manifest-ordered queries; dropped for {} (see PROTOCOL.md)".format(args.arm))
    orchestrate(args.arm, tier, args.seed or None, names, Path(args.out), args.jobs, real_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
