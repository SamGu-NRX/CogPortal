// Journey 4 — mid-journey worker restart and production-refusal boots.
//
// Two facts have to hold for real, because they are what production
// integrity depends on:
//
// 1. A mid-journey worker restart keeps sessions working — the session
//    cookie is a signed value the worker re-validates after a cold boot,
//    so the restart must be transparent to a signed-in user.
// 2. A production-configuration boot refuses the dev sign-in route —
//    /api/dev/login must not exist in production — and recovering to the
//    development configuration restores it.

import { test, expect } from "@playwright/test";
import { freshJourney, control, signIn, TEAM } from "./helpers.mjs";

test.describe("journey: restarts and production-refusal boots", () => {
  test.afterEach(async () => {
    await control.clearFaults();
  });

  test("a session minted before a mid-journey restart still works after it", async ({
    page,
  }) => {
    await freshJourney("mid-journey-restart");
    await signIn(page, "olivia-wu");

    // A real user is signed in: the SPA renders their identity.
    await page.goto("http://127.0.0.1:8810/");
    await expect(page.getByText("olivia-wu").first()).toBeVisible();

    // The supervisor stops the worker and boots it again — same build,
    // same database, no state surgery.
    await control.restartWorker();

    // Same browser context, same cookie: the session still validates and
    // the SPA still shows the user.
    await page.goto("http://127.0.0.1:8810/");
    await expect(page.getByText("olivia-wu").first()).toBeVisible({ timeout: 30_000 });
  });

  test("a production boot refuses dev sign-in until the dev configuration returns", async ({
    page,
  }) => {
    await freshJourney("production-refusal");
    await control.prodBoot();
    try {
      const refused = await page.request.post("http://127.0.0.1:8810/api/dev/login", {
        data: { login: "olivia-wu", demo: true },
      });
      expect(refused.status()).toBe(404);
    } finally {
      // Restore the development configuration no matter what the
      // assertions saw, so later journeys boot a normal stack.
      await control.devBoot();
    }

    const restored = await page.request.post("http://127.0.0.1:8810/api/dev/login", {
      data: { login: "olivia-wu", demo: true },
    });
    expect(restored.ok()).toBeTruthy();
  });
});
