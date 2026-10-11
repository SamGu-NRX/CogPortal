"""HTTPS edge for the journey rig, two names on one listener.

- cogbox.local  -> reverse proxy to the Vite dev server (which carries the
  Worker via the Cloudflare plugin). Gives every client — browser, runner
  callbacks, dev-auth — the HTTPS origin the real deployment and the runner's
  callback check expect.
- api.github.com -> the source-tarball double. The runner's prepare script
  fetches `https://api.github.com/repos/<owner>/<repo>/tarball/<sha>`; this
  answers from the corpus map (sha -> tar.gz) under COGBOX_ROOT/corpus.

Certificates come from stack/setup-host.sh (one CA, trusted only by suite
processes via SSL_CERT_FILE / REQUESTS_CA_BUNDLE — never installed
system-wide).
SNI picks the certificate; the Host header picks the route.

    python3 tools/runner-real-journeys/stack/edge.py --port 443 \
        --upstream 127.0.0.1:5175
"""

import argparse
import http.client
import json
import os
import ssl
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

COGBOX = os.environ.get("COGBOX_ROOT", "/home/user/work/cogbox")
TLS = os.path.join(COGBOX, "tls")

UPSTREAM = ("127.0.0.1", 5175)

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}


def load_context(name: str) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.path.join(TLS, name + ".crt"), os.path.join(TLS, name + ".key"))
    return ctx


CONTEXTS = {}


def sni_callback(sock, server_name, session):
    ctx = CONTEXTS.get(server_name) or CONTEXTS.get("cogbox.local")
    if ctx is not None:
        sock.context = ctx


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[edge] " + (fmt % args) + "\n")

    def _host(self):
        return (self.headers.get("Host") or "").split(":")[0]

    def do_GET(self):
        host = self._host()
        if host == "api.github.com":
            return self.tarball()
        return self.proxy("GET")

    def do_HEAD(self):
        return self.proxy("HEAD")

    def do_POST(self):
        return self.proxy("POST")

    def do_PUT(self):
        return self.proxy("PUT")

    def do_PATCH(self):
        return self.proxy("PATCH")

    def do_DELETE(self):
        return self.proxy("DELETE")

    def tarball(self):
        parts = self.path.strip("/").split("/")
        # /repos/<owner>/<repo>/tarball/<sha>
        if len(parts) == 5 and parts[0] == "repos" and parts[3] == "tarball":
            sha = parts[4]
            mapping = os.path.join(COGBOX, "corpus", "map.json")
            try:
                with open(mapping) as fh:
                    table = json.load(fh)
            except OSError:
                table = {}
            path = table.get(sha)
            if path and os.path.exists(path):
                with open(path, "rb") as fh:
                    data = fh.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-gzip")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def proxy(self, method: str):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        conn = http.client.HTTPConnection(UPSTREAM[0], UPSTREAM[1], timeout=60)
        try:
            conn.request(method, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in HOP_BY_HOP:
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if method != "HEAD" and data:
                self.wfile.write(data)
        except (OSError, http.client.HTTPException) as error:
            self.send_response(502)
            message = ("[edge] upstream unreachable: %s" % error).encode()
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)
        finally:
            conn.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=443)
    parser.add_argument("--upstream", default="127.0.0.1:5175")
    args = parser.parse_args()
    global UPSTREAM
    host, _, port = args.upstream.partition(":")
    UPSTREAM = (host, int(port or 5175))

    for name in ("cogbox.local", "api.github.com"):
        CONTEXTS[name] = load_context(name)
    default_ctx = CONTEXTS["cogbox.local"]
    default_ctx.set_servername_callback(sni_callback)

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    server.socket = default_ctx.wrap_socket(server.socket, server_side=True)
    print("[edge] listening on :%d -> %s" % (args.port, args.upstream), flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
