// M4, keyboard: the core journeys finished with Tab, Shift+Tab, Enter, Space,
// Escape and typing alone, and focus after each action landing somewhere that
// makes sense (never dropped to the document body): a student's onboarding
// and a run's life, a TA's way through the admin console and the desk, and
// the embedded Activity's link gate and bench. Each at 1440x900, on a
// 390x844 phone, and at 320x640.
//
// `tabTo` presses Tab until the wanted control has focus, failing if it
// takes more than a page's worth of stops, so a control that can't be
// reached by keyboard fails the journey rather than being clicked.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVITY, STACK, control, doubles, expectNoDispatch, fresh, signIn } from "./helpers.mjs";
import { focused } from "./a11y.mjs";
import { devLogin, practiceRun } from "./world.mjs";

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];

async function tabTo(page, locator, { max = 80, back = false } = {}) {
  const handle = await locator.elementHandle();
  for (let i = 0; i < max; i += 1) {
    // Focus on the control, inside it, or on the control that wraps it (a
    // <summary> around its label).
    if (await handle.evaluate((el) => { const a = document.activeElement; return a !== document.body && (el === a || el.contains(a) || a.contains(el)); })) return;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
  }
  throw new Error(`could not reach ${locator} by keyboard in ${max} stops`);
}

/**
 * Focus lands somewhere other than the page body. After a navigation the
 * portal moves focus to the new page's heading once it renders
 * (lib/route-focus.ts), which on this stack is about 40ms after the address
 * changes, so this waits up to two seconds for it rather than reading the
 * instant the URL changed.
 */
async function expectFocusKept(target, what) {
  await expect.poll(() => focused(target), { message: `focus after ${what} fell to the page body`, timeout: 2_000 }).not.toBeNull();
}

/** The one visible match: navigation renders in a desktop and a phone copy. */
const visible = (locator) => locator.filter({ visible: true }).first();

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("a new student signs in, joins and starts a team by keyboard alone", async ({ page }) => {
      await fresh();
      await page.goto(`${STACK}/signin`);
      await expect(page.getByText("Development sign-in")).toBeVisible();
      const field = page.getByLabel("Sign in as");
      if (!(await field.isVisible())) {
        await tabTo(page, page.getByText("Development sign-in"));
        await page.keyboard.press("Enter");
      }
      await tabTo(page, field);
      await page.keyboard.type("rj-keyboard-student");
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(`${STACK}/join`);
      await expectFocusKept(page, "arriving on Join");
      await tabTo(page, page.getByLabel("Join code"));
      await page.keyboard.type("vision26");
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(new RegExp(`${STACK}/connect`));
      await tabTo(page, page.getByText("Start a new team"));
      await page.keyboard.press("Enter");
      const repo = page.getByRole("radio", { name: /cogworks-demo\/face-finder/ });
      await tabTo(page, repo);
      await page.keyboard.press("Space");
      await expect(repo).toBeChecked();
      await tabTo(page, page.getByLabel("Team name"));
      await page.keyboard.type("RJ Keyboard Team");
      await tabTo(page, page.getByRole("button", { name: "Create RJ Keyboard Team" }));
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${STACK}/setup`);
      await expectFocusKept(page, "creating the team");
    });

    test("a practice run is started, opened and its console's publish question answered by keyboard", async ({ page }) => {
      test.setTimeout(240_000);
      await fresh();
      await signIn(page, "rj-keyboard-runner", { demo: true });
      await page.goto(`${STACK}/dashboard`);
      const start = page.getByRole("button", { name: "Run practice benchmark" });
      await tabTo(page, start);
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await (await page.request.get(`${STACK}/api/runs`)).json()).length).toBe(1);
      await expectFocusKept(page, "starting a run");
      const [run] = await (await page.request.get(`${STACK}/api/runs`)).json();

      // Open the run from the history by keyboard.
      await page.reload();
      const link = page.locator(`a[href="/runs/${run.id}"]`).first();
      await tabTo(page, link, { max: 120 });
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${STACK}/runs/${run.id}`);
      await expect(page.getByText("Succeeded").first()).toBeVisible({ timeout: 60_000 });

      // Promote from the Runs page: the confirm is a second press on the same control.
      await page.goto(`${STACK}/dashboard`);
      const promote = page.getByRole("button", { name: "Promote to official" }).first();
      await tabTo(page, promote, { max: 120 });
      await page.keyboard.press("Enter");
      const confirm = page.getByRole("button", { name: /Confirm, uses attempt 1 of/ });
      await expect(confirm).toBeFocused();
      await page.keyboard.press("Enter");
      let official;
      await expect
        .poll(async () => {
          official = (await (await page.request.get(`${STACK}/api/runs`)).json()).find((r) => r.mode === "official");
          return official?.status;
        }, { timeout: 90_000 })
        .toBe("succeeded");

      // The console's publish question: Escape closes it and returns focus to
      // the button that asked; Enter on Publish publishes.
      const detail = await (await page.request.get(`${STACK}/api/runs/${official.id}`)).json();
      await page.goto(`${STACK}/run-surfaces/${detail.surfaceId}`);
      const publish = page.getByRole("button", { name: "Publish result" });
      await tabTo(page, publish, { max: 120 });
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(publish).toBeFocused();
      await page.keyboard.press("Enter");
      await tabTo(page, dialog.getByRole("button", { name: "Publish", exact: true }));
      await page.keyboard.press("Enter");
      await expect(dialog).toHaveCount(0);
      await expectFocusKept(page, "publishing");
      await expect
        .poll(async () => (await (await page.request.get(`${STACK}/api/leaderboard?benchmark=${official.benchmarkId}`)).json()).entries.some((e) => e.sha === detail.sha))
        .toBe(true);
      await expectNoDispatch();
    });

    test("a TA opens a team on the admin console and goes to its desk page and back by keyboard", async ({ page }) => {
      await fresh();
      await devLogin("rj-keyboard-desk-student", { demo: true });
      await signIn(page, "rj-keyboard-ta");
      // The admin form assigns TAs by GitHub login, which dev accounts don't carry.
      const [{ id: teamId }] = await control.sql("SELECT id FROM teams WHERE name = 'Demo Team'");
      await control.sql(`INSERT INTO team_tas (team_id, user_id, assigned_at) SELECT '${teamId}', id, 1 FROM users WHERE email = 'rj-keyboard-ta@dev.local'`);

      await page.goto(`${STACK}/admin`);
      const row = visible(page.getByRole("button", { name: /Demo Team/ }));
      await tabTo(page, row, { max: 120 });
      await page.keyboard.press("Enter");
      await expect(row).toHaveAttribute("aria-expanded", "true");
      await expect(row).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(row).toHaveAttribute("aria-expanded", "false");
      await expect(row).toBeFocused();

      await tabTo(page, visible(page.getByRole("link", { name: "Desk", exact: true })), { max: 120 });
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${STACK}/desk`);
      await expectFocusKept(page, "opening the desk");
      await tabTo(page, visible(page.getByRole("link", { name: /Demo Team/ })), { max: 120 });
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${STACK}/desk/${teamId}`);
      await expect(page.getByRole("heading", { level: 1, name: "Demo Team" })).toBeVisible();
      await expectFocusKept(page, "opening the team's desk page");
      await tabTo(page, visible(page.locator('main a[href="/desk"]')), { max: 120 });
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${STACK}/desk`);
      await expectFocusKept(page, "going back to the desk");
    });

    test("the embedded Activity's link gate and bench are worked by keyboard", async ({ browser }) => {
      test.setTimeout(240_000);
      await fresh();
      const login = "rj-keyboard-activity";
      const user = { id: `9000000000000006${String(viewport.width).slice(-2)}`, username: `${login}-discord`, global_name: null };
      // A finished practice run, so the bench has a run to show once linked.
      const student = await devLogin(login, { demo: true });
      await practiceRun(student, student.session.team.id);
      const portalContext = await browser.newContext();
      const portal = await portalContext.newPage();
      await signIn(portal, login);
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        await page.route(`${ACTIVITY}/__rj/discord-client**`, (route) =>
          route.fulfill({ status: 200, contentType: "text/html", headers: { "x-cogportal-double": "discord-client" }, body: DOUBLE_PAGE }),
        );
        const open = async (code) => {
          await doubles.discordCode(code, user);
          await page.goto(`${ACTIVITY}/__rj/discord-client?code=${code}&user=${encodeURIComponent(JSON.stringify(user))}`);
          await expect.poll(() => page.frame({ url: /frame_id=/ }) !== null).toBe(true);
          return page.frame({ url: /frame_id=/ });
        };
        const frame = await open(`rj-keyboard-code-${viewport.width}`);
        await expect(frame.getByRole("heading", { name: "Link Cog*Portal to see your team's bench." })).toBeVisible();

        await tabTo(page, frame.getByRole("button", { name: /Link Cog\*Portal/ }));
        await page.keyboard.press("Enter");
        await expect(frame.getByRole("heading", { name: "Once you've linked it in the browser, check here." })).toBeVisible();
        await expectFocusKept(frame, "asking Discord to open the portal");
        const [linkUrl] = await page.evaluate(() => window.__rjDiscord.opened);
        await portal.goto(linkUrl);
        await portal.getByRole("button", { name: "Connect Discord" }).click();
        await expect(portal.getByText(user.username).first()).toBeVisible();

        await tabTo(page, frame.getByRole("button", { name: "Check the link" }));
        await page.keyboard.press("Enter");
        await expect(frame.getByText("Run summary")).toBeVisible({ timeout: 30_000 });
        await expectFocusKept(frame, "checking the link");

        // Promote: Escape closes the question and gives focus back to the button
        // that asked; Enter on the attempt promotes.
        const promote = frame.getByRole("button", { name: "Promote to official" });
        await tabTo(page, promote);
        await page.keyboard.press("Enter");
        const dialog = frame.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(promote).toBeFocused();
        await page.keyboard.press("Enter");
        await tabTo(page, dialog.getByRole("button", { name: /^Use attempt 1 of \d+$/ }));
        await page.keyboard.press("Enter");
        await expect
          .poll(async () => (await (await portal.request.get(`${STACK}/api/runs`)).json()).filter((r) => r.mode === "official").length, { timeout: 30_000 })
          .toBe(1);
        await expectFocusKept(frame, "promoting");

        // Leaving for the portal goes through Discord's external-link command.
        await tabTo(page, frame.getByRole("button", { name: /Open Cog\*Portal/ }).or(frame.getByRole("link", { name: /Open Cog\*Portal/ })).first());
        await page.keyboard.press("Enter");
        await expect.poll(async () => (await page.evaluate(() => window.__rjDiscord.opened)).at(-1)).toMatch(new RegExp(`^${STACK}/run-surfaces/`));
      } finally {
        await context.close();
        await portalContext.close();
      }
      await expectNoDispatch();
    });
  });
}

const DOUBLE_PAGE = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "stack", "discord-client-double.html"), "utf8");
