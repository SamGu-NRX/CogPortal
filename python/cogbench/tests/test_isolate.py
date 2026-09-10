from __future__ import annotations

import os
import sys
import tempfile
import time
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

    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"]).pid


class OutcomeContractTests(unittest.TestCase):
    def test_outcome_has_only_the_fields_the_child_populates(self):
        from dataclasses import fields
        from cogbench.isolate import Outcome

        self.assertEqual([field.name for field in fields(Outcome)], ["status", "value", "detail"])

    def test_only_reachable_statuses_are_exported(self):
        from cogbench import isolate

        statuses = {name for name in isolate.__all__ if name.isupper()}
        self.assertEqual(statuses, {"COMPLETED", "RAISED", "CRASHED", "TIMED_OUT"})
        self.assertFalse(hasattr(isolate, "OUT_OF_MEMORY"))


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
        pid = outcome.value
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            else:
                self.fail("grandchild {} survived process-group cleanup".format(pid))
        finally:
            # A failing regression must not leave its sleeping process behind.
            import signal
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def test_short_pipe_writes_still_deliver_the_completed_result(self):
        from unittest.mock import patch
        from cogbench import isolate

        write = os.write
        # Deterministically reproduce a signal-shortened write, including
        # a split length prefix, without depending on signal timing.
        with patch.object(isolate.os, "write", side_effect=lambda fd, data: write(fd, data[:3])):
            outcome = run_isolated(lambda: "finished" * 100)
        self.assertEqual(outcome.status, COMPLETED)
        self.assertEqual(outcome.value, "finished" * 100)

    def test_buffered_output_is_flushed_without_repeating_parent_output(self):
        import subprocess

        for raises in (False, True):
            with self.subTest(raises=raises):
                source = """
import sys
sys.path.insert(0, {src!r})
from cogbench.isolate import run_isolated
sys.stderr.reconfigure(line_buffering=False)
sys.stdout.write("parent-out|")
sys.stderr.write("parent-err|")
def work():
    sys.stdout.write("child-out|")
    sys.stderr.write("child-err|")
    if {raises!r}:
        raise ValueError("student error")
    return 42
outcome = run_isolated(work)
assert outcome.status == {status!r}, outcome
""".format(src=str(ROOT / "python" / "cogbench" / "src"), raises=raises,
           status=RAISED if raises else COMPLETED)
                done = subprocess.run([sys.executable, "-c", source], capture_output=True, text=True, timeout=15)
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertEqual(done.stdout, "parent-out|child-out|")
                self.assertEqual(done.stderr, "parent-err|child-err|")

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
    def test_the_child_really_has_no_cpu_limit(self):
        """Read from inside the child, not from the arguments it was given.

        Asserting the keyword would still pass if `_apply_limits` started
        ignoring None, which is the thing that would actually break this.
        """

        import resource

        def limits():
            return resource.getrlimit(resource.RLIMIT_CPU)

        with_none = run_isolated(limits, timeout_seconds=None, memory_bytes=None)
        with_seven = run_isolated(limits, timeout_seconds=7)

        self.assertEqual(with_none.status, COMPLETED)
        self.assertEqual(with_none.value, (resource.RLIM_INFINITY, resource.RLIM_INFINITY))
        self.assertEqual(with_seven.value, (7, 12))

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_a_core_file_is_refused_either_way(self):
        """Not a budget on the work: it refuses a multi-gigabyte core file
        when the crash this boundary exists for happens."""

        import resource

        outcome = run_isolated(
            lambda: resource.getrlimit(resource.RLIMIT_CORE),
            timeout_seconds=None,
            memory_bytes=None,
        )
        self.assertEqual(outcome.value, (0, 0))

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_an_outside_kill_is_not_called_a_timeout(self):
        """With no clock there is nothing to time out, so a SIGKILL came from
        the OOM killer or from someone typing kill. Calling that "longer than
        the time allowed" is a claim about elapsed time nothing measured."""

        def _killed():
            import signal as s

            os.kill(os.getpid(), s.SIGKILL)

        outcome = run_isolated(_killed, timeout_seconds=None, memory_bytes=None)
        self.assertEqual(outcome.status, CRASHED)
        self.assertNotIn("time allowed", outcome.detail)
        self.assertIn("too much memory", outcome.detail)

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_a_crash_is_still_contained_without_limits(self):
        outcome = run_isolated(_segfault, timeout_seconds=None, memory_bytes=None)
        self.assertEqual(outcome.status, CRASHED)
        self.assertIn("segfault", outcome.detail.lower())


class WindowsDoesNotReplaceItself(unittest.TestCase):
    """`os.execve` on Windows starts a second process and ends this one, so
    the caller reads an exit code from a process that did no work. Measured:
    `cogworks --version` printed nothing and exited 1."""

    def test_the_entry_point_stays_unpinned_rather_than_re_executing(self):
        from unittest.mock import patch

        from cogbench.isolate import ensure_pinned_hash_seed

        calls = []
        with patch.object(os, "name", "nt"), \
                patch.object(os, "execve", lambda *a: calls.append(a)):
            self.assertFalse(ensure_pinned_hash_seed(["python", "-m", "cogbench"]))
        self.assertEqual(calls, [], "nothing was re-executed")
