"""Observed death, result framing, and the check report's diagnostic handoff."""
import io
import json
import os
import signal
import struct
import sys
import time
import tempfile
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
                 (struct.pack('!I', 3) + b'bad', 'invalid_outcome')]
        for data, reason in cases:
            with self.subTest(reason=reason):
                def broken(work, fd, *args):
                    os.setsid()
                    os.write(fd, data)
                    os.close(fd)
                    os._exit(0)
                with patch.object(isolate, '_child', broken):
                    result = isolate.run_isolated(lambda: None, timeout_seconds=5)
                self.assertEqual(result.status, isolate.CRASHED)
                self.assertEqual(result.read_reason, reason)
                self.assertFalse(result.alarm_fired)
                self.assertIsNone(result.signal, 'ordinary exit has no signal')
                self.assertIn(reason, result.detail)

    def test_alarm_during_json_decoding_is_not_an_invalid_frame(self):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, struct.pack('!I', 1) + b'x')
        os.close(write_fd)
        try:
            with patch.object(isolate.json, 'loads', side_effect=isolate._Alarm):
                with self.assertRaises(isolate._Alarm):
                    isolate._read_payload(read_fd)
        finally:
            os.close(read_fd)

    def test_pickle_reduction_is_never_called(self):
        class Result:
            def __reduce__(self):
                raise AssertionError('pickle reduction must not run')
        result = isolate.run_isolated(Result)
        self.assertEqual(result.status, isolate.RAISED)
        self.assertIn('TypeError', result.detail)
        self.assertNotIn('AssertionError', result.detail)

    def test_eof_before_waitable_exit_reaps_before_cleanup(self):
        calls = []
        def waitpid(pid, options):
            calls.append(('wait', options))
            # Force the Linux timing: a nonblocking wait sees no exit yet.
            return (0, 0) if options == os.WNOHANG else (pid, signal.SIGKILL)
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        with patch.object(isolate.os, 'waitpid', side_effect=waitpid), \
             patch.object(isolate, '_terminate', side_effect=lambda pid: calls.append(('kill', pid))):
            result = isolate._collect(123, read_fd, 10, 1234)
        self.assertEqual(calls, [('wait', 0), ('kill', 123)])
        self.assertEqual(result.status, isolate.CRASHED)
        self.assertEqual(result.signal, 9)
        self.assertFalse(result.alarm_fired)

    def test_real_child_exits_after_eof_without_losing_its_sigkill(self):
        def delayed_exit(work, fd, *args):
            os.setsid()
            os.close(fd)
            # Test-only teardown delay forces EOF before a waitable exit on
            # macOS too. There is no grace period in production code.
            time.sleep(.05)
            os.kill(os.getpid(), signal.SIGKILL)
        with patch.object(isolate, '_child', delayed_exit):
            result = isolate.run_isolated(lambda: None, timeout_seconds=5)
        self.assertEqual(result.status, isolate.CRASHED)
        self.assertEqual(result.signal, 9)
        self.assertEqual(result.read_reason, 'eof')
        self.assertFalse(result.alarm_fired)

    def test_external_sigkill_keeps_signal_and_unknown_cause(self):
        import threading
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / 'pid'
            def work():
                # Written through a temporary name and renamed. `write_text`
                # creates the file before it has the pid in it, so a reader
                # watching for existence can find it empty; on Linux that
                # happened, the killer raised ValueError, nothing was killed,
                # and the child ran to the deadline instead.
                staging = marker.with_suffix('.writing')
                staging.write_text(str(os.getpid()))
                os.replace(str(staging), str(marker))
                time.sleep(30)
            def kill_child():
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    try:
                        child = int(marker.read_text())
                    except (OSError, ValueError):
                        time.sleep(.01)
                        continue
                    os.kill(child, signal.SIGKILL)
                    return
                raise AssertionError('the child never published its pid')
            # Start the helper only once the child exists: no student work is
            # forked from a test process containing this helper thread.
            real_read = isolate._read_payload
            def read(fd):
                thread = threading.Thread(target=kill_child)
                thread.start()
                try:
                    return real_read(fd)
                finally:
                    thread.join()
            with patch.object(isolate, '_read_payload', side_effect=read):
                result = isolate.run_isolated(work, timeout_seconds=10)
        self.assertEqual(result.signal, 9)
        self.assertEqual(result.status, isolate.CRASHED)
        self.assertFalse(result.alarm_fired)
        self.assertIn('unknown', result.detail)

    def test_closed_pipe_does_not_disarm_the_existing_deadline(self):
        def close_and_hang(work, fd, *args):
            os.setsid()
            os.close(fd)
            time.sleep(30)
        with patch.object(isolate, '_child', close_and_hang):
            result = isolate.run_isolated(lambda: None, timeout_seconds=1)
        self.assertEqual(result.status, isolate.TIMED_OUT)
        self.assertTrue(result.alarm_fired)
        self.assertEqual(result.read_reason, 'eof')

    def test_cli_json_keeps_observed_death_fields(self):
        result = isolate.Outcome(isolate.CRASHED, detail='stopped by SIGKILL; the cause is unknown',
                                 signal=9, timeout_seconds=300, memory_bytes=1234, read_reason='eof')
        class Benchmark:
            def model_cache_status(self):
                return {}
            def cache_status(self, tier):
                from types import SimpleNamespace
                return SimpleNamespace(ready=True, path=Path('/tmp'), message='')
        with patch.object(isolate, 'run_operation', return_value=result), \
             patch.object(isolate, '_isolation_backend', side_effect=lambda: isolate.run_operation), \
             patch.object(cli, 'plugin_names', return_value=['fixture']), \
             patch.object(cli, 'load_benchmark', return_value=Benchmark()), \
             patch('sys.stdout', new_callable=io.StringIO) as output:
            code = cli._check('fixture', True, Path('/tmp'))
        record = json.loads(output.getvalue())
        self.assertEqual(code, 2)
        self.assertIn(result.detail, record['submissionError'])
        self.assertEqual(record['isolationDetail'], result.diagnostics())
        self.assertIsNone(record['submissionDetail'])


@unittest.skipUnless(hasattr(os, 'fork'), 'requires POSIX isolation')
class ReapFailureModes(unittest.TestCase):
    """Force wait and cleanup failures without relying on OS scheduling."""

    def test_a_wait_that_fails_does_not_become_a_clean_exit(self):
        # `_reap` used to report a failed wait as status 0, which reads as "exited
        # normally, no signal". Used as the authoritative record that turned a
        # self-SIGKILL into a child that apparently exited fine.
        calls = []
        real = isolate.os.waitpid

        def flaky(pid, flags=0):
            if flags == 0 and not calls:
                calls.append(pid)
                raise OSError(4, 'Interrupted system call')
            return real(pid, flags)

        with patch.object(isolate.os, 'waitpid', flaky):
            result = isolate.run_isolated(lambda: os.kill(os.getpid(), signal.SIGKILL))

        self.assertEqual(len(calls), 1, 'the failing wait was never exercised')
        self.assertEqual(result.status, isolate.CRASHED)
        self.assertEqual(result.signal, 9, 'a failed wait was reported as a clean exit')
        self.assertFalse(result.alarm_fired)

    def test_an_alarm_inside_the_reap_keeps_an_observable_signal(self):
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        calls = []
        def interrupted_wait(pid, flags):
            calls.append(flags)
            if flags == 0:
                raise isolate._Alarm()
            return pid, signal.SIGKILL
        with patch.object(isolate.os, 'waitpid', side_effect=interrupted_wait), \
             patch.object(isolate, '_terminate'):
            result = isolate._collect(123, read_fd, 5, 1234)
        self.assertEqual(calls, [0, os.WNOHANG])
        self.assertTrue(result.alarm_fired)
        self.assertEqual(result.status, isolate.TIMED_OUT)
        self.assertEqual(result.signal, 9)

    def test_interrupted_authoritative_wait_retries_before_any_cleanup(self):
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        calls = []
        def interrupted_wait(pid, flags):
            calls.append(('wait', flags))
            if len(calls) == 1:
                raise OSError(4, 'Interrupted system call')
            return pid, signal.SIGKILL
        with patch.object(isolate.os, 'waitpid', side_effect=interrupted_wait), \
             patch.object(isolate, '_terminate', side_effect=lambda pid: calls.append(('kill', pid))):
            result = isolate._collect(123, read_fd, 5, 1234)
        self.assertEqual(calls, [('wait', 0), ('wait', 0), ('kill', 123)])
        self.assertEqual(result.status, isolate.CRASHED)
        self.assertEqual(result.signal, 9)
        self.assertFalse(result.alarm_fired)

    def test_cleanup_close_and_nonblocking_wait_errors_do_not_escape(self):
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        close = os.close
        def closed(fd):
            close(fd)
            raise OSError(9, 'already closed')
        with patch.object(isolate, '_read_payload', side_effect=isolate._PayloadError('invalid_outcome')), \
             patch.object(isolate.os, 'close', side_effect=closed), \
             patch.object(isolate.os, 'waitpid', side_effect=OSError(10, 'no child')), \
             patch.object(isolate, '_terminate') as terminate:
            result = isolate._collect(123, read_fd, 5, 1234)
        self.assertEqual(result.status, isolate.CRASHED)
        self.assertEqual(result.read_reason, 'invalid_outcome')
        self.assertIsNone(result.signal)
        self.assertNotIn('exited without', result.detail)
        terminate.assert_called_once_with(123)

    def test_native_previous_handler_does_not_leave_our_alarm_armed(self):
        read_fd, write_fd = os.pipe()
        os.close(write_fd)
        with patch.object(isolate.signal, 'signal', return_value=None) as handler, \
             patch.object(isolate.signal, 'alarm') as alarm, \
             patch.object(isolate.os, 'waitpid', return_value=(123, 0)), \
             patch.object(isolate, '_terminate'):
            result = isolate._collect(123, read_fd, 5, 1234)
        self.assertFalse(result.alarm_fired)
        self.assertEqual([call.args for call in alarm.call_args_list], [(5,), (0,)])
        handler.assert_called_once_with(signal.SIGALRM, isolate._on_alarm)
