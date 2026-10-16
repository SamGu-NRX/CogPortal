// Static server for the layout-shift evidence: it serves the PRODUCTION
// client bundle (apps/portal/dist/client) and answers /api/session with the
// frozen signed-out fixture, so the shift measurement runs against the
// artifact a student actually loads.
//
// `vite preview` cannot serve as the evidence origin: wrangler.jsonc's
// top-level vars intentionally carry GITHUB_CLIENT_ID without the secret, so
// the previewed worker correctly refuses to start auth (that mismatch is a
// property of a staging deploy, not of this evidence). This server isolates
// the question the shift evidence asks — does the built page move? — from
// worker configuration, with the session answer coming from the same frozen
// fixture module the other entry tests parse.
//
// Usage:
//   node evidence/cogportal-entry/prod-server.mjs \
//     --static=apps/portal/dist/client --port=4188 \
//     --session=<path-to-session.json>

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value];
  }),
);
const staticRoot = args.static;
const port = Number(args.port);
const sessionFile = args.session;
if (!staticRoot || !port || !sessionFile) {
  console.error("usage: node prod-server.mjs --static=<dir> --port=<n> --session=<file>");
  process.exit(2);
}

const sessionBody = await readFile(sessionFile, "utf8");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/api/session") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(sessionBody);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "No fixture for this route." } }));
    return;
  }

  // Resolve inside staticRoot only; anything else falls back to the SPA shell.
  const requested = normalize(decodeURIComponent(url.pathname))
    .split(sep)
    .filter((part) => part !== "" && part !== "..")
    .join(sep);
  let filePath = join(staticRoot, requested);
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(staticRoot, "index.html");
  }

  try {
    const body = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? "application/octet-stream";
    const immutable = filePath.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      "content-type": type,
      // Hashed build assets are immutable; the shell is re-read per load so a
      // redeploy is picked up the way a student's next visit would.
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`prod-server: cannot read ${filePath}: ${error?.message ?? error}`);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`prod-server: serving ${staticRoot} on http://127.0.0.1:${port}`);
});
