#!/usr/bin/env node
// Stack supervisor for the real-journeys harness.
//
// Starts and supervises, in order:
//   1. The provider doubles (GitHub REST, GitHub OAuth, Discord, Modal
//      runner): stateful HTTP servers speaking each provider's protocol,
//      labelled on every response via the `x-cogportal-double` header.
//   2. The portal itself: the SPA built for production and served the way
//      deployment serves it — built Worker + assets through the repo's own
//      Cloudflare Vite preview path — with a fresh local D1 (every migration
//      applied, then scripts/seed-local.sql, the VISION26 cohort).
//   3. A network-shaping proxy in front of the Worker. The browser only ever
//      talks to the proxy. The app's own requests are never stubbed here:
//      the proxy forwards real traffic and can delay, drop, duplicate,
//      reorder or fail it under test control.
//
// Playwright starts this once (webServer) and waits for /__stack/health.
// Tests drive everything else through the control endpoints documented in
// README.md: fresh D1 per journey, fault rules, profile boots, direct SQL.

import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDoubles, DOUBLE_PORTS } from "./doubles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const PORTAL_DIR = path.join(REPO_ROOT, "apps", "portal");
const LOG_DIR = path.resolve(HERE, "..", "test-results", "stack-logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

const PROXY_PORT = 8810;
const PORTAL_PORT = 4173;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

const RUNNER_SIGNING_SECRET = "rj-local-runner-signing-secret-0001";
const BETTER_AUTH_SECRET = "rj-local-better-auth-secret-0000000000000000";
const ACTIVITY_SESSION_SECRET = "rj-local-activity-session-secret-0000000000";

const logFile = path.join(LOG_DIR, "stack.log");
const say = (line) => {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  if (process.env.RJ_VERBOSE) console.log(line);
};

// ── .dev.vars ──────────────────────────────────────────────────────────────
// Written on every boot; the file is gitignored and never committed. Values
// follow apps/portal/.dev.vars.example. Dev auth is the test session
// mechanism (the Worker refuses it unless ENVIRONMENT=development,
// DEV_AUTH=enabled and GitHub OAuth is unset). The provider base-URL
// overrides point the Worker's real outbound code at the doubles.
function devVars(profile) {
  const fixture = profile !== "modal-double";
  return [
    'ENVIRONMENT="development"',
    'DEV_AUTH="enabled"',
    'ONBOARDING_DEV_TOOLS="enabled"',
    `EXECUTION_PROVIDER="${fixture ? "fixture" : "modal"}"`,
    `BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET}"`,
    `BETTER_AUTH_URL="${BASE}"`,
    `PUBLIC_ORIGIN="${BASE}"`,
    'GITHUB_CLIENT_ID=""',
    'GITHUB_CLIENT_SECRET=""',
    'GITHUB_APP_SLUG=""',
    'GITHUB_WEBHOOK_SECRET=""',
    'GITHUB_TEMPLATE_REPO=""',
    'GITHUB_TEMPLATE_REPO_ID=""',
    // Dev accounts resolve roles by account name (a dev account never claims
    // a github_login), so a login named below is an owner in this harness.
    'PLATFORM_OWNER_LOGINS="owner-person,second-owner"',
    // A synthetic guild id: nothing here may ever reach the course's guild,
    // and the Discord double owns every call this token could make.
    'COURSE_GUILD_ID="1111111111111111111"',
    'DISCORD_BOT_TOKEN="rj-local-bot-token"',
    'DISCORD_CLIENT_ID="rj-local-discord-client-id"',
    'DISCORD_CLIENT_SECRET="rj-local-discord-client-secret"',
    `ACTIVITY_SESSION_SECRET="${ACTIVITY_SESSION_SECRET}"`,
    'RUNNER_SIGNING_KEY_ID="runner-v1"',
    `RUNNER_SIGNING_SECRET="${RUNNER_SIGNING_SECRET}"`,
    `DISCORD_API_BASE_URL="http://127.0.0.1:${DOUBLE_PORTS.discord}"`,
    // Sealed on every boot: a modal-double run dispatches to the loopback
    // double, never to the staging runner URL baked into wrangler.jsonc.
    `MODAL_RUNNER_URL="http://127.0.0.1:${DOUBLE_PORTS.modalRunner}"`,
    `GITHUB_API_BASE_URL="http://127.0.0.1:${DOUBLE_PORTS.githubRest}"`,
    'RUN_STALE_AFTER_SECONDS="3600"',
  ].join("\n") + "\n";
}

// The production-refusal profile: GitHub OAuth configured and dev auth off,
// exactly like a deployed worker. Used by the config test that proves
// POST /api/dev/login refuses there.
function prodVars() {
  return [
    'ENVIRONMENT="production"',
    'DEV_AUTH="disabled"',
    'ONBOARDING_DEV_TOOLS="disabled"',
    'EXECUTION_PROVIDER="modal"',
    `BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET}"`,
    `BETTER_AUTH_URL="${BASE}"`,
    `PUBLIC_ORIGIN="${BASE}"`,
    'GITHUB_CLIENT_ID="Iv23liATo0NWltd5sZgi"',
    'GITHUB_CLIENT_SECRET="rj-config-test-only"',
    'GITHUB_APP_SLUG="cog-portal-beta"',
    'PLATFORM_OWNER_LOGINS="owner-person"',
    `RUNNER_SIGNING_KEY_ID="runner-v1"`,
    `RUNNER_SIGNING_SECRET="${RUNNER_SIGNING_SECRET}"`,
  ].join("\n") + "\n";
}

const DEV_VARS_PATH = path.join(PORTAL_DIR, ".dev.vars");
let profile = "fixture";

function writeDevVars(nextProfile) {
  profile = nextProfile;
  fs.writeFileSync(DEV_VARS_PATH, nextProfile === "production-refusal" ? prodVars() : devVars(nextProfile));
}

// ── D1 lifecycle ───────────────────────────────────────────────────────────
// One local D1 per journey: wipe the persist state, apply every migration,
// seed the VISION26 cohort. The state lives under apps/portal/.wrangler/
// (see CLAUDE.md), shared by the wrangler CLI and the Vite plugin's runtime.
const STATE_DIR = path.join(PORTAL_DIR, ".wrangler", "state");

function run(argv, opts = {}) {
  say(`$ ${argv.join(" ")}`);
  return execFileSync(argv[0], argv.slice(1), {
    cwd: PORTAL_DIR,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  }).toString();
}

// Spawn wrangler from the portal's own node_modules instead of shelling out
// through pnpm: a global pnpm on PATH is an environment dependency the
// supervisor does not need, and its absence kills every D1 step with
// spawnSync ENOENT before the stack can boot.
const WRANGLER_BIN = path.join(PORTAL_DIR, "node_modules", ".bin", "wrangler");
const VITE_BIN = path.join(PORTAL_DIR, "node_modules", ".bin", "vite");

function pnpmWrangler(args) {
  return run([WRANGLER_BIN, ...args]);
}

function freshD1({ seed = true } = {}) {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  pnpmWrangler(["d1", "migrations", "apply", "cogportal-db", "--local"]);
  if (seed) {
    pnpmWrangler(["d1", "execute", "cogportal-db", "--local", "--file", "scripts/seed-local.sql"]);
  }
}

function sqlD1(command) {
  return pnpmWrangler(["d1", "execute", "cogportal-db", "--local", "--command", command, "--json"]);
}

// ── SPA build (production, the way deployment serves it) ──────────────────
function buildSpa() {
  say("building the SPA for production");
  run([VITE_BIN, "build"], {
    env: {
      VITE_PORTAL_ORIGIN: BASE,
      VITE_ACTIVITY_HOSTNAME: "cogactivity-dev.sillion.app",
    },
  });
  run(["node", "scripts/scrub-dist-secrets.mjs"]);
}

// ── The Worker + assets process ────────────────────────────────────────────
let preview = null;
let previewLog = null;

function portAlive(port) {
  try {
    execFileSync("bash", ["-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function waitForDead(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (portAlive(port)) {
    if (Date.now() > deadline) {
      say(`warning: port ${port} still accepting connections; continuing`);
      return;
    }
    const spinUntil = Date.now() + 150;
    while (Date.now() < spinUntil) {}
  }
}

function stopPreview() {
  if (preview) {
    say("stopping the Worker preview");
    preview.kill("SIGTERM");
    preview = null;
    waitForDead(PORTAL_PORT);
  }
}

function startPreview() {
  say(`starting the Worker preview on ${PORTAL_PORT}`);
  previewLog = fs.openSync(path.join(LOG_DIR, "preview.log"), "a");
  preview = spawn(VITE_BIN, ["preview", "--port", String(PORTAL_PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: PORTAL_DIR,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", previewLog, previewLog],
  });
  return waitHealthy(PORTAL_PORT, 120_000);
}

async function waitHealthy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/session", timeout: 4000 }, (res) => {
        res.resume();
        resolve(res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`worker on ${port} never became healthy`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── The network-shaping proxy ──────────────────────────────────────────────
// Real traffic only. Rules are per-request: the first matching rule applies.
// Actions: delayMs (hold the request), drop (lose the connection),
// status (substitute the upstream status), body (substitute the body),
// duplicateUpstream (send the same request upstream N extra times), times
// (how many requests the rule fires on, default unlimited).
const faultRules = [];
const rulesMatch = (method, pathname) =>
  faultRules.find(
    (rule) =>
      (!rule.method || rule.method === method) &&
      (!rule.path || new RegExp(rule.path).test(pathname)) &&
      (rule.times === undefined || rule.times > 0),
  );

function consumeRule(rule) {
  if (rule && rule.times !== undefined) rule.times -= 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proxy = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  if (url.pathname === "/__stack/health" || url.pathname.startsWith("/__control/") || url.pathname.startsWith("/__proxy/")) {
    return control(req, res, url);
  }
  proxyPass(req, res, url);
});

async function proxyPass(req, res, url) {
  const rule = rulesMatch(req.method, url.pathname);
  consumeRule(rule);
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);
  try {
    if (rule?.delayMs) await sleep(rule.delayMs);
    if (rule?.drop) {
      say(`[proxy] dropping ${req.method} ${url.pathname} (rule ${rule.id ?? ""})`);
      req.socket.destroy();
      return;
    }
    const headers = { ...req.headers };
    delete headers["content-length"];
    // Extra upstream sends: the Worker sees the same request twice or more,
    // the client sees the first answer. This is what a retried POST looks
    // like to a server that cannot tell retries from double clicks.
    const sends = 1 + (rule?.duplicateUpstream ?? 0);
    let firstResponse = null;
    for (let index = 0; index < sends; index += 1) {
      firstResponse = await upstreamOnce(req, url, headers, body, rule);
    }
    let payload = firstResponse.body;
    if (rule?.body !== undefined) payload = Buffer.from(rule.body);
    const outHeaders = { ...firstResponse.headers };
    // A buffered body can restate content-length truthfully; a streamed one
    // (SSE run surfaces) keeps the upstream framing and is piped through.
    if (Buffer.isBuffer(payload) && outHeaders["content-length"] !== undefined) {
      outHeaders["content-length"] = String(Buffer.byteLength(payload));
    }
    res.writeHead(rule?.status ?? firstResponse.statusCode, outHeaders);
    if (Buffer.isBuffer(payload)) {
      res.end(payload);
    } else {
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

function upstreamOnce(req, url, headers, body, rule) {
  return new Promise((resolve, reject) => {
    const up = http.request(
      { host: "127.0.0.1", port: PORTAL_PORT, method: req.method, path: url.pathname + url.search, headers },
      (upres) => {
        // Streams (SSE run surfaces) pass through untouched unless a rule
        // needs the whole body to rewrite it.
        const needsBuffer = rule?.status !== undefined || rule?.body !== undefined;
        if (needsBuffer) {
          const chunks = [];
          upres.on("data", (c) => chunks.push(c));
          upres.on("end", () => resolve({ statusCode: upres.statusCode, headers: upres.headers, body: Buffer.concat(chunks) }));
          upres.on("error", reject);
        } else {
          resolve({ statusCode: upres.statusCode, headers: upres.headers, body: upres });
        }
      },
    );
    up.on("error", reject);
    up.end(body);
  });
}

// ── Control plane ──────────────────────────────────────────────────────────
let bootLock = Promise.resolve();
let lastFreshAt = null;

function withBootLock(fn) {
  const run = bootLock.then(fn);
  bootLock = run.catch(() => {});
  return run;
}

function control(req, res, url) {
  const readBody = () =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

  const reply = (code, payload) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === "/__stack/health") {
    return reply(200, {
      status: "ok",
      profile,
      base: BASE,
      doubles: DOUBLE_PORTS,
      lastFreshAt,
      previewRunning: preview !== null,
    });
  }

  if (url.pathname === "/__proxy/faults" && req.method === "POST") {
    return readBody().then((body) => {
      const parsed = JSON.parse(body || "{}");
      if (Array.isArray(parsed.rules)) faultRules.push(...parsed.rules);
      reply(200, { rules: faultRules.length });
    });
  }
  if (url.pathname === "/__proxy/faults/clear" && req.method === "POST") {
    faultRules.length = 0;
    return reply(200, { rules: 0 });
  }

  if (url.pathname === "/__control/fresh" && req.method === "POST") {
    return readBody()
      .then((body) => JSON.parse(body || "{}"))
      .then(({ nextProfile }) =>
        withBootLock(async () => {
          stopPreview();
          writeDevVars(nextProfile ?? (profile === "production-refusal" ? "fixture" : profile));
          buildSpa();
          freshD1({});
          await startPreview();
          lastFreshAt = Date.now();
          say("fresh journey stack is up");
        }),
      )
      .then(() => reply(200, { ok: true, profile }))
      .catch((error) => reply(500, { error: error.message }));
  }

  if (url.pathname === "/__control/restart-worker" && req.method === "POST") {
    return withBootLock(async () => {
      stopPreview();
      await startPreview();
      say("Worker restarted mid-journey (state kept)");
    })
      .then(() => reply(200, { ok: true }))
      .catch((error) => reply(500, { error: error.message }));
  }

  if (url.pathname === "/__control/prod-boot" && req.method === "POST") {
    return withBootLock(async () => {
      stopPreview();
      writeDevVars("production-refusal");
      buildSpa();
      freshD1({ seed: false });
      await startPreview();
      say("production-refusal worker is up");
    })
      .then(() => reply(200, { ok: true, profile }))
      .catch((error) => reply(500, { error: error.message }));
  }

  if (url.pathname === "/__control/dev-boot" && req.method === "POST") {
    return withBootLock(async () => {
      stopPreview();
      writeDevVars("fixture");
      buildSpa();
      freshD1({});
      await startPreview();
    })
      .then(() => reply(200, { ok: true, profile }))
      .catch((error) => reply(500, { error: error.message }));
  }

  if (url.pathname === "/__control/sql" && req.method === "POST") {
    return readBody()
      .then((body) => JSON.parse(body).sql)
      .then((sql) => {
        const out = sqlD1(sql);
        reply(200, { ok: true, output: out.slice(-4000) });
      })
      .catch((error) => reply(500, { error: error.message }));
  }

  reply(404, { error: `no control route ${url.pathname}` });
}

// ── Boot ───────────────────────────────────────────────────────────────────
// ── Loopback-only provider guard ───────────────────────────────────────────
// The stack must be physically unable to reach non-loopback providers: if a
// provider URL env is set off-loopback, refuse to start. This catches a
// staging or production provider URL leaking into a local harness boot.
const PROVIDER_URL_ENVS = ["GITHUB_API_BASE_URL", "DISCORD_API_BASE_URL", "MODAL_RUNNER_URL"];

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function assertLoopbackProviderUrls() {
  const offenders = PROVIDER_URL_ENVS.filter((name) => {
    const value = process.env[name];
    return value !== undefined && value !== "" && !isLoopbackUrl(value);
  });
  if (offenders.length > 0) {
    console.error(
      "[stack] refusing to start: provider URL env vars must be unset or loopback\n" +
        offenders.map((name) => `  ${name}=${process.env[name]}`).join("\n"),
    );
    process.exit(1);
  }
}

async function main() {
  assertLoopbackProviderUrls();
  say(`stack supervisor starting; repo root ${REPO_ROOT}`);

  const doubles = createDoubles({ log: say });
  for (const double of Object.values(doubles)) {
    if (!double.start) continue;
    await double.start();
  }
  say("provider doubles up (labelled): " + Object.values(doubles).filter((d) => d.label).map((d) => d.label).join(", "));

  writeDevVars("fixture");
  buildSpa();
  freshD1({});
  await startPreview();
  lastFreshAt = Date.now();

  await new Promise((resolve, reject) => {
    proxy.on("error", reject);
    proxy.listen(PROXY_PORT, "127.0.0.1", resolve);
  });
  say(`shaping proxy listening on ${BASE}`);

  const shutdown = () => {
    say("shutting down");
    stopPreview();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  say(`fatal: ${error.stack ?? error}`);
  console.error(error);
  process.exit(1);
});
