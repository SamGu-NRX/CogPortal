"""One-case diagnostic instrumentation; frozen SDK code is not changed."""
import faulthandler
import functools
import json
import os
import pickle
import signal
import sys
import threading
import time
import traceback
from pathlib import Path

log_dir = Path(sys.argv[1]).resolve()
log_dir.mkdir(exist_ok=True)
fd = os.open(str(log_dir / "events.jsonl"), os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
fault_log = (log_dir / "fatal-stack.txt").open("a")
faulthandler.enable(file=fault_log, all_threads=True)
start = time.monotonic()


def emit(event, **fields):
    row = {"event": event, "pid": os.getpid(), "ppid": os.getppid(), "seconds": round(time.monotonic() - start, 6), **fields}
    os.write(fd, (json.dumps(row, default=str) + "\n").encode())


import cogbench.isolate as isolate

original_fork = os.fork
original_waitpid = os.waitpid
original_kill = os.kill
original_alarm = isolate._on_alarm
original_read = isolate._read_payload
original_loads = pickle.loads


def traced_fork():
    emit("before_fork", python_threads=[t.name for t in threading.enumerate()], stack=traceback.format_stack(limit=12))
    pid = original_fork()
    emit("after_fork", fork_return=pid)
    return pid


def traced_waitpid(pid, options):
    result = original_waitpid(pid, options)
    status = result[1]
    emit("waitpid", target=pid, raw_status=status, signal=os.WTERMSIG(status) if os.WIFSIGNALED(status) else None, exit_code=os.WEXITSTATUS(status) if os.WIFEXITED(status) else None)
    return result


def traced_kill(pid, sig):
    emit("kill_requested", target=pid, signal=int(sig))
    return original_kill(pid, sig)


def traced_alarm(signum, frame):
    emit("parent_alarm_fired", signal=signum)
    return original_alarm(signum, frame)


def traced_read(fd):
    emit("read_payload_start")
    try:
        value = original_read(fd)
        emit("read_payload_return", outcome=None if value is None else value.status)
        return value
    except BaseException as error:
        emit("read_payload_exception", type=type(error).__name__, detail=str(error)[:250])
        raise


def traced_loads(*args, **kwargs):
    try:
        return original_loads(*args, **kwargs)
    except BaseException as error:
        emit("pickle_loads_exception", type=type(error).__name__, detail=str(error)[:250])
        raise


os.fork = traced_fork
os.waitpid = traced_waitpid
os.kill = traced_kill
isolate._on_alarm = traced_alarm
isolate._read_payload = traced_read
pickle.loads = traced_loads
mode = sys.argv[2]
if mode == "self-kill":
    def work():
        emit("intentional_self_sigkill")
        os.kill(os.getpid(), signal.SIGKILL)
    result = isolate.run_isolated(work)
    emit("isolate_result", status=result.status, detail=result.detail)
    print(json.dumps({"status": result.status, "detail": result.detail}))
else:
    import cogbench.plugins as plugins
    original_load = plugins.load_benchmark
    cache = Path(sys.argv[3]).resolve()

    def load_with_cache(name):
        plugin = original_load(name)
        if name.startswith("vision-"):
            plugin.load_cases = functools.partial(plugin.load_cases, cache_root=cache)
            plugin.cache_status = functools.partial(plugin.cache_status, cache_root=cache)
        return plugin

    plugins.load_benchmark = load_with_cache
    from cogbench.cli import main
    emit("cli_start", benchmark=mode)
    code = main(["check", "--benchmark", mode, "--json"])
    emit("cli_return", exit_code=code)
    raise SystemExit(code)
