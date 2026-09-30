import assert from "node:assert/strict";
import { test } from "node:test";
import { generateCookie } from "hono/cookie";
import { Hono } from "hono";
import { activityCookieOptions, registerActivityRoutes } from "../worker/routes/activity.ts";
import type { AppEnv } from "../worker/env.ts";
import { ApiHttpError } from "../worker/http/errors.ts";
import { RetryRunRequestSchema } from "@cogworks/contracts/schema";
import { parseBody } from "../worker/http/respond.ts";

test("Activity OAuth cookies survive Discord's cross-site iframe", () => {
  const cookie = generateCookie(
    "activity_state",
    "opaque",
    activityCookieOptions("https://cogactivity-dev.sillion.app/api/activity/oauth/state", 600),
  );

  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Partitioned/);
  assert.match(cookie, /Priority=High/);
});

test("local Activity development keeps a first-party Lax cookie", () => {
  const cookie = generateCookie(
    "activity_state",
    "opaque",
    activityCookieOptions("http://127.0.0.1:5173/api/activity/oauth/state", 600),
  );

  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Partitioned/);
  assert.doesNotMatch(cookie, /Secure/);
});

test("Retry body parsing requires an explicit execution ID and preserves it", async () => {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    assert.ok(error instanceof ApiHttpError);
    return c.json({ code: error.code }, error.status);
  });
  app.post("/retry", async (c) => c.json(await parseBody(c, RetryRunRequestSchema)));
  for (const body of ["", "{", "{}", "null", '{"runId":null}', '{"runId":42}', '{"runId":""}']) {
    const response = await app.request("/retry", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    assert.equal(response.status, 400, body);
    assert.deepEqual(await response.json(), { code: "invalid_request" });
  }
  const target = { runId: "run_0123456789" };
  for (let replay = 0; replay < 2; replay += 1) {
    const response = await app.request("/retry", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), target);
  }
});

test("Activity Retry still requires its signed session before parsing or mutating", async () => {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    assert.ok(error instanceof ApiHttpError);
    return c.json({ message: error.message }, error.status);
  });
  registerActivityRoutes(app);
  const env = {
    DISCORD_CLIENT_ID: "activity-client",
    DISCORD_CLIENT_SECRET: "activity-secret",
    ACTIVITY_SESSION_SECRET: "activity-session-secret-long-enough",
  } as AppEnv["Bindings"];
  for (const cookie of [undefined, "cog_activity_session=forged.9999999999999"]) {
    const response = await app.request("/activity/run-surfaces/surface_0123456789abcdef0123/actions/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ runId: "run_0123456789" }),
    }, env);
    assert.equal(response.status, 401);
    assert.match((await response.json() as { message: string }).message, /Open the Cog Activity again/);
  }
});
