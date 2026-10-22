// S5, authorization in the UI: every page the SPA registers, opened by every
// person, and where each one ends up.
//
// The page list is the router's own: the <Route path> entries in
// apps/portal/src/App.tsx, read from the source, so a page added without a
// row here fails the journey. A cell is the address the browser settles on
// and the page's main heading, which is what a person sees. The policy
// (page-policy.mjs) groups people by that outcome. Every page each person
// opens is also searched for the private data planted in the world
// (canaries.mjs) that they may not read, and a few pages must show a person
// their own (PAGE_CONTENT in page-policy.mjs).
//
// RJ_MATRIX_OBSERVE=1 records to test-results/evidence/page-matrix-observed.json
// instead of asserting, and then fails (helpers.mjs matrixMode).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { STACK, failObserved, fresh, matrixMode } from "./helpers.mjs";
import { REPO_ROOT } from "./cli.mjs";
import { buildWorld, worldFacts } from "./world.mjs";
import { leaks, plantCanaries } from "./canaries.mjs";
import { PAGE_CONTENT, PAGE_IDENTITIES, PAGE_POLICY } from "./page-policy.mjs";

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

test("every SPA page lands each person where the policy says", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const mode = matrixMode(testInfo);
  const registered = spaRoutes();
  expect(registered.filter((route) => !OPEN[route]), "pages the router registers with no row here").toEqual([]);
  expect(Object.keys(OPEN).filter((route) => !registered.includes(route)), "rows for pages the router no longer registers").toEqual([]);

  await fresh();
  const world = await buildWorld();
  const w = { ...world, ...(await worldFacts(world)) };
  const canaries = await plantCanaries(w, { staffWithFullView: ["taAssigned", "owner"] });
  const observed = {};
  const leaked = [];
  /** Opens `target` as `identity`; returns the page, its outcome and its full DOM. */
  const visit = async (identity, target, read) => {
    const context = await browser.newContext();
    await context.addCookies(cookiesFor(w.who[identity].cookie));
    const page = await context.newPage();
    try {
      await page.goto(`${STACK}${target}`);
      const seen = await outcome(page, w);
      const html = await page.content();
      const found = leaks(html, identity, canaries);
      if (found.length) leaked.push({ page: target, identity, found });
      return { seen, html, extra: read ? await read(page) : undefined };
    } finally {
      await context.close();
    }
  };
  for (const route of registered) {
    for (const identity of PAGE_IDENTITIES) {
      const { seen } = await visit(identity, OPEN[route](w));
      ((observed[route] ??= {})[seen] ??= []).push(identity);
    }
  }
  const missing = [];
  for (const { identity, path: target, shows } of PAGE_CONTENT) {
    const resolved = target(w);
    const { html } = await visit(identity, resolved);
    const absent = shows.filter((text) => !html.includes(text));
    if (absent.length) missing.push({ page: resolved, identity, absent });
  }
  const out = path.join("test-results", "evidence", "page-matrix-observed.json");
  fs.writeFileSync(out, `${JSON.stringify(observed, null, 2)}\n`);
  fs.writeFileSync(path.join("test-results", "evidence", "page-matrix-content.json"), `${JSON.stringify({ leaked, missing }, null, 2)}\n`);
  if (mode === "observe") failObserved(out);
  const sort = (table = {}) =>
    Object.fromEntries(Object.entries(table).map(([k, v]) => [k, [...v].sort()]).sort(([a], [b]) => a.localeCompare(b)));
  const mismatches = registered
    .map((route) => ({ route, want: sort(PAGE_POLICY[route]), got: sort(observed[route]) }))
    .filter(({ want, got }) => JSON.stringify(want) !== JSON.stringify(got));
  expect(mismatches, `pages that differ from the policy (full table: ${out})`).toEqual([]);
  expect(leaked, "pages showing private data their reader may not see").toEqual([]);
  expect(missing, "pages that don't show their reader their own data").toEqual([]);
});
