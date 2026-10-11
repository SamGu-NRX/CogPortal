// Journey 1 — GitHub connect and membership sync through the real routes.
//
// Nothing here stubs the app or the worker. better-auth 1.6.23 hardcodes the
// GitHub authorize and token endpoints, so a full social OAuth round trip
// cannot be pointed at a local double without patching the provider; the
// app's own development mode is the real thing instead: sessions minted
// through the Worker's dev-auth route, the student join and connect flows
// through their real routes, and GitHub interactions served by the app's
// own FixtureGitHubClient (the in-repo client real deployments fall back
// to when GitHub is unconfigured). The linkage is asserted through the
// worker's real APIs and the rendered SPA.

import { test, expect } from "@playwright/test";
import { freshJourney, control, signIn, STACK, TEAM } from "./helpers.mjs";

const FIXTURE_REPO = "cogworks-demo/face-finder";

test.describe("journey: GitHub connect and membership sync", () => {
  test.beforeEach(async () => {
    await freshJourney("github-connect");
  });

  test.afterEach(async () => {
    await control.clearFaults();
  });

  test("join, connect a fixture repository, and read the synced membership back", async ({
    page,
  }) => {
    // Mint a clean student session through the worker's real dev-auth route
    // (demo:false — no cohort, no team yet).
    await signIn(page, "olivia-wu", { demo: false });
    const pre = await (await page.request.get(`${STACK}/api/session`)).json();
    expect(pre.cohort).toBeNull();
    expect(pre.team).toBeNull();

    // Join the seeded cohort through the real join route.
    const join = await page.request.post(`${STACK}/api/cohorts/join`, {
      data: { code: "VISION26" },
    });
    expect(join.ok()).toBeTruthy();
    const joined = await join.json();
    expect(joined.cohort).not.toBeNull();

    // Connect the fixture repository through the real connect route: the
    // worker's FixtureGitHubClient supplies the repository and the write
    // permission, and connectTeam records the team plus membership.
    const connect = await page.request.post(`${STACK}/api/github/connect`, {
      data: { fullName: FIXTURE_REPO, teamName: TEAM.name },
    });
    expect(connect.ok()).toBeTruthy();

    // The session reads the synced membership back through real queries.
    const session = await (await page.request.get(`${STACK}/api/session`)).json();
    expect(session.team?.name).toBe(TEAM.name);
    expect(session.cohort).not.toBeNull();

    // The repository listing marks the fixture repository as claimed by the
    // team this student just created.
    const repos = await (await page.request.get(`${STACK}/api/github/repositories`)).json();
    const fixture = repos.find((r) => r.fullName === FIXTURE_REPO);
    expect(fixture).toBeTruthy();
    expect(fixture.claimedByTeam).toBe(TEAM.name);

    // The cohort's team roster shows the membership through its own route.
    const teams = await (await page.request.get(`${STACK}/api/cohorts/teams`)).json();
    const roster = JSON.stringify(teams);
    expect(roster).toContain(TEAM.name);

    // The SPA, freshly loaded, renders the signed-in student and their team.
    await page.goto(`${STACK}/`);
    await expect(page.getByText("olivia-wu").first()).toBeVisible();
  });

  test("the demo login provisions the demo team through the real connect path", async ({
    page,
  }) => {
    // demo:true drives the worker's own demo provisioning: cohort enrolment
    // plus connectTeam with the fixture repository — the same domain code a
    // real student connect runs.
    const demo = await signIn(page, "priya-nair", { demo: true });
    expect(demo.team?.name).toBe("Demo Team");
    expect(demo.cohort).not.toBeNull();

    const repos = await (await page.request.get(`${STACK}/api/github/repositories`)).json();
    const fixture = repos.find((r) => r.fullName === FIXTURE_REPO);
    expect(fixture).toBeTruthy();
    expect(fixture.claimedByTeam).toBe("Demo Team");
  });

  test("the real OAuth start route is refused while GitHub is unconfigured", async ({ page }) => {
    // In development GitHub is deliberately unconfigured: the real route's
    // guard must refuse the social sign-in rather than half-initialise it.
    const login = await page.request.get(`${STACK}/api/github/login`);
    expect(login.status()).toBe(404);
  });
});
