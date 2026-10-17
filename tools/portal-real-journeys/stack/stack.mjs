#!/usr/bin/env node
// Stack supervisor for the real-journeys harness. Playwright starts it as its
// webServer and waits for /__stack/health.
//
// What it runs, all on loopback:
//   - the provider doubles and the hops in front of them (doubles.mjs);
//   - the portal: the SPA and the Worker built for production by the repo's
//     own Vite + Cloudflare plugin, served by `vite preview`, over a local
//     D1 with every migration and scripts/seed-local.sql applied;
//   - a shaping proxy in front of the Worker. The browser talks only to the
//     proxy, which forwards real traffic and can delay, drop or duplicate it.
//
// Everything a boot writes lives in one run-owned directory outside the
// checkout (RJ_RUN_DIR, default a fresh temp dir): the generated wrangler
// config, the build output, and the D1/R2/Durable Object state. The checkout's
// apps/portal/.dev.vars, apps/portal/.wrangler and apps/portal/dist are never
// read or written, so a run cannot change a developer's own dev setup and a
// developer's setup cannot change a run. The run directory links to the
// checkout's sources (src, worker, migrations, node_modules) read-only.
//
// Every boot is sealed (seal.mjs): after building, the supervisor reads the
// vars wrangler will hand the preview Worker and refuses to start it unless
// every provider URL is loopback and nothing names a deployed identity. After
// the Worker is up it asks the Worker which execution provider it got.

import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDoubles, DOUBLE_PORTS, HOP_PORTS, PROVIDER_URLS } from "./doubles.mjs";
import {
  PROFILE_EXPECTATIONS,
  bindingViolations,
  builtWorkerConfigPath,
  deployedIdentities,
  effectivePreviewVars,
  profileVars,
  readPortalConfig,
  runWranglerConfig,
  sealViolations,
  writeJson,
} from "./seal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const PORTAL_DIR = path.join(REPO_ROOT, "apps", "portal");
const LOG_DIR = path.resolve(HERE, "..", "test-results", "stack-logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

export const PROXY_PORT = 8810;
const PORTAL_PORT = 4173;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

// Real path: on macOS the temp dir is under /var, a link to /private/var,
// and Vite rejects an entry whose resolved path leaves its root.
function makeRunDir() {
  if (!process.env.RJ_RUN_DIR) return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cogportal-rj-")));
  const dir = path.resolve(process.env.RJ_RUN_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}
const RUN_DIR = makeRunDir();
const STATE_DIR = path.join(RUN_DIR, ".wrangler", "state");
const RUN_CONFIG = path.join(RUN_DIR, "wrangler.jsonc");
const VITE_CONFIG = path.join(RUN_DIR, "vite.config.mjs");
const VITE_BIN = path.join(PORTAL_DIR, "node_modules", ".bin", "vite");
const WRANGLER_BIN = path.join(PORTAL_DIR, "node_modules", ".bin", "wrangler");

if (RUN_DIR === PORTAL_DIR || RUN_DIR.startsWith(`${PORTAL_DIR}${path.sep}`)) {
  throw new Error(`RJ_RUN_DIR must be outside the checkout's portal (${PORTAL_DIR})`);
}

const logFile = path.join(LOG_DIR, "stack.log");
const say = (line) => {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  if (process.env.RJ_VERBOSE) console.log(line);
};

// Child processes get an allowlisted environment. Wrangler layers
// process.env onto Worker vars when CLOUDFLARE_INCLUDE_PROCESS_ENV is set and
// picks a config environment from CLOUDFLARE_ENV, so none of the caller's
// CLOUDFLARE_*, WRANGLER_* or Worker var names reach a build or a boot.
const PASS_THROUGH = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "SHELL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"];
function childEnv(extra = {}) {
  const env = {};
  for (const name of PASS_THROUGH) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_D1_WARNING: "true", ...extra };
}

function run(argv, opts = {}) {
  say(`$ ${argv.join(" ")}`);
  try {
    return execFileSync(argv[0], argv.slice(1), {
      cwd: RUN_DIR,
      env: childEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch (error) {
    // wrangler may print the real failure on either stream (workerd's
    // SQLITE_BUSY goes to stderr; some wrangler errors go to stdout).
    // Surface both tails so the caller — and the /__control/sql 500 body —
    // names the reason instead of a bare "Command failed".
    const tail = (s) => String(s ?? "").trimEnd().slice(-1500);
    const detail = [tail(error.stderr), tail(error.stdout)].filter(Boolean).map((s) => `\n${s}`).join("");
    throw new Error(`Command failed: ${argv.join(" ")}${detail}`, { cause: error });
  }
}

// ── The run directory ──────────────────────────────────────────────────────
// index.html is copied, not linked: Vite emits the page under the path it
// resolves to, and a link out of the root resolves outside it.
const COPIED = ["index.html"];
const LINKED = [
  "src",
  "public",
  "worker",
  "migrations",
  "scripts",
  "node_modules",
  "package.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "tsconfig.worker.json",
];

function prepareRunDir() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  for (const name of COPIED) fs.copyFileSync(path.join(PORTAL_DIR, name), path.join(RUN_DIR, name));
  for (const name of LINKED) {
    const link = path.join(RUN_DIR, name);
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(PORTAL_DIR, name), link);
  }
  for (const stray of [".dev.vars", ".env", ".env.local"]) {
    if (fs.existsSync(path.join(RUN_DIR, stray))) throw new Error(`run directory carries ${stray}; refusing to build`);
  }
  // Same plugins as apps/portal/vite.config.ts, pointed at the run's own
  // config and state.
  fs.writeFileSync(
    VITE_CONFIG,
    `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  root: ${JSON.stringify(RUN_DIR)},
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({
      configPath: ${JSON.stringify(RUN_CONFIG)},
      persistState: { path: ${JSON.stringify(STATE_DIR)} },
      inspectorPort: false,
    }),
  ],
  resolve: { alias: { "@": ${JSON.stringify(path.join(PORTAL_DIR, "src"))} } },
});
`,
  );
}

let portalConfig = null;
let deployed = new Set();
let profile = null;

async function writeRunConfig(nextProfile) {
  const vars = profileVars(nextProfile, {
    base: BASE,
    providerUrls: PROVIDER_URLS,
  });
  const config = runWranglerConfig({ portalConfig, portalDir: PORTAL_DIR, vars });
  const problems = bindingViolations(config);
  if (problems.length) throw new Error(`run config refused:\n  ${problems.join("\n  ")}`);
  writeJson(RUN_CONFIG, config);
}

function build() {
  say(`building SPA and Worker into ${path.join(RUN_DIR, "dist")}`);
  run([VITE_BIN, "build", "--config", VITE_CONFIG], {
    // The SPA picks the Activity bundle by host name; "localhost" is the
    // Activity's host in a run, 127.0.0.1 the portal's. The client id is the
    // run's synthetic one, never the course application's.
    env: { VITE_PORTAL_ORIGIN: BASE, VITE_ACTIVITY_HOSTNAME: "localhost", VITE_DISCORD_CLIENT_ID: "rj-local-discord-client-id" },
  });
}

/** Refuses to continue unless the preview Worker's effective vars are sealed. */
async function assertSealed(expectedProfile) {
  const builtConfigPath = builtWorkerConfigPath(RUN_DIR, portalConfig.name);
  const { vars, config } = await effectivePreviewVars({ portalDir: PORTAL_DIR, builtConfigPath });
  const violations = [
    ...sealViolations(vars, { deployed, expected: PROFILE_EXPECTATIONS[expectedProfile] }),
    ...bindingViolations(config),
  ];
  if (violations.length) {
    throw new Error(`refusing to boot the ${expectedProfile} Worker:\n  ${violations.join("\n  ")}`);
  }
  say(`sealed: ${expectedProfile} Worker vars resolve to loopback providers (${Object.keys(vars).length} vars)`);
}

// ── D1 ─────────────────────────────────────────────────────────────────────
function wrangler(args) {
  return run([WRANGLER_BIN, ...args, "--config", RUN_CONFIG, "--persist-to", STATE_DIR]);
}

function freshState({ seed }) {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  wrangler(["d1", "migrations", "apply", "cogportal-db", "--local"]);
  if (seed) wrangler(["d1", "execute", "cogportal-db", "--local", "--file", path.join(PORTAL_DIR, "scripts", "seed-local.sql")]);
}

// The control plane runs wrangler against the same SQLite file the live
// Worker holds open, so a statement can land on a transient failure: a WAL
// snapshot race (workerd answers SQLITE_BUSY or "database is locked") or
// workerd's D1 wrapper surfacing that race as an opaque "internal error;
// reference = ..." (jsgInternalError). The identical statement passes on
// the next attempt, so those texts — and only those — are retried a few
// times with a growing pause; every other failure throws on attempt one.
const TRANSIENT_D1 = [/SQLITE_BUSY/, /database is locked/, /internal error; reference = /];
function withD1Retry(runStatement) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return runStatement();
    } catch (error) {
      const message = String(error?.message ?? error);
      if (attempt >= 3 || !TRANSIENT_D1.some((pattern) => pattern.test(message))) throw error;
      say(`[control] transient D1 failure (attempt ${attempt}), retrying: ${message.split("\n")[0].slice(0, 160)}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * attempt);
    }
  }
}

function sql(command) {
  const out = withD1Retry(() => wrangler(["d1", "execute", "cogportal-db", "--local", "--command", command, "--json"]));
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed.at(-1)?.results ?? [];
}

/** Every row of every application table, in one wrangler call: { table: rows }. */
function snapshot() {
  const tables = sql(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name",
  ).map((row) => row.name);
  const out = withD1Retry(() =>
    wrangler(["d1", "execute", "cogportal-db", "--local", "--command", tables.map((t) => `SELECT * FROM "${t}"`).join("; "), "--json"]),
  );
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  if (parsed.length !== tables.length) throw new Error(`snapshot read ${parsed.length} result sets for ${tables.length} tables`);
  return Object.fromEntries(tables.map((table, i) => [table, parsed[i].results ?? []]));
}

// ── The Worker preview ─────────────────────────────────────────────────────
let preview = null;

function waitForPortClosed(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = () => {
      const socket = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1000 }, (res) => {
        res.resume();
        retry();
      });
      socket.on("error", () => resolve());
      socket.on("timeout", () => {
        socket.destroy();
        retry();
      });
    };
    const retry = () => (Date.now() > deadline ? resolve() : setTimeout(probe, 200));
    probe();
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(true);
    });
  });
}

/** Signals vite and the workerd it started; workerd is vite's child. */
function signalPreview(child, signal) {
  try {
    execFileSync("pkill", [`-${signal}`, "-P", String(child.pid)], { stdio: "ignore" });
  } catch {
    // no children left
  }
  try {
    process.kill(child.pid, `SIG${signal}`);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function stopPreview() {
  if (!preview) return;
  say("stopping the Worker preview");
  const child = preview;
  preview = null;
  const exited = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
  signalPreview(child, "TERM");
  const forced = setTimeout(() => signalPreview(child, "KILL"), 5_000);
  await exited;
  clearTimeout(forced);
  await waitForPortClosed(PORTAL_PORT, 10_000);
  if (await portOpen(PORTAL_PORT)) {
    throw new Error(`port ${PORTAL_PORT} is still answering after the preview stopped; another process holds it`);
  }
}

function getJson(port, pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 4000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function startPreview(expectedProfile) {
  await assertSealed(expectedProfile);
  // Whatever answers on this port is what every journey talks to, so it has
  // to be the preview started here. A leftover from another run would serve
  // its own build and its own database.
  if (await portOpen(PORTAL_PORT)) {
    throw new Error(`port ${PORTAL_PORT} is already in use; stop the process holding it before running the journeys`);
  }
  say(`starting the Worker preview on ${PORTAL_PORT}`);
  const log = fs.openSync(path.join(LOG_DIR, "preview.log"), "a");
  const spawnPreview = () =>
    spawn(VITE_BIN, ["preview", "--config", VITE_CONFIG, "--port", String(PORTAL_PORT), "--strictPort", "--host", "127.0.0.1"], {
      cwd: RUN_DIR,
      env: childEnv(),
      stdio: ["ignore", log, log],
    });
  preview = spawnPreview();
  let child = preview;
  let restarted = false;
  let deadline = Date.now() + 180_000;
  for (;;) {
    const session = await getJson(PORTAL_PORT, "/api/session");
    if (session && session.status < 500 && session.body?.auth) {
      // The Worker's own account of its configuration, after it booted.
      const provider = session.body.auth.executionProvider;
      const wanted = PROFILE_EXPECTATIONS[expectedProfile].EXECUTION_PROVIDER;
      if (provider !== wanted) {
        await stopPreview();
        throw new Error(`the ${expectedProfile} Worker reports EXECUTION_PROVIDER=${provider}, expected ${wanted}`);
      }
      return;
    }
    if (child.exitCode !== null) throw new Error(`the preview exited with ${child.exitCode}; see test-results/stack-logs/preview.log`);
    if (Date.now() > deadline) {
      if (restarted) throw new Error(`the Worker on ${PORTAL_PORT} never answered /api/session`);
      restarted = true;
      say("the Worker preview missed the /api/session deadline; restarting it once");
      child.kill("SIGTERM");
      await waitForPortClosed(PORTAL_PORT, 20_000);
      preview = spawnPreview();
      child = preview;
      deadline = Date.now() + 180_000;
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** A fresh database and a Worker in `nextProfile`, building only on a profile change. */
async function boot(nextProfile) {
  await stopPreview();
  if (nextProfile !== profile) {
    await writeRunConfig(nextProfile);
    build();
    profile = nextProfile;
  }
  freshState({ seed: nextProfile !== "production-refusal" });
  await startPreview(nextProfile);
  say(`fresh ${nextProfile} stack is up`);
}

// ── The shaping proxy ──────────────────────────────────────────────────────
// Real traffic only. The first matching rule applies. Actions: delayMs, drop
// (destroy the connection before forwarding: a lost request), dropResponse
// (forward, then destroy the connection: a lost answer), status/body
// (substitute the answer),
// duplicateUpstream (send the same request n extra times; the client gets the
// first answer), holdAnswer (a tag: forward at once, then keep the Worker's
// answer until POST /__proxy/release {tag}; GET /__proxy/held lists what is
// held), times (how many requests the rule fires on).
const faultRules = [];
/** tag -> { method, path, status, release } for answers held by holdAnswer. */
const heldAnswers = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function matchRule(method, pathname) {
  const rule = faultRules.find(
    (candidate) =>
      (!candidate.method || candidate.method === method) &&
      (!candidate.path || new RegExp(candidate.path).test(pathname)) &&
      (candidate.times === undefined || candidate.times > 0),
  );
  if (rule && rule.times !== undefined) rule.times -= 1;
  return rule;
}

function upstreamOnce(req, url, headers, body, buffer) {
  return new Promise((resolve, reject) => {
    const up = http.request(
      { host: "127.0.0.1", port: PORTAL_PORT, method: req.method, path: url.pathname + url.search, headers },
      (upres) => {
        if (!buffer) return resolve({ statusCode: upres.statusCode, headers: upres.headers, body: upres });
        const chunks = [];
        upres.on("data", (chunk) => chunks.push(chunk));
        upres.on("end", () => resolve({ statusCode: upres.statusCode, headers: upres.headers, body: Buffer.concat(chunks) }));
        upres.on("error", reject);
      },
    );
    up.on("error", reject);
    up.end(body);
  });
}

// Discord's proxy double. Inside Discord an Activity reaches its own server
// through `/.proxy/…` on its discordsays.com origin, and Discord forwards the
// rest of the path to the app's URL mapping (`/` to the Activity host). The
// Activity bundle calls `/.proxy/api/…` whenever it is embedded, so on the
// Activity's host here the prefix is stripped the same way before forwarding,
// and the answer is labelled as having passed the double.
const DISCORD_PROXY_PREFIX = "/.proxy/";
function discordProxyMapping(req, url) {
  const host = (req.headers.host ?? "").split(":")[0];
  if (host !== "localhost" || !url.pathname.startsWith(DISCORD_PROXY_PREFIX)) return null;
  const mapped = new URL(url);
  mapped.pathname = url.pathname.slice(DISCORD_PROXY_PREFIX.length - 1);
  return mapped;
}

async function proxyPass(req, res, originalUrl) {
  const mapped = discordProxyMapping(req, originalUrl);
  const url = mapped ?? originalUrl;
  if (mapped) res.setHeader("x-cogportal-double", "discord-proxy");
  const rule = matchRule(req.method, url.pathname);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  try {
    if (rule?.delayMs) await sleep(rule.delayMs);
    if (rule?.drop) {
      say(`[proxy] dropping ${req.method} ${url.pathname}`);
      req.socket.destroy();
      return;
    }
    const headers = { ...req.headers };
    // Buffer when a rule rewrites the answer or when extra sends follow (the
    // first answer has to be held while they go out); otherwise stream, so
    // server-sent events stay live.
    const buffer = rule?.status !== undefined || rule?.body !== undefined || (rule?.duplicateUpstream ?? 0) > 0 || Boolean(rule?.holdAnswer);
    const first = await upstreamOnce(req, url, headers, body, buffer || Boolean(rule?.dropResponse));
    for (let extra = 0; extra < (rule?.duplicateUpstream ?? 0); extra += 1) {
      await upstreamOnce(req, url, headers, body, true);
    }
    if (rule?.holdAnswer) {
      // The Worker has handled the request; its answer waits here.
      const tag = rule.holdAnswer;
      say(`[proxy] holding the answer to ${req.method} ${url.pathname} (${first.statusCode}) as ${tag}`);
      await new Promise((release) => heldAnswers.set(tag, { method: req.method, path: url.pathname, status: first.statusCode, release }));
      heldAnswers.delete(tag);
    }
    if (rule?.dropResponse) {
      // The Worker handled the request; its answer never reaches the browser.
      say(`[proxy] dropping the answer to ${req.method} ${url.pathname} (${first.statusCode})`);
      req.socket.destroy();
      return;
    }
    const outHeaders = { ...first.headers };
    let payload = first.body;
    if (rule?.body !== undefined) payload = Buffer.from(rule.body);
    if (Buffer.isBuffer(payload)) {
      delete outHeaders["transfer-encoding"];
      outHeaders["content-length"] = String(payload.byteLength);
      res.writeHead(rule?.status ?? first.statusCode, outHeaders);
      res.end(payload);
    } else {
      res.writeHead(rule?.status ?? first.statusCode, outHeaders);
      payload.pipe(res);
    }
  } catch (error) {
    say(`[proxy] upstream failure for ${req.method} ${url.pathname}: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "proxy_upstream_failure", detail: error.message }));
    } else {
      res.end();
    }
  }
}

// ── Control plane ──────────────────────────────────────────────────────────
let bootLock = Promise.resolve();
function withBootLock(fn) {
  const next = bootLock.then(fn);
  bootLock = next.catch(() => {});
  return next;
}

async function control(req, res, url) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  const reply = (code, payload) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  try {
    const body = text ? JSON.parse(text) : {};
    if (url.pathname === "/__stack/health") {
      return reply(200, { status: "ok", profile, base: BASE, runDir: RUN_DIR, doubles: DOUBLE_PORTS, hops: HOP_PORTS, previewRunning: preview !== null });
    }
    if (url.pathname === "/__proxy/faults" && req.method === "POST") {
      faultRules.push(...(body.rules ?? []));
      return reply(200, { rules: faultRules.length });
    }
    if (url.pathname === "/__proxy/faults/clear" && req.method === "POST") {
      faultRules.length = 0;
      // Nothing stays held past the journey that held it.
      for (const entry of heldAnswers.values()) entry.release();
      return reply(200, { rules: 0 });
    }
    if (url.pathname === "/__proxy/held" && req.method === "GET") {
      return reply(200, { held: [...heldAnswers].map(([tag, { method, path: heldPath, status }]) => ({ tag, method, path: heldPath, status })) });
    }
    if (url.pathname === "/__proxy/release" && req.method === "POST") {
      const entry = heldAnswers.get(body.tag);
      if (!entry) return reply(404, { error: `no answer held as ${body.tag}` });
      entry.release();
      return reply(200, { released: body.tag });
    }
    if (url.pathname === "/__control/fresh" && req.method === "POST") {
      await withBootLock(() => boot(body.profile ?? "fixture"));
      return reply(200, { ok: true, profile });
    }
    if (url.pathname === "/__control/restart-worker" && req.method === "POST") {
      await withBootLock(async () => {
        await stopPreview();
        await startPreview(profile);
        say("Worker restarted mid-journey (state kept)");
      });
      return reply(200, { ok: true });
    }
    if (url.pathname === "/__control/sql" && req.method === "POST") {
      return reply(200, { ok: true, rows: sql(body.sql) });
    }
    if (url.pathname === "/__control/snapshot" && req.method === "POST") {
      return reply(200, { ok: true, tables: snapshot() });
    }
    return reply(404, { error: `no control route ${url.pathname}` });
  } catch (error) {
    say(`[control] ${url.pathname} failed: ${error.stack ?? error}`);
    return reply(500, { error: String(error.message ?? error) });
  }
}

const proxy = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  if (url.pathname === "/__stack/health" || url.pathname.startsWith("/__control/") || url.pathname.startsWith("/__proxy/")) {
    return void control(req, res, url);
  }
  void proxyPass(req, res, url);
});

// WebSocket upgrades (the run console's live stream) pass straight through:
// the request goes to the Worker as sent, then bytes are piped both ways.
// Fault rules don't apply to an open socket.
proxy.on("upgrade", (req, socket, head) => {
  const original = new URL(req.url, BASE);
  const url = discordProxyMapping(req, original) ?? original;
  const upstream = net.connect(PORTAL_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
});

// ── Boot ───────────────────────────────────────────────────────────────────
async function main() {
  say(`stack supervisor starting; run directory ${RUN_DIR}`);
  portalConfig = await readPortalConfig(PORTAL_DIR);
  deployed = deployedIdentities(portalConfig);
  prepareRunDir();

  const { doubles, hops } = createDoubles();
  for (const server of [...doubles, ...hops]) await server.start();
  say(`provider doubles up: ${doubles.map((d) => `${d.label}:${d.port}`).join(", ")}; hops: ${hops.map((h) => `${h.label}:${h.port}`).join(", ")}`);

  await boot("fixture");

  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(PROXY_PORT, "127.0.0.1", resolve);
  });
  say(`shaping proxy listening on ${BASE}`);

  const shutdown = async () => {
    say("shutting down");
    await stopPreview();
    if (!process.env.RJ_KEEP_RUN && !process.env.RJ_RUN_DIR) fs.rmSync(RUN_DIR, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(async (error) => {
  say(`fatal: ${error.stack ?? error}`);
  console.error(error.message ?? error);
  await stopPreview();
  if (!process.env.RJ_KEEP_RUN && !process.env.RJ_RUN_DIR) fs.rmSync(RUN_DIR, { recursive: true, force: true });
  process.exit(1);
});
