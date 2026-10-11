// Stateful protocol doubles for the CogPortal provider boundaries.
//
// Each double is a small HTTP server that speaks one provider's protocol
// well enough that the portal's real outbound code — the GitHub REST client,
// the OAuth device-flow handlers, the Discord REST calls, the Modal runner
// callbacks — can be exercised end to end. Doubles are stateful: claims,
// pushes, channels, runs and revocations accumulate and change what they
// answer next, exactly the way the real providers do.
//
// Every response carries `x-cogportal-double: <label>`. A journey that ever
// receives a doubled response knows precisely which boundary answered. The
// default paths below shadow nothing that exists in production: they exist
// only because the harness sets GITHUB_API_BASE_URL / DISCORD_API_BASE_URL
// in local bindings (see stack/stack.mjs) and hands the OAuth and runner
// callbacks their URLs explicitly.

import http from "node:http";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

export const DOUBLE_PORTS = {
  githubRest: 8811,
  githubOAuth: 8812,
  discord: 8813,
  modalRunner: 8814,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function server(label, port, handler) {
  const state = { log: [], requests: 0 };
  const instance = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const bodyRaw = Buffer.concat(chunks).toString("utf8");
      let body = bodyRaw;
      try {
        body = bodyRaw ? JSON.parse(bodyRaw) : bodyRaw;
      } catch {
        // Non-JSON bodies: hand form-encoded posts to handlers as plain
        // objects — that is the encoding every OAuth token endpoint speaks.
        if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded") && bodyRaw) {
          body = Object.fromEntries(new URLSearchParams(bodyRaw));
        }
      }
      state.requests += 1;
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      state.log.push({ method: req.method, path: url.pathname, at: Date.now() });
      try {
        await handler({ req, res, url, method: req.method, body, headers: req.headers });
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json", "x-cogportal-double": label });
        res.end(JSON.stringify({ message: `double ${label} internal error: ${error.message}` }));
      }
    });
  });
  return {
    label,
    port,
    state,
    start: () =>
      new Promise((resolve, reject) => {
        instance.once("error", reject);
        instance.listen(port, "127.0.0.1", () => resolve());
      }),
    stop: () => new Promise((resolve) => instance.close(() => resolve())),
  };
}

// ── GitHub REST double ─────────────────────────────────────────────────────
// Speaks enough of api.github.com for the portal's client: repo listing,
// ref resolution, file contents, and the check-suites endpoint the portal
// polls for verify/repo_status. Claims are journaled; a "revoked" token
// flips every subsequent call to 401 the way a real credential death does.
const githubRest = server("github-rest", DOUBLE_PORTS.githubRest, (ctx) => {
  const { res, url, method, body, headers } = ctx;
  const reply = (status, payload, extra = {}) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "x-cogportal-double": "github-rest",
      ...extra,
    });
    res.end(JSON.stringify(payload));
  };
  const auth = headers.authorization ?? "";
  if (githubRest.state.revoked && auth.startsWith("Bearer gho_")) {
    return reply(401, { message: "Bad credentials" });
  }

  // GET /user
  if (url.pathname === "/user" && method === "GET") {
    return reply(200, {
      login: githubRest.state.userLogin ?? "owner-person",
      id: 1001,
      type: "User",
    });
  }

  // GET /user/repos — the listing behind account connect. Repositories are
  // registered by journeys through POST /__control/github-rest/repos.
  if (url.pathname === "/user/repos" && method === "GET") {
    return reply(200, githubRest.state.repos);
  }

  // GET /repos/:owner/:name/contents/:path
  const contents = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
  if (contents && method === "GET") {
    const [, owner, name, path] = contents;
    const entry = githubRest.state.files.get(`${owner}/${name}/${path}`);
    if (!entry) return reply(404, { message: "Not Found" });
    if (url.searchParams.get("ref") && entry.refs && !entry.refs.includes(url.searchParams.get("ref"))) {
      return reply(404, { message: "Not Found" });
    }
    return reply(200, {
      name: path.split("/").pop(),
      path,
      content: Buffer.from(entry.content).toString("base64"),
      encoding: "base64",
    });
  }

  // GET /repos/:owner/:name/commits?path_sha=... (ref resolution proxy)
  const commits = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/commits$/);
  if (commits && method === "GET") {
    const [, owner, name] = commits;
    const ref = url.searchParams.get("sha") ?? "HEAD";
    const head = githubRest.state.heads.get(`${owner}/${name}/${ref}`);
    if (!head) return reply(404, { message: "Not Found" });
    return reply(200, [{ sha: head.sha, commit: { message: head.message ?? "wip" } }]);
  }

  // GET /repos/:owner/:name/commits/:ref/status — check runs
  const status = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/status$/);
  if (status && method === "GET") {
    const [, , , ref] = status;
    const check = githubRest.state.checks.get(ref);
    return reply(200, {
      state: check?.state ?? "pending",
      sha: ref,
      statuses: check?.statuses ?? [],
    });
  }

  return reply(404, {
    message: `github-rest double has no route for ${method} ${url.pathname}`,
  });
});

// Control-plane state for the GitHub REST double (mutated via /__control).
Object.assign(githubRest.state, {
  userLogin: "owner-person",
  repos: [],
  files: new Map(),
  heads: new Map(),
  checks: new Map(),
  revoked: false,
});

// ── GitHub OAuth double ────────────────────────────────────────────────────
// The device-flow pages the portal links a student to, plus the token
// endpoint. The access codes minted here are what the portal's connect
// routes hand to GITHUB_API_BASE_URL; that double accepts only tokens this
// server actually issued, so a journey cannot accidentally pass a forged
// credential through the real client code.
const githubOAuth = server("github-oauth", DOUBLE_PORTS.githubOAuth, (ctx) => {
  const { res, url, method, body } = ctx;
  const reply = (status, payload, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "x-cogportal-double": "github-oauth" });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  };

  if (url.pathname === "/login/device/code" && method === "POST") {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    githubOAuth.state.codes.set(code, { client_id: body.client_id, scope: body.scope ?? "repo" });
    return reply(200, {
      device_code: `dh_${code.toLowerCase()}`,
      user_code: code,
      verification_uri: `http://127.0.0.1:${DOUBLE_PORTS.githubOAuth}/login/device`,
      expires_in: 900,
      interval: 1,
    });
  }

  if (url.pathname === "/login/device" && method === "GET") {
    const userCode = url.searchParams.get("code") ?? "";
    return reply(
      200,
      `<!doctype html><html><body data-dirty="github-oauth"><h1>Device login</h1><p>Code ${userCode}</p></body></html>`,
      "text/html; charset=utf-8",
    );
  }

  if (url.pathname === "/login/oauth/access_token" && method === "POST") {
    const grant = githubOAuth.state.grants.get(body.device_code ?? body.code ?? "");
    if (!grant || grant.state === "slow") {
      return reply(200, { error: "authorization_pending" });
    }
    if (grant.state === "denied") {
      return reply(200, { error: "access_denied" });
    }
    if (grant.state === "expired") {
      return reply(200, { error: "expired_token" });
    }
    const token = `gho_${crypto.randomBytes(16).toString("hex")}`;
    grant.token = token;
    return reply(200, { access_token: token, token_type: "bearer", scope: grant.scope });
  }

  return reply(404, { message: `github-oauth double has no route for ${method} ${url.pathname}` });
});
Object.assign(githubOAuth.state, { codes: new Map(), grants: new Map() });

// ── Discord double ─────────────────────────────────────────────────────────
// Bot-token REST endpoints the portal calls (channel inspection, message
// posting) plus the OAuth token + /users/@me exchange the Discord Activity
// bridge performs. Channel state drives the portal's validation outcomes.
const discord = server("discord", DOUBLE_PORTS.discord, (ctx) => {
  const { res, url, method, body, headers } = ctx;
  const reply = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json", "x-cogportal-double": "discord" });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === "/oauth2/token" && method === "POST") {
    const grant = discord.state.activityCodes.get(body.code ?? "");
    if (!grant) return reply(400, { error: "invalid_grant" });
    return reply(200, { access_token: `dt_${crypto.randomBytes(12).toString("hex")}`, token_type: "Bearer", expires_in: 604800 });
  }
  if (url.pathname === "/api/oauth2/token" && method === "POST") {
    const grant = discord.state.activityCodes.get(body.code ?? "");
    if (!grant) return reply(400, { error: "invalid_grant" });
    return reply(200, { access_token: `dt_${crypto.randomBytes(12).toString("hex")}`, token_type: "Bearer", expires_in: 604800 });
  }
  if ((url.pathname === "/api/v10/users/@me" || url.pathname === "/v10/users/@me") && method === "GET") {
    if (!headers.authorization?.startsWith("Bearer dt_")) return reply(401, { message: "401: Unauthorized" });
    return reply(200, { id: discord.state.activityUser.id, username: discord.state.activityUser.username, global_name: discord.state.activityUser.global_name });
  }
  if (url.pathname.startsWith("/api/v10/") || url.pathname.startsWith("/v10/")) {
    if (headers.authorization !== `Bot ${discord.state.botToken}`) {
      return reply(401, { message: "401: Unauthorized" });
    }
    // /channels/:id and /channels/:id/messages/...
    const channel = url.pathname.match(/\/channels\/(\d+)/);
    if (channel) {
      const channelId = channel[1];
      const known = discord.state.channels.get(channelId);
      if (!known) {
        return reply(404, { message: "Unknown Channel", code: 10003 });
      }
      if (method === "GET" && url.pathname === `/api/v10/channels/${channelId}`) {
        return reply(200, { id: channelId, name: known.name, guild_id: known.guildId, type: 0 });
      }
      if (method === "POST" && url.pathname.endsWith("/messages")) {
        if (!known.writable) return reply(403, { message: "Missing Permissions", code: 50013 });
        const message = { id: `m_${discord.state.messages.size + 1}`, channel_id: channelId, content: body.content ?? "" };
        discord.state.messages.set(message.id, message);
        return reply(200, message);
      }
    }
  }
  return reply(404, { message: `discord double has no route for ${method} ${url.pathname}` });
});
Object.assign(discord.state, {
  botToken: "rj-local-bot-token",
  activityUser: { id: "987654321000000000", username: "activity-student", global_name: "Activity Student" },
  activityCodes: new Map(),
  channels: new Map(),
  messages: new Map(),
});

// ── Modal runner double ────────────────────────────────────────────────────
// The runner boundary: accepts signed run submissions, then drives a run
// through its lifecycle by emitting the exact callback payloads the real
// runner posts, including worker_log lines and artifact manifests. Test
// control lives on /__control: journeys decide per-run whether it succeeds,
// fails, stalls or emits partial logs. HMAC verification is done the way the
// Worker verifies it (key id + timestamp window), so a run whose signature
// the harness mangles is rejected by the real callback handler, not by
// harness logic.
const modalRunner = server("modal-runner", DOUBLE_PORTS.modalRunner, (ctx) => {
  const { res, url, method, body, headers } = ctx;
  const reply = (status, payload) => {
    res.writeHead(status, { "content-type": "application/json", "x-cogportal-double": "modal-runner" });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === "/runs" && method === "POST") {
    // The portal signs submissions; the double records and "runs" them.
    const runId = `run_${modalRunner.state.runs.size + 1}`;
    modalRunner.state.runs.set(runId, { ...body, status: "claimed", logs: [], artifacts: [] });
    return reply(200, { run_id: runId, status: "claimed" });
  }
  if (url.pathname.startsWith("/runs/") && method === "GET") {
    const runId = url.pathname.split("/")[2];
    const run = modalRunner.state.runs.get(runId);
    if (!run) return reply(404, { error: "unknown run" });
    return reply(200, run);
  }
  return reply(404, { error: `modal-runner double has no route for ${method} ${url.pathname}` });
});
Object.assign(modalRunner.state, { runs: new Map(), control: new Map() });

export function createDoubles({ log = () => {} } = {}) {
  return { githubRest, githubOAuth, discord, modalRunner, log };
}

/** Registers a synthetic GitHub repo into the REST double (harness control). */
export function registerRepo({ owner, name, defaultBranch = "main", files = {}, head }) {
  const full = `${owner}/${name}`;
  githubRest.state.repos.push({
    id: 900 + githubRest.state.repos.length + 1,
    name,
    full_name: full,
    private: false,
    owner: { login: owner },
    default_branch: defaultBranch,
  });
  for (const [path, content] of Object.entries(files)) {
    githubRest.state.files.set(`${full}/${path}`, { content, refs: [defaultBranch] });
  }
  if (head?.sha) {
    githubRest.state.heads.set(`${full}/${defaultBranch}`, head);
    githubRest.state.heads.set(`${full}/HEAD`, head);
  }
}

export const _internals = { sleep };
