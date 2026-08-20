from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.isolate import (  # noqa: E402
    COMPLETED,
    CRASHED,
    RAISED,
    TIMED_OUT,
    run_isolated,
)


def _segfault():
    import ctypes

    ctypes.string_at(0)


def _spin():
    while True:
        pass


def _write_beside_me():
    Path("db.pkl").write_bytes(b"student state")
    return Path("db.pkl").resolve().parent.name


def _read_stdin():
    return sys.stdin.read()


def _leak_a_child():
    import subprocess

    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    return "spawned"


class IsolationTests(unittest.TestCase):
    """Discovery calls functions nobody vetted. It must fail like a CI job."""

    def test_a_normal_result_comes_back(self):
        outcome = run_isolated(lambda: 6 * 7)
        self.assertEqual(outcome.status, COMPLETED)
        self.assertEqual(outcome.value, 42)
        self.assertTrue(outcome.ok)

    def test_an_exception_is_a_no_not_a_disaster(self):
        outcome = run_isolated(lambda: 1 / 0)
        self.assertEqual(outcome.status, RAISED)
        self.assertIn("ZeroDivisionError", outcome.detail)
        self.assertFalse(outcome.ok)

    def test_the_parent_survives_a_segfault(self):
        """One repository's mp3 splitter aborts the interpreter through a
        second native audio backend. No except clause can catch that."""

        outcome = run_isolated(_segfault)

        self.assertEqual(outcome.status, CRASHED)
        self.assertIn("segfaulted", outcome.detail)

    def test_an_endless_loop_is_stopped(self):
        """Either limit may land first. A spin burns wall clock and CPU at the
        same rate, and both are set to the same number of seconds, so which
        signal arrives is a race the test must not pick a winner in. What
        matters is that the loop stops and the reason names time."""

        outcome = run_isolated(_spin, timeout_seconds=3)

        self.assertEqual(outcome.status, TIMED_OUT)
        self.assertIn("time", outcome.detail)

    def test_files_are_written_to_scratch_not_the_repository(self):
        """One audited repository keeps a module-global relative db.pkl and
        rewrites it on every add, so two runs sharing a directory corrupt
        each other."""

        outcome = run_isolated(_write_beside_me)

        self.assertEqual(outcome.status, COMPLETED)
        self.assertTrue(outcome.value.startswith("cogworks-discovery-"))

    def test_reading_from_the_terminal_ends_rather_than_hangs(self):
        """Two repositories prompt for a file path at module scope."""

        outcome = run_isolated(_read_stdin, timeout_seconds=10)

        self.assertEqual(outcome.status, COMPLETED)
        self.assertEqual(outcome.value, "")

    def test_a_process_the_child_started_does_not_outlive_it(self):
        outcome = run_isolated(_leak_a_child, timeout_seconds=10)
        self.assertEqual(outcome.status, COMPLETED)

    def test_an_unpicklable_result_is_reported_not_lost(self):
        outcome = run_isolated(lambda: (lambda: None))
        self.assertNotEqual(outcome.status, COMPLETED)
        self.assertTrue(outcome.detail)

    def test_the_parent_is_unchanged_afterwards(self):
        before_cwd = Path.cwd()
        before_pid = os.getpid()

        run_isolated(_segfault)
        run_isolated(_spin, timeout_seconds=2)
        run_isolated(lambda: 1)

        self.assertEqual(Path.cwd(), before_cwd)
        self.assertEqual(os.getpid(), before_pid)


if __name__ == "__main__":
    unittest.main()
