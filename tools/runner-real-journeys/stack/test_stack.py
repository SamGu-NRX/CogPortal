"""Focused tests for the review fixes in the local runner stack.

Run from the repository root (stdlib only; no sudo, no network):

    python3 -m pytest tools/runner-real-journeys/stack/test_stack.py -q

The sandbox-level behaviors the smoke suite exercises live (sudo, cgroups,
namespaces) are covered here at the script and environment level: the exec
script's shape, the child environment's allowlist, the build commands, the
edge's Content-Length handling, and the reset endpoint's method dispatch.
"""

import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build_envs  # noqa: E402
import edge  # noqa: E402
import runnerbox  # noqa: E402
import sandbox_shim  # noqa: E402


class _UpstreamHandler(BaseHTTPRequestHandler):
    """A tiny origin: 200 with a known 11-byte body and Content-Length."""

    def _respond(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", "11")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(b"hello world")

    do_GET = _respond
    do_HEAD = _respond

    def log_message(self, fmt, *args):
        pass


class _ServerMixin:
    """One ThreadingHTTPServer per test, torn down with the test."""

    server = None

    def _start_server(self, handler):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.server.server_close)

    def _request(self, method, path, body=None):
        conn = http.client.HTTPConnection(*self.server.server_address[:2], timeout=10)
        try:
            conn.request(method, path, body=body)
            resp = conn.getresponse()
            return resp.status, resp.getheaders(), resp.read()
        finally:
            conn.close()


class EdgeContentLengthTest(_ServerMixin, unittest.TestCase):
    """The edge must send exactly one Content-Length header.

    proxy() forwarded the upstream's Content-Length and then added its own:
    on GET that is a duplicate header, and on HEAD it is the real length
    beside a zero (review finding 4242631260)."""

    def setUp(self):
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), _UpstreamHandler)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        self.addCleanup(upstream.shutdown)
        self.addCleanup(upstream.server_close)
        self._old_upstream = edge.UPSTREAM
        edge.UPSTREAM = upstream.server_address[:2]
        self.addCleanup(self._restore_upstream)
        self._start_server(edge.Handler)

    def _restore_upstream(self):
        edge.UPSTREAM = self._old_upstream

    def _lengths(self, method):
        _, headers, body = self._request(method, "/")
        lengths = [v for k, v in headers if k.lower() == "content-length"]
        return lengths, body

    def test_get_sends_one_content_length(self):
        lengths, body = self._lengths("GET")
        self.assertEqual(body, b"hello world")
        self.assertEqual(lengths, ["11"])

    def test_head_preserves_the_upstream_length(self):
        lengths, body = self._lengths("HEAD")
        self.assertEqual(body, b"")
        self.assertEqual(lengths, ["11"])


class RunnerboxResetTest(_ServerMixin, unittest.TestCase):
    """/__reset must refuse GET and answer POST; GET stays read-only.

    GET /__reset used to clear the job store (review finding 4242631258);
    POST /__reset fell through to the signed submit path."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        dicts = os.path.join(tmp.name, "dicts")
        os.makedirs(dicts)
        with open(os.path.join(dicts, "jobs.json"), "w") as fh:
            json.dump({"job-a": {"benchmark": "x"}}, fh)
        self._old_root = os.environ.get("COGBOX_ROOT")
        os.environ["COGBOX_ROOT"] = tmp.name
        self.addCleanup(self._restore_root)
        self._start_server(runnerbox.Handler)

    def _restore_root(self):
        if self._old_root is None:
            os.environ.pop("COGBOX_ROOT", None)
        else:
            os.environ["COGBOX_ROOT"] = self._old_root

    def _store(self):
        path = os.path.join(os.environ["COGBOX_ROOT"], "dicts", "jobs.json")
        with open(path) as fh:
            return json.load(fh)

    def test_post_reset_clears_the_store(self):
        status, _, _ = self._request("POST", "/__reset", body=b"")
        self.assertEqual(status, 200)
        self.assertEqual(self._store(), {})

    def test_get_reset_is_read_only(self):
        status, _, _ = self._request("GET", "/__reset")
        self.assertEqual(status, 200)
        self.assertEqual(self._store(), {"job-a": {"benchmark": "x"}})

    def test_healthz_answers_get(self):
        status, _, body = self._request("GET", "/__healthz")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"ok\n")


class BuildEnvsTest(unittest.TestCase):
    """Build markers, --repo rebinding, and the pip seed (review 4242631246,
    4242631252, 4242631261)."""

    def test_weeks_follows_the_current_benchmarks_root(self):
        old = build_envs.BENCHMARKS
        try:
            with tempfile.TemporaryDirectory() as tmp:
                build_envs.BENCHMARKS = Path(tmp)
                rows = build_envs.weeks()
                expected = [Path(tmp) / name for name in ("week1", "week3", "week2")]
        finally:
            build_envs.BENCHMARKS = old
        self.assertEqual([row[0] for row in rows], ["week1", "week3", "week2"])
        self.assertEqual([Path(row[3]) for row in rows], expected)

    def test_venv_command_seeds_pip(self):
        steps = build_envs.venv_steps(
            "week1", "week1-py38", "3.8.20", Path("/tmp/bench-week1"),
            uv="/usr/bin/false",  # shape only; uv need not exist on this host
        )
        venv_cmds = [cmd for label, cmd in steps if label == "venv"]
        self.assertTrue(venv_cmds, "the venv step must be present")
        self.assertIn("--seed", " ".join(venv_cmds[0]))

    def test_inputs_hash_tracks_bench_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            bench = Path(tmp) / "week1"
            (bench / "sub").mkdir(parents=True)
            (bench / "a.py").write_text("x = 1\n")
            (bench / "sub" / "b.toml").write_text("[a]\n")
            first = build_envs.build_inputs_hash("3.8.20", bench)
            self.assertEqual(first, build_envs.build_inputs_hash("3.8.20", bench))
            self.assertNotEqual(first, build_envs.build_inputs_hash("3.8.21", bench))
            (bench / "a.py").write_text("x = 2\n")
            self.assertNotEqual(first, build_envs.build_inputs_hash("3.8.20", bench))
            self.assertNotIn(first, ("", None))


class SandboxScriptTest(unittest.TestCase):
    """The namespace script a sandbox exec runs (review 4242631221, 4242631229)."""

    def _sandbox(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "tmp").mkdir()
        (root / "ws").mkdir()
        sandbox = sandbox_shim.Sandbox(
            {"tmp": str(root / "tmp"), "ws": str(root / "ws")},
            {
                "track": "week1",
                "memoryMax": 2048,
                "memoryHigh": 512,
                "cpuMax": "200000",
                "blockNetwork": False,
            },
            time.time() + 60,
        )
        sandbox._id = "sb-test"
        sandbox._root = str(root)
        sandbox._cg_dir = str(root / "cg")
        sandbox._cg_name = "cog-test"
        sandbox._hosts_path = str(root / "hosts")
        sandbox._venv_copy = None
        sandbox._venv_host = None
        return sandbox

    def test_second_exec_can_recreate_the_cgroup(self):
        script, _ = self._sandbox()._setup_script(["/bin/echo", "hi"], {})
        self.assertIn("mkdir -p", script)

    def test_script_drops_privileges_for_the_student_process(self):
        script, _ = self._sandbox()._setup_script(["/bin/echo", "hi"], {})
        self.assertIn("setpriv", script)
        self.assertIn("--reuid", script)

    def test_script_binds_the_private_venv_when_present(self):
        sandbox = self._sandbox()
        sandbox._venv_copy = "/copy/venv"
        script, _ = sandbox._setup_script(["/bin/echo", "hi"], {})
        # The private copy mounts at the deployed venv path — one the
        # unprivileged student can traverse (the host cogbox tree is not).
        self.assertIn("mount --bind /copy/venv /opt/cogworks-py38", script)
        no_venv_script, _ = self._sandbox()._setup_script(["/bin/echo"], {})
        venv_binds = [
            ln for ln in no_venv_script.splitlines()
            if ln.startswith("mount --bind ") and ln.endswith(" /opt/cogworks-py38")
        ]
        self.assertEqual(venv_binds, [])

    def test_script_binds_the_runner_source_for_the_student(self):
        # PYTHONPATH must resolve inside the namespace at a traversable path.
        script, _ = self._sandbox()._setup_script(["/bin/echo", "hi"], {})
        self.assertIn("/opt/cogworks-runner", script)

    def test_untouched_argv_and_oom_copy_survive(self):
        script, argv = self._sandbox()._setup_script(["/bin/echo", "hi"], {})
        self.assertEqual(argv, ["/bin/echo", "hi"])
        self.assertIn("memory.events", script)
        self.assertIn("cgroup.procs", script)


class ChildEnvTest(unittest.TestCase):
    """The sandbox child environment is an allowlist, not a copy
    (review finding 4242631221: RUNNER_SIGNING_SECRET reached student code)."""

    def test_allowlist_blocks_runner_secrets(self):
        host = {
            "RUNNER_SIGNING_SECRET": "leak-me",
            "SSL_CERT_FILE": "/ca/ca.crt",
            "TORCH_HOME": "/opt/torch",
            "SMOKE_NOT_FOR_SANDBOX": "host-only",
            "PATH": "/usr/bin:/bin",
        }
        env = sandbox_shim.child_environment("/opt/week1-py38", host_env=host)
        self.assertNotIn("RUNNER_SIGNING_SECRET", env)
        self.assertNotIn("SMOKE_NOT_FOR_SANDBOX", env)
        self.assertEqual(env["SSL_CERT_FILE"], "/ca/ca.crt")
        self.assertEqual(env["TORCH_HOME"], "/opt/torch")
        self.assertTrue(env["PATH"].startswith("/opt/week1-py38/bin:"))
        self.assertEqual(env["HOME"], "/tmp")

    def test_extra_env_and_passthrough_join_but_not_the_host_copy(self):
        host = {"RUNNER_SIGNING_SECRET": "x", "KEEP": "no"}
        env = sandbox_shim.child_environment(
            "/v",
            extra={"JOB_MARK": "1"},
            host_env=host,
            passthrough_env={"COG_TEST_DATA": "/opt/data"},
        )
        self.assertEqual(env.get("COG_TEST_DATA"), "/opt/data")
        self.assertEqual(env.get("JOB_MARK"), "1")
        self.assertNotIn("KEEP", env)
        self.assertNotIn("RUNNER_SIGNING_SECRET", env)


class PassthroughEnvTest(unittest.TestCase):
    """_passthrough_env reads COGBOX_PASSTHROUGH_ENV names and the suite's
    passthrough.env file — never the host env wholesale."""

    def test_reads_names_and_file(self):
        old_names = os.environ.get("COGBOX_PASSTHROUGH_ENV")
        old_data = os.environ.get("COG_TEST_DATA")
        old_root = os.environ.get("COGBOX_ROOT")
        try:
            os.environ["COGBOX_PASSTHROUGH_ENV"] = "COG_TEST_DATA"
            os.environ["COG_TEST_DATA"] = "/opt/data"
            with tempfile.TemporaryDirectory() as tmp:
                os.environ["COGBOX_ROOT"] = tmp
                with open(os.path.join(tmp, "passthrough.env"), "w") as fh:
                    fh.write("WEEK3_DATA_DIR=/opt/cogworks-data/week3\n# comment\nBROKEN\n")
                got = sandbox_shim._passthrough_env()
        finally:
            for name, value in (
                ("COGBOX_PASSTHROUGH_ENV", old_names),
                ("COG_TEST_DATA", old_data),
                ("COGBOX_ROOT", old_root),
            ):
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
        self.assertEqual(got.get("COG_TEST_DATA"), "/opt/data")
        self.assertEqual(got.get("WEEK3_DATA_DIR"), "/opt/cogworks-data/week3")
        self.assertNotIn("BROKEN", got)


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-q"]))
