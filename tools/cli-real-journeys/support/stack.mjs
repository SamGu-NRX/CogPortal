// Boots the whole local stack for the CLI and CogBot journeys and writes the
// readiness file the journeys read (STACK_INFO):
//
//   portal   the built portal Worker (apps/portal/dist, the production build)
//            with the built SPA as its assets, on a fresh local D1, R2 and
//            Durable Object. The repo's own migrate+seed steps ran before
//            boot; this file only serves what they prepared.
//   bot      the built CogBot Worker (apps/discord-bot) bound to the portal's
//            real PortalRpc entrypoint, exactly as wrangler.jsonc declares it,
//            with a journey-only Ed25519 key.
//   shaper   a loopback proxy in front of the portal and the bot. Faults
//            (delay, 5xx, connection drop) apply to whatever passes through a
//            shaped port; nothing is answered on the Worker's behalf.
//   double   the discord-api-double: a loopback HTTP server that speaks the
//            interaction-webhook protocol and records every request. The
//            bot's outboundService points discord.com at it; nothing else is
//            intercepted.
//
// Every piece listens on loopback only. Nothing here reaches a deployed
// portal, Discord, GitHub or Modal.
import http, { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { appendFile, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// support/ → cli-real-journeys/ → tools/ → repo root.
const REPO_ROOT = join(HERE, "../../..");
const PORTAL_DIST = join(REPO_ROOT, "apps/portal/dist");
// Each run owns its persistence directory: run-all.sh points STACK_PERSIST_ROOT
// at the run's state directory -- the same root its wrangler migrate and seed
// steps use via --persist-to, under wrangler's v3 layout -- so the checkout's
// own .wrangler state (a student's normal local portal storage) is never
// read, written or deleted.
if (!process.env.STACK_PERSIST_ROOT) {
  throw new Error(
    "STACK_PERSIST_ROOT is not set; run-all.sh points it at the run's own state directory so the checkout's .wrangler state is never touched.",
  );
}
const PERSIST_ROOT = process.env.STACK_PERSIST_ROOT;
const BOT_DIST = join(REPO_ROOT, "apps/discord-bot/dist");

// miniflare is wrangler's own dependency (not a direct dep of any workspace
// package), so pnpm never hoists it and symlink-based resolution from
// wrangler's link cannot see it. Go to its real directory under .pnpm and
// take the highest version present; run-all asserts it matches the lockfile.
import { readdirSync } from "node:fs";
const pnpmDir = join(REPO_ROOT, "node_modules/.pnpm");
const mfDir = readdirSync(pnpmDir)
  .filter((name) => name.startsWith("miniflare@"))
  .sort()
  .pop();
if (!mfDir) throw new Error("miniflare not found under node_modules/.pnpm — run the repo install first");
const { Miniflare } = await import(join(pnpmDir, mfDir, "node_modules/miniflare/dist/src/index.js"));

const STACK_INFO = process.env.STACK_INFO ?? join(HERE, "../results/stack.json");
const STACK_LOG = process.env.STACK_LOG ?? join(HERE, "../results/stack.log");

const log = async (line) => {
  await appendFile(STACK_LOG, `${new Date().toISOString()} ${line}\n`).catch(() => {});
};

/** A loopback port nobody has taken yet. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ── the discord-api-double ───────────────────────────────────────────────────
// Speaks the interaction-webhook calls CogBot makes (PATCH and GET on the
// @original message) and records everything. Its log is a receipt the
// journeys read back; nothing is dropped silently.
function startDiscordDouble(logPath) {
  const requests = [];
  const messages = new Map();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const record = {
      at: Date.now(),
      method: req.method,
      path: req.url,
      body: body ? safeParse(body) : undefined,
      // Named at every use, per the README's double table.
      via: "discord-api-double",
    };
    requests.push(record);
    await appendFile(logPath, `${JSON.stringify(record)}\n`).catch(() => {});

    if (req.url.endsWith("/messages/@original")) {
      if (req.method === "PATCH" || req.method === "POST") {
        messages.set(req.url, { id: `double-${requests.length}`, body: record.body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `double-${requests.length}`, ...(record.body ?? {}) }));
        return;
      }
      if (req.method === "GET") {
        const stored = messages.get(req.url);
        res.writeHead(stored ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(stored?.body ?? { message: "Not found" }));
        return;
      }
    }
    if (req.url === "/__log__") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(requests));
      return;
    }
    if (req.url === "/__reset__" && req.method === "POST") {
      requests.length = 0;
      messages.clear();
      res.writeHead(200);
      res.end("{}");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "discord-api-double: unhandled path" }));
  });
  return { server, requests };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ── the network shaper ───────────────────────────────────────────────────────
// A fault-injecting reverse proxy. Each shaper fronts one Worker origin.
// Control lives on its own port:
//   POST /__shape__ { "mode": "delay"|"fail_5xx"|"drop"|"normal", "count": n, "ms": m }
// A mode with a count applies to the next `count` requests through the shaped
// port, then clears itself. `drop` accepts the connection and destroys the
// socket, which is what a lost response looks like to a client; `fail_5xx`
// answers without reaching the Worker, which is a failed hop, not a fake
// Worker response; `delay` holds the connection for `ms`, then sends the real
// request to the Worker and relays its real response — the fault is the wait,
// never a response the Worker did not send.
const modes = new Map(); // shapedPort -> { mode, remaining, ms }

function shapeResponse(req, res, port, forwardPort, routeHost) {
  const shape = modes.get(port);
  if (!shape || shape.remaining <= 0 || shape.mode === "normal") return false;
  shape.remaining -= 1;
  if (shape.remaining <= 0) modes.delete(port);
  if (shape.mode === "delay") {
    // Hold the request for the delay, then run the same faithful forward the
    // unshaped path uses: the Worker answers with its own status, headers and
    // body, and the shaper has added only time.
    setTimeout(() => forward(req, res, forwardPort, routeHost), shape.ms ?? 5000);
    return true;
  }
  if (shape.mode === "fail_5xx") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ shaped: "fail_5xx" }));
    return true;
  }
  if (shape.mode === "drop") {
    res.destroy();
    return true;
  }
  return false;
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

// Forward with node:http rather than fetch: undici derives the Host header
// from the URL and ignores an explicit override, which un-routes the request.
// agent: false disables keep-alive pooling: Node 19+ enables keep-alive on
// the global agent, and a pooled socket workerd closed while idle killed one
// proxied request per run with a socket hang up (run 7/8 receipts). A fresh
// connection per forward is what a sane reverse proxy does; the localhost
// handshake costs microseconds.
function forward(req, res, forwardPort, routeHost) {
  const headers = { ...req.headers, host: routeHost };
  const upstream = http.request(
    { host: "127.0.0.1", port: forwardPort, path: req.url, method: req.method, headers, agent: false },
    (up) => {
      res.writeHead(up.statusCode, up.statusMessage, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    console.error(`[shaper] forward error on ${req.method} ${req.url}: ${String(error)}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ shaped: "forward_error", message: String(error) }));
  });
  req.pipe(upstream);
}

function startShaper({ forwardPort, routeHost, controlPort, shapedPort }) {
  const control = createServer(async (req, res) => {
    if (req.url?.startsWith("/__shape__") && req.method === "POST") {
      const shape = safeParse(await readBody(req));
      modes.set(shapedPort, { mode: shape.mode ?? "normal", remaining: shape.count ?? 1, ms: shape.ms ?? 5000 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ shaping: modes.get(shapedPort) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const front = createServer((req, res) => {
    if (shapeResponse(req, res, shapedPort, forwardPort, routeHost)) return;
    forward(req, res, forwardPort, routeHost);
  });
  return { control, front };
}

// ── boot ─────────────────────────────────────────────────────────────────────
// ── module loading ───────────────────────────────────────────────────────────
// The portal and bot bundles are wrangler's own module collections (the build
// emitted them pre-bundled with no_bundle: true), and the bundle contains a
// dynamic import with a computed specifier (`await import(nodeSqlite)` from
// the kysely dialect chooser). Miniflare's automatic import walker refuses
// that, so we hand it the module list explicitly — exactly what wrangler's
// deploy path does. The first module is the main module.
async function loadModules(distDir) {
  const files = (await readdir(distDir, { recursive: true }))
    .filter((name) => name.endsWith(".js"))
    .sort((a, b) => (a === "index.js" ? -1 : b === "index.js" ? 1 : a.localeCompare(b)));
  if (!files.includes("index.js")) throw new Error(`no index.js module in ${distDir}`);
  return Promise.all(
    files.map(async (name) => ({
      type: "ESModule",
      // miniflare derives the module NAME as path.relative(modulesRoot,
      // def.path), so def.path is the absolute location on disk, and the
      // name becomes the bundle-relative specifier workerd links on.
      path: join(distDir, name),
      contents: await readFile(join(distDir, name), "utf8"),
    })),
  );
}

async function main() {
  await mkdir(dirname(STACK_LOG), { recursive: true });
  await mkdir(dirname(STACK_INFO), { recursive: true });

  const [doublePort, shaperControlPort, shaperPortalPort, shaperBotPort, dispatchPort] =
    await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);

  const keypair = generateKeyPairSync("ed25519");
  const der = keypair.publicKey.export({ format: "der", type: "spki" });
  const publicKeyHex = Buffer.from(der.subarray(der.length - 32)).toString("hex");
  const privateKeyPem = keypair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  const discordLogPath = join(dirname(STACK_INFO), "discord-double.log");
  const double = startDiscordDouble(discordLogPath);
  await listen(double.server, doublePort);

  // The shaper fronts the Workers; these are the origins a browser or a CLI
  // actually visits. The Worker is routed by hostname behind the dispatch
  // server, and the shaper rewrites the Host header accordingly.
  const portalOrigin = `http://portal.journey.test:${dispatchPort}`;
  const botOrigin = `http://bot.journey.test:${dispatchPort}`;
  const browsableOrigin = `http://127.0.0.1:${shaperPortalPort}`;
  const guildId = "1515858059027550321";

  const mf = new Miniflare({
    port: dispatchPort,
    // The run's own persistence root (STACK_PERSIST_ROOT): each plugin's
    // persist path is the plugin's own subdirectory under the v3 root
    // (getPersistPath returns the string as-is), so the D1 migrations and
    // seed run-all.sh applied with --persist-to land in exactly the database
    // this Worker serves -- and the checkout's .wrangler state stays
    // untouched.
    d1Persist: join(PERSIST_ROOT, "d1"),
    r2Persist: join(PERSIST_ROOT, "r2"),
    kvPersist: join(PERSIST_ROOT, "kv"),
    doPersist: join(PERSIST_ROOT, "do"),
    cachePersist: join(PERSIST_ROOT, "cache"),
    workers: [
      {
        name: "discord-outbound",
        modules: true,
        script: `export default {
          async fetch(request) {
            const url = new URL(request.url);
            if (url.hostname === "discord.com" || url.hostname === "discordapp.com") {
              return fetch(new URL(url.pathname + url.search, "http://127.0.0.1:${doublePort}"), request);
            }
            return new Response("discord-outbound: blocked " + url.hostname, { status: 503 });
          },
        }`,
      },
      {
        name: "bot",
        modulesRoot: BOT_DIST,
        modules: await loadModules(BOT_DIST),
        compatibilityDate: "2026-07-01",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          DISCORD_PUBLIC_KEY: publicKeyHex,
          COURSE_GUILD_ID: guildId,
          PORTAL_ORIGIN: browsableOrigin,
        },
        serviceBindings: {
          PORTAL: { name: "portal", entrypoint: "PortalRpc" },
        },
        outboundService: "discord-outbound",
        routes: [`${botOrigin}/*`],
      },
      {
        name: "portal",
        modulesRoot: join(PORTAL_DIST, "cogportal"),
        modules: await loadModules(join(PORTAL_DIST, "cogportal")),
        compatibilityDate: "2026-07-01",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ENVIRONMENT: "development",
          DEV_AUTH: "enabled",
          ONBOARDING_DEV_TOOLS: "enabled",
          EXECUTION_PROVIDER: "fixture",
          BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "local-development-only-not-a-real-secret-0000",
          BETTER_AUTH_URL: browsableOrigin,
          PUBLIC_ORIGIN: browsableOrigin,
          COURSE_GUILD_ID: guildId,
          PLATFORM_OWNER_LOGINS: "",
          GITHUB_CLIENT_ID: "",
          GITHUB_CLIENT_SECRET: "",
          GITHUB_WEBHOOK_SECRET: "",
          DISCORD_BOT_TOKEN: "",
          RUN_STALE_AFTER_SECONDS: "3600",
          RUNNER_PYTHON_VERSION: "3.11",
          RUNNER_SIGNING_KEY_ID: "runner-v1",
        },
        d1Databases: { DB: "b7e9e560-c32c-435e-9bfc-b82da43b27f4" },
        r2Buckets: { ARTIFACTS: "cogportal-artifacts-dev" },
        durableObjects: { RUN_SURFACES: { className: "RunSurfaceHub", scriptName: "portal" } },
        migrations: [{ tag: "run-surfaces-v1", new_sqlite_classes: ["RunSurfaceHub"] }],
        assets: {
          directory: join(PORTAL_DIST, "client"),
          binding: "ASSETS",
          // run_worker_first in wrangler.jsonc is ["/*", "!/media/*"]; the
          // closest single switch here puts the Worker ahead of assets for
          // every path. /media/* then also passes through the Worker, which
          // forwards it to ASSETS itself — same bytes, one extra hop, and
          // the journeys exercise no /media/* path.
          routerConfig: { invoke_user_worker_ahead_of_assets: true },
          assetConfig: { not_found_handling: "single-page-application" },
        },
        routes: [`${portalOrigin}/*`],
      },
    ],
  });

  const shaperPortal = startShaper({ forwardPort: dispatchPort, routeHost: `portal.journey.test:${dispatchPort}`, controlPort: shaperControlPort, shapedPort: shaperPortalPort });
  const shaperBot = startShaper({ forwardPort: dispatchPort, routeHost: `bot.journey.test:${dispatchPort}`, controlPort: shaperControlPort, shapedPort: shaperBotPort });
  await listen(shaperPortal.control, shaperControlPort);
  await listen(shaperPortal.front, shaperPortalPort);
  await listen(shaperBot.front, shaperBotPort);

  await mf.ready;
  await log(`booted: dispatch ${dispatchPort}, double ${doublePort}, shaper portal ${shaperPortalPort}, bot ${shaperBotPort}, control ${shaperControlPort}`);

  // Readiness: the Worker's own benchmarks route must answer 200 through the
  // shaper, so a boot that only half-worked fails here, not in a journey.
  // STACK_SKIP_BOOT_PROBE=1 leaves the stack running past a failed probe for
  // hands-on debugging of routing.
  if (process.env.STACK_SKIP_BOOT_PROBE !== "1") {
    const response = await fetch(`${browsableOrigin}/api/v1/benchmarks`);
    if (response.status !== 200) {
      throw new Error(`stack boot check failed: /api/v1/benchmarks answered ${response.status} — ${await response.text().then((t) => t.slice(0, 200))}`);
    }
  }

  await writeFile(
    STACK_INFO,
    JSON.stringify(
      {
        ready: true,
        browsableOrigin,
        portalOrigin,
        botOrigin,
        shaperPortalOrigin: browsableOrigin,
        shaperBotOrigin: `http://127.0.0.1:${shaperBotPort}`,
        shaperControlOrigin: `http://127.0.0.1:${shaperControlPort}`,
        discordDoubleOrigin: `http://127.0.0.1:${doublePort}`,
        discordPublicKeyHex: publicKeyHex,
        // Test-only key, generated per boot for signing journey interactions.
        // It signs nothing outside this run and never left the machine.
        discordPrivateKeyPem: privateKeyPem,
        courseGuildId: guildId,
        discordDoubleLogPath: discordLogPath,
        stackLog: STACK_LOG,
      },
      null,
      2,
    ),
  );
  // run-all.sh greps this file for the ready flag; it stays valid JSON.
  await log(`stack ready: dispatch ${dispatchPort}, shaper portal ${shaperPortalPort}, bot ${shaperBotPort}, double ${doublePort}`);

  const stop = async () => {
    await mf.dispose();
    double.server.close();
    shaperPortal.control.close();
    shaperPortal.front.close();
    shaperBot.front.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

main().catch(async (error) => {
  await log(`stack boot failed: ${error?.stack ?? error}`);
  console.error(error);
  process.exit(1);
});
