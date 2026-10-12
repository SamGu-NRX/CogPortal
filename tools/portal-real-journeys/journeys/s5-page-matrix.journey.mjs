// S5, authorization in the UI: every page the SPA registers, opened by every
// person, and where each one ends up.
//
// The page list is the router's own: the <Route path> entries in
// apps/portal/src/App.tsx, read from the source, so a page added without a
// row here fails the journey. A cell is the address the browser settles on
// and the page's main heading, which is what a person sees. The policy
// (page-policy.mjs) groups people by that outcome.
//
// RJ_MATRIX_OBSERVE=1 records instead of asserting, to
// test-results/evidence/page-matrix-observed.json.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { STACK, fresh } from "./helpers.mjs";
import { REPO_ROOT } from "./cli.mjs";
import { buildWorld } from "./world.mjs";
import { PAGE_IDENTITIES, PAGE_POLICY } from "./page-policy.mjs";

/** `path` props of every <Route> in App.tsx, `index` as "/". */
export function spaRoutes() {
  const source = fs.readFileSync(path.join(REPO_ROOT, "apps", "portal", "src", "App.tsx"), "utf8");
  const routes = [];
  for (const match of source.matchAll(/<Route\b([^>]*?)(\/?)>/gs)) {
    const props = match[1];
    const pathProp = props.match(/\bpath="([^"]+)"/)?.[1];
    if (/\bindex\b/.test(props)) routes.push("/");
    else if (pathProp) routes.push(`/${pathProp}`);
  }
  return routes;
}

/** Where each registered page is opened; params point at team A's things. */
const OPEN = {
  "/": () => "/",
  "/leaderboard": () => "/leaderboard",
  "/signin": () => "/signin",
  "/join": () => "/join",
  "/connect": () => "/connect",
  "/connections": () => "/connections",
  "/setup": () => "/setup",
  "/dashboard": () => "/dashboard",
  "/team": () => "/team",
  "/runs/:runId": (w) => `/runs/${w.ids.runA}`,
  "/run-surfaces/:surfaceId": (w) => `/run-surfaces/${w.ids.surfaceA}`,
  "/admin": () => "/admin",
  "/desk": () => "/desk",
  "/desk/:teamId": (w) => `/desk/${w.ids.teamA}`,
  "/__gallery": () => "/__gallery",
  "/*": () => "/rj-no-such-page",
};

function cookiesFor(header) {
  if (!header) return [];
  return header.split("; ").map((pair) => {
    const index = pair.indexOf("=");
    return { name: pair.slice(0, index), value: pair.slice(index + 1), domain: "127.0.0.1", path: "/" };
  });
}

async function outcome(page, w) {
  // Settled: the address stops changing and a level-1 heading or an alert
  // is up. A page with neither is described by its main text.
  await page.waitForLoadState("networkidle").catch(() => {});
  const heading = page.getByRole("heading", { level: 1 }).first();
  const alert = page.locator("main").getByRole("alert").first();
  await heading.or(alert).first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  let text;
  if (await heading.isVisible().catch(() => false)) text = await heading.textContent();
  else if (await alert.isVisible().catch(() => false)) text = `alert: ${await alert.textContent()}`;
  else text = `main: ${((await page.locator("main").first().innerText().catch(() => "")) || "(empty)").slice(0, 100)}`;
  text = text.trim().replace(/\s+/g, " ");
  // Ids differ between runs; name them by role.
  const where = new URL(page.url()).pathname
    .replace(w.ids.runA, ":runA")
    .replace(w.ids.surfaceA, ":surfaceA")
    .replace(w.ids.teamA, ":teamA");
  return `${where} | ${text.replace(/\d+ (minutes?|seconds?|hours?) ago/g, "<time> ago")}`;
}

test("every SPA page lands each person where the policy says", async ({ browser }) => {
  test.setTimeout(600_000);
  const registered = spaRoutes();
  expect(registered.filter((route) => !OPEN[route]), "pages the router registers with no row here").toEqual([]);
  expect(Object.keys(OPEN).filter((route) => !registered.includes(route)), "rows for pages the router no longer registers").toEqual([]);

  await fresh();
  const w = await buildWorld();
  const observed = {};
  for (const route of registered) {
    for (const identity of PAGE_IDENTITIES) {
      const context = await browser.newContext();
      await context.addCookies(cookiesFor(w.who[identity].cookie));
      const page = await context.newPage();
      await page.goto(`${STACK}${OPEN[route](w)}`);
      const seen = await outcome(page, w);
      ((observed[route] ??= {})[seen] ??= []).push(identity);
      await context.close();
    }
  }
  const out = path.join("test-results", "evidence", "page-matrix-observed.json");
  fs.writeFileSync(out, `${JSON.stringify(observed, null, 2)}\n`);
  if (process.env.RJ_MATRIX_OBSERVE) return;
  const sort = (table = {}) =>
    Object.fromEntries(Object.entries(table).map(([k, v]) => [k, [...v].sort()]).sort(([a], [b]) => a.localeCompare(b)));
  const mismatches = registered
    .map((route) => ({ route, want: sort(PAGE_POLICY[route]), got: sort(observed[route]) }))
    .filter(({ want, got }) => JSON.stringify(want) !== JSON.stringify(got));
  expect(mismatches, `pages that differ from the policy (full table: ${out})`).toEqual([]);
});
