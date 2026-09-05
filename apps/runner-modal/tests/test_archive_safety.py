"""What the prepare step does with an archive that is not an ordinary repository.

Gate 1 names a malicious contract fixture as the way to prove archive handling,
and no such fixture existed anywhere in this repository. The defences did:
PREPARE_SCRIPT caps the download at 100 MiB on both the declared Content-Length
and the streamed total, refuses any tar member that is not a plain file or
directory, and refuses any member whose resolved path escapes the workspace.
Nothing exercised them. The one test that mentioned the size limit checked how
its error message is shortened for a student, not whether the limit holds.

An untested defence is a defence you find out about during a run, and a run is
the expensive place to find out. This builds the hostile archives, serves them
over a loopback HTTP server, and runs the real PREPARE_SCRIPT against them in a
subprocess. No Modal, no network, no cost. It is the same source string the
sandbox executes, read out of modal_app.py rather than copied, because a test
against a copy stops being evidence about the shipped script the first time the
two drift.

What this cannot show: that Modal's own container isolation holds, or that the
prepare sandbox's outbound allowlist really blocks a host that is not on it.
Those need a live sandbox and are runbook steps, not tests.
"""

from __future__ import annotations

import ast
import http.server
import io
import json
import socketserver
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MODAL_APP = ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"


def _prepare_script() -> str:
    """The real PREPARE_SCRIPT, out of the AST.

    Same reason as every other test in this directory: modal_app imports modal
    and fastapi at module scope and the test interpreter has neither.
    """

    module = ast.parse(MODAL_APP.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            getattr(target, "id", None) == "PREPARE_SCRIPT" for target in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError("PREPARE_SCRIPT not found")


SCRIPT = _prepare_script()

#: The cap PREPARE_SCRIPT enforces. Read from the script rather than restated,
#: so raising the limit there does not leave a test quietly checking the old one.
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
assert "max_archive_bytes = 100 * 1024 * 1024" in SCRIPT, (
    "the archive cap moved; update MAX_ARCHIVE_BYTES and the oversize tests"
)


def _tar(members) -> bytes:
    """A gzipped tar built member by member, so members tarfile would refuse to
    create from a real filesystem (a symlink to /etc/passwd, a path with ..)
    can still be written."""

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for info, payload in members:
            bundle.addfile(info, io.BytesIO(payload) if payload is not None else None)
    return buffer.getvalue()


def _directory(name: str) -> tuple:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    return info, None


def _file(name: str, body: bytes = b"x = 1\n") -> tuple:
    info = tarfile.TarInfo(name)
    info.size = len(body)
    info.mode = 0o644
    return info, body


def ordinary_repository() -> bytes:
    """What GitHub's tarball endpoint actually returns: one top-level directory."""

    return _tar([_directory("team-project-abc1234"), _file("team-project-abc1234/submission.py")])


def symlink_archive() -> bytes:
    """A symlink pointing outside the workspace.

    The concrete risk: extract it, then read or write through it. Refusing every
    member that is not a plain file or directory is a broader rule than chasing
    link targets, and a repository has no legitimate need for a device node
    either.
    """

    link = tarfile.TarInfo("team-project-abc1234/passwd")
    link.type = tarfile.SYMTYPE
    link.linkname = "/etc/passwd"
    return _tar([_directory("team-project-abc1234"), _file("team-project-abc1234/submission.py"), (link, None)])


def hardlink_archive() -> bytes:
    link = tarfile.TarInfo("team-project-abc1234/hard")
    link.type = tarfile.LNKTYPE
    link.linkname = "team-project-abc1234/submission.py"
    return _tar([_directory("team-project-abc1234"), _file("team-project-abc1234/submission.py"), (link, None)])


def device_archive() -> bytes:
    node = tarfile.TarInfo("team-project-abc1234/null")
    node.type = tarfile.CHRTYPE
    node.devmajor, node.devminor = 1, 3
    return _tar([_directory("team-project-abc1234"), (node, None)])


def path_escape_archive() -> bytes:
    """The classic: a member whose path climbs out of the extraction root."""

    return _tar([_file("../escaped.py")])


def deep_path_escape_archive() -> bytes:
    """The same idea, disguised by a legitimate-looking prefix.

    `proj/../../escaped.py` normalizes above the root, so a check that only
    looks for a leading `..` would pass it.
    """

    return _tar([_directory("team-project-abc1234"), _file("team-project-abc1234/../../escaped.py")])


def absolute_path_archive() -> bytes:
    return _tar([_file("/tmp/cogworks-absolute-escape.py")])


def two_roots_archive() -> bytes:
    """Two top-level directories, so there is no single project root.

    Not hostile, and refused anyway: the prepare step has to name one directory
    as the repository, and guessing between two would silently score whichever
    it guessed.
    """

    return _tar([_directory("one"), _file("one/a.py"), _directory("two"), _file("two/b.py")])


class ArchiveServer:
    """Serves one named archive per path over loopback.

    Two oversize shapes are served specially. `/declared-oversize` sends a
    Content-Length above the cap and no body, which is what a hostile server
    would do to make the client allocate; the script must refuse on the header
    alone and never read. `/streamed-oversize` sends no length at all and then
    streams past the cap, which is what a chunked response does; the script must
    stop counting bytes and refuse.
    """

    def __init__(self, archives):
        self.archives = archives
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's name
                path = self.path
                if path == "/declared-oversize":
                    self.send_response(200)
                    self.send_header("Content-Length", str(MAX_ARCHIVE_BYTES * 2))
                    self.end_headers()
                    return
                if path == "/streamed-oversize":
                    self.send_response(200)
                    self.end_headers()
                    chunk = b"\0" * (1024 * 1024)
                    try:
                        for _ in range(MAX_ARCHIVE_BYTES // len(chunk) + 8):
                            self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                body = outer.archives.get(path.lstrip("/"))
                if body is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # keep the test output readable
                pass

        self.server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        self.server.allow_reuse_address = True

    def __enter__(self):
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    def url(self, path: str) -> str:
        return "http://127.0.0.1:{}/{}".format(self.server.server_address[1], path)


def run_prepare(url: str, benchmark_id: str = "language-search", weights=None) -> tuple:
    """Run the real prepare script against one URL, in its own directory.

    The script hardcodes `/workspace` and `/tmp`, which belong to the sandbox.
    Both are redirected into a temporary directory so a test can never write to
    either, and so two tests cannot collide. Only those two path literals are
    rewritten; every other line executes as shipped.

    Returns (returncode, stderr, workspace path).
    """

    directory = tempfile.mkdtemp(prefix="cogworks-archive-")
    root = Path(directory)
    # Rewrite /tmp first. Linux creates this fixture under /tmp, so doing it
    # second also rewrites the workspace path inserted by the first replacement.
    body = SCRIPT.replace('"/tmp/', '"{}/'.format(root)).replace(
        'pathlib.Path("/workspace")', 'pathlib.Path("{}/workspace")'.format(root)
    )
    script = root / "prepare.py"
    script.write_text(body, encoding="utf-8")
    finished = subprocess.run(
        [
            sys.executable,
            str(script),
            url,
            benchmark_id,
            "cogworks.submissions.v2",
            json.dumps(weights or []),
        ],
        capture_output=True,
        text=True,
        timeout=300,
        cwd=str(root),
        # An empty PYTHONPATH so the repository's own cogbench cannot be
        # imported. Discovery is not what these tests are about, and a machine
        # where it happened to import would take a different branch.
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": ""},
    )
    return finished.returncode, finished.stderr, root / "workspace"


class RefusedArchives(unittest.TestCase):
    """Each of these must fail, and fail with the sentence naming the reason.

    The message matters as much as the refusal. `_prepare` in modal_app.py
    routes on it: a detail containing "source archive" becomes
    `repository_fetch` at the preparing phase with infrastructure=False, which
    is a run the team can fix. Anything it does not recognize becomes
    `dependency_install`, which points a team at their packaging when the real
    problem was the download.
    """

    @classmethod
    def setUpClass(cls):
        cls.archives = {
            "symlink": symlink_archive(),
            "hardlink": hardlink_archive(),
            "device": device_archive(),
            "escape": path_escape_archive(),
            "deep-escape": deep_path_escape_archive(),
            "absolute": absolute_path_archive(),
            "two-roots": two_roots_archive(),
            "ordinary": ordinary_repository(),
            "weight": b"trained weights",
        }
        cls.server = ArchiveServer(cls.archives)
        cls.server.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.server.__exit__(None, None, None)

    def assert_refused(self, path: str, expected: str):
        code, stderr, workspace = run_prepare(self.server.url(path))
        self.assertNotEqual(code, 0, "{} was accepted: {}".format(path, stderr[-300:]))
        self.assertIn(expected, stderr, "{} refused for the wrong reason: {}".format(path, stderr[-400:]))
        return workspace

    def test_a_symlink_member_is_refused(self):
        self.assert_refused("symlink", "link or special file")

    def test_a_hardlink_member_is_refused(self):
        self.assert_refused("hardlink", "link or special file")

    def test_a_device_node_is_refused(self):
        self.assert_refused("device", "link or special file")

    def test_a_path_climbing_out_of_the_workspace_is_refused(self):
        workspace = self.assert_refused("escape", "unsafe path")
        self.assertFalse(
            (workspace.parent / "escaped.py").exists(),
            "the refusal came after the write, which is not a refusal",
        )

    def test_a_path_that_only_normalizes_out_is_refused(self):
        self.assert_refused("deep-escape", "unsafe path")

    def test_an_absolute_path_is_refused(self):
        self.assert_refused("absolute", "unsafe path")

    def test_two_project_roots_are_refused(self):
        self.assert_refused("two-roots", "one project root")

    def test_an_oversize_content_length_is_refused_before_the_body_is_read(self):
        """The declared size alone must be enough.

        Reading first and checking after means a hostile server sets the cost,
        which is the whole point of having a cap.
        """

        code, stderr, _ = run_prepare(self.server.url("declared-oversize"))
        self.assertNotEqual(code, 0)
        self.assertIn("could not be downloaded safely", stderr)

    def test_a_response_that_streams_past_the_cap_is_refused(self):
        """No Content-Length is the ordinary chunked case, not an attack.

        The declared-size check does nothing here, so the running total is the
        only thing standing between us and an unbounded write.
        """

        code, stderr, _ = run_prepare(self.server.url("streamed-oversize"))
        self.assertNotEqual(code, 0)
        self.assertIn("could not be downloaded safely", stderr)

    def test_a_weight_path_cannot_leave_the_checkout(self):
        code, stderr, workspace = run_prepare(
            self.server.url("ordinary"),
            weights=[{
                "path": "../stolen.pkl",
                "size": 1,
                "sha256": "0" * 64,
                "url": self.server.url("ordinary"),
                "headers": {},
            }],
        )

        self.assertNotEqual(code, 0)
        self.assertIn("Weight file has an unsafe path", stderr)
        self.assertFalse((workspace.parent / "stolen.pkl").exists())

    def test_a_weight_digest_mismatch_is_refused(self):
        code, stderr, _ = run_prepare(
            self.server.url("ordinary"),
            weights=[{
                "path": "models/search.pkl",
                "size": len(b"trained weights"),
                "sha256": "0" * 64,
                "url": self.server.url("weight"),
                "headers": {},
            }],
        )

        self.assertNotEqual(code, 0)
        self.assertIn(
            "Weight file models/search.pkl did not match its digest.",
            stderr,
        )

    def test_an_ordinary_repository_gets_past_every_archive_check(self):
        """The control. Without it, a script that refused everything would pass
        every test above and prove nothing.

        This one runs to completion, because a `submission.py` at the
        repository root is rung 1 of the prepare step's resolution order and
        needs nothing installed. The two files it writes are what the evaluate
        sandbox reads, so their presence says the archive path finished rather
        than merely got further.
        """

        code, stderr, workspace = run_prepare(self.server.url("ordinary"))
        # The exit code is the assertion. stderr is deliberately not checked
        # for the absence of "archive": CPython 3.14 emits a DeprecationWarning
        # about tarfile.extractall's coming default filter, and that warning
        # contains the word. The script validates every member before calling
        # extractall, so the coming default is stricter than what it relies on.
        self.assertEqual(code, 0, stderr[-400:])
        self.assertTrue((workspace / "team-project-abc1234" / "submission.py").is_file())
        # Written last, after extraction, the single-root check, and
        # resolution. The evaluate sandbox imports the adapter from this path.
        root_note = workspace.parent / "project-root.txt"
        self.assertTrue(root_note.is_file())
        self.assertTrue(root_note.read_text(encoding="utf-8").strip().endswith("team-project-abc1234"))
        self.assertEqual(
            (workspace.parent / "adapter-source.txt").read_text(encoding="utf-8"),
            "file:submission.py",
        )


class RefusalsAreAttributedToTheRightOwner(unittest.TestCase):
    """A refused archive must not be read as the team's packaging problem.

    `_prepare` decides the failure category by looking for "source archive" in
    the message. Every download refusal has to carry that phrase or the run is
    reported as `dependency_install`, which tells a team to fix a requirements
    file that was never the problem.
    """

    def test_every_download_refusal_names_the_source_archive(self):
        messages = [
            line
            for line in SCRIPT.splitlines()
            if "RuntimeError(" in line and "rchive" in line
        ]
        self.assertGreaterEqual(len(messages), 3, messages)
        for message in messages:
            self.assertIn(
                "archive",
                message.lower(),
                "a refusal that does not say 'archive' is attributed to the wrong owner",
            )


if __name__ == "__main__":
    unittest.main()
