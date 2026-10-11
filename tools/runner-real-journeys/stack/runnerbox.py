"""Serve the real controller's signed submit endpoint locally.

`serve` imports `apps/runner-modal/src/cogworks_runner/modal_app.py` verbatim
through the sandbox shim and answers POST / the way Modal would call
`submit_job`: the body and headers go in, the shim Response's status goes back.
`execute_job` runs in threads; sandboxes are the shim's local namespaces.

    python3 tools/runner-real-journeys/stack/runnerbox.py serve \
        --port 8791 --secret <secret>

Admin surface (localhost only, never signed):
- GET  /__healthz  -> "ok" once modal_app has imported
- POST /__reset    -> empties the job store (fresh journey)
"""

import argparse
import asyncio
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SUITES = os.path.dirname(HERE)
REPO = os.environ.get("COGBOX_REPO", os.path.dirname(os.path.dirname(os.path.dirname(SUITES))))

modal_app = None


def build_runner(repo: str) -> None:
    sys.path.insert(0, HERE)
    import localresolve
    import sandbox_shim

    # Process-local name resolution for the two local hostnames; the
    # system resolver, host git and gh are untouched by this suite.
    localresolve.install()
    sandbox_shim.install_shim()
    sys.path.insert(0, os.path.join(repo, "apps", "runner-modal", "src"))
    sys.path.insert(0, os.path.join(repo, "python", "cogbench", "src"))
    global modal_app
    from cogworks_runner import modal_app as module

    modal_app = module


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[runnerbox] " + (fmt % args) + "\n")

    def _admin(self):
        if self.path == "/__healthz":
            self._respond(200, b"ok\n")
            return True
        if self.path == "/__reset":
            box = os.environ["COGBOX_ROOT"]
            dicts = os.path.join(box, "dicts")
            for name in os.listdir(dicts):
                with open(os.path.join(dicts, name), "w") as fh:
                    json.dump({}, fh)
            self._respond(200, b"reset\n")
            return True
        return False

    def _respond(self, status: int, body: bytes = b"") -> None:
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        headers = {k.lower(): v for k, v in self.headers.items()}
        request = modal_app.Request(body=body, headers=headers)
        response = asyncio.run(modal_app.submit_job(request))
        self._respond(getattr(response, "status_code", 202))

    def do_GET(self):
        if self._admin():
            return
        self._respond(404, b"not the signed endpoint\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["serve"])
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--repo", default=REPO)
    args = parser.parse_args()

    os.environ.setdefault("COGBOX_ROOT", "/home/user/work/cogbox")
    os.environ["RUNNER_SIGNING_SECRET"] = os.environ.get(
        "RUNNER_SIGNING_SECRET", "local-journey-secret"
    )
    os.environ.pop("COGWORKS_RUNNER_TARGET", None)
    os.environ.pop("COGWORKS_RUNNER_SANDBOX_IMAGE_IDS", None)

    build_runner(args.repo)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("[runnerbox] serving the real controller on 127.0.0.1:%d" % args.port, flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
