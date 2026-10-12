// Egress witness: a local HTTP/CONNECT proxy that FAILS CLOSED in every mode,
// with a full request log. Real-data journeys run the CLI through it so the
// receipts can record every public-asset download (allowed, with sizes) and
// FAIL the case if the command attempts anything else — portal, provider,
// chat, a deployed Worker, anything.
//
//   EGRESS_LOG    where the request log (jsonl) is appended
//   EGRESS_INFO   where {proxy, control, log} is written once listening
//
// Control plane (JSON):
//   POST /__egress__/mode   {"mode":"online"|"offline"} — flip modes
//   POST /__egress__/marker {"label":"..."}             — returns {"seq":N}
//   GET  /__egress__/events?after=N                     — log entries > N
//
// Every destination that is neither loopback nor a documented public-asset
// host (the week 2/3 data sources named in benchmark-packages.ts, README.md
// and docs/design/student-cli-and-onboarding.md) is refused BEFORE any
// upstream socket is opened — in online and offline mode alike, so an
// accidental Discord or deployed-Worker request can never reach live
// infrastructure and only be judged after the fact. Refusals are recorded,
// not silent — a journey asserting "no other traffic" sees them.
import http from "node:http";
import net from "node:net";
import { appendFileSync, writeFileSync } from "node:fs";
import { egressAllowed } from "./egress-hosts.mjs";

const LOG = process.env.EGRESS_LOG ?? "/tmp/egress.jsonl";
const INFO = process.env.EGRESS_INFO ?? "/tmp/egress.json";

/** The one allow rule (support/egress-hosts.mjs), applied in EVERY mode:
 * loopback and the documented public-asset hosts, nothing else. The mode is
 * still recorded on events because the journeys use it to mark which windows
 * must be silent; it does not change what is allowed. */
const allowed = egressAllowed;

let mode = "online";
const events = [];

function record(event) {
  const entry = { seq: events.length, at: new Date().toISOString(), mode, ...event };
  events.push(entry);
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Count the bytes flowing through a pipe in both directions. */
function counted(a, b, recordBytes) {
  let total = 0;
  a.on("data", (chunk) => {
    total += chunk.length;
    recordBytes(total);
    if (b.destroyed === false && b.writable) b.write(chunk);
  });
  a.on("end", () => b.end());
  a.on("error", () => b.destroy());
}

const server = http.createServer((req, res) => {
  // Plain-HTTP proxy request (absolute form). The course's downloads are
  // https, so this path mostly catches anything naive enough for http.
  const host = req.headers.host ?? "";
  const hostName = host.split(":")[0];
  const target = new URL(req.url ?? "/", "http://localhost");
  const ok = allowed(hostName || target.hostname);
  record({
    kind: "http",
    method: req.method,
    host: hostName || target.hostname,
    port: target.port || 80,
    path: target.pathname + target.search,
    allowed: ok,
    refused: ok ? undefined : "not a loopback or documented public-asset host",
  });
  if (!ok) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("egress witness: refused\n");
    return;
  }
  const up = http.request(
    { host: hostName, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: { ...req.headers, host } },
    (upRes) => {
      let bytes = 0;
      upRes.on("data", (chunk) => {
        bytes += chunk.length;
      });
      record({ kind: "http-response", host: hostName, status: upRes.statusCode, bytesHint: "see response_bytes_final" });
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
      upRes.on("end", () => record({ kind: "http-response-final", host: hostName, status: upRes.statusCode, bytes }));
    },
  );
  req.pipe(up);
  up.on("error", (error) => {
    record({ kind: "http-error", host: hostName, error: String(error) });
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
});

server.on("connect", (req, socket, head) => {
  // TLS tunnel: the witness sees host:port (not paths) and counts bytes.
  const separator = req.url?.lastIndexOf(":") ?? -1;
  const host = (req.url ?? "").slice(0, separator);
  const port = Number((req.url ?? "").slice(separator + 1)) || 443;
  const ok = allowed(host);
  record({
    kind: "connect",
    method: "CONNECT",
    host,
    port,
    allowed: ok,
    refused: ok ? undefined : "not a loopback or documented public-asset host",
  });
  if (!ok) {
    socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const up = net.connect(port, host, () => {
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (head && head.length) up.write(head);
    let sent = 0;
    let received = 0;
    const note = () => record({ kind: "tunnel-bytes", host, sent, received });
    counted(socket, up, (total) => {
      sent = total;
    });
    counted(up, socket, (total) => {
      received = total;
    });
    socket.on("close", note);
  });
  up.on("error", (error) => {
    record({ kind: "tunnel-error", host, error: String(error) });
    socket.destroy();
  });
  socket.on("error", () => up.destroy());
});

const control = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/__egress__/mode" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const next = JSON.parse(body || "{}").mode;
      if (next !== "online" && next !== "offline") {
        send(400, { error: "mode must be online or offline" });
        return;
      }
      mode = next;
      record({ kind: "mode", mode });
      send(200, { mode });
    });
    return;
  }
  if (url.pathname === "/__egress__/marker" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const label = JSON.parse(body || "{}").label ?? "";
      send(200, { seq: events.length - 1, label });
    });
    return;
  }
  if (url.pathname === "/__egress__/events" && req.method === "GET") {
    const after = Number(url.searchParams.get("after") ?? "-1");
    send(200, { mode, events: events.filter((event) => event.seq > after) });
    return;
  }
  send(404, { error: "unknown control path" });
});

server.listen(0, "127.0.0.1", () => {
  control.listen(0, "127.0.0.1", () => {
    const info = {
      proxy: `http://127.0.0.1:${server.address().port}`,
      control: `http://127.0.0.1:${control.address().port}`,
      log: LOG,
      pid: process.pid,
    };
    writeFileSync(INFO, `${JSON.stringify(info, null, 2)}\n`);
    process.on("SIGTERM", () => process.exit(0));
  });
});
