#!/usr/bin/env python3
"""Build the three course venvs the local runner shim expects, and verify them.

The S10 harness (CONTRACTS.md) runs the real controller locally: `stack/
runnerbox.py serve` imports `apps/runner-modal/src/cogworks_runner/modal_app.py`
verbatim through `stack/sandbox_shim.py`, and every sandbox exec expects one of
three venvs under COGBOX_ROOT (sandbox_shim._TRACK_VENV):

    week1-py38   CPython 3.8.20   week 1 stack  (audio-identification)
    week2-py311  CPython 3.11     week 2 stack  (vision-recognition,
                                                vision-clustering)
    week3-py38   CPython 3.8.20   week 3 stack  (language-search)

This script builds them, plus the caches and the controller-interpreter pieces
the deployed images bake (image_bake.py), and --verify measures the pass bar
into receipts/envs.json. Package lists come from the repo ground truth
(cogbench.environment WEEK1/WEEK2/WEEK3_TRACK) at run time, never from a
restated copy, so a track bump cannot drift between environment.py and here.

Interpreter route
    uv (installed from PyPI) manages python-build-standalone interpreters
    downloaded from the astral-sh/python-build-standalone GitHub releases:
    `uv python install 3.8.20 3.11`, then `uv venv --python 3.8.20 ...`. This
    is the same route the deployed images use for week1/week3 ("uv venv
    --python 3.8.20 /opt/cogworks-py38"), it needs no compiler, and it works
    on Debian 13, which ships only Python 3.13. conda-forge was the runner-up
    (acceptable, slower: a full conda solve per env).

Network
    PyPI and GitHub only: python-build-standalone releases, the pinned
    facenet_models git install, the FaceNet checkpoint GitHub release, and the
    rsokl/cog_data GitHub release that carries the Week 3 language artifacts
    (captions, resnet18 descriptors, GloVe). Nothing else is contacted.

Deliberate deviations from the deployed bakes (documented, not silent)
    1. Week 2 CelebA (Hugging Face Hub, flwrlabs/celeba) is NOT baked: the Hub
       is outside the allowed network set. --with-week2-celeba opts in for an
       operator who allows it. The pristine probe and synthetic tiers do not
       read it; the real-data Week 2 tiers cannot materialize without it.
    2. The controller interpreter (the local runnerbox host, python3.13) is
       not the deployed 3.11 control image, and the deployed pins have no
       cp313 wheels (torch 2.2.2, numba 0.58.1, numpy 1.24.4, Pillow 10.2).
       It gets the plugins' import surface only: numpy, Pillow, platformdirs
       (latest cp313 wheels) and the three benchmark distributions installed
       --no-deps --ignore-requires-python, which is what _load_benchmark's
       entry-point lookup needs. --controller-torch adds a cp313 torch for
       Week 2 scoring inside full journeys.
    3. The deployed images apt-install libsndfile1 and ffmpeg. The soundfile
       wheel bundles libsndfile, and the synth/probe paths write WAV, so no
       apt packages are installed here.
    4. cogbench is pip-installed into each venv (--no-deps). The deployed
       sandbox images expose it via PYTHONPATH=/opt/cogbench; the shim's
       PYTHONPATH covers only the runner source, so the probe's
       `import cogbench` resolves from the venv's site-packages instead.

Idempotence and resume
    Each step writes a marker under $COGBOX_ROOT/.build-state with its
    measured outcome; a marker present from an earlier run skips the step.
    A venv whose marker is missing is deleted and rebuilt (uv's wheel cache
    makes that cheap). Everything is logged under $COGBOX_ROOT/logs/.

Usage
    python3 stack/build_envs.py                # build everything missing
    python3 stack/build_envs.py --verify       # build, then measure the pass bar
    python3 stack/build_envs.py --verify-only  # measure only (envs must exist)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
SUITES = HERE.parent
def _repo_root() -> Path:
    """The repo root: COGBOX_REPO override, else git's own answer.

    The suite's position in a checkout is an assumption; git's is a fact.
    """
    override = os.environ.get("COGBOX_REPO")
    if override:
        return Path(override)
    result = subprocess.run(
        ["git", "-C", str(HERE), "rev-parse", "--show-toplevel"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "cannot locate the repo root with git rev-parse --show-toplevel "
            "from %s; set COGBOX_REPO" % HERE
        )
    return Path(result.stdout.strip())


REPO = _repo_root()
RUNNER_SRC = REPO / "apps" / "runner-modal" / "src"
COGBENCH_SRC = REPO / "python" / "cogbench" / "src"
BENCHMARKS = REPO / "benchmarks"
STACK = HERE

#: The shim resolves the same variable with the same default (sandbox_shim.BOX).
COGBOX_ROOT = Path(os.environ.get("COGBOX_ROOT", "/home/user/work/cogbox"))

#: Restated from image_bake.py (the reviewed lock; the script re-verifies
#: every byte it writes, so a typo here fails the build instead of baking
#: a wrong checkpoint).
CHECKPOINT_URL = (
    "https://github.com/timesler/facenet-pytorch/releases/download/"
    "v2.2.9/20180402-114759-vggface2.pt"
)
CHECKPOINT_SHA256 = "281cebca8662831adb987a874bdcb36e73f5b1c6dc5ee5878f305e985625d99b"
CHECKPOINT_BYTES = 111_898_327
TORCH_HOME = Path("/opt/torch")
WEEK2_CACHE_DIR = Path("/opt/cogworks-cache")
WEEK3_DATA_DIR = Path("/opt/cogworks-data/week3")

#: (track, venv name, uv python spec, benchmark source dir). Order is small
#: to large: week 2 pulls the CUDA torch build, so it goes last.
WEEKS: List[Tuple[str, str, str, Path]] = [
    ("week1", "week1-py38", "3.8.20", BENCHMARKS / "week1"),
    ("week3", "week3-py38", "3.8.20", BENCHMARKS / "week3"),
    ("week2", "week2-py311", "3.11", BENCHMARKS / "week2"),
]

BENCHMARK_IDS = {
    "week1": "audio-identification",
    "week2": "vision-recognition",
    "week3": "language-search",
}

LOGS = COGBOX_ROOT / "logs"
STATE = COGBOX_ROOT / ".build-state"
RECEIPTS = SUITES / "receipts"


def log(track: str, line: str) -> None:
    """Append one operator-visible line to the track's log and stdout."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    LOGS.mkdir(parents=True, exist_ok=True)
    with open(LOGS / ("env-%s.log" % track), "a", encoding="utf-8") as handle:
        handle.write("[%s] %s\n" % (stamp, line))
    print("[%s] %s" % (track, line), flush=True)


def run_logged(cmd: List[str], track: str, env: Optional[Dict[str, str]] = None) -> int:
    """Run a command with its output appended to the track's log."""
    LOGS.mkdir(parents=True, exist_ok=True)
    with open(LOGS / ("env-%s.log" % track), "a", encoding="utf-8") as handle:
        handle.write("\n$ %s\n" % " ".join(cmd))
        handle.flush()
        proc = subprocess.run(
            cmd, stdout=handle, stderr=subprocess.STDOUT,
            env=env if env is not None else dict(os.environ),
        )
    return proc.returncode


def marker(name: str) -> Path:
    STATE.mkdir(parents=True, exist_ok=True)
    return STATE / (name + ".done")


def marker_read(name: str) -> Optional[Dict[str, Any]]:
    path = marker(name)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None


def marker_write(name: str, payload: Dict[str, Any]) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    tmp = marker(name).with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    os.replace(tmp, marker(name))


def is_root() -> bool:
    return os.geteuid() == 0


def sudo_install_dir(path: Path, owner: bool) -> int:
    """Create a root-owned parent dir; owner=True chowns it to the caller."""
    cmd = ["sudo", "-n", "install", "-d"]
    if owner:
        cmd += ["-o", str(os.geteuid()), "-g", str(os.getegid())]
    cmd += [str(path)]
    return subprocess.run(cmd).returncode


# ---------------------------------------------------------------------------
# uv bootstrap
# ---------------------------------------------------------------------------

def uv_binary() -> Path:
    candidates = [
        Path(sysconfig.get_path("scripts")) / "uv",
        Path.home() / ".local" / "bin" / "uv",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("uv is not installed where pip said it would be")


def ensure_uv() -> str:
    """Install uv from PyPI (the deployed route's own tooling)."""
    recorded = marker_read("uv")
    if recorded:
        return recorded["version"]
    log("bootstrap", "installing uv from PyPI")
    done: Optional[str] = None
    if run_logged([sys.executable, "-m", "pip", "install", "uv"], "bootstrap") == 0:
        done = "installed"
    elif run_logged([sys.executable, "-m", "pip", "install", "--user", "uv"],
                    "bootstrap") == 0:
        done = "installed-user"
    if done is None:
        raise RuntimeError("pip install uv failed; see logs/env-bootstrap.log")
    version = subprocess.run(
        [str(uv_binary()), "--version"], capture_output=True, text=True
    ).stdout.strip()
    log("bootstrap", "uv ready: " + version)
    marker_write("uv", {"version": version})
    return version


def ensure_interpreters() -> Dict[str, str]:
    """Download the python-build-standalone interpreters via uv."""
    recorded = marker_read("interpreters")
    if recorded:
        return recorded["versions"]
    log("bootstrap", "downloading CPython 3.8.20 and 3.11 (python-build-standalone)")
    cmd = [str(uv_binary()), "python", "install", "3.8.20", "3.11"]
    if run_logged(cmd, "bootstrap") != 0:
        raise RuntimeError("uv python install failed; see logs/env-bootstrap.log")
    listing = subprocess.run(
        [str(uv_binary()), "python", "list"], capture_output=True, text=True
    ).stdout
    versions = {
        "py38": next((ln for ln in listing.splitlines() if "3.8.20" in ln), ""),
        "py311": next((ln for ln in listing.splitlines() if "3.11" in ln), ""),
    }
    log("bootstrap", "interpreters: %s" % json.dumps(versions))
    marker_write("interpreters", {"versions": versions})
    return versions


# ---------------------------------------------------------------------------
# Track package lists, read from the repo's own cogbench.environment
# ---------------------------------------------------------------------------

def track_requirements() -> Dict[str, List[str]]:
    """WEEK{1,2,3}_TRACK requirement strings, straight from cogbench.environment."""
    code = (
        "import json, sys\n"
        "sys.path.insert(0, r'{src}')\n"
        "from cogbench.environment import WEEK1_TRACK, WEEK2_TRACK, WEEK3_TRACK\n"
        "print(json.dumps({{\n"
        "    'week1': [p.requirement for p in WEEK1_TRACK],\n"
        "    'week2': [p.requirement for p in WEEK2_TRACK],\n"
        "    'week3': [p.requirement for p in WEEK3_TRACK],\n"
        "}}))\n"
    ).format(src=COGBENCH_SRC)
    proc = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "cogbench.environment could not be read from %s: %s"
            % (COGBENCH_SRC, proc.stderr.strip()[-2000:])
        )
    return json.loads(proc.stdout.strip().splitlines()[-1])


# ---------------------------------------------------------------------------
# Venv builds
# ---------------------------------------------------------------------------

def build_venv(track: str, venv_name: str, python_spec: str, bench_dir: Path) -> Dict[str, Any]:
    """Create one track venv and install its stack; marker makes it a no-op."""
    recorded = marker_read("venv-" + venv_name)
    if recorded:
        log(track, "%s already built (%.0fs originally); skipping"
            % (venv_name, recorded["seconds"]))
        return recorded
    venv_dir = COGBOX_ROOT / venv_name
    if venv_dir.exists():
        log(track, "%s exists without a pass marker; rebuilding" % venv_name)
        shutil.rmtree(venv_dir)
    started = time.time()
    uv = str(uv_binary())
    steps: List[Tuple[str, List[str]]] = [
        ("venv", [uv, "venv", "--python", python_spec, str(venv_dir)]),
        ("track", [uv, "pip", "install", "--python", str(venv_dir / "bin" / "python")]
         + track_requirements()[track]),
        ("plugins", [uv, "pip", "install", "--python", str(venv_dir / "bin" / "python"),
                     "--no-deps", str(bench_dir), str(REPO / "python" / "cogbench")]),
    ]
    for label, cmd in steps:
        log(track, "%s: %s" % (venv_name, label))
        if run_logged(cmd, track) != 0:
            raise RuntimeError("%s failed at %s; see logs/env-%s.log"
                               % (venv_name, label, track))
    sanity = subprocess.run(
        [str(venv_dir / "bin" / "python"), "-c", "import sys; print(sys.version.split()[0])"],
        capture_output=True, text=True,
    )
    if sanity.returncode != 0:
        raise RuntimeError("%s interpreter failed its sanity check" % venv_name)
    payload = {
        "venv": venv_name,
        "python": sanity.stdout.strip(),
        "pythonSpec": python_spec,
        "seconds": time.time() - started,
        "exit": 0,
    }
    marker_write("venv-" + venv_name, payload)
    log(track, "%s built in %.0fs (python %s)"
        % (venv_name, payload["seconds"], payload["python"]))
    return payload


# ---------------------------------------------------------------------------
# Controller interpreter (the local runnerbox host)
# ---------------------------------------------------------------------------

def build_controller(with_torch: bool) -> Dict[str, Any]:
    recorded = marker_read("controller")
    # A recorded run without torch already satisfies a no-torch request; a
    # --controller-torch request always re-runs to add torch.
    if recorded and (recorded.get("withTorch") or not with_torch):
        log("controller", "controller interpreter already prepared; skipping")
        return recorded
    started = time.time()
    surface = ["numpy", "Pillow", "platformdirs"]
    cmds: List[Tuple[str, List[str]]] = [
        ("surface", [sys.executable, "-m", "pip", "install"] + surface),
        ("plugins", [sys.executable, "-m", "pip", "install", "--no-deps",
                     "--ignore-requires-python",
                     str(BENCHMARKS / "week1"), str(BENCHMARKS / "week2"),
                     str(BENCHMARKS / "week3")]),
    ]
    if with_torch:
        cmds.append(("torch", [sys.executable, "-m", "pip", "install", "torch"]))
    pip_user = False
    for label, cmd in cmds:
        attempt = cmd + (["--user"] if pip_user else [])
        log("controller", "controller: %s" % label)
        code = run_logged(attempt, "controller")
        if code != 0 and not pip_user and not is_root():
            log("controller", "system install refused; retrying with --user")
            pip_user = True
            code = run_logged(attempt + ["--user"], "controller")
        if code != 0:
            raise RuntimeError("controller step %r failed; see logs/env-controller.log"
                               % label)
    check = subprocess.run(
        [sys.executable, "-c",
         "import numpy, PIL, platformdirs;"
         "from cogbench.plugins import load_benchmark;"
         "print('controller-surface-ok')"],
        capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": str(COGBENCH_SRC)},
    )
    if check.returncode != 0:
        raise RuntimeError("controller import surface check failed: %s"
                           % check.stderr[-1500:])
    payload = {"seconds": time.time() - started, "exit": 0, "withTorch": with_torch}
    marker_write("controller", payload)
    log("controller", "controller interpreter prepared in %.0fs" % payload["seconds"])
    return payload


# ---------------------------------------------------------------------------
# Baked caches (what image_bake.py bakes, minus the HF-hosted CelebA)
# ---------------------------------------------------------------------------

def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bake_facenet_checkpoint() -> Dict[str, Any]:
    recorded = marker_read("cache-facenet")
    if recorded:
        log("caches", "FaceNet checkpoint already baked; skipping")
        return recorded
    dest = TORCH_HOME / "checkpoints" / "20180402-114759-vggface2.pt"
    if dest.is_file() and dest.stat().st_size == CHECKPOINT_BYTES \
            and sha256_of(dest) == CHECKPOINT_SHA256:
        log("caches", "FaceNet checkpoint already present and verified")
        marker_write("cache-facenet", {"path": str(dest), "exit": 0})
        return marker_read("cache-facenet")  # type: ignore[return-value]
    log("caches", "downloading FaceNet VGGFace2 checkpoint (%.1f MB)"
        % (CHECKPOINT_BYTES / 1e6))
    with tempfile.TemporaryDirectory() as tmp:
        staging = Path(tmp) / "checkpoint.pt"
        with urllib.request.urlopen(CHECKPOINT_URL, timeout=300) as response, \
                open(staging, "wb") as handle:
            shutil.copyfileobj(response, handle, length=1 << 20)
        size = staging.stat().st_size
        digest = sha256_of(staging)
        if size != CHECKPOINT_BYTES or digest != CHECKPOINT_SHA256:
            raise RuntimeError(
                "FaceNet checkpoint does not match the reviewed lock "
                "(size %d, sha256 %s)" % (size, digest)
            )
        if is_root():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(staging, dest)
        elif run_logged(["sudo", "-n", "install", "-D", "-m", "0644",
                         str(staging), str(dest)], "caches") != 0:
            raise RuntimeError("could not install the checkpoint into %s" % dest)
    log("caches", "FaceNet checkpoint verified and installed at %s" % dest)
    marker_write("cache-facenet", {"path": str(dest), "exit": 0})
    return marker_read("cache-facenet")  # type: ignore[return-value]


def week3_data_env_name() -> str:
    """The env var the week3 benchmark uses to redirect its cache root."""
    proc = subprocess.run(
        [str(COGBOX_ROOT / "week3-py38" / "bin" / "python"), "-c",
         "from language_search_benchmark.datasets import DATA_ENV; print(DATA_ENV)"],
        capture_output=True, text=True,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip().splitlines()[-1]
    source = (BENCHMARKS / "week3" / "language_search_benchmark" / "datasets.py").read_text(
        encoding="utf-8")
    found = re.search(r'^DATA_ENV\s*=\s*"([^"]+)"', source, re.MULTILINE)
    if found:
        return found.group(1)
    raise RuntimeError("could not determine the week3 cache-root env var name")


def bake_week3_data() -> Dict[str, Any]:
    """captions + resnet18 descriptors + GloVe (+ .kv), all from the GitHub
    release the benchmark lists first; verify with the benchmark's own pins."""
    recorded = marker_read("cache-week3")
    if recorded:
        log("caches", "week3 language artifacts already baked; skipping")
        return recorded
    if is_root():
        WEEK3_DATA_DIR.mkdir(parents=True, exist_ok=True)
    elif sudo_install_dir(WEEK3_DATA_DIR, owner=True) != 0:
        raise RuntimeError("could not create %s" % WEEK3_DATA_DIR)
    data_env = week3_data_env_name()
    log("caches", "week3 bake: %s=%s (captions, descriptors, GloVe + .kv)"
        % (data_env, WEEK3_DATA_DIR))
    env = dict(os.environ)
    env[data_env] = str(WEEK3_DATA_DIR)
    code = (
        "from language_search_benchmark.datasets import build_resources\n"
        "resources = build_resources(download=True, build_kv=True)\n"
        "print('week3-artifacts-ok')\n"
    )
    started = time.time()
    if run_logged([str(COGBOX_ROOT / "week3-py38" / "bin" / "python"), "-c", code],
                  "caches", env=env) != 0:
        raise RuntimeError("week3 data bake failed; see logs/env-caches.log")
    payload = {"dir": str(WEEK3_DATA_DIR), "seconds": time.time() - started, "exit": 0}
    marker_write("cache-week3", payload)
    log("caches", "week3 artifacts baked in %.0fs" % payload["seconds"])
    return payload


def bake_week2_celeba() -> Dict[str, Any]:
    """Optional: the HF-hosted CelebA tiers, mirroring image_bake's bake (the
    benchmark's own cache_status re-checksums every image). Off by default."""
    recorded = marker_read("cache-week2-celeba")
    if recorded:
        return recorded
    if is_root():
        WEEK2_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    elif sudo_install_dir(WEEK2_CACHE_DIR, owner=True) != 0:
        raise RuntimeError("could not create %s" % WEEK2_CACHE_DIR)
    env = dict(os.environ)
    env["XDG_CACHE_HOME"] = str(WEEK2_CACHE_DIR)
    code = (
        "from facial_recognition_benchmark.datasets import (\n"
        "    cache_status, load_manifest, materialize_manifest,\n"
        ")\n"
        "for tier in ('test', 'evaluation'):\n"
        "    materialize_manifest(load_manifest(tier))\n"
        "    status = cache_status(load_manifest(tier))\n"
        "    print(tier, status.message)\n"
        "print('week2-celeba-ok')\n"
    )
    started = time.time()
    if run_logged([str(COGBOX_ROOT / "week2-py311" / "bin" / "python"), "-c", code],
                  "caches", env=env) != 0:
        raise RuntimeError("week2 celeba bake failed; see logs/env-caches.log")
    payload = {"dir": str(WEEK2_CACHE_DIR), "seconds": time.time() - started, "exit": 0}
    marker_write("cache-week2-celeba", payload)
    return payload


# ---------------------------------------------------------------------------
# Verification: the four pass-bar measurements
# ---------------------------------------------------------------------------

DRIVER_SANDBOX = r"""
import json, sys
sys.path.insert(0, "@@STACK@@")
import sandbox_shim
sandbox_shim.install_shim()
sys.path.insert(0, "@@RUNNER_SRC@@")
sys.path.insert(0, "@@COGBENCH_SRC@@")
from cogworks_runner import prepared_environment as pe

track, bench_id = sys.argv[1], sys.argv[2]
sandbox_shim.set_track(track)
sandbox = sandbox_shim.Sandbox.create()
try:
    argv0 = pe.student_python(bench_id, sandbox_shim.PY38_VENV)
    proc = sandbox.exec(argv0, "-m", "cogworks_runner.prepared_environment", bench_id)
    code = proc.wait(timeout=600)
    out = proc.stdout.read().decode("utf-8", "replace")
    err = proc.stderr.read().decode("utf-8", "replace")
    result = {"track": track, "benchmarkId": bench_id, "exitCode": code,
              "stderrTail": err[-2000:]}
    if code == 0:
        observation = json.loads(out.strip().splitlines()[-1])
        pe.validate_observation(
            {"benchmark": {"id": bench_id,
                           "sandboxContract": pe.SANDBOX_CONTRACTS[bench_id]}},
            observation,
        )
        result["observation"] = observation
        result["observationValid"] = True
    print("@@RESULT@@" + json.dumps(result))
finally:
    sandbox.terminate()
"""

DRIVER_ADAPTER = r"""
import json, sys
sys.path.insert(0, "@@STACK@@")
import sandbox_shim

track = sys.argv[1]
sandbox_shim.set_track(track)
sandbox = sandbox_shim.Sandbox.create()
try:
    imports = ["numpy"]
    if track == "week2":
        imports.append("torch")
    result = {"track": track, "imports": {}}
    for module in imports:
        child = "import " + module + "; print('" + module + "', " + module + ".__version__)"
        proc = sandbox.exec(
            sandbox_shim.PY38_VENV if track != "week2" else "python",
            "-c", child,
        )
        rc = proc.wait(timeout=600)
        out = proc.stdout.read().decode("utf-8", "replace")
        err = proc.stderr.read().decode("utf-8", "replace")
        result["imports"][module] = {
            "exitCode": rc, "stdoutTail": out.strip()[-200:], "stderrTail": err[-2000:],
        }
    print("@@RESULT@@" + json.dumps(result))
finally:
    sandbox.terminate()
"""

DRIVER_CONTROLLER = r"""
import json, sys
sys.path.insert(0, "@@STACK@@")
import sandbox_shim
sandbox_shim.install_shim()
# modal_app.py builds deployed-image descriptions at import time with a
# fluent chain (apt_install / run_commands / env / pipe / add_local_dir(
# copy=..., ignore=...)) that predates the shim's _Recorder, which only
# knows pip_install/add_local_dir/run. Route every unrecognized builder
# call to a no-op that returns the recorder: nothing is deployed locally,
# so import only needs the chain to compose.
_recorder = sandbox_shim._Recorder

def _recorder_any(self, name):
    def _builder(*args, **kwargs):
        return self
    return _builder

_recorder.__getattr__ = _recorder_any
_recorder.add_local_dir = lambda self, *args, **kwargs: self

sys.path.insert(0, "@@RUNNER_SRC@@")
sys.path.insert(0, "@@COGBENCH_SRC@@")
from cogworks_runner import modal_app
from cogbench.plugins import load_benchmark

result = {}
for bid in ("audio-identification", "vision-recognition",
            "vision-clustering", "language-search"):
    try:
        benchmark = load_benchmark(bid)
        job = {"benchmark": {
            "id": bid,
            "version": getattr(benchmark, "benchmark_version", None),
            "contractVersion": getattr(benchmark, "contract_version", None),
            "pluginVersion": getattr(benchmark, "plugin_version", None),
            "scorerVersion": getattr(benchmark, "scorer_version", None),
        }}
        modal_app._load_benchmark(job)
        result[bid] = {
            "loaded": True,
            "attributes": {key: job["benchmark"][key] for key in
                           ("version", "contractVersion", "pluginVersion", "scorerVersion")},
        }
    except Exception as error:  # recorded, never swallowed
        result[bid] = {"loaded": False, "error": repr(error)[:500]}
print("@@RESULT@@" + json.dumps(result))
"""


def fill_driver(template: str, **paths: str) -> str:
    """Substitute @@PLACEHOLDER@@ tokens; drivers keep literal braces intact."""
    filled = template
    for name, value in paths.items():
        filled = filled.replace("@@%s@@" % name.upper(), value)
    return filled


def run_driver(source: str, args: List[str], use_sudo: bool) -> Dict[str, Any]:
    """Run a verification driver, parse its @@RESULT@@ line, return the dict."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "driver.py"
        path.write_text(source, encoding="utf-8")
        python = sys.executable
        if use_sudo:
            cmd = ["sudo", "-n", "env",
                   "COGBOX_ROOT=%s" % COGBOX_ROOT,
                   "COGBOX_REPO=%s" % REPO,
                   python, str(path)] + args
        else:
            cmd = ["env",
                   "COGBOX_ROOT=%s" % COGBOX_ROOT,
                   "COGBOX_REPO=%s" % REPO,
                   python, str(path)] + args
        proc = subprocess.run(cmd, capture_output=True, text=True)
    combined = proc.stdout + proc.stderr
    for line in reversed(combined.strip().splitlines()):
        if line.startswith("@@RESULT@@"):
            return json.loads(line[len("@@RESULT@@"):])
    raise RuntimeError(
        "verification driver produced no result (rc=%s): %s"
        % (proc.returncode, combined[-2000:])
    )


def verify() -> Dict[str, Any]:
    """Measure the pass bar and write receipts/envs.json. Returns the receipt."""
    receipt: Dict[str, Any] = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": {
            "python": platform.python_version(),
            "machine": platform.machine(),
        },
        "repo": str(REPO),
        "cogboxRoot": str(COGBOX_ROOT),
    }
    # (a) The build: markers recorded each fresh build as it happened.
    builds = {}
    for _, venv_name, _, _ in WEEKS:
        record = marker_read("venv-" + venv_name)
        builds[venv_name] = record if record else {"missing": True}
    receipt["a_fresh_build"] = builds

    # (b) The pristine probe inside a shim sandbox, per week.
    probe_results = {}
    for track, _, _, _ in WEEKS:
        driver = fill_driver(
            DRIVER_SANDBOX, stack=str(STACK), runner_src=str(RUNNER_SRC),
            cogbench_src=str(COGBENCH_SRC),
        )
        result = run_driver(driver, [track, BENCHMARK_IDS[track]], use_sudo=True)
        result["pass"] = result.get("exitCode") == 0 and result.get("observationValid") is True
        probe_results[track] = result
        log("verify", "probe %s: %s" % (track, "PASS" if result["pass"] else "FAIL"))
    receipt["b_prepared_environment_probe"] = probe_results

    # (c) Plugins load in the controller process via modal_app._load_benchmark.
    controller_driver = fill_driver(
        DRIVER_CONTROLLER, stack=str(STACK), runner_src=str(RUNNER_SRC),
        cogbench_src=str(COGBENCH_SRC),
    )
    controller = run_driver(controller_driver, [], use_sudo=False)
    controller["pass"] = all(
        row.get("loaded") for row in controller.values()
        if isinstance(row, dict) and "loaded" in row
    ) and len(controller) == len(WEEKS) + 1  # four ids plus this flag
    log("verify", "controller plugins: %s" % ("PASS" if controller["pass"] else "FAIL"))
    receipt["c_controller_plugins"] = controller

    # (d) A trivial student adapter importing the week stack, in the sandbox.
    adapter_results = {}
    for track, _, _, _ in WEEKS:
        driver = fill_driver(DRIVER_ADAPTER, stack=str(STACK))
        result = run_driver(driver, [track], use_sudo=True)
        result["pass"] = all(
            row.get("exitCode") == 0 for row in result.get("imports", {}).values()
        )
        adapter_results[track] = result
        log("verify", "adapter %s: %s" % (track, "PASS" if result["pass"] else "FAIL"))
    receipt["d_student_adapter"] = adapter_results

    receipt["pass"] = (
        all((row or {}).get("exit") == 0 for row in builds.values())
        and bool(probe_results) and controller["pass"]
        and all(row.get("pass") for row in probe_results.values())
        and all(row.get("pass") for row in adapter_results.values())
    )
    return receipt


# ---------------------------------------------------------------------------

def main() -> int:
    global COGBOX_ROOT, REPO, RUNNER_SRC, COGBENCH_SRC, BENCHMARKS, LOGS, STATE, RECEIPTS
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--verify", action="store_true",
                        help="build (resumably), then measure the pass bar")
    parser.add_argument("--verify-only", action="store_true",
                        help="measure only; envs must already be built")
    parser.add_argument("--skip-caches", action="store_true",
                        help="skip the baked caches (checkpoint, week3 data)")
    parser.add_argument("--with-week2-celeba", action="store_true",
                        help="also bake the HF-hosted CelebA tiers (see header)")
    parser.add_argument("--controller-torch", action="store_true",
                        help="install a cp313 torch into the controller interpreter")
    parser.add_argument("--cogbox-root", default=COGBOX_ROOT)
    parser.add_argument("--repo", default=str(REPO))
    args = parser.parse_args()

    COGBOX_ROOT = Path(args.cogbox_root).resolve()
    REPO = Path(args.repo).resolve()
    RUNNER_SRC = REPO / "apps" / "runner-modal" / "src"
    COGBENCH_SRC = REPO / "python" / "cogbench" / "src"
    BENCHMARKS = REPO / "benchmarks"
    LOGS = COGBOX_ROOT / "logs"
    STATE = COGBOX_ROOT / ".build-state"
    RECEIPTS = REPO / "tools" / "runner-real-journeys" / "receipts"

    started = time.time()
    if not args.verify_only:
        ensure_uv()
        ensure_interpreters()
        for track, venv_name, python_spec, bench_dir in WEEKS:
            build_venv(track, venv_name, python_spec, bench_dir)
        build_controller(with_torch=args.controller_torch)
        if not args.skip_caches:
            bake_facenet_checkpoint()
            bake_week3_data()
        if args.with_week2_celeba:
            bake_week2_celeba()
        log("build", "build complete in %.0fs" % (time.time() - started))

    if args.verify or args.verify_only:
        receipt = verify()
        RECEIPTS.mkdir(parents=True, exist_ok=True)
        path = RECEIPTS / "envs.json"
        path.write_text(json.dumps(receipt, indent=2, sort_keys=True), encoding="utf-8")
        log("verify", "receipts written to %s" % path)
        if not receipt["pass"]:
            log("verify", "PASS BAR NOT MET - see the receipt for the failing rows")
            return 1
        log("verify", "pass bar met: probe (b), controller (c), adapter (d) all green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
