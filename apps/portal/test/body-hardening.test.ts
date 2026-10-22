import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
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
