"""Run discovery in a process that is allowed to die.

Discovery calls functions nobody vetted, with inputs their author never
anticipated, to find out what they are. Most answer or raise, and a raise is
just a no. Some do neither:

- ``slicing.split_mp3`` in one audited repository loads a second copy of soxr
  through pydub and the interpreter aborts with a nanobind duplicate-key
  error. There is no exception; the process is gone.
- A student's own ``while True`` in a helper never returns.
- A function that allocates a spectrogram for a whole album takes the machine
  down with it.

None of those are exceptional in a classroom, and none of them may take down a
run, a queue worker, or another team's evaluation. So discovery happens in a
child process with limits, and the parent reads a result or a cause of death.
A hard crash then reads the way a failing CI job reads: this one step failed,
here is what it was doing, everything else is untouched.

The parent never trusts the child for anything but data. The child returns a
report, never a live object, so a chain the child verified is re-bound in the
parent from names it reports, and re-verified there.
"""

from __future__ import annotations

import os
import pickle
try:
    import resource
except ImportError:  # Windows has no rlimits; `run_isolated` refuses there
    resource = None  # type: ignore[assignment]
import signal
import struct
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

__all__ = [
    "Outcome",
    "CRASHED",
    "TIMED_OUT",
    "OUT_OF_MEMORY",
    "RAISED",
    "COMPLETED",
    "run_isolated",
    "ensure_pinned_hash_seed",
    "hash_seed_in_effect",
]

COMPLETED = "completed"
RAISED = "raised"
CRASHED = "crashed"
TIMED_OUT = "timed_out"
OUT_OF_MEMORY = "out_of_memory"

#: Whole-of-discovery wall clock. Generous: the slowest legitimate import in
#: the corpus builds a FaceNet model, and a week 1 chain check enrolls two
#: synthetic songs. A repository that cannot be read inside this is reported
#: as slow, which is a true statement about it.
DEFAULT_TIMEOUT_SECONDS = 300

#: Address space ceiling for the child. Above the measured peak of a real
#: hosted run (1.5 GB) and below anything that would disturb the host.
DEFAULT_MEMORY_BYTES = 3 * 1024 * 1024 * 1024

#: Signals that mean the interpreter died rather than the code failed.
_FATAL = {
    getattr(signal, name): description
    for name, description in (
        ("SIGABRT", "aborted"),
        ("SIGSEGV", "segfaulted"),
        ("SIGBUS", "hit a bus error"),
        ("SIGILL", "executed an illegal instruction"),
        ("SIGFPE", "hit a floating point error"),
    )
    if hasattr(signal, name)
}


@dataclass(frozen=True)
class Outcome:
    """What happened in the child, in terms the parent can report.

    ``status`` is one of the five module constants. ``value`` is set only for
    ``COMPLETED``. ``detail`` is a sentence naming the cause, written for a
    student rather than for a log.
    """

    status: str
    value: Any = None
    detail: str = ""
    #: Whatever the child wrote before it died. A crash is far easier to place
    #: when the last thing the child printed is the function it was calling.
    trace: str = ""

    @property
    def ok(self) -> bool:
        return self.status == COMPLETED


#: Set on a process this module has already re-executed, so a failure to take
#: the seed cannot become an exec loop.
_REEXEC_MARK = "COGBENCH_HASH_SEED_PINNED"


def hash_seed_in_effect() -> Optional[str]:
    """The hash seed this interpreter is actually running with, or None.

    None means the interpreter chose a seed at startup and does not expose
    it: CPython keeps `_Py_HashSecret` private and offers no way to read or
    reset it. That is the whole reason pinning has to happen before the
    first line runs, and the reason a run that was not pinned has to say so
    rather than report a seed it is guessing.
    """

    if sys.flags.hash_randomization:
        return None
    return os.environ.get("PYTHONHASHSEED", "0")


def _original_command() -> Optional[list]:
    """The exact command line this interpreter was started with.

    `sys.argv` is not it and cannot be made into it: under ``python -m
    cogbench check`` it holds the path of ``__main__.py``, and re-running
    that file as a script breaks its relative imports; under ``python -c
    SOURCE`` it holds ``["-c"]`` and the source is simply gone. Both were
    tried, and both produced a re-execution that failed rather than a run
    with a pinned seed.

    ``sys.orig_argv`` is the real thing and exists from Python 3.10. On
    Python 3.8, a ``-m`` invocation can still be identified by its
    ``__main__.py`` path and rebuilt from this module's package. A ``-c``
    invocation remains unknowable, so it returns None and stays unpinned.
    """

    original = getattr(sys, "orig_argv", None)
    if original:
        return list(original)
    if not sys.argv or not sys.argv[0] or sys.argv[0].startswith("-"):
        return None
    if Path(sys.argv[0]).name == "__main__.py":
        package = getattr(globals().get("__spec__"), "parent", None)
        if not package:
            package = Path(sys.argv[0]).parent.name
        if not package:
            return None
        return [sys.executable, "-m", package] + list(sys.argv[1:])
    return [sys.executable] + list(sys.argv)


def ensure_pinned_hash_seed(command: Optional[list] = None) -> bool:
    """Re-execute this process once with ``PYTHONHASHSEED=0``, if it must.

    An interpreter's hash seed is fixed before its first line runs. Setting
    ``os.environ["PYTHONHASHSEED"]`` afterwards changes what its CHILDREN
    get and nothing about itself, and `run_isolated` forks rather than
    executes, so the discovery child inherits whatever the parent was given.
    Measured before this existed: four independent parents each ran
    ``run_isolated(lambda: hash("cogbench-seed-probe"))`` and got four
    different hashes, while the child reported ``PYTHONHASHSEED="0"``.

    The only way to actually get a pinned seed is to start an interpreter
    with one, so a command-line entry point calls this first and, when the
    seed is loose, replaces itself with the same command under a pinned
    environment. Returns whether a re-execution happened, which is never on
    the second pass.

    Deliberately not called from library code. Replacing the process is a
    reasonable thing for `python -m cogbench` to do to itself and not
    something an imported function may do to its caller; a hosted run gets
    the same guarantee from the image, which sets the variable for every
    process in the sandbox.
    """

    if not sys.flags.hash_randomization:
        return False
    if os.environ.get(_REEXEC_MARK):
        # Already tried and the seed still did not take. Re-executing again
        # would be a loop, and the binding records that it is not pinned.
        return False
    line = list(command) if command else _original_command()
    if not line:
        return False
    environment = dict(os.environ)
    environment["PYTHONHASHSEED"] = "0"
    environment[_REEXEC_MARK] = "1"
    try:
        sys.stdout.flush()
        sys.stderr.flush()
        os.execve(sys.executable, line, environment)
    except OSError:
        # A machine that will not execute us again is not a reason to refuse
        # to run. The seed stays loose and the record says so.
        return False
    raise AssertionError("unreachable")  # pragma: no cover - execve does not return


def _pin_hash_seed() -> None:
    """Fix the hash seed for everything this child starts.

    This does NOT re-seed the child itself, and it never did: the child is a
    fork, its seed was fixed when the parent started, and no environment
    variable set afterwards can change it. `ensure_pinned_hash_seed` is what
    actually pins a run, at the entry point, before any of this.

    What this still buys is every process the child starts, and every
    re-execution of it. Kept for that, and for the reason below.

    One 2026 repository builds its inverse-document-frequency table by
    iterating a set, so the order words land in the table depends on string
    hashing, and its text retrieval score moved between 0.8188 and 0.8335
    across three seeds. That is a number the student did not choose and
    cannot reproduce, which makes it a bad thing to score.

    Whether the run was pinned is recorded on the binding
    (`Submission.to_dict`), so a run that was not pinned says so rather than
    claiming a determinism it does not have.
    """

    os.environ["PYTHONHASHSEED"] = "0"


def _apply_limits(
    memory_bytes: Optional[int], timeout_seconds: Optional[int]
) -> None:
    """Bound the child before it runs a line of student code.

    ``None`` for either means the caller is not imposing that limit. Reading a
    repository has a budget; running the whole benchmark does not, and giving
    it discovery's budget would end a legitimate run early.
    """

    if resource is None:
        # A platform can have fork and no resource module. Reaching for it
        # anyway raises AttributeError, which is not in the tuples below, so
        # the child exited 70 and reported "exited with status 70".
        return
    try:
        if memory_bytes is not None:
            resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    except (ValueError, OSError):
        # Some platforms refuse an address-space limit. The wall clock and the
        # process boundary still hold, so this is a weaker child, not an
        # unsafe one.
        pass
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (ValueError, OSError):
        pass
    # A CPU limit catches a spin that the wall clock would also catch, but it
    # arrives as a signal the parent can name precisely.
    try:
        if timeout_seconds is not None:
            resource.setrlimit(
                resource.RLIMIT_CPU, (timeout_seconds, timeout_seconds + 5)
            )
    except (ValueError, OSError):
        pass


def _child(
    work: Callable[[], Any],
    write_fd: int,
    scratch: Path,
    memory_bytes: int,
    timeout_seconds: int,
) -> None:
    """Everything after the fork. Never returns; always ``_exit``.

    ``os._exit`` rather than ``sys.exit`` on every path: a normal exit would
    run the parent's atexit handlers and flush its buffers a second time, and
    student code that registered one of those would run it here.
    """

    exit_code = 0
    try:
        os.setsid()
    except OSError:
        pass
    try:
        os.chdir(scratch)
        _pin_hash_seed()
        _apply_limits(memory_bytes, timeout_seconds)
        # Student code that reads from a terminal gets EOF rather than a hang.
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        try:
            payload = pickle.dumps(
                Outcome(COMPLETED, value=work()), protocol=pickle.HIGHEST_PROTOCOL
            )
        except BaseException as error:  # noqa: BLE001 - the child owns every failure
            payload = pickle.dumps(
                Outcome(
                    RAISED,
                    detail="{}: {}".format(type(error).__name__, str(error)[:300]),
                ),
                protocol=pickle.HIGHEST_PROTOCOL,
            )
        os.write(write_fd, struct.pack("!I", len(payload)))
        os.write(write_fd, payload)
    except BaseException:  # noqa: BLE001 - a broken pipe must not raise here
        exit_code = 70
    finally:
        try:
            os.close(write_fd)
        except OSError:
            pass
        os._exit(exit_code)


def _read_payload(read_fd: int) -> Optional[Outcome]:
    header = b""
    while len(header) < 4:
        chunk = os.read(read_fd, 4 - len(header))
        if not chunk:
            return None
        header += chunk
    (size,) = struct.unpack("!I", header)
    body = b""
    while len(body) < size:
        chunk = os.read(read_fd, size - len(body))
        if not chunk:
            return None
        body += chunk
    try:
        return pickle.loads(body)
    except BaseException:  # noqa: BLE001 - a truncated payload is a dead child
        return None


def _describe_death(status: int, timed: bool = True) -> Outcome:
    """Turn a wait status into something worth showing a student.

    ``timed`` is whether this process was holding a clock over the child. With
    no clock there is nothing to time out, so a SIGKILL came from outside: the
    Linux OOM killer, macOS jetsam, or someone typing kill. Reporting that as
    "took longer than the time allowed" is a claim about elapsed time that
    nothing here measured.
    """

    if os.WIFSIGNALED(status):
        number = os.WTERMSIG(status)
        if number == signal.SIGKILL:
            if not timed:
                return Outcome(
                    CRASHED,
                    detail=(
                        "the operating system stopped this process, most often "
                        "for using too much memory"
                    ),
                )
            return Outcome(
                TIMED_OUT,
                detail="stopped after taking longer than the time allowed",
            )
        if number == signal.SIGXCPU:
            return Outcome(
                TIMED_OUT, detail="stopped after using more CPU time than allowed"
            )
        verb = _FATAL.get(number, "was killed by signal {}".format(number))
        return Outcome(
            CRASHED,
            detail="the Python interpreter {} while running this code".format(verb),
        )
    code = os.WEXITSTATUS(status)
    if code == 0:
        return Outcome(CRASHED, detail="exited without returning a result")
    return Outcome(CRASHED, detail="exited with status {}".format(code))


def run_isolated(
    work: Callable[[], Any],
    *,
    timeout_seconds: Optional[int] = DEFAULT_TIMEOUT_SECONDS,
    memory_bytes: Optional[int] = DEFAULT_MEMORY_BYTES,
    scratch: Optional[Path] = None,
) -> Outcome:
    """Run ``work`` in a child process and report what became of it.

    ``work`` must return something picklable. It runs with a scratch directory
    as its working directory, so a module that writes ``db.pkl`` beside itself
    writes into a temporary directory that is deleted afterwards, and with
    stdin at EOF.

    The child is killed by process group, because student code that spawns a
    subprocess would otherwise leave it running after the parent gives up.
    """

    if not hasattr(os, "fork"):
        # No fork means no isolation to offer. Say so rather than pretending.
        return Outcome(
            CRASHED, detail="this platform cannot isolate discovery in a subprocess"
        )

    with tempfile.TemporaryDirectory(prefix="cogworks-discovery-") as temporary:
        workspace = Path(scratch) if scratch else Path(temporary)
        read_fd, write_fd = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(read_fd)
            _child(work, write_fd, workspace, memory_bytes, timeout_seconds)
            raise AssertionError("unreachable")

        os.close(write_fd)
        outcome: Optional[Outcome] = None
        # Windows has neither SIGALRM nor alarm(). Without them the parent
        # cannot interrupt this pipe read, so it waits until the child exits
        # or the child's CPU rlimit fires. The no-fork branch above is what
        # Windows takes; this guard also keeps other limited platforms usable.
        alarm = (
            timeout_seconds is not None
            and hasattr(signal, "SIGALRM")
            and hasattr(signal, "alarm")
        )
        previous = signal.signal(signal.SIGALRM, _on_alarm) if alarm else None
        if alarm:
            signal.alarm(timeout_seconds)
        try:
            outcome = _read_payload(read_fd)
        except _Alarm:
            outcome = None
        except OSError:
            outcome = None
        finally:
            if alarm:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, previous)
            try:
                os.close(read_fd)
            except OSError:
                pass
            # Inside the finally, because Ctrl+C raises KeyboardInterrupt out
            # of the read above and used to leave the child running. The child
            # called setsid, so the terminal's own SIGINT never reaches it:
            # measured, the parent printed "interrupted" and the child was
            # still going a second later, reparented to init. On a scored run
            # that orphan finishes the benchmark and, with --live, reports a
            # completed run minutes after the student stopped the command.
            _terminate(pid)
            status = _reap(pid)[1]

        if outcome is not None:
            return outcome
        return _describe_death(status, timed=alarm)


class _Alarm(Exception):
    pass


def _on_alarm(signum, frame):  # noqa: ARG001 - signal handler shape
    raise _Alarm()


def _terminate(pid: int) -> None:
    """Take down the child and anything it started."""

    for target, sig in ((-pid, signal.SIGKILL), (pid, signal.SIGKILL)):
        try:
            os.kill(target, sig)
        except OSError:
            continue


def _reap(pid: int):
    try:
        return os.waitpid(pid, 0)
    except OSError:
        return pid, 0
