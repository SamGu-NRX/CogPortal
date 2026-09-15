"""Whose failure it was is decided by how far the run got, not by its words.

Staging runs `run_158c8e88c3` and `run_ff26a6ceec`'s predecessor both stopped
because the Week 2 image carried no CelebA, so `discovery()` could not build
its fixture. The student saw "No adapter found ... and no set of functions in
it performed the benchmark's task" and two commands to run on their laptop.
Their code was fine; it scores 0.9250 and 0.7556.

The distinction is positional. Loading our plugin and asking the week to
describe its task happen before anything reads the repository, so a failure
there cannot be the team's. Once `from_spec` runs, their code is running, and
a failure is theirs or unattributable; either way it is not ours to claim.

These tests execute the shipped source of that decision rather than a copy of
it, and pin the controller's routing of both messages.
"""

from __future__ import annotations

import ast
import pathlib
import sys
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
MODAL_APP = ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"


def _prepare_scripts() -> str:
    """PREPARE_SCRIPT's own text, from the module that ships it."""

    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "PREPARE_SCRIPT":
            return node.value.value
    raise AssertionError("PREPARE_SCRIPT not found")


PREPARE_SCRIPT = _prepare_scripts()
#: The discovery decision, sliced out of the shipped script. Executing the
#: whole script would need an HTTP server and a tarball; this is the part the
#: provenance question lives in.
DECISION = PREPARE_SCRIPT[PREPARE_SCRIPT.index("discovery = None") : PREPARE_SCRIPT.index("# Read by the evaluate sandbox")]


#: The script imports cogbench, so these are stubbed. Everything under
#: `unittest discover` shares one interpreter, so they are put back afterwards;
#: leaving them behind made 46 later tests in other modules error.
_STUBBED = ("cogbench", "cogbench.plugins", "cogbench.resolve")


def _stub_cogbench(describes, from_spec):
    plugins = types.ModuleType("cogbench.plugins")
    plugins.load_benchmark = lambda _id: types.SimpleNamespace(discovery=describes)
    resolve = types.ModuleType("cogbench.resolve")
    resolve.from_spec = from_spec
    sys.modules.update(
        {
            "cogbench": types.ModuleType("cogbench"),
            "cogbench.plugins": plugins,
            "cogbench.resolve": resolve,
        }
    )


def _run_decision(describes, from_spec, tmp):
    _stub_cogbench(describes, from_spec)
    namespace = {
        "resolved_by": None,
        "project": tmp,
        "benchmark_id": "vision-recognition",
        "sys": sys,
        "pathlib": pathlib,
    }
    try:
        exec(compile(DECISION, "<PREPARE_SCRIPT>", "exec"), namespace)
    except RuntimeError as error:
        return str(error), namespace.get("discovery") or {}
    return "", namespace.get("discovery") or {}


class WhoseFailureItWas(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(__file__).resolve().parent
        self.saved = {name: sys.modules.get(name) for name in _STUBBED}

    def tearDown(self):
        for name, module in self.saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def test_a_week_that_cannot_describe_its_task_is_ours(self):
        def describes():
            raise RuntimeError("Couldn't find any data file at /flwrlabs/celeba.")

        message, discovery = _run_decision(describes, None, self.tmp)

        self.assertIn("could not describe its task", message)
        self.assertNotIn("no set of functions", message)
        self.assertEqual(discovery["verdict"]["status"], "benchmark_unavailable")

    def test_a_search_that_ran_and_found_nothing_is_still_reported_as_before(self):
        def from_spec(*_args, **_keywords):
            raise RuntimeError("their module raised on import")

        message, discovery = _run_decision(lambda: object(), from_spec, self.tmp)

        self.assertIn("No adapter found", message)
        self.assertEqual(discovery["verdict"]["status"], "not_read")

    def test_a_week_with_no_discovery_still_asks_for_an_adapter(self):
        message, discovery = _run_decision(None, None, self.tmp)

        self.assertIn("No adapter found", message)
        self.assertEqual(discovery, {})

    def test_a_spec_of_none_is_ours_because_the_cache_is_ours(self):
        # Both Week 2 plugins answer None when their dataset cache is missing.
        message, discovery = _run_decision(lambda: None, None, self.tmp)

        self.assertIn("could not describe its task", message)
        self.assertEqual(discovery["verdict"]["status"], "benchmark_unavailable")

    def test_a_repository_that_binds_nothing_is_not_called_a_platform_fault(self):
        def from_spec(*_args, **_keywords):
            return types.SimpleNamespace(
                ready=False,
                to_dict=lambda: {"verdict": {"status": "not_wired", "headline": "x"}},
            )

        message, _ = _run_decision(lambda: object(), from_spec, self.tmp)

        self.assertIn("No adapter found", message)
        self.assertNotIn("could not describe its task", message)


class TheControllerRoutesBothMessages(unittest.TestCase):
    """The routing, read off the shipped controller source."""

    def setUp(self):
        self.source = MODAL_APP.read_text(encoding="utf-8")

    def test_the_platform_message_reaches_the_platform_category(self):
        index = self.source.index('(refusal or {}).get("status") == "benchmark_unavailable"')
        following = self.source[index : index + 220]

        self.assertIn('RunnerFailure("provider", "preparing"', following)

    def test_the_category_is_not_chosen_from_text_a_student_can_reach(self):
        """`normalized` carries the student's stderr; refunding on it is forgery.

        The controller already refuses to pick a category from their words, and
        the first version of this branch matched a phrase inside it. A
        `from_spec` error quoting that phrase would have been appended to "No
        adapter found" and selected the refunding category.
        """

        self.assertNotIn('"could not describe its task" in normalized', self.source)

    def test_it_carries_no_refusal_to_render(self):
        index = self.source.index('(refusal or {}).get("status") == "benchmark_unavailable"')
        following = self.source[index : index + 220]
        raised = following[following.index("RunnerFailure") : following.index(")\n")]

        # `refusal` is the verdict on the team's code. There is none to give
        # when nothing read it, and passing one is what put "nothing here did
        # the job end to end" in front of a student whose code was fine.
        self.assertNotIn("refusal", raised)

    def test_the_student_message_still_routes_where_it_did(self):
        index = self.source.index('"no adapter found" in normalized')
        following = self.source[index : index + 220]

        self.assertIn('"adapter_missing", "contract_check"', following)
        self.assertIn("refusal", following)
