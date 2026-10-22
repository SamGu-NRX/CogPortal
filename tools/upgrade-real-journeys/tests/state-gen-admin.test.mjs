import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ROSTER, adminPhase } from "../lib/state-gen.mjs";

// A beta stand-in for the routes the staff phase exercises, faithful to what
// beta actually does at 17d26d9:
// - POST /api/dev/login creates the user row with githubLogin NULL;
// - POST /api/admin/staff only names a roster row (no user row);
// - POST /api/admin/teams/:id/tas resolves the assignee by
//   lower(users.githubLogin) and 404s for dev-auth logins.
function betaStub() {
  const users = new Map(); // login -> { login, githubLogin }
  const roster = [];
  const requests = [];
  const tasAttempts = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const cookie = Object.fromEntries(
        String(req.headers.cookie || "")
          .split("; ")
          .filter(Boolean)
          .map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]),
      );
      const record = {
        method: req.method,
        path: req.url,
        body: body ? JSON.parse(body) : null,
        session: cookie.session ?? null,
      };
      requests.push(record);
      if (req.method === "POST" && req.url === "/api/dev/login") {
        const { login } = record.body;
        if (!users.has(login)) users.set(login, { login, githubLogin: null });
        res.setHeader("set-cookie", `session=${login}; Path=/; HttpOnly`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/admin/staff") {
        // owner-gated: the session must name a platform owner login
        if (cookie.session !== ROSTER.owner) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "forbidden" }));
          return;
        }
        roster.push(record.body.login);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ login: record.body.login }));
        return;
      }
      const taMatch = /^\/api\/admin\/teams\/([^/]+)\/tas$/.exec(req.url);
      if (req.method === "POST" && taMatch) {
        tasAttempts.push(record.body.login);
        const user = users.get(record.body.login);
        // beta resolves the assignee by githubLogin; dev-auth users have none.
        if (!user || user.githubLogin === null) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not_found", message: "no matching staff identity" }));
          return;
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  return { server, users, roster, requests, tasAttempts };
}

test("adminPhase signs rostered staff in through beta's real login path", async () => {
  const { server, users, roster, requests, tasAttempts } = betaStub();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const logs = [];
    const { tas } = await adminPhase({ baseUrl, teamId: "team-1", log: (m) => logs.push(m) });
    // Roster rows named, and every staff account also holds a real user row.
    assert.deepEqual([...roster].sort(), [...ROSTER.staff].sort());
    for (const login of ROSTER.staff) {
      assert.ok(users.has(login), `${login} never signed in (no user row)`);
      assert.equal(users.get(login).githubLogin, null);
      assert.ok(
        requests.some((r) => r.path === "/api/dev/login" && r.body.login === login),
        `${login} never went through /api/dev/login`,
      );
    }
    // The TA assignment is still attempted through the real route and its 404
    // recorded - dev-auth accounts carry no githubLogin to match.
    assert.deepEqual([...tasAttempts].sort(), [...ROSTER.tas].sort());
    assert.equal(tas.every((t) => t.assigned === false), true);
    assert.ok(logs.some((m) => m.includes("unreachable")));
  } finally {
    server.close();
  }
});
