// Labelled provider doubles and the shaping hops in front of them.
//
// The Worker reaches three providers: GitHub's REST API, Discord's API and
// the Modal runner. In a harness boot each base URL points at a loopback
// *hop* (a small forwarding proxy), and each hop forwards to the provider's
// *double* (an HTTP server speaking enough of the provider's protocol for
// the routes the journeys exercise). Every double's response carries
// `x-cogportal-double: <label>` and every request it receives is journalled.
//
//   Worker --DISCORD_API_BASE_URL--> discord hop :8823 --> discord double :8813
//
// Faults that belong on the wire between the Worker and a provider (a send
// that arrives twice, a delayed answer) are rules on the hop, so the double
// receives real, separate HTTP requests and the Worker sees what it would see
// on the real network: one response per request it sent.
//
// Control routes (`/__doubles/*` on a double, `/__hop/*` on a hop) are
// answered locally and never forwarded.

import http from "node:http";
import crypto from "node:crypto";

export const DOUBLE_PORTS = {
  githubRest: 8811,
  discord: 8813,
  modalRunner: 8814,
};

export const HOP_PORTS = {
  githubRest: 8821,
  discord: 8823,
  modalRunner: 8824,
};

/** Base URLs the Worker is given: the hops, never the doubles directly. */
export const PROVIDER_URLS = {
  github: `http://127.0.0.1:${HOP_PORTS.githubRest}`,
  // Stands for https://discord.com/api; the Worker appends /v10 or /oauth2.
  discord: `http://127.0.0.1:${HOP_PORTS.discord}`,
  modal: `http://127.0.0.1:${HOP_PORTS.modalRunner}/submit`,
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseBody(raw, contentType) {
  const text = raw.toString("utf8");
  if (!text) return {};
  if ((contentType ?? "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function double(label, port, handler) {
  const state = { journal: [] };
  const instance = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const reply = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json", "x-cogportal-double": label });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname.startsWith("/__doubles/")) {
      if (url.pathname === "/__doubles/journal" && req.method === "GET") return reply(200, { double: label, journal: state.journal });
      if (url.pathname === "/__doubles/reset" && req.method === "POST") {
        state.journal.length = 0;
        state.reset?.();
        return reply(200, { ok: true });
      }
      const body = parseBody(raw, req.headers["content-type"]);
      if (state.control) {
        const handled = await state.control({ url, method: req.method, body, reply });
        if (handled !== false) return;
      }
      return reply(404, { message: `${label} double has no control route ${url.pathname}` });
    }
    const entry = { method: req.method, path: url.pathname, at: Date.now(), status: 0 };
    state.journal.push(entry);
    const body = parseBody(raw, req.headers["content-type"]);
    const respond = (status, payload) => {
      entry.status = status;
      reply(status, payload);
    };
    try {
      await handler({ url, method: req.method, body, headers: req.headers, respond });
    } catch (error) {
      respond(500, { message: `double ${label} internal error: ${error.message}` });
    }
  });
  return {
    label,
    port,
    state,
    start: () => new Promise((resolve, reject) => {
      instance.once("error", reject);
      instance.listen(port, "127.0.0.1", resolve);
    }),
    stop: () => new Promise((resolve) => instance.close(() => resolve())),
  };
}

/**
 * A forwarding hop. Rules: `{ match: { method?, path? }, duplicate?: n,
 * delayMs?, times? }`. `duplicate` sends the same request n extra times to
 * the double, after the first, and answers the Worker with the first
 * response: the wire shape of a send the network delivered twice.
 */
function hop(label, port, targetPort) {
  const rules = [];
  const instance = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const reply = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/__hop/rules" && req.method === "POST") {
      rules.push(JSON.parse(raw.toString("utf8") || "{}"));
      return reply(200, { ok: true, rules: rules.length });
    }
    if (url.pathname === "/__hop/reset" && req.method === "POST") {
      rules.length = 0;
      return reply(200, { ok: true });
    }
    const rule = rules.find(
      (candidate) =>
        (candidate.times === undefined || candidate.times > 0) &&
        (!candidate.match?.method || candidate.match.method === req.method) &&
        (!candidate.match?.path || candidate.match.path === url.pathname),
    );
    if (rule && rule.times !== undefined) rule.times -= 1;
    if (rule?.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    const send = () =>
      new Promise((resolve, reject) => {
        const upstream = http.request(
          { host: "127.0.0.1", port: targetPort, method: req.method, path: url.pathname + url.search, headers },
          async (upRes) => resolve({ status: upRes.statusCode, headers: upRes.headers, body: await readBody(upRes) }),
        );
        upstream.on("error", reject);
        upstream.end(raw);
      });
    try {
      const first = await send();
      for (let extra = 0; extra < (rule?.duplicate ?? 0); extra += 1) await send();
      res.writeHead(first.status, first.headers);
      res.end(first.body);
    } catch (error) {
      reply(502, { message: `${label} hop could not reach its double: ${error.message}` });
    }
  });
  return {
    label: `${label}-hop`,
    port,
    start: () => new Promise((resolve, reject) => {
      instance.once("error", reject);
      instance.listen(port, "127.0.0.1", resolve);
    }),
    stop: () => new Promise((resolve) => instance.close(() => resolve())),
  };
}

// ── GitHub REST ────────────────────────────────────────────────────────────
// Reached only when the Worker has GitHub OAuth configured (the
// production-refusal profile). In development the Worker uses its in-repo
// FixtureGitHubClient and sends nothing here. Without a token this double
// issued, every route answers 401 the way api.github.com does.
const githubRest = double("github-rest", DOUBLE_PORTS.githubRest, ({ respond }) => {
  respond(401, { message: "Bad credentials" });
});

// ── Discord ────────────────────────────────────────────────────────────────
// The Activity's OAuth exchange (/oauth2/token, /v10/users/@me) and the bot
// routes the Worker calls (/v10/channels/...). Activity codes are minted by a
// journey through the control route and are single-use, as Discord's are: a
// second exchange of the same code answers invalid_grant.
const discord = double("discord", DOUBLE_PORTS.discord, ({ url, method, body, headers, respond }) => {
  const state = discord.state;
  if (url.pathname === "/oauth2/token" && method === "POST") {
    const grant = state.codes.get(body.code ?? "");
    if (!grant || grant.spent) return respond(400, { error: "invalid_grant" });
    grant.spent = true;
    const token = `dt_${crypto.randomBytes(12).toString("hex")}`;
    state.tokens.set(token, grant.user);
    return respond(200, { access_token: token, token_type: "Bearer", expires_in: 604800, scope: "identify" });
  }
  if (url.pathname === "/v10/users/@me" && method === "GET") {
    const user = state.tokens.get((headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!user) return respond(401, { message: "401: Unauthorized", code: 0 });
    return respond(200, user);
  }
  if (url.pathname.startsWith("/v10/")) {
    if (headers.authorization !== `Bot ${state.botToken}`) return respond(401, { message: "401: Unauthorized", code: 0 });
    return respond(404, { message: "Unknown Channel", code: 10003 });
  }
  return respond(404, { message: `discord double has no route for ${method} ${url.pathname}` });
});
Object.assign(discord.state, {
  botToken: "rj-local-bot-token",
  codes: new Map(),
  tokens: new Map(),
  reset() {
    discord.state.codes.clear();
    discord.state.tokens.clear();
  },
  async control({ url, method, body, reply }) {
    // Mint an Activity code for a synthetic Discord user.
    if (url.pathname === "/__doubles/discord/codes" && method === "POST") {
      discord.state.codes.set(body.code, {
        spent: false,
        user: { id: body.user.id, username: body.user.username, global_name: body.user.global_name ?? null },
      });
      return reply(200, { ok: true });
    }
    return false;
  },
});

// ── Modal runner ───────────────────────────────────────────────────────────
// A sink. Every harness profile points MODAL_RUNNER_URL here, and under the
// fixture provider nothing should arrive at all; a journey asserts the
// journal is empty. A dispatch that does arrive is refused, so no run can
// look as if it was accepted.
const modalRunner = double("modal-runner", DOUBLE_PORTS.modalRunner, ({ respond }) => {
  respond(503, { error: "the modal-runner double accepts no jobs" });
});

export function createDoubles() {
  return {
    doubles: [githubRest, discord, modalRunner],
    hops: [
      hop("github-rest", HOP_PORTS.githubRest, DOUBLE_PORTS.githubRest),
      hop("discord", HOP_PORTS.discord, DOUBLE_PORTS.discord),
      hop("modal-runner", HOP_PORTS.modalRunner, DOUBLE_PORTS.modalRunner),
    ],
  };
}
