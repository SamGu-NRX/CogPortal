import assert from "node:assert/strict";
import { test } from "node:test";
import { generateCookie } from "hono/cookie";
import { Hono } from "hono";
import {
  activityCookieOptions,
  activityTokenRejection,
  registerActivityRoutes,
} from "../worker/routes/activity.ts";
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

/**
 * What survives a refused token exchange.
 *
 * The route used to discard Discord's status and reason, so a student hitting
 * "Discord could not authorize the Activity" on the hosted Activity left no
 * evidence behind. These pin the two properties that make the next one a single
 * log line: the reason is kept whatever it is, and nothing around it is.
 */

test("Discord's reason for refusing the exchange is recorded", () => {
  // The exact status and body Discord returns to an unknown client.
  const rejection = activityTokenRejection(400, { error: "invalid_client" });

  assert.equal(rejection.logged.error, "invalid_client");
  assert.equal(rejection.logged.status, 400);
});

test("an identifier we have never seen is recorded, not flattened", () => {
  // The whole point of the record is the response nobody predicted. Keeping
  // only recognised values would drop exactly those.
  assert.equal(activityTokenRejection(400, { error: "authorization_pending" }).logged.error, "authorization_pending");
});

test("a response with no error field still says so, next to its status", () => {
  // Discord's rate-limit body carries message/retry_after/global and no error
  // at all, and an edge failure returns HTML. 429 beside "none" is the answer.
  assert.equal(activityTokenRejection(429, { message: "You are being rate limited.", retry_after: 4.2 }).logged.error, "none");
  assert.equal(activityTokenRejection(502, null).logged.error, "none");
});

test("the record carries the reason and nothing else", () => {
  // A refused exchange can echo the request that was refused, and that request
  // carries the client secret and the authorization code.
  const rejection = activityTokenRejection(400, {
    error: "invalid_client",
    error_description: "Invalid \"client_id\" or \"client_secret\"",
    request: "client_secret=REDACTED&code=REDACTED",
  });

  assert.deepEqual(Object.keys(rejection.logged).sort(), ["error", "evt", "status"]);
  assert.doesNotMatch(JSON.stringify(rejection.logged), /client_secret|code=|REDACTED/);
});

test("a refused grant sends the student back for a fresh one", () => {
  assert.match(activityTokenRejection(400, { error: "invalid_grant" }).message, /open it again/);
});

test("only a refusal that names our credentials says reopening cannot help", () => {
  for (const error of ["invalid_client", "unauthorized_client", "invalid_scope"]) {
    assert.match(activityTokenRejection(400, { error }).message, /reopening won't change that/);
  }
});

test("a refusal we cannot explain does not blame our configuration", () => {
  // 429 and 502 clear on their own, so telling a student the fix is on our side
  // is both a guess and the wrong next move.
  for (const rejection of [
    activityTokenRejection(429, { message: "You are being rate limited." }),
    activityTokenRejection(502, null),
    activityTokenRejection(400, { error: "something_new" }),
  ]) {
    assert.doesNotMatch(rejection.message, /the fix is on our side/);
    assert.match(rejection.message, /Open the Activity again/);
  }
});

test("no student-facing sentence carries a provider identifier", () => {
  for (const error of ["invalid_client", "invalid_grant", "unauthorized_client", "slow_down"]) {
    const { message } = activityTokenRejection(400, { error });
    assert.doesNotMatch(message, /invalid_|unauthorized_client|slow_down|oauth/i);
  }
});
