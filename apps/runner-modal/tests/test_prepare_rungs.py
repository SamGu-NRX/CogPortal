"""The order the prepare step resolves a repository in.

Prepare runs as a source string inside a Modal sandbox, so it cannot be
imported and unit-tested directly. What can be checked here is the thing that
would be most damaging to get wrong and least visible when it breaks: which
rung wins.

A team that declares its own submission must be scored by that declaration.
Discovery infers a binding by running their functions, and an inference that
could shadow a declaration would silently score our guess about their code
instead of the code they told us to run.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))

from cogworks_runner.modal_app import EVALUATE_SCRIPT, PREPARE_SCRIPT  # noqa: E402


class TheScriptsAreValidPython(unittest.TestCase):
    """Both sandbox steps are source strings, so nothing compiles them until
    they run inside Modal. A syntax error therefore costs a deploy and a real
    run to discover.

    The way to write one is a triple-quoted docstring inside a script whose
    own delimiter is triple quotes: the inner one closes the outer, and the
    rest of the script becomes module code that happens to still parse."""

    def test_prepare_parses(self):
        import ast

        ast.parse(PREPARE_SCRIPT)

    def test_evaluate_parses(self):
        import ast

        ast.parse(EVALUATE_SCRIPT)


class WiringReachesTheRunPage(unittest.TestCase):
    """A score that rests on an inference should show the inference.

    Nothing in a 2026 repository says which function is the peak finder, so
    the platform decides by running them. A team who cannot see which
    functions we chose cannot tell a wrong choice from a low score."""

    def test_the_evaluate_step_writes_which_functions_it_ran(self):
        self.assertIn("/tmp/cog-wiring.json", EVALUATE_SCRIPT)

    def test_writing_it_never_costs_the_run(self):
        """The score is the point; the explanation is worth less than it."""

        index = EVALUATE_SCRIPT.find("/tmp/cog-wiring.json")
        surrounding = EVALUATE_SCRIPT[max(0, index - 900) : index + 200]

        self.assertIn("try:", surrounding)
        self.assertIn("except Exception:", surrounding)

    def test_a_repository_that_declared_its_own_submission_reports_none(self):
        """There is no inference to show when a team told us where their code
        is, and an empty panel would imply we guessed."""

        from cogworks_runner import modal_app

        modal_app._WIRING.clear()

        class _NoFile:
            class filesystem:
                @staticmethod
                def read_text(_path):
                    raise FileNotFoundError

        modal_app._collect_wiring(_NoFile())

        self.assertEqual(modal_app._WIRING, [])

    def test_a_wiring_record_is_capped(self):
        from cogworks_runner import modal_app
        import json as _json

        class _Many:
            class filesystem:
                @staticmethod
                def read_text(_path):
                    return _json.dumps([{"stage": str(i), "function": "f"} for i in range(40)])

        modal_app._collect_wiring(_Many())

        self.assertEqual(len(modal_app._WIRING), 16)


class RungOrderTests(unittest.TestCase):
    def _position(self, needle: str) -> int:
        index = PREPARE_SCRIPT.find(needle)
        self.assertNotEqual(index, -1, "prepare no longer contains: {}".format(needle))
        return index

    def test_discovery_runs_after_both_ways_a_repository_can_declare_itself(self):
        entry_point = self._position('resolved_by = "entry_point"')
        own_file = self._position('resolved_by = (\n        "instructor_adapter:"')
        discovery = self._position("from cogbench.resolve import resolve")

        self.assertLess(entry_point, discovery)
        self.assertLess(own_file, discovery)

    def test_discovery_only_runs_when_nothing_else_resolved(self):
        """Guarded on `resolved_by is None`, not merely ordered after."""

        discovery = self._position("from cogbench.resolve import resolve")
        guard = PREPARE_SCRIPT.rfind("if resolved_by is None:", 0, discovery)

        self.assertNotEqual(guard, -1)
        self.assertIn("discovery = None", PREPARE_SCRIPT[:guard])

    def test_a_failed_search_does_not_take_the_sandbox_with_it(self):
        """The report is what a student reads. A traceback out of prepare
        replaces it with our stack instead of their verdict."""

        discovery = self._position("from cogbench.resolve import resolve")
        after = PREPARE_SCRIPT[discovery:]

        self.assertIn("except Exception as error:", after)
        self.assertLess(after.find("except Exception as error:"), after.find("if resolved_by is None:"))

    def test_the_verdict_is_written_where_the_caller_can_read_it(self):
        self.assertIn("/tmp/discovery.json", PREPARE_SCRIPT)

    def test_the_failure_message_carries_the_verdict_rather_than_only_a_refusal(self):
        """"No adapter found" told a student nothing they could act on."""

        message = PREPARE_SCRIPT[self._position("No adapter found in {}"):]

        self.assertIn("headline", PREPARE_SCRIPT[: self._position("No adapter found in {}")])
        self.assertIn("detail", message[:400])


if __name__ == "__main__":
    unittest.main()
