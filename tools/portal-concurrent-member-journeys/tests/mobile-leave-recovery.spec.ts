import { expect, test } from "@playwright/test";
import { DEMO_TEAM, horizontalOverflow, joinCohort, joinTeam, apiSession, d1, resetFixture, rosterLogins, signIn } from "./helpers";

// The narrow-viewport recovery path: a student on a 320 px screen joins a team
// by touch, an admin removes them from the roster, and their page has to walk
// them back through the real chooser to a readable setup page. The arm-then-
// confirm remove stays on the admin side; the recovery is all theirs, on the
// small screen, and nothing may push the page wider than the screen they have.
test.describe("recovery after removal at 320 px", () => {
  // The admin promotion only sets up the world; the removal itself goes
  // through the real arm-then-confirm control on the real team page.
  test.beforeAll(async ({ request }) => {
    await resetFixture();
    await apiSession(request, "race-owner", { demo: true });
    await d1(
      `UPDATE team_members SET role = 'admin' WHERE user_id = (SELECT id FROM users WHERE email = 'race-owner@dev.local') AND team_id = (SELECT id FROM teams WHERE name = '${DEMO_TEAM}')`,
    );
  });

  test("a removed member rejoins by touch and lands on a readable setup", async ({
    browser,
    request,
  }) => {
    const mobile = await browser.newContext({ viewport: { width: 320, height: 700 } });
    const page = await mobile.newPage();

    // First day: sign in, join the cohort, join the demo team — all by touch
    // on the 320 px screen.
    await signIn(page, "mobile-rejoiner");
    await joinCohort(page);
    await joinTeam(page);

    // The admin removes them (arm, then confirm) from a normal-size screen.
    const admin = await browser.newContext();
    const adminPage = await admin.newPage();
    await signIn(adminPage, "race-owner");
    await adminPage.goto("/team");
    // Dev sign-ins clear github_login on every login, and the remove control
    // targets members by it — real members always carry their GitHub login, so
    // the journey gives the removed member theirs once sign-ins are done.
    await d1(`UPDATE users SET github_login = 'mobile-rejoiner' WHERE email = 'mobile-rejoiner@dev.local'`);
    await adminPage.getByRole("button", { name: "Remove @mobile-rejoiner from the team" }).click();
    await adminPage.getByRole("button", { name: "Confirm, they leave (@mobile-rejoiner)" }).click();
    // The removal is a request the page sends after the click: wait until the
    // roster on the page itself no longer lists them, then read the server.
    await expect(adminPage.getByText("mobile-rejoiner")).toHaveCount(0, { timeout: 15_000 });
    await apiSession(request, "roster-reader", { demo: true });
    const logins = await rosterLogins(request);
    expect(logins).not.toContain("mobile-rejoiner");

    // The removed member's page recovers: back at the chooser, and the chooser
    // names the team they were on (the join path asserts the team heading).
    // Then they rejoin by touch and land on a readable setup page with nothing
    // overflowing the screen.
    await page.goto("/team");
    await page.waitForURL(/\/connect/, { timeout: 15_000 });

    await joinTeam(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    await admin.close();
    await mobile.close();
  });
});
