from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.discover import (  # noqa: E402
    STUBBED_MODULES,
    candidate_roots,
    choose_root,
    discover,
    notebook_source,
)


def _notebook(*cells: str) -> str:
    return json.dumps(
        {
            "cells": [
                {"cell_type": "code", "source": [cell]} for cell in cells
            ],
            "metadata": {},
            "nbformat": 4,
            "nbformat_minor": 5,
        }
    )


class RootChoiceTests(unittest.TestCase):
    """Which directory discovery searches, on the layouts that actually exist."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_flat_repository_uses_its_own_root(self):
        (self.tmp / "spectrogram.py").write_text("def make(x):\n    return x\n")
        choice = choose_root(self.tmp)
        self.assertEqual(choice.path, self.tmp)

    def test_a_directory_named_for_the_week_wins(self):
        """One team kept three weeks in one repository, one directory each."""

        for week in ("Week1", "Week2", "Week3"):
            (self.tmp / week).mkdir()
            (self.tmp / week / "code.py").write_text("x = 1\n")
        self.assertEqual(choose_root(self.tmp, hints=("week2",)).path.name, "Week2")

    def test_declared_root_beats_every_heuristic(self):
        (self.tmp / "code").mkdir()
        (self.tmp / "code" / "a.py").write_text("x = 1\n")
        (self.tmp / "Week1").mkdir()
        (self.tmp / "Week1" / "b.py").write_text("x = 1\n")
        choice = choose_root(self.tmp, declared="code", hints=("week1",))
        self.assertEqual(choice.path.name, "code")
        self.assertIn("cogworks.toml", choice.reason)

    def test_scratch_directory_loses_to_the_pipeline_that_imports_itself(self):
        """The measured carti4ce layout: 7 real files, 15 throwaway scripts.

        Counting files picks the scratch directory. Counting satisfied sibling
        imports picks the capstone, because a pipeline imports itself and a
        pile of one-off scripts does not.
        """

        (self.tmp / "spectrogram.py").write_text("def make_spectrogram(s, r):\n    return s\n")
        (self.tmp / "fingerprint.py").write_text(
            "from spectrogram import make_spectrogram\n\ndef find_peaks(s):\n    return []\n"
        )
        (self.tmp / "match.py").write_text(
            "from fingerprint import find_peaks\nfrom spectrogram import make_spectrogram\n"
            "\ndef query(f):\n    return []\n"
        )
        scratch = self.tmp / "tests_manual"
        scratch.mkdir()
        for index in range(9):
            (scratch / "probe{}.py".format(index)).write_text("import os\n")

        choice = choose_root(self.tmp)
        self.assertEqual(choice.path, self.tmp)
        self.assertNotEqual(choice.path.name, "tests_manual")

    def test_candidate_roots_skips_caches_and_environments(self):
        for junk in ("__pycache__", ".git", "venv", "node_modules"):
            (self.tmp / junk).mkdir()
            (self.tmp / junk / "noise.py").write_text("x = 1\n")
        (self.tmp / "real.py").write_text("x = 1\n")
        self.assertEqual(candidate_roots(self.tmp), [self.tmp])


class ImportResilienceTests(unittest.TestCase):
    """One bad module must not cost a team its whole repository."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_missing_dependency_skips_one_module_and_names_it(self):
        (self.tmp / "good.py").write_text("def find_peaks(spec):\n    return []\n")
        (self.tmp / "bad.py").write_text("import definitely_not_installed\n")

        found = discover(self.tmp)

        self.assertEqual([entry.name for entry in found.modules], ["good"])
        skipped = {entry.name: entry for entry in found.skipped}
        self.assertEqual(skipped["bad"].reason, "missing_dependency")
        self.assertEqual(skipped["bad"].missing, "definitely_not_installed")

    def test_interface_packages_are_stubbed_so_the_rest_survives(self):
        """Measured: streamlit appears at module scope in 13 places, and no
        scored path touches any of it."""

        (self.tmp / "app.py").write_text(
            "import streamlit as st\n\ndef identify(samples, rate):\n    return []\n"
        )
        found = discover(self.tmp)
        self.assertEqual([entry.name for entry in found.modules], ["app"])
        self.assertIn("streamlit", STUBBED_MODULES)

    def test_a_module_that_asks_for_input_is_skipped_not_hung(self):
        """Two audited repositories prompt and block at module scope."""

        (self.tmp / "recorder.py").write_text(
            "print('Please play the song now!')\n"
            "path = input('Enter the path to the WAV file: ')\n"
        )
        (self.tmp / "core.py").write_text("def query(f):\n    return []\n")

        found = discover(self.tmp)

        self.assertEqual([entry.name for entry in found.modules], ["core"])
        self.assertEqual(found.skipped[0].name, "recorder")
        self.assertEqual(found.skipped[0].reason, "raised")

    def test_a_syntax_error_reports_its_line(self):
        (self.tmp / "broken.py").write_text("def f(:\n    pass\n")
        found = discover(self.tmp)
        self.assertEqual(found.skipped[0].reason, "syntax")
        self.assertIn("line", found.skipped[0].detail)

    def test_import_does_not_leak_into_the_calling_process(self):
        (self.tmp / "leaky.py").write_text("VALUE = 1\n")
        discover(self.tmp)
        self.assertNotIn("leaky", sys.modules)
        self.assertNotIn(str(self.tmp), sys.path)

    def test_code_split_across_root_and_a_package_directory_is_found_whole(self):
        """One audited repository keeps its matcher at the root and its
        descriptors, profiles, and clustering under core/."""

        (self.tmp / "recognizer.py").write_text("def recognize(image):\n    return None\n")
        core = self.tmp / "core"
        core.mkdir()
        (core / "profile.py").write_text("def build(x):\n    return x\n")
        (core / "similarity.py").write_text("def cosine(a, b):\n    return 0.0\n")

        names = {entry.name for entry in discover(self.tmp).modules}

        self.assertEqual(names, {"recognizer", "profile", "similarity"})


class NotebookTests(unittest.TestCase):
    """Notebooks hold real pipelines; only 4 of 35 are definitions alone."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_definitions_are_lifted_and_statements_are_left_behind(self):
        source = notebook_source_from(
            self.tmp,
            "import numpy as np\n\ndef generate_fingerprints(peaks):\n    return []\n",
            "songs = load_every_song_from_disk()\nplot(songs)\n",
        )
        self.assertIn("def generate_fingerprints", source)
        self.assertNotIn("load_every_song_from_disk", source)
        self.assertIn("import numpy", source)

    def test_a_literal_assignment_survives_because_it_is_state_the_code_needs(self):
        source = notebook_source_from(
            self.tmp, "database = {}\n\ndef add(key):\n    database[key] = 1\n"
        )
        self.assertIn("database = {}", source)

    def test_shell_escapes_and_magics_do_not_break_the_parse(self):
        source = notebook_source_from(
            self.tmp, "!pip install librosa\n%matplotlib inline\ndef q(x):\n    return x\n"
        )
        self.assertIn("def q", source)

    def test_a_notebook_with_no_definitions_is_reported_not_imported(self):
        path = self.tmp / "exploration.ipynb"
        path.write_text(_notebook("x = compute()\nprint(x)\n"))
        found = discover(self.tmp)
        self.assertEqual(found.modules, [])
        self.assertEqual(found.skipped[0].reason, "syntax")
        self.assertIn("as they run", found.skipped[0].detail)

    def test_a_python_file_wins_over_a_notebook_of_the_same_name(self):
        (self.tmp / "database.py").write_text("def add(x):\n    return 'file'\n")
        (self.tmp / "database.ipynb").write_text(_notebook("def add(x):\n    return 'notebook'\n"))
        found = discover(self.tmp)
        self.assertEqual([entry.origin for entry in found.modules], ["file"])

    def test_notebook_modules_are_marked_so_a_failure_can_be_explained(self):
        (self.tmp / "pipeline.ipynb").write_text(_notebook("def query(f):\n    return []\n"))
        found = discover(self.tmp)
        self.assertEqual(found.modules[0].origin, "notebook")


def notebook_source_from(directory: Path, *cells: str) -> str:
    path = directory / "nb.ipynb"
    path.write_text(_notebook(*cells))
    source = notebook_source(path)
    assert source is not None
    return source


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_an_empty_repository_reports_rather_than_raising(self):
        (self.tmp / "README.md").write_text("# our capstone\n")
        found = discover(self.tmp)
        self.assertEqual(found.modules, [])
        self.assertEqual(found.skipped, [])
        self.assertEqual(found.root.path, self.tmp)

    def test_the_record_says_what_was_searched_and_what_was_stubbed(self):
        (self.tmp / "a.py").write_text("def f():\n    return 1\n")
        record = discover(self.tmp).to_dict()
        self.assertEqual(record["rootReason"], "code sits at the repository root")
        self.assertEqual(record["stubbed"], list(STUBBED_MODULES))
        self.assertEqual(record["modules"][0]["name"], "a")


if __name__ == "__main__":
    unittest.main()
