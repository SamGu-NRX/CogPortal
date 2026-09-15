"""Decoder/driver contract goldens and controller evidence validation.

The wire fixtures below are built independently of the current encoders, so a
matching encoder/decoder edit cannot silently redefine an existing contract.
They cover small deterministic input/output examples, not model quality, the
full corpus, scorer semantics, or integrity after student installation.
"""

from __future__ import annotations

import ast
import copy
import hashlib
import importlib
import importlib.util
import inspect
import io
import json
import os
import platform
import sqlite3
import subprocess
import sys
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
RUNNER_SRC = ROOT / "apps" / "runner-modal" / "src"
sys.path.insert(0, str(RUNNER_SRC))

from cogworks_runner import prepared_environment as env


def require_benchmark(benchmark_id):
    """Skip only absent import dependencies, never an error from the probe.

    CI runs this suite with no plugin or one track installed. Check top-level
    specs before imports so a missing SDK symbol, broken module, or failed
    contract assertion cannot be mistaken for an optional dependency.
    """
    packages = {
        "audio-identification": ("audio_identification_benchmark",),
        "vision-recognition": ("facial_recognition_benchmark", "PIL"),
        "vision-clustering": ("facial_recognition_benchmark", "PIL"),
        "language-search": ("language_search_benchmark",),
    }
    require_packages("cogbench", "numpy", *packages[benchmark_id])


def require_packages(*names):
    missing = [name for name in names if importlib.util.find_spec(name) is None]
    if missing:
        raise unittest.SkipTest("Optional test dependencies are absent: " + ", ".join(missing))


def job(benchmark_id="language-search"):
    return {
        "preparedArtifactId": "im-snapshot",
        "benchmark": {"id": benchmark_id, "sandboxContract": env.SANDBOX_CONTRACTS[benchmark_id],
                      "benchmarkVersion": 3, "scorerVersion": "new-controller"},
        "source": {"repositoryId": 42, "fullName": "course/team", "sha": "a" * 40,
                   "archiveUrl": "https://api.github.com/repos/course/team/tarball/" + "a" * 40},
        "weights": [{"path": "model/weights.npz", "sha256": "b" * 64, "size": 12}],
    }


def observation(benchmark_id="language-search"):
    return {"sandboxContract": env.SANDBOX_CONTRACTS[benchmark_id], "pythonVersion": "3.8.20", "sdkVersion": "0.2.0",
            "modules": [{"name": "cogbench", "path": "/opt/cogbench/cogbench/__init__.py",
                         "sha256": "c" * 64}]}


def evidence(benchmark_id="language-search"):
    return env.bind_environment(job(benchmark_id), observation(benchmark_id), "im-snapshot", "im-base")


def payload(metadata, arrays=None):
    import numpy as np

    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as archive:
        archive.writestr("metadata.json", json.dumps(metadata))
        for name, array in (arrays or {}).items():
            stream = io.BytesIO()
            np.save(stream, array, allow_pickle=False)
            archive.writestr(name, stream.getvalue())
    return result.getvalue()


class DependencyGateTest(unittest.TestCase):
    def test_absent_package_is_named_in_skip(self):
        with mock.patch.object(importlib.util, "find_spec", side_effect=lambda name: None if name == "numpy" else object()):
            with self.assertRaisesRegex(unittest.SkipTest, "dependencies are absent: numpy"):
                require_benchmark("language-search")

    def test_broken_dependency_discovery_is_not_a_skip(self):
        with mock.patch.object(importlib.util, "find_spec", side_effect=ImportError("broken installation")):
            with self.assertRaisesRegex(ImportError, "broken installation"):
                require_benchmark("language-search")

    def test_probe_contract_defect_is_not_a_skip_when_dependencies_exist(self):
        with mock.patch.object(importlib.util, "find_spec", return_value=object()):
            with mock.patch.dict(sys.modules, {"cogbench": mock.Mock()}):
                with mock.patch.object(env, "probe", side_effect=env.PreparedEnvironmentError("real contract defect")):
                    with self.assertRaisesRegex(env.PreparedEnvironmentError, "real contract defect"):
                        ProbeTest().check_paths_and_hashes("language-search")


class EvidenceTest(unittest.TestCase):
    def test_only_language_advances_from_the_pr8_baseline(self):
        self.assertEqual(env.SANDBOX_CONTRACTS, {
            "audio-identification": 1, "vision-recognition": 1,
            "vision-clustering": 1, "language-search": 2,
        })

    def test_language_migration_advances_all_language_rows_only(self):
        migrations = ROOT / "apps/portal/migrations"
        with sqlite3.connect(":memory:") as database:
            database.executescript("CREATE TABLE runs (id TEXT); CREATE TABLE benchmarks (id TEXT, version INTEGER);")
            rows = [("language-search", 1), ("language-search", 3),
                    ("audio-identification", 1), ("vision-recognition", 2),
                    ("vision-clustering", 1), ("future-track", 1)]
            database.executemany("INSERT INTO benchmarks VALUES (?, ?)", rows)
            database.executescript((migrations / "0042_prepared_environment.sql").read_text())
            baseline = database.execute("SELECT id, version, sandbox_contract FROM benchmarks ORDER BY id, version").fetchall()
            self.assertEqual([row[2] for row in baseline if row[0] == "language-search"], [1, 1])
            database.executescript((migrations / "0043_language_sandbox_contract.sql").read_text())
            updated = database.execute("SELECT id, version, sandbox_contract FROM benchmarks ORDER BY id, version").fetchall()
            self.assertEqual(updated, [(name, version, 2 if name == "language-search" else contract)
                                       for name, version, contract in baseline])

    def test_binding_uses_only_source_identity_and_requested_digests(self):
        result = evidence()
        self.assertEqual(result["source"], {
            "repositoryId": 42, "fullName": "course/team", "sha": "a" * 40,
        })
        self.assertEqual(result["weights"], [{"path": "model/weights.npz", "sha256": "b" * 64}])
        self.assertIsNone(env.validate_prepared_environment(job(), result))

    def test_binding_copies_the_retained_pre_student_observation(self):
        request, observed = job(), observation()
        result = env.bind_environment(request, observed, "im-snapshot", "im-base")
        observed["modules"][0]["sha256"] = "d" * 64
        observed["modules"].append({})
        request["source"]["sha"] = "e" * 40
        request["weights"][0]["path"] = "changed.npz"
        self.assertEqual(result, evidence())
        result["modules"][0]["name"] = "changed"
        self.assertEqual(observed["modules"][0]["name"], "cogbench")

    def test_reuse_omits_weights_without_erasing_original_evidence(self):
        for mode in ("absent", "empty"):
            request = job()
            if mode == "absent":
                del request["weights"]
            else:
                request["weights"] = []
            result = evidence()
            before = copy.deepcopy(result)
            self.assertIsNone(env.validate_prepared_environment(request, result))
            self.assertEqual(result, before)
            self.assertEqual(len(result["weights"]), 1)

    def test_new_binding_requires_explicit_weights_even_when_empty(self):
        request = job()
        del request["weights"]
        with self.assertRaisesRegex(env.PreparedEnvironmentError, "does not match"):
            env.bind_environment(request, observation(), "im-snapshot", "im-base")
        request["weights"] = []
        self.assertEqual(env.bind_environment(request, observation(), "im-snapshot", "im-base")["weights"], [])

    def test_unknown_incompatible_and_binding_mismatch_are_distinct(self):
        self.assertEqual(env.validate_prepared_environment(job(), None), env.UNKNOWN)
        for requirement in (None, True, 0, "1"):
            request = job()
            request["benchmark"]["sandboxContract"] = requirement
            self.assertEqual(env.validate_prepared_environment(request, evidence()), env.UNKNOWN)
        request = job()
        request["benchmark"]["id"] = "unknown-track"
        self.assertEqual(env.validate_prepared_environment(request, evidence()), env.UNKNOWN)
        for change_job in (True, False):
            request, result = job(), evidence()
            if change_job:
                request["benchmark"]["sandboxContract"] = 999
            else:
                result["sandboxContract"] = 999
            self.assertEqual(env.validate_prepared_environment(request, result), env.INCOMPATIBLE)
        for key, value in (("artifactId", "im-other"), ("benchmarkId", "vision-clustering")):
            result = evidence()
            result[key] = value
            self.assertEqual(env.validate_prepared_environment(job(), result), env.BINDING_MISMATCH)
        for key, value in (("repositoryId", 43), ("fullName", "course/other"), ("sha", "d" * 40)):
            result = evidence()
            result["source"][key] = value
            self.assertEqual(env.validate_prepared_environment(job(), result), env.BINDING_MISMATCH)
        for key, value in (("path", "other.npz"), ("sha256", "d" * 64)):
            result = evidence()
            result["weights"][0][key] = value
            self.assertEqual(env.validate_prepared_environment(job(), result), env.BINDING_MISMATCH)

    def test_matching_remote_markers_cannot_override_local_catalog_contract(self):
        request, result = job(), evidence()
        request["benchmark"]["sandboxContract"] = result["sandboxContract"] = 999
        self.assertEqual(env.validate_prepared_environment(request, result), env.INCOMPATIBLE)

    def test_versions_hashes_paths_and_base_images_are_not_eligibility(self):
        result = evidence()
        result.update(sdkVersion="different-release", baseImageId="im-old-base")
        result["modules"][0].update(path="/different/install/cogbench.py", sha256="d" * 64)
        self.assertIsNone(env.validate_prepared_environment(job(), result))
        request = job()
        request["benchmark"].update(benchmarkVersion=999, scorerVersion="another-scorer")
        self.assertIsNone(env.validate_prepared_environment(request, result))
        result["sandboxContract"] = 999
        self.assertEqual(env.validate_prepared_environment(request, result), env.INCOMPATIBLE)

    def test_python38_requirement_is_only_for_audio_and_language(self):
        for benchmark_id in env.SANDBOX_CONTRACTS:
            request = job(benchmark_id)
            for version in ("3.7.17", "3.8.19", "3.8.20", "3.8.21", "3.9.20", "3.11.15", "3.80.1", "3.8", "3.8.invalid"):
                observed, result = observation(benchmark_id), evidence(benchmark_id)
                observed["pythonVersion"] = result["pythonVersion"] = version
                accepted = benchmark_id.startswith("vision-") or version in ("3.8.19", "3.8.20", "3.8.21")
                with self.subTest(benchmark=benchmark_id, version=version):
                    if accepted:
                        env.validate_observation(request, observed)
                        self.assertIsNone(env.validate_prepared_environment(request, result))
                    else:
                        with self.assertRaisesRegex(env.PreparedEnvironmentError, "Python 3.8 requirement"):
                            env.validate_observation(request, observed)
                        self.assertEqual(env.validate_prepared_environment(request, result), env.INCOMPATIBLE_PYTHON)

    def test_validation_does_not_lookup_provider_images(self):
        request, result = job(), evidence()
        request["preparedArtifactId"] = result["artifactId"] = "im-no-longer-exists"
        self.assertIsNone(env.validate_prepared_environment(request, result))

    def test_nullable_repository_id_is_bound_exactly(self):
        request = job()
        request["source"]["repositoryId"] = None
        result = env.bind_environment(request, observation(), "im-snapshot", "im-base")
        self.assertIsNone(env.validate_prepared_environment(request, result))
        self.assertEqual(env.validate_prepared_environment(job(), result), env.BINDING_MISMATCH)

    def test_observation_failure_messages_do_not_echo_input(self):
        with self.assertRaisesRegex(env.PreparedEnvironmentError, "observation has an invalid schema"):
            env.validate_observation(job(), "student stdout SECRET")
        observed = observation()
        observed["sandboxContract"] = 999
        with self.assertRaisesRegex(env.PreparedEnvironmentError, "incompatible"):
            env.validate_observation(job(), observed)
        observed = observation()
        observed["sdkVersion"] = "unrelated-version"
        env.validate_observation(job(), observed)

    def test_shape_validation_is_separate_from_compatibility(self):
        result = evidence()
        result["sandboxContract"] = 42
        result["benchmarkId"] = "future-benchmark"
        env.validate_record_shape(result)
        for field in result:
            malformed = copy.deepcopy(result)
            del malformed[field]
            with self.subTest(missing=field), self.assertRaises(env.PreparedEnvironmentError):
                env.validate_record_shape(malformed)
        for field, value in (
            ("schemaVersion", True), ("schemaVersion", 2), ("artifactId", ""),
            ("baseImageId", "x" * 201), ("benchmarkId", "x" * 121),
            ("sandboxContract", True), ("sandboxContract", 0),
            ("pythonVersion", "x" * 81), ("sdkVersion", None),
            ("modules", []), ("modules", [{}]), ("modules", observation()["modules"] * 33),
            ("weights", evidence()["weights"] * 9), ("source", []),
        ):
            malformed = evidence()
            malformed[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(env.PreparedEnvironmentError):
                env.validate_record_shape(malformed)
            self.assertEqual(env.validate_prepared_environment(job(), malformed), env.INVALID)
        for location in ((), ("source",), ("modules", 0), ("weights", 0)):
            malformed = evidence()
            target = malformed
            for key in location:
                target = target[key]
            target["extra"] = "not part of schema 1"
            with self.assertRaises(env.PreparedEnvironmentError):
                env.validate_record_shape(malformed)

    def test_nested_digests_and_source_types_are_strict(self):
        for field, value in (("repositoryId", True), ("repositoryId", 0),
                             ("fullName", "owner/repo/extra"), ("fullName", "owner /repo"),
                             ("sha", "A" * 40)):
            result = evidence()
            result["source"][field] = value
            with self.assertRaises(env.PreparedEnvironmentError):
                env.validate_record_shape(result)
        for field in ("modules", "weights"):
            result = evidence()
            result[field][0]["sha256"] = "g" * 64
            with self.assertRaises(env.PreparedEnvironmentError):
                env.validate_record_shape(result)


class ProbeTest(unittest.TestCase):
    def check_paths_and_hashes(self, benchmark_id):
        require_benchmark(benchmark_id)
        import cogbench

        observed = env.probe(benchmark_id)
        self.assertEqual(observed["sandboxContract"], env.SANDBOX_CONTRACTS[benchmark_id])
        self.assertEqual(observed["pythonVersion"], platform.python_version())
        self.assertEqual(observed["sdkVersion"], cogbench.__version__)
        names = {row["name"] for row in observed["modules"]}
        self.assertIn("cogbench", names)
        self.assertIn("cogbench.plugins", names)
        self.assertIn("cogbench.discover", names)
        self.assertIn("cogbench.resolve", names)
        request = job(benchmark_id)
        if benchmark_id in ("audio-identification", "language-search") and sys.version_info[:2] != (3, 8):
            with self.assertRaisesRegex(env.PreparedEnvironmentError, "Python 3.8 requirement"):
                env.validate_observation(request, observed)
        else:
            env.validate_observation(request, observed)
        self.assertTrue(any(name.endswith(".drivers") for name in names))
        self.assertTrue(any(name.startswith("cogworks_runner.week") for name in names))
        for row in observed["modules"]:
            module = importlib.import_module(row["name"])
            expected = Path(inspect.getsourcefile(module)).resolve()
            self.assertEqual(row["path"], str(expected))
            self.assertEqual(row["sha256"], hashlib.sha256(expected.read_bytes()).hexdigest())

    def test_audio_paths_and_hashes(self):
        self.check_paths_and_hashes("audio-identification")

    def test_recognition_paths_and_hashes(self):
        self.check_paths_and_hashes("vision-recognition")

    def test_clustering_paths_and_hashes(self):
        self.check_paths_and_hashes("vision-clustering")

    def test_language_paths_and_hashes(self):
        self.check_paths_and_hashes("language-search")

    def test_probe_rejects_missing_or_noncallable_evaluator_sdk_apis(self):
        require_packages("cogbench")
        # Patch actual imported SDK objects, not fabricated compatibility labels.
        # These checks establish API presence, not signatures or full behavior.
        required = (
            ("cogbench.plugins", "load_benchmark"),
            ("cogbench.plugins", "load_submission"),
            ("cogbench.resolve", "from_spec"),
            ("cogbench.discover", "_Redirects"),
            ("cogbench.discover", "_Redirects.enter"),
            ("cogbench.discover", "_Redirects.leave"),
            ("cogbench.discover", "_Redirects.__enter__"),
            ("cogbench.discover", "_Redirects.__exit__"),
        )
        for name, dotted_attribute in required:
            owner = importlib.import_module(name)
            parts = dotted_attribute.split(".")
            for part in parts[:-1]:
                owner = getattr(owner, part)
            self.assertTrue(callable(getattr(owner, parts[-1])))
            for missing in (False, True):
                with self.subTest(module=name, attribute=dotted_attribute, missing=missing):
                    with mock.patch.object(owner, parts[-1], "obsolete-api"):
                        if missing:
                            delattr(owner, parts[-1])
                        with self.assertRaises(env.PreparedEnvironmentError) as raised:
                            env.probe("language-search")
                        self.assertEqual(str(raised.exception), "Prepared environment SDK lacks required evaluation APIs.")

    def test_actual_import_failure_has_a_fixed_message(self):
        with mock.patch.object(env.importlib, "import_module", side_effect=ImportError("SECRET path")):
            with self.assertRaises(env.PreparedEnvironmentError) as raised:
                env.probe("language-search")
        self.assertEqual(str(raised.exception), "Prepared environment platform imports could not be observed.")

    def check_cli(self, benchmark_id):
        require_benchmark(benchmark_id)
        # Payload suites also expose source packages via sys.path. The child
        # must observe the same import roots rather than require an extra install.
        child_env = dict(os.environ, PYTHONPATH=os.pathsep.join(sys.path), PYTHONDONTWRITEBYTECODE="1")
        command = [sys.executable, "-m", "cogworks_runner.prepared_environment", benchmark_id]
        result = subprocess.run(command, env=child_env, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), env.probe(benchmark_id))
        check = subprocess.run([
            sys.executable, "-c",
            "import sys; from cogworks_runner.prepared_environment import probe; "
            "probe(sys.argv[1]); assert 'cogworks_runner.modal_app' not in sys.modules; "
            "assert 'modal' not in sys.modules", benchmark_id,
        ], env=child_env, capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_audio_cli(self):
        self.check_cli("audio-identification")

    def test_recognition_cli(self):
        self.check_cli("vision-recognition")

    def test_clustering_cli(self):
        self.check_cli("vision-clustering")

    def test_language_cli(self):
        self.check_cli("language-search")

    def test_unknown_cli_benchmark_fails_without_optional_dependencies(self):
        child_env = dict(os.environ, PYTHONPATH=str(RUNNER_SRC), PYTHONDONTWRITEBYTECODE="1")
        bad = subprocess.run([
            sys.executable, "-m", "cogworks_runner.prepared_environment", "unsupported",
        ], env=child_env, capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1)
        self.assertEqual(bad.stdout, "")
        self.assertEqual(bad.stderr.strip(), env.UNKNOWN)

    def test_new_module_and_tests_parse_as_python38(self):
        for path in (Path(env.__file__), Path(__file__)):
            ast.parse(path.read_text(), feature_version=(3, 8))


class DecoderDriverGoldenTest(unittest.TestCase):
    def test_audio_contract1_renders_pinned_signal_and_serializes_ranked_candidates(self):
        require_benchmark("audio-identification")
        import numpy as np
        from audio_identification_benchmark.adapters import adapt_identifier
        from audio_identification_benchmark.drivers import run_with_adapter
        from audio_identification_benchmark.synth import SynthError
        from cogworks_runner.week1_payload import decode_payload

        # First song and clean query from the shipped Week 1 test manifest.
        # The digest is fixed here, not recomputed from the current synthesizer.
        salt = "week1-test-v1:20260817"
        token = "src-" + hashlib.sha256((salt + ":song-00").encode()).hexdigest()[:16]
        pinned = "bfae612593acc391462439aa7df95ec63db88a3b4977e635b4f3ae4f395207e3"
        metadata = {
            "benchmark_id": "audio-identification", "showcase": False,
            "corpus_version": "synth-v1", "sample_rate": 44100, "salt": salt,
            "songs": [{"song_id": "song-00", "seed": 1384103405,
                       "duration_seconds": 12.0, "sha256": pinned}],
            "out_of_set_songs": [],
            "queries": [{"query_id": "q0000", "source_token": token, "clip_seconds": 6.0,
                         "offset_seconds": 2.5936, "pitch_semitones": 0.0,
                         "snr_db": None, "noise_seed": 1967396751}],
        }
        benchmark_id, showcase, cases = decode_payload(payload(metadata))
        self.assertEqual((benchmark_id, showcase, len(cases)), ("audio-identification", False, 2))
        self.assertEqual(hashlib.sha256(cases[0].samples.tobytes()).hexdigest(), pinned)
        self.assertEqual(cases[0].samples.dtype, np.float32)
        self.assertIsNone(cases[1].gold_song_id)
        self.assertEqual(cases[1].source_song_id, token)
        self.assertEqual(cases[1].samples.shape, (264600,))
        seen = []

        class Adapter:
            def enroll(self, song_id, samples, sample_rate):
                seen.append((song_id, sample_rate, len(samples)))

            def identify(self, samples, sample_rate):
                return [("song-00", 4.0)]

        outputs = run_with_adapter(adapt_identifier(Adapter()), cases, 44100)
        self.assertEqual(seen, [("song-00", 44100, 529200)])
        self.assertEqual([(row["ok"], row["kind"]) for row in outputs], [(True, "enroll"), (True, "query")])
        self.assertEqual(outputs[1]["query_id"], "q0000")
        self.assertEqual(outputs[1]["candidates"], ["song-00"])
        self.assertEqual(outputs[1]["scores"], [4.0])
        metadata["songs"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(SynthError, "does not match the manifest"):
            decode_payload(payload(metadata))

    def test_vision_recognition_contract1_preserves_two_batch_lifecycle(self):
        require_benchmark("vision-recognition")
        import numpy as np
        from facial_recognition_benchmark.drivers import run_recognition_scenario
        from cogworks_runner.week2_payload import decode_cases

        # Same pixel-identity adapter as the benchmark driver's class-based
        # fixture, with explicit flat hosted batches instead of local gold.
        arrays = {"images/{:04d}.npy".format(i): np.full((2, 2, 3), v, dtype=np.uint8)
                  for i, v in enumerate([1, 2, 1, 2, 2, 1])}
        wire = payload({"benchmark_id": "vision-recognition", "cases": [{
            "known": [{"person_id": "known", "enrollment": [0]}],
            "unknown_person_id": "new", "unknown_enrollment": [1],
            "queries_before_enrollment": [2, 3], "queries_after_enrollment": [4, 5],
        }]}, arrays)
        benchmark_id, cases = decode_cases(wire)
        self.assertEqual((benchmark_id, len(cases)), ("vision-recognition", 1))
        self.assertEqual(cases[0].known[0].queries, [])
        self.assertEqual(cases[0].unknown_queries, [])
        self.assertEqual(cases[0].post_enrollment_queries, [])
        calls = []

        class Adapter:
            def __init__(self, model):
                self.database = {}
                calls.append("factory")

            def enroll(self, person_id, images):
                calls.append(("enroll", person_id))
                self.database[int(images[0][0, 0, 0])] = person_id

            def recognize(self, images):
                calls.append(("recognize", len(images)))
                return [self.database.get(int(image[0, 0, 0])) for image in images]

        self.assertEqual(run_recognition_scenario(Adapter, object(), cases[0]), {
            "before_enrollment": ["known", None], "after_enrollment": ["new", "known"],
        })
        self.assertEqual(calls, ["factory", ("enroll", "known"), ("recognize", 2),
                                 ("enroll", "new"), ("recognize", 2)])

    def test_vision_clustering_contract1_forwards_seed_without_gold(self):
        require_benchmark("vision-clustering")
        import numpy as np
        from facial_recognition_benchmark.adapters import AdapterContractError
        from facial_recognition_benchmark.drivers import run_clustering_scenario
        from cogworks_runner.week2_payload import decode_cases

        arrays = {"images/{:04d}.npy".format(i): np.full((2, 2, 3), i, dtype=np.uint8)
                  for i in range(3)}
        wire = payload({"benchmark_id": "vision-clustering", "cases": [
            # Contract 1 does not carry these controller-only fields through
            # decoding. Preserving them later requires a new contract fixture.
            {"images": [0, 1, 2], "seed": 7, "scored": False, "scenario_key": "sweep"},
        ]}, arrays)
        benchmark_id, cases = decode_cases(wire)
        self.assertEqual((benchmark_id, len(cases)), ("vision-clustering", 1))
        self.assertEqual(cases[0].expected_labels, [])
        self.assertEqual(cases[0].seed, 7)
        self.assertTrue(cases[0].scored)
        self.assertIsNone(cases[0].scenario_key)
        seen = []

        class Adapter:
            def cluster(self, images, *, seed):
                seen.append((seed, [int(image[0, 0, 0]) for image in images]))
                return [np.int64(9), np.int64(9), "other"]

        self.assertEqual(run_clustering_scenario(lambda model: Adapter(), object(), cases[0]), [9, 9, "other"])
        self.assertEqual(seen, [(7, [0, 1, 2])])

        class Broken:
            def cluster(self, images, *, seed):
                return [0]

        with self.assertRaisesRegex(AdapterContractError, "returned 1 labels for 3 images"):
            run_clustering_scenario(lambda model: Broken(), object(), cases[0])

    def test_language_contract2_has_nine_cases_and_component_shared_preparation(self):
        require_benchmark("language-search")
        import numpy as np
        from language_search_benchmark.drivers import run_cases
        from cogworks_runner.week3_payload import decode_payload

        queries = ["A man riding a horse", "Two cats on a bed"]
        wire = payload({
            "benchmark_id": "language-search", "showcase": True, "tie_break_seed": 7,
            "text_captions": queries, "queries": queries, "pool_image_ids": [10, 20], "search_k": 2,
        }, {"descriptors.npy": np.eye(2, 8, dtype=np.float32)})
        benchmark_id, showcase, cases = decode_payload(wire)
        self.assertEqual((benchmark_id, showcase), ("language-search", True))
        self.assertEqual([(case.kind, getattr(case, "rung", "verbatim")) for case in cases], [
            ("text", "verbatim"), ("retrieval", "verbatim"), ("search", "verbatim"),
            ("retrieval", "keywords"), ("retrieval", "truncated"), ("retrieval", "typo"),
            ("search", "keywords"), ("search", "truncated"), ("search", "typo"),
        ])
        self.assertIsNone(cases[0].group_rows)
        retrievals = [case for case in cases if case.kind == "retrieval"]
        searches = [case for case in cases if case.kind == "search"]
        expected_queries = [
            ("verbatim", queries), ("keywords", ["man riding horse", "Two cats bed"]),
            ("truncated", ["man riding horse", "Two cats bed"]),
            ("typo", ["A man ruding a horse", "Two cars on a bed"]),
        ]
        for component in (retrievals, searches):
            self.assertEqual([(case.rung, case.queries) for case in component], expected_queries)
            for case in component:
                self.assertIs(case.descriptors, component[0].descriptors)
        for case in retrievals:
            self.assertIsNone(case.gold_rows)
        for case in searches:
            self.assertIsNone(case.gold_image_ids)
            self.assertIs(case.image_ids, searches[0].image_ids)
        self.assertFalse(np.shares_memory(retrievals[0].descriptors, searches[0].descriptors))
        np.testing.assert_array_equal(retrievals[0].descriptors, searches[0].descriptors)
        calls = []

        class Adapter:
            def embed_text(self, texts):
                return np.tile([3.0, 4.0] + [0.0] * 6, (len(texts), 1))

            def embed_images(self, descriptors):
                return descriptors

            def prepare_database(self, image_ids, descriptors):
                calls.append(list(image_ids))
                # A mutable search index must not alter later retrieval rungs.
                descriptors[:] = 9.0

            def search(self, query, k):
                return [20, 10][:k]

        outputs = run_cases(lambda resources: Adapter(), object(), cases)
        self.assertEqual(calls, [[10, 20]])
        self.assertEqual(len(outputs), 9)
        for row in outputs:
            self.assertTrue(row["ok"], row)
        np.testing.assert_allclose(outputs[0]["embeddings"], [[0.6, 0.8] + [0.0] * 6] * 2, atol=1e-6)
        for case, output in zip(cases[1:], outputs[1:]):
            if case.kind == "retrieval":
                np.testing.assert_allclose(output["text"], [[0.6, 0.8] + [0.0] * 6] * 2, atol=1e-6)
                self.assertEqual(output["images"], np.eye(2, 8).tolist())
            else:
                self.assertEqual(output, {"ok": True, "kind": "search", "rankings": [[20, 10], [20, 10]]})


if __name__ == "__main__":
    unittest.main()
