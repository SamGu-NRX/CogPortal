// Probe: the egress witness must refuse prohibited destinations BEFORE any
// upstream socket exists, in EVERY mode, while documented public-asset hosts
// and loopback still pass. Replay: node support/egress-fail-closed-probe.mjs
// (exit 0 = every assertion held; any failure exits 1 and prints the diffs).
//
// The honest client is curl, exactly as in the week2 planted-probe case:
// Node's fetch ignores proxy variables, curl honors them.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const run = promisify(execFile);

const dir = mkdtempSync(join(tmpdir(), "egress-probe-"));
const LOG = join(dir, "egress.jsonl");
const INFO = join(dir, "egress.json");
const here = new URL(".", import.meta.url).pathname;

const child = spawn(process.execPath, [join(here, "egress.mjs")], {
  env: { ...process.env, EGRESS_LOG: LOG, EGRESS_INFO: INFO },
  stdio: ["ignore", "inherit", "inherit"],
});
let proxy;
for (let i = 0; i < 100; i++) {
  try {
    proxy = JSON.parse(readFileSync(INFO, "utf8")).proxy;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
if (!proxy) {
  console.error("PROBE FAIL: witness never wrote its info file");
  process.exit(1);
}

const NO_PROXY_ENV = { ...process.env };
delete NO_PROXY_ENV.http_proxy;
delete NO_PROXY_ENV.https_proxy;
delete NO_PROXY_ENV.HTTP_PROXY;
delete NO_PROXY_ENV.HTTPS_PROXY;
delete NO_PROXY_ENV.no_proxy;
delete NO_PROXY_ENV.NO_PROXY;

async function curl(url, extra = []) {
  try {
    const { stdout } = await run("curl", ["-sS", "--max-time", "30", "--proxy", proxy, ...extra, url], {
      env: NO_PROXY_ENV,
      timeout: 40_000,
    });
    return { exit: 0, output: stdout };
  } catch (error) {
    return { exit: error.code ?? -1, output: String(error.stdout ?? "") + String(error.message ?? "") };
  }
}

async function setMode(mode) {
  await fetch(`${JSON.parse(readFileSync(INFO, "utf8")).control}/__egress__/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

function events() {
  return readFileSync(LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.kind !== "mode");
}

/** tunnel-bytes is recorded when the tunnel socket closes — a beat after curl
 * exits. Poll briefly instead of racing it. */
async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

// A minimal loopback service the proxy may forward to.
const loopback = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("loopback-ok\n");
});
await new Promise((r) => loopback.listen(0, "127.0.0.1", r));
const loopbackUrl = `http://127.0.0.1:${loopback.address().port}/probe`;

try {
  await setMode("online");

  // (a) ONLINE + https to a prohibited host: connect-time refusal, no tunnel.
  {
    const r = await curl("https://discord.com/");
    const evs = events().filter((e) => e.host === "discord.com");
    const refusal = evs.filter((e) => e.kind === "connect" && e.allowed === false && typeof e.refused === "string");
    const forwarded = evs.filter((e) => e.kind !== "connect");
    check(
      "online: CONNECT discord.com refused with a refusal event",
      r.exit !== 0 && refusal.length > 0,
      `curl exit ${r.exit}; events: ${JSON.stringify(evs)}`,
    );
    check(
      "online: discord.com — no upstream socket, nothing forwarded",
      forwarded.length === 0,
      forwarded.length ? `unexpected events: ${JSON.stringify(forwarded)}` : "no tunnel/bytes/error events",
    );
  }

  // (b) ONLINE + https to a documented public-asset host: passes through.
  {
    const r = await curl("https://github.com/", ["-o", "/dev/null"]);
    const evs = () => events().filter((e) => e.host === "github.com");
    const allowed = evs().some((e) => e.kind === "connect" && e.allowed === true);
    const bytes = await waitFor(() => evs().some((e) => e.kind === "tunnel-bytes" && (e.received ?? 0) > 0));
    check(
      "online: CONNECT github.com (documented) allowed and forwarded",
      r.exit === 0 && allowed && bytes !== null,
      `curl exit ${r.exit}; events: ${JSON.stringify(evs())}`,
    );
  }

  // (c) ONLINE + plain http to a prohibited host: refused before forwarding.
  {
    const r = await curl("http://example.com/");
    const evs = events().filter((e) => e.host === "example.com");
    const refusal = evs.filter((e) => e.kind === "http" && e.allowed === false);
    const upstream = evs.filter((e) => e.kind === "http-response" || e.kind === "http-response-final" || e.kind === "http-error");
    check(
      "online: plain http example.com refused, body says so, no upstream request",
      r.exit === 0 && r.output.includes("egress witness: refused") && refusal.length > 0 && upstream.length === 0,
      `curl exit ${r.exit}; body=${JSON.stringify(r.output.slice(0, 80))}; events: ${JSON.stringify(evs)}`,
    );
  }

  // (d) ONLINE + loopback via the proxy: still allowed in every mode.
  {
    const r = await curl(loopbackUrl);
    const evs = events().filter((e) => e.host === `127.0.0.1:${loopback.address().port}` || e.host === "127.0.0.1");
    const allowed = evs.some((e) => e.kind === "http" && e.allowed === true);
    check(
      "online: loopback http via the proxy allowed",
      r.exit === 0 && r.output.includes("loopback-ok") && allowed,
      `curl exit ${r.exit}; body=${JSON.stringify(r.output.slice(0, 40))}; events: ${JSON.stringify(evs)}`,
    );
  }

  await setMode("offline");

  // (e) OFFLINE + https prohibited host: still refused.
  {
    const r = await curl("https://discord.com/");
    const evs = events().filter((e) => e.host === "discord.com" && e.mode === "offline");
    const refusal = evs.filter((e) => e.kind === "connect" && e.allowed === false);
    const forwarded = evs.filter((e) => e.kind !== "connect");
    check(
      "offline: CONNECT discord.com still refused, nothing forwarded",
      r.exit !== 0 && refusal.length > 0 && forwarded.length === 0,
      `curl exit ${r.exit}; events: ${JSON.stringify(evs)}`,
    );
  }

  // (f) OFFLINE + documented host: still passes (pre-existing behavior).
  {
    const r = await curl("https://github.com/", ["-o", "/dev/null"]);
    const evs = events().filter((e) => e.host === "github.com" && e.mode === "offline");
    const allowed = evs.some((e) => e.kind === "connect" && e.allowed === true);
    check("offline: CONNECT github.com (documented) still allowed", r.exit === 0 && allowed, `curl exit ${r.exit}; events: ${JSON.stringify(evs)}`);
  }
} finally {
  child.kill("SIGTERM");
  loopback.close();
}

if (failures.length > 0) {
  console.error(`PROBE FAIL: ${failures.length} assertion(s) failed: ${failures.join("; ")}`);
  console.error(`evidence log preserved at ${LOG}`);
  process.exit(1);
}
console.log(`PROBE OK — all fail-closed assertions held; raw event log: ${LOG}`);
