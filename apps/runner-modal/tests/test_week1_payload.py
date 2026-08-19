from __future__ import annotations

import io
import json
import sys
import unittest
import zipfile
from importlib.util import find_spec
from pathlib import Path

try:
    import numpy as np
except ImportError:
    np = None

# `cogworks_runner` is not a published package; the sandbox image mounts it at
# /opt/runner. Insert it here rather than relying on another payload test
# having done it as an import side effect.
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))


def _manifest():
    from audio_identification_benchmark.datasets import load_manifest

    return load_manifest("test")


@unittest.skipIf(
    np is None or find_spec("audio_identification_benchmark") is None,
    "Week 1 dependency lane only",
)
class Week1PayloadTest(unittest.TestCase):
    def test_gold_never_serialized(self):
        from cogworks_runner.week1_payload import encode_payload

        manifest = _manifest()
        payload = encode_payload("audio-identification", manifest, showcase=False)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            metadata = json.loads(archive.read("metadata.json"))
        flattened = json.dumps(metadata)
        # The two things that would answer a query: which song a clip came
        # from, and whether that song is in the catalog at all.
        self.assertNotIn("source_song_id", flattened)
        self.assertNotIn("in_set", flattened)
        for row in manifest["out_of_set_songs"]:
            self.assertNotIn(row["song_id"], flattened)
        # Enrolled ids are public by construction: the submission is handed
        # each one when it enrolls.
        for row in manifest["songs"]:
            self.assertIn(row["song_id"], flattened)

    def test_payload_is_manifest_sized_not_audio_sized(self):
        """The point of shipping seeds: the test tier's audio is ~17 MB of
        float32 and its payload must stay in the kilobytes."""

        from cogworks_runner.week1_payload import encode_payload

        payload = encode_payload("audio-identification", _manifest(), showcase=False)
        self.assertLess(len(payload), 64 * 1024)

    def test_roundtrip_renders_identical_audio_without_gold(self):
        from audio_identification_benchmark.datasets import (
            QueryCase,
            materialize_cases,
        )
        from cogworks_runner.week1_payload import decode_payload, encode_payload

        manifest = _manifest()
        first = encode_payload("audio-identification", manifest, showcase=True)
        second = encode_payload("audio-identification", manifest, showcase=True)
        self.assertEqual(first, second)

        benchmark_id, showcase, sandbox = decode_payload(first)
        self.assertEqual(benchmark_id, "audio-identification")
        self.assertTrue(showcase)

        controller = materialize_cases(manifest)
        self.assertEqual(len(sandbox), len(controller))
        for produced, expected in zip(sandbox, controller):
            np.testing.assert_array_equal(produced.samples, expected.samples)

        queries = [case for case in sandbox if isinstance(case, QueryCase)]
        self.assertTrue(queries)
        self.assertTrue(all(case.gold_song_id is None for case in queries))
        # Every query looks in-set to the sandbox, which is what stops it
        # telling an out-of-set clip apart from an answerable one.
        self.assertEqual({case.kind for case in queries}, {"in_set"})

    def test_extract_and_attach_gold_roundtrip(self):
        from audio_identification_benchmark.datasets import (
            QueryCase,
            materialize_cases,
        )
        from cogworks_runner.week1_payload import (
            attach_gold,
            decode_payload,
            encode_payload,
            extract_gold,
        )

        manifest = _manifest()
        controller = materialize_cases(manifest)
        gold = extract_gold(controller)
        _, _, stripped = decode_payload(
            encode_payload("audio-identification", manifest, showcase=False)
        )
        restored = attach_gold(stripped, gold)

        original_queries = [c for c in controller if isinstance(c, QueryCase)]
        restored_queries = [c for c in restored if isinstance(c, QueryCase)]
        self.assertEqual(len(restored_queries), len(original_queries))
        for produced, expected in zip(restored_queries, original_queries):
            self.assertEqual(produced.query_id, expected.query_id)
            self.assertEqual(produced.gold_song_id, expected.gold_song_id)
            self.assertEqual(produced.kind, expected.kind)
            self.assertEqual(produced.source_song_id, expected.source_song_id)
        # An out-of-set query must come back out-of-set, or the scorer would
        # count an abstention as a miss.
        self.assertTrue(any(c.kind == "out_of_set" for c in restored_queries))

    def test_attach_gold_count_mismatch_fails(self):
        from cogworks_runner.week1_payload import (
            attach_gold,
            decode_payload,
            encode_payload,
        )

        manifest = _manifest()
        _, _, stripped = decode_payload(
            encode_payload("audio-identification", manifest, showcase=False)
        )
        with self.assertRaises(ValueError):
            attach_gold(stripped, {"queries": [{
                "query_id": "q0000",
                "gold_song_id": "song-00",
                "kind": "in_set",
                "source_song_id": "song-00",
            }]})

    def test_corpus_version_mismatch_is_refused(self):
        """A payload built against different synthesis math must not score."""

        from cogworks_runner.week1_payload import decode_payload, encode_payload

        payload = encode_payload("audio-identification", _manifest(), showcase=False)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            metadata = json.loads(archive.read("metadata.json"))
        metadata["corpus_version"] = "synth-v0"
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("metadata.json", json.dumps(metadata, sort_keys=True))
        with self.assertRaises(ValueError):
            decode_payload(buffer.getvalue())

    def test_tampered_digest_is_refused(self):
        """The sha256 pins are checked in the sandbox, before student code."""

        from audio_identification_benchmark.synth import SynthError
        from cogworks_runner.week1_payload import decode_payload, encode_payload

        payload = encode_payload("audio-identification", _manifest(), showcase=False)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            metadata = json.loads(archive.read("metadata.json"))
        metadata["songs"][0]["seed"] = int(metadata["songs"][0]["seed"]) + 1
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("metadata.json", json.dumps(metadata, sort_keys=True))
        with self.assertRaises(SynthError):
            decode_payload(buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
