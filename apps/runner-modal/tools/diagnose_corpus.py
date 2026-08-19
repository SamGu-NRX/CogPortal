"""Find where the Week 1 corpus render diverges between machines.

The manifest pins a sha256 per song, and the sandbox re-renders and checks it
before any student code runs. That check fired on Modal while the same
manifest verified locally, so one of the two renders is not what the manifest
recorded. This narrows it from "the hash differs" to the first operation whose
output differs, by running the same ladder of primitives in both places.

    python apps/runner-modal/tools/diagnose_corpus.py

It prints the local column and the sandbox column side by side. Any row where
they disagree is a determinism break in that primitive under that build.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(REPO / "benchmarks" / "week1"))

import modal  # noqa: E402

from cogworks_runner.modal_app import WEEK1_SANDBOX_IMAGE, app  # noqa: E402

PROBE = r'''
import hashlib, json, sys
import numpy as np

out = {"python": sys.version.split()[0], "numpy": np.__version__}


def h(a):
    a = np.ascontiguousarray(a)
    return hashlib.sha256(a.tobytes()).hexdigest()[:16]


# Primitive ladder, cheapest first. Each row isolates one operation that the
# renderer depends on, so the first disagreement names the cause.
rng = np.random.default_rng(12345)
out["rng_normal"] = h(rng.standard_normal(1024))
rng2 = np.random.default_rng(12345)
out["rng_integers"] = h(rng2.integers(0, 128, size=1024))
rng3 = np.random.default_rng(12345)
out["rng_random"] = h(rng3.random(1024))

t = np.arange(4096, dtype=np.float64) / 44100.0
out["sin_f64"] = h(np.sin(2.0 * np.pi * 440.0 * t))
out["pow_f64"] = h(np.power(2.0, (np.arange(128, dtype=np.float64) - 69.0) / 12.0))
out["exp_f64"] = h(np.exp(-np.arange(4096, dtype=np.float64) / 1000.0))
out["cumsum"] = h(np.cumsum(np.sin(t)))
out["f32_cast"] = h(np.sin(2.0 * np.pi * 440.0 * t).astype(np.float32))

# The real thing.
try:
    from audio_identification_benchmark import synth
    for name, seed in (("song-00", 838647895), ("song-20", 1827023219)):
        sig = synth.render_song(synth.SongSpec(name, seed, 45.0), 44100)
        out["render_" + name] = synth.sha256_signal(sig)[:16]
        out["sum_" + name] = float(np.sum(sig.astype(np.float64)))
    # Bisect song-20 by stage. Each row hashes one renderer component with
    # the same parameters that song rolls, so the first mismatch names the
    # stage rather than the song.
    from audio_identification_benchmark import exactmath as em
    seed = 1827023219
    r = np.random.default_rng(seed)
    tempo = float(r.integers(84, 156)); root = int(r.integers(45, 60))
    scale_major = r.random() < 0.5
    pc = int(r.integers(5, 9)); roll = float(r.uniform(0.9, 2.1))
    g = em.power(np.arange(1, pc + 1, dtype=np.float64), -roll)
    g = g * r.uniform(0.6, 1.4, size=pc); g = g / np.sum(g)
    att = float(r.uniform(0.001, 0.006)); dec = float(r.uniform(0.35, 0.85))
    out["s20_params"] = repr((tempo, root, scale_major, pc, round(roll, 12)))
    out["s20_gains"] = h(g)
    # Split the gains line into its three steps with a fresh RNG each time.
    q = np.random.default_rng(seed)
    _ = (q.integers(84, 156), q.integers(45, 60), q.random(),
         q.integers(5, 9), q.uniform(0.9, 2.1))
    step_pow = em.power(np.arange(1, 7, dtype=np.float64), -1.9322780902)
    out["g_pow"] = h(step_pow)
    out["g_pow_repr"] = repr([float(v) for v in step_pow[:3]])
    jitter = q.uniform(0.6, 1.4, size=6)
    out["g_jitter"] = h(jitter)
    out["g_mul"] = h(step_pow * jitter)
    out["g_sum"] = repr(float(np.sum(step_pow * jitter)))
    out["g_div"] = h((step_pow * jitter) / np.sum(step_pow * jitter))
    out["g_uniform_raw"] = h(np.random.default_rng(11).uniform(0.6, 1.4, size=64))
    out["g_arange_pow"] = h(np.arange(1, 7, dtype=np.float64) ** -1.9322780902)
    out["s20_note"] = h(synth._note(220.0, 0.5, 44100, g, att, 0.3))
    out["s20_midi"] = h(synth._midi_to_hz(np.arange(30, 90, dtype=np.float64)))
    for kind in ("kick", "snare", "hat"):
        pr = np.random.default_rng(999)
        out["s20_hit_" + kind] = h(synth._percussive_hit(kind, 44100, pr))
    pr = np.random.default_rng(4242)
    out["s20_smooth48"] = h(synth._smooth(pr.standard_normal(8000), 48))
    out["s20_smooth9"] = h(synth._smooth(pr.standard_normal(8000), 9))
    out["s20_smooth6"] = h(synth._smooth(pr.standard_normal(8000), 6))
    out["s20_smooth1"] = h(synth._smooth(pr.standard_normal(8000), 1))
    out["em_sin"] = h(em.sin(np.linspace(-1e5, 1e5, 4096)))
    out["em_box"] = h(em.box_average(np.random.default_rng(3).standard_normal(4000), 48))
    out["em_interp"] = h(em.interp(np.arange(0, 300, 1.7),
                                   np.arange(400, dtype=np.float64),
                                   np.random.default_rng(3).standard_normal(400)))
except Exception as error:
    out["render_song"] = "ERROR: {}: {}".format(type(error).__name__, error)

print("PROBE_JSON " + json.dumps(out))
'''


def main() -> int:
    local: dict = {}
    exec_globals: dict = {}
    import io
    import contextlib

    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        exec(compile(PROBE, "<probe>", "exec"), exec_globals)
    for line in buffer.getvalue().splitlines():
        if line.startswith("PROBE_JSON "):
            local = json.loads(line[len("PROBE_JSON "):])

    with modal.enable_output(), modal.runner.run_app(app):
        sandbox = modal.Sandbox.create(
            image=modal.Image.from_name(WEEK1_SANDBOX_IMAGE),
            app=app,
            cpu=(0.5, 1),
            memory=(512, 4096),
            timeout=600,
        )
        try:
            sandbox.filesystem.write_text(PROBE, "/tmp/probe.py")
            process = sandbox.exec("/opt/cogworks-py38/bin/python", "/tmp/probe.py")
            process.wait()
            stdout = process.stdout.read()
            stderr = process.stderr.read()
        finally:
            sandbox.terminate()

    remote: dict = {}
    for line in stdout.splitlines():
        if line.startswith("PROBE_JSON "):
            remote = json.loads(line[len("PROBE_JSON "):])
    if not remote:
        print("sandbox produced no probe output")
        print(stdout[-2000:])
        print(stderr[-2000:])
        return 1

    print("\n{:<16} {:<34} {:<34} {}".format("key", "local", "sandbox", ""))
    print("-" * 100)
    for key in sorted(set(local) | set(remote)):
        a, b = str(local.get(key, "-")), str(remote.get(key, "-"))
        mark = "" if a == b else "  <-- DIFFERS"
        print("{:<16} {:<34} {:<34}{}".format(key, a[:34], b[:34], mark))
    return 0


if __name__ == "__main__":
    import modal.runner  # noqa: F401

    raise SystemExit(main())
