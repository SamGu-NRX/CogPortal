from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.apploader import (  # noqa: E402
    SubmissionFactoryMissing,
    SubmissionFileMissing,
    SubmissionImportFailed,
    factory_names,
    load_submission_file,
    resolve_submission_file,
)
from cogbench.plugins import PluginError, resolve_submission  # noqa: E402


class SubmissionFileTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="cogbench-apploader-")).resolve()
        self.addCleanup(shutil.rmtree, str(self.root), True)
        self._path = list(sys.path)
        self._modules = set(sys.modules)
        self.addCleanup(self._restore)

    def _restore(self):
        sys.path[:] = self._path
        for name in set(sys.modules) - self._modules:
            sys.modules.pop(name, None)

    def _write(self, filename, body):
        path = self.root / filename
        path.write_text(body, encoding="utf-8")
        return path

    def test_submission_py_resolves_create_submission(self):
        self._write(
            "submission.py",
            "def create_submission(resources):\n    return {'resources': resources}\n",
        )

        found = resolve_submission_file(self.root, "language-search")

        self.assertEqual(found.filename, "submission.py")
        self.assertEqual(found.attribute, "create_submission")
        self.assertEqual(found.describe(), "submission.py:create_submission")
        self.assertEqual(found.factory("pinned"), {"resources": "pinned"})

    def test_benchmark_adapter_py_resolves_contract_named_factory(self):
        """Back-compat with the two reference repos, which name the factory
        after the contract's trailing word rather than create_submission."""

        self._write(
            "benchmark_adapter.py",
            "def create_search_adapter(resources):\n    return 'reference'\n",
        )

        found = resolve_submission_file(self.root, "language-search")

        self.assertEqual(found.filename, "benchmark_adapter.py")
        self.assertEqual(found.attribute, "create_search_adapter")

    def test_submission_py_wins_over_benchmark_adapter_py(self):
        self._write("submission.py", "def create_submission(r):\n    return 'new'\n")
        self._write("benchmark_adapter.py", "def create_submission(r):\n    return 'old'\n")

        self.assertEqual(load_submission_file(self.root, "language-search")(None), "new")

    def test_module_level_submission_class_resolves(self):
        self._write(
            "submission.py",
            "class Submission:\n    def __init__(self, resources=None):\n        self.resources = resources\n",
        )

        found = resolve_submission_file(self.root, "vision-recognition")

        self.assertEqual(found.attribute, "Submission")
        self.assertIsInstance(found.factory, type)

    def test_missing_file_names_both_expected_filenames(self):
        with self.assertRaises(SubmissionFileMissing) as caught:
            resolve_submission_file(self.root, "language-search")

        message = str(caught.exception)
        self.assertIn("submission.py", message)
        self.assertIn("benchmark_adapter.py", message)
        self.assertIn(str(self.root), message)
        self.assertEqual(caught.exception.repo_root, self.root)

    def test_import_error_carries_the_students_own_traceback_line(self):
        path = self._write(
            "submission.py",
            "import os\n\nBROKEN = 1 / 0\n\ndef create_submission(resources):\n    return None\n",
        )

        with self.assertRaises(SubmissionImportFailed) as caught:
            resolve_submission_file(self.root, "language-search")

        error = caught.exception
        self.assertEqual(error.path, path)
        self.assertEqual(error.traceback_line, "{}:3".format(path))
        self.assertEqual(error.source_line, "BROKEN = 1 / 0")
        message = str(error)
        self.assertIn("submission.py", message)
        self.assertIn("ZeroDivisionError", message)
        self.assertIn("{}:3".format(path), message)

    def test_failed_import_is_not_cached_as_a_half_built_module(self):
        self._write("submission.py", "raise RuntimeError('boom')\n")
        with self.assertRaises(SubmissionImportFailed):
            resolve_submission_file(self.root, "language-search")
        self.assertNotIn("submission", sys.modules)

        self._write("submission.py", "def create_submission(r):\n    return 'fixed'\n")
        self.assertEqual(load_submission_file(self.root, "language-search")(None), "fixed")

    def test_no_factory_names_everything_it_looked_for(self):
        path = self._write(
            "submission.py",
            "class MySearchApp:\n    pass\n\nAPP = MySearchApp()\n",
        )

        with self.assertRaises(SubmissionFactoryMissing) as caught:
            resolve_submission_file(self.root, "language-search")

        error = caught.exception
        self.assertEqual(error.path, path)
        message = str(error)
        for name in ("create_submission", "create_language_search_adapter", "create_search_adapter", "Submission"):
            self.assertIn(name, message)
            self.assertIn(name, error.looked_for)

    def test_repo_root_is_importable_so_the_adapter_can_import_its_project(self):
        (self.root / "my_project").mkdir()
        (self.root / "my_project" / "__init__.py").write_text(
            "VALUE = 'from the repo'\n", encoding="utf-8"
        )
        self._write(
            "submission.py",
            "from my_project import VALUE\n\ndef create_submission(r):\n    return VALUE\n",
        )

        self.assertEqual(load_submission_file(self.root, "language-search")(None), "from the repo")

    def test_loading_never_calls_the_factory(self):
        self._write(
            "submission.py",
            "CALLED = []\n\ndef create_submission(resources):\n    CALLED.append(resources)\n    return None\n",
        )

        load_submission_file(self.root, "language-search")

        self.assertEqual(sys.modules["submission"].CALLED, [])

    def test_an_exit_at_import_becomes_a_named_error_not_a_dead_process(self):
        self._write("submission.py", "import sys\nsys.exit(3)\n")

        with self.assertRaises(SubmissionImportFailed):
            resolve_submission_file(self.root, "language-search")


class ResolutionPrecedenceTests(unittest.TestCase):
    """A submission.py in the working directory beats anything installed."""

    class _EntryPoint:
        def __init__(self, name, value, loaded):
            self.name = name
            self.value = value
            self._loaded = loaded

        def load(self):
            return self._loaded

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="cogbench-precedence-")).resolve()
        self.addCleanup(shutil.rmtree, str(self.root), True)
        self._path = list(sys.path)
        self._modules = set(sys.modules)
        self.addCleanup(self._restore)
        (self.root / "submission.py").write_text(
            "def create_submission(r):\n    return 'file'\n", encoding="utf-8"
        )

    def _restore(self):
        sys.path[:] = self._path
        for name in set(sys.modules) - self._modules:
            sys.modules.pop(name, None)

    def test_the_file_wins_over_an_installed_entry_point(self):
        """Scoring the wrong code and reporting success is the worst failure
        this tool can have, because it is indistinguishable from a pass.

        An entry point can arrive from anywhere in the environment: a
        reference submission someone pip-installed once, a sibling week left
        over from an earlier `pip install -e`. A file in the directory the
        student is standing in is an unambiguous statement of which code they
        meant. Measured before this changed: `cogworks check` inside a fresh
        template directory reported `submissionSource entry_point` for Weeks 1
        and 2 and scored the monorepo's reference implementations, while
        reporting success."""

        point = self._EntryPoint("language-search", "benchmark_adapter:f", lambda r: "entry point")
        with patch("cogbench.plugins._entry_points", return_value=[point]):
            factory, source, detail = resolve_submission(
                "language-search", "cogworks.submissions.v2", self.root
            )

        self.assertEqual(factory(None), "file")
        self.assertEqual(source, "file")
        self.assertEqual(detail, "submission.py:create_submission")

    def test_a_broken_file_does_not_fall_through_to_an_entry_point(self):
        """Same failure wearing a different hat: falling through here would
        hide the student's own syntax error behind somebody else's working
        code, and they would see a passing run."""

        (self.root / "submission.py").write_text("BAD = 1 / 0\n", encoding="utf-8")
        point = self._EntryPoint("language-search", "benchmark_adapter:f", lambda r: "entry point")
        with patch("cogbench.plugins._entry_points", return_value=[point]):
            with self.assertRaises(PluginError) as caught:
                resolve_submission("language-search", "cogworks.submissions.v2", self.root)

        self.assertIn("submission.py", str(caught.exception))
        self.assertNotIn("entry point", str(caught.exception))

    def test_the_file_still_resolves_when_nothing_is_installed(self):
        with patch("cogbench.plugins._entry_points", return_value=[]):
            factory, source, detail = resolve_submission(
                "language-search", "cogworks.submissions.v2", self.root
            )

        self.assertEqual(factory(None), "file")
        self.assertEqual(source, "file")
        self.assertEqual(detail, "submission.py:create_submission")

    def test_v1_contract_still_instantiates_a_file_provided_class(self):
        (self.root / "submission.py").write_text(
            "class Submission:\n    def predict(self, inputs):\n        return list(inputs)\n",
            encoding="utf-8",
        )
        with patch("cogbench.plugins._entry_points", return_value=[]):
            factory, _, detail = resolve_submission(
                "vision-recognition", "cogworks.submissions.v1", self.root
            )

        self.assertNotIsInstance(factory, type)
        self.assertEqual(factory.predict([1, 2]), [1, 2])
        self.assertEqual(detail, "submission.py:Submission")

    def test_a_broken_file_reports_its_own_line_not_the_entry_point_miss(self):
        (self.root / "submission.py").write_text("BAD = 1 / 0\n", encoding="utf-8")
        with patch("cogbench.plugins._entry_points", return_value=[]):
            with self.assertRaises(PluginError) as caught:
                resolve_submission("language-search", "cogworks.submissions.v2", self.root)

        message = str(caught.exception)
        self.assertIn("ZeroDivisionError", message)
        self.assertIn("submission.py:1", message)
        self.assertNotIn("Entry-point group", message)


class FactoryNameTests(unittest.TestCase):
    def test_contract_names_expand_to_full_and_trailing_word_forms(self):
        self.assertEqual(
            factory_names("language-search"),
            ["create_submission", "create_language_search_adapter", "create_search_adapter"],
        )

    def test_single_word_contract_does_not_duplicate_its_form(self):
        self.assertEqual(factory_names("clustering"), ["create_submission", "create_clustering_adapter"])

    def test_empty_contract_still_offers_the_documented_name(self):
        self.assertEqual(factory_names(""), ["create_submission"])


if __name__ == "__main__":
    unittest.main()
