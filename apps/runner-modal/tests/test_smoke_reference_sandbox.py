"""The reference smoke has to be honest evidence or refuse.

It is the only hosted check that scores a known-good submission without
fetching a repository, so a pass is read as "this image evaluates offline".
That reading is wrong if any sandbox had network, if a published name was
resolved instead of the given id, if the reference reached the image before
the image was compared with this checkout, or if a sandbox outlived the run.
These tests pin each of those, plus the local refusals that must happen before
anything is billed.

Nothing here touches Modal. `modal` and `modal_app` are stood in for, because
neither is importable where these tests run.
"""

from __future__ import annotations

import contextlib
import io
import json
import math
import sys
import tarfile
import tempfile
import types
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "tools"))
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))

import smoke_reference_sandbox as smoke  # noqa: E402
from cogworks_runner.failure import RunnerFailure  # noqa: E402

IMAGE_ID = "im-ZifONoo1Zzk4nHasqRblTZ"
HEAD = "17d26d9aad6ee571442197c46294ce6d1a5ce070"
TRACK = smoke.TRACKS["language-search"]


def _row(**changes):
    row = {
        "id": "language-search", "version": 1, "contract_version": "cogworks.submissions.v2",
        "plugin_version": "0.1.0", "scorer_version": "retrieval-v4", "sandbox_contract": 2,
        # Columns a `SELECT *` also returns, which are not read.
        "title": "Language search", "active": 1, "dataset_version": "language-search-official-v1",
    }
    row.update(changes)
    return row


class CatalogRow(unittest.TestCase):
    def test_reads_only_the_named_columns_of_a_whole_row(self):
        self.assertEqual(
            set(smoke.read_catalog_row(_row(), "language-search")), set(smoke.CATALOG_COLUMNS)
        )

    def test_refuses_a_row_missing_a_column(self):
        row = _row()
        del row["scorer_version"]
        with self.assertRaisesRegex(smoke.SmokeError, "scorer_version"):
            smoke.read_catalog_row(row, "language-search")

    def test_refuses_a_row_for_another_benchmark(self):
        with self.assertRaisesRegex(smoke.SmokeError, "audio-identification"):
            smoke.read_catalog_row(_row(id="audio-identification"), "language-search")

    def test_refuses_a_contract_a_run_could_not_be_dispatched_against(self):
        for value in (None, 0, True, "2", 2.0):
            with self.subTest(value=value), self.assertRaises(smoke.SmokeError):
                smoke.read_catalog_row(_row(sandbox_contract=value), "language-search")

    def test_refuses_anything_but_one_object(self):
        with self.assertRaises(smoke.SmokeError):
            smoke.read_catalog_row([_row()], "language-search")


class PluginAgreement(unittest.TestCase):
    PLUGIN = types.SimpleNamespace(
        benchmark_version=1, contract_version="cogworks.submissions.v2",
        plugin_version="0.1.0", scorer_version="retrieval-v4",
    )

    def test_a_matching_plugin_passes(self):
        smoke.check_plugin(smoke.read_catalog_row(_row(), "language-search"), self.PLUGIN)

    def test_names_every_column_that_disagrees(self):
        row = smoke.read_catalog_row(_row(scorer_version="retrieval-v3", plugin_version="0.0.9"), "language-search")
        with self.assertRaises(smoke.SmokeError) as caught:
            smoke.check_plugin(row, self.PLUGIN)
        self.assertIn("scorer_version", str(caught.exception))
        self.assertIn("plugin_version", str(caught.exception))


class Job(unittest.TestCase):
    def test_the_job_carries_the_catalog_values_and_clears_the_runner_validator(self):
        job = smoke.build_job(smoke.read_catalog_row(_row(), "language-search"), IMAGE_ID, HEAD, TRACK)
        self.assertEqual(job["mode"], "practice")
        self.assertIsNone(job["preparedArtifactId"])
        self.assertEqual(job["weights"], [])
        self.assertEqual(job["benchmark"]["datasetVersion"], "practice-v1")
        self.assertEqual(job["benchmark"]["sandboxContract"], 2)
        self.assertEqual(job["benchmark"]["scorerVersion"], "retrieval-v4")
        self.assertEqual(job["runtime"]["imageDigest"], IMAGE_ID)
        self.assertEqual(job["source"]["sha"], HEAD)

    def test_a_job_the_runner_would_refuse_is_refused_locally(self):
        with self.assertRaisesRegex(smoke.SmokeError, "refuses this job"):
            smoke.build_job(smoke.read_catalog_row(_row(), "language-search"), IMAGE_ID, HEAD[:39], TRACK)


class SourceIdentity(unittest.TestCase):
    def _git(self, porcelain="", pinned="tree-sdk"):
        calls = []

        def git(*args):
            calls.append(args)
            if args[0] == "status":
                return porcelain
            if args[:2] == ("rev-parse", "064400e:python/cogbench/src"):
                return pinned
            if args[:2] == ("rev-parse", "HEAD:python/cogbench/src"):
                return "tree-sdk"
            return "value-of-" + args[-1]

        return git, calls

    def test_checks_every_compared_path_is_clean(self):
        git, calls = self._git()
        identity = smoke.source_identity(TRACK, "064400e", git)
        status = next(call for call in calls if call[0] == "status")
        for path in ("python/cogbench/src", "apps/runner-modal/src", TRACK.submodule, TRACK.reference):
            self.assertIn(path, status)
        self.assertIn("--untracked-files=all", status)
        self.assertEqual(identity["sdkTree"], "tree-sdk")

    def test_refuses_uncommitted_or_untracked_changes(self):
        git, _calls = self._git(porcelain="?? apps/runner-modal/src/cogworks_runner/new.py")
        with self.assertRaisesRegex(smoke.SmokeError, "no commit holds"):
            smoke.source_identity(TRACK, "064400e", git)

    def test_refuses_an_sdk_tree_that_is_not_the_pinned_commits(self):
        git, _calls = self._git(pinned="tree-other")
        with self.assertRaisesRegex(smoke.SmokeError, "064400e"):
            smoke.source_identity(TRACK, "064400e", git)


class ImportRoots(unittest.TestCase):
    def test_refuses_a_module_imported_from_another_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            elsewhere = types.SimpleNamespace(__file__=str(Path(directory) / "cogbench" / "__init__.py"))
            with self.assertRaisesRegex(smoke.SmokeError, "outside"):
                smoke.check_import_roots({"cogbench": elsewhere})

    def test_records_where_each_module_resolved(self):
        inside = types.SimpleNamespace(__file__=str(ROOT / "python" / "cogbench" / "src" / "cogbench" / "__init__.py"))
        self.assertEqual(
            smoke.check_import_roots({"cogbench": inside}),
            {"cogbench": "python/cogbench/src/cogbench/__init__.py"},
        )


class Archive(unittest.TestCase):
    def _tree(self, directory):
        root = Path(directory)
        (root / "pkg").mkdir()
        (root / "submission.py").write_text("x = 1\n")
        (root / "pkg" / "__init__.py").write_text("")
        return root, ["pkg/__init__.py", "submission.py"]

    def test_is_byte_identical_for_identical_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root, files = self._tree(directory)
            self.assertEqual(
                smoke.reference_archive(root, files, "reference"),
                smoke.reference_archive(root, files, "reference"),
            )

    def test_passes_the_prepare_scripts_archive_rules(self):
        """One project root, regular files and directories only, nothing escaping."""

        with tempfile.TemporaryDirectory() as directory:
            root, files = self._tree(directory)
            archive = smoke.reference_archive(root, files, "reference")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
            members = bundle.getmembers()
        self.assertTrue(all(member.isfile() or member.isdir() for member in members))
        self.assertEqual({member.name.split("/")[0] for member in members}, {"reference"})
        self.assertEqual(
            sorted(member.name for member in members if member.isfile()),
            ["reference/pkg/__init__.py", "reference/submission.py"],
        )
        self.assertFalse(any(member.name.startswith("/") or ".." in member.name.split("/") for member in members))

    def test_refuses_a_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root, files = self._tree(directory)
            (root / "link.py").symlink_to(root / "submission.py")
            with self.assertRaisesRegex(smoke.SmokeError, "regular file"):
                smoke.reference_archive(root, files + ["link.py"], "reference")

    def test_the_prepare_scripts_download_loop_reads_a_file_url(self):
        """PREPARE_SCRIPT fetches with a Request carrying headers and reads Content-Length."""

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reference.tar.gz"
            path.write_bytes(b"x" * 3000)
            request = urllib.request.Request("file://" + str(path), headers={"User-Agent": "cogworks-runner"})
            with urllib.request.urlopen(request, timeout=30) as response:
                declared = int(response.headers.get("Content-Length", "0"))
                body = response.read()
        self.assertEqual((declared, len(body)), (3000, 3000))

    def test_the_real_references_are_tracked_files_only(self):
        for track in smoke.TRACKS.values():
            with self.subTest(track=track.reference):
                files = smoke.reference_files(track)
                self.assertFalse(any(".egg-info" in path or "__pycache__" in path for path in files))


# ---------------------------------------------------------------------------
# The remote part, against stand-ins for modal and modal_app.
# ---------------------------------------------------------------------------


class Stream:
    def __init__(self, text):
        self.text = text

    def read(self):
        return self.text


class Process:
    def __init__(self, returncode=0, stderr=""):
        self.returncode = returncode
        self.stderr = Stream(stderr)

    def wait(self):
        return self.returncode


class World:
    """Records every sandbox, write, exec and termination, in order."""

    def __init__(self, network_exit=1, prepare_exit=0, prepare_stderr=""):
        self.events = []
        self.sandboxes = []
        self.network_exit = network_exit
        self.prepare_exit = prepare_exit
        self.prepare_stderr = prepare_stderr
        self.terminate_raises = False


class Sandbox:
    def __init__(self, world, image, kwargs):
        self.world = world
        self.object_id = "sb-{}".format(len(world.sandboxes))
        self.image = image
        self.kwargs = kwargs
        self.terminated = 0
        world.sandboxes.append(self)
        self.filesystem = types.SimpleNamespace(
            write_bytes=lambda data, path: world.events.append(("write", self.object_id, path)),
            write_text=lambda data, path: world.events.append(("write", self.object_id, path)),
            read_text=lambda path: "file:benchmark_adapter.py\n",
        )

    def exec(self, *args, text=True):
        self.world.events.append(("exec", self.object_id, args))
        if "-c" in args:
            return Process(self.world.network_exit, "OSError: [Errno 101] Network is unreachable\n")
        if smoke.PREPARE_REMOTE_PATH in args:
            return Process(self.world.prepare_exit, self.world.prepare_stderr.encode("utf-8"))
        return Process(0)

    def snapshot_filesystem(self, ttl=None):
        self.world.events.append(("snapshot", self.object_id, ttl))
        return types.SimpleNamespace(object_id="im-snapshot")

    def terminate(self):
        self.terminated += 1
        self.world.events.append(("terminate", self.object_id))
        if self.world.terminate_raises:
            raise RuntimeError("terminate failed")


def fake_modal(world):
    class SandboxClass:
        @staticmethod
        def create(*args, **kwargs):
            world.events.append(("create", kwargs.get("image")))
            return Sandbox(world, kwargs.get("image"), kwargs)

    class ImageClass:
        @staticmethod
        def from_id(value):
            return "image:" + value

        @staticmethod
        def from_name(value):
            return "named:" + value

    return types.SimpleNamespace(
        App=lambda name: types.SimpleNamespace(name=name),
        enable_output=contextlib.nullcontext,
        runner=types.SimpleNamespace(run_app=lambda app: contextlib.nullcontext()),
        Sandbox=SandboxClass,
        Image=ImageClass,
    )


def _evaluator(modal, world, **create_changes):
    """Stands in for `_evaluate_week3`: creates its own sandbox the way the runner does."""

    def evaluate(job, snapshot_id, cases):
        world.events.append(("evaluate", snapshot_id, runner_app_holder[0].app))
        kwargs = dict(image=modal.Image.from_id(snapshot_id), app=runner_app_holder[0].app,
                      cpu=(0.5, 1), memory=(512, 4096), timeout=900, block_network=True)
        kwargs.update(create_changes)
        sandbox = modal.Sandbox.create(**kwargs)
        try:
            return [{"ok": True}], "student python 3.8.20\n"
        finally:
            sandbox.terminate()

    runner_app_holder = [None]
    return evaluate, runner_app_holder


def fake_runner(evaluate):
    return types.SimpleNamespace(
        app="runner-app",
        PREPARE_SCRIPT="prepare script",
        RunnerFailure=RunnerFailure,
        _last_error_line=lambda text: text.strip().splitlines()[-1] if text.strip() else "",
        _evaluate_week3=evaluate,
    )


def _plan():
    return smoke.Plan(
        "language-search", IMAGE_ID, 2,
        smoke.build_job(smoke.read_catalog_row(_row(), "language-search"), IMAGE_ID, HEAD, TRACK),
        {}, b"archive", ["case"], "_evaluate_week3", ["case"],
    )


RECEIPT = {
    "imageId": IMAGE_ID,
    "observation": {"pythonVersion": "3.8.20", "sandboxContract": 2, "sdkVersion": "0.2.0", "modules": []},
    "importedModuleRoots": {"cogbench": "sdk"},
    "sourceManifests": {"sdk": {"root": "/opt/cogbench/cogbench", "files": [{"path": "a.py", "sha256": "a" * 64}]}},
}


class Remote(unittest.TestCase):
    def _run(self, world, evaluate=None, receipt=RECEIPT, observe=None, as_provider_failure=False,
             **create_changes):
        modal = fake_modal(world)
        default, holder = _evaluator(modal, world, **create_changes)
        if as_provider_failure:
            # What every runner evaluator does with an exception it did not raise itself.
            inner = default

            def default(job, snapshot_id, cases):
                try:
                    return inner(job, snapshot_id, cases)
                except Exception as error:
                    raise RunnerFailure("provider", "evaluating", "Evaluation provider failed.", True) from error

        runner = fake_runner(evaluate or default)
        holder[0] = runner

        def observing(sandbox, benchmark_id, image_id):
            world.events.append(("observe", sandbox.object_id))
            if observe:
                observe()
            return {"observation": {}, "manifests": {}}

        def receipt_from(*args):
            if isinstance(receipt, Exception):
                raise receipt
            return receipt

        self.evidence = {}
        with mock.patch.object(smoke.probe, "observe_sandbox", observing), \
                mock.patch.object(smoke.probe, "receipt_from", receipt_from):
            try:
                result = smoke.run_remote(_plan(), modal, runner, lambda line: None, self.evidence)
            finally:
                self.assertEqual(runner.app, "runner-app", "the runner's app must be restored")
                self.assertEqual(modal.Image.from_name("x"), "named:x", "from_name must be restored")
        result["evidence"] = self.evidence
        return result

    def test_a_clean_run_uses_the_exact_image_and_blocks_network_everywhere(self):
        world = World()
        result = self._run(world)
        staging, evaluation = world.sandboxes
        self.assertEqual(staging.image, "image:" + IMAGE_ID)
        self.assertEqual(evaluation.image, "image:im-snapshot")
        for sandbox in world.sandboxes:
            self.assertIs(sandbox.kwargs["block_network"], True)
            self.assertNotIn("outbound_domain_allowlist", sandbox.kwargs)
        self.assertEqual(result["evidence"]["snapshotImageId"], "im-snapshot")
        self.assertEqual(result["evidence"]["resolvedBy"], "file:benchmark_adapter.py")
        self.assertIn("Network is unreachable", result["evidence"]["outboundConnection"])

    def test_the_evaluator_runs_attached_to_the_smoke_app(self):
        world = World()
        self._run(world)
        evaluate = next(event for event in world.events if event[0] == "evaluate")
        self.assertEqual(evaluate[2].name, smoke.SMOKE_APP)

    def test_the_image_is_checked_and_the_network_tested_before_the_reference_arrives(self):
        world = World()
        self._run(world)
        order = [event[0] if event[0] != "exec" else ("network" if "-c" in event[2] else "exec") for event in world.events]
        first_write = next(i for i, event in enumerate(world.events)
                           if event[0] == "write" and event[2] == smoke.ARCHIVE_REMOTE_PATH)
        self.assertLess(order.index("observe"), first_write)
        self.assertLess(order.index("network"), first_write)

    def test_the_prepare_script_reads_the_upload_through_a_file_url(self):
        world = World()
        self._run(world)
        prepare = next(event for event in world.events
                       if event[0] == "exec" and smoke.PREPARE_REMOTE_PATH in event[2])
        self.assertIn("file://" + smoke.ARCHIVE_REMOTE_PATH, prepare[2])
        self.assertEqual(prepare[2][-1], "[]")

    def test_the_snapshot_expires_rather_than_keeping_the_reference_for_a_month(self):
        world = World()
        self._run(world)
        snapshot = next(event for event in world.events if event[0] == "snapshot")
        self.assertEqual(snapshot[2], smoke.SNAPSHOT_TTL_SECONDS)

    def test_every_sandbox_is_terminated_on_success(self):
        world = World()
        result = self._run(world)
        self.assertTrue(all(sandbox.terminated >= 1 for sandbox in world.sandboxes))
        self.assertEqual(
            [attempt["sandbox"] for attempt in result["evidence"]["cleanup"]],
            [sandbox.object_id for sandbox in world.sandboxes],
        )
        self.assertTrue(smoke.cleanup_confirmed(result["evidence"]))

    def test_a_failed_terminate_after_a_good_run_is_recorded_not_hidden(self):
        world = World()

        def evaluate_then_lose_the_api(job, snapshot_id, cases):
            # Scoring succeeded; only the smoke's own final terminate calls fail.
            world.terminate_raises = True
            return [{"ok": True}], "student python 3.8.20\n"

        result = self._run(world, evaluate=evaluate_then_lose_the_api)
        self.assertFalse(smoke.cleanup_confirmed(result["evidence"]))
        failed = [attempt for attempt in result["evidence"]["cleanup"] if not attempt["terminated"]]
        self.assertTrue(failed)
        self.assertIn("terminate failed", failed[0]["error"])

    def _fails(self, world, stage, **kwargs):
        with self.assertRaises(smoke.SmokeError) as caught:
            self._run(world, **kwargs)
        self.assertEqual(caught.exception.stage, stage, str(caught.exception))
        self.assertTrue(all(sandbox.terminated >= 1 for sandbox in world.sandboxes),
                        "a sandbox was left running")
        return caught.exception

    def test_an_image_that_is_not_this_checkout_stops_before_the_upload(self):
        world = World()
        self._fails(world, "provenance", receipt=smoke.probe.ProbeError("The sdk package differs."))
        self.assertFalse(any(event[0] == "write" for event in world.events))

    def test_a_sandbox_that_reaches_the_network_stops_before_the_upload(self):
        world = World(network_exit=0)
        self._fails(world, "network")
        self.assertFalse(any(event[0] == "write" for event in world.events))

    def test_a_refused_prepare_names_the_reason_and_takes_no_snapshot(self):
        world = World(prepare_exit=1, prepare_stderr="Traceback\nRuntimeError: Source archive contains an unsafe path.\n")
        error = self._fails(world, "prepare")
        self.assertIn("unsafe path", str(error))
        self.assertFalse(any(event[0] == "snapshot" for event in world.events))

    def test_an_evaluator_that_asks_for_network_is_refused_before_modal_is_asked(self):
        """The runner would report this as 'Evaluation provider failed.' and lose the reason."""

        world = World()
        self._fails(world, "network", as_provider_failure=True, block_network=False)
        self.assertEqual(len(world.sandboxes), 1, "the network sandbox must never be created")

    def test_an_allowlist_counts_as_network(self):
        world = World()
        self._fails(world, "network", as_provider_failure=True, block_network=False,
                    outbound_domain_allowlist=["pypi.org"])
        self.assertEqual(len(world.sandboxes), 1)

    def test_a_published_name_is_never_resolved(self):
        world = World()

        def evaluate(job, snapshot_id, cases):
            try:
                world_modal_holder[0].Image.from_name("cogworks-runner-week3")
            except Exception as error:
                raise RunnerFailure("provider", "evaluating", "Evaluation provider failed.", True) from error
            return [], ""

        world_modal_holder = [None]
        modal = fake_modal(world)
        world_modal_holder[0] = modal
        runner = fake_runner(evaluate)
        with mock.patch.object(smoke.probe, "observe_sandbox", lambda *a: {}), \
                mock.patch.object(smoke.probe, "receipt_from", lambda *a: RECEIPT), \
                self.assertRaises(smoke.SmokeError) as caught:
            smoke.run_remote(_plan(), modal, runner, lambda line: None, {})
        self.assertEqual(caught.exception.stage, "provenance")

    def test_a_student_failure_keeps_its_category_and_still_cleans_up(self):
        world = World()

        def evaluate(job, snapshot_id, cases):
            raise RunnerFailure("student_runtime", "evaluating", "Your code raised ValueError.", False)

        with self.assertRaises(RunnerFailure) as caught:
            self._run(world, evaluate=evaluate)
        self.assertEqual(caught.exception.category, "student_runtime")
        self.assertTrue(all(sandbox.terminated >= 1 for sandbox in world.sandboxes))

    def test_a_failing_terminate_does_not_replace_the_original_failure(self):
        world = World(network_exit=0)
        world.terminate_raises = True
        with self.assertRaises(smoke.SmokeError) as caught:
            self._run(world)
        self.assertEqual(caught.exception.stage, "network")
        self.assertFalse(smoke.cleanup_confirmed(self.evidence))

    def test_a_failed_run_still_records_its_cleanup(self):
        world = World(prepare_exit=1, prepare_stderr="RuntimeError: Source archive contains an unsafe path.\n")
        with self.assertRaises(smoke.SmokeError):
            self._run(world)
        self.assertEqual(len(self.evidence["cleanup"]), 1)
        self.assertTrue(smoke.cleanup_confirmed(self.evidence))


BENCHMARK = types.SimpleNamespace(primary_metric="overall")


class Scoring(unittest.TestCase):
    def _runner(self, metrics, checked=None):
        def check(benchmark, predictions, count):
            if checked is not None:
                checked.append(count)

        rows = [types.SimpleNamespace(to_wire=lambda row=row: row) for row in metrics]
        return types.SimpleNamespace(
            check_predictions=check,
            _v2_metrics=lambda benchmark, predictions, cases: (rows, ["note one"]),
            _diagnostic_lines=lambda item: [item],
            _sweep_wire=lambda benchmark: None,
            _WIRING=[],
        )

    def test_scores_through_the_controllers_own_checks(self):
        checked = []
        runner = self._runner([{"key": "overall", "value": 0.43, "primary": True}], checked)
        outcome = smoke.score(runner, BENCHMARK, ["a", "b"], [{"ok": True}, {"ok": True}])
        self.assertEqual(checked, [2])
        self.assertEqual(outcome["caseCount"], 2)
        self.assertEqual(outcome["diagnostics"], ["note one"])
        self.assertEqual(len(outcome["outputDigest"]), 64)

    def test_refuses_a_number_that_is_not_finite(self):
        for value in (math.nan, math.inf):
            with self.subTest(value=value), self.assertRaisesRegex(smoke.SmokeError, "overall"):
                smoke.score(self._runner([{"key": "overall", "value": value, "primary": True}]),
                            BENCHMARK, ["a"], [{}])

    def test_refuses_no_metrics_and_no_primary(self):
        with self.assertRaises(smoke.SmokeError):
            smoke.score(self._runner([]), BENCHMARK, ["a"], [{}])
        with self.assertRaisesRegex(smoke.SmokeError, "primary"):
            smoke.score(self._runner([{"key": "overall", "value": 0.4, "primary": False}]),
                        BENCHMARK, ["a"], [{}])

    def test_refuses_a_run_scored_under_a_substitute_primary(self):
        """Week 3 withholds the image side and promotes text_mrr when it never ran."""

        runner = self._runner([
            {"key": "text_mrr", "value": 0.6, "primary": True},
            {"key": "chance_mrr", "value": 0.01, "primary": False},
        ])
        with self.assertRaisesRegex(smoke.SmokeError, "not measured"):
            smoke.score(runner, BENCHMARK, ["a"], [{}])

    def test_a_refused_prediction_shape_propagates_as_the_runners_failure(self):
        runner = self._runner([{"key": "overall", "value": 0.4, "primary": True}])

        def check(benchmark, predictions, count):
            raise RunnerFailure("student_runtime", "evaluating", "Wrong number of outputs.", False)

        runner.check_predictions = check
        with self.assertRaises(RunnerFailure):
            smoke.score(runner, BENCHMARK, ["a"], [{}])


class CommandLine(unittest.TestCase):
    def _arguments(self, directory, **changes):
        row = Path(directory) / "row.json"
        row.write_text(json.dumps(_row()))
        values = {
            "--benchmark": "language-search", "--image-id": IMAGE_ID,
            "--catalog-row": str(row), "--sdk-commit": "064400e",
            "--result": str(Path(directory) / "result.json"),
        }
        values.update(changes)
        return [item for pair in values.items() for item in pair]

    def _main(self, argv):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
            status = smoke.main(argv)
        return status, stderr.getvalue()

    def test_an_occupied_result_path_is_refused_before_anything_else(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "result.json").write_text("earlier evidence")
            with mock.patch.object(smoke, "_load_runner", side_effect=AssertionError("too far")):
                status, said = self._main(self._arguments(directory))
            self.assertEqual(status, 1)
            self.assertIn("never overwritten", said)
            self.assertEqual((Path(directory) / "result.json").read_text(), "earlier evidence")

    def test_a_published_name_is_refused_before_any_sandbox_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(smoke, "_load_runner", side_effect=AssertionError("imported modal_app")), \
                mock.patch.object(smoke, "run_remote", side_effect=AssertionError("billed")):
            status, said = self._main(self._arguments(directory, **{"--image-id": "cogworks-runner-week3"}))
            self.assertEqual(status, 1)
            self.assertIn("immutable image id", said)
            self.assertFalse((Path(directory) / "result.json").exists())

    def test_a_catalog_contract_the_source_does_not_declare_is_refused_locally(self):
        with tempfile.TemporaryDirectory() as directory:
            row = Path(directory) / "row.json"
            arguments = self._arguments(directory)
            row.write_text(json.dumps(_row(sandbox_contract=1)))
            with mock.patch.object(smoke, "_load_runner", side_effect=AssertionError("imported modal_app")), \
                    mock.patch.object(smoke, "run_remote", side_effect=AssertionError("billed")):
                status, said = self._main(arguments)
            self.assertEqual(status, 1)
            self.assertIn("sandbox contract", said)

    def test_an_environment_without_modal_is_a_refusal_not_a_traceback(self):
        # The plugin is stood in for, so this runs where the benchmark
        # submodule is absent (CI's week1/week2 lanes have no Week 3 package).
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(smoke, "source_identity", return_value={"head": HEAD}), \
                mock.patch.object(smoke, "load_benchmark", return_value=PluginAgreement.PLUGIN), \
                mock.patch.object(smoke, "_load_runner", side_effect=ImportError("No module named 'modal'")):
            status, said = self._main(self._arguments(directory))
            self.assertEqual(status, 1)
            self.assertIn(".venv-deploy", said)
            self.assertFalse((Path(directory) / "result.json").exists())

    def test_a_missing_benchmark_plugin_is_a_refusal_not_a_traceback(self):
        missing = smoke.PluginError("No installed benchmark plugin named 'language-search'.")
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.object(smoke, "source_identity", return_value={"head": HEAD}), \
                mock.patch.object(smoke, "load_benchmark", side_effect=missing), \
                mock.patch.object(smoke, "_load_runner", side_effect=AssertionError("imported modal_app")):
            status, said = self._main(self._arguments(directory))
            self.assertEqual(status, 1)
            self.assertIn("language-search plugin isn't importable", said)
            self.assertIn("benchmarks/week3", said)
            self.assertNotIn("Traceback", said)
            self.assertFalse((Path(directory) / "result.json").exists())

    def test_a_score_with_unconfirmed_cleanup_is_incomplete_not_passed(self):
        def remote(plan, modal, runner, say, evidence):
            evidence["cleanup"] = [
                {"sandbox": "sb-0", "terminated": True},
                {"sandbox": "sb-1", "terminated": False, "error": "RuntimeError: gone"},
            ]
            return {"predictions": [{}], "log": "student python 3.8.20\n"}

        prepared = {
            "plan": _plan(), "runner": types.SimpleNamespace(RunnerFailure=RunnerFailure),
            "benchmark": object(), "record": {},
        }
        fake = types.SimpleNamespace(__version__="1.5.4", runner=types.SimpleNamespace())
        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.dict(sys.modules, {"modal": fake, "modal.runner": fake.runner}), \
                mock.patch.object(smoke, "prepare_plan", return_value=prepared), \
                mock.patch.object(smoke, "run_remote", remote), \
                mock.patch.object(smoke, "score", return_value={"metrics": [
                    {"key": "overall", "value": 0.1, "primary": True}]}):
            status, _said = self._main(self._arguments(directory))
            result = json.loads((Path(directory) / "result.json").read_text())
        self.assertEqual(status, 1)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["failure"]["stage"], "cleanup")
        self.assertIn("outcome", result)

    def test_only_tracks_with_a_current_reference_are_offered(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(SystemExit):
            self._main(self._arguments(directory, **{"--benchmark": "vision-recognition"}))


if __name__ == "__main__":
    unittest.main()
