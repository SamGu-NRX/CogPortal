from __future__ import annotations

import linecache
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.pipeline import _reaches_outside, callables_in, instances_in  # noqa: E402


class ScreeningTests(unittest.TestCase):
    def module(self, source):
        name = "screening_fixture"
        filename = "<screening-fixture>"
        module = types.ModuleType(name)
        previous = sys.modules.get(name)
        sys.modules[name] = module
        self.addCleanup(
            lambda: sys.modules.pop(name, None) if previous is None
            else sys.modules.__setitem__(name, previous)
        )
        linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
        self.addCleanup(linecache.cache.pop, filename, None)
        exec(compile(source, filename, "exec"), module.__dict__)
        return module

    def test_comments_and_docstrings_do_not_exclude_working_functions(self):
        for note in ('# pydub and os.remove are not used here',
                     '"""pydub and os.remove are not used here"""'):
            with self.subTest(note=note):
                module = self.module('def transform(value):\n    ' + note + '\n    return value\n')
                self.assertFalse(_reaches_outside(module.transform))
                self.assertEqual([candidate.label for candidate in callables_in([module])],
                                 ['screening_fixture.transform'])

    def test_real_import_and_dynamic_import_are_still_screened(self):
        for operation in ('import pydub', '__import__("pydub")'):
            with self.subTest(operation=operation):
                module = self.module('def transform(value):\n    ' + operation + '\n    return value\n')
                self.assertTrue(_reaches_outside(module.transform))
                self.assertEqual(callables_in([module]), [])

    def test_unavailable_source_retains_live_dynamic_import_constants(self):
        for expression in ('__import__("pydub")', 'importlib.import_module("sounddevice")'):
            with self.subTest(expression=expression):
                module = self.module(
                    'def transform(value):\n    return ' + expression + '\n'
                    'class Store:\n    def __init__(self):\n        self.backend = ' + expression + '\n'
                )
                linecache.cache.pop("<screening-fixture>", None)
                self.assertTrue(_reaches_outside(module.transform))
                self.assertTrue(_reaches_outside(module.Store.__init__))

    def test_unavailable_source_distinguishes_nested_docstrings_and_imports(self):
        for body, screened in (
            ('return __import__("pydub")', True),
            ('"""pydub is not used."""\n        return value', False),
        ):
            with self.subTest(body=body):
                module = self.module(
                    'def transform(value):\n    def helper():\n        ' + body + '\n'
                    '    return helper()\n'
                )
                linecache.cache.pop("<screening-fixture>", None)
                self.assertEqual(_reaches_outside(module.transform), screened)

    def test_qualified_input_calls_are_screened(self):
        module = self.module(
            'def transform(value):\n    import builtins\n'
            '    return builtins.input(value)\n'
            'class Store:\n    def __init__(self):\n'
            '        import builtins\n        builtins.input("never-called")\n'
        )
        self.assertTrue(_reaches_outside(module.transform))
        self.assertEqual(callables_in([module]), [])
        self.assertEqual(instances_in([module]), [])

    def test_fstring_expressions_still_screen_listed_operations(self):
        for expression in ('os.remove(path)', 'shutil.rmtree(path)',
                           'os.system(command)', 'input()'):
            with self.subTest(expression=expression):
                module = self.module(
                    'def transform(path, command):\n'
                    '    return f"result: {' + expression + '}"\n'
                )
                self.assertTrue(_reaches_outside(module.transform))
                self.assertEqual(callables_in([module]), [])

    def test_nested_dynamic_imports_keep_their_live_string_constants(self):
        sources = (
            'def transform(value):\n    def helper():\n        return __import__("pydub")\n    return helper()\n',
            'def transform(value):\n    return [__import__("pydub") for _ in value]\n',
        )
        for source in sources:
            with self.subTest(source=source):
                module = self.module(source)
                self.assertTrue(_reaches_outside(module.transform))
                self.assertEqual(callables_in([module]), [])

    def test_nested_documentation_does_not_exclude_a_working_function(self):
        module = self.module(
            'def transform(value):\n    def helper():\n'
            '        """pydub is not used."""\n        return value\n'
            '    return helper()\n'
        )
        self.assertFalse(_reaches_outside(module.transform))

    def test_no_argument_constructor_is_screened_before_instantiation(self):
        module = self.module(
            'events = []\nclass Store:\n'
            '    def __init__(self):\n'
            '        events.append("constructed")\n'
            '        if False:\n            os.remove("never-executed")\n'
        )
        self.assertEqual(instances_in([module]), [])
        self.assertEqual(module.events, [])

    def test_harmless_constructor_documentation_is_allowed(self):
        module = self.module(
            'class Store:\n    def __init__(self):\n'
            '        """Uses neither pydub nor subprocess."""\n'
            '        self.table = {}\n'
        )
        instances = instances_in([module])
        self.assertEqual(len(instances), 1)
        self.assertEqual(instances[0][1].table, {})


if __name__ == "__main__":
    unittest.main()
