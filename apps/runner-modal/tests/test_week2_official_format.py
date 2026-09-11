"""Exercise official clustering bundles with synthetic RGB rows, never CelebA."""

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

try:
    WEEK2_AVAILABLE = all(
        importlib.util.find_spec(name) is not None
        for name in (
            "numpy",
            "PIL",
            "facial_recognition_benchmark.datasets",
        )
    )
except ModuleNotFoundError:
    WEEK2_AVAILABLE = False

if WEEK2_AVAILABLE:
    import numpy as np
    from cogworks_runner.week2_payload import (
        attach_clustering_labels,
        decode_cases,
        encode_cases,
    )
    from facial_recognition_benchmark import datasets
    from facial_recognition_benchmark.plugins import ClusteringBenchmark

    TOOL = Path(__file__).resolve().parents[1] / "tools/materialize_week2_official.py"
    spec = importlib.util.spec_from_file_location("materialize_week2_official", TOOL)
    materializer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(materializer)


def synthetic_manifest(seed, sizes=(30, 30, 30)):
    samples, scenarios, rows = [], [], {}
    for group, size in enumerate(sizes):
        sample_ids, labels = [], []
        for position in range(size):
            index = len(rows)
            sample_id = "synthetic-{}".format(index)
            identity = "synthetic-identity-{}-{}".format(group, position % 2)
            image = np.full((2, 2, 3), index, dtype=np.uint8)
            rows[index] = {"image": image, "identity": identity}
            samples.append(
                {
                    "sample_id": sample_id,
                    "row_index": index,
                    "pixel_sha256": datasets.decoded_pixel_sha256(image),
                    "source_identity_sha256": datasets.source_identity_sha256(identity),
                    "width": 2,
                    "height": 2,
                }
            )
            sample_ids.append(sample_id)
            labels.append(identity)
        scenarios.append(
            {
                "scenario_id": "scenario-{}".format(group),
                "sample_ids": sample_ids,
                "labels": labels,
                "seed": seed,
            }
        )
    return {
        "schema_version": 1,
        "manifest_id": "synthetic-official-format",
        "dataset": datasets.DATASET_NAME,
        "revision": datasets.DATASET_REVISION,
        "split": "synthetic-only",
        "samples": samples,
        "clustering_scenarios": scenarios,
    }, rows


@unittest.skipUnless(WEEK2_AVAILABLE, "Week 2 dependency lane only")
class OfficialClusteringFormatTests(unittest.TestCase):
    def materialize(self, root, seed, sizes=(30, 30, 30)):
        manifest, rows = synthetic_manifest(seed, sizes)
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        def synthetic_rows(_split, _revision, indexes):
            return ((index, rows[index]) for index in indexes)

        argv = [
            str(TOOL),
            "vision-clustering",
            str(manifest_path),
            str(root / "volume"),
            "--dataset-version",
            "synthetic-test",
        ]
        # Only the data source and cache location change. Manifest validation,
        # scenario expansion, CLI bounds and bundle writing are production code.
        with patch.object(datasets, "_huggingface_rows", synthetic_rows), patch.object(
            datasets, "user_cache_path", return_value=root / "cache"
        ), patch.object(sys, "argv", argv), contextlib.redirect_stdout(
            io.StringIO()
        ) as output:
            cases = datasets.clustering_scenarios(manifest)
            self.assertEqual(sum(case.scored for case in cases), len(sizes))
            materializer.main()
        self.assertEqual(
            output.getvalue().strip(),
            "Materialized {} scored clustering cases with {} images and {} stability repetitions.".format(
                len(sizes), sum(sizes), len(cases) - len(sizes)
            ),
        )
        target = root / "volume/vision-clustering/synthetic-test"
        return (
            cases,
            (target / "payload.zip").read_bytes(),
            json.loads((target / "expected.json").read_text(encoding="utf-8")),
        )

    def check_round_trip(self, seed, expanded_count):
        with tempfile.TemporaryDirectory() as directory:
            original, payload, gold = self.materialize(Path(directory), seed)
        self.assertEqual(len(original), expanded_count)
        self.assertEqual(sum(len(case.images) for case in original if case.scored), 90)
        self.assertEqual(len(gold), expanded_count)
        benchmark_id, decoded = decode_cases(payload)
        self.assertEqual(benchmark_id, "vision-clustering")
        self.assertTrue(all(case.expected_labels == [] for case in decoded))
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            metadata = json.loads(archive.read("metadata.json"))
            self.assertNotIn("expected.json", archive.namelist())
        self.assertNotIn("synthetic-identity", json.dumps(metadata))
        for source, case in zip(original, decoded):
            self.assertEqual(
                (case.seed, case.scored, case.scenario_key),
                (source.seed, source.scored, source.scenario_key),
            )
            for expected, actual in zip(source.images, case.images):
                np.testing.assert_array_equal(expected, actual)
        attached = attach_clustering_labels(decoded, gold)
        # The controller re-encodes official cases for the sandbox on every run.
        reencoded, plans = encode_cases(benchmark_id, attached)
        self.assertEqual(plans, [])
        _, sandbox_cases = decode_cases(reencoded)
        for source, case in zip(original, sandbox_cases):
            self.assertEqual(
                (case.seed, case.scored, case.scenario_key),
                (source.seed, source.scored, source.scenario_key),
            )
            self.assertEqual(case.expected_labels, [])
        self.assertEqual([case.expected_labels for case in attached], gold)

        # Deliberately poor repetition answers must change findings, not scores.
        outputs = [
            list(case.expected_labels) if case.scored else [0] * len(case.images)
            for case in attached
        ]
        scorer = ClusteringBenchmark()
        metrics = scorer.score(outputs, attached)
        self.assertTrue(scorer.last_diagnostics)
        baseline = ClusteringBenchmark().score(
            [output for output, case in zip(outputs, attached) if case.scored],
            [case for case in attached if case.scored],
        )
        for key, value in baseline.items():
            self.assertEqual(metrics[key], value)
        self.assertEqual(metrics["clustering_pairwise_f1"], 1.0)
        self.assertGreater(metrics["clustering_seed_spread"], 0.15)
        self.assertEqual(metrics, ClusteringBenchmark().score(outputs, original))

    def test_normal_seed_preserves_all_nine_unscored_repetitions(self):
        self.check_round_trip(42, 12)

    def test_base_seed_matching_stability_seed_is_scored_once(self):
        self.check_round_trip(datasets.STABILITY_SEEDS[0], 9)

    def test_base_bounds_are_not_satisfied_by_repetition_images(self):
        for sizes in [(10, 10, 10), (41, 40, 40), (45, 45)]:
            with self.subTest(sizes=sizes), tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(SystemExit, "three.*scored|scored.*three"):
                    self.materialize(Path(directory), 42, sizes)

    def test_legacy_clustering_records_default_to_scored_cases(self):
        image = io.BytesIO()
        np.save(image, np.zeros((2, 2, 3), dtype=np.uint8), allow_pickle=False)
        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr(
                "metadata.json",
                json.dumps(
                    {
                        "benchmark_id": "vision-clustering",
                        "cases": [{"images": [0], "seed": 42}],
                    }
                ),
            )
            archive.writestr("images/0000.npy", image.getvalue())
        _, cases = decode_cases(payload.getvalue())
        self.assertTrue(cases[0].scored)
        self.assertIsNone(cases[0].scenario_key)


if __name__ == "__main__":
    unittest.main()
