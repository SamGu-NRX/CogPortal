"""A submission reads a course file while it runs, not only while it is found.

`from_spec` holds the benchmark's course-file mapping while it searches a
repository and drops it when it returns, so anything read during the candidate
call is outside that scope. A captured alias survives, which is why the one
repository driven so far worked; a lookup through the module, or a first import
inside the call, does not, and the evaluation sandbox has no network for the
real loader to reach.

The sandbox script is a string nothing imports, so the tests that matter here
execute it. `run_evaluate_script` rewrites its hardcoded `/tmp/` paths into a
temporary directory and supplies the handful of modules the sandbox would have,
then runs the real source. Everything else about it is untouched.
"""

from __future__ import annotations

import ast
import contextlib
import json
import os
import sys
import types
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

DOWNLOADED = "/root/.cache/cog_data/captions_train2014.json"
STAGED = "/opt/cogworks-data/week3/captions_train2014.json"
COURSE_FILE = "captions_train2014.json"


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


@contextlib.contextmanager
def _installed(name: str, module: types.ModuleType):
    saved = sys.modules.get(name)
    sys.modules[name] = module
    try:
        yield
    finally:
        if saved is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = saved


def run_evaluate_script(script: str, seen: list) -> None:
    """Run the real script's week 2 branch, where a submission reads a course
    file only once its results are iterated.

    Week 2 because weeks 1 and 3 refuse any interpreter but 3.8.20 and this
    suite runs on 3.11; the four branches share the shape under test.
    """

    def benchmark_run(factory, model, cases):
        # A generator, which is what makes the placement of `list(...)` matter:
        # nothing here runs until something iterates it.
        def results():
            language = sys.modules["cogworks_data.language"]
            seen.append(language.get_data_path(COURSE_FILE))
            for _case in cases:
                yield {"kind": "scenario", "ok": True}

        return results()

    benchmark = types.SimpleNamespace(
        run=benchmark_run,
        discovery=lambda: types.SimpleNamespace(resource_files={COURSE_FILE: Path(STAGED)}),
        submission_from_discovery=lambda found: object(),
    )
    plugins = types.ModuleType("cogbench.plugins")
    plugins.load_benchmark = lambda benchmark_id: benchmark
    plugins.load_submission = lambda *a, **k: object()
    resolve = types.ModuleType("cogbench.resolve")
    resolve.from_spec = lambda *a, **k: types.SimpleNamespace(
        ready=True, verdict=types.SimpleNamespace(trace=(), headline=""), attempt=None
    )
    payload = types.ModuleType("cogworks_runner.week2_payload")
    payload.decode_cases = lambda blob: ("facial-recognition", [object()])
    facenet = types.ModuleType("facenet_models")
    facenet.FacenetModel = lambda device=None: object()

    with TemporaryDirectory() as folder:
        staged = Path(folder)
        (staged / "project-root.txt").write_text(str(staged), encoding="utf-8")
        (staged / "adapter-source.txt").write_text("discovery", encoding="utf-8")
        with zipfile.ZipFile(staged / "cog-v2-payload.zip", "w") as archive:
            archive.writestr("cases.json", "[]")
        # The script's paths are literals; point them at this directory so a
        # stale file in the real /tmp cannot select another branch.
        source = script.replace('"/tmp/', '"{}/'.format(staged))

        cwd = os.getcwd()
        argv = sys.argv[:]
        path = sys.path[:]
        sys.argv = ["cog-evaluate.py", "facial-recognition", "8192"]
        try:
            with _installed("cogbench.plugins", plugins), _installed(
                "cogbench.resolve", resolve
            ), _installed("cogworks_runner.week2_payload", payload), _installed(
                "facenet_models", facenet
            ):
                exec(compile(source, "cog-evaluate.py", "exec"), {"__name__": "__main__"})
        finally:
            os.chdir(cwd)
            sys.argv = argv
            sys.path[:] = path


class TheStagedMappingCoversEveryLookupShape(unittest.TestCase):
    def setUp(self):
        from cogbench.discover import _Redirects

        self.scope = lambda: _Redirects({COURSE_FILE: Path(STAGED)})

    def test_a_module_attribute_lookup_reaches_the_staged_file(self):
        """`language.get_data_path(...)`, resolved when it is called."""

        with StubCourseLoader() as module:
            self.assertEqual(module.get_data_path(COURSE_FILE), DOWNLOADED)
            scope = self.scope()
            scope.enter()
            try:
                observed = sys.modules["cogworks_data.language"].get_data_path(COURSE_FILE)
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
                sys.modules["cogworks_data"] = package
                sys.modules["cogworks_data.language"] = module
                __import__("cogworks_data.language")
                from cogworks_data.language import get_data_path

                observed = get_data_path(COURSE_FILE)
            finally:
                scope.leave()
        self.assertEqual(observed, STAGED)

    def test_leaving_the_scope_restores_the_real_loader(self):
        with StubCourseLoader() as module:
            scope = self.scope()
            scope.enter()
            scope.leave()
            self.assertEqual(module.get_data_path(COURSE_FILE), DOWNLOADED)


class AGeneratorRunsInsideTheScope(unittest.TestCase):
    """The lifetime question the AST cannot answer.

    A submission may return a generator, which runs its body when something
    iterates it. While `list(...)` sat after the `with`, that body executed
    against the restored loader: the redirect was open for the call that built
    the generator and shut for the code that produced the results.
    """

    def test_iterating_the_results_still_sees_the_staged_file(self):
        seen: list = []
        with StubCourseLoader():
            run_evaluate_script(evaluate_script(), seen)
        self.assertEqual(seen, [STAGED])

    def test_materializing_after_the_scope_would_have_downloaded(self):
        """The counterfactual, against the real source with one edit.

        Without it, the test above passes for any script that happens to keep
        the scope open, and says nothing about where `list(...)` sits.
        """

        script = evaluate_script()
        moved = script.replace(
            "                predictions = list(benchmark.run(factory, model, cases))",
            "                predictions = benchmark.run(factory, model, cases)\n"
            "        predictions = list(predictions)",
            1,
        )
        self.assertNotEqual(moved, script, "the week 2 branch no longer reads as expected")

        seen: list = []
        with StubCourseLoader():
            run_evaluate_script(moved, seen)
        self.assertEqual(seen, [DOWNLOADED])


class EveryBranchHasTheSameShape(unittest.TestCase):
    def test_no_branch_materializes_results_outside_the_scope(self):
        """Week 2 is the branch driven above; the other three are read.

        Weeks 1 and 3 assert CPython 3.8.20 before they reach the submission,
        so they cannot run here. What is checked is that none of the four binds
        `predictions` to an unconsumed call and lists it later.
        """

        tree = ast.parse(evaluate_script())
        listed_outside = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            if getattr(node.targets[0], "id", "") != "predictions":
                continue
            call = node.value
            wrapped = isinstance(call, ast.Call) and getattr(call.func, "id", "") == "list"
            if not wrapped:
                listed_outside.append(node.lineno)
        self.assertEqual(
            listed_outside,
            [],
            "predictions is bound to an unconsumed result at line(s) {}".format(listed_outside),
        )

    def test_every_result_is_materialized_inside_both_scopes(self):
        tree = ast.parse(evaluate_script())
        parents = {
            child: parent for parent in ast.walk(tree)
            for child in ast.iter_child_nodes(parent)
        }
        assignments = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and getattr(node.targets[0], "id", "") == "predictions"
        ]
        self.assertEqual(len(assignments), 4)
        for assignment in assignments:
            scopes = set()
            node = assignment
            while node in parents:
                node = parents[node]
                if isinstance(node, ast.With):
                    for item in node.items:
                        expression = item.context_expr
                        if isinstance(expression, ast.Name):
                            scopes.add(expression.id)
                        elif isinstance(expression, ast.Call):
                            scopes.add(getattr(expression.func, "attr", ""))
            self.assertTrue(
                {"course_files", "redirect_stdout", "redirect_stderr"} <= scopes,
                "result at line {} escapes a scope: {}".format(assignment.lineno, scopes),
            )

    def test_every_load_student_call_takes_both_halves(self):
        """Every branch has to unpack the factory and the scope."""

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
