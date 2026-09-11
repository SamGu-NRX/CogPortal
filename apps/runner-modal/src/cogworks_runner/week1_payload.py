"""Sandbox payload for the Week 1 audio benchmark.

The zip carries the manifest and nothing else: song seeds, their pinned
sha256 digests, and the query grid. The sandbox renders the audio itself
from those seeds and verifies each signal against its digest, so a corpus
that is not the pinned corpus fails before student code runs. That is why
the payload is kilobytes (16 KB for the test tier, 57 KB for evaluation)
where the audio it stands for is about 240 MB of float32.

Gold is stripped by construction. A query row's ``source_song_id`` names
which song a clip came from, and for an in-set query that *is* the answer,
so the sandbox copy replaces it with an opaque token and drops the
``in_set`` flag. The sandbox can still render the clip, because rendering
needs the song's seed and not its identity; it cannot tell which enrolled
song the clip belongs to, or whether the clip belongs to an enrolled song
at all. The controller re-attaches the real ids to its own copy with
``attach_gold`` before scoring.

``extract_gold`` and ``attach_gold`` are week 1's own pair; week 3's
``attach_gold`` has since moved into that benchmark. The official
volume layout (payload.zip beside gold.json) is one shape for both tracks.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from dataclasses import replace
from typing import Any, Dict, List, Sequence, Tuple

BENCHMARK_ID = "audio-identification"

#: Prefix for the opaque source token a stripped query carries. The token is
#: derived from the song id under a per-payload salt, so two queries cut from
#: the same song still share a token (the sandbox needs that to render them
#: from one signal) while the token itself names no song.
_TOKEN_PREFIX = "src-"


def _token(salt: str, song_id: str) -> str:
    digest = hashlib.sha256("{}:{}".format(salt, song_id).encode("utf-8")).hexdigest()
    return _TOKEN_PREFIX + digest[:16]


def _song_rows(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        {
            "song_id": str(row["song_id"]),
            "seed": int(row["seed"]),
            "duration_seconds": float(row["duration_seconds"]),
            "sha256": str(row["sha256"]),
        }
        for row in rows
    ]


def encode_payload(benchmark_id: str, manifest: Dict[str, Any], showcase: bool) -> bytes:
    """The sandbox manifest: renderable, scorable by nobody.

    Enrolled songs keep their real ids, because the submission is told those
    ids when it enrolls. Out-of-set songs and every query's source are
    tokenized, so the payload cannot answer the questions it asks.
    """

    if benchmark_id != BENCHMARK_ID:
        raise ValueError("Unsupported Week 1 benchmark.")
    if manifest.get("corpus_version") is None:
        raise ValueError("Manifest is missing its corpus version.")

    salt = "{}:{}".format(manifest["manifest_id"], manifest["master_seed"])
    songs = _song_rows(manifest["songs"])
    catalog_ids = {row["song_id"] for row in songs}

    # Out-of-set songs keep their seeds (the sandbox renders their clips) but
    # lose their ids, which is the only thing that would reveal that a query
    # is unanswerable.
    out_rows = []
    for row in _song_rows(manifest.get("out_of_set_songs", [])):
        row["song_id"] = _token(salt, row["song_id"])
        out_rows.append(row)

    queries = []
    for row in manifest["queries"]:
        source = str(row["source_song_id"])
        if bool(row["in_set"]) and source not in catalog_ids:
            raise ValueError(
                "Query {} claims to be in-set but names {}, which is not in the "
                "catalog.".format(row.get("query_id"), source)
            )
        queries.append(
            {
                "query_id": str(row["query_id"]),
                "source_token": _token(salt, source),
                "clip_seconds": float(row["clip_seconds"]),
                "offset_seconds": float(row["offset_seconds"]),
                "pitch_semitones": float(row["pitch_semitones"]),
                "snr_db": None if row.get("snr_db") is None else float(row["snr_db"]),
                "noise_seed": int(row["noise_seed"]),
            }
        )

    metadata = {
        "benchmark_id": benchmark_id,
        "showcase": bool(showcase),
        "corpus_version": str(manifest["corpus_version"]),
        "sample_rate": int(manifest["sample_rate"]),
        "salt": salt,
        "songs": songs,
        "out_of_set_songs": out_rows,
        "queries": queries,
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("metadata.json", json.dumps(metadata, sort_keys=True))
    return buffer.getvalue()


def decode_payload(payload: bytes) -> Tuple[str, bool, List[Any]]:
    """Render the corpus and rebuild the cases, gold-free, in the sandbox.

    Every rendered signal is verified against the manifest's sha256 here,
    before a single line of student code runs; ``render_from_manifest`` does
    that check itself.
    """

    from audio_identification_benchmark import synth
    from audio_identification_benchmark.datasets import EnrollCase, QueryCase

    with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
        metadata = json.loads(archive.read("metadata.json"))
    benchmark_id = str(metadata["benchmark_id"])
    if benchmark_id != BENCHMARK_ID:
        raise ValueError("Unsupported Week 1 benchmark payload.")
    if metadata["corpus_version"] != synth.CORPUS_VERSION:
        raise ValueError(
            "Payload was built for corpus {}, but this package renders {}.".format(
                metadata["corpus_version"], synth.CORPUS_VERSION
            )
        )

    sample_rate = int(metadata["sample_rate"])
    salt = str(metadata["salt"])
    catalog = synth.render_corpus(
        synth.specs_from_manifest(metadata["songs"]), sample_rate, verify=True
    )
    out_of_set = synth.render_corpus(
        synth.specs_from_manifest(metadata["out_of_set_songs"]), sample_rate, verify=True
    )
    # Both halves are addressed by token here: a query names only a token, and
    # the enrolled songs' real ids are looked up through the same derivation
    # the encoder used.
    by_token = {_token(salt, song_id): signal for song_id, signal in catalog.items()}
    by_token.update(out_of_set)

    cases: List[Any] = [
        EnrollCase(song_id=song_id, samples=catalog[song_id], sample_rate=sample_rate)
        for song_id in sorted(catalog)
    ]
    for row in metadata["queries"]:
        token = str(row["source_token"])
        source = by_token.get(token)
        if source is None:
            raise ValueError(
                "Query {} names a source that is not in the payload.".format(
                    row["query_id"]
                )
            )
        cases.append(
            QueryCase(
                query_id=str(row["query_id"]),
                sample_rate=sample_rate,
                clip_seconds=float(row["clip_seconds"]),
                pitch_semitones=float(row["pitch_semitones"]),
                snr_db=None if row["snr_db"] is None else float(row["snr_db"]),
                # Gold-free by construction: the sandbox is never told which
                # song a clip came from, or whether it came from an enrolled
                # one. The driver only reads gold to skip queries whose song
                # failed to enroll, which degrades to "run it anyway".
                gold_song_id=None,
                kind="in_set",
                offset_seconds=float(row["offset_seconds"]),
                noise_seed=int(row["noise_seed"]),
                source_song_id=token,
                _source=source,
            )
        )
    return benchmark_id, bool(metadata["showcase"]), cases


def extract_gold(cases: Sequence[Any]) -> Dict[str, Any]:
    """The controller-side gold record written beside the official payload."""

    from audio_identification_benchmark.datasets import QueryCase

    queries = [case for case in cases if isinstance(case, QueryCase)]
    if not queries:
        raise ValueError("No query cases to extract gold from.")
    if all(case.gold_song_id is None and case.kind == "in_set" for case in queries):
        raise ValueError("Cases are already gold-free; nothing to extract.")
    return {
        "queries": [
            {
                "query_id": case.query_id,
                "gold_song_id": case.gold_song_id,
                "kind": case.kind,
                "source_song_id": case.source_song_id,
            }
            for case in queries
        ]
    }


def attach_gold(cases: Sequence[Any], gold: Dict[str, Any]) -> List[Any]:
    """Restore gold ids on the controller's own copy, matched by query id."""

    from audio_identification_benchmark.datasets import QueryCase

    rows = {str(row["query_id"]): row for row in gold["queries"]}
    restored: List[Any] = []
    matched = 0
    for case in cases:
        if not isinstance(case, QueryCase):
            restored.append(case)
            continue
        row = rows.get(case.query_id)
        if row is None:
            raise ValueError("Gold record has no row for query {}.".format(case.query_id))
        matched += 1
        restored.append(
            replace(
                case,
                gold_song_id=(
                    None if row["gold_song_id"] is None else str(row["gold_song_id"])
                ),
                kind=str(row["kind"]),
                source_song_id=str(row["source_song_id"]),
            )
        )
    if matched != len(rows):
        raise ValueError(
            "Gold record covers {} queries but the cases carry {}.".format(
                len(rows), matched
            )
        )
    return restored
