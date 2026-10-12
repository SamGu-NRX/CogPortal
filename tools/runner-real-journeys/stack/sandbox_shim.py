"""A stand-in for the `modal` module whose Sandbox runs locally.

`modal_app` is imported and run verbatim; what changes is what `modal.Sandbox`
means. Here it means: a private mount/PID/UTS (and optionally network)
namespace with `/tmp` and `/workspace` bound to the sandbox's own directories,
a private cgroup2 enforcing the job's memory, CPU and process ceilings, and a
wall-clock kill at the sandbox timeout. That is the same enforcement surface the
deployed sandboxes get from Modal — memory.max and cpu.max rather than a
cgroup's cousin, no chroot, so /usr and /etc stay the host's the way a
container's own images differ from ours.

The shim lives entirely in this file. Nothing in the controller changes.

Design notes a reviewer needs:

- `filesystem.*` calls happen in the runner process and translate `/tmp` and
  `/workspace` into the sandbox's private directories. Nothing else is
  sandboxed for them; the controller only ever touches those two paths.
- `snapshot_filesystem()` tars the private trees; `Image.from_id(snapshot_id)`
  later extracts that tar into a new sandbox's private trees. The course stacks
  are not inside `/tmp` or `/workspace`, so snapshots stay small and no
  student-writable byte is shared between sandboxes.
- Interpreter selection follows `prepared_environment.student_python`:
  `/opt/cogworks-py38/bin/python` means "the 3.8 venv of this track" and bare
  `python` means "the track's control interpreter", so argv is rewritten per the
  job's track (thread-local, set by the runner server).
- OOM surfaces as an exception containing "memory"/"oom" after `wait()`, which
  `_evaluate`'s catch maps to `memory_limit` — the same exception shape Modal
  kills sandboxes with. A wall-clock timeout instead returns returncode 137 so
  `_timed_out` (elapsed vs budget) classifies it, matching the deployed
  behavior where the sandbox dies at its timeout and the process never exits.
"""

from __future__ import annotations

import io
import json
import os
import shlex
import shutil
import subprocess
import tarfile
import threading
import time
import types
import uuid

BOX = os.environ.get("COGBOX_ROOT", "/home/user/work/cogbox")
HERE = os.path.dirname(os.path.abspath(__file__))


def _repo_root() -> str:
    """The repo root: COGBOX_REPO override, else git's own answer."""
    override = os.environ.get("COGBOX_REPO")
    if override:
        return override
    result = subprocess.run(
        ["git", "-C", HERE, "rev-parse", "--show-toplevel"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise ShimError(
            "cannot locate the repo root with git rev-parse --show-toplevel "
            "from %s; set COGBOX_REPO" % HERE
        )
    return result.stdout.strip()


REPO = _repo_root()

#: PY38_VENV from cogbench.environment — argv[0] the controller uses for
#: week1/week3 tracks, mapped to the track's local venv.
PY38_VENV = "/opt/cogworks-py38/bin/python"

_TRACK_VENV = {
    "week1": "week1-py38",
    "week3": "week3-py38",
    "week2": "week2-py311",
}

_state = threading.local()


def current_track() -> str:
    return getattr(_state, "track", "week2")


def set_track(track: str) -> None:
    _state.track = track


def _track_venv(track: str) -> str:
    return os.path.join(BOX, _TRACK_VENV[track])


class ShimError(RuntimeError):
    pass


class _Dict:
    """modal.Dict: a JSON-file-backed dict with the two methods the
    controller uses, `get` and `put(..., skip_if_exists=True)`."""

    def __init__(self, name: str, create_if_missing: bool = False):
        self.path = os.path.join(BOX, "dicts", name + ".json")
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        if not os.path.exists(self.path):
            with open(self.path, "w") as fh:
                json.dump({}, fh)
        self.lock = threading.Lock()

    def _load(self):
        with open(self.path) as fh:
            return json.load(fh)

    def _save(self, data):
        tmp = self.path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(data, fh)
        os.replace(tmp, self.path)

    def get(self, key, default=None):
        with self.lock:
            return self._load().get(key, default)

    def put(self, key, value, skip_if_exists=False):
        with self.lock:
            data = self._load()
            if skip_if_exists and key in data:
                return None
            data[key] = value
            self._save(data)
            return value

    def __getitem__(self, key):
        return self.get(key)

    def __setitem__(self, key, value):
        self.put(key, value)

    def __contains__(self, key):
        with self.lock:
            return key in self._load()


class _Image:
    """Image handle. `object_id` is the published name or the snapshot id."""

    def __init__(self, object_id: str, kind: str):
        self.object_id = object_id
        self.kind = kind  # "name" | "id"

    def publish(self, name):
        pass


def _debian_slim(**kwargs):
    """modal.Image.debian_slim through the labelled double: record the base."""
    recorder = _Recorder()
    recorder._step("debian_slim", kwargs={str(k): str(v) for k, v in kwargs.items()})
    return recorder


class _Recorder:
    """The labelled modal.Image double: records every builder call so the
    controller verification can receipt the deployed image chain. Surface
    mirrors the calls modal_app.py actually makes (the authoritative
    caller); nothing is executed or deployed locally."""

    def __init__(self, *args, **kwargs):
        self.installs_ = []
        self.steps_ = []

    def _step(self, op, **fields):
        record = {"op": op}
        record.update(fields)
        self.steps_.append(record)
        return self

    def pip_install(self, *specs):
        self.installs_.extend(specs)
        return self._step("pip_install", args=[str(spec) for spec in specs])

    def apt_install(self, *packages, **kwargs):
        return self._step("apt_install", args=[str(p) for p in packages])

    def run_commands(self, *commands, **kwargs):
        return self._step("run_commands", args=[str(c) for c in commands])

    def run_function(self, fn, *args, **kwargs):
        target = getattr(fn, "_fn", fn)
        return self._step(
            "run_function", fn=getattr(target, "__name__", repr(target))
        )

    def env(self, env_dict=None, **kwargs):
        merged = dict(env_dict or {})
        merged.update(kwargs)
        return self._step("env", env={str(k): str(v) for k, v in merged.items()})

    def pipe(self, fn):
        return fn(self)

    def add_local_dir(self, local_path, remote_path, copy=False, ignore=None):
        """(local, remote) order per modal_app.py's real call site."""
        return self._step(
            "add_local_dir",
            local_path=str(local_path),
            remote_path=str(remote_path),
            copy=bool(copy),
            ignore=getattr(ignore, "__name__", None if ignore is None else str(ignore)),
        )

    def run(self, *commands):
        return self._step("run", args=[str(c) for c in commands])

    def installs(self):
        return self.installs_

    def steps(self):
        return [dict(step) for step in self.steps_]


class _SandboxFilesystem:
    def __init__(self, dirs):
        self._dirs = dirs

    def _resolve(self, path: str) -> str:
        if path == "/tmp" or path.startswith("/tmp/"):
            return self._dirs["tmp"] + path[len("/tmp"):]
        if path == "/workspace" or path.startswith("/workspace/"):
            return self._dirs["ws"] + path[len("/workspace"):]
        raise ShimError(
            "local sandbox filesystem API only covers /tmp and /workspace; "
            "asked for {!r}".format(path)
        )

    def write_text(self, text, path):
        target = self._resolve(path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w") as fh:
            fh.write(text)

    def write_bytes(self, data, path):
        target = self._resolve(path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as fh:
            fh.write(data)

    def read_text(self, path):
        with open(self._resolve(path)) as fh:
            return fh.read()

    def listdir(self, path):
        return os.listdir(self._resolve(path))


class _Process:
    """Modal exec handle. Output is captured fully; `wait` enforces the
    sandbox's remaining wall clock and reports OOM as an exception."""

    def __init__(self, popen, sandbox):
        self._popen = popen
        self._sandbox = sandbox
        self.returncode = None
        self.stdout = io.BytesIO()
        self.stderr = io.BytesIO()

    def wait(self, timeout=None):
        deadline = time.time() + (timeout if timeout is not None else 1e18)
        remaining = max(0.0, min(deadline - time.time(), self._sandbox.deadline - time.time()))
        try:
            self.returncode = self._popen.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            self._sandbox.kill()
            self._popen.wait(timeout=30)
            self.returncode = self._popen.returncode or 137
        self.stdout.write(self._popen.stdout.read() or b"")
        self.stderr.write(self._popen.stderr.read() or b"")
        self.stdout.seek(0)
        self.stderr.seek(0)
        if self._sandbox.oom_check():
            raise RuntimeError(
                "local sandbox process was killed: out of memory (oom) — "
                "cgroup memory.events recorded oom_kill"
            )
        return self.returncode


class Sandbox:
    def __init__(self, dirs, limits, deadline):
        self.dirs = dirs
        self.limits = limits
        self.deadline = deadline
        self.filesystem = _SandboxFilesystem(dirs)

    @classmethod
    def create(cls, image=None, app=None, cpu=(0.5, 2.0), memory=(512, 2048),
               timeout=600, block_network=False, outbound_domain_allowlist=None,
               **_kwargs):
        track = current_track()
        sandbox_id = "sb-" + uuid.uuid4().hex[:12]
        root = os.path.join(BOX, "sandboxes", sandbox_id)
        tmp_dir, ws_dir, cg_dir = (os.path.join(root, sub) for sub in ("tmp", "ws", "cg"))
        for d in (tmp_dir, ws_dir, cg_dir):
            os.makedirs(d, exist_ok=True)
        if isinstance(image, _Image) and image.kind == "id":
            snapshot = os.path.join(BOX, "snapshots", image.object_id + ".tar.gz")
            if os.path.exists(snapshot):
                with tarfile.open(snapshot) as tar:
                    tar.extractall(root, filter="tar")
        soft, hard = memory
        lo_cpu, hi_cpu = cpu
        sandbox = cls({"tmp": tmp_dir, "ws": ws_dir}, {
            "track": track, "memoryMax": hard, "memoryHigh": soft,
            "cpuMax": str(int(hi_cpu * 100000)), "blockNetwork": bool(block_network),
        }, time.time() + timeout)
        sandbox._id = sandbox_id
        sandbox._root = root
        sandbox._cg_dir = cg_dir
        sandbox._hosts_path = os.path.join(BOX, "hosts")
        if not os.path.isfile(sandbox._hosts_path):
            raise ShimError(
                "suite-private hosts file missing at %s — run "
                "stack/setup-host.sh first; refusing to start a "
                "sandbox whose processes would resolve the real GitHub"
                % sandbox._hosts_path
            )
        sandbox._timer = threading.Timer(timeout, sandbox._wall_clock_kill)
        sandbox._timer.daemon = True
        sandbox._timer.start()
        return sandbox

    def _setup_script(self, argv, env):
        """The bash run inside the namespaces: private mounts, cgroup, exec.

        Environment is exported in the script because `sudo` strips the
        caller's env before `unshare` runs. The timeout wrapper enforces the
        sandbox's remaining wall clock from inside (the cgroup view is
        namespace-private, so the runner cannot reach in to kill); on exit the
        cgroup's memory.events is copied to the private /tmp, which IS visible
        to the runner, for the OOM check.
        """

        cg = self._cg_dir
        remaining = max(1, int(self.deadline - time.time()))
        exports = "\n".join(
            "export {k}={v}".format(k=k, v=shlex.quote(str(v)))
            for k, v in env.items()
        )
        script = "\n".join([
            "set -eu",
            "hostname " + self._id,
            "mount --make-rprivate /",
            "mount --bind {tmp} /tmp",
            "mount --bind {ws} /workspace",
            "mount --bind {hosts} /etc/hosts",
            "mount -t cgroup2 none {cg}",
            "mkdir {cg}/sb",
            "echo {hi} > {cg}/sb/memory.high",
            "echo {mx} > {cg}/sb/memory.max",
            "echo 512 > {cg}/sb/pids.max",
            "echo {cpu} > {cg}/sb/cpu.max",
            'printf "%s\\n" "$BASHPID" > {cg}/sb/cgroup.procs',
            "{exports}",
            "set +e",
            "timeout --kill-after=10 {remaining} \"$@\"",
            "rc=$?",
            "set -e",
            "cp {cg}/sb/memory.events /tmp/.cog-cg-events 2>/dev/null || true",
            "exit $rc",
        ]).format(
            tmp=self.dirs["tmp"], ws=self.dirs["ws"], cg=cg,
            hosts=self._hosts_path,
            hi=self.limits["memoryHigh"] * 1024 * 1024,
            mx=self.limits["memoryMax"] * 1024 * 1024,
            cpu=self.limits["cpuMax"],
            remaining=remaining,
            exports=exports,
        )
        return script, argv

    def exec(self, *argv, text=True, env=None, **_kwargs):
        argv = list(argv)
        venv = _track_venv(self.limits["track"])
        if argv[0] == PY38_VENV:
            argv[0] = os.path.join(venv, "bin", "python")
        elif argv[0] == "python":
            argv[0] = os.path.join(venv, "bin", "python")
        child_env = dict(os.environ)
        child_env.update({
            "PATH": os.path.join(venv, "bin") + ":/usr/bin:/bin",
            "HOME": "/tmp",
            "TMPDIR": "/tmp",
            "PYTHONDONTWRITEBYTECODE": "1",
            "COGWORKS_RUNNER_TARGET": "",
            # The image bakes the runner package in; the venvs have the course
            # stack and benchmarks, and the runner source rides PYTHONPATH.
            "PYTHONPATH": os.path.join(REPO, "apps", "runner-modal", "src"),
        })
        child_env.pop("COGWORKS_RUNNER_SANDBOX_IMAGE_IDS", None)
        if env:
            child_env.update(env)
        inner, inner_argv = self._setup_script(argv, child_env)
        cmd = ["sudo", "unshare", "--mount", "--uts", "--pid", "--fork", "--mount-proc"]
        if self.limits["blockNetwork"]:
            cmd.append("--net")
        cmd += ["bash", "-c", inner, "_", *inner_argv]
        popen = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self._popen = popen
        return _Process(popen, self)

    def oom_check(self) -> bool:
        try:
            with open(os.path.join(self.dirs["tmp"], ".cog-cg-events")) as fh:
                for line in fh:
                    if line.startswith("oom_kill ") and line.split()[1] != "0":
                        return True
        except OSError:
            pass
        return False

    def _wall_clock_kill(self):
        self.kill()

    def kill(self):
        try:
            subprocess.run(
                ["sudo", "sh", "-c",
                 "echo 1 > " + os.path.join(self._cg_dir, "sb", "cgroup.kill")],
                capture_output=True, timeout=30,
            )
        except Exception:
            pass

    def snapshot_filesystem(self):
        object_id = "snap-" + uuid.uuid4().hex[:16]
        target = os.path.join(BOX, "snapshots", object_id + ".tar.gz")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with tarfile.open(target, "w:gz") as tar:
            for name, arc in (("tmp", "tmp"), ("ws", "ws")):
                tar.add(self.dirs[name], arcname=arc)
        return types.SimpleNamespace(object_id=object_id)

    def terminate(self):
        self.kill()
        if hasattr(self, "_timer") and self._timer:
            self._timer.cancel()
        shutil.rmtree(self._root, ignore_errors=True)


class _App:
    """modal.App: records decorated functions and returns them unchanged,
    so `execute_job.spawn(job)` runs the real function in a thread."""

    def __init__(self, *args, **kwargs):
        self.functions = {}

    def function(self, *args, **kwargs):
        def wrap(fn):
            self.functions[fn.__name__] = fn
            handle = _FunctionHandle(fn, kwargs)
            return handle
        return wrap

    def cls(self, *args, **kwargs):
        def wrap(cls):
            return cls
        return wrap

    def local_entrypoint(self, *args, **kwargs):
        def wrap(fn):
            return fn
        return wrap

    @classmethod
    def lookup(cls, name, create_if_missing=False):
        return cls(name)

    def spawn(self, *args, **kwargs):
        raise ShimError("app.spawn is not used by the controller")


class _FunctionHandle:
    def __init__(self, fn, kwargs):
        self._fn = fn
        self._kwargs = kwargs

    def __call__(self, *args, **kwargs):
        return self._fn(*args, **kwargs)

    def spawn(self, *args, **kwargs):
        thread = threading.Thread(target=self._run, args=args, kwargs=kwargs, daemon=True)
        thread.start()
        return types.SimpleNamespace(get=lambda: None, object_id="fn-" + uuid.uuid4().hex[:8])

    def _run(self, *args, **kwargs):
        set_track(_track_from_args(args))
        try:
            self._fn(*args, **kwargs)
        except Exception:
            import traceback
            traceback.print_exc()


def _track_from_args(args):
    """execute_job(job) — the benchmark id picks the track, as
    cogbench.environment.track_for does for image selection."""
    try:
        job = args[0]
        benchmark_id = job["benchmark"]["id"]
        mapping = {"audio-identification": "week1", "vision-recognition": "week2",
                   "vision-clustering": "week2", "language-search": "week3"}
        return mapping.get(benchmark_id, "week2")
    except Exception:
        return "week2"


def _enable_output():
    import contextlib
    return contextlib.nullcontext()


class _Runner(types.ModuleType):
    pass


def install_shim():
    """Put the shim in sys.modules as `modal` (and `fastapi`)."""
    modal = types.ModuleType("modal")
    modal.Image = types.SimpleNamespace(
        debian_slim=_debian_slim,
        from_name=lambda name, *a, **k: _Image(name, "name"),
        from_id=lambda image_id: _Image(image_id, "id"),
    )
    modal.App = _App
    modal.Secret = types.SimpleNamespace(from_name=lambda *a, **k: object())
    modal.Volume = types.SimpleNamespace(from_name=lambda *a, **k: object())
    modal.Dict = types.SimpleNamespace(from_name=lambda *a, create_if_missing=False: _Dict(a[0] if a else "jobs"))
    modal.Sandbox = Sandbox
    modal.Retries = lambda **kwargs: types.SimpleNamespace(**kwargs)
    modal.is_local = lambda: True
    modal.enter = lambda *a, **k: (lambda f: f)
    modal.method = lambda *a, **k: (lambda f: f)
    modal.asgi_app = lambda *a, **k: (lambda f: f)
    modal.fastapi_endpoint = lambda *a, **k: (lambda f: f)
    modal.enable_output = _enable_output
    modal.runner = types.ModuleType("modal.runner")
    modal.runner.deploy_app = lambda application: None
    import sys
    sys.modules["modal"] = modal
    sys.modules["modal.runner"] = modal.runner

    fastapi = types.ModuleType("fastapi")

    class Request:
        def __init__(self, scope=None, receive=None, body=b"", headers=None):
            self._body = body
            self.headers = headers or {}

        async def body(self):
            return self._body

    class Response:
        def __init__(self, content=None, status_code=200, headers=None, media_type=None):
            self.content = content
            self.status_code = status_code
            self.headers = headers or {}

    fastapi.Request = Request
    fastapi.Response = Response
    fastapi.FastAPI = lambda *a, **k: types.SimpleNamespace()
    sys.modules["fastapi"] = fastapi
    return modal
