// The two properties every other journey leans on.
//
// 1. A Worker restart in the middle of a journey keeps the signed-in user
//    signed in: the session is a signed cookie the Worker re-validates on a
//    cold boot, and it lives in the run's D1, which the restart keeps.
// 2. A Worker configured the way a deployment is (GitHub OAuth set, dev auth
//    off) refuses the development sign-in. The production-refusal profile is
//    sealed like every other: fake credentials, loopback providers.

import { test, expect } from "@playwright/test";
import { STACK, control, expectNoDispatch, fresh, signIn } from "./helpers.mjs";

test("a session minted before a Worker restart still works after it", async ({ page }) => {
  await fresh();
  await signIn(page, "rj-restart-student", { demo: true });
  await page.goto(`${STACK}/dashboard`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await control.restartWorker();

  await page.goto(`${STACK}/team`);
  await expect(page).toHaveURL(`${STACK}/team`);
  await expect(page.getByText("Demo Team").first()).toBeVisible({ timeout: 30_000 });
  const session = await (await page.request.get(`${STACK}/api/session`)).json();
  expect(session.user?.login).toBe("rj-restart-student");
  await expectNoDispatch();
});

test("a production-configured Worker refuses dev sign-in, and the next fresh boot restores it", async ({ page }) => {
  await fresh("production-refusal");
  try {
    const session = await (await page.request.get(`${STACK}/api/session`)).json();
    expect(session.auth).toMatchObject({ githubConfigured: true, devAuthEnabled: false, executionProvider: "modal" });
    const refused = await page.request.post(`${STACK}/api/dev/login`, { data: { login: "rj-intruder", demo: true } });
    expect(refused.status()).toBe(404);
    // Nobody was created by the refused attempt.
    expect(await control.sql(`SELECT count(*) AS n FROM users WHERE email = 'rj-intruder@dev.local'`)).toEqual([{ n: 0 }]);
    // The sign-in page offers GitHub, not the development form.
    await page.goto(`${STACK}/signin`);
    await expect(page.getByRole("link", { name: /GitHub/i }).or(page.getByRole("button", { name: /GitHub/i })).first()).toBeVisible();
  } finally {
    await fresh("fixture");
  }
  const restored = await page.request.post(`${STACK}/api/dev/login`, { data: { login: "rj-restart-student", demo: false } });
  expect(restored.ok()).toBeTruthy();
  await expectNoDispatch();
});
