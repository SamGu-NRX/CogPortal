"""Real on-disk plugins cross the exec boundary without inherited test mocks."""
import io
import json
import os
try:
    import resource
except ImportError:
    resource = None
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout, nullcontext
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from cogbench import cli, isolate
from cogbench.discover import survey

PROBE = Path(__file__).parent / 'fixtures' / 'proxy_probe.py'


def wait_gone(test, pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        # Linux can leave a killed grandchild as a zombie until its new
        # parent reaps it. It is no longer executing; we do not own that wait.
        stat = Path('/proc') / str(pid) / 'stat'
        try:
            if stat.read_text().rsplit(')', 1)[1].split()[0] == 'Z':
                return
        except (OSError, IndexError):
            pass
        time.sleep(.01)
    test.fail('process {} survived cleanup'.format(pid))


class OperationFixtures:
    backend_name = 'run_operation'

    def setUp(self):
        selection = patch.object(isolate, '_isolation_backend',
                                 side_effect=lambda: getattr(isolate, self.backend_name))
        selection.start()
        self.addCleanup(selection.stop)
        temporary = tempfile.TemporaryDirectory(prefix='cogbench-exec-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.record = self.root / 'observed.json'
        metadata = self.root / 'boundary_fixture-1.0.dist-info'
        metadata.mkdir()
        (metadata / 'METADATA').write_text('Name: boundary-fixture\nVersion: 1.0\n')
        (metadata / 'entry_points.txt').write_text(
            '[cogworks.benchmarks.v1]\nboundary-fixture = boundary_fixture:Benchmark\n')
        (self.root / 'boundary_fixture.py').write_text('''
class Benchmark:
    benchmark_id = 'boundary-fixture'
    benchmark_version = 1
    contract_version = 'cogworks.submissions.v1'
    plugin_version = '1.0'
    def public_cases(self):
        return [{'input': 1, 'expected': 1}]
    def score(self, predictions, expected):
        return [], ['fixture scored']
''')
        sys.path.insert(0, str(self.root))
        self.addCleanup(sys.path.remove, str(self.root))

    def submission(self, extra='', probe=False):
        source = '''
import contextlib, io, json, os, resource, runpy, subprocess, sys
from pathlib import Path
'''
        if probe:
            source += '''
old_argv = sys.argv
sys.argv = ['probe', 'direct']
with contextlib.redirect_stdout(io.StringIO()) as captured:
    runpy.run_path(%r)
sys.argv = old_argv
assert 'proxy lookup returned' in captured.getvalue()
''' % str(PROBE)
        source += '''
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
Path(%r).write_text(json.dumps({
    'pid': os.getpid(), 'descendant': child.pid, 'cwd': os.getcwd(),
    'cpu': resource.getrlimit(resource.RLIMIT_CPU),
    'memory': resource.getrlimit(resource.RLIMIT_AS),
    'core': resource.getrlimit(resource.RLIMIT_CORE),
    'seed': sys.flags.hash_randomization, 'stdin': sys.stdin.read(),
}))
%s
def create_submission(inputs):
    return inputs
''' % (str(self.record), extra)
        (self.repo / 'submission.py').write_text(source)

    def reject_raw_fork(self):
        if self.backend_name == 'run_operation':
            return patch.object(os, 'fork', side_effect=AssertionError('raw fork'))
        return nullcontext()

    def test_cold_proxy_check_installs_limits_and_cleans_descendants(self):
        import importlib.util
        if importlib.util.find_spec('numpy') is None:
            self.skipTest('the frozen proxy probe imports numpy')
        self.submission(probe=True)
        # A macOS CLI operation must not call our Python fork API at all.
        with self.reject_raw_fork():
            view, status, detail = cli._read_repository('boundary-fixture', self.repo, True)
        self.assertEqual(status, isolate.COMPLETED, detail)
        self.assertTrue(view['ready'])
        observed = json.loads(self.record.read_text())
        self.assertNotEqual(observed['pid'], os.getpid())
        self.assertEqual(observed['cwd'], str(self.repo))
        self.assertEqual(observed['cpu'], [300, 305])
        self.assertEqual(observed['core'], [0, 0])
        # macOS may reject RLIMIT_AS; never claim installation if it did.
        self.assertIn(observed['memory'][0], [resource.RLIM_INFINITY, isolate.DEFAULT_MEMORY_BYTES])
        self.assertEqual(observed['seed'], 0)
        self.assertEqual(observed['stdin'], '')
        wait_gone(self, observed['pid'])
        wait_gone(self, observed['descendant'])

    def test_stricter_inherited_cpu_limits_are_not_raised(self):
        self.submission()
        environment = dict(os.environ, PYTHONPATH=os.pathsep.join(sys.path))
        source = """import resource
from pathlib import Path
from cogbench.isolate import run_operation
resource.setrlimit(resource.RLIMIT_CPU, (10, 20))
result = run_operation('check', {
    'name': 'boundary-fixture', 'repository': %r, 'as_json': True,
})
assert result.ok, result
""" % str(self.repo)
        result = subprocess.run([sys.executable, '-c', source], env=environment,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(self.record.read_text())
        self.assertEqual(observed['cpu'], [10, 20])
        wait_gone(self, observed['descendant'])

    def test_student_sitecustomize_cannot_run_during_interpreter_startup(self):
        self.submission()
        nested = self.repo / 'nested'
        nested.mkdir()
        alias = self.root / 'repo-alias'
        alias.symlink_to(self.repo, target_is_directory=True)
        marker = self.root / 'startup.json'
        hook = """
import json, resource
from pathlib import Path
Path(%r).write_text(json.dumps(list(resource.getrlimit(resource.RLIMIT_CPU))))
""" % str(marker)
        (self.repo / 'sitecustomize.py').write_text(hook)
        (nested / 'sitecustomize.py').write_text(hook)
        # Explicitly import the same hook from student code. This must work,
        # but only after _child has installed the CPU limit.
        submission = self.repo / 'submission.py'
        submission.write_text('import sitecustomize\n' + submission.read_text())
        for entry in (self.repo, nested, alias):
            with self.subTest(entry=str(entry)), patch.object(sys, 'path', [str(entry)] + sys.path):
                view, status, detail = cli._read_repository('boundary-fixture', self.repo, True)
            self.assertEqual(status, isolate.COMPLETED, detail)
            self.assertTrue(view['ready'])
            self.assertEqual(json.loads(marker.read_text()), [300, 305])
            observed = json.loads(self.record.read_text())
            wait_gone(self, observed['descendant'])

    def test_bootstrap_does_not_import_repository_code_before_limits(self):
        self.submission()
        (self.repo / 'json.py').write_text("raise AssertionError('repository json imported during bootstrap')")
        view, status, detail = cli._read_repository('boundary-fixture', self.repo, True)
        self.assertEqual(status, isolate.COMPLETED, detail)
        self.assertTrue(view['ready'])
        observed = json.loads(self.record.read_text())
        wait_gone(self, observed['descendant'])

    def test_test_and_run_reconstruct_and_score_in_fresh_interpreter(self):
        self.submission()
        for command in ('test', 'run'):
            with self.subTest(command=command), patch.object(cli.Path, 'cwd', return_value=self.repo), \
                 self.reject_raw_fork(), \
                 redirect_stdout(io.StringIO()) as output:
                code = cli.main([command, '--benchmark', 'boundary-fixture', '--json'])
            self.assertEqual(code, 0, output.getvalue())
            self.assertEqual(json.loads(output.getvalue())['benchmarkId'], 'boundary-fixture')
            observed = json.loads(self.record.read_text())
            self.assertEqual(observed['cpu'], [resource.RLIM_INFINITY, resource.RLIM_INFINITY], 'scored runs retain their unbounded CPU budget')
            wait_gone(self, observed['descendant'])

    def test_score_time_attribute_lookup_uses_validated_course_file(self):
        owned = self.root / 'validated.pkl'
        owned.write_bytes(b'validated course input')
        package = self.root / 'cogworks_data'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'language.py').write_text("""
def get_data_path(name):
    raise AssertionError('original course loader reached at score time')
""")
        benchmark_file = self.root / 'boundary_fixture.py'
        benchmark_file.write_text(benchmark_file.read_text() + """
    def discovery(self):
        from pathlib import Path
        from types import SimpleNamespace
        return SimpleNamespace(resource_files={'resnet18_features.pkl': Path(%r)})
""" % str(owned))
        (self.repo / 'submission.py').write_text("""
from pathlib import Path
import cogworks_data.language as language

def create_submission(inputs):
    # Attribute lookup occurs during execute(), after resolution has returned.
    path = language.get_data_path('resnet18_features.pkl')
    assert Path(path).read_bytes() == b'validated course input'
    return inputs
""")
        with patch.object(cli.Path, 'cwd', return_value=self.repo), redirect_stdout(io.StringIO()) as output:
            code = cli.main(['test', '--benchmark', 'boundary-fixture', '--json'])
        self.assertEqual(code, 0, output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['diagnostics'], ['fixture scored'])

    def test_discovered_check_report_crosses_json_and_rehydrates_for_rendering(self):
        from test_resolve import REPO
        from cogbench.resolve import SubmissionReport
        (self.repo / 'theirs.py').write_text(REPO)
        benchmark_file = self.root / 'boundary_fixture.py'
        benchmark_file.write_text(benchmark_file.read_text() + """
    def discovery(self):
        from cogbench.discovery_spec import DiscoverySpec
        from test_resolve import ROLE, FIXTURE, _accepts, _arrangements
        return DiscoverySpec(ROLE, FIXTURE, _accepts, _arrangements)
    def submission_from_discovery(self, submission):
        return submission
""")
        view, status, detail = cli._read_repository('boundary-fixture', self.repo, True)
        self.assertEqual(status, isolate.COMPLETED, detail)
        self.assertTrue(view['ready'])
        self.assertIsInstance(view['report'], SubmissionReport)
        self.assertEqual(view['report'].attempt.query, 'theirs.whose')
        self.assertIsInstance(view['survey'], dict)

    def test_survey_executes_import_and_keeps_journal_after_death(self):
        (self.repo / 'a_good.py').write_text('def identity(x):\n    return x\n')
        (self.repo / 'z_bad.py').write_text('import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n')
        with self.reject_raw_fork():
            result = survey(self.repo)
        self.assertEqual(result.status, isolate.CRASHED)
        self.assertIn('unknown', result.detail)
        self.assertTrue(result.record['unread'])
        self.assertEqual(result.record['modules'][0]['name'], 'a_good')

    def test_wall_deadline_reaps_worker_and_descendant(self):
        self.submission('import time\ntime.sleep(120)')
        result = isolate.run_operation('check', {
            'name': 'boundary-fixture', 'repository': str(self.repo), 'as_json': True,
        }, scratch=self.repo, timeout_seconds=2)
        self.assertTrue(result.alarm_fired)
        self.assertEqual(result.timeout_seconds, 2)
        self.assertEqual(result.memory_bytes, isolate.DEFAULT_MEMORY_BYTES)
        observed = json.loads(self.record.read_text())
        self.assertEqual(observed['cpu'], [2, 7])
        wait_gone(self, observed['pid'])
        wait_gone(self, observed['descendant'])

    def test_interrupt_cleans_worker_and_descendant(self):
        self.submission('import time\ntime.sleep(120)')
        environment = dict(os.environ, PYTHONPATH=os.pathsep.join(sys.path))
        source = '''from pathlib import Path
from cogbench.isolate import run_operation
run_operation('check', {'name': 'boundary-fixture', 'repository': %r, 'as_json': True})
''' % str(self.repo)
        parent = subprocess.Popen([sys.executable, '-c', source], env=environment,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 15
            while not self.record.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(self.record.exists(), 'worker did not start')
            observed = json.loads(self.record.read_text())
            parent.send_signal(signal.SIGINT)
            parent.communicate(timeout=10)
            self.assertNotEqual(parent.returncode, 0)
            wait_gone(self, observed['pid'])
            wait_gone(self, observed['descendant'])
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.communicate()


@unittest.skipUnless(hasattr(os, 'fork'), 'POSIX execution boundary')
class FreshInterpreter(OperationFixtures, unittest.TestCase):
    """Exec integration runs on Linux CI as well as macOS."""


@unittest.skipUnless(hasattr(os, 'fork'), 'POSIX execution boundary')
class ForkOperations(unittest.TestCase):
    """The same on-disk operations exercise the fork backend on either OS.

    The cold proxy probe belongs only to exec: raw macOS fork is the failure
    that operation reconstruction was introduced to avoid.
    """
    backend_name = 'run_isolated'
    setUp = OperationFixtures.setUp
    submission = OperationFixtures.submission
    reject_raw_fork = OperationFixtures.reject_raw_fork
    test_scoring = OperationFixtures.test_test_and_run_reconstruct_and_score_in_fresh_interpreter
    test_check = OperationFixtures.test_discovered_check_report_crosses_json_and_rehydrates_for_rendering
    test_survey = OperationFixtures.test_survey_executes_import_and_keeps_journal_after_death
    test_course_file_at_score_time = OperationFixtures.test_score_time_attribute_lookup_uses_validated_course_file
