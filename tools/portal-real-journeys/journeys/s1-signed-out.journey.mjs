// S1, signed out: the public pages render for a visitor with no session, a
// deep link into a team page asks them to sign in, and an unknown address
// says so. axe runs on each public page once its content has loaded, at the
// desktop and phone widths M4 names.

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { STACK, expectNoDispatch, fresh } from "./helpers.mjs";

test.beforeAll(async () => {
  await fresh();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
]) {
  test(`landing and leaderboard render signed out and pass axe at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${STACK}/`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const landing = await new AxeBuilder({ page }).analyze();
    expect(landing.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);

    await page.goto(`${STACK}/leaderboard`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The local seed's published rows are on vision-recognition v1, which is
    // not the active version, so the signed-out board has no rows to show.
    // What's measured here is that each tab says so instead of rendering an
    // empty table or failing.
    await expect(page.getByText("No team has published both yet.")).toBeVisible();
    await page.getByRole("tab", { name: "Recognition" }).click();
    await expect(page.getByText("No results published yet.")).toBeVisible();
    const board = await new AxeBuilder({ page }).analyze();
    expect(board.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    // Nothing on the page is wider than the screen.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("a deep link into a team page sends a signed-out visitor to sign in", async ({ page }) => {
  await page.goto(`${STACK}/dashboard`);
  await expect(page).toHaveURL(`${STACK}/signin`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto(`${STACK}/runs/run_demo_p1`);
  await expect(page).toHaveURL(`${STACK}/signin`);
});

test("an unknown address says there is nothing there and shows the address", async ({ page }) => {
  await page.goto(`${STACK}/no-such-page/%3Cscript%3E`);
  await expect(page.getByRole("heading", { name: "There's nothing at this address." })).toBeVisible();
  await expect(page.locator("code").filter({ hasText: "/no-such-page/" })).toBeVisible();
  // An unknown API path is a JSON 404, not the SPA's page.
  const api = await page.request.get(`${STACK}/api/no-such-route`);
  expect(api.status()).toBe(404);
  expect((await api.json()).error.code).toBe("not_found");
  await expectNoDispatch();
});

test("the skip link is the first stop by keyboard and lands in the page's content", async ({ page }) => {
  await page.goto(`${STACK}/`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Start from the top of the document, as a keyboard user arriving does.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
  expect(first).toBe("Skip to content");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  const inMain = await page.evaluate(() => document.activeElement?.closest("main") !== null);
  expect(inMain, "after skipping, the next stop is in the page's main content").toBe(true);
});
