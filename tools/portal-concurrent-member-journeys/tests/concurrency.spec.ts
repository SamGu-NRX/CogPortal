import { expect, test, type Browser, type Page } from "@playwright/test";
import { DEMO_TEAM, JOIN_CODE, apiSession, demoTeamId, d1, joinTeam, resetFixture, rosterLogins, signIn } from "./helpers";

const OWNER = "race-owner";
const NEW_NAME = "Demo Team Regrouped";

/** A cohort member with no team, signed in on their own real page. */
async function teamlessMember(browser: Browser, login: string): Promise<{ page: Page; context: Awaited<ReturnType<Browser["newContext"]>> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.request.post("/api/dev/login", { data: { login, demo: false } });
  const joined = await page.request.post("/api/cohorts/join", { data: { code: JOIN_CODE } });
  expect(joined.status()).toBeLessThan(400);
  return { page, context };
}

const joinStatus = (page: Page, teamId: string) =>
  page.evaluate(
    async (id) =>
      (await fetch("/api/team/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId: id }),
      })).status,
    teamId,
  );

test.describe.serial("concurrent team members (A5)", () => {
  // The dev demo login provisions its team with a "write" membership (no
  // GitHub to ask locally), so the rename journey promotes its owner to admin
  // in the local development database before any browser work starts. This
  // only sets up the world; every behaviour below is driven through the app.
  test.beforeAll(async ({ request }) => {
    await resetFixture();
    await apiSession(request, OWNER, { demo: true });
    await d1(
      `UPDATE team_members SET role = 'admin' WHERE user_id = (SELECT id FROM users WHERE email = '${OWNER}@dev.local') AND team_id = (SELECT id FROM teams WHERE name = '${DEMO_TEAM}')`,
    );
  });

  test("a teammate joining through the real path lands on a roster that shows both", async ({
    browser,
    request,
  }) => {
    await apiSession(request, OWNER, { demo: true });
    const mate = await browser.newContext();
    const page = await mate.newPage();
    await signIn(page, "race-mate");
    await page.request.post("/api/cohorts/join", { data: { code: JOIN_CODE } });
    await joinTeam(page);

    await page.goto("/team");
    await expect(page.getByRole("heading", { name: DEMO_TEAM })).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(text).toContain("race-mate");
    expect(text).toContain(OWNER);

    // The server agrees with the page: exactly one membership row per person.
    const logins = await rosterLogins(request);
    expect(logins.filter((l) => l === "race-mate")).toHaveLength(1);
    expect(logins.filter((l) => l === OWNER)).toHaveLength(1);
    await mate.close();
  });

  test("a teammate's join survives a concurrent rename", async ({ browser, request }) => {
    await apiSession(request, OWNER, { demo: true });
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    await signIn(ownerPage, OWNER);
    await ownerPage.goto("/team");
    await expect(ownerPage.getByRole("heading", { name: DEMO_TEAM })).toBeVisible();

    // The team's id, captured before the rename so the mid-flight roster read
    // below can find it under its new name.
    const renamedTeamId = await demoTeamId(request);

    // Hold the rename's answer after the Worker has applied it, so the join is
    // handled and stored while the rename's response is still in flight.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await ownerPage.route("**/api/team", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const response = await route.fetch();
      await released;
      await route.fulfill({ response });
    });

    // The rename the page sends while the join is about to land mid-flight.
    await ownerPage.getByRole("button", { name: "Rename" }).click();
    await ownerPage.locator("#rename").fill(NEW_NAME);
    await ownerPage.getByRole("button", { name: "Save name" }).click();

    const mate = await teamlessMember(browser, "race-mid-flight");
    await joinTeam(mate.page);

    // The server's truth while the rename's answer is still held: the join
    // landed, the rename is applied, nobody appears twice.
    const logins = await rosterLogins(request, renamedTeamId);
    expect(logins).toContain("race-mid-flight");
    expect(logins.filter((l) => l === "race-mid-flight")).toHaveLength(1);
    release();
    await released;

    // The owner's page, read fresh: the new name and the mid-flight member.
    await ownerPage.reload();
    await expect(ownerPage.getByRole("heading", { name: NEW_NAME })).toBeVisible();
    const ownerText = await ownerPage.locator("body").innerText();
    expect(ownerText).toContain("race-mid-flight");

    // Put the name back through the same control, so the journeys that follow
    // find the team under its original name.
    await ownerPage.getByRole("button", { name: "Rename" }).click();
    await ownerPage.locator("#rename").fill(DEMO_TEAM);
    await ownerPage.getByRole("button", { name: "Save name" }).click();
    await expect(ownerPage.getByRole("heading", { name: DEMO_TEAM })).toBeVisible();
    await mate.context.close();
    await owner.close();
  });

  test("two teammates joining at the same instant each get exactly one row", async ({
    browser,
    request,
  }) => {
    await apiSession(request, OWNER, { demo: true });
    const teamId = await demoTeamId(request);
    const first = await teamlessMember(browser, "race-first");
    const second = await teamlessMember(browser, "race-second");

    // Two different people, one instant: the same team named in two concurrent
    // joins from two real pages, answered by the real Worker.
    const [firstAnswer, secondAnswer] = await Promise.all([
      joinStatus(first.page, teamId),
      joinStatus(second.page, teamId),
    ]);
    expect(firstAnswer).toBeLessThan(300);
    expect(secondAnswer).toBeLessThan(300);

    const logins = await rosterLogins(request);
    expect(logins.filter((l) => l === "race-first")).toHaveLength(1);
    expect(logins.filter((l) => l === "race-second")).toHaveLength(1);
    await first.context.close();
    await second.context.close();
  });

  test("one person joining from two tabs never ends up with two memberships", async ({
    browser,
    request,
  }) => {
    await apiSession(request, OWNER, { demo: true });
    const teamId = await demoTeamId(request);
    const solo = await teamlessMember(browser, "race-both-tabs");
    const otherTab = await solo.context.newPage();
    await otherTab.goto("/");

    // The one-team-per-person invariant: one answer wins, the other is refused
    // (never a success), and the roster holds exactly one row.
    const [a, b] = await Promise.all([joinStatus(solo.page, teamId), joinStatus(otherTab, teamId)]);
    const statuses = [a, b].sort((x, y) => x - y);
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    const logins = await rosterLogins(request);
    expect(logins.filter((l) => l === "race-both-tabs")).toHaveLength(1);
    await solo.context.close();
  });

  // On main this interleaving lost with a 500 (documented in PR #122); alpha's
  // join path answers the contract correctly, so it runs as an active test
  // here — the port's regression guard for that fix.
  test("the losing join from two tabs is a 409 the page can act on", async ({
    browser,
    request,
  }) => {
    await apiSession(request, OWNER, { demo: true });
    const teamId = await demoTeamId(request);
    const solo = await teamlessMember(browser, "race-both-tabs-409");
    const otherTab = await solo.context.newPage();
    await otherTab.goto("/");

    const [a, b] = await Promise.all([joinStatus(solo.page, teamId), joinStatus(otherTab, teamId)]);
    const statuses = [a, b].sort((x, y) => x - y);
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(409);
    await solo.context.close();
  });

  test("a signed-out caller cannot move membership anywhere", async ({ request, page }) => {
    await apiSession(request, OWNER, { demo: true });
    const before = await rosterLogins(request);
    const teamId = await demoTeamId(request);

    // The same routes the journeys above drive, with no session at all.
    const attempts = await (await import("@playwright/test")).request.newContext({
      baseURL: "http://localhost:5199",
    });
    try {
      const kick = await attempts.delete("/api/team/members/race-first");
      expect(kick.status()).toBeGreaterThanOrEqual(400);
      const join = await attempts.post("/api/team/join", { data: { teamId } });
      expect(join.status()).toBeGreaterThanOrEqual(400);
      const rename = await attempts.patch("/api/team", {
        data: { name: "Renamed From Nowhere" },
      });
      expect(rename.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await attempts.dispose();
    }

    expect(await rosterLogins(request)).toEqual(before);

    // And the page a signed-out visitor gets for /team is sign-in, not a team.
    await page.goto("/team");
    await page.waitForURL(/\/signin/, { timeout: 15_000 });
    const text = await page.locator("body").innerText();
    expect(text).not.toContain(DEMO_TEAM);
  });
});
