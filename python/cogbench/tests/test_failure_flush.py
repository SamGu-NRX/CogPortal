"""Failure paths that never publish still flush buffered child diagnostics."""
import os
import subprocess
import sys
import unittest
from pathlib import Path


@unittest.skipUnless(hasattr(os, 'fork'), 'POSIX child boundary')
class FailureFlush(unittest.TestCase):
    def run_child(self, source):
        bootstrap = '''
import os, signal, sys
from pathlib import Path
from cogbench.isolate import _child
'''
        environment = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / 'src'))
        return subprocess.run([sys.executable, '-c', bootstrap + source],
                              env=environment, capture_output=True, text=True, timeout=15)

    def test_broken_exception_string_keeps_output_before_the_error(self):
        result = self.run_child('''
class Broken(Exception):
    def __str__(self):
        raise RuntimeError('cannot format error')
def work():
    print('before error;', end='')
    raise Broken()
read_fd, write_fd = os.pipe()
_child(work, write_fd, Path.cwd(), None, None)
''')
        self.assertEqual(result.returncode, 70, result.stderr)
        self.assertEqual(result.stdout, 'before error;')

    def test_broken_pipe_handler_output_after_publication_flush_survives(self):
        result = self.run_child('''
original_write = os.write
def diagnosed_write(fd, data):
    try:
        return original_write(fd, data)
    except BrokenPipeError:
        print('student SIGPIPE diagnostic', end='')
        raise
def work():
    # Handle the real EPIPE exception so signal-delivery timing cannot move
    # this test's diagnostic into a different cleanup step.
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    os.write = diagnosed_write
    print('before payload;', end='')
    return 42
read_fd, write_fd = os.pipe()
os.close(read_fd)
_child(work, write_fd, Path.cwd(), None, None)
''')
        self.assertEqual(result.returncode, 70, result.stderr)
        self.assertEqual(result.stdout, 'before payload;student SIGPIPE diagnostic')
