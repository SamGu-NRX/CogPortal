"""Local commands may mutate their copy, never the student's resource bytes."""
from __future__ import annotations

import errno
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing, contextmanager, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from cogbench import cli, execution, isolate, memo, runner
from cogbench.discovery_spec import DiscoverySpec
from cogbench.models import RepositoryState


DECLARED = '''
from contextlib import closing
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parent
assert Path.cwd() == ROOT, "student cwd must be the private root"
with closing(sqlite3.connect(str(ROOT / "existing.sqlite"))) as db, db:
    db.execute("UPDATE state SET value = value + 1")
(ROOT / "import-root.txt").write_text(str(ROOT))

def create_submission(*args, **kwargs):
    def predict(value):
        assert ROOT.is_dir()
        assert (ROOT / "import-root.txt").read_text() == str(ROOT)
        with closing(sqlite3.connect(str(ROOT / "existing.sqlite"))) as db, db:
            before = db.execute("SELECT value FROM state").fetchone()[0]
            assert before == 11, before
            db.execute("UPDATE state SET value = value + 1")
        (ROOT / "later.txt").write_text("scored")
        return {"value": value, "root": str(ROOT)}
    return predict
'''


class TinyBenchmark:
    benchmark_id = "fixture"
    benchmark_version = 1
    contract_version = "cogworks.submissions.v2"
    plugin_version = "0.0.1"
    primary_metric = "correct"

    def __init__(self, original):
        self.original = original

    def cache_status(self, tier):
        return SimpleNamespace(ready=True, path=self.original, message="fixture")

    def model_cache_status(self):
        return {"ready": True, "message": "fixture has no model"}

    def model_factory(self):
        return None

    def load_cases(self, tier):
        return [1 if tier == "test" else 2]

    def run(self, factory, model, cases):
        adapter = factory()
        return [adapter(case) for case in cases]

    def score(self, outputs, cases):
        copied = Path(outputs[0]["root"])
        assert copied != self.original
        assert copied.is_dir(), "copy removed before scoring"
        assert (copied / "later.txt").read_text() == "scored"
        with closing(sqlite3.connect(str(copied / "existing.sqlite"))) as db, db:
            assert db.execute("SELECT value FROM state").fetchone()[0] == 12
        assert [output["value"] for output in outputs] == cases
        self.last_diagnostics = ["scored in {}".format(copied)]
        return {"correct": 1.0}


class TinyDiscoveryBenchmark(TinyBenchmark):
    def discovery(self):
        # Reuse the arithmetic-only mini-week used by the resolver's own tests.
        from test_resolve import ROLE, FIXTURE, _accepts, _arrangements

        def prepare(root, modules):
            weights = root / "weights.bin"
            assert weights.read_bytes() == b"tiny weights"
            return {"weights_used": [str(weights)]}

        return DiscoverySpec(ROLE, FIXTURE, _accepts, _arrangements, prepare=prepare)

    def submission_from_discovery(self, submission):
        return submission


class TinyProject(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="cogbench-execution-test-")
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name).resolve()
        self.root = self.workspace / "student"
        self.root.mkdir()
        self.copies = []
        real_private_project = execution.private_project

        @contextmanager
        def tracked(root):
            # A mistaken cwd must fail before it can copy the test suite or /tmp.
            self.assertEqual(Path(root).resolve(), self.root)
            with real_private_project(root) as paths:
                self.copies.append(paths.execution)
                yield paths

        for target, name, value in (
            (cli, "private_project", tracked),
            (cli, "load_benchmark", lambda name: TinyBenchmark(self.root)),
            (cli, "plugin_names", lambda group: ["fixture"] if group == "cogworks.benchmarks.v2" else []),
        ):
            replacement = patch.object(target, name, value)
            replacement.start()
            self.addCleanup(replacement.stop)

    def declared_project(self):
        import_guard = (
            '\nimport sys\n'
            'original = Path({!r})\n'
            'assert all(Path(entry or Path.cwd()).resolve() != original and '\
            'original not in Path(entry or Path.cwd()).resolve().parents for entry in sys.path)\n'
        ).format(str(self.root))
        (self.root / "submission.py").write_text(DECLARED + import_guard)
        with closing(sqlite3.connect(str(self.root / "existing.sqlite"))) as db, db:
            db.execute("CREATE TABLE state(value INTEGER)")
            db.execute("INSERT INTO state VALUES (10)")
        self.original_bytes = (self.root / "existing.sqlite").read_bytes()

    def main(self, command, backend):
        previous = Path.cwd()
        output = io.StringIO()
        try:
            os.chdir(str(self.root))
            with patch.object(isolate, "_isolation_backend", return_value=backend), redirect_stdout(output):
                code = cli.main([command, "--benchmark", "fixture", "--json"])
        finally:
            os.chdir(str(previous))
        return code, json.loads(output.getvalue())

    def assert_clean(self):
        self.assertEqual((self.root / "existing.sqlite").read_bytes(), self.original_bytes)
        for name in ("later.txt", "import-root.txt", "existing.sqlite-journal", "existing.sqlite-wal"):
            self.assertFalse((self.root / name).exists(), name)
        for copied in self.copies:
            self.assertFalse(copied.parent.exists(), str(copied))

    def identity(self, root):
        self.assertEqual(root, self.root, "git identity must come from the original")
        return RepositoryState(123, "students/tiny", "a" * 40, False)


class LocalCommands(TinyProject):
    def test_failure_names_the_original_resource_not_the_removed_copy(self):
        self.declared_project()

        def missing_resource(*args, **kwargs):
            raise FileNotFoundError(str(Path.cwd() / 'missing-resource.bin'))

        backends = [None] + ([isolate.run_isolated] if hasattr(os, 'fork') else [])
        for backend in backends:
            with self.subTest(backend=backend), patch.object(cli, 'execute', side_effect=missing_resource):
                code, record = self.main('run', backend)
            self.assertEqual(code, 2)
            self.assertIn(str(self.root / 'missing-resource.bin'), record['detail'])
            self.assertNotIn('cogworks-execution-', record['detail'])
            self.assert_clean()

    def test_no_fork_check_test_and_run_preserve_existing_database(self):
        self.exercise_commands(None)

    @unittest.skipUnless(hasattr(os, "fork"), "requires fork")
    def test_fork_check_test_and_run_preserve_existing_database(self):
        self.exercise_commands(isolate.run_isolated)

    def exercise_commands(self, backend):
        self.declared_project()
        previous_path = list(sys.path)
        self.addCleanup(setattr, sys, 'path', previous_path)
        sys.path[:0] = [str(self.root), str(self.root / 'nested'), '']
        cwd, import_path = Path.cwd(), list(sys.path)
        for command in ("check", "test", "run"):
            with self.subTest(command=command), \
                    patch.object(cli, "repository_state", side_effect=self.identity), \
                    patch.object(runner, "repository_state", side_effect=self.identity):
                code, record = self.main(command, backend)
                self.assertEqual(code, 0, record)
                self.assert_clean()
                self.assertNotIn("cogworks-execution-", json.dumps(record))
                self.assertEqual(Path.cwd(), cwd)
                self.assertEqual(sys.path, import_path)
                if command == "check":
                    self.assertTrue(record["submissionLoadable"])
                    self.assertEqual(record["submissionSource"], "file")
                else:
                    self.assertEqual(record["repositoryFullName"], "students/tiny")
                    self.assertEqual(record["sha"], "a" * 40)
                    self.assertEqual(record["metrics"][0]["value"], 1.0)
                    reports = list((self.root / ".cogbench" / "reports").glob("*.json"))
                    self.assertTrue(reports)
                    saved = [json.loads(path.read_text()) for path in reports]
                    self.assertIn(record["reportId"], [item["reportId"] for item in saved])
        self.assertEqual(len(self.copies), 3)
        self.assertEqual(len(set(self.copies)), 3)

    @unittest.skipUnless(hasattr(os, "fork"), "requires fork")
    def test_child_exit_cleans_copy_for_every_command(self):
        self.declared_project()
        (self.root / "submission.py").write_text(DECLARED + "\nimport os\nos._exit(23)\n")
        for command in ("check", "test", "run"):
            with self.subTest(command=command):
                code, record = self.main(command, isolate.run_isolated)
                self.assertEqual(code, 2)
                self.assertEqual(record.get("status", record.get("isolationDetail", {}).get("status")), "crashed")
                self.assert_clean()
                self.assertFalse((self.root / ".cogbench" / "reports").exists())

    def test_no_fork_exception_cleans_copy(self):
        self.declared_project()
        for failure in (RuntimeError("fixture failure"), SystemExit("fixture failure")):
            with self.subTest(failure=type(failure).__name__), \
                    patch.object(cli, "_run_view", side_effect=failure):
                code, record = self.main("run", None)
            self.assertEqual(code, 2)
            self.assertEqual(record["status"], isolate.RAISED)
            self.assertIn("fixture failure", record["detail"])
            self.assert_clean()

    def test_enospc_refuses_before_import_and_cleans_partial_copy(self):
        self.declared_project()
        partial = self.workspace / "partial"

        def fail_copy(source, destination, **kwargs):
            Path(destination).mkdir()
            (Path(destination) / "partial.bin").write_bytes(b"partial")
            raise OSError(errno.ENOSPC, "No space left on device")

        for command in ("check", "test", "run"):
            with self.subTest(command=command):
                partial.mkdir()
                with patch.object(execution.tempfile, "mkdtemp", return_value=str(partial)), \
                        patch.object(execution.shutil, "copytree", side_effect=fail_copy), \
                        patch.object(cli, "_check_view") as check, \
                        patch.object(cli, "_run_view") as run:
                    code, record = self.main(command, None)
                self.assertEqual(code, 2)
                self.assertIn("No space left", json.dumps(record))
                self.assertIn("original was not run", json.dumps(record))
                check.assert_not_called()
                run.assert_not_called()
                self.assertFalse(partial.exists())
                self.assert_clean()

    @unittest.skipUnless(hasattr(os, "fork"), "requires fork")
    def test_discovery_memo_reuses_original_identity_and_invalidates_source_edit(self):
        from test_resolve import REPO

        (self.root / "theirs.py").write_text(REPO)
        (self.root / "weights.bin").write_bytes(b"tiny weights")
        with patch.object(cli, "load_benchmark", side_effect=lambda name: TinyDiscoveryBenchmark(self.root)), \
                patch.object(cli, "repository_state", side_effect=self.identity):
            keys = []
            for expected_recalled in (False, True, False):
                if len(keys) == 2:
                    source = self.root / "theirs.py"
                    source.write_text(source.read_text().replace("value * 2", "value * 3"))
                code, record = self.main("check", isolate.run_isolated)
                self.assertEqual(code, 0, record)
                discovery = record["discovery"]
                self.assertEqual(discovery["recalled"], expected_recalled)
                self.assertEqual(discovery["discovery"]["root"], str(self.root))
                self.assertEqual(discovery["weightsUsed"], [str(self.root / "weights.bin")])
                self.assertTrue(all(Path(path).is_file() for path in discovery["weightsUsed"]))
                self.assertNotIn("cogworks-execution-", json.dumps(record))
                cached = memo.cache_path(self.root).read_text()
                self.assertNotIn("cogworks-execution-", cached)
                keys.append(json.loads(cached)["key"])
                self.assertFalse(self.copies[-1].parent.exists())
        self.assertEqual(keys[0], keys[1])
        self.assertNotEqual(keys[1], keys[2])
        self.assertEqual(len(set(self.copies)), 3)


class PrivateLinks(TinyProject):
    def link(self, path, target, *, directory=False):
        try:
            path.symlink_to(target, target_is_directory=directory)
        except OSError as error:
            if os.name == 'nt' and getattr(error, 'winerror', None) == 1314:
                self.skipTest('Windows requires symlink privileges for this fixture')
            raise

    def test_environment_named_resource_folder_is_still_copied(self):
        resource_folder = self.root / 'env'
        resource_folder.mkdir()
        (resource_folder / 'data.bin').write_bytes(b'student resource')
        with execution.private_project(self.root) as paths:
            copied = paths.execution / 'env' / 'data.bin'
            self.assertEqual(copied.read_bytes(), b'student resource')
            copied.write_bytes(b'private change')
            self.assertEqual((resource_folder / 'data.bin').read_bytes(), b'student resource')

    def test_resolved_copy_paths_map_to_existing_original_resources(self):
        source = self.root / 'weights.bin'
        source.write_bytes(b'tiny weights')
        with execution.private_project(self.root) as paths:
            copied = (paths.execution / source.name).resolve()
            self.assertEqual(paths.source_path(copied), source)
            self.assertEqual(paths.describe({'weights': [str(copied)]}),
                             {'weights': [str(source)]})

    def test_ancestor_alias_is_not_expanded_and_absolute_write_stays_private(self):
        nested = self.root / "nested"
        nested.mkdir()
        resource = self.root / "resource.txt"
        resource.write_bytes(b"original")
        self.link(nested / "ancestor", self.root, directory=True)
        self.link(self.root / "absolute.txt", resource)
        with execution.private_project(self.root) as paths:
            ancestor = paths.execution / "nested" / "ancestor"
            alias = paths.execution / "absolute.txt"
            self.assertTrue(ancestor.is_symlink())
            self.assertEqual(ancestor.resolve(), paths.execution.resolve())
            self.assertTrue(alias.is_symlink())
            self.assertEqual(alias.resolve(), (paths.execution / "resource.txt").resolve())
            self.assertFalse(os.path.isabs(os.readlink(str(alias))))
            alias.write_bytes(b"private")
            self.assertEqual((ancestor / "resource.txt").read_bytes(), b"private")
            self.assertEqual(resource.read_bytes(), b"original")
            self.assertEqual(sum(len(files) for _, _, files in os.walk(str(paths.execution))), 2)
        self.assertFalse(paths.execution.parent.exists())

    def test_external_and_dangling_links_refuse_before_execution(self):
        self.declared_project()
        external = self.workspace / "outside.txt"
        external.write_bytes(b"outside")
        link = self.root / "alias"
        for target in (external, self.root / "missing"):
            self.link(link, target)
            try:
                for command in ("check", "test", "run"):
                    with self.subTest(target=target.name, command=command), \
                            patch.object(cli, "_check_view") as check, \
                            patch.object(cli, "_run_view") as run:
                        code, record = self.main(command, None)
                    self.assertEqual(code, 2)
                    self.assertIn("Cannot make a private execution copy", json.dumps(record))
                    check.assert_not_called()
                    run.assert_not_called()
                    self.assert_clean()
            finally:
                link.unlink()
        self.assertEqual(external.read_bytes(), b"outside")


if __name__ == "__main__":
    unittest.main()
