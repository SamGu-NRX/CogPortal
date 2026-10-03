"""An official dataset version is published once and never replaced.

The first class drives `publish_bundle` directly with stdlib-only inputs. The
other two run the real Week 2 and Week 3 materializer `main()` on synthetic
rows, replacing only the data source, so the refusal is proven on the path an
operator runs and not only on the helper.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import time
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps/runner-modal/src"))
sys.path.insert(0, str(Path(__file__).parent))

from cogworks_runner import official_bundle  # noqa: E402
from cogworks_runner.official_bundle import (  # noqa: E402
    PUBLISHED,
    SCORED_FILES,
    UNCHANGED,
    BundleRefused,
    DatasetNotApproved,
    dataset_digest,
    publish_bundle,
    read_approved_bundle,
    read_bundle,
    require_usable_destination,
)
from test_prepared_environment import require_benchmark  # noqa: E402

TOOLS = Path(__file__).resolve().parents[1] / "tools"


def archive(members, date_time=(2026, 1, 1, 0, 0, 0)):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as handle:
        for name, data in members:
            handle.writestr(zipfile.ZipInfo(name, date_time=date_time), data)
    return buffer.getvalue()


def bundle(gold=b'{"rows":[0,2]}', members=(("metadata.json", b"{}"), ("a.npy", b"x"))):
    return {"payload.zip": archive(members), "gold.json": gold}


def snapshot(directory):
    """Every entry under a directory with its bytes, mode and inode."""

    rows = {}
    for path in sorted(Path(directory).rglob("*")):
        status = os.lstat(str(path))
        rows[str(path.relative_to(directory))] = (
            path.read_bytes() if path.is_file() and not path.is_symlink() else None,
            status.st_mode,
            status.st_ino,
        )
    return rows


class PublishBundle(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.target = self.root / "language-search" / "official-v1"

    def assertOnlyTarget(self):
        """No temporary sibling survives, whatever the outcome."""
        self.assertEqual(
            sorted(path.name for path in self.target.parent.iterdir()), [self.target.name]
        )

    def test_publishes_a_new_version_read_only(self):
        files = bundle()
        self.assertEqual(publish_bundle(self.target, files), PUBLISHED)
        for name, data in files.items():
            self.assertEqual((self.target / name).read_bytes(), data)
            self.assertEqual((self.target / name).stat().st_mode & 0o777, 0o440)
        self.assertOnlyTarget()

    def test_identical_bytes_are_a_no_op(self):
        publish_bundle(self.target, bundle())
        before = snapshot(self.root)
        self.assertEqual(publish_bundle(self.target, bundle()), UNCHANGED)
        self.assertEqual(snapshot(self.root), before)

    def test_same_members_under_a_different_clock_are_a_no_op(self):
        publish_bundle(self.target, bundle())
        before = snapshot(self.root)
        later = bundle()
        later["payload.zip"] = archive(
            (("metadata.json", b"{}"), ("a.npy", b"x")), date_time=(2027, 6, 1, 12, 0, 0)
        )
        self.assertNotEqual(later["payload.zip"], bundle()["payload.zip"])
        self.assertEqual(publish_bundle(self.target, later), UNCHANGED)
        # The original archive stays, byte for byte.
        self.assertEqual(snapshot(self.root), before)

    def test_changed_gold_is_refused_and_the_original_survives(self):
        # The audit's case: same payload, different answers, same version name.
        publish_bundle(self.target, bundle())
        before = snapshot(self.root)
        with self.assertRaises(BundleRefused) as caught:
            publish_bundle(self.target, bundle(gold=b'{"rows":[2,0]}'))
        self.assertIn("different contents (gold.json differ)", str(caught.exception))
        self.assertIn("new --dataset-version", str(caught.exception))
        self.assertEqual(snapshot(self.root), before)
        self.assertOnlyTarget()

    def test_changed_member_bytes_or_names_are_refused(self):
        publish_bundle(self.target, bundle())
        before = snapshot(self.root)
        for members in (
            (("metadata.json", b"{}"), ("a.npy", b"y")),
            (("metadata.json", b"{}"),),
            (("metadata.json", b"{}"), ("a.npy", b"x"), ("b.npy", b"x")),
        ):
            with self.subTest(members=members):
                with self.assertRaises(BundleRefused) as caught:
                    publish_bundle(self.target, bundle(members=members))
                self.assertIn("payload.zip differ", str(caught.exception))
                self.assertEqual(snapshot(self.root), before)

    def test_an_incomplete_or_padded_destination_is_refused_untouched(self):
        for present, words in (
            ({"payload.zip": bundle()["payload.zip"]}, "missing: gold.json; unexpected: none"),
            (dict(bundle(), **{"notes.txt": b"x"}), "missing: none; unexpected: notes.txt"),
            ({}, "missing: gold.json, payload.zip"),
        ):
            with self.subTest(present=sorted(present)):
                with tempfile.TemporaryDirectory() as directory:
                    target = Path(directory) / "official-v1"
                    target.mkdir()
                    for name, data in present.items():
                        (target / name).write_bytes(data)
                    before = snapshot(directory)
                    with self.assertRaises(BundleRefused) as early:
                        require_usable_destination(target, bundle())
                    with self.assertRaises(BundleRefused) as late:
                        publish_bundle(target, bundle())
                    for caught in (early, late):
                        self.assertIn("not a complete bundle", str(caught.exception))
                        self.assertIn(words, str(caught.exception))
                    self.assertEqual(snapshot(directory), before)

    def test_a_complete_destination_passes_the_early_check(self):
        publish_bundle(self.target, bundle())
        require_usable_destination(self.target, bundle())
        require_usable_destination(self.root / "absent", bundle())

    def test_a_link_or_file_at_the_destination_is_refused(self):
        elsewhere = self.root / "elsewhere"
        publish_bundle(elsewhere, bundle())
        self.target.parent.mkdir(parents=True)
        cases = {
            "directory symlink": lambda: self.target.symlink_to(elsewhere, target_is_directory=True),
            "plain file": lambda: self.target.write_bytes(b"not a bundle"),
        }
        for label, make in cases.items():
            with self.subTest(label):
                if os.path.lexists(str(self.target)):
                    os.unlink(str(self.target))
                make()
                before = snapshot(self.root)
                with self.assertRaises(BundleRefused) as caught:
                    publish_bundle(self.target, bundle())
                self.assertIn("not a plain directory", str(caught.exception))
                self.assertEqual(snapshot(self.root), before)

    def test_a_linked_member_is_refused(self):
        publish_bundle(self.target, bundle())
        outside = self.root / "outside.json"
        outside.write_bytes(bundle()["gold.json"])
        os.chmod(str(self.target), 0o755)
        os.unlink(str(self.target / "gold.json"))
        (self.target / "gold.json").symlink_to(outside)
        with self.assertRaises(BundleRefused) as caught:
            publish_bundle(self.target, bundle())
        self.assertIn("is not a regular file", str(caught.exception))

    def test_an_unreadable_existing_archive_is_refused(self):
        publish_bundle(self.target, bundle())
        os.chmod(str(self.target / "payload.zip"), 0o644)
        (self.target / "payload.zip").write_bytes(b"truncated")
        with self.assertRaises(BundleRefused) as caught:
            publish_bundle(self.target, bundle())
        self.assertIn("payload.zip in", str(caught.exception))
        self.assertIn("not a readable archive", str(caught.exception))
        self.assertEqual((self.target / "payload.zip").read_bytes(), b"truncated")

    def race(self, target, appear):
        """Run `appear` between the existence check and this call's claim."""

        real_mkdir = os.mkdir
        fired = []

        def other_writer_first(path, *args, **kwargs):
            # `official_bundle.os` is the os module, so this patch is global
            # and `appear` may call it too; it fires once.
            if Path(path) == target and not fired:
                fired.append(True)
                appear()
            return real_mkdir(path, *args, **kwargs)

        return mock.patch.object(official_bundle.os, "mkdir", other_writer_first)

    def test_a_bundle_that_lands_first_wins_over_a_concurrent_one(self):
        winner = bundle(gold=b'{"rows":[1,1]}')
        staging = self.root / "staging" / "official-v1"
        publish_bundle(staging, winner)
        with self.race(self.target, lambda: os.rename(str(staging), str(self.target))):
            with self.assertRaises(BundleRefused) as caught:
                publish_bundle(self.target, bundle())
        self.assertIn("gold.json differ", str(caught.exception))
        self.assertEqual((self.target / "gold.json").read_bytes(), winner["gold.json"])
        self.assertOnlyTarget()

        same = self.root / "same" / "official-v1"
        staging = self.root / "staging-same" / "official-v1"
        publish_bundle(staging, bundle())
        with self.race(same, lambda: os.rename(str(staging), str(same))):
            self.assertEqual(publish_bundle(same, bundle()), UNCHANGED)
        self.assertEqual(sorted(path.name for path in same.parent.iterdir()), ["official-v1"])

    def test_an_empty_directory_made_after_the_check_is_refused_not_replaced(self):
        # Sol's reproduction: rename(2) replaced it and reported PUBLISHED.
        self.target.parent.mkdir(parents=True)
        with self.race(self.target, lambda: os.mkdir(str(self.target))):
            with self.assertRaises(BundleRefused) as caught:
                publish_bundle(self.target, bundle())
        self.assertIn("not a complete bundle", str(caught.exception))
        self.assertEqual(list(self.target.iterdir()), [])
        self.assertOnlyTarget()

    def test_a_link_that_fails_part_way_leaves_no_version_behind(self):
        real_link = os.link

        def fail_second(source, destination):
            if destination.endswith("payload.zip"):
                raise OSError(18, "Cross-device link")
            return real_link(source, destination)

        with mock.patch.object(official_bundle.os, "link", fail_second):
            with self.assertRaises(BundleRefused) as caught:
                publish_bundle(self.target, bundle())
        self.assertIn("Could not publish", str(caught.exception))
        self.assertFalse(os.path.lexists(str(self.target)))
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_a_failed_rollback_reports_the_original_error_and_what_is_left(self):
        real_link, real_unlink = os.link, os.unlink

        def fail_second(source, destination):
            if destination.endswith("payload.zip"):
                raise OSError(28, "No space left on device")
            return real_link(source, destination)

        def refuse_target_unlink(path, *args, **kwargs):
            if Path(path).parent == self.target:
                raise OSError(1, "Operation not permitted")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(official_bundle.os, "link", fail_second), \
                mock.patch.object(official_bundle.os, "unlink", refuse_target_unlink):
            with self.assertRaises(BundleRefused) as caught:
                publish_bundle(self.target, bundle())
        message = str(caught.exception)
        self.assertIn("No space left on device", message)
        self.assertIn("could not be removed (still holds gold.json)", message)

    def test_a_staging_copy_that_cannot_be_removed_is_reported(self):
        # Sol's reproduction: the outcome stood and the leftover copy was silent.
        def refuse(path, *args, **kwargs):
            raise OSError(13, "Permission denied")

        def link_fails(source, destination):
            raise OSError(28, "No space left on device")

        for failing in (False, True):
            with self.subTest(publication_fails=failing):
                target = self.root / ("failing" if failing else "fresh") / "official-v1"
                with mock.patch.object(official_bundle.shutil, "rmtree", refuse), \
                        contextlib.redirect_stderr(io.StringIO()) as log:
                    if failing:
                        with mock.patch.object(official_bundle.os, "link", link_fails), \
                                self.assertRaises(BundleRefused) as caught:
                            publish_bundle(target, bundle())
                        # The publication failure stays the error raised.
                        self.assertIn("No space left on device", str(caught.exception))
                    else:
                        self.assertEqual(publish_bundle(target, bundle()), PUBLISHED)
                self.assertIn("bundle warning: a temporary copy remains at", log.getvalue())
                self.assertIn(str(target.parent / ".official-v1."), log.getvalue())
                self.assertIn("Permission denied", log.getvalue())

    def test_duplicate_archive_member_names_are_refused(self):
        publish_bundle(self.target, bundle())
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # zipfile warns about the duplicate
            twice = archive((("metadata.json", b"{}"), ("a.npy", b"y"), ("a.npy", b"x")))
        with self.assertRaises(BundleRefused) as caught:
            publish_bundle(self.target, dict(bundle(), **{"payload.zip": twice}))
        self.assertIn("repeats an archive member name", str(caught.exception))

    def test_a_failed_write_leaves_no_destination_and_no_temporary(self):
        real = Path.write_bytes

        def fail_on_gold(path, data):
            if path.name == "gold.json":
                raise OSError(28, "No space left on device")
            return real(path, data)

        with mock.patch.object(Path, "write_bytes", fail_on_gold):
            with self.assertRaises(OSError):
                publish_bundle(self.target, bundle())
        self.assertFalse(os.path.lexists(str(self.target)))
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_refuses_names_that_are_not_plain_files(self):
        for files in ({}, {"../gold.json": b"x"}, {"nested/gold.json": b"x"}, {"..": b"x"}):
            with self.subTest(files=sorted(files)):
                with self.assertRaises(BundleRefused):
                    publish_bundle(self.target, files)
        self.assertFalse(self.target.parent.exists())


class DatasetDigest(unittest.TestCase):
    """One correct answer, so pinned to a vector built independently here."""

    def test_known_answer(self):
        import hashlib

        canonical = (
            '{"files":[{"path":"gold.json","sha256":"%s"},{"path":"payload.zip","sha256":"%s"}],'
            '"schema":"cogworks.dataset-digest.v1"}'
            % (hashlib.sha256(b"{}").hexdigest(), hashlib.sha256(b"x").hexdigest())
        )
        expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        self.assertEqual(dataset_digest({"payload.zip": b"x", "gold.json": b"{}"}), expected)
        self.assertEqual(dataset_digest({"gold.json": b"{}", "payload.zip": b"x"}), expected)

    def test_any_byte_or_name_change_changes_it(self):
        base = dataset_digest({"payload.zip": b"x", "gold.json": b"{}"})
        for files in (
            {"payload.zip": b"y", "gold.json": b"{}"},
            {"payload.zip": b"x", "gold.json": b"{ }"},
            {"payload.zip": b"x", "expected.json": b"{}"},
            {"payload.zip": b"x"},
        ):
            with self.subTest(files=files):
                self.assertNotEqual(dataset_digest(files), base)

    def test_the_layouts_are_the_files_the_controller_reads(self):
        self.assertEqual(
            SCORED_FILES,
            {
                "audio-identification": ("manifest.json",),
                "vision-recognition": ("payload.zip", "expected.json"),
                "vision-clustering": ("payload.zip", "expected.json"),
                "language-search": ("payload.zip", "gold.json"),
            },
        )


class ReadApprovedBundle(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        publish_bundle(self.root / "v1", bundle())
        self.approved = dataset_digest(read_bundle(self.root / "v1", "language-search"))

    def test_returns_the_bytes_it_checked(self):
        files = read_approved_bundle(self.root / "v1", "language-search", self.approved)
        self.assertEqual(files, bundle())

    def test_ignores_files_outside_the_layout(self):
        os.chmod(str(self.root / "v1"), 0o755)
        (self.root / "v1" / "README.md").write_text("notes")
        read_approved_bundle(self.root / "v1", "language-search", self.approved)

    def test_refuses_without_approval_or_with_other_bytes(self):
        for benchmark_id, approved, words in (
            ("language-search", None, "carries no approved dataset digest"),
            ("language-search", "", "carries no approved dataset digest"),
            ("language-search", "0" * 64, "do not match the approved digest"),
            ("vision-clustering", self.approved, "expected.json could not be read"),
            ("audio-recognition", self.approved, "has no official dataset layout"),
        ):
            with self.subTest(benchmark_id=benchmark_id, approved=approved):
                with self.assertRaises(DatasetNotApproved) as caught:
                    read_approved_bundle(self.root / "v1", benchmark_id, approved)
                self.assertIn(words, str(caught.exception))


def run_main(module, argv):
    with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()) as output:
        module.main()
    return output.getvalue().strip()


class Week2Materializer(unittest.TestCase):
    """The real `materialize_week2_official.main()` on synthetic rows."""

    def setUp(self):
        require_benchmark("vision-clustering")
        from test_week2_official_format import materialize_official_bundle

        self.materialize = materialize_official_bundle
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.target = self.root / "volume/vision-clustering/synthetic-test"

    def test_same_manifest_again_writes_nothing_even_with_a_new_clock(self):
        _cases, _payload, _gold, first = self.materialize(self.root, 42)
        on_disk = dataset_digest(read_bundle(self.target, "vision-clustering"))
        self.assertEqual(
            first.splitlines()[-1],
            "Dataset digest for vision-clustering synthetic-test: {}".format(on_disk),
        )
        before = snapshot(self.root / "volume")
        # A later clock gives the new archive different bytes and the same
        # members; that must still count as the same bundle, and the digest
        # printed is still the one of the bytes kept.
        later = time.struct_time((2031, 3, 4, 5, 6, 7, 0, 63, -1))
        with mock.patch("time.localtime", return_value=later):
            _cases, payload, _gold, announced = self.materialize(self.root, 42)
        self.assertEqual(announced.splitlines(), [
            "synthetic-test already holds this exact bundle; nothing was written.",
            "Dataset digest for vision-clustering synthetic-test: {}".format(on_disk),
        ])
        self.assertEqual(snapshot(self.root / "volume"), before)

    def test_a_different_manifest_under_the_same_version_is_refused(self):
        self.materialize(self.root, 42)
        before = snapshot(self.root / "volume")
        with self.assertRaises(SystemExit) as caught:
            self.materialize(self.root, 43)
        self.assertIn("already holds this dataset version with different contents", str(caught.exception))
        self.assertEqual(snapshot(self.root / "volume"), before)

    def test_an_old_bundle_without_expected_json_is_refused_before_any_download(self):
        from test_week2_official_format import synthetic_manifest, week2_fixture_modules

        _np, datasets, _materializer, tool = week2_fixture_modules()
        self.target.mkdir(parents=True)
        (self.target / "payload.zip").write_bytes(b"old recognition-era bundle")
        manifest, _rows = synthetic_manifest(42)
        (self.root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        before = snapshot(self.root / "volume")
        # Patched before the tool module loads, because it imports the name.
        with mock.patch.object(datasets, "materialize_manifest", side_effect=AssertionError("downloaded")):
            _np, _datasets, materializer, _tool = week2_fixture_modules()
            with self.assertRaises(SystemExit) as caught:
                run_main(materializer, [str(tool), "vision-clustering", str(self.root / "manifest.json"),
                                        str(self.root / "volume"), "--dataset-version", "synthetic-test"])
        self.assertIn("missing: expected.json", str(caught.exception))
        self.assertEqual(snapshot(self.root / "volume"), before)


class Week3Materializer(unittest.TestCase):
    """The real `materialize_week3_official.main()` with synthetic resources."""

    def setUp(self):
        require_benchmark("language-search")
        import numpy as np
        from language_search_benchmark.datasets import attach_gold, build_cases

        spec = importlib.util.spec_from_file_location(
            "materialize_week3_official", TOOLS / "materialize_week3_official.py"
        )
        self.tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.tool)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "manifest.json").write_text("{}", encoding="utf-8")
        self.target = self.root / "volume/language-search/official-v1"
        # The smallest grid inside the reviewed bounds: 100 queries, 400 images.
        queries = ["synthetic query {}".format(index) for index in range(100)]
        descriptors = np.arange(400 * 4, dtype=np.float32).reshape(400, 4)

        def cases(retrieval_gold):
            return attach_gold(
                build_cases(
                    text_captions=queries[:6],
                    queries=queries,
                    pool_image_ids=list(range(1000, 1400)),
                    pool_descriptors=descriptors,
                    tie_break_seed=7,
                    search_k=10,
                ),
                text_group_rows=[0, 0, 1, 1, 2, 2],
                retrieval_gold_rows=retrieval_gold,
                search_gold_image_ids=[1000 + row for row in retrieval_gold],
            )

        self.cases = cases

    def materialize(self, retrieval_gold):
        tool = self.tool
        with mock.patch.object(tool, "assert_disjoint"), mock.patch.object(
            tool, "load_manifest"
        ), mock.patch.object(tool, "build_resources"), mock.patch.object(
            tool, "materialize_cases", return_value=self.cases(retrieval_gold)
        ):
            return run_main(
                tool,
                ["materialize_week3_official.py", str(self.root / "manifest.json"),
                 str(self.root / "volume"), "--dataset-version", "official-v1"],
            )

    def test_rerun_is_a_no_op_and_changed_gold_is_refused(self):
        gold = list(range(100))
        first = self.materialize(gold).splitlines()
        digest_line = "Dataset digest for language-search official-v1: {}".format(
            dataset_digest(read_bundle(self.target, "language-search"))
        )
        self.assertEqual(first, [
            "Materialized official bundle: 100 queries over a 400-image pool.", digest_line,
        ])
        before = snapshot(self.root / "volume")
        self.assertEqual(self.materialize(gold).splitlines(), [
            "official-v1 already holds this exact bundle; nothing was written.", digest_line,
        ])
        self.assertEqual(snapshot(self.root / "volume"), before)

        # Same payload, two answers swapped: the audit's 1.0 to 0.61 case.
        swapped = gold[:]
        swapped[0], swapped[1] = swapped[1], swapped[0]
        with self.assertRaises(SystemExit) as caught:
            self.materialize(swapped)
        self.assertIn("different contents (gold.json differ)", str(caught.exception))
        self.assertEqual(snapshot(self.root / "volume"), before)
        self.assertEqual(sorted(path.name for path in self.target.parent.iterdir()), ["official-v1"])

    def test_an_incomplete_destination_is_refused_before_resources_load(self):
        self.target.mkdir(parents=True)
        (self.target / "gold.json").write_bytes(b"{}")
        with mock.patch.object(self.tool, "build_resources", side_effect=AssertionError("downloaded")):
            with self.assertRaises(SystemExit) as caught:
                run_main(
                    self.tool,
                    ["materialize_week3_official.py", str(self.root / "manifest.json"),
                     str(self.root / "volume"), "--dataset-version", "official-v1"],
                )
        self.assertIn("missing: payload.zip", str(caught.exception))
        self.assertEqual((self.target / "gold.json").read_bytes(), b"{}")


if __name__ == "__main__":
    unittest.main()
