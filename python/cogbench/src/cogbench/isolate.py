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
import errno
import json
import math
try:
    import resource
except ImportError:  # Windows has no rlimits; `run_isolated` refuses there
    resource = None  # type: ignore[assignment]
import select
import signal
import struct
import sys
import tempfile
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Optional

__all__ = [
    "Outcome",
    "CRASHED",
    "TIMED_OUT",
    "RAISED",
    "COMPLETED",
    "run_isolated",
    "run_operation",
    "ensure_pinned_hash_seed",
    "hash_seed_in_effect",
]

COMPLETED = "completed"
RAISED = "raised"
CRASHED = "crashed"
TIMED_OUT = "timed_out"

#: Whole-of-discovery wall clock. Generous: the slowest legitimate import in
#: the corpus builds a FaceNet model, and a week 1 chain check enrolls two
#: synthetic songs. A repository that cannot be read inside this is reported
#: as slow, which is a true statement about it.
DEFAULT_TIMEOUT_SECONDS = 300

#: Bound only the wait after publication or pipe closure, never student work.
#: `_child` closes the descriptor and calls `os._exit` with the bulk flush
#: already behind it, so a child on its way out is gone in microseconds and a
#: whole second is generous. A child still alive after that is lingering, which
#: is the shape of the forged-payload case, so it loses its payload. This is a
#: cleanup policy, not a measured maximum for interpreter teardown.
UNBOUNDED_REAP_SECONDS = 1.0

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

    ``status`` is one of the four status constants. ``value`` is set only for
    ``COMPLETED``. ``detail`` is a sentence naming the cause, written for a
    student rather than for a log.
    """

    status: str
    value: Any = None
    detail: str = ""
    signal: Optional[int] = None
    alarm_fired: bool = False
    timeout_seconds: Optional[int] = None
    memory_bytes: Optional[int] = None
    read_reason: Optional[str] = None

    def diagnostics(self) -> dict:
        """Configured budgets and observed outcome, not proof rlimits took."""
        # Exec pays plugin-import CPU inside RLIMIT_CPU; fork inherited those
        # imports for free. Heavy imports leave less CPU for a native fit.
        # Check also loads the plugin in the parent for benchmarkLoadable.
        return {
            "status": self.status, "detail": self.detail, "signal": self.signal,
            "alarmFired": self.alarm_fired, "readReason": self.read_reason,
            "limits": {"wallSeconds": self.timeout_seconds,
                       "cpuSeconds": self.timeout_seconds,
                       "cpuHardSeconds": None if self.timeout_seconds is None else self.timeout_seconds + 5,
                       "memoryBytes": self.memory_bytes},
        }

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
    if os.name == "nt":
        # Windows has no exec: `os.execve` starts a second process and ends
        # this one, so the caller sees an exit code from a process that did
        # no work. Measured in CI, where `cogworks --version` printed nothing
        # and exited 1 the first time the job got far enough to run it.
        # Staying unpinned is a state this function already allows, and a
        # hosted run is unaffected because its image sets the variable for
        # every process in the sandbox.
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
    # A caller may already have a stricter soft limit. Discovery must never
    # raise it just because its own configured budget is more generous.
    def install(kind, requested):
        resource.setrlimit(kind, requested)
        # Startup hooks can replace setrlimit with a silent no-op. Only a
        # successful call is checked; refused limits retain the weaker mode.
        try:
            observed = resource.getrlimit(kind)
        except (ValueError, OSError) as error:
            raise RuntimeError("could not verify resource limit {}".format(kind)) from error
        if observed != requested:
            raise RuntimeError(
                "resource limit {} was not installed: requested {}, observed {}".format(
                    kind, requested, observed))

    def lower(kind, soft, hard):
        old_soft, old_hard = resource.getrlimit(kind)
        if old_soft != resource.RLIM_INFINITY:
            soft = min(soft, old_soft)
        if old_hard != resource.RLIM_INFINITY:
            hard = min(hard, old_hard)
        install(kind, (min(soft, hard), hard))

    try:
        if memory_bytes is not None:
            lower(resource.RLIMIT_AS, memory_bytes, memory_bytes)
    except (ValueError, OSError):
        # Some platforms refuse an address-space limit. The wall clock and the
        # process boundary still hold, so this is a weaker child, not an
        # unsafe one.
        pass
    try:
        install(resource.RLIMIT_CORE, (0, 0))
    except (ValueError, OSError):
        pass
    # A CPU limit catches a spin that the wall clock would also catch, but it
    # arrives as a signal the parent can name precisely.
    try:
        if timeout_seconds is not None:
            lower(resource.RLIMIT_CPU, timeout_seconds, timeout_seconds + 5)
    except (ValueError, OSError):
        pass


def _child(
    work: Callable[[], Any],
    write_fd: int,
    scratch: Path,
    memory_bytes: Optional[int],
    timeout_seconds: Optional[int],
) -> None:
    """Everything inside the process boundary. Never returns; always ``_exit``.

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
        # Student code that reads from a terminal gets EOF rather than a hang.
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        if devnull != 0:
            os.close(devnull)
        try:
            _apply_limits(memory_bytes, timeout_seconds)
            value = work()
            _json_value(value)
            payload = json.dumps(
                {"status": COMPLETED, "detail": "", "value": value}, allow_nan=False
            ).encode("utf-8")
        except BaseException as error:  # noqa: BLE001 - the child owns every failure
            payload = json.dumps({
                "status": RAISED,
                "detail": "{}: {}".format(type(error).__name__, str(error)[:300]),
            }).encode("utf-8")
        # Publish completion only after serialization and stream flushing.
        # Serialization may itself print. Fatal signals and asynchronous writers can
        # still lose output; a completed payload no longer races this flush.
        _flush_streams()
        # A signal mid-write can shorten a blocking pipe write. Send the
        # remainder so completed work is not reported as a crash when the
        # reader rejects a truncated payload.
        payload = struct.pack("!I", len(payload)) + payload
        while payload:
            payload = payload[os.write(write_fd, payload):]
    except BaseException:  # noqa: BLE001 - a broken pipe must not raise here
        exit_code = 70
    finally:
        try:
            os.close(write_fd)
        except OSError:
            pass
        # The pre-publication flush orders output before completion. This
        # final flush preserves output when formatting an error or writing the
        # pipe fails, including diagnostics produced after the first flush.
        _flush_streams()
        os._exit(exit_code)


def _flush_streams() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except BaseException:
            pass  # A broken student stream must not prevent reporting.


class _PayloadError(Exception):
    pass


def _read_payload(read_fd: int, exited: Optional[Callable[[], bool]] = None) -> Outcome:
    child_exited = False

    def read(size):
        nonlocal child_exited
        if exited is not None:
            # Polling avoids a busy wait, without imposing a work deadline.
            # Once exit is observed, even this polling delay is unnecessary.
            while not select.select([read_fd], [], [], 0 if child_exited else 0.05)[0]:
                # There is no deadline while the direct child works. After
                # its exit, publication is over: drain bytes already present,
                # but do not wait for EOF withheld by an inherited writer.
                child_exited = child_exited or exited()
                if child_exited:
                    if not select.select([read_fd], [], [], 0)[0]:
                        raise _PayloadError("child_exited_before_payload")
                    break
        return os.read(read_fd, size)

    header = b""
    while len(header) < 4:
        chunk = read(4 - len(header))
        if not chunk:
            raise _PayloadError("eof" if not header else "truncated_header")
        header += chunk
    (size,) = struct.unpack("!I", header)
    body = b""
    while len(body) < size:
        chunk = read(size - len(body))
        if not chunk:
            raise _PayloadError("truncated_body")
        body += chunk
    # JSON stops child bytes becoming code in the parent, and this envelope
    # stops the child claiming a death the parent did not observe. It cannot
    # stop a child lying about its result; the parent re-verifies elsewhere.
    try:
        record = json.loads(body.decode("utf-8"), object_pairs_hook=_unique_keys,
                            parse_constant=_invalid_constant)
        if type(record) is not dict or type(record.get("detail")) is not str:
            raise ValueError("expected an outcome object with string detail")
        status = record.get("status")
        keys = {"status", "detail", "value"} if status == COMPLETED else {"status", "detail"}
        if status not in (COMPLETED, RAISED) or set(record) != keys:
            raise ValueError("unexpected outcome status or fields")
        if status == COMPLETED:
            _json_value(record["value"])
        return Outcome(status, value=record.get("value"), detail=record["detail"])
    except _Alarm:
        raise
    except BaseException as error:
        raise _PayloadError("invalid_outcome") from error


def _json_value(value) -> None:
    """Reject Python objects and scalar subclasses instead of coercing them.

    json.dumps accepts numpy.float64 as a float on some versions. Requiring
    built-in scalar types makes that refusal independent of numpy's version.
    Tuples use json.dumps' normal conversion to JSON arrays.
    """
    kind = type(value)
    if value is None or kind in (str, bool, int):
        return
    if kind is float:
        if not math.isfinite(value):
            raise ValueError("non-finite floats are not JSON values")
        return
    if kind in (list, tuple):
        for item in value:
            _json_value(item)
        return
    if kind is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise TypeError("JSON object keys must be strings")
            _json_value(item)
        return
    raise TypeError("Object of type {} is not JSON serializable".format(kind.__name__))


def _unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key: {}".format(key))
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("not a JSON number: {}".format(value))


def _describe_death(status: Optional[int], timed: bool = False) -> Outcome:
    """Describe observed death only; cleanup's signal is not evidence."""

    number = os.WTERMSIG(status) if status is not None and os.WIFSIGNALED(status) else None
    if timed:
        return Outcome(TIMED_OUT, detail="stopped because the wall-clock time limit expired",
                       signal=number, alarm_fired=True)
    if number == getattr(signal, "SIGXCPU", None) and number is not None:
        return Outcome(TIMED_OUT, detail="stopped by SIGXCPU, the CPU-time limit signal",
                       signal=number)
    if number == signal.SIGKILL:
        return Outcome(CRASHED, detail="stopped by SIGKILL; the cause is unknown", signal=number)
    if number is not None:
        verb = _FATAL.get(number, "was killed by signal {}".format(number))
        return Outcome(CRASHED, detail="the Python interpreter {} while running this code".format(verb),
                       signal=number)
    if status is None:
        return Outcome(CRASHED, detail="the result pipe failed before a process exit was observed")
    code = os.WEXITSTATUS(status)
    return Outcome(CRASHED, detail="exited without returning a result" if code == 0
                   else "exited with status {}".format(code))


def _isolation_backend():
    """Select execution policy once; tests can exercise either POSIX backend."""
    if not hasattr(os, "fork"):
        return None
    return run_operation if sys.platform == "darwin" else run_isolated


def run_isolated(
    work: Callable[[], Any],
    *,
    timeout_seconds: Optional[int] = DEFAULT_TIMEOUT_SECONDS,
    memory_bytes: Optional[int] = DEFAULT_MEMORY_BYTES,
    scratch: Optional[Path] = None,
) -> Outcome:
    """Run ``work`` in a child process and report what became of it.

    ``work`` must return JSON-serializable data, not live Python objects. It runs with a scratch directory
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
        # Empty inherited buffers so the child's final flush cannot print
        # the parent's pending output a second time.
        sys.stdout.flush()
        sys.stderr.flush()
        pid = os.fork()
        if pid == 0:
            os.close(read_fd)
            _child(work, write_fd, workspace, memory_bytes, timeout_seconds)
            raise AssertionError("unreachable")

        os.close(write_fd)
        return _collect(pid, read_fd, timeout_seconds, memory_bytes)


def run_operation(
    operation: str, arguments: dict, *,
    timeout_seconds: Optional[int] = DEFAULT_TIMEOUT_SECONDS,
    memory_bytes: Optional[int] = DEFAULT_MEMORY_BYTES,
    scratch: Optional[Path] = None,
) -> Outcome:
    """Reconstruct one SDK operation after exec, without carrying live objects.

    macOS high-level APIs cannot safely run in a raw fork of the CLI. Popen
    uses no Python preexec callback; limits are installed in the interpreter
    before importing the operation owner or any student module.
    """
    import json
    import subprocess

    if operation not in ("survey",):
        raise ValueError("unknown isolated SDK operation: {!r}".format(operation))
    with tempfile.TemporaryDirectory(prefix="cogworks-discovery-") as temporary:
        workspace = Path(scratch).resolve() if scratch else Path(temporary)
        request = Path(temporary) / "operation.json"
        request.write_text(json.dumps({"operation": operation, "arguments": arguments,
                                      "memory": memory_bytes, "timeout": timeout_seconds,
                                      "workspace": str(workspace)}),
                           encoding="utf-8")
        read_fd, write_fd = os.pipe()
        environment = dict(os.environ, PYTHONHASHSEED="0")
        # Site processing precedes our bootstrap. Keep student paths out of
        # its search path so their sitecustomize cannot run before limits.
        # Environment-owned .pth files remain trusted setup; disabling site
        # would also disable the editable installs used by the course.
        repository = Path(arguments["repository"]).resolve()
        startup_paths = [str(Path(__file__).resolve().parent.parent)]
        for entry in sys.path:
            if not entry:
                continue
            path = Path(entry).resolve()
            if path != repository and repository not in path.parents:
                startup_paths.append(str(path))
        environment["PYTHONPATH"] = os.pathsep.join(startup_paths)
        _flush_streams()
        try:
            process = subprocess.Popen(
                [sys.executable, "-c", "from cogbench.isolate import _operation_child; _operation_child()",
                 str(request), str(write_fd)],
                # Bootstrap outside the repository: a student json.py must
                # not be imported before the child installs its limits.
                cwd=temporary, env=environment, stdin=subprocess.DEVNULL,
                pass_fds=(write_fd,), start_new_session=True,
            )
        except BaseException:
            os.close(read_fd)
            raise
        finally:
            os.close(write_fd)
        try:
            return _collect(process.pid, read_fd, timeout_seconds, memory_bytes)
        finally:
            # _collect owns waitpid and process-group cleanup, including SIGINT.
            process.wait()


def _operation_child() -> None:
    import json

    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    operation = request["operation"]
    arguments = request["arguments"]

    def work():
        # _child has installed limits before invoking this function. Student
        # imports can now use their root without exposing it to site startup.
        sys.path.insert(0, str(Path(arguments["repository"]).resolve()))
        if operation == "survey":
            from .discover import _survey_work
            return _survey_work(Path(arguments["repository"]), arguments["declared_root"],
                                arguments["hints"], Path(arguments["trail"]))
        raise ValueError("unknown isolated SDK operation: {!r}".format(operation))

    _child(work, int(sys.argv[2]), Path(request["workspace"]),
           request["memory"], request["timeout"])


def _collect(pid, read_fd, timeout_seconds, memory_bytes) -> Outcome:
    outcome = None
    fired = False
    reason = None
    status = None
    reaped = False
    armed = (timeout_seconds is not None and hasattr(signal, "SIGALRM")
             and hasattr(signal, "alarm"))
    previous = None

    def exited():
        nonlocal status, reaped
        if not reaped:
            while True:
                try:
                    done, observed = os.waitpid(pid, os.WNOHANG)
                    break
                except InterruptedError:
                    continue
            if done:
                status, reaped = observed, True
        return reaped

    try:
        if armed:
            previous = signal.signal(signal.SIGALRM, _on_alarm)
            signal.alarm(timeout_seconds)
        try:
            try:
                outcome = _read_payload(read_fd, exited)
            except _PayloadError as error:
                reason = str(error)
            except OSError as error:
                reason = "read_error: {}".format(error)
            if not reaped and (outcome is not None or reason in ("eof", "truncated_header", "truncated_body")):
                # EOF can precede a waitable exit on Linux. Reap before any
                # cleanup signal so a self/external SIGKILL keeps its identity.
                # Keep the existing deadline armed: code holding the descriptor
                # can close it and remain alive, despite _child's normal
                # ordering. The alarm can therefore land inside this wait, and
                # that is a real timeout rather than a lost status, so it falls
                # through to the cleanup path with `fired` set.
                try:
                    observed = (_reap_exact(pid) if armed
                                else _reap_bounded(pid, UNBOUNDED_REAP_SECONDS))
                except _Alarm:
                    fired, observed = True, None
                if observed is not None:
                    status, reaped = observed, True
        except _Alarm:
            fired, outcome = True, None
            reason = reason or "alarm"
    finally:
        try:
            if armed:
                signal.alarm(0)
                # None denotes a handler installed outside Python. It cannot
                # be passed to signal.signal, but our timer must still stop.
                if previous is not None:
                    signal.signal(signal.SIGALRM, previous)
            try:
                os.close(read_fd)
            except OSError:
                pass
            # Capture an already-dead child's status before cleanup. If the
            # pipe closed while it was alive, cleanup's SIGKILL proves no cause.
            if not reaped:
                try:
                    done, observed = os.waitpid(pid, os.WNOHANG)
                except OSError:
                    done = 0
                if done:
                    reaped, status = True, observed
        finally:
            _terminate(pid)
            if not reaped:
                final_status = _reap(pid)[1]
                # A different signal or ordinary exit could arrive between
                # WNOHANG and cleanup. Those cannot have come from our SIGKILL.
                if final_status is not None and not (os.WIFSIGNALED(final_status)
                        and os.WTERMSIG(final_status) == signal.SIGKILL):
                    status = final_status
    # A result is only trustworthy if the child exited on its own. The result
    # descriptor is reachable from the child, so code running there can write a
    # correctly framed "completed" envelope, close it, and hang: the parent
    # would accept that, kill the process at its deadline, and report the
    # forged success. For `check` the forged value can have the right shape, so
    # `--update-setup` would record setup evidence for a run we killed. The
    # payload is a claim; the exit is the evidence for it.
    if outcome is not None and (fired or not reaped):
        outcome = None
        reason = reason or ("alarm" if fired else "killed_before_exit")
    if outcome is None:
        outcome = _describe_death(status, timed=fired)
        if reason:
            outcome = replace(outcome, detail=outcome.detail + " (result pipe: {})".format(reason))
        if outcome.signal == getattr(signal, "SIGXCPU", None) and outcome.signal is not None:
            limits = (
                "; no CPU limit was configured by this operation"
                if timeout_seconds is None else
                "; configured CPU limit: {} seconds soft, {} seconds hard".format(
                    timeout_seconds, timeout_seconds + 5)
            )
            outcome = replace(outcome, detail=outcome.detail + limits)
    return replace(outcome, alarm_fired=fired, timeout_seconds=timeout_seconds,
                   memory_bytes=memory_bytes, read_reason=reason)


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
    return pid, _reap_exact(pid)


def _reap_bounded(pid: int, seconds: float):
    """Wait up to `seconds` for `pid`, without a deadline to interrupt us.

    `test` and `run` impose no wall-clock budget, so nothing arms an alarm and
    a blocking wait here is unbounded. Student code that closes the result
    descriptor and then lingers, or leaves a descendant holding it, hung the
    command with no way out but Ctrl+C.

    Normal serialization and output flushing precede publication. A child
    that remains alive beyond this cleanup budget loses its payload, even if
    the OS delayed its exit; no claim about its progress can be verified.
    """

    deadline = time.monotonic() + seconds
    while True:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except InterruptedError:
            continue
        except OSError:
            return None
        if done:
            return status
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.005)


def _reap_exact(pid: int):
    """Return a real wait status, or None when no status can be obtained.

    EINTR interrupts the wait, not the child. Retry that same blocking wait
    before cleanup so an interrupted reap cannot erase a self-SIGKILL.
    This is syscall interruption handling, not polling or a grace period.
    """
    while True:
        try:
            return os.waitpid(pid, 0)[1]
        except OSError as error:
            if error.errno != errno.EINTR:
                return None
