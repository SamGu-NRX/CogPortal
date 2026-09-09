from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench.isolate import (  # noqa: E402
    COMPLETED,
    CRASHED,
    RAISED,
    TIMED_OUT,
    _original_command,
    run_isolated,
)


def _segfault():
    # A signal, not a real null dereference. The wait status is identical
    # (WIFSIGNALED, SIGSEGV), which is all `_describe_death` reads, and a
    # genuine EXC_BAD_ACCESS makes macOS write a crash report for every run
    # of this suite: 25 of them landed in ~/Library/Logs/DiagnosticReports on
    # 2026-09-04 and read as the machine crashing.
    import signal

    os.kill(os.getpid(), signal.SIGSEGV)


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


@unittest.skipUnless(hasattr(os, "fork"), "requires os.fork process isolation")
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


#: Run in four independent parent processes: pin the seed the way a command
#: line entry point does, then ask the isolated child what a string hashes to.
#: `run_isolated` forks, so the child's seed is whatever the parent was given
#: and the pinning has to have happened before this process started.
_SEED_PROBE = """
import sys
sys.path.insert(0, {src!r})
from cogbench.isolate import ensure_pinned_hash_seed, run_isolated

ensure_pinned_hash_seed()
print(run_isolated(_probe).value)
"""

_PROBE_BODY = """
def _probe():
    return hash("cogbench-seed-probe")
"""


class DiscoveryRunsUnderASeedSomebodyChose(unittest.TestCase):
    """Same repository bytes, same binding, same score.

    One 2026 repository builds its IDF table by iterating a set, so which
    order words land in it depends on string hashing and its text retrieval
    score moved with the seed. An interpreter's seed is fixed before its
    first line runs, so setting `PYTHONHASHSEED` after the fork -- which is
    what the child did -- changes what the child's own children get and
    nothing about the child. Measured before this existed: four independent
    parents each got a different hash while the child reported
    `PYTHONHASHSEED="0"`.
    """

    def _hash_from_a_fresh_process(self) -> str:
        import subprocess

        source = _PROBE_BODY + _SEED_PROBE.format(
            src=str(ROOT / "python" / "cogbench" / "src")
        )
        directory = tempfile.TemporaryDirectory(prefix="cogbench-seed-probe-")
        self.addCleanup(directory.cleanup)
        script = Path(directory.name) / "probe.py"
        script.write_text(source, encoding="utf-8")
        environment = dict(os.environ)
        # The state a student's machine is in: no seed chosen, so the
        # interpreter picks one. Anything that pins the run has to do it
        # from here.
        environment["PYTHONHASHSEED"] = "random"
        environment.pop("COGBENCH_HASH_SEED_PINNED", None)
        done = subprocess.run(
            [sys.executable, str(script)],
            capture_output=True,
            text=True,
            env=environment,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.strip()

    @unittest.skipUnless(hasattr(os, "fork"), "requires os.fork process isolation")
    def test_four_independent_runs_hash_a_string_the_same_way(self):
        answers = {self._hash_from_a_fresh_process() for _ in range(4)}

        self.assertEqual(len(answers), 1, answers)

    def test_the_seed_that_was_in_effect_is_readable(self):
        from cogbench.isolate import hash_seed_in_effect

        # This interpreter's own state, whatever it is: pinned reports the
        # seed, unpinned reports None rather than a guess.
        seed = hash_seed_in_effect()
        if sys.flags.hash_randomization:
            self.assertIsNone(seed)
        else:
            self.assertEqual(seed, os.environ.get("PYTHONHASHSEED", "0"))

    def test_python_38_rebuilds_a_module_invocation(self):
        from unittest.mock import patch

        main = str(
            ROOT / "python" / "cogbench" / "src" / "cogbench" / "__main__.py"
        )
        with patch.object(sys, "orig_argv", None, create=True), patch.object(
            sys, "argv", [main, "--version"]
        ), patch.object(sys, "executable", "/python3.8"):
            command = _original_command()

        self.assertEqual(command, ["/python3.8", "-m", "cogbench", "--version"])

    def test_pinning_is_a_no_op_once_the_seed_is_already_fixed(self):
        """A run that is already reproducible must not restart itself.

        Checked in a subprocess rather than here, because whether this
        interpreter is pinned depends on how the suite was started and a
        test that skips itself on the ordinary machine is not a test.
        """

        import subprocess

        source = (
            "import sys\n"
            "sys.path.insert(0, {src!r})\n"
            "from cogbench.isolate import ensure_pinned_hash_seed\n"
            "print(ensure_pinned_hash_seed())\n"
        ).format(src=str(ROOT / "python" / "cogbench" / "src"))

        done = subprocess.run(
            [sys.executable, "-c", source],
            capture_output=True,
            text=True,
            env=dict(os.environ, PYTHONHASHSEED="0"),
        )

        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout.strip(), "False")


class NoBudgetIsAllowed(unittest.TestCase):
    """A caller can decline the limits rather than inherit discovery's.

    `run` puts the whole scored benchmark behind this boundary, and the hosted
    runner gives that work 900 seconds where discovery's default is 300. Two
    hosted runs of one 2026 week 1 repository took 875 and 898 seconds, so the
    default would have ended a working submission early and called it a
    timeout.
    """

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_work_runs_with_neither_a_clock_nor_a_ceiling(self):
        outcome = run_isolated(
            lambda: "finished", timeout_seconds=None, memory_bytes=None
        )
        self.assertEqual(outcome.status, COMPLETED)
        self.assertEqual(outcome.value, "finished")

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_a_crash_is_still_contained_without_limits(self):
        outcome = run_isolated(_segfault, timeout_seconds=None, memory_bytes=None)
        self.assertEqual(outcome.status, CRASHED)
        self.assertIn("segfault", outcome.detail.lower())
