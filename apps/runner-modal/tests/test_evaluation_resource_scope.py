"""A submission reads a course file while it runs, not only while it is found.

`from_spec` holds the benchmark's course-file mapping while it searches a
repository and drops it when it returns, so anything read during the candidate
call is outside that scope. A captured alias survives, which is why the one
repository driven so far worked; a lookup through the module, or a first import
inside the call, does not, and the evaluation sandbox has no network for the
real loader to reach.
"""

from __future__ import annotations

import ast
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

DOWNLOADED = "/root/.cache/cog_data/captions_train2014.json"
STAGED = "/opt/cogworks-data/week3/captions_train2014.json"


def evaluate_script() -> str:
    source = (
        ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"
    ).read_text(encoding="utf-8")
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "EVALUATE_SCRIPT":
            return node.value.value
    raise AssertionError("EVALUATE_SCRIPT is no longer a plain string constant")


class StubCourseLoader:
    """`cogworks_data.language`, which downloads what it is not given."""

    def __enter__(self):
        package = types.ModuleType("cogworks_data")
        module = types.ModuleType("cogworks_data.language")
        module.get_data_path = lambda name: DOWNLOADED
        package.language = module
        self._saved = {
            key: sys.modules.get(key) for key in ("cogworks_data", "cogworks_data.language")
        }
        sys.modules["cogworks_data"] = package
        sys.modules["cogworks_data.language"] = module
        return module

    def __exit__(self, *exc):
        for key, value in self._saved.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value


class TheStagedMappingCoversEveryLookupShape(unittest.TestCase):
    def setUp(self):
        from cogbench.discover import _Redirects

        self.scope = lambda: _Redirects({"captions_train2014.json": Path(STAGED)})

    def test_a_module_attribute_lookup_reaches_the_staged_file(self):
        """`language.get_data_path(...)`, resolved when it is called."""

        with StubCourseLoader() as module:
            self.assertEqual(module.get_data_path("captions_train2014.json"), DOWNLOADED)
            scope = self.scope()
            scope.enter()
            try:
                observed = sys.modules["cogworks_data.language"].get_data_path(
                    "captions_train2014.json"
                )
            finally:
                scope.leave()
        self.assertEqual(observed, STAGED)

    def test_a_first_import_inside_the_call_reaches_the_staged_file(self):
        """The shape that has no alias to capture, because the import happens
        after resolution has already returned."""

        with StubCourseLoader():
            sys.modules.pop("cogworks_data.language", None)
            sys.modules.pop("cogworks_data", None)
            package = types.ModuleType("cogworks_data")
            module = types.ModuleType("cogworks_data.language")
            module.get_data_path = lambda name: DOWNLOADED
            package.language = module

            scope = self.scope()
            scope.enter()
            try:
                # Registering the module now is what an import does; the scope's
                # import hook is what notices and patches it.
                sys.modules["cogworks_data"] = package
                sys.modules["cogworks_data.language"] = module
                __import__("cogworks_data.language")
                from cogworks_data.language import get_data_path

                observed = get_data_path("captions_train2014.json")
            finally:
                scope.leave()
        self.assertEqual(observed, STAGED)

    def test_leaving_the_scope_restores_the_real_loader(self):
        with StubCourseLoader() as module:
            scope = self.scope()
            scope.enter()
            scope.leave()
            self.assertEqual(module.get_data_path("captions_train2014.json"), DOWNLOADED)


class TheSandboxHoldsItAcrossTheCandidateCall(unittest.TestCase):
    def test_every_benchmark_run_is_inside_the_course_file_scope(self):
        """Wiring, because the behaviour above is only useful if the script
        actually holds the scope while the submission runs."""

        script = evaluate_script()
        tree = ast.parse(script)
        guarded_calls = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.With):
                continue
            names = {
                item.context_expr.id
                for item in node.items
                if isinstance(item.context_expr, ast.Name)
            }
            if "course_files" not in names:
                continue
            for inner in ast.walk(node):
                if isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute):
                    if inner.func.attr == "run":
                        guarded_calls.append(inner)
        self.assertTrue(guarded_calls, "no benchmark.run(...) is held inside course_files")

        guarded = {id(call) for call in guarded_calls}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr == "run" and getattr(node.func.value, "id", "") == "benchmark":
                    self.assertIn(
                        id(node),
                        guarded,
                        "a benchmark.run(...) call runs outside the course-file scope",
                    )


    def test_every_load_student_call_takes_both_halves(self):
        """The script is a string no test executes, so its one contract with
        `load_student` is checked here instead.

        Every branch has to unpack the factory and the scope. A branch that
        took only the factory would raise inside a real Modal run and nowhere
        else.
        """

        tree = ast.parse(evaluate_script())
        calls = 0
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            call = node.value
            if not (isinstance(call, ast.Call) and getattr(call.func, "id", "") == "load_student"):
                continue
            calls += 1
            target = node.targets[0]
            self.assertIsInstance(
                target, ast.Tuple, "load_student's result is not unpacked at line {}".format(node.lineno)
            )
            self.assertEqual(len(target.elts), 2, node.lineno)
        self.assertEqual(calls, 4, "expected one load_student call per payload branch")


if __name__ == "__main__":
    unittest.main()
