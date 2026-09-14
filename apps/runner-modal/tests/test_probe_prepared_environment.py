"""The release probe has to refuse for the right reasons.

It answers one question before a student reaches an image: can this exact build
host an evaluation? Every way of answering that wrongly is worse than not
asking, so these are mostly refusals.

Four carry the weight. A published image *name* must be rejected, because a
name answers for whatever it points at when the probe runs. The required
sandbox contract must come from outside, or the image is compared with itself.
An import that resolves outside the checked roots, or to a different hash than
the manifest reports, must be rejected, because a path that exists is not proof
of what got loaded. And a receipt must never be overwritten.

Nothing here touches Modal. `observe_image` is the only function that imports
it, and it is replaced with a recorder wherever ordering is under test.
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "tools"))
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))

# The private 3.8 requirement, imported deliberately: one test exists to pin
# that the interpreter choice is derived from it and not listed beside it.
from cogworks_runner.prepared_environment import _REQUIRED_PYTHON as REQUIRED_PYTHON  # noqa: E402
import probe_prepared_environment as probe_module  # noqa: E402
from probe_prepared_environment import (  # noqa: E402
    PLATFORM_TREES,
    PY38_VENV,
    SANDBOX_CONTRACTS,
    ProbeError,
    benchmark_source,
    bind_modules_to_manifests,
    build_receipt,
    compare_manifests,
    expected_trees,
    load_json,
    main,
    probe_image,
    reserve_receipt,
    source_manifest,
    student_python,
    validate_manifest_payload,
    validate_probe_inputs,
    write_receipt,
)

IMAGE_ID = "im-Tpq3fjbNvymPQUJ7SWkCYp"
BENCHMARK = "audio-identification"
SITE_PACKAGES = "/usr/local/lib/python3.8/site-packages/audio_identification_benchmark"


def _roots(benchmark_id=BENCHMARK):
    """Resolved import root per key, as a passing image would report them."""

    resolved = {}
    for key, _module, _local, expected_root in expected_trees(benchmark_id):
        resolved[key] = expected_root if expected_root is not None else SITE_PACKAGES
    return resolved


def _manifests(benchmark_id=BENCHMARK):
    """Manifests that match the accepted source exactly."""

    roots = _roots(benchmark_id)
    built = {}
    for key, _module, local, _expected_root in expected_trees(benchmark_id):
        files = source_manifest(local)
        built[key] = {
            "root": roots[key],
            "files": files,
            "difference": compare_manifests(files, files),
        }
    return built


def _module_row(manifests, key, relative, name):
    """An observation row pointing at a real file in one of the manifests."""

    digest = {row["path"]: row["sha256"] for row in manifests[key]["files"]}[relative]
    return {
        "name": name,
        "path": "{}/{}".format(manifests[key]["root"], relative),
        "sha256": digest,
    }


def _observation(manifests=None, **overrides):
    """A well-formed Audio observation whose modules live in the manifests."""

    manifests = manifests or _manifests()
    observation = {
        "sandboxContract": 1,
        "pythonVersion": "3.8.20",
        "sdkVersion": "0.2.0",
        "modules": [
            _module_row(manifests, "sdk", "__init__.py", "cogbench"),
            _module_row(manifests, "sdk", "plugins.py", "cogbench.plugins"),
            _module_row(manifests, "runner", "week1_payload.py", "cogworks_runner.week1_payload"),
            _module_row(
                manifests, "benchmark", "drivers.py", "audio_identification_benchmark.drivers"
            ),
        ],
    }
    observation.update(overrides)
    return observation


class BenchmarkSourceSelection(unittest.TestCase):
    def test_each_track_maps_to_its_submodule_package(self):
        self.assertEqual(
            benchmark_source("audio-identification")[0], "audio_identification_benchmark"
        )
        self.assertEqual(benchmark_source("language-search")[0], "language_search_benchmark")
        # Both Vision tracks are one package and one image, probed once each.
        self.assertEqual(
            benchmark_source("vision-recognition"), benchmark_source("vision-clustering")
        )

    def test_the_source_directory_exists_and_carries_the_driver(self):
        for benchmark_id in ("audio-identification", "language-search", "vision-recognition"):
            _package, source = benchmark_source(benchmark_id)
            self.assertTrue(source.is_dir(), source)
            self.assertTrue((source / "drivers.py").is_file(), source)

    def test_only_the_three_packages_are_compared(self):
        # Not a repository walk: datasets, tools and tests never enter a
        # manifest, and no student code is imported.
        keys = [key for key, _module, _local, _root in expected_trees(BENCHMARK)]
        self.assertEqual(keys, ["sdk", "runner", "benchmark"])


class SourceManifest(unittest.TestCase):
    def test_covers_every_python_file_once(self):
        for _key, _module, local, _root in expected_trees(BENCHMARK):
            rows = source_manifest(local)
            on_disk = sorted(path.relative_to(local).as_posix() for path in local.rglob("*.py"))
            self.assertEqual([row["path"] for row in rows], on_disk)
            self.assertEqual(len(rows), len(set(row["path"] for row in rows)))

    def test_refuses_a_directory_that_is_not_there(self):
        with self.assertRaises(ProbeError):
            source_manifest(ROOT / "python" / "cogbench" / "src" / "not-a-package")

    def test_refuses_a_tree_with_no_python(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "README.md").write_text("no modules here")
            with self.assertRaises(ProbeError):
                source_manifest(Path(directory))


class ManifestPayload(unittest.TestCase):
    def test_reads_a_resolved_root_and_rows(self):
        root, files = validate_manifest_payload(
            {"root": "/opt/cogbench/cogbench", "files": [{"path": "a.py", "sha256": "a" * 64}]}
        )
        self.assertEqual(root, "/opt/cogbench/cogbench")
        self.assertEqual(len(files), 1)

    def test_refuses_a_manifest_without_a_resolved_root(self):
        for bad in (
            [{"path": "a.py", "sha256": "a" * 64}],
            {"files": [{"path": "a.py", "sha256": "a" * 64}]},
            {"root": "", "files": [{"path": "a.py", "sha256": "a" * 64}]},
            {"root": "relative/path", "files": [{"path": "a.py", "sha256": "a" * 64}]},
        ):
            with self.assertRaises(ProbeError):
                validate_manifest_payload(bad)

    def test_refuses_malformed_rows(self):
        for files in ([], "not a list", [{"path": "a.py"}], [{"path": "a.py", "sha256": "nope"}]):
            with self.assertRaises(ProbeError):
                validate_manifest_payload({"root": "/opt/x", "files": files})


class ManifestComparison(unittest.TestCase):
    def test_names_the_three_kinds_of_difference_separately(self):
        expected = [
            {"path": "kept.py", "sha256": "a" * 64},
            {"path": "edited.py", "sha256": "b" * 64},
            {"path": "dropped.py", "sha256": "c" * 64},
        ]
        observed = [
            {"path": "kept.py", "sha256": "a" * 64},
            {"path": "edited.py", "sha256": "d" * 64},
            {"path": "added.py", "sha256": "e" * 64},
        ]
        self.assertEqual(
            compare_manifests(expected, observed),
            {
                "missingFromImage": ["dropped.py"],
                "unexpectedInImage": ["added.py"],
                "changed": ["edited.py"],
            },
        )


class ImportsAreBoundToManifests(unittest.TestCase):
    """A path that exists is not proof of what the interpreter loaded."""

    def test_a_clean_image_binds_every_module_to_a_checked_root(self):
        manifests = _manifests()
        receipt = build_receipt(BENCHMARK, 1, IMAGE_ID, _observation(manifests), manifests)
        self.assertEqual(
            receipt["importedModuleRoots"],
            {
                "cogbench": "sdk",
                "cogbench.plugins": "sdk",
                "cogworks_runner.week1_payload": "runner",
                "audio_identification_benchmark.drivers": "benchmark",
            },
        )

    def test_rejects_a_module_imported_from_an_alternate_root(self):
        manifests = _manifests()
        observation = _observation(manifests)
        # Same filename, same hash, loaded from a copy the image also carries.
        observation["modules"][1]["path"] = "/tmp/shadow/cogbench/plugins.py"
        with self.assertRaises(ProbeError) as caught:
            build_receipt(BENCHMARK, 1, IMAGE_ID, observation, manifests)
        self.assertIn("outside every checked", str(caught.exception))

    def test_rejects_a_module_whose_hash_disagrees_with_the_manifest(self):
        manifests = _manifests()
        observation = _observation(manifests)
        observation["modules"][0]["sha256"] = "f" * 64
        with self.assertRaises(ProbeError) as caught:
            build_receipt(BENCHMARK, 1, IMAGE_ID, observation, manifests)
        self.assertIn("different hash", str(caught.exception))

    def test_rejects_a_module_the_manifest_does_not_contain(self):
        manifests = _manifests()
        observation = _observation(manifests)
        observation["modules"][0]["path"] = "{}/ghost.py".format(manifests["sdk"]["root"])
        with self.assertRaises(ProbeError) as caught:
            build_receipt(BENCHMARK, 1, IMAGE_ID, observation, manifests)
        self.assertIn("does not contain", str(caught.exception))

    def test_the_driver_is_one_of_the_bound_modules(self):
        # The decoder and driver are what a stale benchmark install gets wrong,
        # so they have to be inside this binding rather than beside it.
        manifests = _manifests()
        bound = bind_modules_to_manifests(_observation(manifests), manifests)
        self.assertEqual(bound["audio_identification_benchmark.drivers"], "benchmark")


class PlatformRootsArePinned(unittest.TestCase):
    def test_rejects_an_sdk_imported_from_somewhere_other_than_opt(self):
        manifests = _manifests()
        manifests["sdk"]["root"] = "/usr/local/lib/python3.8/site-packages/cogbench"
        observation = _observation(manifests)
        with self.assertRaises(ProbeError) as caught:
            build_receipt(BENCHMARK, 1, IMAGE_ID, observation, manifests)
        self.assertIn("/opt/cogbench/cogbench", str(caught.exception))

    def test_the_benchmark_root_is_not_pinned_because_it_is_installed(self):
        manifests = _manifests()
        manifests["benchmark"]["root"] = "/usr/lib/python3/dist-packages/audio_identification_benchmark"
        receipt = build_receipt(BENCHMARK, 1, IMAGE_ID, _observation(manifests), manifests)
        self.assertEqual(
            receipt["sourceManifests"]["benchmark"]["root"],
            "/usr/lib/python3/dist-packages/audio_identification_benchmark",
        )


class InstalledSourceFidelity(unittest.TestCase):
    def test_a_stale_installed_benchmark_fails_even_with_fresh_platform_trees(self):
        # The case the user asked for: /opt carries the accepted SDK and runner,
        # and the installed benchmark package is from an older build.
        manifests = _manifests()
        stale = [dict(row) for row in manifests["benchmark"]["files"]]
        stale[0] = dict(stale[0], sha256="f" * 64)
        manifests["benchmark"]["files"] = stale
        manifests["benchmark"]["difference"] = compare_manifests(
            source_manifest(benchmark_source(BENCHMARK)[1]), stale
        )
        with self.assertRaises(ProbeError) as caught:
            build_receipt(BENCHMARK, 1, IMAGE_ID, _observation(), manifests)
        self.assertIn("benchmark package", str(caught.exception))

    def test_a_missing_benchmark_module_fails(self):
        manifests = _manifests()
        trimmed = manifests["benchmark"]["files"][:-1]
        manifests["benchmark"]["files"] = trimmed
        manifests["benchmark"]["difference"] = compare_manifests(
            source_manifest(benchmark_source(BENCHMARK)[1]), trimmed
        )
        with self.assertRaises(ProbeError):
            build_receipt(BENCHMARK, 1, IMAGE_ID, _observation(), manifests)

    def test_a_drifted_runner_tree_fails(self):
        manifests = _manifests()
        changed = [dict(row) for row in manifests["runner"]["files"]]
        changed[0] = dict(changed[0], sha256="f" * 64)
        manifests["runner"]["files"] = changed
        manifests["runner"]["difference"] = compare_manifests(
            source_manifest(PLATFORM_TREES[1][2]), changed
        )
        with self.assertRaises(ProbeError) as caught:
            build_receipt(BENCHMARK, 1, IMAGE_ID, _observation(), manifests)
        self.assertIn("runner package", str(caught.exception))

    def test_a_receipt_records_all_three_roots(self):
        receipt = build_receipt(BENCHMARK, 1, IMAGE_ID, _observation(), _manifests())
        self.assertEqual(sorted(receipt["sourceManifests"]), ["benchmark", "runner", "sdk"])
        self.assertEqual(receipt["sourceManifests"]["sdk"]["root"], "/opt/cogbench/cogbench")


class ImageIdentity(unittest.TestCase):
    def test_refuses_a_published_name(self):
        for name in (
            "cogworks-runner-week1",
            "cogworks-runner-benchmark",
            "cogworks-runner-week1@im-Tpq3fjbNvymPQUJ7SWkCYp",
            "",
        ):
            with self.assertRaises(ProbeError) as caught:
                build_receipt(BENCHMARK, 1, name, _observation(), _manifests())
            self.assertIn("immutable image id", str(caught.exception))


class CatalogAgreement(unittest.TestCase):
    def test_refuses_when_the_catalog_and_the_image_disagree(self):
        # The demonstrated Language case: catalog on the nine-case grid, image
        # still carrying the six-case decoder.
        manifests = _manifests("language-search")
        observation = _observation(manifests, sandboxContract=1)
        observation["modules"] = [
            _module_row(manifests, "sdk", "__init__.py", "cogbench"),
        ]
        with self.assertRaises(ProbeError):
            build_receipt("language-search", 2, IMAGE_ID, observation, manifests)

    def test_refuses_an_interpreter_that_misses_the_track_requirement(self):
        for version in ("3.11.9", "3.9.18", "3"):
            with self.assertRaises(ProbeError):
                build_receipt(
                    BENCHMARK, 1, IMAGE_ID, _observation(pythonVersion=version), _manifests()
                )

    def test_accepts_another_3_8_patch_release(self):
        # The image pins 3.8.20; the pin is not evidence another patch fails.
        receipt = build_receipt(
            BENCHMARK, 1, IMAGE_ID, _observation(pythonVersion="3.8.18"), _manifests()
        )
        self.assertEqual(receipt["observation"]["pythonVersion"], "3.8.18")


class LocalInputValidation(unittest.TestCase):
    def test_accepts_the_pairings_this_source_declares(self):
        validate_probe_inputs("audio-identification", IMAGE_ID, 1)
        validate_probe_inputs("language-search", IMAGE_ID, 2)

    def test_names_both_numbers_when_the_catalog_disagrees(self):
        with self.assertRaises(ProbeError) as caught:
            validate_probe_inputs("language-search", IMAGE_ID, 1)
        message = str(caught.exception)
        self.assertIn("contract 1", message)
        self.assertIn("declares 2", message)


class NothingReachesModalUntilLocalChecksPass(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def recorder(*arguments):
            self.calls.append(arguments)
            raise AssertionError("observe_image should not have been reached")

        original = probe_module.observe_image
        probe_module.observe_image = recorder
        self.addCleanup(setattr, probe_module, "observe_image", original)

    def test_a_published_name_is_refused_before_any_sandbox(self):
        for name in ("cogworks-runner-week1", "cogworks-runner-week1@im-Tpq3f", ""):
            with self.assertRaises(ProbeError):
                probe_image(BENCHMARK, name, 1, 300)
        self.assertEqual(self.calls, [])

    def test_a_contract_this_source_does_not_serve_is_refused_before_any_sandbox(self):
        with self.assertRaises(ProbeError) as caught:
            probe_image(BENCHMARK, IMAGE_ID, 2, 300)
        self.assertIn("sandbox contract", str(caught.exception))
        self.assertEqual(self.calls, [])

    def test_valid_inputs_do_reach_the_observation_step(self):
        # Without this the tests above would pass if probe_image refused
        # everything, or never called observe_image at all.
        with self.assertRaises(AssertionError):
            probe_image(BENCHMARK, IMAGE_ID, 1, 300)
        self.assertEqual(self.calls, [(BENCHMARK, IMAGE_ID, 300)])

    def test_an_occupied_receipt_path_is_refused_before_any_sandbox(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "audio-receipt.json"
            original = b'{"imageId": "im-somethingelse"}\n'
            receipt.write_bytes(original)
            code = main([
                "--benchmark", BENCHMARK, "--image-id", IMAGE_ID,
                "--sandbox-contract", "1", "--receipt", str(receipt),
            ])
            self.assertEqual(code, 1)
            # The earlier probe's record is still exactly what it was.
            self.assertEqual(receipt.read_bytes(), original)
            self.assertEqual(self.calls, [])

    def test_a_dangling_symlink_occupies_the_path_too(self):
        # `exists` follows the link and answers False, while the exclusive
        # create still fails. Checking with `exists` would let this reach the
        # sandbox and refuse afterwards, which is the cost being avoided.
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "audio-receipt.json"
            receipt.symlink_to(Path(directory) / "gone.json")
            self.assertFalse(receipt.exists())
            self.assertTrue(receipt.is_symlink())
            code = main([
                "--benchmark", BENCHMARK, "--image-id", IMAGE_ID,
                "--sandbox-contract", "1", "--receipt", str(receipt),
            ])
            self.assertEqual(code, 1)
            # The link is left alone rather than cleared to make room.
            self.assertTrue(receipt.is_symlink())
            self.assertEqual(self.calls, [])

    def test_a_missing_local_source_tree_refuses_before_any_sandbox(self):
        # The accepted source is read before the call, so a checkout without
        # the benchmark submodule fails here rather than after paying for a
        # sandbox whose answer could not have been compared to anything.
        original = probe_module.expected_trees
        probe_module.expected_trees = lambda benchmark_id: [
            ("sdk", "cogbench", ROOT / "python" / "cogbench" / "src" / "cogbench", "/opt/cogbench/cogbench"),
            ("benchmark", "gone_benchmark", ROOT / "benchmarks" / "week9" / "gone_benchmark", None),
        ]
        self.addCleanup(setattr, probe_module, "expected_trees", original)
        with self.assertRaises(ProbeError) as caught:
            probe_image(BENCHMARK, IMAGE_ID, 1, 300)
        self.assertIn("No source tree", str(caught.exception))
        self.assertEqual(self.calls, [])


class ReceiptWriting(unittest.TestCase):
    def test_a_refused_probe_writes_no_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "nested" / "audio-receipt.json"

            def failing(*_arguments):
                raise ProbeError("the image could not state its execution contract")

            original = probe_module.observe_image
            probe_module.observe_image = failing
            self.addCleanup(setattr, probe_module, "observe_image", original)
            code = main([
                "--benchmark", BENCHMARK, "--image-id", IMAGE_ID,
                "--sandbox-contract", "1", "--receipt", str(receipt),
            ])
            self.assertEqual(code, 1)
            self.assertFalse(receipt.exists())

    def test_reserve_refuses_an_existing_path_and_accepts_a_free_one(self):
        with tempfile.TemporaryDirectory() as directory:
            taken = Path(directory) / "taken.json"
            taken.write_text("{}")
            with self.assertRaises(ProbeError) as caught:
                reserve_receipt(taken)
            self.assertIn("never overwritten", str(caught.exception))
            reserve_receipt(Path(directory) / "free.json")
            reserve_receipt(None)

    def test_a_path_taken_while_the_sandbox_ran_refuses_without_a_traceback(self):
        # `reserve_receipt` cleared this path, then something else took it. The
        # collision has to read as a refusal: exit 1, the specific message, the
        # other file untouched, and no line claiming a receipt was written.
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "audio-receipt.json"
            intruder = b'{"written": "by someone else"}\n'

            def occupying(*_arguments):
                receipt.write_bytes(intruder)
                manifests = _manifests()
                return {"observation": _observation(manifests), "manifests": manifests}

            original = probe_module.observe_image
            probe_module.observe_image = occupying
            self.addCleanup(setattr, probe_module, "observe_image", original)

            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = main([
                    "--benchmark", BENCHMARK, "--image-id", IMAGE_ID,
                    "--sandbox-contract", "1", "--receipt", str(receipt),
                ])
            self.assertEqual(code, 1)
            self.assertEqual(receipt.read_bytes(), intruder)
            self.assertIn("probe refused", err.getvalue())
            self.assertIn("nothing was written", err.getvalue())
            self.assertNotIn("receipt written", out.getvalue())

    def test_a_failed_write_leaves_the_destination_absent(self):
        # The destination is created by linking a finished temporary file into
        # place, so a write that dies partway never reaches the final name and
        # the next attempt is not blocked by a stub of a receipt.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            self._fail_writes(OSError(28, "No space left on device"))

            with self.assertRaises(ProbeError) as caught:
                write_receipt(path, {"imageId": IMAGE_ID})

            self.assertIn("Could not write", str(caught.exception))
            self.assertFalse(path.exists())
            self.assertEqual(self._leftovers(directory), [])
            reserve_receipt(path)  # the retry is free to proceed

    def test_an_unserializable_receipt_creates_nothing(self):
        # Serialization happens before any file exists, so this whole class of
        # failure cannot leave residue.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"

            with self.assertRaises(TypeError):
                write_receipt(path, {"imageId": object()})

            self.assertFalse(path.exists())
            self.assertEqual(self._leftovers(directory), [])

    def test_a_collision_is_refused_and_the_other_file_is_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            intruder = b'{"written": "by someone else"}\n'
            path.write_bytes(intruder)

            with self.assertRaises(ProbeError) as caught:
                write_receipt(path, {"imageId": IMAGE_ID})

            self.assertIn("appeared while this probe was running", str(caught.exception))
            self.assertEqual(path.read_bytes(), intruder)
            self.assertEqual(self._leftovers(directory), [])

    def test_a_dangling_symlink_destination_is_refused_intact(self):
        # `os.link` refuses it rather than replacing it, which is why the
        # destination is never unlinked to make room.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.symlink_to(Path(directory) / "gone.json")

            with self.assertRaises(ProbeError):
                write_receipt(path, {"imageId": IMAGE_ID})

            self.assertTrue(path.is_symlink())
            self.assertFalse(path.exists())
            self.assertEqual(self._leftovers(directory), [])

    def test_a_cleanup_failure_does_not_mask_the_write_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            self._fail_writes(OSError(28, "No space left on device"))
            original_unlink = probe_module.os.unlink
            probe_module.os.unlink = self._raising_unlink(original_unlink)
            try:
                with self.assertRaises(ProbeError) as caught:
                    write_receipt(path, {"imageId": IMAGE_ID})
            finally:
                probe_module.os.unlink = original_unlink

            message = str(caught.exception)
            self.assertIn("No space left on device", message)   # the primary cause
            self.assertIn("A temporary file remains", message)  # stated, not hidden
            self.assertFalse(path.exists())
            # The residue the message promised is really there. Removing it is
            # this test's job, not the fixture's: rmtree cannot clear a file
            # whose deletion it was just told would fail.
            residue = self._leftovers(directory)
            self.assertEqual(len(residue), 1)
            (Path(directory) / residue[0]).unlink()

    def test_cleanup_residue_is_reported_after_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text("existing receipt")
            original = probe_module.os.unlink
            probe_module.os.unlink = self._raising_unlink(original)
            try:
                with self.assertRaises(ProbeError) as caught:
                    write_receipt(path, {"imageId": IMAGE_ID})
            finally:
                probe_module.os.unlink = original
            self.assertIn("A temporary file remains", str(caught.exception))
            self.assertEqual(path.read_text(), "existing receipt")
            self.assertEqual(len(self._leftovers(directory)), 1)

    def test_cleanup_residue_warns_after_successful_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            original = probe_module.os.unlink
            probe_module.os.unlink = self._raising_unlink(original)
            err = io.StringIO()
            try:
                with redirect_stderr(err):
                    write_receipt(path, {"imageId": IMAGE_ID})
            finally:
                probe_module.os.unlink = original
            self.assertIn("receipt is complete", err.getvalue())
            self.assertIn("A temporary file remains", err.getvalue())
            self.assertEqual(json.loads(path.read_text())["imageId"], IMAGE_ID)
            self.assertEqual(len(self._leftovers(directory)), 1)

    def test_the_destination_appears_only_once_it_is_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            original = probe_module.os.link

            def link_complete(source, destination):
                self.assertFalse(path.exists())
                self.assertEqual(json.loads(Path(source).read_text())["imageId"], IMAGE_ID)
                return original(source, destination)

            probe_module.os.link = link_complete
            try:
                write_receipt(path, {"imageId": IMAGE_ID})
            finally:
                probe_module.os.link = original
            self.assertEqual(json.loads(path.read_text())["imageId"], IMAGE_ID)
            self.assertEqual(self._leftovers(directory), [])

    def _fail_writes(self, error):
        """Make every write to the temporary stream raise."""

        original = probe_module.os.fdopen

        def failing(descriptor, *arguments, **keywords):
            stream = original(descriptor, *arguments, **keywords)
            def fail(_text):
                raise error

            stream.write = fail
            return stream

        probe_module.os.fdopen = failing
        self.addCleanup(setattr, probe_module.os, "fdopen", original)

    def _raising_unlink(self, original):
        """Fail only on this module's own temporary files.

        `probe_module.os` is the real os module, so an unconditional patch also
        breaks the fixture's own directory cleanup.
        """

        def unlink(target, *arguments, **keywords):
            if str(target).endswith(".part"):
                raise OSError(13, "Permission denied")
            return original(target, *arguments, **keywords)

        return unlink

    @staticmethod
    def _leftovers(directory):
        """Temporary files this module would have created, if any survived."""

        return sorted(p.name for p in Path(directory).iterdir() if p.name.endswith(".part"))

    def test_writing_is_exclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "out" / "receipt.json"
            write_receipt(path, {"imageId": IMAGE_ID})
            self.assertEqual(json.loads(path.read_text())["imageId"], IMAGE_ID)
            # A second writer must not clobber the first.
            with self.assertRaises(ProbeError):
                write_receipt(path, {"imageId": "im-other"})
            self.assertEqual(json.loads(path.read_text())["imageId"], IMAGE_ID)


class SandboxOutputHandling(unittest.TestCase):
    def test_malformed_json_is_a_refusal_naming_the_read(self):
        with self.assertRaises(ProbeError) as caught:
            load_json("Traceback (most recent call last):", "the sdk manifest")
        self.assertIn("not JSON", str(caught.exception))
        self.assertIn("sdk manifest", str(caught.exception))

    def test_the_payload_is_not_echoed_into_the_message(self):
        noisy = json.dumps({"secretish": "x" * 500})[:-1]
        with self.assertRaises(ProbeError) as caught:
            load_json(noisy, "the sdk manifest")
        self.assertNotIn("secretish", str(caught.exception))
        self.assertLess(len(str(caught.exception)), 200)

    def test_an_unexpected_error_is_not_swallowed(self):
        class Exploding:
            def __str__(self):
                raise RuntimeError("boom")

        with self.assertRaises(TypeError):
            load_json(Exploding(), "anything")


class InterpreterSelection(unittest.TestCase):
    """Test the selection shared by the runner and release probe."""

    def test_the_two_tracks_the_evaluator_holds_to_3_8_get_the_venv(self):
        for benchmark_id in ("audio-identification", "language-search"):
            self.assertEqual(student_python(benchmark_id, PY38_VENV), PY38_VENV)

    def test_every_other_track_gets_the_image_interpreter(self):
        for benchmark_id in ("vision-recognition", "vision-clustering"):
            self.assertEqual(student_python(benchmark_id, PY38_VENV), "python")

    def test_the_track_set_is_the_3_8_requirement_itself(self):
        # The point of deriving it: a track cannot acquire the 3.8 requirement
        # without acquiring the interpreter that satisfies it.
        for benchmark_id in SANDBOX_CONTRACTS:
            needs_venv = student_python(benchmark_id, PY38_VENV) == PY38_VENV
            self.assertEqual(needs_venv, benchmark_id in REQUIRED_PYTHON, benchmark_id)


class CommandLine(unittest.TestCase):
    def test_manifest_only_needs_no_image_and_no_credentials(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(["--benchmark", BENCHMARK, "--manifest-only"])
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertEqual(sorted(payload), ["benchmark", "runner", "sdk"])
        self.assertEqual(payload["benchmark"]["module"], "audio_identification_benchmark")

    def test_a_probe_run_requires_both_concrete_inputs(self):
        for argv in (
            ["--benchmark", BENCHMARK],
            ["--benchmark", BENCHMARK, "--image-id", IMAGE_ID],
            ["--benchmark", BENCHMARK, "--sandbox-contract", "1"],
        ):
            with self.assertRaises(SystemExit) as caught:
                main(argv)
            self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
