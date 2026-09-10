"""Observed death, result framing, and the check report's diagnostic handoff."""
import io
import json
import os
import signal
import struct
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from cogbench import cli, isolate


@unittest.skipUnless(hasattr(os, 'fork'), 'requires POSIX isolation')
class ProcessOutcomes(unittest.TestCase):
    def test_self_sigkill_is_unknown_not_a_timeout(self):
        for _ in range(10):
            result = isolate.run_isolated(lambda: os.kill(os.getpid(), signal.SIGKILL))
            self.assertEqual(result.status, isolate.CRASHED)
            self.assertEqual(result.signal, 9)
            self.assertFalse(result.alarm_fired)
            self.assertEqual(result.read_reason, 'eof')
            self.assertIn('unknown', result.detail)
            self.assertNotIn('memory', result.detail)

    def test_sleep_hits_wall_deadline_and_keeps_limits(self):
        result = isolate.run_isolated(lambda: time.sleep(30), timeout_seconds=1)
        self.assertEqual(result.status, isolate.TIMED_OUT)
        self.assertTrue(result.alarm_fired)
        self.assertEqual(result.read_reason, 'alarm')
        self.assertEqual(result.timeout_seconds, 1)
        self.assertEqual(result.memory_bytes, isolate.DEFAULT_MEMORY_BYTES)

    def test_explicit_sigxcpu_names_cpu_limit(self):
        result = isolate.run_isolated(lambda: os.kill(os.getpid(), signal.SIGXCPU), timeout_seconds=10)
        self.assertEqual(result.status, isolate.TIMED_OUT)
        self.assertEqual(result.signal, signal.SIGXCPU)
        self.assertFalse(result.alarm_fired)
        self.assertIn('CPU', result.detail)
        self.assertIn('10 seconds soft, 15 seconds hard', result.detail)

    def test_framing_failures_keep_their_reason(self):
        cases = [(b'', 'eof'), (b'\0', 'truncated_header'),
                 (struct.pack('!I', 4) + b'x', 'truncated_body'),
                 (struct.pack('!I', 3) + b'bad', 'invalid_payload')]
        for data, reason in cases:
            with self.subTest(reason=reason):
                def broken(work, fd, *args):
                    os.setsid()
                    os.write(fd, data)
                    os.close(fd)
                    time.sleep(30)
                with patch.object(isolate, '_child', broken):
                    result = isolate.run_isolated(lambda: None, timeout_seconds=5)
                self.assertEqual(result.status, isolate.CRASHED)
                self.assertEqual(result.read_reason, reason)
                self.assertFalse(result.alarm_fired)
                self.assertIsNone(result.signal, 'cleanup SIGKILL is not an observed cause')
                self.assertIn(reason, result.detail)

    def test_alarm_during_unpickling_is_not_an_invalid_frame(self):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, struct.pack('!I', 1) + b'x')
        os.close(write_fd)
        try:
            with patch.object(isolate.pickle, 'loads', side_effect=isolate._Alarm):
                with self.assertRaises(isolate._Alarm):
                    isolate._read_payload(read_fd)
        finally:
            os.close(read_fd)

    def test_output_written_by_pickling_is_flushed_before_completion(self):
        import subprocess
        source = """
from cogbench.isolate import run_isolated
class Result:
    def __reduce__(self):
        print('printed during pickling', end='')
        return (str, ('result',))
result = run_isolated(Result)
assert result.value == 'result'
"""
        environment = dict(os.environ, PYTHONPATH=str(Path(isolate.__file__).parent.parent))
        result = subprocess.run([sys.executable, '-c', source], env=environment,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'printed during pickling')

    def test_cli_json_keeps_observed_death_fields(self):
        result = isolate.Outcome(isolate.CRASHED, detail='stopped by SIGKILL; the cause is unknown',
                                 signal=9, timeout_seconds=300, memory_bytes=1234, read_reason='eof')
        class Platform:
            platform = 'darwin'
        class Benchmark:
            def model_cache_status(self):
                return {}
            def cache_status(self, tier):
                from types import SimpleNamespace
                return SimpleNamespace(ready=True, path=Path('/tmp'), message='')
        with patch.object(cli, 'run_operation', return_value=result), \
             patch.object(cli, 'sys', Platform()), \
             patch.object(cli, 'plugin_names', return_value=['fixture']), \
             patch.object(cli, 'load_benchmark', return_value=Benchmark()), \
             patch('sys.stdout', new_callable=io.StringIO) as output:
            code = cli._check('fixture', True, Path('/tmp'))
        record = json.loads(output.getvalue())
        self.assertEqual(code, 2)
        # The existing check object owns submissionDetail; no parallel report.
        checks = record.get('checks', record)
        self.assertIn(result.detail, checks['submissionError'])
        self.assertEqual(checks['submissionDetail'], result.diagnostics())
