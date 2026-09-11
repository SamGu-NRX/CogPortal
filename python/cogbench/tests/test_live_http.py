"""CLI live delivery over loopback HTTP, with real isolated student processes."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from cogbench.cli import _LiveRun
from cogbench.client import send_local_run_event, send_local_run_event_batch

SOURCE = Path(__file__).resolve().parents[1] / 'src'
CHECKOUT = Path(__file__).resolve().parents[3]
TOKEN = 'loopback-fixture-token'

# Select the same real backends as test_fresh_interpreter, inside a process
# which has never hosted the receiver thread. Authentication stays on disk so
# exec children need no inherited mocks.
CLI_SCRIPT = '''
import sys
from cogbench import cli, isolate
isolate._isolation_backend = lambda: getattr(isolate, sys.argv[1])
raise SystemExit(cli.main(sys.argv[2:]))
'''


class Receiver(HTTPServer):
    """Model ordering and terminal guards, not Worker auth, storage, or publishing."""

    def __init__(self, gate):
        super().__init__(('127.0.0.1', 0), Handler)
        self.gate = gate
        self.starts = []
        self.deliveries = []
        self.accepted = []
        self.errors = []
        self.sequence = -1
        self.status = 'running'
        self.phase = 'preparing'
        self.seen = {}
        self.terminal_retry = False
        self.session_id = 'localrun_loopback_fixture'

    @property
    def portal(self):
        return 'http://127.0.0.1:{}'.format(self.server_port)

    def accept(self, event):
        self.deliveries.append(event)
        previous = self.seen.get(event['eventId'])
        if previous is not None and previous != event:
            raise AssertionError('retry changed an event with the same eventId')
        self.seen[event['eventId']] = event
        if self.status != 'running' or event['sequence'] <= self.sequence:
            return True
        if event['type'] == 'progress':
            phases = ['preparing', 'contract_check', 'evaluating', 'scoring']
            if phases.index(event['phase']) < phases.index(self.phase):
                return True
            self.phase = event['phase']
            if self.phase == 'evaluating':
                # Prediction cannot finish until an actual HTTP progress
                # request arrives, so a final-only history replay cannot pass.
                self.gate.write_text('progress received')
        elif event['type'] == 'completed':
            for key in ('benchmarkId', 'benchmarkVersion', 'repositoryFullName', 'sha'):
                if event['report'][key] != self.starts[0][key]:
                    raise AssertionError('completed report changed ' + key)
            self.status = 'succeeded'
        elif event['type'] == 'failed':
            if 'report' in event or 'metrics' in event:
                raise AssertionError('failure carried a report or score')
            self.status = 'failed'
        else:
            raise AssertionError('unknown event type')
        self.sequence = event['sequence']
        self.accepted.append(event)
        return False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        try:
            if self.headers.get('Authorization') != 'Bearer ' + TOKEN:
                raise AssertionError('missing fixture authentication')
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            prefix = '/api/v1/local-runs'
            events_path = prefix + '/' + self.server.session_id + '/events'
            if self.path == prefix:
                self.server.starts.append(body)
                self.reply(201, {'sessionId': self.server.session_id,
                                 'discord': 'channel_unbound'})
            elif self.path in (events_path, events_path + '/batch'):
                events = body['events'] if self.path.endswith('/batch') else [body]
                if self.path.endswith('/batch'):
                    if not isinstance(events, list) or not 1 <= len(events) <= 32:
                        raise AssertionError('batch must contain 1..32 events')
                    if any(left['sequence'] >= right['sequence']
                           for left, right in zip(events, events[1:])):
                        raise AssertionError('batch sequences must strictly increase')
                    if any(event['type'] != 'progress' for event in events[:-1]):
                        raise AssertionError('terminal event must be last in batch')
                duplicates = [self.server.accept(event) for event in events]
                # Simulate a lost terminal acknowledgement after acceptance.
                # The actual urllib client retries the single-event request.
                if (self.path == events_path and body['type'] != 'progress'
                        and not self.server.terminal_retry):
                    self.server.terminal_retry = True
                    self.reply(503, {'error': {'message': 'fixture acknowledgement lost'}})
                else:
                    self.reply(200, {'ok': True, 'duplicate': all(duplicates)})
            else:
                raise AssertionError('unexpected endpoint ' + self.path)
        except Exception as error:
            self.server.errors.append(repr(error))
            self.reply(400, {'error': {'message': str(error)}})

    def reply(self, status, body):
        encoded = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class StalledProgressHandler(Handler):
    def reply(self, status, body):
        if self.path.endswith('/events') and not self.server.progress_blocked.is_set():
            self.server.progress_blocked.set()
            if not self.server.release_progress.wait(20):
                self.server.errors.append('test did not release stalled progress response')
        elif self.path.endswith('/events/batch') and status == 200:
            self.server.batch_received.set()
        super().reply(status, body)


class StalledProgressReceiver(ThreadingMixIn, Receiver):
    def __init__(self, gate):
        super().__init__(gate)
        self.RequestHandlerClass = StalledProgressHandler
        self.progress_blocked = threading.Event()
        self.release_progress = threading.Event()
        self.batch_received = threading.Event()


class LiveHTTPStalledProgress(unittest.TestCase):
    def test_terminal_batch_arrives_before_stalled_progress_response_is_released(self):
        # No execution child is needed for this transport regression. The four
        # CLI fixtures below separately exercise both process backends.
        with tempfile.TemporaryDirectory(prefix='cogbench-live-stalled-') as temporary:
            receiver = StalledProgressReceiver(Path(temporary) / 'progress-received')
            thread = threading.Thread(target=receiver.serve_forever, daemon=True)
            live = _LiveRun(receiver.portal, TOKEN, receiver.session_id)
            thread.start()
            try:
                live.progress('preparing')
                self.assertTrue(receiver.progress_blocked.wait(5),
                                'sender did not reach the loopback receiver')
                live.failed(RuntimeError('fixture failed while progress response stalled'))
                self.assertFalse(receiver.release_progress.is_set())
                self.assertTrue(receiver.batch_received.is_set(),
                                'finish returned without a terminal batch while progress was blocked')
                self.assertEqual(receiver.status, 'failed')
                terminals = [event for event in receiver.accepted if event['type'] != 'progress']
                self.assertEqual(len(terminals), 1)
                self.assertEqual(terminals[0]['type'], 'failed')
                self.assertNotIn('report', terminals[0])
                self.assertEqual(receiver.accepted[-1], terminals[0])
                self.assertFalse(receiver.errors, receiver.errors)
            finally:
                receiver.release_progress.set()
                live._sender.join(timeout=10)
                live._heartbeat.join(timeout=5)
                receiver.shutdown()
                thread.join(timeout=5)
                receiver.server_close()
            self.assertFalse(live._sender.is_alive(), 'live sender survived cleanup')
            self.assertFalse(live._heartbeat.is_alive(), 'live heartbeat survived cleanup')
            self.assertFalse(thread.is_alive(), 'receiver survived cleanup')
            self.assertFalse(receiver.errors, receiver.errors)


@unittest.skipUnless(hasattr(os, 'fork'), 'requires POSIX isolation backends')
class LiveHTTP(unittest.TestCase):
    def exercise(self, backend, action, expected_status):
        with tempfile.TemporaryDirectory(prefix='cogbench-live-http-') as temporary:
            root = Path(temporary).resolve()
            repo = root / 'repo'
            # Borrow existing Git objects without creating a commit or changing
            # this checkout. Only the disposable repository's config is edited.
            subprocess.run(['git', 'clone', '--quiet', '--shared', '--no-checkout',
                            str(CHECKOUT), str(repo)], check=True, capture_output=True)
            subprocess.run(['git', '-C', str(repo), 'remote', 'set-url', 'origin',
                            'https://github.com/students/live-http-fixture.git'],
                           check=True, capture_output=True)
            sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'],
                                          text=True).strip()
            branch = subprocess.check_output(
                ['git', '-C', str(repo), 'symbolic-ref', '--short', 'HEAD'], text=True).strip()
            gate = root / 'progress-received'
            observed = root / 'student.json'
            scored = root / 'scored'
            (repo / 'submission.py').write_text('''
import json, os, signal, time
from pathlib import Path

def create_submission(inputs):
    Path(%r).write_text(json.dumps({'pid': os.getpid(), 'cwd': str(Path.cwd())}))
    deadline = time.monotonic() + 8
    while not Path(%r).exists():
        if time.monotonic() >= deadline:
            raise RuntimeError('live progress was not delivered before prediction')
        time.sleep(.01)
    %s
    return inputs
''' % (str(observed), str(gate), action))
            metadata = root / 'live_http_fixture-1.0.dist-info'
            metadata.mkdir()
            (metadata / 'METADATA').write_text('Name: live-http-fixture\nVersion: 1.0\n')
            (metadata / 'entry_points.txt').write_text(
                '[cogworks.benchmarks.v1]\nlive-http-fixture = live_http_fixture:Benchmark\n')
            (root / 'live_http_fixture.py').write_text('''
from pathlib import Path
from cogbench.models import Metric
class Benchmark:
    benchmark_id = 'live-http-fixture'
    benchmark_version = 1
    contract_version = 'cogworks.submissions.v1'
    plugin_version = '1.0'
    def public_cases(self):
        return [{'input': 7, 'expected': 7}, {'input': 11, 'expected': 11}]
    def score(self, predictions, expected):
        assert predictions == expected == [7, 11]
        Path(%r).write_text('scored')
        return [Metric('match', 'Match', 1.0, None, True, True, 3)], ['fixture scored']
''' % str(scored))
            receiver = Receiver(gate)
            thread = threading.Thread(target=receiver.serve_forever, daemon=True)
            thread.start()
            try:
                config = root / 'config.json'
                config.write_text(json.dumps({'portals': {receiver.portal: {
                    'token': TOKEN, 'expiresAt': int(time.time() * 1000) + 60000}}}))
                environment = dict(os.environ, COGBENCH_CONFIG=str(config),
                                   PYTHONHASHSEED='0', PYTHONDONTWRITEBYTECODE='1',
                                   PYTHONPATH=os.pathsep.join((str(SOURCE), str(root))),
                                   NO_PROXY='127.0.0.1', no_proxy='127.0.0.1')
                process = subprocess.Popen(
                    [sys.executable, '-c', CLI_SCRIPT, backend, 'run', '--benchmark',
                     'live-http-fixture', '--live', '--json', '--portal', receiver.portal],
                    cwd=str(repo), env=environment, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, universal_newlines=True)
                try:
                    stdout, stderr = process.communicate(timeout=30)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate()
                detail = '{}\n{}\naccepted={!r}'.format(stdout, stderr, receiver.accepted)
                self.assertFalse(receiver.errors, receiver.errors)
                self.assertEqual(len(receiver.starts), 1, detail)
                start = receiver.starts[0]
                self.assertEqual(start['repositoryFullName'], 'students/live-http-fixture')
                self.assertEqual(start['sha'], sha)
                self.assertEqual(start['branch'], branch)
                self.assertTrue(start['dirty'])
                self.assertEqual(start['benchmarkId'], 'live-http-fixture')
                self.assertEqual(start['benchmarkVersion'], 1)
                self.assertTrue(start['clientRunId'])
                self.assertTrue(gate.exists(), detail)
                student = json.loads(observed.read_text())
                self.assertNotEqual(student['pid'], process.pid)
                self.assertNotEqual(Path(student['cwd']), repo)
                self.assertFalse(Path(student['cwd']).exists(), 'execution copy survived')
                terminals = [e for e in receiver.accepted if e['type'] != 'progress']
                self.assertEqual(len(terminals), 1, detail)
                self.assertEqual(receiver.status, expected_status, detail)
                self.assertEqual(receiver.accepted[-1], terminals[0])
                self.assertTrue(any(e['type'] == 'progress' for e in receiver.accepted[:-1]))
                unique = list(receiver.seen.values())
                sequences = [e['sequence'] for e in unique]
                self.assertEqual(sequences, sorted(set(sequences)), detail)
                terminal = terminals[0]
                result = json.loads(stdout)
                reports = list((repo / '.cogbench' / 'reports').glob('*.json'))
                if expected_status == 'succeeded':
                    self.assertEqual(process.returncode, 0, detail)
                    self.assertEqual(terminal['type'], 'completed')
                    self.assertTrue(scored.exists())
                    self.assertEqual(len(reports), 1)
                    self.assertEqual(json.loads(reports[0].read_text()), result)
                    self.assertEqual(terminal['report'],
                                     {k: v for k, v in result.items() if k != 'outputDigest'})
                    self.assertEqual(result['diagnostics'], ['fixture scored'])
                    self.assertEqual(result['metrics'][0]['value'], 1.0)
                else:
                    self.assertEqual(process.returncode, 2, detail)
                    self.assertEqual(terminal['type'], 'failed')
                    self.assertFalse(scored.exists(), 'failed prediction reached scoring')
                    self.assertEqual(reports, [])
                    for key in ('report', 'reportId', 'metrics', 'outputDigest'):
                        self.assertNotIn(key, result)
                    self.assertIn(result['status'], ('raised', 'crashed'))
                # Replay the very same IDs out of order over the real network.
                # Then try a higher-sequence progress event: sequence alone must
                # never reopen a terminal session.
                accepted = list(receiver.accepted)
                send_local_run_event_batch(receiver.portal, TOKEN, receiver.session_id, unique)
                for event in reversed(unique):
                    send_local_run_event(receiver.portal, TOKEN, receiver.session_id, event)
                send_local_run_event(receiver.portal, TOKEN, receiver.session_id, terminal)
                late = dict(next(e for e in unique if e['type'] == 'progress'),
                            eventId='localevent_late_fixture', sequence=receiver.sequence + 1)
                send_local_run_event(receiver.portal, TOKEN, receiver.session_id, late)
                self.assertEqual(receiver.accepted, accepted)
                self.assertEqual(receiver.status, expected_status)
                self.assertFalse(receiver.errors, receiver.errors)
            finally:
                receiver.shutdown()
                thread.join(timeout=5)
                receiver.server_close()

    def test_success(self):
        for backend in ('run_isolated', 'run_operation'):
            with self.subTest(backend=backend):
                self.exercise(backend, 'pass', 'succeeded')

    def test_ordinary_exception(self):
        for backend in ('run_isolated', 'run_operation'):
            with self.subTest(backend=backend):
                self.exercise(backend, "raise RuntimeError('fixture prediction failed')", 'failed')

    def test_abrupt_exit(self):
        for backend in ('run_isolated', 'run_operation'):
            with self.subTest(backend=backend):
                self.exercise(backend, 'os._exit(23)', 'failed')

    @unittest.skipUnless(hasattr(signal, 'SIGKILL'), 'requires fatal POSIX signal')
    def test_fatal_signal(self):
        for backend in ('run_isolated', 'run_operation'):
            with self.subTest(backend=backend):
                self.exercise(backend, 'os.kill(os.getpid(), signal.SIGKILL)', 'failed')
