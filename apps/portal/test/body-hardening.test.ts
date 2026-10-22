import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { z } from "zod";
import type { AppEnv, Env } from "../worker/env.ts";
import { handleError } from "../worker/http/errors.ts";
import { boundedAuthRequest } from "../worker/http/auth-request.ts";
import { BODY_LIMITS, parseBody } from "../worker/http/respond.ts";
import { registerGithubRoutes } from "../worker/routes/github.ts";

const secret = "webhook-test-secret";
const portalEnv = { ENVIRONMENT: "development", GITHUB_WEBHOOK_SECRET: secret } as Env;

function signedGithubRequest(body: string): Request {
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("http://localhost/github/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${signature}`,
      "X-GitHub-Event": "ping",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
    },
    body,
  });
}

function githubApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  registerGithubRoutes(app);
  app.onError(handleError);
  return app;
}

test("GitHub webhook refuses an oversized body before checking its signature", async () => {
  const response = await githubApp().fetch(
    new Request("http://localhost/github/webhook", {
      method: "POST",
      headers: { "Content-Length": String(BODY_LIMITS.githubWebhook + 1) },
      body: "x",
    }),
    portalEnv,
  );
  assert.equal(response.status, 413);
});

test("GitHub webhook accepts a normally signed ping", async () => {
  const response = await githubApp().fetch(signedGithubRequest("{}"), portalEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("a throwing zod callback reaches the 500 handler", async () => {
  const app = new Hono<AppEnv>();
  app.post("/parse", async (c) => parseBody(c, z.string().transform(() => { throw new Error("boom"); })));
  app.onError(handleError);
  const response = await app.fetch(new Request("http://localhost/parse", { method: "POST", body: JSON.stringify("ok") }), portalEnv);
  assert.equal(response.status, 500);
});

test("Better Auth's bounded request rejects an oversized body before its parser", async () => {
  const app = new Hono<AppEnv>();
  let parserCalled = false;
  app.post("/auth", async (c) => {
    const request = await boundedAuthRequest(c);
    parserCalled = true;
    return new Response(await request.text());
  });
  app.onError(handleError);
  const oversized = await app.fetch(
    new Request("http://localhost/auth", {
      method: "POST",
      headers: { "Content-Length": String(BODY_LIMITS.auth + 1) },
      body: "x",
    }),
    portalEnv,
  );
  assert.equal(oversized.status, 413);
  assert.equal(parserCalled, false);

  const normal = await app.fetch(new Request("http://localhost/auth", { method: "POST", body: "{}" }), portalEnv);
  assert.equal(normal.status, 200);
  assert.equal(await normal.text(), "{}");
});

function realAuthApp(observe: (request: Request) => Promise<void>): Hono<AppEnv> {
  // No database option uses Better Auth's built-in memory adapter.
  const auth = betterAuth({
    baseURL: "http://localhost",
    secret: "body-preservation-test-secret-at-least-32-characters",
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    plugins: [{
      id: "observe-request-bytes",
      async onRequest(request) {
        await observe(request);
      },
    }],
  });
  const app = new Hono<AppEnv>();
  app.all("/api/auth/*", async (c) => auth.handler(await boundedAuthRequest(c)));
  app.onError(handleError);
  return app;
}

test("real Better Auth accepts a body-less sign-out without adding Content-Type", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network must not run"); });
  let observed: Request | undefined;
  const app = realAuthApp(async (request) => { observed = request; });
  const response = await app.fetch(new Request("http://localhost/api/auth/sign-out", { method: "POST" }), portalEnv);
  assert.equal(response.status, 200);
  assert.ok(observed);
  assert.equal(observed.body, null);
  assert.equal(observed.headers.get("Content-Type"), null);
});

test("real Better Auth receives JSON sign-in bytes and headers unchanged, including a BOM", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network must not run"); });
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ email: "synthetic@example.test", password: "invalid-password" }))]);
  const headers = new Headers({ "Content-Type": "application/json", "Content-Length": String(bytes.byteLength), "X-Test-Header": "unchanged" });
  let observed: Uint8Array | undefined;
  let observedHeaders: Headers | undefined;
  const app = realAuthApp(async (request) => {
    observed = new Uint8Array(await request.clone().arrayBuffer());
    observedHeaders = request.headers;
  });
  const response = await app.fetch(new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST", headers, body: bytes,
  }), portalEnv);
  assert.deepEqual(observed, new Uint8Array(bytes));
  assert.ok(observedHeaders);
  assert.deepEqual([...observedHeaders], [...headers]);
  // The real parser accepts the JSON and the real handler rejects nonexistent credentials.
  assert.equal(response.status, 401);
});
