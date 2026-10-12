// M4, keyboard: the core journeys finished with Tab, Shift+Tab, Enter, Space
// and typing alone, and focus after each action landing somewhere that makes
// sense (never dropped to the document body).
//
// `tabTo` presses Tab until the wanted control has focus, failing if it
// takes more than a page's worth of stops, so a control that can't be
// reached by keyboard fails the journey rather than being clicked.

import { test, expect } from "@playwright/test";
import { STACK, expectNoDispatch, fresh, signIn } from "./helpers.mjs";
import { focused } from "./a11y.mjs";

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

async function expectFocusKept(page, what) {
  const now = await focused(page);
  expect(now, `focus after ${what} fell to the page body`).not.toBeNull();
  return now;
}

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
