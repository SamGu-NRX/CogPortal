from __future__ import annotations

import os
import signal
import sys
import threading
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import isolate as isolate_module  # noqa: E402
from cogbench.isolate import (  # noqa: E402
    COMPLETED,
    CRASHED,
    RAISED,
    TIMED_OUT,
    _original_command,
    run_isolated,
)
from cogbench.isolate import _describe_death  # noqa: E402


def _killed():
    # SIGKILL, not SIGSEGV. Sending SIGSEGV was believed to avoid the crash
    # report a genuine EXC_BAD_ACCESS writes; it does not. Fifty-three reports
    # landed in ~/Library/Logs/DiagnosticReports between 02:23 and 02:37 on
    # 2026-09-14, one per execution of the fixtures in this file and in
    # test_discover, and they read to the owner as the machine crashing.
    # SIGKILL is a real fatal signal no `except` clause can catch, which is
    # what these tests are about, and it writes no report. The wording for a
    # segfault is pinned separately, against the formatter.
    import signal

    os.kill(os.getpid(), signal.SIGKILL)


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

    def test_the_parent_survives_a_child_killed_outright(self):
        """One repository's mp3 splitter aborts the interpreter through a
        second native audio backend. No except clause can catch that."""

        outcome = run_isolated(_killed)

        self.assertEqual(outcome.status, CRASHED)
        self.assertTrue(outcome.detail)
        self.assertFalse(outcome.ok)

    def test_a_segfault_is_named_as_one(self):
        """The wording, without the report. `_describe_death` reads only the
        wait status, so a synthetic one says everything running a real
        segfault said, and says it on every platform rather than only where
        the signal can be raised."""

        import signal

        outcome = _describe_death(signal.SIGSEGV)

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

    def test_a_caller_supplied_scratch_directory_is_used_and_kept(self):
        """`scratch=` is the contract `cogworks check` and `cogworks run` use.

        Both pass the project root (cli.py:452 and :859), which is the
        student's own repository, so three things have to hold at once: the
        child really works there, the directory is still there afterwards
        with whatever their code wrote in it, and the parent's own working
        directory never moves. Without the third, a command that isolates one
        step would silently relocate every later step.

        The default path is different and is not what this covers: with no
        `scratch=`, the child works in a temporary directory that is removed.
        """

        import shutil

        before = Path.cwd()
        scratch = Path(tempfile.mkdtemp(prefix="cogworks-scratch-test-")).resolve()
        self.addCleanup(shutil.rmtree, str(scratch), ignore_errors=True)

        def _work():
            Path("their-state.txt").write_text("student state", encoding="utf-8")
            return os.getcwd()

        outcome = run_isolated(_work, scratch=scratch)

        self.assertEqual(outcome.status, COMPLETED)
        self.assertEqual(
            Path(outcome.value).resolve(), scratch, "the child worked somewhere else"
        )
        kept = scratch / "their-state.txt"
        self.assertTrue(kept.exists(), "the caller's directory did not survive the run")
        self.assertEqual(kept.read_text(encoding="utf-8"), "student state")
        self.assertEqual(Path.cwd(), before, "the parent's working directory moved")

    def test_without_a_scratch_directory_the_child_works_somewhere_temporary(self):
        """The other half of the same contract, so the test above is about the
        explicit argument rather than about `os.getcwd` in general."""

        before = Path.cwd()
        outcome = run_isolated(os.getcwd)

        self.assertEqual(outcome.status, COMPLETED)
        self.assertNotEqual(Path(outcome.value).resolve(), before)
        self.assertFalse(
            Path(outcome.value).exists(), "the temporary directory outlived the run"
        )
        self.assertEqual(Path.cwd(), before)

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

    def test_a_non_json_result_is_reported_not_lost(self):
        outcome = run_isolated(lambda: (lambda: None))
        self.assertNotEqual(outcome.status, COMPLETED)
        self.assertTrue(outcome.detail)

    def test_the_parent_is_unchanged_afterwards(self):
        before_cwd = Path.cwd()
        before_pid = os.getpid()

        run_isolated(_killed)
        run_isolated(_spin, timeout_seconds=2)
        run_isolated(lambda: 1)

        self.assertEqual(Path.cwd(), before_cwd)
        self.assertEqual(os.getpid(), before_pid)


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
        self.assertEqual(with_none.value, [resource.RLIM_INFINITY, resource.RLIM_INFINITY])
        self.assertEqual(with_seven.value, [7, 12])

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
        self.assertEqual(outcome.value, [0, 0])

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
        self.assertIn("unknown", outcome.detail)
        self.assertFalse(outcome.alarm_fired)

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_a_crash_is_still_contained_without_limits(self):
        outcome = run_isolated(_killed, timeout_seconds=None, memory_bytes=None)
        self.assertEqual(outcome.status, CRASHED)
        self.assertTrue(outcome.detail)


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



class TheCallerKeepsWhatItBroughtIn(unittest.TestCase):
    """`_collect` arms its own `SIGALRM` and used to discard whatever the
    caller already had pending. Measured before this: a caller holding four
    seconds got zero back and its handler never ran, with nothing raised to
    say the timer had gone."""

    @unittest.skipUnless(hasattr(signal, "alarm"), "needs SIGALRM")
    def test_an_alarm_the_caller_already_had_is_given_back(self):
        fired = []
        previous = signal.signal(signal.SIGALRM, lambda *_: fired.append(True))
        signal.alarm(4)
        try:
            outcome = run_isolated(lambda: 1, timeout_seconds=2)
            left = signal.alarm(0)
        finally:
            signal.signal(signal.SIGALRM, previous)

        self.assertEqual(outcome.status, COMPLETED)
        self.assertEqual(fired, [])
        # One second of slack: `alarm` counts in whole seconds, so what comes
        # back is the remainder rounded down, not the exact figure.
        self.assertGreaterEqual(left, 1)
        self.assertLessEqual(left, 4)


class AWorkerThreadGetsAnOutcomeLikeEveryOtherCaller(unittest.TestCase):
    """`signal.signal` raises off the main thread, and it raised out of
    `run_isolated` rather than returning. A caller that handles a crash, a
    timeout and a memory limit as results was taken down by this one alone."""

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_running_off_the_main_thread_returns_rather_than_raises(self):
        result = {}

        def work():
            try:
                result["outcome"] = run_isolated(lambda: 2, timeout_seconds=5)
            except BaseException as error:  # noqa: BLE001 - reported, not raised
                result["raised"] = "{}: {}".format(type(error).__name__, error)

        worker = threading.Thread(target=work)
        worker.start()
        worker.join(timeout=30)

        self.assertFalse(worker.is_alive())
        self.assertNotIn("raised", result)
        self.assertEqual(result["outcome"].status, COMPLETED)
        self.assertEqual(result["outcome"].value, 2)

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_a_sleeping_child_on_a_worker_still_hits_its_deadline(self):
        """The first fix here skipped the parent's alarm off the main thread
        and claimed the child's own limit covered it. That was wrong: the
        child's limit is RLIMIT_CPU, which a sleeping or blocked child never
        spends. The containment owner measured it, `sleep(3)` under a
        one-second budget returning COMPLETED after 3.01 seconds. A worker
        gets a watchdog instead, so the wall-clock deadline is real."""

        result = {}

        def sleeper():
            time.sleep(6)
            return 42

        def work():
            result["outcome"] = run_isolated(
                sleeper, timeout_seconds=1, memory_bytes=None
            )

        worker = threading.Thread(target=work)
        started = time.monotonic()
        worker.start()
        worker.join(timeout=60)
        elapsed = time.monotonic() - started

        self.assertFalse(worker.is_alive())
        self.assertEqual(result["outcome"].status, TIMED_OUT)
        self.assertIsNone(result["outcome"].value)
        self.assertLess(elapsed, 5)

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_a_spinning_child_on_a_worker_also_stops(self):
        result = {}

        def work():
            result["outcome"] = run_isolated(_spin, timeout_seconds=2)

        worker = threading.Thread(target=work)
        worker.start()
        worker.join(timeout=60)

        self.assertFalse(worker.is_alive())
        self.assertNotEqual(result["outcome"].status, COMPLETED)
        self.assertTrue(result["outcome"].detail)


class AReapedChildIsNotSignalledAgain(unittest.TestCase):
    """Cleanup fired at the child's own pid whether or not it had been reaped.
    A reaped number is free for the kernel to hand to someone else, so that
    signal is addressed to nobody at best and to an unrelated process at
    worst. The group signal stays: a descendant can outlive the child and
    nothing else reaches one."""

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_cleanup_after_a_clean_exit_signals_only_the_group(self):
        sent = []
        real = os.kill

        def watch(pid, number):
            sent.append(pid)
            return real(pid, number)

        os.kill = watch
        try:
            outcome = run_isolated(lambda: 3, timeout_seconds=5)
        finally:
            os.kill = real

        self.assertEqual(outcome.status, COMPLETED)
        self.assertTrue(all(pid < 0 for pid in sent), sent)


class AFailedForkIsReportedLikeAnyOtherFailure(unittest.TestCase):
    """A machine out of processes is a condition to report, not an exception
    to propagate. It also leaked the result pipe, two descriptors per attempt,
    which is the shape that turns one exhausted fork into many."""

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_it_returns_an_outcome_and_closes_its_pipe(self):
        before = len(os.listdir("/dev/fd"))
        real = os.fork

        def refuse():
            raise OSError(35, "Resource temporarily unavailable")

        os.fork = refuse
        try:
            outcome = run_isolated(lambda: 4, timeout_seconds=2)
        finally:
            os.fork = real

        self.assertEqual(outcome.status, CRASHED)
        self.assertIn("could not start a process", outcome.detail)
        self.assertLessEqual(len(os.listdir("/dev/fd")), before)
        # The budgets travel with it like every other return from here, so
        # `diagnostics()` does not report this as an unlimited run.
        self.assertEqual(outcome.timeout_seconds, 2)
        self.assertIsNotNone(outcome.memory_bytes)

class TheWatchdogCannotActAfterTheOperationCloses(unittest.TestCase):
    """`Timer.cancel` does not stop a callback already dispatched, and only
    `exited()` took the lifecycle lock. The containment owner reproduced the
    consequence deterministically: the collector returned while the callback
    was blocked, cleanup observed `reaped=True`, and the released callback
    then signalled using the `reaped=False` it had captured earlier, after the
    operation had finished. Every reap and termination path shares one lock
    now, and `closed` is set under it, so a late callback does nothing.

    This test does not pin that fix and must not be read as doing so: it
    passes against the unfixed source too, because with real processes the
    interleaving it is looking for does not reliably occur. It is a guard
    against a regression that happens to be caught, not evidence the race is
    closed. The deterministic proof is the owner's instrumented probe, which
    forces the interleaving; reproducing that shape here needs the callback
    held before it takes the lock, which this cannot reach from outside."""

    @unittest.skipUnless(hasattr(os, "fork"), "needs fork")
    def test_no_signal_is_sent_once_the_collector_has_returned(self):
        sent = []
        real = isolate_module._terminate

        def record(pid, reaped=False):
            sent.append((time.monotonic(), reaped))
            return real(pid, reaped=reaped)

        isolate_module._terminate = record
        try:
            for _ in range(8):
                # The work lands near the deadline on purpose, so the timer
                # and the completion race rather than one clearly winning.
                outcome = {}

                def work():
                    outcome["got"] = run_isolated(
                        lambda: time.sleep(0.9), timeout_seconds=1
                    )

                worker = threading.Thread(target=work)
                worker.start()
                worker.join(timeout=30)
                returned = time.monotonic()
                self.assertFalse(worker.is_alive())
                time.sleep(0.3)
                late = [when for when, _ in sent if when > returned]
                self.assertEqual(late, [], "signal sent after the collector returned")
                sent.clear()
        finally:
            isolate_module._terminate = real


if __name__ == "__main__":
    unittest.main()
