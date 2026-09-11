from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import discover as discover_module  # noqa: E402
from cogbench.discover import (  # noqa: E402
    ROOT_HINTED,
    STUBBED_MODULES,
    WEEK_SCOPED_ROOTS,
    candidate_roots,
    choose_root,
    discover,
    is_package_directory,
    notebook_source,
    survey,
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

    def test_the_named_week_beats_a_word_every_week_shares(self):
        """Reproduced: a week 3 search landed in ``week1_capstone``.

        Every week's hints end in ``capstone``, and the old match took the
        first folder containing any hint. ``week1_capstone`` sorts before
        ``week3``, so the generic word won and the week 3 folder was then
        dropped from the search as a sibling.
        """

        for folder in ("week1_capstone", "week3"):
            (self.tmp / folder).mkdir()
            (self.tmp / folder / "code.py").write_text("x = 1\n")
        week3 = ("week3", "week 3", "language", "search", "capstone")
        self.assertEqual(choose_root(self.tmp, hints=week3).path.name, "week3")

    def test_the_shared_word_still_matches_when_no_week_is_named(self):
        (self.tmp / "capstone").mkdir()
        (self.tmp / "capstone" / "code.py").write_text("x = 1\n")
        week3 = ("week3", "week 3", "language", "search", "capstone")
        self.assertEqual(choose_root(self.tmp, hints=week3).path.name, "capstone")

    def test_reading_only_one_week_is_decided_by_kind_not_by_wording(self):
        """The sentence is for the report. Rewording it must not change which
        folders are read, which is what searching it for "matches this week"
        did."""

        for folder in ("week1_capstone", "week3"):
            (self.tmp / folder).mkdir()
            (self.tmp / folder / "code.py").write_text("x = 1\n")
        chosen = choose_root(self.tmp, hints=("week3",))
        self.assertEqual(chosen.kind, ROOT_HINTED)
        self.assertIn(chosen.kind, WEEK_SCOPED_ROOTS)
        flat = choose_root(self.tmp)
        self.assertNotIn(flat.kind, WEEK_SCOPED_ROOTS)

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

    def test_an_empty_notebook_is_called_empty(self):
        # Measured on one 2026 repository: `master.ipynb` is a zero-byte file
        # in the checkout and at origin, and was reported as "no importable
        # definitions; its cells build what they use as they run", which sent
        # a team looking for a cell that does not exist.
        (self.tmp / "master.ipynb").write_text("")
        found = discover(self.tmp)
        self.assertEqual(found.skipped[0].detail, "is empty")

    def test_a_notebook_that_is_not_json_says_so(self):
        (self.tmp / "master.ipynb").write_text("this was never a notebook\n")
        found = discover(self.tmp)
        self.assertEqual(
            found.skipped[0].detail, "is not a notebook this can read (not JSON)"
        )

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
        # A subset, not the constant. `_install_stubs` deliberately declines to
        # stand in for a module that is genuinely importable, so the record
        # names what was replaced on this machine rather than what the list
        # allows. Asserting the whole tuple passes only on an interpreter that
        # happens to have none of them installed, and fails on any student
        # laptop carrying streamlit or pyaudio, which is the case the code
        # under test exists to handle.
        self.assertIn("microphone", record["stubbed"])
        for name in record["stubbed"]:
            self.assertIn(name, STUBBED_MODULES)
        self.assertEqual(record["modules"][0]["name"], "a")


class ImportDeadlineTests(unittest.TestCase):
    """Importing runs whatever a file does at module scope, and files do real
    work there. One 2026 repository tunes a threshold across 25 iterations
    while being imported."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_module_that_never_finishes_importing_is_skipped_and_named(self):
        (self.tmp / "slow.py").write_text("while True:\n    pass\n")
        (self.tmp / "fine.py").write_text("def peaks(x):\n    return x\n")

        found = discover(self.tmp, import_timeout=1)

        self.assertEqual([entry.name for entry in found.modules], ["fine"])
        slow = [entry for entry in found.skipped if entry.name == "slow"]
        self.assertEqual(slow[0].reason, "too_slow")
        self.assertIn("imported rather than when called", slow[0].detail)

    def test_the_deadline_cannot_be_swallowed_by_their_own_except(self):
        """Student code catches Exception liberally. A timeout a module can
        catch and ignore is not a timeout."""

        (self.tmp / "stubborn.py").write_text(
            "while True:\n    try:\n        pass\n    except Exception:\n        pass\n"
        )

        found = discover(self.tmp, import_timeout=1)

        self.assertEqual(found.modules, [])
        self.assertEqual(found.skipped[0].reason, "too_slow")

    def test_a_slow_module_does_not_stop_the_ones_after_it(self):
        (self.tmp / "a_slow.py").write_text("while True:\n    pass\n")
        (self.tmp / "z_good.py").write_text("def peaks(x):\n    return x\n")

        found = discover(self.tmp, import_timeout=1)

        self.assertIn("z_good", [entry.name for entry in found.modules])


class SiblingImportTests(unittest.TestCase):
    """Reading code from a directory and importing from it are the same
    permission. One 2026 team keeps `buildSongDatabase.py` and `pipeline.py`
    side by side in a subdirectory, and the report told them to pip-install
    their own file."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_module_imports_its_neighbour_in_the_same_subdirectory(self):
        (self.tmp / "readme.py").write_text("VERSION = 1\n")
        day = self.tmp / "Day 4"
        day.mkdir()
        (day / "helpers.py").write_text("def peak(x):\n    return x\n")
        (day / "builder.py").write_text(
            "from helpers import peak\ndef build(x):\n    return peak(x)\n"
        )

        found = discover(self.tmp)

        self.assertIn("builder", [entry.name for entry in found.modules])

    def test_the_chosen_root_still_wins_a_name_collision(self):
        """Two files called database.py must not shadow each other by
        accident; the root owns precedence."""

        (self.tmp / "database.py").write_text("WHERE = 'root'\n")
        other = self.tmp / "extras"
        other.mkdir()
        (other / "database.py").write_text("WHERE = 'extras'\n")
        (self.tmp / "uses.py").write_text("from database import WHERE\n")

        found = discover(self.tmp)
        uses = [entry for entry in found.modules if entry.name == "uses"]

        self.assertTrue(uses)
        self.assertEqual(uses[0].module.WHERE, "root")


class StubTests(unittest.TestCase):
    """The stub list stands in for packages the sandbox does not carry."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_submodule_of_a_stubbed_package_imports_too(self):
        """`from microphone.config import settings` is a real line in the 2026
        corpus. Stubbing only the top name left it failing, and one team lost
        the module holding their spectrogram to it."""

        (self.tmp / "theirs.py").write_text(
            "from microphone import record_audio\n"
            "from microphone.config import settings\n"
            "def peaks(x):\n    return x\n"
        )

        found = discover(self.tmp)

        self.assertIn("theirs", [entry.name for entry in found.modules])

    def test_using_a_stubs_result_names_the_stub_not_the_shape_of_None(self):
        """`frames, rate = record_audio(5)` failed with "cannot unpack
        non-iterable NoneType object", which describes our stand-in rather
        than the microphone that is not here."""

        (self.tmp / "theirs.py").write_text(
            "from microphone import record_audio\n"
            "frames, rate = record_audio(5)\n"
        )

        found = discover(self.tmp)

        self.assertIn("microphone.record_audio", found.skipped[0].detail)
        self.assertNotIn("NoneType", found.skipped[0].detail)

    def test_a_module_that_guards_on_a_stub_takes_the_branch_without_it(self):
        """`if record_audio(...)` should behave as it does on a machine with
        no microphone, which is the branch that runs."""

        (self.tmp / "theirs.py").write_text(
            "from microphone import record_audio\n"
            "HAVE_MIC = bool(record_audio(1))\n"
            "def peaks(x):\n    return x\n"
        )

        found = discover(self.tmp)

        self.assertEqual([entry.name for entry in found.modules], ["theirs"])

    def test_an_unrelated_missing_package_still_fails_and_is_named(self):
        """The stub list is fixed. Answering for anything missing would turn
        a real dependency error into a silent wrong answer."""

        (self.tmp / "theirs.py").write_text("import definitely_not_a_package\n")

        found = discover(self.tmp)

        self.assertEqual([entry.name for entry in found.modules], [])
        self.assertEqual(found.skipped[0].missing, "definitely_not_a_package")

    def test_a_listed_package_that_is_installed_is_not_stood_in_for(self):
        """The measured bug, in the shape it actually took.

        `networkx` was on the list while the Week 2 image installed it, so a
        team's clustering module got a stand-in instead of the real package
        and their working code was reported as broken. `json` stands in for
        networkx here because it is always importable, which is the property
        that made the real case a bug.
        """

        import json as real_json

        saved = discover_module.STUBBED_MODULES
        discover_module.STUBBED_MODULES = ("json",)
        self.addCleanup(setattr, discover_module, "STUBBED_MODULES", saved)
        sys.modules.pop("json", None)
        self.addCleanup(sys.modules.__setitem__, "json", real_json)

        (self.tmp / "theirs.py").write_text(
            "import json\n"
            "PARSED = json.loads('{\"ok\": 1}')\n"
            "def peaks(x):\n    return x\n"
        )

        found = discover(self.tmp)

        self.assertEqual([entry.name for entry in found.modules], ["theirs"])
        # The real package ran, so the parse produced a real value rather than
        # the placeholder a stub returns.
        self.assertEqual(found.modules[0].module.PARSED, {"ok": 1})
        self.assertNotIn("json", found.to_dict()["stubbed"])

    def test_the_record_names_what_was_replaced_not_what_the_list_allows(self):
        """A student reads this to find out why a module was skipped, so it
        has to describe what happened rather than what was permitted."""

        (self.tmp / "a.py").write_text("def f():\n    return 1\n")

        record = discover(self.tmp).to_dict()

        # microphone is not installable anywhere, so it is genuinely stubbed.
        self.assertIn("microphone", record["stubbed"])
        for name in record["stubbed"]:
            self.assertIn(name, STUBBED_MODULES)

    def test_a_real_submodule_survives_when_its_parent_was_not_stubbed(self):
        """The finder sits first on `sys.meta_path`, so it answers before the
        real path finder. Matching on the name alone shadowed submodules of a
        package that is genuinely installed: with the real networkx imported,
        `networkx.algorithms...` still resolved to a stub, and that install
        has 294 such submodules."""

        import importlib

        import json as real_json

        saved = discover_module.STUBBED_MODULES
        discover_module.STUBBED_MODULES = ("json",)
        self.addCleanup(setattr, discover_module, "STUBBED_MODULES", saved)
        self.addCleanup(sys.modules.__setitem__, "json", real_json)

        (self.tmp / "a.py").write_text("def f():\n    return 1\n")
        discover(self.tmp)

        decoder = importlib.import_module("json.decoder")
        self.assertFalse(isinstance(decoder, discover_module._Stub))


class PackageImportTests(unittest.TestCase):
    """A module inside a package must be imported as part of that package.

    ``from .profile import Profile`` resolves from the importing module's
    ``__package__``, never from ``sys.path``. Imported under a bare name that
    attribute is empty, and Python raises "attempted relative import with no
    known parent package" about a file that is correct. Measured on the 2026
    corpus: one repository loses ``core/database.py``, the class its whole
    pipeline is built on, to exactly that.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _core(self, *, initializer: bool):
        """A package directory whose modules import each other with dots."""

        core = self.tmp / "core"
        core.mkdir()
        if initializer:
            core.joinpath("__init__.py").write_text("MARKER = 'the package body ran'\n")
        (core / "normalize.py").write_text("def resize(image):\n    return image\n")
        (core / "profile.py").write_text("class Profile:\n    pass\n")
        (core / "database.py").write_text(
            "from .normalize import resize\n"
            "from .profile import Profile\n"
            "def add(image):\n"
            "    return resize(image), Profile\n"
        )
        return core

    def test_a_package_with_an_init_file_and_a_relative_import_resolves(self):
        self._core(initializer=True)

        found = discover(self.tmp)

        names = [entry.name for entry in found.modules]
        self.assertIn("database", names)
        database = [e for e in found.modules if e.name == "database"][0]
        self.assertEqual(database.module.add(7), (7, database.module.Profile))

    def test_a_directory_of_relative_imports_with_no_init_file_resolves(self):
        """No repository in the 2026 corpus has an __init__.py anywhere, and
        the one directory that uses relative imports has none either. A rule
        that required the marker file would recover nothing that is broken."""

        core = self._core(initializer=False)
        self.assertFalse((core / "__init__.py").exists())
        self.assertTrue(is_package_directory(core))

        found = discover(self.tmp)

        self.assertIn("database", [entry.name for entry in found.modules])

    def test_the_package_body_runs_so_what_it_defines_is_available(self):
        """An __init__.py is a file the student wrote. Skipping it would drop
        whatever it offers, silently."""

        core = self._core(initializer=True)
        (core / "uses_marker.py").write_text(
            "from . import MARKER\ndef say():\n    return MARKER\n"
        )

        found = discover(self.tmp)
        uses = [e for e in found.modules if e.name == "uses_marker"]

        self.assertTrue(uses, "uses_marker did not import")
        self.assertEqual(uses[0].module.say(), "the package body ran")

    def test_a_package_module_keeps_the_plain_name_a_student_would_recognise(self):
        """The synthetic package name is machinery. A report that named a
        student's file `_cogbench_pkg_0_core.database` would be describing our
        implementation to someone debugging theirs."""

        self._core(initializer=True)

        found = discover(self.tmp)
        database = [e for e in found.modules if e.name == "database"][0]

        self.assertEqual(database.module.__name__, "database")
        self.assertEqual(database.module.add.__module__, "database")

    def test_a_relative_import_of_a_module_that_is_broken_names_the_real_cause(self):
        """The failure must be attributed to the file that actually failed,
        not to the file that imported it and not to our loader."""

        core = self._core(initializer=False)
        (core / "normalize.py").write_text("import definitely_not_installed\n")

        found = discover(self.tmp)
        skipped = {entry.name: entry for entry in found.skipped}

        self.assertEqual(skipped["database"].reason, "missing_dependency")
        self.assertEqual(skipped["database"].missing, "definitely_not_installed")
        self.assertNotIn("relative import", skipped["database"].detail)

    def test_one_file_yields_one_module_object_however_it_is_reached(self):
        """Two objects for one file is the silent-wrong-number failure: a
        module stores into one copy and a resolver reads the other, empty."""

        core = self._core(initializer=False)
        (core / "state.py").write_text("CALLS = []\ndef use(x):\n    CALLS.append(x)\n")
        (core / "driver.py").write_text(
            "from .state import use, CALLS\ndef go():\n    use('a')\n    return CALLS\n"
        )

        found = discover(self.tmp)
        by_name = {entry.name: entry.module for entry in found.modules}

        self.assertIn("driver", by_name)
        self.assertIn("state", by_name)
        by_name["driver"].go()
        self.assertEqual(by_name["state"].CALLS, ["a"])

    def test_a_flat_directory_is_not_treated_as_a_package(self):
        (self.tmp / "spectrogram.py").write_text("def make(x):\n    return x\n")
        self.assertFalse(is_package_directory(self.tmp))


class PackageIsolationTests(unittest.TestCase):
    """Two directories may both hold database.py. Neither may become the
    other, in one repository or across two scored in the same process."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _repository(self, name: str, where: str) -> Path:
        """A repository whose core/ package reports which one it is."""

        repository = self.tmp / name
        core = repository / "core"
        core.mkdir(parents=True)
        (core / "normalize.py").write_text("WHERE = {!r}\n".format(where))
        (core / "database.py").write_text(
            "from .normalize import WHERE\ndef where():\n    return WHERE\n"
        )
        return repository

    def test_two_repositories_scored_in_one_process_do_not_borrow_each_other(self):
        """A team's code scoring another team's repository is the worst
        failure available here, and it is silent."""

        first = self._repository("alpha", "alpha")
        second = self._repository("beta", "beta")

        found_first = discover(first)
        found_second = discover(second)

        def _where(found):
            entry = [e for e in found.modules if e.name == "database"]
            self.assertTrue(entry, "database did not import")
            return entry[0].module.where()

        self.assertEqual(_where(found_first), "alpha")
        self.assertEqual(_where(found_second), "beta")

    def test_two_package_directories_in_one_repository_stay_separate(self):
        repository = self.tmp / "one"
        for where in ("first", "second"):
            core = repository / where
            core.mkdir(parents=True)
            (core / "normalize.py").write_text("WHERE = {!r}\n".format(where))
            (core / "shared.py").write_text(
                "from .normalize import WHERE\ndef where():\n    return WHERE\n"
            )

        found = discover(repository)
        wheres = {
            entry.module.where()
            for entry in found.modules
            if entry.name == "shared"
        }

        # One name, so one module is offered: the dedupe that has always
        # applied. What must not happen is a `shared` from one directory
        # answering with the other directory's WHERE.
        for value in wheres:
            self.assertIn(value, ("first", "second"))
        for entry in found.modules:
            if entry.name == "shared":
                self.assertEqual(entry.module.where(), entry.path.parent.name)

    def test_nothing_from_a_package_is_left_in_the_calling_process(self):
        """A synthetic package has no __file__ when the directory had no
        __init__.py, so eviction by file location alone would leave it behind
        holding a path into a repository this process has finished with."""

        self._repository("alpha", "alpha")
        before = set(sys.modules)

        discover(self.tmp / "alpha")

        added = set(sys.modules) - before
        self.assertEqual(
            [name for name in added if name.startswith("_cogbench_pkg_")], []
        )
        self.assertNotIn("database", sys.modules)


class PackageRegressionTests(unittest.TestCase):
    """The flat layouts resolve today and must keep resolving identically.
    Eleven of the thirteen 2026 repositories import at least one file under a
    bare name from a subdirectory, so this is the risk that matters."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_flat_script_repository_behaves_exactly_as_before(self):
        (self.tmp / "spectrogram.py").write_text(
            "def make_spectrogram(s, r):\n    return s\n"
        )
        (self.tmp / "fingerprint.py").write_text(
            "from spectrogram import make_spectrogram\n"
            "def find_peaks(s):\n    return [make_spectrogram(s, 1)]\n"
        )
        (self.tmp / "match.py").write_text(
            "from fingerprint import find_peaks\ndef query(f):\n    return find_peaks(f)\n"
        )

        found = discover(self.tmp)

        self.assertEqual(
            [entry.name for entry in found.modules],
            ["fingerprint", "match", "spectrogram"],
        )
        self.assertEqual(found.skipped, [])
        for entry in found.modules:
            # A flat module belongs to no package, exactly as before. A
            # non-empty __package__ here would mean the loader changed the
            # meaning of a layout that was already working.
            self.assertIn(getattr(entry.module, "__package__", "") or "", ("", None))
            self.assertEqual(entry.module.__name__, entry.name)
        match = [e for e in found.modules if e.name == "match"][0]
        self.assertEqual(match.module.query("x"), ["x"])

    def test_a_genuine_syntax_error_is_still_reported_as_a_skip_with_its_reason(self):
        """Distinguishing our failure from theirs is the whole point. A file
        that really is broken must still be named, with its line."""

        core = self.tmp / "core"
        core.mkdir()
        (core / "normalize.py").write_text("def resize(x):\n    return x\n")
        (core / "database.py").write_text("from .normalize import resize\n")
        (core / "broken.py").write_text("def f(:\n    pass\n")

        found = discover(self.tmp)
        skipped = {entry.name: entry for entry in found.skipped}

        self.assertIn("broken", skipped)
        self.assertEqual(skipped["broken"].reason, "syntax")
        self.assertIn("line 1", skipped["broken"].detail)
        # The broken neighbour costs itself and nothing else.
        self.assertIn("database", [entry.name for entry in found.modules])

    def test_an_init_file_that_raises_is_reported_and_the_rest_still_loads(self):
        core = self.tmp / "core"
        core.mkdir()
        (core / "__init__.py").write_text("import definitely_not_installed\n")
        (core / "normalize.py").write_text("def resize(x):\n    return x\n")
        (core / "database.py").write_text(
            "from .normalize import resize\ndef add(x):\n    return resize(x)\n"
        )

        found = discover(self.tmp)
        skipped = {entry.name: entry for entry in found.skipped}

        self.assertIn("__init__", skipped)
        self.assertEqual(skipped["__init__"].reason, "missing_dependency")
        self.assertIn("database", [entry.name for entry in found.modules])


class SurveyIsolationTests(unittest.TestCase):
    """A survey whose child process dies must not read as an empty repository.

    Both used to return `modules: []` and `skipped: []`, which is exactly what
    a repository holding no Python returns. So a team whose module aborted the
    interpreter was told their repository had nothing in it: a confident wrong
    answer about their work, which is the one thing this platform must not do.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_an_empty_repository_is_read_and_found_to_hold_nothing(self):
        (self.tmp / "README.md").write_text("# our capstone\n")

        result = survey(self.tmp, timeout_seconds=60)

        self.assertTrue(result.ok)
        self.assertTrue(result.looked)
        self.assertEqual(result.module_names, [])

    @unittest.skipUnless(
        hasattr(os, "fork"), "requires os.fork process isolation"
    )
    def test_a_repository_whose_reader_dies_says_so_rather_than_saying_empty(self):
        """os.abort() stands in for the real case: one repository's audio
        helper loads a second copy of a native backend and the interpreter
        dies with a nanobind error no `except` clause can see."""

        (self.tmp / "a_fine.py").write_text("def peaks(x):\n    return x\n")
        (self.tmp / "z_fatal.py").write_text("import os\nos.abort()\n")

        result = survey(self.tmp, timeout_seconds=60)

        self.assertFalse(result.ok)
        self.assertFalse(result.looked)
        self.assertTrue(result.record.get("unread"))
        self.assertNotEqual(result.status, "ok")

    @unittest.skipUnless(
        hasattr(os, "fork"), "requires os.fork process isolation"
    )
    def test_what_was_read_before_the_death_survives_the_process_boundary(self):
        """Twenty files read successfully must not cost nothing because the
        twenty-first ended the process."""

        (self.tmp / "a_fine.py").write_text("def peaks(x):\n    return x\n")
        (self.tmp / "b_missing.py").write_text("import definitely_not_installed\n")
        (self.tmp / "z_fatal.py").write_text("import os\nos.abort()\n")

        result = survey(self.tmp, timeout_seconds=60)

        self.assertIn("a_fine", result.module_names)
        reasons = {
            str(entry["name"]): str(entry["reason"])
            for entry in result.record["skipped"]
        }
        self.assertEqual(reasons.get("b_missing"), "missing_dependency")
        self.assertIn("z_fatal", str(result.record.get("endedWhileReading", "")))

    @unittest.skipUnless(
        hasattr(os, "fork"), "requires os.fork process isolation"
    )
    def test_the_two_outcomes_do_not_render_as_the_same_sentence(self):
        from cogbench.report import render_survey

        (self.tmp / "a_fine.py").write_text("def peaks(x):\n    return x\n")
        (self.tmp / "z_fatal.py").write_text("import os\nos.abort()\n")
        died = survey(self.tmp, timeout_seconds=60)

        empty_repository = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, empty_repository, ignore_errors=True)
        (empty_repository / "README.md").write_text("# nothing here\n")
        empty = survey(empty_repository, timeout_seconds=60)

        died_text = "\n".join(render_survey(died.record))
        empty_text = "\n".join(render_survey(empty.record))

        self.assertIn("stopped early", died_text)
        self.assertNotIn("stopped early", empty_text)
        self.assertIn("nothing", empty_text)


class PlottingDoesNotStopTheSearch(unittest.TestCase):
    """Student code draws, and drawing must never open a window here.

    One 2026 team's `whispers` calls `plt.show()` inside its iteration loop.
    That is a reasonable thing to write for a notebook, where the point is to
    watch the cluster count settle. It is fatal to a search that calls their
    function: measured on this machine, the default backend with no
    MPLBACKEND set is MacOSX, and a resolve against that repository sat in
    `_macosx.show` inside a CoreFoundation run loop until it was killed.

    The hosted Week 1 image already sets MPLBACKEND. This is the same
    protection everywhere else discovery runs, which includes every student
    laptop and the Week 2 and Week 3 images.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_the_backend_is_agg_while_their_code_is_imported(self):
        (self.tmp / "plots.py").write_text(
            "import os\n"
            "BACKEND_AT_IMPORT = os.environ.get('MPLBACKEND')\n"
        )
        found = discover(self.tmp)
        module = next(m for m in found.modules if m.name == "plots")
        self.assertEqual(
            getattr(module.module, "BACKEND_AT_IMPORT", None),
            "Agg",
            "their import must see a backend that draws to memory",
        )

    def test_the_caller_gets_their_own_setting_back(self):
        """Discovery runs inside a student's own shell. Leaving MPLBACKEND
        set behind would change how their next command plots."""

        import os

        previous = os.environ.get("MPLBACKEND")
        self.addCleanup(
            lambda: os.environ.__setitem__("MPLBACKEND", previous)
            if previous is not None
            else os.environ.pop("MPLBACKEND", None)
        )
        os.environ.pop("MPLBACKEND", None)
        (self.tmp / "quiet.py").write_text("x = 1\n")
        discover(self.tmp)
        self.assertIsNone(os.environ.get("MPLBACKEND"))

        os.environ["MPLBACKEND"] = "svg"
        discover(self.tmp)
        self.assertEqual(os.environ.get("MPLBACKEND"), "svg")


class ACellBoundaryIsALineBreak(unittest.TestCase):
    """A notebook stores a cell without a trailing newline whenever its last
    line has none, and joining the cells as written glues the last line of one
    onto the first line of the next."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_two_cells_do_not_run_into_each_other(self):
        """Measured on one 2026 repository: `import uuid` and `class
        SongMetadata:` became `import uuidclass SongMetadata:`, and the team
        was told their own file had a syntax error."""

        source = notebook_source_from(
            self.tmp, "import uuid", "class SongMetadata:\n    pass\n"
        )

        self.assertIn("import uuid\n", source)
        self.assertNotIn("uuidclass", source)

    def test_a_notebook_whose_only_definition_follows_such_a_cell_imports(self):
        path = self.tmp / "peaks.ipynb"
        path.write_text(_notebook("import json", "def find(x):\n    return x\n"))

        found = discover(self.tmp)

        self.assertEqual([entry.name for entry in found.modules], ["peaks"])


class AModuleThatReadsItsOwnFolder(unittest.TestCase):
    """A module that opens `data/trumpet.wav` at import scope is right about
    where that file is relative to itself and wrong only about the working
    directory the platform chose."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_relative_read_is_retried_from_the_modules_own_directory(self):
        (self.tmp / "data").mkdir()
        (self.tmp / "data" / "trumpet.txt").write_text("samples\n")
        (self.tmp / "pipeline.py").write_text(
            "SAMPLES = open('data/trumpet.txt').read()\n"
            "def peaks(spec):\n    return []\n"
        )

        found = discover(self.tmp)

        self.assertEqual([entry.name for entry in found.modules], ["pipeline"])
        self.assertEqual(found.modules[0].cwd_hint, self.tmp)
        record = found.to_dict()["modules"][0]
        self.assertEqual(record["note"], "imported from its own folder")

    def test_an_absolute_path_is_never_retried(self):
        """An absolute path names a location on some machine. If it is not
        here, no working directory makes it appear, and retrying would hide
        the only true answer there is."""

        (self.tmp / "pipeline.py").write_text(
            "SAMPLES = open('/definitely/not/here/trumpet.wav').read()\n"
            "def peaks(spec):\n    return []\n"
        )

        found = discover(self.tmp)

        self.assertEqual(found.modules, [])
        self.assertEqual(found.skipped[0].reason, "raised")


class ANameUsedOnlyInAnAnnotation(unittest.TestCase):
    """`def f(x) -> Tuple[Dict[DatabaseKey, int]]` with `DatabaseKey`
    undefined kills a module at import even though no line of it would ever
    evaluate that expression."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_the_module_is_recompiled_with_the_future_flag_and_says_so(self):
        (self.tmp / "spectogram.py").write_text(
            "from typing import Dict\n"
            "def match(fp) -> Dict[DatabaseKey, int]:\n"
            "    return {'ok': 1}\n"
        )

        found = discover(self.tmp)

        self.assertEqual([entry.name for entry in found.modules], ["spectogram"])
        self.assertTrue(found.modules[0].future_annotations)
        self.assertEqual(found.modules[0].module.match(None), {"ok": 1})
        self.assertTrue(found.to_dict()["modules"][0]["futureAnnotations"])

    def test_a_name_their_code_actually_uses_is_still_their_error(self):
        """Recompiling would only move the failure to the first call, and the
        report would then blame a function instead of the missing name."""

        (self.tmp / "broken.py").write_text(
            "def match(fp) -> int:\n    return DatabaseKey\n"
            "VALUE = match(None)\n"
        )

        found = discover(self.tmp)

        self.assertEqual(found.modules, [])
        self.assertIn("DatabaseKey", found.skipped[0].detail)


class ANotebookImportedAsAPackage(unittest.TestCase):
    """`from ipynb.fs.full.metadata import SongMetadata` is a real line in the
    2026 corpus and means the definitions in metadata.ipynb, which is the
    module discovery already builds."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_the_lifted_notebook_answers_for_ipynb_fs_full(self):
        (self.tmp / "metadata.ipynb").write_text(
            _notebook("class SongMetadata:\n    NAME = 'theirs'\n")
        )
        (self.tmp / "database.py").write_text(
            "from ipynb.fs.full.metadata import SongMetadata\n"
            "def add(x):\n    return SongMetadata.NAME\n"
        )

        found = discover(self.tmp)
        by_name = {entry.name: entry.module for entry in found.modules}

        self.assertIn("database", by_name)
        self.assertEqual(by_name["database"].add(0), "theirs")

    def test_the_defs_spelling_resolves_to_the_same_definitions(self):
        (self.tmp / "helpers.ipynb").write_text(
            _notebook("def peak(x):\n    return x + 1\n")
        )
        (self.tmp / "uses.py").write_text(
            "from ipynb.fs.defs.helpers import peak\n"
            "def go(x):\n    return peak(x)\n"
        )

        found = discover(self.tmp)
        by_name = {entry.name: entry.module for entry in found.modules}

        self.assertIn("uses", by_name)
        self.assertEqual(by_name["uses"].go(1), 2)

    def test_a_stem_with_no_notebook_is_still_a_missing_dependency(self):
        (self.tmp / "uses.py").write_text(
            "from ipynb.fs.full.nothing import thing\n"
        )

        found = discover(self.tmp)

        self.assertEqual(found.modules, [])
        self.assertEqual(found.skipped[0].reason, "missing_dependency")

    def test_the_finder_does_not_outlive_the_repository(self):
        (self.tmp / "metadata.ipynb").write_text(_notebook("X = 1\ndef f():\n    return X\n"))
        (self.tmp / "a.py").write_text("def g():\n    return 1\n")

        discover(self.tmp)

        self.assertNotIn("ipynb", sys.modules)
        self.assertFalse(
            [f for f in sys.meta_path if type(f).__name__ == "_NotebookFsFinder"]
        )

    def test_the_course_camera_helper_is_stubbed_like_the_microphone(self):
        (self.tmp / "shots.py").write_text(
            "from camera import take_picture\n"
            "def peaks(x):\n    return x\n"
        )

        found = discover(self.tmp)

        self.assertIn("camera", STUBBED_MODULES)
        self.assertEqual([entry.name for entry in found.modules], ["shots"])


class ACourseArtifactAtAPathThisMachineDoesNotHave(unittest.TestCase):
    """One 2026 repository loads GloVe from a Windows drive at module scope,
    so every module in it is skipped and the week has nothing to search. The
    file is the same course artifact the benchmark already owns."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.owned = self.tmp / "owned"
        self.owned.mkdir()
        self.glove = self.owned / "glove.6B.200d.kv"
        self.glove.write_text("the benchmark's copy\n")
        self.repo = self.tmp / "repo"
        self.repo.mkdir()

    def test_the_basename_the_benchmark_owns_is_answered_from_its_copy(self):
        (self.repo / "text_to_image.py").write_text(
            "VECTORS = open(r'C:/Users/them/glove.6B.200d.kv').read()\n"
            "def embed(text):\n    return VECTORS\n"
        )

        found = discover(
            self.repo, resource_files={"glove.6B.200d.kv": self.glove}
        )

        self.assertEqual([entry.name for entry in found.modules], ["text_to_image"])
        self.assertEqual(found.modules[0].redirected, ("glove.6B.200d.kv",))
        record = found.to_dict()["modules"][0]
        self.assertEqual(
            record["redirectNote"],
            ["their path to glove.6B.200d.kv was redirected to the benchmark's copy"],
        )

    def test_a_basename_the_benchmark_did_not_name_is_left_alone(self):
        (self.repo / "theirs.py").write_text(
            "DATA = open(r'C:/Users/them/private.bin').read()\n"
        )

        found = discover(
            self.repo, resource_files={"glove.6B.200d.kv": self.glove}
        )

        self.assertEqual(found.modules, [])
        self.assertEqual(found.skipped[0].reason, "raised")

    def test_the_vector_loader_they_already_imported_is_pointed_at_it_too(self):
        """`KeyedVectors.load` is how the corpus reads GloVe, and it opens the
        file itself rather than through `open`. Patched only when their code
        has already imported gensim, so a repository that does not use it
        neither pays for the import nor is reported as needing it."""

        from types import ModuleType

        models = ModuleType("gensim.models")

        class KeyedVectors:
            @staticmethod
            def load(path):
                return open(path).read()

        models.KeyedVectors = KeyedVectors
        sys.modules["gensim.models"] = models
        self.addCleanup(sys.modules.pop, "gensim.models", None)

        (self.repo / "text_to_image.py").write_text(
            "from gensim.models import KeyedVectors\n"
            "VECTORS = KeyedVectors.load(r'C:/Users/them/glove.6B.200d.kv')\n"
            "def embed(text):\n    return VECTORS\n"
        )

        found = discover(
            self.repo, resource_files={"glove.6B.200d.kv": self.glove}
        )

        self.assertEqual([entry.name for entry in found.modules], ["text_to_image"])
        self.assertEqual(found.modules[0].module.embed(""), "the benchmark's copy\n")
        # And the patch is gone afterwards. A loader that kept answering for
        # this basename would redirect a later repository that names the same
        # file and means its own.
        with self.assertRaises(OSError):
            KeyedVectors.load("C:/Users/them/glove.6B.200d.kv")

    def test_the_course_data_directory_is_pointed_at_the_same_copy(self):
        """Several repositories go through `cogworks_data.get_data_path`
        rather than naming a path, and it reads this variable."""

        (self.repo / "theirs.py").write_text(
            "import os\n"
            "WHERE = os.environ.get('COGWORKS_LANGUAGE_DATA', '')\n"
            "def where():\n    return WHERE\n"
        )

        found = discover(
            self.repo, resource_files={"glove.6B.200d.kv": self.glove}
        )

        self.assertEqual(found.modules[0].module.where(), str(self.owned))
        self.assertNotIn("COGWORKS_LANGUAGE_DATA", os.environ)


class TheOwnFolderRetryNeverWritesIntoTheCheckout(unittest.TestCase):
    """Discovery may read a repository. It may not change one.

    The retry that gives a module its own directory as the working directory
    did that with `os.chdir(folder)`, which put the student's checkout under
    the student's own `open(..., "w")`: a module that wrote a file before
    reading one failed the scratch import, succeeded on the retry, and left
    the file behind in the repository it was asked to read.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _repository(self) -> None:
        (self.tmp / "data.txt").write_text("samples\n", encoding="utf-8")
        (self.tmp / "pipeline.py").write_text(
            "open('marker.txt', 'w').write('student was here')\n"
            "SAMPLES = open('data.txt').read()\n"
            "def peaks(spec):\n    return []\n",
            encoding="utf-8",
        )

    def test_the_module_still_imports(self):
        self._repository()

        found = discover(self.tmp)

        self.assertEqual([entry.name for entry in found.modules], ["pipeline"])
        self.assertEqual(found.modules[0].cwd_hint, self.tmp)

    def _entries(self) -> set:
        return {path.name for path in self.tmp.iterdir()}

    def test_and_the_repository_is_exactly_as_it_was(self):
        self._repository()
        before = self._entries()

        discover(self.tmp)

        self.assertEqual(self._entries(), before)
        self.assertFalse((self.tmp / "marker.txt").exists())

    def test_a_write_that_would_land_in_their_folder_anyway_is_refused(self):
        """Truncating a file they already have cannot be redirected into
        scratch, because there is no copy of it there. Refusing is the only
        answer that leaves their checkout alone."""

        (self.tmp / "data.txt").write_text("samples\n", encoding="utf-8")
        (self.tmp / "keep.txt").write_text("theirs\n", encoding="utf-8")
        (self.tmp / "pipeline.py").write_text(
            "open('keep.txt', 'w').write('overwritten')\n"
            "SAMPLES = open('data.txt').read()\n"
            "def peaks(spec):\n    return []\n",
            encoding="utf-8",
        )

        discover(self.tmp)

        self.assertEqual(
            (self.tmp / "keep.txt").read_text(encoding="utf-8"), "theirs\n"
        )

    def _nested(self, housekeeping: str) -> None:
        """A module that tidies up before it reads, which is ordinary.

        The first import runs from scratch and fails on `data.txt`, which is
        what turns the own-folder retry on. The housekeeping line then runs a
        second time with the mirror as the working directory, and that is the
        moment the first draft reached their checkout.
        """

        (self.tmp / "data.txt").write_text("samples\n", encoding="utf-8")
        (self.tmp / "cache").mkdir()
        (self.tmp / "cache" / "stale.pkl").write_text("theirs\n", encoding="utf-8")
        (self.tmp / "cache" / "empty").mkdir()
        (self.tmp / "pipeline.py").write_text(
            "import os, shutil\n"
            "from pathlib import Path\n"
            "try:\n    {}\nexcept Exception:\n    pass\n"
            "SAMPLES = open('data.txt').read()\n"
            "def peaks(spec):\n    return []\n".format(housekeeping),
            encoding="utf-8",
        )

    def test_a_nested_path_cannot_delete_rename_or_create_in_their_tree(self):
        """A link to a directory is a doorway, and a relative path walks
        straight through it. Each of these reached the original tree while the
        mirror linked top-level entries, and none of them opens a file, so the
        audit hook never saw one."""

        for housekeeping, gone in (
            ("os.remove('cache/stale.pkl')", "cache/stale.pkl"),
            ("Path('cache/stale.pkl').unlink()", "cache/stale.pkl"),
            ("os.rename('cache/stale.pkl', 'cache/moved.pkl')", "cache/stale.pkl"),
            ("os.rmdir('cache/empty')", "cache/empty"),
            ("shutil.rmtree('cache')", "cache/stale.pkl"),
        ):
            with self.subTest(housekeeping):
                shutil.rmtree(self.tmp, ignore_errors=True)
                self.tmp.mkdir(parents=True)
                self._nested(housekeeping)

                found = discover(self.tmp)

                self.assertEqual([e.name for e in found.modules], ["pipeline"])
                self.assertTrue((self.tmp / gone).exists())
                self.assertFalse((self.tmp / "cache" / "moved.pkl").exists())

    def test_a_nested_write_lands_in_scratch_not_in_their_tree(self):
        self._nested("os.mkdir('cache/created')")

        discover(self.tmp)

        self.assertFalse((self.tmp / "cache" / "created").exists())

    def test_their_bytes_survive_the_two_writes_that_skip_open(self):
        """`os.truncate` takes a path, and `os.open` reports flags where a
        mode string would be, so the guard read it as "no mode, not a write"
        and let it past. Both end at a file they already have."""

        for housekeeping in (
            "os.truncate('cache/stale.pkl', 0)",
            "os.write(os.open('cache/stale.pkl', os.O_WRONLY | os.O_TRUNC), b'z')",
        ):
            with self.subTest(housekeeping):
                shutil.rmtree(self.tmp, ignore_errors=True)
                self.tmp.mkdir(parents=True)
                self._nested(housekeeping)

                discover(self.tmp)

                self.assertEqual(
                    (self.tmp / "cache" / "stale.pkl").read_text(encoding="utf-8"),
                    "theirs\n",
                )

    def test_a_link_of_their_own_into_the_tree_is_not_a_way_back_in(self):
        """A checkout that keeps `cache -> real_cache` had the doorway back,
        because linking their link as it stood pointed through their tree. No
        repository in the 2026 corpus holds one, which is why this is a test
        and not a paragraph."""

        (self.tmp / "data.txt").write_text("samples\n", encoding="utf-8")
        (self.tmp / "real_cache").mkdir()
        (self.tmp / "real_cache" / "stale.pkl").write_text("theirs\n", encoding="utf-8")
        os.symlink("real_cache", self.tmp / "cache")
        (self.tmp / "pipeline.py").write_text(
            "import os\n"
            "try:\n    os.remove('cache/stale.pkl')\nexcept OSError:\n    pass\n"
            "SAMPLES = open('data.txt').read()\n"
            "def peaks(spec):\n    return []\n",
            encoding="utf-8",
        )

        found = discover(self.tmp)

        self.assertEqual([e.name for e in found.modules], ["pipeline"])
        self.assertTrue((self.tmp / "real_cache" / "stale.pkl").exists())

    def test_reading_a_repository_leaves_no_pycache_behind(self):
        """Importing writes `__pycache__` next to the module. That is the
        platform changing a tree it was asked to read, and it made `git
        status` dirty in a checkout that had only run `cogworks check`."""

        (self.tmp / "pipeline.py").write_text(
            "def peaks(spec):\n    return []\n", encoding="utf-8"
        )

        discover(self.tmp)

        self.assertEqual(self._entries(), {"pipeline.py"})

    def test_a_relative_read_at_depth_still_finds_their_file(self):
        """The retry exists for this. Closing the doorway may not close it."""

        (self.tmp / "data.txt").write_text("samples\n", encoding="utf-8")
        nested = self.tmp / "data" / "audio"
        nested.mkdir(parents=True)
        (nested / "trumpet.wav").write_bytes(b"RIFF-pretend")
        (self.tmp / "pipeline.py").write_text(
            "AUDIO = open('data/audio/trumpet.wav', 'rb').read()\n"
            "SAMPLES = open('data.txt').read()\n"
            "def peaks(spec):\n    return []\n",
            encoding="utf-8",
        )

        found = discover(self.tmp)

        self.assertEqual(found.modules[0].module.AUDIO, b"RIFF-pretend")


class AFileShadowedByTheRootIsReadUnderItsFolderName(unittest.TestCase):
    """One 2026 repository keeps `image_caption_model.py` at the root with no
    `load`, and the copy under `model_tests/` that its scripts import and
    that reads the trained weights. The second stem was skipped as a
    duplicate, so the only encoder that could load their file was never
    read."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "model.py").write_text("WHICH = 'root'\n")
        (self.tmp / "tests").mkdir()
        (self.tmp / "tests" / "model.py").write_text("WHICH = 'tests'\n")
        (self.tmp / "Day 4").mkdir()
        (self.tmp / "Day 4" / "model.py").write_text("WHICH = 'day'\n")

    def test_both_files_load_and_the_root_keeps_the_bare_name(self):
        found = discover(self.tmp)

        names = {entry.name: entry.module.WHICH for entry in found.modules}
        self.assertEqual(names.get("model"), "root")
        self.assertEqual(names.get("tests.model"), "tests")
        # A folder that is not an identifier has no importable name.
        self.assertNotIn("Day 4.model", names)


class ADeclaredWeekRootReadsOnlyItsOwnFiles(unittest.TestCase):
    """A repository holding Week1, Week2, and Week3 with `Week3` declared was
    read whole, and a week 2 function bound as the week 3 store. The rule
    that a matched week directory reads only what lives under it now covers
    a declared one too."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        for week in ("Week2", "Week3"):
            (self.tmp / week).mkdir()
            (self.tmp / week / "{}_code.py".format(week.lower())).write_text("X = 1\n")
        (self.tmp / "Week3" / "inner").mkdir()
        (self.tmp / "Week3" / "inner" / "deeper.py").write_text("Y = 2\n")

    def test_the_other_week_is_not_read(self):
        found = discover(self.tmp, declared_root="Week3")

        names = sorted(entry.name for entry in found.modules)
        self.assertEqual(names, ["deeper", "week3_code"])


class AStudentFileNeverDisplacesARealModule(unittest.TestCase):
    """An independent review loaded a fixture under `json.tool` and a later
    import in the same process received student code; a root `json.py`
    displaced the real `json` for the rest of the process."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_a_dotted_name_that_already_exists_is_not_taken(self):
        import json.tool

        real_tool = sys.modules["json.tool"]
        (self.tmp / "tool.py").write_text("X = 'root'\n")
        (self.tmp / "json").mkdir()
        (self.tmp / "json" / "tool.py").write_text("STUDENT = True\n")

        found = discover(self.tmp)

        self.assertIn("tool", [entry.name for entry in found.modules])
        self.assertNotIn("json.tool", [entry.name for entry in found.modules])
        self.assertIs(sys.modules["json.tool"], real_tool)

    def test_a_displaced_module_is_put_back_when_discovery_leaves(self):
        import json

        real_json = sys.modules["json"]
        (self.tmp / "json.py").write_text("X = 1\n")

        found = discover(self.tmp)

        self.assertEqual([entry.name for entry in found.modules], ["json"])
        self.assertIs(sys.modules["json"], real_json)
        self.assertEqual(json.loads("[1]"), [1])


class AFileTheirOwnScriptsAlreadyImportedIsStillRead(unittest.TestCase):
    """Bagel's `get_model_embeddings.py` imports `model_tests.image_caption_model`
    before discovery reaches that file, so the name is in `sys.modules` by
    then. A guard that read the live table skipped the one encoder that
    loads their weights."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "model.py").write_text("WHICH = 'root'\n")
        (self.tmp / "tests").mkdir()
        (self.tmp / "tests" / "model.py").write_text("WHICH = 'tests'\n")
        (self.tmp / "script.py").write_text("from tests.model import WHICH\n")

    def test_the_shadowed_file_loads_under_its_folder_name(self):
        found = discover(self.tmp)

        names = {entry.name: entry.module.WHICH for entry in found.modules}
        self.assertEqual(names.get("tests.model"), "tests")


class OnlyAnInstalledModuleIsPutBackAfterDiscovery(unittest.TestCase):
    """A bare module loaded from another repository is not installed state.

    Discovery must leave the repository's own module in place instead of
    restoring unrelated code under the same import name.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.addCleanup(sys.modules.pop, "database", None)

    def test_a_bare_module_from_another_repository_is_not_restored(self):
        import types

        other_repository_module = types.ModuleType("database")
        other_repository_module.__file__ = str(
            self.tmp / "other-repository" / "database.py"
        )
        sys.modules["database"] = other_repository_module
        (self.tmp / "database.py").write_text("MINE = True\n")

        discover(self.tmp)

        self.assertIsNot(sys.modules.get("database"), other_repository_module)


class APlatformWithoutForkStillReadsTheRepository(unittest.TestCase):
    """Windows has no fork. The survey runs in-process there rather than
    reporting that nothing could be read."""

    def test_the_survey_reads_the_modules_anyway(self):
        import cogbench.discover as discover_module

        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        (root / "theirs.py").write_text("def solve(x):\n    return x\n")

        real_fork = getattr(os, "fork", None)
        if real_fork is not None:
            del os.fork
        try:
            found = discover_module.survey(root)
        finally:
            if real_fork is not None:
                os.fork = real_fork

        self.assertTrue(found.looked)
        self.assertEqual(found.module_names, ["theirs"])


class _Fixture(unittest.TestCase):
    """A repository to read and somewhere outside it to leave a trace.

    The trace file lives outside the repository on purpose: discovery makes a
    scratch directory the working directory, and a student module writing
    beside itself would be testing the write guard rather than the import.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.outside = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.outside, ignore_errors=True)
        self.trace = self.outside / "ran.log"

    def _records(self, text: str) -> str:
        """Source for a module that notes each time its body runs."""

        return (
            "with open({!r}, 'a') as _handle:\n"
            "    _handle.write('ran\\n')\n"
        ).format(str(self.trace)) + text

    def _times_run(self) -> int:
        if not self.trace.exists():
            return 0
        return len(self.trace.read_text().split())

    def _module(self, found, name):
        matching = [entry for entry in found.modules if entry.name == name]
        self.assertEqual(len(matching), 1, "expected one {!r}, got {}".format(
            name, [entry.name for entry in found.modules]
        ))
        return matching[0].module


class AnInitializerRunsAsItsPackage(_Fixture):
    """``from .core import Detector`` in an ``__init__.py`` is offering a name.

    The file was run as a standalone module and its globals copied across
    afterwards, so every relative import in it failed with "attempted relative
    import with no known parent package" and the package was reported as a
    skipped module a student cannot act on: their file is correct.
    """

    def _package(self):
        core = self.tmp / "core"
        core.mkdir()
        (core / "detector.py").write_text(
            "class Detector:\n    def detect(self, x):\n        return x\n"
        )
        (core / "__init__.py").write_text(
            "from .detector import Detector\n"
            "\n"
            "THRESHOLD = 0.5\n"
            "\n"
            "def make_detector():\n"
            "    return Detector()\n"
        )
        return core

    def test_a_relative_import_in_an_initializer_resolves(self):
        self._package()

        found = discover(self.tmp)

        self.assertEqual(
            [entry.detail for entry in found.skipped if entry.name == "__init__"], []
        )
        body = self._module(found, "__init__")
        self.assertEqual(type(body.make_detector()).__name__, "Detector")

    def test_what_the_initializer_offers_is_in_the_namespace(self):
        """A benchmark searches `Discovery.namespace`. A name that exists only
        because the initializer defined it was not in it."""

        self._package()

        found = discover(self.tmp)

        offered = [
            module for module in found.namespace if hasattr(module, "make_detector")
        ]
        self.assertEqual(len(offered), 1)
        self.assertEqual(offered[0].THRESHOLD, 0.5)

    def test_a_failing_initializer_is_reported_and_the_rest_is_read(self):
        core = self._package()
        (core / "__init__.py").write_text("raise ValueError('the body failed')\n")

        found = discover(self.tmp)

        failure = [entry for entry in found.skipped if entry.name == "__init__"]
        self.assertEqual(len(failure), 1)
        self.assertEqual(failure[0].reason, "raised")
        self.assertIn("the body failed", failure[0].detail)
        self.assertIn("detector", [entry.name for entry in found.modules])
        self.assertNotIn("__init__", [entry.name for entry in found.modules])

    def test_the_initializer_gets_the_caller_s_deadline(self):
        """The 30-second constant was hard-coded here while every other module
        in the same directory used the timeout the caller asked for. The skip
        detail names the number of seconds, which is how this tells the two
        apart without waiting for either."""

        core = self.tmp / "core"
        core.mkdir()
        (core / "__init__.py").write_text("while True:\n    pass\n")
        (core / "member.py").write_text("def solve(x):\n    return x\n")

        found = discover(self.tmp, import_timeout=1)

        failure = [entry for entry in found.skipped if entry.name == "__init__"]
        self.assertEqual(len(failure), 1)
        self.assertEqual(failure[0].reason, "too_slow")
        self.assertIn("after 1 seconds", failure[0].detail)
        self.assertIn("solve", dir(self._module(found, "member")))


class AFileIsReadOnceHoweverItIsReached(_Fixture):
    """One module object per source file, for the whole of one discovery.

    A second execution produces a second object with independent globals, and
    the copy discovery hands to the benchmark is the one that never saw the
    student's own setup: their registry is empty in the copy that gets
    searched and full in the copy their script holds.
    """

    def test_a_sibling_a_root_script_imported_is_not_read_again(self):
        (self.tmp / "helpers.py").write_text(self._records(
            "REGISTRY = {}\n"
            "\n"
            "def register(name):\n"
            "    REGISTRY[name] = True\n"
        ))
        (self.tmp / "aaa_main.py").write_text(
            "import helpers\nhelpers.register('from_main')\n"
        )

        found = discover(self.tmp)

        self.assertEqual(self._times_run(), 1)
        self.assertEqual(self._module(found, "helpers").REGISTRY, {"from_main": True})

    def test_a_package_member_a_root_script_imported_is_not_read_again(self):
        core = self.tmp / "core"
        core.mkdir()
        (core / "__init__.py").write_text("")
        (core / "database.py").write_text(self._records("STORE = {}\n"))
        (self.tmp / "aaa_main.py").write_text(
            "import core.database as database\ndatabase.STORE['seeded'] = 1\n"
        )

        found = discover(self.tmp)

        self.assertEqual(self._times_run(), 1)
        self.assertEqual(self._module(found, "database").STORE, {"seeded": 1})

    def test_a_sibling_reached_by_a_relative_import_is_the_same_object(self):
        """The member the student never imported is read under the package
        their own import already made, so its `from .database import STORE`
        binds the store that has their data in it."""

        core = self.tmp / "core"
        core.mkdir()
        (core / "__init__.py").write_text("")
        (core / "database.py").write_text(self._records("STORE = {}\n"))
        (core / "extra.py").write_text(
            "from .database import STORE\n"
            "\n"
            "def peek():\n"
            "    return STORE\n"
        )
        (self.tmp / "aaa_main.py").write_text(
            "import core.database as database\ndatabase.STORE['seeded'] = 1\n"
        )

        found = discover(self.tmp)

        self.assertEqual(self._times_run(), 1)
        self.assertIs(
            self._module(found, "extra").peek(), self._module(found, "database").STORE
        )
        self.assertEqual(self._module(found, "extra").peek(), {"seeded": 1})


class AShadowedFileInsideAPackageIsStillRead(_Fixture):
    """A file whose stem the root already owns is read under its folder name.

    Inside a package that name was handed to a lookup by stem, which went
    looking for `core.model.py`, found nothing, and reported the student's
    perfectly good file as "Python could not read this file as a module" --
    a syntax error, about a file with no syntax error in it.
    """

    def test_the_package_copy_is_read_and_not_called_a_syntax_error(self):
        (self.tmp / "model.py").write_text("def load():\n    return None\n")
        core = self.tmp / "core"
        core.mkdir()
        (core / "__init__.py").write_text("")
        (core / "model.py").write_text(
            "WEIGHTS = 'the trained ones'\n\ndef load():\n    return WEIGHTS\n"
        )

        found = discover(self.tmp)

        self.assertEqual(found.skipped, [])
        self.assertEqual(self._module(found, "core.model").load(), "the trained ones")


class ARetriedModuleKeepsTheIdentityItWouldHaveHad(_Fixture):
    """A module that needed one of the three retries is the same module.

    The resolver keeps a function only when its ``__module__`` equals the
    module's ``__name__``, so a retry that changed ``__name__`` would make
    every function in the file look imported from somewhere else and the
    search would discard all of them.
    """

    def test_a_package_member_read_under_a_folder_name_keeps_its_stem(self):
        (self.tmp / "model.py").write_text("def load():\n    return None\n")
        core = self.tmp / "core"
        core.mkdir()
        (core / "__init__.py").write_text("")
        (core / "model.py").write_text(
            "WEIGHTS = 'the trained ones'\n"
            "\n"
            "\n"
            "def load(key) -> DatabaseKey:\n"
            "    return WEIGHTS\n"
        )

        found = discover(self.tmp)

        entry = [item for item in found.modules if item.name == "core.model"][0]
        self.assertTrue(entry.future_annotations)
        self.assertEqual(entry.module.__name__, "model")
        self.assertEqual(entry.module.load.__module__, "model")


class ANotebookIsOneModuleHoweverItIsImported(_Fixture):
    """``from ipynb.fs.full.metadata import SongMetadata`` and the notebook
    pass lifted the same file twice, into two modules. A team's own
    ``isinstance`` across the two classes was then false, and the second
    lifting also ran without the import deadline the first one had."""

    def test_the_class_a_sibling_imported_is_the_discovered_one(self):
        (self.tmp / "metadata.ipynb").write_text(_notebook(
            "class SongMetadata:\n    def __init__(self, title):\n        self.title = title\n"
        ))
        (self.tmp / "aaa_first.py").write_text(
            "from ipynb.fs.full.metadata import SongMetadata\n"
            "\n"
            "def make(title):\n"
            "    return SongMetadata(title)\n"
        )

        found = discover(self.tmp)

        notebook = self._module(found, "metadata")
        sibling = self._module(found, "aaa_first")
        self.assertIsInstance(sibling.make("Hey"), notebook.SongMetadata)


class LiftedDefinitionsKeepWhatWasWrittenAboveThem(_Fixture):
    """Lifting started at the ``def`` or ``class`` line, so decorators were
    dropped. A ``@dataclass`` came out as a plain class with annotations and
    no ``__init__``, and the team's own ``Song("Hey")`` raised "Song() takes
    no arguments" against a notebook that is correct."""

    def test_a_decorated_class_still_behaves_as_the_decorator_makes_it(self):
        (self.tmp / "shapes.ipynb").write_text(_notebook(
            "from dataclasses import dataclass\n",
            "@dataclass\nclass Song:\n    title: str\n    plays: int = 0\n",
        ))

        found = discover(self.tmp)

        song = self._module(found, "shapes").Song("Hey")
        self.assertEqual((song.title, song.plays), ("Hey", 0))

    def test_a_signed_constant_is_kept(self):
        """Python has no negative literals, so `THRESHOLD = -1` is a unary
        minus over 1. It was dropped while the function reading it was kept,
        and that function then failed with a NameError."""

        (self.tmp / "tuning.ipynb").write_text(_notebook(
            "THRESHOLD = -1\nSCALE = +2.5\n",
            "def score(n):\n    return n * THRESHOLD * SCALE\n",
        ))

        found = discover(self.tmp)

        module = self._module(found, "tuning")
        self.assertEqual(module.THRESHOLD, -1)
        self.assertEqual(module.score(2), -5.0)


class ALiftedNotebookSaysWhetherItsAnnotationsWerePostponed(_Fixture):
    """`compile` takes its future flags from the frame calling it unless told
    not to, and this file declares postponed annotations. Every lifted
    notebook silently got them while its record said it had not, which is a
    claim about the student's module that was not true."""

    def test_an_unresolved_annotation_is_retried_and_disclosed(self):
        (self.tmp / "lifted.ipynb").write_text(_notebook(
            "def pick(x: DatabaseKey) -> int:\n    return 1\n"
        ))

        found = discover(self.tmp)

        entry = [e for e in found.modules if e.name == "lifted"][0]
        self.assertTrue(entry.future_annotations)
        self.assertTrue(found.to_dict()["modules"][0]["futureAnnotations"])


class AnObjectThatClaimsToBeAPathDoesNotEndTheSearch(_Fixture):
    """Locals on the failing frames are read for a path the benchmark can
    answer. That is a hint, not a contract: one object whose ``__fspath__``
    raised took the exception out of the import, out of `load_modules`, and
    out of `discover`, so the repository reported nothing at all."""

    def test_a_broken_fspath_costs_one_module_and_not_the_repository(self):
        artifact = self.outside / "glove.6B.200d.kv"
        artifact.write_bytes(b"the benchmark's copy")
        (self.tmp / "loader.py").write_text(
            "import os\n"
            "\n"
            "\n"
            "class Weights(os.PathLike):\n"
            "    def __fspath__(self):\n"
            "        raise RuntimeError('not really a path')\n"
            "\n"
            "\n"
            "HANDLE = Weights()\n"
            "with open('glove.6B.200d.kv', 'rb') as stream:\n"
            "    DATA = stream.read()\n"
        )
        (self.tmp / "other.py").write_text("def solve(x):\n    return x\n")

        found = discover(
            self.tmp, resource_files={"glove.6B.200d.kv": artifact}
        )

        self.assertIn("other", [entry.name for entry in found.modules])
        self.assertEqual(self._module(found, "loader").DATA, b"the benchmark's copy")


class ADirectoryThisProcessMayNotReadIsNotFatal(_Fixture):
    """Walking for a root called `iterdir` unguarded, so one unreadable
    folder raised out of `choose_root` and ended `discover`. The repository
    was lost over a directory that could not have held code we could read."""

    def test_the_readable_code_is_still_found(self):
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root can read a mode-000 directory")
        (self.tmp / "solver.py").write_text("def solve(x):\n    return x\n")
        shut = self.tmp / "shut"
        shut.mkdir()
        (shut / "hidden.py").write_text("x = 1\n")
        shut.chmod(0o000)
        self.addCleanup(shut.chmod, 0o755)

        found = discover(self.tmp)

        self.assertIn("solver", [entry.name for entry in found.modules])


class AFinderThatRaisesDoesNotEndTheSearch(_Fixture):
    """Standing in for an absent package asks every finder on the path
    whether it is there. One raising `OSError` ended the discovery before a
    single module was read, and what a third-party finder raises is not ours
    to enumerate."""

    def test_a_repository_is_still_read(self):
        class _Hostile:
            def find_spec(self, name, path=None, target=None):
                if name == "streamlit":
                    raise OSError("this finder is broken")
                return None

        hostile = _Hostile()
        sys.meta_path.insert(0, hostile)
        self.addCleanup(
            lambda: sys.meta_path.remove(hostile) if hostile in sys.meta_path else None
        )
        # A package already standing in is never asked about again, and an
        # earlier test in this process has usually stubbed it, so the finder
        # would never be reached and the test would pass either way.
        held = sys.modules.pop("streamlit", None)
        if held is not None:
            self.addCleanup(sys.modules.__setitem__, "streamlit", held)
        (self.tmp / "solver.py").write_text("def solve(x):\n    return x\n")

        found = discover(self.tmp)

        self.assertIn("solver", [entry.name for entry in found.modules])


class EachRunRecordsItsOwnStubCalls(_Fixture):
    """A stub is reused across discoveries in one interpreter, and its
    callables closed over whichever list was passed first. The second
    repository's calls were appended to the first repository's record and
    missing from its own."""

    def test_the_second_repository_reports_the_calls_it_made(self):
        if "microphone" in sys.modules and not isinstance(
            sys.modules["microphone"], discover_module._Stub
        ):
            self.skipTest("microphone is really installed here")
        first = self.tmp / "first"
        second = self.tmp / "second"
        for where in (first, second):
            where.mkdir()
            (where / "listen.py").write_text(
                "import microphone\nmicrophone.record(5)\n"
            )

        one = discover(first)
        two = discover(second)

        self.assertEqual(one.stub_calls, ["microphone.record"])
        self.assertEqual(two.stub_calls, ["microphone.record"])


class APathFromAnotherMachineIsNotRetriedHere(_Fixture):
    """A module that fails on a relative read is retried from its own folder,
    because it is right about where the file sits relative to itself. An
    absolute path names a machine instead, and `C:\\Users\\...` reads as
    relative on POSIX, so the retry ran and the record then said we imported
    from a folder we had no reason to move to."""

    def test_the_record_does_not_claim_we_moved_to_read_it(self):
        artifact = self.outside / "glove.kv"
        artifact.write_bytes(b"the benchmark's copy")
        # Built rather than written out, so the file under test holds one
        # backslash per separator the way the student's own line did.
        backslash = chr(92)
        named = backslash.join(["C:", "Users", "student", "glove.kv"])
        (self.tmp / "weights.py").write_text(
            "with open({!r}, 'rb') as stream:\n"
            "    DATA = stream.read()\n".format(named)
        )

        found = discover(self.tmp, resource_files={"glove.kv": artifact})

        entry = [item for item in found.modules if item.name == "weights"][0]
        self.assertEqual(entry.redirected, ("glove.kv",))
        self.assertIsNone(entry.cwd_hint)
        self.assertNotIn("importedFrom", found.to_dict()["modules"][0])


class ALiftedNotebookRunsOnlyWhatWasLifted(_Fixture):
    """Lifting keeps imports, definitions and plain constants and drops the
    rest, which is what stops a notebook's training loop from running during
    discovery. A cell can put two statements on one line, and taking the line
    rather than the statement carried the discarded one back in."""

    def test_a_statement_sharing_a_line_with_an_import_is_left_behind(self):
        marker = self.outside / "ran.txt"
        cell = (
            "import pathlib; pathlib.Path({!r}).write_text('the cell ran')\n"
            "def solve(x):\n    return x\n".format(str(marker))
        )
        (self.tmp / "mixed.ipynb").write_text(_notebook(cell))

        found = discover(self.tmp)

        self.assertEqual(self._module(found, "mixed").solve(3), 3)
        self.assertFalse(marker.exists())

    @unittest.skipIf(sys.version_info < (3, 9), "parenthesized decorators are 3.9+")
    def test_a_parenthesized_decorator_is_kept_whole(self):
        """The `@` is on an earlier line than the decorator expression here,
        and starting from the expression left a stray closing bracket."""

        (self.tmp / "paren.ipynb").write_text(_notebook(
            "from dataclasses import dataclass\n",
            "@(\n    dataclass\n)\nclass Song:\n    title: str\n",
        ))

        found = discover(self.tmp)

        self.assertEqual(self._module(found, "paren").Song("Hey").title, "Hey")

    def test_a_one_line_annotated_function_is_still_recovered(self):
        """`def pick(x: Missing): return 1` has its body on the def line, so
        there is no line strictly between the two."""

        (self.tmp / "one.ipynb").write_text(_notebook("def pick(x: Missing): return 1\n"))

        found = discover(self.tmp)

        entry = [item for item in found.modules if item.name == "one"][0]
        self.assertTrue(entry.future_annotations)
        self.assertEqual(entry.module.pick(0), 1)


class ASlowNotebookImportIsStillATimeout(_Fixture):
    """The deadline is a `BaseException` so a module cannot catch and ignore
    it. Reporting it to the importing module as an `ImportError` let that
    module's own `except Exception` swallow it and carry on with no timer
    left, and a notebook that never finishes was recorded as loaded."""

    def test_the_importing_module_cannot_swallow_it(self):
        (self.tmp / "slow.ipynb").write_text(_notebook(
            "def spin(f):\n    while True:\n        pass\n    return f\n",
            "@spin\ndef thing():\n    return 1\n",
        ))
        (self.tmp / "aaa_main.py").write_text(
            "try:\n"
            "    from ipynb.fs.full.slow import thing\n"
            "except Exception:\n"
            "    pass\n"
            "MARKER = 'ran past its deadline'\n"
        )

        found = discover(self.tmp, import_timeout=1)

        self.assertEqual(found.modules, [])
        self.assertEqual(
            sorted(entry.reason for entry in found.skipped), ["too_slow", "too_slow"]
        )


class AFinderImportedNotebookKeepsItsRecord(_Fixture):
    """A notebook read first through `ipynb.fs.full` is reused by the notebook
    pass, and the pass has no notes of its own for it. The record then said
    nothing unusual had happened while the annotations had in fact been
    postponed, which is a claim about their module that was not true."""

    def test_the_retry_it_needed_is_still_disclosed(self):
        (self.tmp / "nine.ipynb").write_text(_notebook("def g(x: Missing):\n    return 1\n"))
        (self.tmp / "aaa_load.py").write_text("from ipynb.fs.full.nine import g\n")

        found = discover(self.tmp)

        entry = [item for item in found.modules if item.name == "nine"][0]
        self.assertTrue(entry.future_annotations)
        record = [item for item in found.to_dict()["modules"] if item["name"] == "nine"]
        self.assertTrue(record[0]["futureAnnotations"])


class AnInitializerCanReadItsOwnFile(_Fixture):
    """`Path(__file__).parent` in an `__init__.py`, to find a data file beside
    it, is ordinary. Giving the package its file only after the body had run
    killed the body with `NameError: name '__file__' is not defined`."""

    def test_the_package_has_its_file_while_the_body_runs(self):
        core = self.tmp / "core"
        core.mkdir()
        (core / "detector.py").write_text("class Detector:\n    pass\n")
        (core / "__init__.py").write_text(
            "from pathlib import Path\n"
            "HERE = Path(__file__).parent\n"
            "from .detector import Detector\n"
            "\n"
            "def make_detector():\n"
            "    return Detector()\n"
        )

        found = discover(self.tmp)

        self.assertEqual(found.skipped, [])
        body = self._module(found, "__init__")
        self.assertEqual(body.HERE, core)
        self.assertEqual(type(body.make_detector()).__name__, "Detector")


class ARetriedInitializerStartsWhereItStarted(_Fixture):
    """Every other retry gets a fresh module object. A package body runs in
    the package, so a retry that kept the failed attempt's globals applied
    the body's own setup twice."""

    def test_the_body_s_own_state_is_applied_once(self):
        core = self.tmp / "core"
        core.mkdir()
        (core / "__init__.py").write_text(
            'if "STATE" not in globals():\n'
            "    STATE = []\n"
            "STATE.append(1)\n"
            "\n"
            "\n"
            "def f(x: Missing):\n"
            "    return STATE\n"
        )

        found = discover(self.tmp)

        entry = [item for item in found.modules if item.name == "__init__"][0]
        self.assertTrue(entry.future_annotations)
        self.assertEqual(entry.module.STATE, [1])


class APackageMemberImportingItsOwnPackageIsReadOnce(_Fixture):
    """`import core.b` written inside `core/a.py` is served by the ordinary
    import system under the directory's own name, while a sibling's `from .
    import b` resolves through the synthetic package. Both ran the file, and
    the two copies then held different state."""

    def test_both_spellings_reach_one_module(self):
        core = self.tmp / "core"
        core.mkdir()
        (core / "__init__.py").write_text("")
        (core / "a.py").write_text("import core.b\ncore.b.SEEN.append('from a')\n")
        (core / "b.py").write_text("SEEN = []\n")
        (core / "c.py").write_text(
            "from . import b\n\n\ndef peek():\n    return b.SEEN\n"
        )

        found = discover(self.tmp)

        self.assertIs(
            self._module(found, "c").peek(), self._module(found, "b").SEEN
        )
        self.assertEqual(self._module(found, "b").SEEN, ["from a"])


class AFailureThatCannotBeDescribedIsStillReported(_Fixture):
    """Building the skip record runs the student's own `__str__`. One that
    raises, or returns something that is not a string, carried the exception
    back out of the import and ended the whole discovery, from inside the
    code meant to contain it."""

    def test_a_broken_str_costs_one_module_and_not_the_repository(self):
        (self.tmp / "aaa_main.py").write_text(
            "class StudentError(Exception):\n"
            "    def __str__(self):\n"
            "        return None\n"
            "\n"
            "\n"
            "raise StudentError()\n"
        )
        (self.tmp / "helper.py").write_text("def solve(x):\n    return x\n")

        found = discover(self.tmp)

        self.assertIn("helper", [entry.name for entry in found.modules])
        failure = [entry for entry in found.skipped if entry.name == "aaa_main"][0]
        self.assertEqual(failure.reason, "raised")
        self.assertIn("StudentError", failure.detail)


class AnythingCanBeInSysModules(_Fixture):
    """Finding out whether a file has already been read means looking at every
    entry in `sys.modules`, and code elsewhere in the process puts objects
    there that answer attribute access with whatever they like."""

    def test_a_hostile_entry_does_not_end_the_search(self):
        self.addCleanup(sys.modules.pop, "cogbench_test_hostile", None)
        # Put there by a module discovery is reading, not before it starts.
        # An entry that was already present is in `_PREEXISTING`, which every
        # scan skips, so planting it early tests nothing.
        (self.tmp / "aaa_plant.py").write_text(
            "import sys\n"
            "\n"
            "\n"
            "class Hostile:\n"
            "    __slots__ = ()\n"
            "\n"
            "    def __getattr__(self, name):\n"
            "        raise RuntimeError('this object refuses ' + name)\n"
            "\n"
            "\n"
            "sys.modules['cogbench_test_hostile'] = Hostile()\n"
        )
        (self.tmp / "solver.py").write_text("def solve(x):\n    return x\n")

        found = discover(self.tmp)

        self.assertIn("solver", [entry.name for entry in found.modules])


class ANamespacePackageDoesNotOutliveTheRun(_Fixture):
    """A package Python built for a directory with no `__init__.py` has no
    `__file__`, so eviction by file location could not see it, and it stayed
    in `sys.modules` holding a search path into a finished checkout. The next
    repository's `import core.database` then found the last one's."""

    def test_the_package_their_import_made_is_evicted(self):
        core = self.tmp / "core"
        core.mkdir()
        (core / "m.py").write_text("V = 1\n")
        (self.tmp / "aaa_main.py").write_text("import core.m\n")
        before = set(sys.modules)
        self.addCleanup(
            lambda: [sys.modules.pop(n, None) for n in set(sys.modules) - before]
        )

        discover(self.tmp)

        self.assertNotIn("core", sys.modules)
        self.assertNotIn("core.m", sys.modules)


class ANestedPackageTheirImportMadeIsEvictedSafely(_Fixture):
    """A namespace package's `__path__` is not inert: resolving it looks its
    parent up in `sys.modules`, and teardown is emptying that table while it
    decides what to evict. With `core` gone before `core.sub`, asking the
    child where it searches raised `KeyError` out of `discover`."""

    def test_both_levels_go_and_neither_takes_the_run_down(self):
        nested = self.tmp / "core" / "sub"
        nested.mkdir(parents=True)
        (nested / "m.py").write_text("V = 1\n")
        (self.tmp / "aaa_main.py").write_text("import core.sub.m\n")
        before = set(sys.modules)
        self.addCleanup(
            lambda: [sys.modules.pop(n, None) for n in set(sys.modules) - before]
        )

        discover(self.tmp)

        self.assertNotIn("core", sys.modules)
        self.assertNotIn("core.sub", sys.modules)

    def test_a_child_whose_parent_is_already_gone_answers_rather_than_raises(self):
        """The ordering above is a set's, so pin the hazard directly."""

        from importlib._bootstrap_external import _NamespacePath
        from types import ModuleType

        parent = ModuleType("cogbench_test_ns")
        parent.__path__ = _NamespacePath(
            "cogbench_test_ns", [str(self.tmp)], lambda *a: None
        )
        sys.modules["cogbench_test_ns"] = parent
        self.addCleanup(sys.modules.pop, "cogbench_test_ns", None)
        # Built while the parent is still there, because building one looks
        # the parent up as well. Then the parent goes, which is the state
        # teardown reaches partway through emptying the table.
        child = ModuleType("cogbench_test_ns.leaf")
        child.__path__ = _NamespacePath(
            "cogbench_test_ns.leaf", [str(self.tmp)], lambda *a: None
        )
        sys.modules.pop("cogbench_test_ns", None)

        self.assertFalse(
            discover_module._searches_inside(child, (self.tmp,))
        )


class ARetriedInitializerKeepsWhatItAlreadyImported(_Fixture):
    """Python keeps an imported submodule as an attribute of its package. One
    the failed attempt imported is still in `sys.modules`, so the retry's
    import of it is a cache hit that sets no attribute, and resetting the
    package namespace alone left `core.child` importable and `core.child`
    unreachable."""

    def test_the_submodule_is_still_reachable_through_the_package(self):
        core = self.tmp / "core"
        core.mkdir()
        (core / "child.py").write_text("def helper():\n    return 'the child ran'\n")
        # `from .child import helper`, not `from . import child`. The bare
        # form is rebound by the retry anyway, because `IMPORT_FROM` falls
        # back to `sys.modules` when the attribute is missing, so it passes
        # whether or not the attribute was preserved.
        (core / "__init__.py").write_text(
            "from .child import helper\n"
            "\n"
            "\n"
            "def f(x: Missing):\n"
            "    return helper()\n"
        )

        found = discover(self.tmp)

        body = self._module(found, "__init__")
        self.assertEqual(body.child.helper(), "the child ran")
        self.assertEqual(body.f(None), "the child ran")


class ASecondNotebookSpellingDoesNotEraseTheFirstReading(_Fixture):
    """`ipynb.fs.defs.x` after `ipynb.fs.full.x` reuses the module and has no
    notes of its own. Storing those emptied the record of the read that
    actually happened, and the notebook was reported as having needed no
    remedy when it had needed one."""

    def test_the_retry_survives_the_second_import(self):
        (self.tmp / "nine.ipynb").write_text(_notebook("def g(x: Missing):\n    return 1\n"))
        (self.tmp / "aaa_full.py").write_text("from ipynb.fs.full.nine import g\n")
        (self.tmp / "aab_defs.py").write_text("from ipynb.fs.defs.nine import g\n")

        found = discover(self.tmp)

        entry = [item for item in found.modules if item.name == "nine"][0]
        self.assertTrue(entry.future_annotations)


class ASyntaxErrorNamesTheFileItIsIn(_Fixture):
    """A module importing a sibling with a syntax error fails with that
    sibling's `SyntaxError`. Reporting it against the importer sent a team to
    look at a file that is correct: `main.py` was blamed for `line 4:
    expected ':'`, which is in `bad_syntax.py`."""

    def test_the_importer_is_not_blamed_for_its_sibling(self):
        (self.tmp / "bad_syntax.py").write_text(
            "def broken(\n    x,\n    y\n    return x\n"
        )
        (self.tmp / "main.py").write_text("import bad_syntax\n")

        found = discover(self.tmp)

        blamed = [entry for entry in found.skipped if entry.name == "main"][0]
        self.assertEqual(blamed.reason, "syntax")
        self.assertIn("bad_syntax.py", blamed.detail)
        itself = [entry for entry in found.skipped if entry.name == "bad_syntax"][0]
        self.assertNotIn("of ", itself.detail)


if __name__ == "__main__":
    unittest.main()
