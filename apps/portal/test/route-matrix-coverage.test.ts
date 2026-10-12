import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { registeredRoutes } from "../worker/app.ts";
import { NO_POSITIVE, POLICY } from "../../../tools/portal-real-journeys/journeys/route-policy.mjs";
import { PAGE_POLICY } from "../../../tools/portal-real-journeys/journeys/page-policy.mjs";

/**
 * The real-journeys authorization matrix (tools/portal-real-journeys,
 * s5-route-matrix and s5-page-matrix) runs locally, not in CI. These checks
 * do run in CI, so a route or page added without a policy row fails here
 * instead of going untested until someone runs the suite.
 */

test("every Worker route has a row in the authorization matrix's policy", () => {
  const routes = registeredRoutes();
  assert.deepEqual([...routes].sort(), Object.keys(POLICY).sort());
  for (const key of Object.keys(NO_POSITIVE)) assert.ok(routes.includes(key), `${key} has no positive control but isn't registered`);
});

test("every SPA route has a row in the page matrix's policy", () => {
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "App.tsx"), "utf8");
  const pages: string[] = [];
  for (const match of app.matchAll(/<Route\b([^>]*?)\/?>/gs)) {
    const props = match[1] ?? "";
    const path = props.match(/\bpath="([^"]+)"/)?.[1];
    if (/\bindex\b/.test(props)) pages.push("/");
    else if (path) pages.push(`/${path}`);
  }
  assert.deepEqual([...pages].sort(), Object.keys(PAGE_POLICY).sort());
});
