import assert from "node:assert/strict";
import { test } from "node:test";
import { generateCookie } from "hono/cookie";
import { activityCookieOptions } from "../worker/routes/activity.ts";

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
