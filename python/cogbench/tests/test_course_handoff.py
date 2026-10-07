"""A course alias belongs to the repository whose validated inputs it received."""
import builtins
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from cogbench.discover import discover, _Redirects
from cogbench.resolve import resolve
from test_resolve import ROLE, FIXTURE, REPO, _accepts, _arrangements


class CourseHandoff(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.course = ModuleType('cogworks_data')
        self.language = ModuleType('cogworks_data.language')
        self.original = Mock(side_effect=AssertionError('Pooch/Requests must not be reached'))
        self.language.get_data_path = self.original
        self.course.language = self.language
        modules = patch.dict(sys.modules, {'cogworks_data': self.course,
                                          'cogworks_data.language': self.language})
        modules.start()
        self.addCleanup(modules.stop)

    def artifact(self, name, contents):
        path = self.root / name
        path.write_bytes(contents)
        # The benchmark owns validation; the redirect receives its exact path.
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), hashlib.sha256(contents).digest())
        return path

    def test_alias_imported_before_first_read_keeps_its_repository_mapping(self):
        importer = builtins.__import__
        callbacks = []
        for index in (1, 2):
            repo = self.root / ('repo%d' % index)
            repo.mkdir()
            owned = self.artifact('owned%d.pkl' % index, str(index).encode())
            (repo / 'train.py').write_text('''
from cogworks_data.language import get_data_path
def prep_data():
    return get_data_path('resnet18_features.pkl')
def missing():
    return get_data_path('unmapped.pkl')
''')
            found = discover(repo, resource_files={'resnet18_features.pkl': owned})
            self.assertEqual(len(found.modules), 1, found.skipped)
            module = found.modules[0].module
            callbacks.append((module.prep_data, owned))
            self.assertEqual(module.prep_data(), str(owned))
            with self.assertRaisesRegex(FileNotFoundError, 'unmapped.pkl.*no validated benchmark input.*Ask your instructor'):
                module.missing()
            self.assertIs(self.language.get_data_path, self.original)
            self.assertIs(builtins.__import__, importer)
        # Reading the first submission after the second must not use its file.
        for callback, owned in callbacks:
            self.assertEqual(callback(), str(owned))
        self.original.assert_not_called()

    def test_resolve_keeps_mapping_during_candidate_calls_and_deferred_imports(self):
        repo = self.root / 'repo'
        repo.mkdir()
        owned = self.artifact('validated.pkl', b'validated')
        source = REPO.replace('    return [(value * 2, rate)]', '''    from cogworks_data.language import get_data_path
    with open(get_data_path('resnet18_features.pkl'), 'rb') as stream:
        assert stream.read() == b'validated'
    return [(value * 2, rate)]''')
        (repo / 'theirs.py').write_text(source)
        submission = resolve(repo, chain_role=ROLE, fixture=FIXTURE, accepts=_accepts,
                             arrangements=_arrangements,
                             resource_files={'resnet18_features.pkl': owned})
        self.assertTrue(submission.ready, submission.verdict)
        self.original.assert_not_called()
        self.assertIs(self.language.get_data_path, self.original)

    def test_a_cold_course_import_is_patched_before_from_import_captures_alias(self):
        # Start with the real import machinery, not an already imported module.
        package = self.root / 'cogworks_data'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'language.py').write_text('''
def get_data_path(name):
    raise AssertionError('unpatched course loader')
''')
        owned = self.artifact('validated.pkl', b'validated')
        repo = self.root / 'repo'
        repo.mkdir()
        (repo / 'train.py').write_text('''
from cogworks_data.language import get_data_path
def prep_data():
    return get_data_path('resnet18_features.pkl')
''')
        sys.modules.pop('cogworks_data', None)
        sys.modules.pop('cogworks_data.language', None)
        sys.path.insert(0, str(self.root))
        self.addCleanup(sys.path.remove, str(self.root))
        found = discover(repo, resource_files={'resnet18_features.pkl': owned})
        self.assertEqual(found.modules[0].module.prep_data(), str(owned))

    def test_cleanup_restores_loader_and_imports_on_exception(self):
        importer = builtins.__import__
        owned = self.artifact('validated.pkl', b'validated')
        with self.assertRaisesRegex(RuntimeError, 'stop'):
            with _Redirects({'resnet18_features.pkl': owned}):
                self.assertEqual(self.language.get_data_path('resnet18_features.pkl'), str(owned))
                raise RuntimeError('stop')
        self.assertIs(builtins.__import__, importer)
        self.assertIs(self.language.get_data_path, self.original)
