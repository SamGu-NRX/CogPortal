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
from contextlib import redirect_stdout
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
        time.sleep(.01)
    test.fail('process {} survived cleanup'.format(pid))


@unittest.skipUnless(sys.platform == 'darwin', 'macOS fresh-interpreter boundary')
class FreshInterpreter(unittest.TestCase):
    def setUp(self):
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

    def test_cold_proxy_check_installs_limits_and_cleans_descendants(self):
        self.submission(probe=True)
        # A macOS CLI operation must not call our Python fork API at all.
        with patch.object(os, 'fork', side_effect=AssertionError('raw fork')):
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

    def test_bootstrap_does_not_import_repository_code_before_limits(self):
        self.submission()
        (self.repo / 'json.py').write_text("raise AssertionError('repository json imported during bootstrap')")
        view, status, detail = cli._read_repository('boundary-fixture', self.repo, True)
        self.assertEqual(status, isolate.COMPLETED, detail)
        self.assertTrue(view['ready'])
        observed = json.loads(self.record.read_text())
        wait_gone(self, observed['descendant'])

    def test_test_and_run_reconstruct_and_score_in_fresh_interpreter(self):
        self.submission(probe=True)
        for command in ('test', 'run'):
            with self.subTest(command=command), patch.object(cli.Path, 'cwd', return_value=self.repo), \
                 patch.object(os, 'fork', side_effect=AssertionError('raw fork')), \
                 redirect_stdout(io.StringIO()) as output:
                code = cli.main([command, '--benchmark', 'boundary-fixture', '--json'])
            self.assertEqual(code, 0, output.getvalue())
            self.assertEqual(json.loads(output.getvalue())['benchmarkId'], 'boundary-fixture')
            observed = json.loads(self.record.read_text())
            self.assertEqual(observed['cpu'], [resource.RLIM_INFINITY, resource.RLIM_INFINITY], 'scored runs retain their unbounded CPU budget')
            wait_gone(self, observed['descendant'])

    def test_survey_executes_import_and_keeps_journal_after_death(self):
        (self.repo / 'a_good.py').write_text('def identity(x):\n    return x\n')
        (self.repo / 'z_bad.py').write_text('import os, signal\nos.kill(os.getpid(), signal.SIGKILL)\n')
        with patch.object(os, 'fork', side_effect=AssertionError('raw fork')):
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
