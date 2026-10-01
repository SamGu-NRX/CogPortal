"""Replayed identity slots name the inputs on the new reading."""

import sys
import tempfile
import unittest
from array import array
from pathlib import Path
from types import ModuleType

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cogbench._namespace import Bundle, Project, Unmapped
from cogbench.pipeline import Binding, Candidate, Fixtures, Role, _FitProvenance
from cogbench.resolve import _renewed


class PhotoPaths(list):
    def __init__(self, root, readings, paths=()):
        super().__init__(paths)
        self.root = root
        self.readings = readings

    def __deepcopy__(self, memo):
        directory = self.root / "reading-{}".format(len(self.readings))
        directory.mkdir()
        paths = [directory / name for name in ("a.png", "b.png")]
        for path in paths:
            path.write_bytes(b"fixture")
        copied = PhotoPaths(self.root, self.readings, paths)
        memo[id(self)] = copied
        self.readings.append(paths)
        return copied


class IdentityRebinding(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.source = self.root / "theirs.py"
        self.source.write_text(
            "def read(rows):\n    return [1 for row in rows]\n"
            "def graph(rows, names):\n    return [(row, names[i]) for i, row in enumerate(rows)]\n"
            "def keyword_graph(rows, *, names):\n    return graph(rows, names)\n"
            "def answer(rows, table):\n    return table\n"
        )
        self.module = ModuleType("theirs")
        exec(self.source.read_text(), self.module.__dict__)

    def candidate(self, name, **kwargs):
        return Candidate("theirs." + name, getattr(self.module, name), "theirs", **kwargs)

    def renew(self, binding, handed, role=None):
        project = Project(self.root, {"theirs": str(self.source)})
        self.addCleanup(project.close)
        return _renewed(binding, project, handed, role)

    def graph(self, **kwargs):
        return self.candidate("graph", plan=("value", "identity"),
                              supplied={"identity": ("old-a", "old-b")}, **kwargs)

    def test_arrays_keep_positional_identities_in_actual_replay(self):
        rows = [array("d", [1, 0]), array("d", [0, 1])]
        binding = Binding("root", (self.graph(),))
        renewed = self.renew(binding, Bundle((rows,)).again())
        self.assertEqual(renewed.steps[0].bound(rows), [(rows[0], 0), (rows[1], 1)])

    def test_downstream_identity_uses_the_first_steps_selected_path_form(self):
        for keyword in (False, True):
            with self.subTest(keyword=keyword):
                with tempfile.TemporaryDirectory(dir=str(self.root)) as directory:
                    readings = []
                    paths = PhotoPaths(Path(directory), readings)
                    forms = Fixtures((([array("d", [1]), array("d", [2])],), (paths,)))
                    bundle = Bundle(forms)
                    graph = self.graph() if not keyword else self.candidate(
                        "keyword_graph", plan=("value",), keyword_plan=(("names", "identity"),),
                        supplied={"identity": ("old-a", "old-b")},
                    )
                    graph = graph.with_plan(graph.plan,
                        supplied={"identity": tuple(str(path) for path in readings[0])},
                        keyword_plan=graph.keyword_plan)
                    binding = Binding("root", (self.candidate("read", form=1), graph))
                    handed = bundle.again()
                    renewed = self.renew(binding, handed)
                    selected = handed.case().for_chain(renewed.steps)
                    values = renewed.steps[0].bound(*selected)
                    self.assertEqual(renewed.steps[1].bound(values),
                                     [(1, str(path)) for path in selected[0]])
                    self.assertNotEqual(selected[0], readings[0])
                    self.assertTrue(all(path.exists() for path in selected[0]))

    def test_explicit_identities_override_inferred_names(self):
        rows = [array("d", [1]), array("d", [2])]
        binding = Binding("root", (self.graph(),))
        renewed = self.renew(binding, Bundle((rows,), identities=("alpha", "beta")).again())
        self.assertEqual(renewed.steps[0].bound(rows),
                         [(rows[0], "alpha"), (rows[1], "beta")])

    def test_a_fit_uses_its_own_selected_fixture(self):
        fit = self.graph(form=1, _fit_provenance=_FitProvenance(("root",), 0))
        answer = self.candidate("answer", plan=("value", "extra:table"))
        paths = [self.root / "fit-a", self.root / "fit-b"]
        fixture = Fixtures((([0],), (paths,)))
        handed = Bundle(([999],), fits=((("root",), 0, fixture),)).again()
        renewed = self.renew(Binding("root", (answer,), fits=(("table", fit),)), handed)
        self.assertEqual(renewed.steps[0].bound([999]),
                         [(path, str(path)) for path in paths])

    def test_a_branch_uses_one_fresh_generated_case_for_names_and_values(self):
        made = []

        def fixture(pool, chains):
            paths = [self.root / ("branch-{}-{}".format(len(made), i)) for i in range(2)]
            made.append(paths)
            return Fixtures((([999],), (paths,)))

        chain = (self.graph(form=1),)
        answer = self.candidate("answer", plan=("value", "extra:branch"))
        role = Role("root", (), branches=(Role("branch", (), fixture=fixture),))
        binding = Binding("root", (answer,), branches={"branch": chain},
                          _reach=(self.graph(branch="branch"),))
        renewed = self.renew(binding, Bundle(([999],)).again(), role)
        self.assertEqual(len(made), 1)
        self.assertEqual(renewed.steps[0].bound([999]),
                         [(path, str(path)) for path in made[0]])
        self.assertEqual(renewed._reach[0].bound(made[0]),
                         [(path, str(path)) for path in made[0]])

    def test_explicit_branch_names_do_not_eagerly_run_unused_fixture(self):
        def fixture(pool, chains):
            raise AssertionError("unused branch fixture ran")

        chain = (self.graph(form=1),)
        role = Role("root", (), branches=(Role("branch", (), fixture=fixture),))
        binding = Binding("root", (), branches={"branch": chain})
        renewed = self.renew(binding, Bundle((), identities=("alpha", "beta")).again(), role)
        self.assertEqual(renewed.branches["branch"][0].bound([1, 2]),
                         [(1, "alpha"), (2, "beta")])

    def test_a_branch_without_an_input_declaration_fails_by_name(self):
        binding = Binding("root", (), branches={"missing": (self.graph(),)})
        with self.assertRaises(Unmapped) as raised:
            self.renew(binding, Bundle(([1, 2],)).again())
        self.assertEqual((raised.exception.reason, raised.exception.label),
                         ("branch_input", "missing"))
        self.assertEqual(raised.exception.detail, "the binding has no declared input")
