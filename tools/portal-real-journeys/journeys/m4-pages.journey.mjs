// M4 on every S1 to S6 page: axe with zero violations once content has
// loaded, text contrast measured on pixels where axe can't decide, no
// horizontal overflow, at 1440x900, 390x844 and 320x640; and, under
// prefers-reduced-motion at 1440 and 390 wide, nothing animating at all, from
// the page's first script through hovering, focusing and opening its
// controls, on every page and in the embedded Activity.
//
// Each page is opened as the person who would be on it, in a populated
// portal (journeys/world.mjs): a run, its console, staff, and an owner.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVITY, STACK, doubles, fresh } from "./helpers.mjs";
import { VIEWPORTS, exercise, expectAccessible, expectNoMotion, recordMotion, settle } from "./a11y.mjs";
import { buildWorld, call, devLogin } from "./world.mjs";

let world;
let joiner;
let connector;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await fresh();
  world = await buildWorld();
  // Someone who has only signed in (Join), and someone in the cohort with no team (Connect).
  joiner = await devLogin("rj-m4-joiner");
  connector = await devLogin("rj-m4-connector");
  await call("POST", "/api/cohorts/join", { who: connector, body: { code: "VISION26" } });
});

/** Cookie header -> Playwright cookies for one host. */
function cookiesFor(header, host) {
  if (!header) return [];
  return header.split("; ").map((pair) => {
    const index = pair.indexOf("=");
    return { name: pair.slice(0, index), value: pair.slice(index + 1), domain: host, path: "/" };
  });
}

const PAGES = [
  { name: "landing", who: null, path: "/", heading: { level: 1 } },
  { name: "leaderboard", who: null, path: "/leaderboard", heading: { level: 1 } },
  { name: "sign-in", who: null, path: "/signin", heading: { level: 1 } },
  { name: "not-found", who: null, path: "/no-such-page", heading: { name: "There's nothing at this address." } },
  { name: "join", who: () => joiner, path: "/join", heading: { level: 1 } },
  { name: "connect", who: () => connector, path: "/connect", heading: { level: 1 } },
  { name: "connections", who: () => world.who.studentA, path: "/connections", heading: { level: 1 } },
  { name: "setup", who: () => world.who.studentA, path: "/setup", heading: { level: 1 } },
  { name: "runs", who: () => world.who.studentA, path: "/dashboard", heading: { level: 1 } },
  { name: "team", who: () => world.who.studentA, path: "/team", heading: { level: 1 } },
  { name: "run", who: () => world.who.studentA, path: () => `/runs/${world.ids.runA}`, heading: { level: 1 } },
  { name: "run-console", who: () => world.who.studentA, path: () => `/run-surfaces/${world.ids.surfaceA}`, heading: { level: 1 } },
  { name: "admin", who: () => world.who.owner, path: "/admin", heading: { level: 1 } },
  { name: "desk", who: () => world.who.taAssigned, path: "/desk", heading: { level: 1 } },
  { name: "desk-team", who: () => world.who.taAssigned, path: () => `/desk/${world.ids.teamA}`, heading: { level: 1 } },
  { name: "activity-unembedded", who: null, host: ACTIVITY, path: "/", heading: { level: 1 } },
];

async function open(browser, page_, viewport, { reducedMotion = "no-preference" } = {}) {
  const host = page_.host ?? STACK;
  const context = await browser.newContext({ viewport, reducedMotion });
  if (reducedMotion === "reduce") await recordMotion(context);
  const who = page_.who?.();
  if (who?.cookie) await context.addCookies(cookiesFor(who.cookie, new URL(host).hostname));
  const page = await context.newPage();
  const target = typeof page_.path === "function" ? page_.path() : page_.path;
  await page.goto(`${host}${target}`);
  await expect(page).toHaveURL(`${host}${target}`);
  await expect(page.getByRole("heading", page_.heading).first()).toBeVisible();
  await settle(page);
  return { context, page };
}

for (const viewport of VIEWPORTS) {
  test(`every S1 to S6 page passes axe, contrast and overflow at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    test.setTimeout(300_000);
    const failures = [];
    for (const entry of PAGES) {
      const { context, page } = await open(browser, entry, viewport);
      try {
        await expectAccessible(page, `${entry.name} at ${viewport.width}`);
      } catch (error) {
        failures.push(`${entry.name}: ${String(error.message).split("\n").slice(0, 60).join("\n")}`);
      } finally {
        await context.close();
      }
    }
    expect(failures, "pages that failed M4").toEqual([]);
  });
}

const MOTION_VIEWPORTS = VIEWPORTS.filter((viewport) => viewport.width !== 320);

for (const viewport of MOTION_VIEWPORTS) {
  test(`under reduced motion nothing on any S1 to S6 page animates at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    test.setTimeout(420_000);
    const failures = [];
    for (const entry of PAGES) {
      const { context, page } = await open(browser, entry, viewport, { reducedMotion: "reduce" });
      try {
        await exercise(page);
        await expectNoMotion([page], `${entry.name} at ${viewport.width}`);
      } catch (error) {
        failures.push(`${entry.name}: ${String(error.message).split("\n").slice(0, 24).join("\n")}`);
      } finally {
        await context.close();
      }
    }
    expect(failures).toEqual([]);
  });
}

// The Activity inside the Discord client double (s6-activity-frontend): the
// link gate, then the bench with a finished run. axe and the contrast check
// read inside the frame; overflow is the frame's own.
const DOUBLE_PAGE = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "stack", "discord-client-double.html"), "utf8");

async function activityFrame(browser, viewport, code, user, { reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion });
  if (reducedMotion === "reduce") await recordMotion(context);
  const page = await context.newPage();
  await page.route(`${ACTIVITY}/__rj/discord-client**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: DOUBLE_PAGE }));
  await doubles.discordCode(code, user);
  await page.goto(`${ACTIVITY}/__rj/discord-client?code=${code}&user=${encodeURIComponent(JSON.stringify(user))}`);
  const frame = page.frame({ url: /frame_id=/ });
  return { context, page, frame };
}

for (const viewport of VIEWPORTS) {
  test(`the embedded Activity's gate and bench pass axe, contrast and overflow at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const n = VIEWPORTS.indexOf(viewport);
    const gate = await activityFrame(browser, viewport, `rj-m4-gate-${n}`, { id: `90000000000000040${n}`, username: `rj-m4-gate-${n}` });
    try {
      await expect(gate.frame.getByRole("heading", { name: "Link Cog*Portal to see your team's bench." })).toBeVisible();
      await expectAccessible(gate.page, `Activity gate at ${viewport.width}`, { frame: gate.frame });
    } finally {
      await gate.context.close();
    }
    // world.who.activityA is linked to student A, whose team has a finished run.
    const user = { id: "900000000000000201", username: "rj-m-discord-a" };
    const bench = await activityFrame(browser, viewport, `rj-m4-bench-${n}`, user);
    try {
      await expect(bench.frame.getByText("Run summary")).toBeVisible();
      await expectAccessible(bench.page, `Activity bench at ${viewport.width}`, { frame: bench.frame });
    } finally {
      await bench.context.close();
    }
  });
}

for (const viewport of MOTION_VIEWPORTS) {
  test(`under reduced motion nothing in the embedded Activity's gate or bench animates at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const n = VIEWPORTS.indexOf(viewport);
    const gate = await activityFrame(browser, viewport, `rj-m4-still-gate-${n}`, { id: `90000000000000041${n}`, username: `rj-m4-still-gate-${n}` }, { reducedMotion: "reduce" });
    try {
      await expect(gate.frame.getByRole("heading", { name: "Link Cog*Portal to see your team's bench." })).toBeVisible();
      await exercise(gate.page, gate.frame);
      await expectNoMotion([gate.page, gate.frame], `Activity gate at ${viewport.width}`);
    } finally {
      await gate.context.close();
    }
    const user = { id: "900000000000000201", username: "rj-m-discord-a" };
    const bench = await activityFrame(browser, viewport, `rj-m4-still-bench-${n}`, user, { reducedMotion: "reduce" });
    try {
      await expect(bench.frame.getByText("Run summary")).toBeVisible();
      await exercise(bench.page, bench.frame);
      await expectNoMotion([bench.page, bench.frame], `Activity bench at ${viewport.width}`);
    } finally {
      await bench.context.close();
    }
  });
}
