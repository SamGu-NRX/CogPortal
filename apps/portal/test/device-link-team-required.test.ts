import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import { createAuth } from "../worker/auth/better-auth.ts";
import { cohorts, teamMembers, teams, users } from "../worker/db/schema.ts";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { registerConnectionRoutes } from "../worker/routes/connections.ts";

/*
 * A student with no team who runs `cogworks link` and opens the URL is sent
 * to onboarding before approval renders. The guard's hold, or an explicit
 * approval refusal, tells the terminal why it is waiting (`teamRequired` on
 * the poll). Neither binds nor consumes the code.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !/^(0002_seed|0016_backfill)/.test(name))) {
    sqlite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  const binding = {
    prepare(query: string) {
      const statement = sqlite.prepare(query);
      let bound: SQLInputValue[] = [];
      const prepared = {
        bind(...params: SQLInputValue[]) { bound = params; return prepared; },
        async run() { return { success: true, meta: statement.run(...bound) }; },
        async all() { return { success: true, results: statement.all(...bound) }; },
        async raw() {
          statement.setReturnArrays(true);
          try { return statement.all(...bound); }
          finally { statement.setReturnArrays(false); }
        },
      };
      return prepared;
    },
  };
  return { sqlite, db: drizzle(binding as never), binding };
}

async function harness(t: TestContext) {
  const { sqlite, binding, db } = freshDb();
  t.after(() => sqlite.close());
  const env = {
    DB: binding, ENVIRONMENT: "development", DEV_AUTH: "enabled",
    EXECUTION_PROVIDER: "fixture", PUBLIC_ORIGIN: "http://localhost:5173",
    BETTER_AUTH_SECRET: "a-secure-development-secret-32-chars",
    BETTER_AUTH_URL: "http://localhost:5173",
  } as unknown as Env;
  const routes = new Hono<AppEnv>();
  registerConnectionRoutes(routes);
  const app = new Hono<AppEnv>();
  app.route("/api", routes);
  app.onError(handleError);
  app.notFound((c) => c.json({ error: { code: "not_found", message: "API route not found." } }, 404));

  await db.insert(cohorts).values({
    id: "cohort_test", slug: "test", name: "Test cohort", joinCode: "TESTCODE", active: true,
  });
  const signedIn = await createAuth(env).api.signUpEmail({
    body: { email: "ada@users.noreply.github.com", password: "cogportal-local-dev-password", name: "Ada" },
    returnHeaders: true,
  });
  const userId = signedIn.response.user.id;
  const firstCookie = signedIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  await db.update(users).set({ githubLogin: "ada" }).where(eq(users.id, userId));
  const secondSignedIn = await createAuth(env).api.signUpEmail({
    body: { email: "grace@users.noreply.github.com", password: "cogportal-local-dev-password", name: "Grace" },
    returnHeaders: true,
  });
  const secondCookie = secondSignedIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

  const send = (path: string, init: RequestInit = {}, sessionCookie: string | boolean = "") => app.fetch(
    new Request(`http://localhost:5173${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...((typeof sessionCookie === "string" ? sessionCookie : sessionCookie ? firstCookie : "")
          ? { cookie: typeof sessionCookie === "string" ? sessionCookie : firstCookie } : {}),
        ...init.headers,
      },
    }), env,
  );
  const post = async (
    path: string,
    body: Record<string, unknown>,
    sessionCookie: string | boolean = false,
  ) => {
    const response = await send(`/api${path}`, { method: "POST", body: JSON.stringify(body) }, sessionCookie);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
  };
  const joinTeam = async () => {
    await db.update(users).set({ cohortId: "cohort_test" }).where(eq(users.id, userId));
    await db.insert(teams).values({
      id: "team_a", cohortId: "cohort_test", name: "Team A",
      repoOwner: FIXTURE_REPO.owner, repoName: FIXTURE_REPO.name, repoFullName: FIXTURE_REPO.fullName,
      repoUrl: FIXTURE_REPO.url, defaultBranch: FIXTURE_REPO.defaultBranch,
      repoId: FIXTURE_REPO.repositoryId, discordChannelId: "channel_a",
    });
    await db.insert(teamMembers).values({ teamId: "team_a", userId, role: "write" });
  };
  const authorization = (code: string) => sqlite.prepare("SELECT * FROM device_authorizations WHERE user_code = ?").get(code);
  return { post, send, joinTeam, sqlite, authorization, secondCookie };
}

test("device approval and hold calls rate-limit per signed-in user without changing a held code", async (t) => {
  const h = await harness(t);
  const start = await h.post("/v1/cli/device/start", {});
  const userCode = start.body.userCode as string;

  for (let index = 0; index < 5; index += 1) {
    assert.equal((await h.post("/v1/cli/device/hold", { userCode }, true)).status, 204);
  }
  const before = h.authorization(userCode);
  const limited = await h.post("/v1/cli/device/approve", { userCode, deviceName: "Laptop" }, true);
  assert.equal(limited.status, 429);
  assert.deepEqual(h.authorization(userCode), before, "the rejected request must not approve or alter the code");

  assert.equal((await h.post("/v1/cli/device/hold", { userCode }, h.secondCookie)).status, 204);
});

test("the global approval cap rejects a request before it can bind a code", async (t) => {
  const h = await harness(t);
  const start = await h.post("/v1/cli/device/start", {});
  const userCode = start.body.userCode as string;
  h.sqlite.prepare("INSERT INTO rate_limits (id, key, count, last_request) VALUES (?, ?, ?, ?)").run(
    "rate_global", "cli-device-approve:global", 100, Date.now(),
  );
  const before = h.authorization(userCode);
  const response = await h.post("/v1/cli/device/approve", { userCode, deviceName: "Laptop" }, true);
  assert.equal(response.status, 429);
  assert.deepEqual(h.authorization(userCode), before);
});

test("an approval refused for no team is reported to the polling CLI and the code still links", async (t) => {
  const h = await harness(t);
  const start = await h.post("/v1/cli/device/start", {});
  assert.equal(start.status, 200);
  const deviceCode = start.body.deviceCode as string;
  const userCode = start.body.userCode as string;
  const poll = () => h.post("/v1/cli/device/token", { deviceCode });

  assert.deepEqual(await poll(), {
    status: 200, body: { status: "pending", retryAfterSeconds: 5, teamRequired: false },
  });

  const refused = await h.post("/v1/cli/device/approve", { userCode, deviceName: "Laptop" }, true);
  assert.deepEqual(refused, {
    status: 403, body: { error: { code: "no_team", message: "Connect a repository to continue." } },
  });

  assert.deepEqual(await poll(), {
    status: 200, body: { status: "pending", retryAfterSeconds: 5, teamRequired: true },
  });

  await h.joinTeam();
  const approved = await h.post("/v1/cli/device/approve", { userCode, deviceName: "Laptop" }, true);
  assert.deepEqual(approved, { status: 200, body: { ok: true } });
  const linked = await poll();
  assert.equal(linked.status, 200);
  assert.equal(linked.body.status, "authorized");
});

test("a hold marks the wait once without approving or binding the code", async (t) => {
  const h = await harness(t);
  const start = await h.post("/v1/cli/device/start", {});
  const userCode = start.body!.userCode as string;
  const before = h.authorization(userCode)!;
  assert.deepEqual(await h.post("/v1/cli/device/hold", { userCode }, true), { status: 204, body: null });
  const held = h.authorization(userCode)!;
  assert.equal(typeof held.team_required_at, "number");
  assert.deepEqual({ ...held }, { ...before, team_required_at: held.team_required_at });
  assert.deepEqual(await h.post("/v1/cli/device/token", { deviceCode: start.body!.deviceCode }), {
    status: 200, body: { status: "pending", retryAfterSeconds: 5, teamRequired: true },
  });
  // Use a distinct clock so an unconditional UPDATE cannot pass by coincidence.
  t.mock.method(Date, "now", () => Number(held.team_required_at) + 1000);
  assert.deepEqual(await h.post("/v1/cli/device/hold", { userCode: userCode.toLowerCase() }, true), { status: 204, body: null });
  assert.deepEqual(h.authorization(userCode), held);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM cli_devices").get()!.n, 0);
});

test("a hold from a student with a team changes nothing", async (t) => {
  const h = await harness(t);
  await h.joinTeam();
  const start = await h.post("/v1/cli/device/start", {});
  const userCode = start.body!.userCode as string;
  const before = h.authorization(userCode);
  assert.deepEqual(await h.post("/v1/cli/device/hold", { userCode }, true), { status: 204, body: null });
  assert.deepEqual(h.authorization(userCode), before);
});

test("unknown, expired, approved and consumed codes get the same empty hold response and do not change", async (t) => {
  for (const state of ["unknown", "expired", "approved", "consumed"] as const) {
    await t.test(state, async (t) => {
      const h = await harness(t);
      const start = await h.post("/v1/cli/device/start", {});
      const code = start.body!.userCode as string;
      if (state === "expired") h.sqlite.prepare("UPDATE device_authorizations SET expires_at = ?").run(Date.now() - 1);
      if (state === "approved") h.sqlite.prepare("UPDATE device_authorizations SET approved_at = ?").run(Date.now());
      if (state === "consumed") h.sqlite.prepare("UPDATE device_authorizations SET consumed_at = ?").run(Date.now());
      const before = h.authorization(code);
      const userCode = state === "unknown" ? "UNKNOWN-CODE" : code;
      assert.deepEqual(await h.post("/v1/cli/device/hold", { userCode }, true), { status: 204, body: null });
      assert.deepEqual(h.authorization(code), before);
    });
  }
});

test("holding requires a browser session, not a CLI bearer token", async (t) => {
  const h = await harness(t);
  const start = await h.post("/v1/cli/device/start", {});
  const userCode = start.body!.userCode as string;
  const before = h.authorization(userCode);
  assert.equal((await h.post("/v1/cli/device/hold", { userCode })).status, 401);
  await h.joinTeam();
  await h.post("/v1/cli/device/approve", { userCode, deviceName: "Laptop" }, true);
  const linked = await h.post("/v1/cli/device/token", { deviceCode: start.body!.deviceCode });
  const next = await h.post("/v1/cli/device/start", {});
  const response = await h.send("/api/v1/cli/device/hold", {
    method: "POST", headers: { Authorization: `Bearer ${linked.body!.token}` },
    body: JSON.stringify({ userCode: next.body!.userCode }),
  });
  assert.equal(response.status, 401);
  assert.equal(h.authorization(next.body!.userCode as string)!.team_required_at, before!.team_required_at);
});

/** Real guard and approval page; browser requests go to the same Worker as the Python CLI. */
async function browser(t: TestContext, h: Awaited<ReturnType<typeof harness>>, entry: string) {
  const window = new Window({ url: `http://localhost:5173${entry}` });
  const pending: Promise<Response>[] = [];
  const requests: string[] = [];
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    sessionStorage: window.sessionStorage, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (input: string, init: RequestInit = {}) => {
      requests.push(`${init.method ?? "GET"} ${input}`);
      const response = h.send(input, init, true);
      pending.push(response);
      return response;
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  const session = {
    user: { login: "ada", name: "Ada", avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
    cohort: null, team: null,
    auth: { githubConfigured: false, devAuthEnabled: true, onboardingDevToolsEnabled: true, appSlug: null, templateRepo: null, executionProvider: "fixture" },
  };
  client.setQueryData(["session"], session);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses.
  const root = createRoot(container as unknown as Element);
  const { RequireStage } = await import("../src/App.tsx");
  const { ConnectionsPage } = await import("../src/routes/ConnectionsPage.tsx");
  const router = createMemoryRouter([
    { path: "/connections", element: React.createElement(RequireStage, { stage: "team" }, React.createElement(ConnectionsPage)) },
    { path: "*", element: React.createElement("p", null, "onboarding") },
  ], { initialEntries: [entry] });
  t.after(async () => {
    await act(async () => root.unmount());
    router.dispose();
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router }))));
  assert.equal(router.state.location.pathname, "/join");
  assert.ok(requests.includes("POST /api/v1/cli/device/hold"), "the guard must notify the Worker before the CLI polls");
  await Promise.all(pending);
  const reopenAndApprove = async () => {
    await h.joinTeam();
    const { api } = await import("../src/lib/api.ts");
    await client.fetchQuery({ queryKey: ["connections"], queryFn: api.connections });
    await act(async () => {
      client.setQueryData(["session"], { ...session, cohort: { slug: "test", name: "Test cohort" }, team: { id: "team_a", name: "Team A", description: null, repo: null } });
      await router.navigate(entry);
    });
    await act(async () => { await Promise.all(pending); });
    const approve = [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve device");
    assert.ok(approve, "reopening the URL after joining shows the approval form");
    await act(async () => {
      approve.click();
      await Promise.all(pending);
    });
    assert.ok(requests.includes("POST /api/v1/cli/device/approve"));
  };
  return { reopenAndApprove };
}

test("the guarded approval URL tells the real CLI once, then joining and reopening completes the link", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  let page: Awaited<ReturnType<typeof browser>>;
  let verificationUri = "";
  let polls = 0;
  let failure: unknown;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const path = req.url!;
      if (path.endsWith("/token") && ++polls === 3) await page.reopenAndApprove();
      const response = await h.send(path, {
        method: req.method,
        headers: req.headers.authorization ? { Authorization: req.headers.authorization } : {},
        ...(req.method === "POST" ? { body: Buffer.concat(chunks).toString() } : {}),
      });
      const text = await response.text();
      if (path.endsWith("/start")) {
        const start = JSON.parse(text);
        verificationUri = start.verificationUri;
        const url = new URL(verificationUri);
        page = await browser(t, h, `${url.pathname}${url.search}`);
      }
      if (path.endsWith("/token") && polls < 3) {
        assert.equal(JSON.parse(text).teamRequired, true);
        assert.equal(JSON.parse(text).status, "pending");
      }
      res.writeHead(response.status, { "content-type": "application/json" }).end(text);
    } catch (error) {
      failure = error;
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const helper = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "device-link-cli.py");
  const source = join(MIGRATIONS, "../../..", "python/cogbench/src");
  const child = spawn("python3", [helper, `http://127.0.0.1:${address.port}`, source], { env: { ...process.env, NODE_ENV: undefined } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (failure) throw failure;
  assert.equal(code, 0, stderr);
  const hint = `This account isn't on a team yet. Join a team in the browser, then reopen ${verificationUri} to approve this device. Still waiting.`;
  assert.equal(stdout.split(hint).length - 1, 1, stdout);
  assert.ok(stdout.indexOf(hint) < stdout.indexOf("Linked "), stdout);
  assert.equal(polls, 3);
  assert.equal(h.sqlite.prepare("SELECT count(*) AS n FROM cli_devices").get()!.n, 1);
});
