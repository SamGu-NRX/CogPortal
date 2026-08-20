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
import resource
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
    signal.SIGABRT: "aborted",
    signal.SIGSEGV: "segfaulted",
    signal.SIGBUS: "hit a bus error",
    signal.SIGILL: "executed an illegal instruction",
    signal.SIGFPE: "hit a floating point error",
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


def _apply_limits(memory_bytes: int, timeout_seconds: int) -> None:
    """Bound the child before it runs a line of student code."""

    try:
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


def _describe_death(status: int) -> Outcome:
    """Turn a wait status into something worth showing a student."""

    if os.WIFSIGNALED(status):
        number = os.WTERMSIG(status)
        if number == signal.SIGKILL:
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
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    memory_bytes: int = DEFAULT_MEMORY_BYTES,
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
        previous = signal.signal(signal.SIGALRM, _on_alarm)
        signal.alarm(timeout_seconds)
        try:
            outcome = _read_payload(read_fd)
        except _Alarm:
            outcome = None
        except OSError:
            outcome = None
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
            try:
                os.close(read_fd)
            except OSError:
                pass

        _terminate(pid)
        _, status = _reap(pid)

        if outcome is not None:
            return outcome
        return _describe_death(status)


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
