"""Exercise official clustering bundles with synthetic RGB rows, never CelebA."""

import contextlib
import importlib.util
import io
import json
import subprocess
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

sys.path.insert(0, str(Path(__file__).parent))
from test_prepared_environment import require_benchmark

# Bound only for this module's own test bodies, which the class decorator
# already skips when Week 2 is absent. Anything reusable reads
# week2_fixture_modules() instead, so it answers for the call and not for the
# instant this module happened to be imported.
if WEEK2_AVAILABLE:
    import numpy as np
    from cogworks_runner.week2_payload import (
        attach_clustering_labels,
        decode_cases,
        encode_cases,
    )
    from facial_recognition_benchmark import datasets
    from facial_recognition_benchmark.plugins import ClusteringBenchmark


def week2_fixture_modules():
    """Check dependencies when a shared fixture is called.

    Other tests can add Week 2 to sys.path after this module was imported.
    Reusable fixtures cannot rely on globals initialized only at import time.
    """
    require_benchmark("vision-clustering")
    import numpy as np
    from facial_recognition_benchmark import datasets

    tool = Path(__file__).resolve().parents[1] / "tools/materialize_week2_official.py"
    spec = importlib.util.spec_from_file_location("materialize_week2_official", tool)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return np, datasets, module, tool


def synthetic_manifest(seed, sizes=(30, 30, 30)):
    np, datasets, _, _ = week2_fixture_modules()
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


def materialize_official_bundle(root, seed, sizes=(30, 30, 30)):
    """Return expanded cases, payload, gold and CLI output from synthetic rows."""
    _, datasets, materializer, tool = week2_fixture_modules()
    manifest, rows = synthetic_manifest(seed, sizes)
    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def synthetic_rows(_split, _revision, indexes):
        return ((index, rows[index]) for index in indexes)

    argv = [
        str(tool),
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
        materializer.main()
    target = root / "volume/vision-clustering/synthetic-test"
    return (
        cases,
        (target / "payload.zip").read_bytes(),
        json.loads((target / "expected.json").read_text(encoding="utf-8")),
        output.getvalue().strip(),
    )


# A fresh interpreter reproduces import before dependency availability.
# The finder also blocks editable installs, which sys.path changes alone do not.
_LATE_ARRIVAL_PROGRAM = """
import sys, unittest

class Absent:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] == "facial_recognition_benchmark":
            raise ModuleNotFoundError(name)
        return None

absent = Absent()
sys.meta_path.insert(0, absent)
sys.path.insert(0, {tests!r})
sys.path.insert(0, {runner!r})
import test_week2_official_format as fixture
assert not fixture.WEEK2_AVAILABLE, "Week 2 was reachable at import; the case did not arise"
sys.meta_path.remove(absent)
try:
    fixture.synthetic_manifest(42)
except unittest.SkipTest as skip:
    print("SKIPPED:" + str(skip))
else:
    print("RETURNED")
"""


class FixtureDependencyTests(unittest.TestCase):
    def test_source_arriving_after_import_does_not_raise_name_error(self):
        program = _LATE_ARRIVAL_PROGRAM.format(
            tests=str(Path(__file__).parent),
            runner=str(Path(__file__).resolve().parents[1] / "src"),
        )
        result = subprocess.run(
            [sys.executable, "-c", program], capture_output=True, universal_newlines=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # The failure this replaces: import-time globals read at call time.
        self.assertNotIn("NameError", result.stderr)
        outcome = result.stdout.strip()
        if WEEK2_AVAILABLE:
            # Reachable again by the time the fixture ran, so it must work
            # rather than skip on a stale answer from before the finder moved.
            self.assertEqual(outcome, "RETURNED")
        else:
            self.assertTrue(outcome.startswith("SKIPPED:"), outcome)

    @unittest.skipUnless(WEEK2_AVAILABLE, "Week 2 dependency lane only")
    def test_installed_lane_materializes_through_the_shared_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            cases, payload, gold, announced = materialize_official_bundle(Path(directory), 42)
        self.assertEqual((sum(case.scored for case in cases), len(cases)), (3, 12))
        self.assertEqual(len(gold), len(cases))
        self.assertTrue(payload)
        self.assertIn("3 scored clustering cases", announced)


@unittest.skipUnless(WEEK2_AVAILABLE, "Week 2 dependency lane only")
class OfficialClusteringFormatTests(unittest.TestCase):
    def materialize(self, root, seed, sizes=(30, 30, 30)):
        cases, payload, gold, announced = materialize_official_bundle(root, seed, sizes)
        self.assertEqual(sum(case.scored for case in cases), len(sizes))
        self.assertEqual(
            announced,
            "Materialized {} scored clustering cases with {} images and {} stability repetitions.".format(
                len(sizes), sum(sizes), len(cases) - len(sizes)
            ),
        )
        return cases, payload, gold

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
