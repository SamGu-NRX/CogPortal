#!/usr/bin/env python3
"""Seven-check smoke suite for the local runner stack.

    python3 tools/runner-real-journeys/stack/smoke_test.py

Runs one-time setup (process-local certs/hosts, /workspace, cgroup
delegation), then the seven checks the review asked for. Exits 1 if any
check fails; every check prints its own evidence line.
"""

import glob
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
COGBOX_ROOT = os.environ.get("COGBOX_ROOT", "/home/user/work/cogbox")
PY = sys.executable

RESULTS = []


def record(n, name, ok, evidence=""):
    RESULTS.append((str(n), ok))
    line = "[check-%s] %s: %s" % (n, "PASS" if ok else "FAIL", name)
    if evidence:
        line += "\n    " + evidence
    print(line, flush=True)


def sandbox(**kw):
    import sandbox_shim

    sandbox_shim.install_shim()
    return sandbox_shim.Sandbox.create(**kw)


def check_1():
    """Sandbox exec round-trip: run, exit cleanly, capture output."""
    sb = sandbox(cpu=(0.5, 2.0), memory=(512, 2048), timeout=60)
    try:
        p = sb.exec("/bin/echo", "hello-from-sandbox")
        rc = p.wait()
        out = p.stdout.read().decode().strip()
        record(1, "sandbox exec/output round-trip", rc == 0 and out == "hello-from-sandbox",
               "rc=%s out=%r" % (rc, out))
    finally:
        sb.terminate()


def check_2():
    """Wall-clock kill: a 30 s sleep in a 3 s-deadline sandbox dies early."""
    sb = sandbox(cpu=(0.5, 2.0), memory=(512, 2048), timeout=3)
    try:
        t0 = time.monotonic()
        p = sb.exec("/bin/sleep", "30")
        rc = p.wait()
        dt = time.monotonic() - t0
        err = p.stderr.read().decode()[-200:]
        record(2, "wall-clock kill", rc != 0 and dt < 20, "rc=%s wall=%.1fs err=%r" % (rc, dt, err))
    finally:
        sb.terminate()


def check_3():
    """5 MB capture: output far past the old 64 KiB pipe cap comes back whole."""
    sb = sandbox(cpu=(0.5, 2.0), memory=(512, 2048), timeout=120)
    try:
        p = sb.exec(PY, "-c", "import sys; sys.stdout.write('x' * (5 * 1024 * 1024))")
        rc = p.wait()
        n = len(p.stdout.read())
        record(3, "5 MB capture", rc == 0 and n >= 5 * 1024 * 1024, "rc=%s bytes=%d" % (rc, n))
    finally:
        sb.terminate()


def check_4():
    """Sandbox-private name resolution: the namespace sees the private hosts
    file, and the suite's getaddrinfo override maps only the local names."""
    sb = sandbox(cpu=(0.5, 2.0), memory=(512, 2048), timeout=60)
    try:
        p = sb.exec("/bin/cat", "/etc/hosts")
        rc = p.wait()
        txt = p.stdout.read().decode()
        names_ok = "cogbox.local" in txt and "api.github.com" in txt

        import localresolve

        localresolve.install()
        ip = socket.getaddrinfo("api.github.com", 443)[0][4][0]
        record(4, "sandbox-private name resolution",
               rc == 0 and names_ok and ip == "127.0.0.1",
               "hosts-visible=%s localresolve(api.github.com)=%s" % (names_ok, ip))
    finally:
        sb.terminate()


def check_5():
    """Edge TLS/SNI: both vhosts present the local CA's certs, the chain is
    not publicly trusted (it is our double, not a passthrough), and
    non-tarball paths on the tarball vhost are refused."""
    help_run = subprocess.run([PY, os.path.join(HERE, "edge.py"), "--help"],
                              capture_output=True, text=True)
    helptxt = (help_run.stdout or "") + (help_run.stderr or "")
    flags = []
    if "--port" in helptxt:
        flags += ["--port", "8443"]
    if "--upstream" in helptxt:
        flags += ["--upstream", "127.0.0.1:5999"]
    os.makedirs(os.path.join(COGBOX_ROOT, "logs"), exist_ok=True)
    log = open(os.path.join(COGBOX_ROOT, "logs", "smoke-edge.log"), "ab")
    edge = subprocess.Popen([PY, os.path.join(HERE, "edge.py"), *flags],
                            stdout=log, stderr=log)
    try:
        up = False
        for _ in range(25):
            try:
                socket.create_connection(("127.0.0.1", 8443), timeout=0.4).close()
                up = True
                break
            except OSError:
                time.sleep(0.2)
        if not up:
            record(5, "edge TLS/SNI + non-tarball refusal", False,
                   "edge never came up on :8443 (flags=%r)" % flags)
            return
        ca = os.path.join(COGBOX_ROOT, "tls", "ca.crt")

        def curl(url, extra):
            return subprocess.run(
                ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
                 "--max-time", "10", *extra, url],
                capture_output=True, text=True)

        r_tls = curl("https://api.github.com:8443/",
                     ["--resolve", "api.github.com:8443:127.0.0.1", "--cacert", ca])
        r_untrust = curl("https://api.github.com:8443/",
                         ["--resolve", "api.github.com:8443:127.0.0.1"])
        r_refuse = curl("https://api.github.com:8443/not-a-tarball.bin",
                        ["--resolve", "api.github.com:8443:127.0.0.1", "--cacert", ca])
        s_client = subprocess.run(
            ["timeout", "30", "openssl", "s_client", "-connect", "127.0.0.1:8443",
             "-servername", "cogbox.local", "-CAfile", ca],
            input="", capture_output=True, text=True)
        tls_cogbox = "Verify return code: 0" in (s_client.stdout + s_client.stderr)
        ok = (r_tls.returncode == 0            # local TLS + HTTP round trip works
              and r_untrust.returncode != 0    # the local CA is not publicly trusted
              and r_refuse.stdout.strip() != "200"  # non-tarball paths are refused
              and tls_cogbox)                  # cogbox.local SNI cert verifies
        record(5, "edge TLS/SNI + non-tarball refusal", ok,
               "api-tls=%s/%s untrusted-without-CA=%s refusal-code=%s cogbox-sni=%s"
               % (r_tls.returncode, r_tls.stdout.strip(), r_untrust.returncode,
                  r_refuse.stdout.strip(), tls_cogbox))
    finally:
        edge.terminate()


def _oom_evidence(sb):
    """Locate the killed run's OOM counters. The host-visible child cgroup
    under the delegated parent survives an OOM kill that takes the
    namespace (and the private tmpfs with its .cog-cg-events copy) with
    it, so it is checked first. Returns (path, memory.max content)."""
    try:
        import sandbox_shim as _shim

        parent = getattr(_shim, "CG_PARENT", "/sys/fs/cgroup/cogbox")
    except ImportError:
        parent = "/sys/fs/cgroup/cogbox"
    cgname = getattr(sb, "_cg_name", "") or ""
    tmp = (getattr(sb, "dirs", {}) or {}).get("tmp", "")
    cands = []
    if cgname:
        cands.append(os.path.join(parent, cgname, "memory.events"))
    if tmp:
        cands.append(os.path.join(tmp, ".cog-cg-events"))
    cg = getattr(sb, "_cg_dir", "") or ""
    if cg:
        cands.append(os.path.join(cg, "memory.events"))
    if tmp:
        cands += glob.glob(os.path.join(tmp, "**", "memory.events"), recursive=True)
    for c in cands:
        if os.path.isfile(c):
            memmax = ""
            mx = os.path.join(os.path.dirname(c), "memory.max")
            try:
                with open(mx) as fh:
                    memmax = fh.read().strip()
            except OSError:
                pass
            return c, memmax
    return None, ""


def check_6():
    """Cgroup memory ceiling: an allocation of incompressible (random)
    bytes past the sandbox's memory.max is OOM-killed by THAT ceiling.

    The limit must be the binding constraint: this host's free memory is
    tight (a 256 MiB limit let the VM-wide OOM killer strike first, with
    oom_kill staying 0), so the ceiling sits at 96 MiB with the soft high
    watermark at 90 MiB — a ~6 MiB throttled zone keeps the run fast, and
    the 96 MiB hard ceiling stays far below host free memory so the
    cgroup's own OOM killer fires first. Zero-filled buffers stall under
    reclaim without charging past memory.max, so the workload must be
    random; it stays bounded at 320 MB so a failed ceiling cannot exhaust
    the host. The criterion is oom_kill >= 1 in the copied counters, not
    just a non-zero exit."""
    sb = sandbox(cpu=(0.5, 2.0), memory=(90, 96), timeout=60)
    rc, oom_raised, detail = None, False, ""
    try:
        p = sb.exec(PY, "-c",
                    "import os\nxs = []\nfor _ in range(320):\n"
                    "    xs.append(os.urandom(1 << 20))\n"
                    "print('SURVIVED', len(xs))")
        rc = p.wait()
    except RuntimeError as exc:
        oom_raised = "out of memory" in str(exc).lower()
        detail = "RuntimeError(%s)" % exc
    ev, memmax = _oom_evidence(sb)
    oom = -1
    if ev and os.path.isfile(ev):
        with open(ev) as fh:
            for line in fh:
                parts = line.split()
                if len(parts) == 2 and parts[0] == "oom_kill":
                    oom = int(parts[1])
    record(6, "cgroup memory ceiling enforced", oom >= 1,
           "oom_kill=%s rc=%s raised=%s %s memory.max=%r evidence=%s"
           % (oom, rc, oom_raised, detail, memmax, ev))
    globals()["_OOM_SB"] = sb
    globals()["_OOM_EV"] = ev
    globals()["_OOM_MAX"] = memmax


def check_7():
    """OOM evidence preserved: the killed run's counters survive with
    oom_kill >= 1 and are copied to the suite's logs. Text parsing only —
    counters are ints read from text, never compared as bytes."""
    sb = globals().get("_OOM_SB")
    ev = globals().get("_OOM_EV")
    memmax = globals().get("_OOM_MAX", "")
    ok, detail = False, "no evidence file found"
    if ev and os.path.isfile(ev):
        with open(ev) as fh:
            txt = fh.read()
        oom = 0
        for line in txt.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0] == "oom_kill":
                oom = int(parts[1])
        os.makedirs(os.path.join(COGBOX_ROOT, "logs"), exist_ok=True)
        dst = os.path.join(COGBOX_ROOT, "logs", "smoke-oom-evidence.txt")
        with open(dst, "w") as fh:
            fh.write("memory.max=%s\n%s" % (memmax, txt))
        ok = oom >= 1
        detail = "oom_kill=%d memory.max=%s from %s, preserved at %s" % (oom, memmax, ev, dst)
    try:
        record(7, "OOM evidence preserved", ok, detail)
    finally:
        if sb is not None:
            sb.terminate()


def _run_setup(cmd, abort=True):
    r = subprocess.run(cmd)
    if r.returncode != 0:
        msg = "SETUP FAILED: %s (rc=%s)" % (" ".join(cmd), r.returncode)
        if abort:
            print(msg, "- aborting before checks", flush=True)
            sys.exit(1)
        print(msg, "- continuing; the cgroup checks will give the verdict", flush=True)


def main():
    os.makedirs(os.path.join(COGBOX_ROOT, "logs"), exist_ok=True)
    _run_setup(["bash", os.path.join(HERE, "setup-host.sh")])
    _run_setup(["sudo", "-E", "bash", os.path.join(HERE, "setup_host_cgroups.sh")],
               abort=False)
    for check in (check_1, check_2, check_3, check_4, check_5, check_6, check_7):
        try:
            check()
        except Exception as exc:  # noqa: BLE001 — a failing check is a result, not a crash
            record(check.__name__.split("_")[1], "%s raised" % check.__name__, False, repr(exc))
    failed = [n for n, ok in RESULTS if not ok]
    print("SMOKE: %d/%d passed%s" % (len(RESULTS) - len(failed), len(RESULTS),
                                     ", FAILED: %s" % failed if failed else ""), flush=True)
    sys.exit(1 if failed else 0)


main()
