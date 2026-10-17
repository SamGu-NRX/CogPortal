// Journey 2 — credential refusals and error mapping through the real routes.
//
// Nothing here stubs the app or the worker. The deep path this journey
// originally targeted — a revoked GitHub credential surfacing as the
// repositories route's mapped 502 through the RealGitHubClient — cannot run
// locally: it needs a GitHub-configured boot, but better-auth 1.6.23
// hardcodes its social OAuth token endpoint, so no local session source
// exists in such a boot (see journey 1's header). What runs here instead is
// every refusal the worker really makes around credentials in development,
// asserted against their real status codes and error codes.

import { test, expect } from "@playwright/test";
import { control, fresh, signIn, STACK } from "./helpers.mjs";

const TEAM = { name: "parity-checkers" };

const FIXTURE_REPO = "cogworks-demo/face-finder";

async function errorOf(response) {
  const body = await response.json();
  return body.error?.code ?? null;
}

test.describe("journey: credential refusals and error mapping", () => {
  test.beforeEach(async () => {
    await fresh();
  });

  test.afterEach(async () => {
    await control.clearFaults();
  });

  test("connecting without a cohort is refused before anything is written", async ({ page }) => {
    // demo:false leaves the student outside every cohort; the connect route's
    // cohort guard must refuse with its own sentence.
    await signIn(page, "rj-refused-student", { demo: false });
    const connect = await page.request.post(`${STACK}/api/github/connect`, {
      data: { fullName: FIXTURE_REPO, teamName: TEAM.name },
    });
    expect(connect.status()).toBe(403);
    expect(await errorOf(connect)).toBe("no_cohort");

    // The refusal happened before any insert: the session still shows no team.
    const session = await (await page.request.get(`${STACK}/api/session`)).json();
    expect(session.team).toBeNull();
  });

  test("connecting an unclaimable repository is refused without a GitHub token", async ({
    page,
  }) => {
    // Joined but development-unauthenticated: the connect route requires a
    // GitHub linkage before it will touch any non-fixture repository.
    await signIn(page, "rj-refused-student", { demo: false });
    await page.request.post(`${STACK}/api/cohorts/join`, { data: { code: "VISION26" } });
    const connect = await page.request.post(`${STACK}/api/github/connect`, {
      data: { fullName: "octocat/hello-world", teamName: TEAM.name },
    });
    expect(connect.status()).toBe(403);
    expect(await errorOf(connect)).toBe("forbidden");

    const session = await (await page.request.get(`${STACK}/api/session`)).json();
    expect(session.team).toBeNull();
  });

  test("a second connect while already on a team is refused with its own code", async ({ page }) => {
    // The duplicate-claim refusal is checked before any insert, so the one
    // team per user rule never surfaces as a raw 500.
    await signIn(page, "rj-refused-student", { demo: true });
    const second = await page.request.post(`${STACK}/api/github/connect`, {
      data: { fullName: FIXTURE_REPO, teamName: "another-team" },
    });
    expect(second.status()).toBe(409);
    expect(await errorOf(second)).toBe("already_on_team");

    // The original team is untouched.
    const session = await (await page.request.get(`${STACK}/api/session`)).json();
    expect(session.team?.name).toBe("Demo Team");

    // And the repositories listing marks the fixture repository as claimed
    // by the demo team the demo connect path created (from j1-real-github-oauth).
    const repos = await (await page.request.get(`${STACK}/api/github/repositories`)).json();
    const claimed = repos.find((r) => r.fullName === FIXTURE_REPO);
    expect(claimed?.claimedByTeam).toBe("Demo Team");
  });

  test("a duplicated connect POST keeps the first response and lands one team", async ({ page }) => {
    // Restored from j3-duplicate-send. The proxy duplicates exactly one
    // non-idempotent POST — the wire-level shape of a client retry after a
    // response was lost. The caller must see the first response, and the
    // duplicate must not land a second team or a second membership row. (The
    // old journey duplicated Discord's channel-create during connect; the
    // connect route no longer creates a Discord channel, so the duplication
    // rides the create itself.)
    await signIn(page, "rj-duplicated-student", { demo: false });
    await page.request.post(`${STACK}/api/cohorts/join`, { data: { code: "VISION26" } });
    await control.fault({
      method: "POST",
      path: "^/api/github/connect$",
      duplicateUpstream: 1,
      times: 1,
    });
    const create = await page.request.post(`${STACK}/api/github/connect`, {
      data: { fullName: FIXTURE_REPO, teamName: TEAM.name },
    });
    expect(create.ok()).toBeTruthy();

    const teams = await control.sql(`SELECT COUNT(*) AS n FROM teams WHERE name = '${TEAM.name}'`);
    expect(Number(teams[0].n)).toBe(1);
    const members = await control.sql(
      `SELECT COUNT(*) AS n FROM team_members m JOIN teams t ON t.id = m.team_id WHERE t.name = '${TEAM.name}'`,
    );
    expect(Number(members[0].n)).toBe(1);
  });

  test("unauthenticated traffic is refused by the real session guard", async ({ page }) => {
    // No login at all: every domain route must answer 401, not leak state.
    // The session route answers everyone, and says nobody is signed in.
    const session = await page.request.get(`${STACK}/api/session`);
    expect(session.status()).toBe(200);
    expect((await session.json()).user).toBeNull();
    const repos = await page.request.get(`${STACK}/api/github/repositories`);
    expect(repos.status()).toBe(401);
  });
});
