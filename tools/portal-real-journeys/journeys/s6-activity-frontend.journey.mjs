// S6, the Activity frontend itself (apps/portal/src/activity-main.tsx), on
// the Activity's own host (localhost here, cogactivity.sillion.app deployed).
//
// - Unembedded: opened in a plain browser tab, the Activity says to open it
//   from Discord and links to the portal.
// - Embedded: framed by the Discord client double
//   (stack/discord-client-double.html), which answers the embedded SDK's
//   RPC the way the Discord client does. The SDK, the Activity's code
//   exchange through the Worker, the Discord API double and the portal are
//   all real; only Discord's client and its /.proxy mapping are doubles.
//
// Journeys: the link gate (not linked, link in the portal, check), the team
// gate (linked with no team), and the live console following a hosted
// practice run to its end.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVITY, STACK, doubles, evidence, expectNoDispatch, fresh, signIn } from "./helpers.mjs";

const DOUBLE_PAGE = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "stack", "discord-client-double.html"),
  "utf8",
);
const DOUBLE_URL = `${ACTIVITY}/__rj/discord-client`;

/**
 * Opens the Activity inside the Discord client double, as `user`, who
 * authorizes with `code`. Returns the Activity's frame.
 */
async function openInDiscord(page, { code, user }) {
  await page.route(`${DOUBLE_URL}**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", headers: { "x-cogportal-double": "discord-client" }, body: DOUBLE_PAGE }),
  );
  await doubles.discordCode(code, user);
  await page.goto(`${DOUBLE_URL}?code=${encodeURIComponent(code)}&user=${encodeURIComponent(JSON.stringify(user))}`);
  return page.frameLocator("#activity");
}

const discordState = (page) => page.evaluate(() => window.__rjDiscord);

test("opened outside Discord, the Activity says where to open it and links to the portal", async ({ page }) => {
  await fresh();
  await page.goto(`${ACTIVITY}/`);
  await expect(page).toHaveTitle("Cog · Live bench");
  await expect(page.getByRole("heading", { name: "Open the live bench from Discord." })).toBeVisible();
  const portal = page.getByRole("link", { name: "Open Cog*Portal" });
  await expect(portal).toHaveAttribute("href", STACK);
  // Nothing was asked of Discord or the Worker's Activity routes.
  expect(await doubles.journal("discord")).toEqual([]);
});

test("the link gate sends the student to the portal, and the check opens their team's bench", async ({ browser }) => {
  await fresh();
  const user = { id: "900000000000000101", username: "rj-gate-student", global_name: "RJ Gate Student" };
  const portalContext = await browser.newContext();
  const portal = await portalContext.newPage();
  await signIn(portal, "rj-gate-student", { demo: true });

  const discordContext = await browser.newContext();
  const page = await discordContext.newPage();
  try {
    const activity = await openInDiscord(page, { code: "rj-gate-code", user });
    await expect(activity.getByRole("heading", { name: "Link Cog*Portal to see your team's bench." })).toBeVisible();
    const state = await discordState(page);
    expect(state.commands).toEqual(expect.arrayContaining(["HANDSHAKE", "AUTHORIZE", "AUTHENTICATE"]));
    // The code went through the Worker to the Discord double once.
    const exchanges = (await doubles.journal("discord")).filter((entry) => entry.path === "/oauth2/token");
    expect(exchanges.map((entry) => entry.status)).toEqual([200]);

    await activity.getByRole("button", { name: /Link Cog\*Portal/ }).click();
    await expect(activity.getByRole("heading", { name: "Once you've linked it in the browser, check here." })).toBeVisible();
    // Checking before linking says nothing moved.
    await activity.getByRole("button", { name: "Check the link" }).click();
    await expect(activity.getByRole("status").filter({ hasText: "Discord isn't linked to a portal account yet." })).toBeVisible();

    const [linkUrl] = (await discordState(page)).opened;
    expect(new URL(linkUrl).origin).toBe(STACK);
    await portal.goto(linkUrl);
    await portal.getByRole("button", { name: "Connect Discord" }).click();
    await expect(portal.getByText(user.username).first()).toBeVisible();

    await activity.getByRole("button", { name: "Check the link" }).click();
    await expect(activity.getByRole("heading", { name: "No shared runs yet." })).toBeVisible();
    await expect(activity.getByText("Demo Team · live bench")).toBeVisible();
    await evidence(page, "activity-bench-empty");
  } finally {
    await discordContext.close();
    await portalContext.close();
  }
  await expectNoDispatch();
});

test("a linked student with no team meets the team gate, which sends them to team setup", async ({ browser }) => {
  await fresh();
  const user = { id: "900000000000000102", username: "rj-teamless", global_name: null };
  // Linked to a portal account that joined the cohort but has no team. The
  // link itself is made through the real Activity and portal path first.
  const portalContext = await browser.newContext();
  const portal = await portalContext.newPage();
  await signIn(portal, "rj-teamless", { demo: true });
  const discordContext = await browser.newContext();
  const page = await discordContext.newPage();
  try {
    let activity = await openInDiscord(page, { code: "rj-teamless-code-1", user });
    await activity.getByRole("button", { name: /Link Cog\*Portal/ }).click();
    await expect.poll(async () => (await discordState(page)).opened.length).toBe(1);
    await portal.goto((await discordState(page)).opened[0]);
    await portal.getByRole("button", { name: "Connect Discord" }).click();
    await expect(portal.getByText(user.username).first()).toBeVisible();

    // The student leaves their team in the portal.
    const session = await (await portal.request.get(`${STACK}/api/session`)).json();
    const leave = await portal.request.post(`${STACK}/api/team/leave`, { data: { teamId: session.team.id } });
    expect(leave.status(), await leave.text()).toBe(200);

    activity = await openInDiscord(page, { code: "rj-teamless-code-2", user });
    await expect(activity.getByRole("heading", { name: "You're linked, but not on a team yet." })).toBeVisible();
    await activity.getByRole("button", { name: /Finish team setup/ }).click();
    await expect.poll(async () => (await discordState(page)).opened.at(-1)).toMatch(new RegExp(`^${STACK}`));
    // The Worker refuses the bench's data to a teamless identity.
    const refused = await page.request.get(`${ACTIVITY}/api/activity/run-surfaces`);
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error).toEqual({ code: "no_team", message: "Link Discord and finish joining a Cog*Portal team first." });
  } finally {
    await discordContext.close();
    await portalContext.close();
  }
});

test("the live console follows a hosted practice run to its end", async ({ browser }) => {
  test.setTimeout(180_000);
  await fresh();
  const user = { id: "900000000000000103", username: "rj-console-student", global_name: "RJ Console" };
  const portalContext = await browser.newContext();
  const portal = await portalContext.newPage();
  await signIn(portal, "rj-console-student", { demo: true });
  const discordContext = await browser.newContext();
  const page = await discordContext.newPage();
  try {
    // Link through the gate, as above.
    let activity = await openInDiscord(page, { code: "rj-console-code-1", user });
    await activity.getByRole("button", { name: /Link Cog\*Portal/ }).click();
    await expect.poll(async () => (await discordState(page)).opened.length).toBe(1);
    await portal.goto((await discordState(page)).opened[0]);
    await portal.getByRole("button", { name: "Connect Discord" }).click();
    await expect(portal.getByText(user.username).first()).toBeVisible();

    // A practice run started from the portal's Runs page, and the Activity
    // reopened while it runs: the console streams it live to its end.
    await portal.goto(`${STACK}/dashboard`);
    await portal.getByRole("button", { name: "Run practice benchmark" }).click();
    await expect.poll(async () => (await (await portal.request.get(`${STACK}/api/runs`)).json()).length).toBe(1);
    const [run] = await (await portal.request.get(`${STACK}/api/runs`)).json();

    activity = await openInDiscord(page, { code: "rj-console-code-2", user });
    const bench = activity.getByRole("region", { name: /^Live run for / });
    await expect(bench).toBeVisible();
    await expect(activity.getByText("Live events")).toBeVisible();
    await expect(activity.getByText("Run summary")).toBeVisible({ timeout: 90_000 });
    await expect(activity.getByText("Run complete")).toBeVisible();
    const [surface] = await (await page.request.get(`${ACTIVITY}/api/activity/run-surfaces`)).json();
    const detail = await (await portal.request.get(`${STACK}/api/runs/${run.id}`)).json();
    expect(surface.id).toBe(detail.surfaceId);
    await evidence(page, "activity-console-finished");

    // The console's own action, through the Activity's route: promote, after
    // the question that names the attempt it uses.
    await activity.getByRole("button", { name: "Promote to official" }).click();
    const dialog = activity.getByRole("dialog");
    await expect(dialog).toContainText(/official attempt 1 of \d+/);
    await dialog.getByRole("button", { name: /^Use attempt 1 of \d+$/ }).click();
    await expect.poll(async () => (await (await portal.request.get(`${STACK}/api/runs`)).json()).filter((r) => r.mode === "official").length).toBe(1);
    // The console follows the official run it just started.
    await expect(activity.getByText(/official · (queued|preparing|installing|contract_check|evaluating|scoring|succeeded)/).first()).toBeVisible();

    // Leaving for the portal goes through Discord's external-link command.
    await activity.getByRole("button", { name: /Open Cog\*Portal/ }).or(activity.getByRole("link", { name: /Open Cog\*Portal/ })).first().click();
    await expect.poll(async () => (await discordState(page)).opened.at(-1)).toMatch(new RegExp(`^${STACK}/run-surfaces/`));
  } finally {
    await discordContext.close();
    await portalContext.close();
  }
  await expectNoDispatch();
});
