"""A packaged manifest edit that changes scoring must fail release checks.

The 2026-10-02 provenance audit edited only the labels in Week 2's packaged
public-evaluation.json. Practice pairwise F1 moved from 1.0 to 0.0 while the
release receipt and the submodule validator both still passed. This runs the
same edit through the real manifest walk, receipt, validator, cache check and
scorer on synthetic RGB rows, and requires the receipt and the validator to
refuse it.

Set COGPORTAL_WEEK2_RESOURCE_SOURCE to an initialized local Week 2 repository
(default: this checkout's submodule). The child process checks out the
parent's exact gitlink in its own temporary clone. It never downloads data or
changes the source repository. Isolation keeps the temporary benchmark imports
out of the surrounding test suite.
"""

from __future__ import annotations

import ast
import copy
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
BENCHMARK_ID = "vision-clustering"


def _function(name, **namespace):
    source = ROOT / "apps/runner-modal/src/cogworks_runner/modal_app.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    node = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
    node.returns = None
    for argument in node.args.args:
        argument.annotation = None
    isolated = ast.Module(body=[node], type_ignores=[])
    exec(compile(isolated, str(source), "exec"), namespace)
    return namespace[name]


def reproduce(source_repository):
    for path in (ROOT / "scripts", ROOT / "apps/runner-modal/tools",
                 ROOT / "python/cogbench/src", ROOT / "apps/runner-modal/src"):
        sys.path.insert(0, str(path))
    import numpy as np
    from cogworks_runner import prepared_environment as environment
    from cogworks_runner.protocol import validate_job
    import probe_prepared_environment as release

    gitlink = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD:benchmarks/week2"], text=True
    ).strip()
    with tempfile.TemporaryDirectory(prefix="resource-provenance-") as temporary:
        temporary = Path(temporary)
        checkout = temporary / "week2"
        subprocess.run(["git", "clone", "--local", "--shared", "--no-checkout",
                        str(source_repository), str(checkout)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(checkout), "checkout", "--detach", gitlink],
                       check=True, capture_output=True)
        sys.path.insert(0, str(checkout))
        from facial_recognition_benchmark import datasets
        from facial_recognition_benchmark.plugins import ClusteringBenchmark, RecognitionBenchmark
        from cogworks_runner.week2_payload import encode_cases
        assert Path(datasets.__file__).resolve().parent == (checkout / "facial_recognition_benchmark").resolve(), datasets.__file__
        package = Path(datasets.__file__).parent
        manifest_path = package / "manifests/public-evaluation.json"
        images = [np.full((2, 2, 3), index, dtype=np.uint8) for index in range(4)]
        samples = [{"sample_id": "synthetic-{}".format(index), "row_index": index,
                    "pixel_sha256": datasets.decoded_pixel_sha256(image),
                    "source_identity_sha256": datasets.source_identity_sha256(index // 2),
                    "width": 2, "height": 2} for index, image in enumerate(images)]
        manifest = {"schema_version": 1, "manifest_id": "synthetic-resource-v1",
                    "dataset": datasets.DATASET_NAME, "revision": datasets.DATASET_REVISION,
                    "split": "valid", "samples": samples, "recognition_scenarios": [],
                    "clustering_scenarios": [{"scenario_id": "synthetic", "seed": 42,
                                              "sample_ids": [row["sample_id"] for row in samples],
                                              "labels": [0, 0, 1, 1]}]}

        def write_manifest(value):
            manifest_path.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")

        def provider(_split, _revision, indices):
            for index in indices:
                yield index, {"image": images[index], "identity": index // 2}

        write_manifest(manifest)
        cache = temporary / "cache"
        cache_directory = datasets.materialize_manifest(manifest, cache, provider)
        benchmark = ClusteringBenchmark()

        class PixelClusterer:
            def __init__(self, _model):
                pass

            def cluster(self, values, *, seed):
                return [int(image[0, 0, 0]) // 2 for image in values]

        def score(cases):
            return benchmark.score(benchmark.run(PixelClusterer, None, cases), cases)

        accepted_python = release.source_manifest(package)
        platform = {key: {"root": root, "files": release.source_manifest(local),
                          "difference": release.compare_manifests([], [])}
                    for key, _module, local, root in release.PLATFORM_TREES}

        def receipt():
            output = io.StringIO()
            with mock.patch.object(sys, "argv", ["manifest.py", "facial_recognition_benchmark"]), redirect_stdout(output):
                exec(release.MANIFEST_SCRIPT, {})
            _observed_root, files = release.validate_manifest_payload(json.loads(output.getvalue()))
            assert files == release.source_manifest(package)
            manifests = copy.deepcopy(platform)
            manifests["benchmark"] = {"root": "/image/site-packages/facial_recognition_benchmark",
                                      "files": files,
                                      "difference": release.compare_manifests(accepted_python, files)}
            import cogbench.plugins
            with mock.patch.object(cogbench.plugins, "load_benchmark", return_value=benchmark):
                observation = environment.probe(BENCHMARK_ID)
            local_roots = [(local.resolve(), root) for _key, _module, local, root in release.PLATFORM_TREES]
            local_roots.append((package.resolve(), manifests["benchmark"]["root"]))
            for row in observation["modules"]:
                for local, remote in local_roots:
                    try:
                        relative = Path(row["path"]).relative_to(local)
                    except ValueError:
                        continue
                    row["path"] = remote + "/" + relative.as_posix()
                    break
                else:
                    raise AssertionError("Probe imported outside the explicit source trees: " + row["path"])
            return release.build_receipt(BENCHMARK_ID, 1, "im-Synthetic", observation, manifests)

        before_receipt = receipt()
        def practice_cases():
            with mock.patch.object(datasets, "user_cache_path", return_value=cache):
                return _function("_v2_cases")({"mode": "practice"}, benchmark)

        before_cases = practice_cases()
        before_score = score(before_cases)
        payload, _plans = encode_cases(BENCHMARK_ID, before_cases)
        hidden = temporary / "hidden" / BENCHMARK_ID / "celeba-official-v1"
        hidden.mkdir(parents=True)
        (hidden / "payload.zip").write_bytes(payload)
        (hidden / "expected.json").write_text(json.dumps([case.expected_labels for case in before_cases]))
        resource_before = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        drifted = copy.deepcopy(manifest)
        drifted["clustering_scenarios"][0]["labels"] = [0, 1, 0, 1]
        write_manifest(drifted)
        datasets.validate_manifest(datasets.load_manifest("evaluation"))
        assert datasets.cache_status(drifted, cache).ready
        after_score = score(practice_cases())
        try:
            receipt()
        except release.ProbeError as error:
            resource_refusal = str(error)
        else:
            raise AssertionError("Changed packaged labels were accepted by the receipt")

        job = {"protocolVersion": "1", "jobId": "synthetic", "runId": "synthetic",
               "mode": "official", "preparedArtifactId": "im-Snapshot", "weights": [],
               "source": {"repositoryId": 1, "fullName": "course/synthetic", "sha": "a" * 40,
                          "archiveUrl": "https://api.github.com/repos/course/synthetic/tarball/" + "a" * 40},
               "benchmark": {"id": BENCHMARK_ID, "version": benchmark.benchmark_version,
                             "contractVersion": benchmark.contract_version, "pluginVersion": benchmark.plugin_version,
                             "scorerVersion": benchmark.scorer_version, "datasetVersion": "celeba-official-v1",
                             "sandboxContract": 1}, "runtime": {}, "callback": {"url": "https://example.invalid"}}
        record = environment.bind_environment(job, before_receipt["observation"], "im-Snapshot", "im-Synthetic")
        job["preparedEnvironment"] = record
        validate_job(job)
        admission = environment.validate_prepared_environment(job, record)
        import cogbench.plugins
        with mock.patch.object(cogbench.plugins, "load_benchmark", return_value=benchmark):
            _function("_load_benchmark")(job)

        import validate_week2_submodule as version_validator
        with mock.patch.object(version_validator, "BENCHMARK", checkout), \
             mock.patch.object(version_validator, "load_plugin", side_effect=lambda _group, track:
                               ClusteringBenchmark() if track == BENCHMARK_ID else RecognitionBenchmark()):
            try:
                version_validator.main()
            except SystemExit as error:
                validator_refusal = str(error)
            else:
                raise AssertionError("The submodule validator accepted an edited tracked manifest")

        def hidden_path(path):
            return temporary / "hidden" if str(path) == "/hidden" else Path(path)

        official = _function("_v2_cases", Path=hidden_path, json=json)(job, benchmark)
        official_score = score(official)
        changed_identity = copy.deepcopy(drifted)
        changed_identity["samples"][0]["source_identity_sha256"] = "0" * 64
        try:
            datasets.materialize_manifest(changed_identity, temporary / "other-cache", provider)
        except datasets.DatasetError as error:
            identity_refusal = str(error)
        else:
            raise AssertionError("Changed source identity was accepted")
        np.save(cache_directory / "synthetic-0.npy", np.zeros_like(images[0]) + 99)
        pixel_refusal = datasets.cache_status(drifted, cache).message
        # Back to the accepted labels, so the next refusal is the driver's alone.
        write_manifest(manifest)
        assert receipt() == before_receipt
        driver = package / "drivers.py"
        driver.write_text(driver.read_text() + "\n# synthetic source drift\n")
        try:
            receipt()
        except release.ProbeError as error:
            python_refusal = str(error)
        else:
            raise AssertionError("Changed Python driver was accepted")
        return {"gitlink": gitlink, "imported_dataset": str(datasets.__file__),
                "versions": job["benchmark"], "observed_modules": record["modules"],
                "receipt_sha256": hashlib.sha256(json.dumps(before_receipt, sort_keys=True).encode()).hexdigest(),
                "before_score": before_score, "after_score": after_score,
                "official_score": official_score, "resource_refusal": resource_refusal,
                "admission": admission, "resource_before": resource_before,
                "resource_after": hashlib.sha256(json.dumps(drifted, sort_keys=True).encode()).hexdigest(),
                "validator_refusal": validator_refusal, "identity_refusal": identity_refusal,
                "pixel_refusal": pixel_refusal, "python_refusal": python_refusal,
                "observation_is_synthetic": True}


class ResourceProvenance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = os.environ.get("COGPORTAL_WEEK2_RESOURCE_SOURCE")
        if not source:
            source = str(ROOT / "benchmarks/week2")
        if not (Path(source) / ".git").exists():
            raise unittest.SkipTest("An initialized local Week 2 source is required")
        child = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--reproduce", source],
                               capture_output=True, text=True, timeout=60)
        if child.returncode:
            raise AssertionError(child.stderr)
        cls.result = json.loads(child.stdout)

    def test_a_scoring_resource_edit_fails_the_receipt_and_the_validator(self):
        # The edit is real: same images and identities, the score moves.
        self.assertNotEqual(self.result["resource_before"], self.result["resource_after"])
        self.assertEqual(self.result["before_score"]["clustering_pairwise_f1"], 1.0)
        self.assertEqual(self.result["after_score"]["clustering_pairwise_f1"], 0.0)
        self.assertIn("The benchmark package", self.result["resource_refusal"])
        self.assertIn("1 changed", self.result["resource_refusal"])
        self.assertIn("benchmarks/week2 differs from its reviewed commit", self.result["validator_refusal"])
        self.assertIn("manifests/public-evaluation.json", self.result["validator_refusal"])

    def test_materialized_official_bundle_does_not_read_public_manifest(self):
        self.assertEqual(self.result["official_score"], self.result["before_score"])

    def test_python_edits_and_wrong_row_identity_are_refused(self):
        self.assertIn("not the accepted source", self.result["python_refusal"])
        self.assertIn("identity does not match", self.result["identity_refusal"])

    def test_corrupt_cached_pixels_are_refused(self):
        self.assertIn("checksum failed", self.result["pixel_refusal"])


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--reproduce":
        print(json.dumps(reproduce(Path(sys.argv[2])), sort_keys=True))
    else:
        unittest.main()
