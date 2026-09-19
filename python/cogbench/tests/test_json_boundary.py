"""The parent accepts reports, never executable objects or child-claimed deaths."""
import json
import os
import pickle
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from cogbench import isolate


class JsonEnvelope(unittest.TestCase):
    def read(self, body):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, struct.pack('!I', len(body)) + body)
            os.close(write_fd)
            return isolate._read_payload(read_fd)
        finally:
            os.close(read_fd)

    def test_completed_and_raised_have_only_their_allowed_fields(self):
        completed = {'status': 'completed', 'detail': '', 'value': {'unicode': 'λ', 'items': [None, True, 3, 2.5]}}
        result = self.read(json.dumps(completed).encode('utf-8'))
        self.assertEqual(result.value, completed['value'])
        self.assertIsNone(result.signal)
        self.assertFalse(result.alarm_fired)
        result = self.read(b'{"status":"raised","detail":"TypeError: bad input"}')
        self.assertEqual(result.status, isolate.RAISED)
        self.assertEqual(result.detail, 'TypeError: bad input')
        self.assertIsNone(result.value)

    def test_decoder_baseexceptions_are_categorized_but_alarm_is_preserved(self):
        from unittest.mock import patch
        class DecoderFailure(BaseException):
            pass
        for error in (SystemExit(23), DecoderFailure()):
            with self.subTest(error=type(error).__name__), \
                 patch.object(isolate.json, 'loads', side_effect=error):
                with self.assertRaisesRegex(isolate._PayloadError, 'invalid_outcome'):
                    self.read(b'{}')
        with patch.object(isolate.json, 'loads', side_effect=isolate._Alarm):
            with self.assertRaises(isolate._Alarm):
                self.read(b'{}')

    def test_invalid_envelopes_cannot_claim_parent_observations(self):
        records = [
            None, [], {},
            {'status': 'completed', 'detail': ''},
            {'status': 'completed', 'detail': [], 'value': None},
            {'status': 'raised', 'detail': '', 'value': None},
            {'status': 'crashed', 'detail': ''},
            {'status': 'timed_out', 'detail': ''},
        ]
        for field, value in [('signal', 9), ('alarm_fired', True), ('read_reason', 'eof'),
                             ('timeout_seconds', 1), ('memory_bytes', 1), ('unknown', None)]:
            records.append(dict(status='completed', detail='', value=None, **{field: value}))
        for record in records:
            with self.subTest(record=record), self.assertRaisesRegex(isolate._PayloadError, 'invalid_outcome'):
                self.read(json.dumps(record).encode('utf-8'))

    def test_invalid_utf8_duplicates_and_non_json_numbers_are_rejected(self):
        for body in [b'\xff', b'bad', b'{"status":"completed","detail":"","value":NaN}',
                     b'{"status":"completed","detail":"","value":1e999}',
                     b'{"status":"completed","status":"raised","detail":""}',
                     b'{"status":"completed","detail":"","value":{"x":1,"x":2}}']:
            with self.subTest(body=body), self.assertRaisesRegex(isolate._PayloadError, 'invalid_outcome'):
                self.read(body)

    def test_crafted_pickle_does_not_execute_in_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / 'executed'
            class Attack:
                def __reduce__(self):
                    return (os.system, ('touch ' + str(marker),))
            body = pickle.dumps(Attack())
            with self.assertRaisesRegex(isolate._PayloadError, 'invalid_outcome'):
                self.read(body)
            self.assertFalse(marker.exists())

    @unittest.skipUnless(hasattr(os, 'fork'), 'POSIX isolation')
    def test_live_python_objects_and_numpy_scalars_are_refused(self):
        # numpy is not installed in every CI job, and the Python objects are
        # the part that must hold everywhere. Add the scalars when the
        # interpreter has them rather than skipping the whole case.
        values = [lambda: None, ValueError('bad'), Path('/tmp')]
        try:
            import numpy as np
        except ImportError:
            pass
        else:
            values += [np.int64(1), np.float64(1), np.bool_(True)]
        for value in values:
            with self.subTest(kind=type(value).__name__):
                result = isolate.run_isolated(lambda: value)
                self.assertEqual(result.status, isolate.RAISED)
                self.assertIn('TypeError', result.detail)

    @unittest.skipUnless(hasattr(os, 'fork'), 'POSIX isolation')
    def test_invalid_envelope_is_reported_beside_observed_exit(self):
        from unittest.mock import patch
        def invalid(work, fd, *args):
            os.setsid()
            body = b'{"status":"crashed","detail":"pretend"}'
            os.write(fd, struct.pack('!I', len(body)) + body)
            os._exit(23)
        # Full malformed frames do not imply EOF. Wait for the fixture's exit
        # before reading to isolate envelope rejection from cleanup timing.
        real_read = isolate._read_payload
        status = []
        def read(fd, exited=None):
            pid, observed = os.wait()
            status.append((pid, observed))
            return real_read(fd, exited)
        real_wait = os.waitpid
        def wait(pid, options):
            if status:
                return status.pop()
            return real_wait(pid, options)
        with patch.object(isolate, '_child', invalid), \
             patch.object(isolate, '_read_payload', side_effect=read), \
             patch.object(isolate.os, 'waitpid', side_effect=wait):
            result = isolate.run_isolated(lambda: None)
        self.assertEqual(result.read_reason, 'invalid_outcome')
        self.assertIn('status 23', result.detail)
        self.assertEqual(result.status, isolate.CRASHED)
        self.assertIsNone(result.signal)
