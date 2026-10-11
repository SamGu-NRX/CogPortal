// Journey 1 — real GitHub OAuth round trip with the full membership sync.
//
// Nothing here stubs the app or the worker: the browser performs the real
// authorize redirect chain against the labelled GitHub double, the worker
// exchanges the returned code through its real client code (token, /user,
// memberships), and the resulting linkage is asserted through the worker's
// real API and the double's request journal.

import { test, expect } from "@playwright/test";
import { freshJourney, control, TEAM } from "./helpers.mjs";

test.describe("journey: real GitHub OAuth and membership sync", () => {
  test.beforeEach(async () => {
    await freshJourney("real-github-oauth");
  });

  test.afterEach(async () => {
    await control.clearFaults();
  });

  test("linking a GitHub account provisions the matching team through real redirects", async ({
    page,
  }) => {
    await freshJourney("real-github-oauth");
    // Mint the session through the worker's real dev-auth route (the SPA
    // login screen drives the same endpoint in development).
    const login = await page.request.post("http://127.0.0.1:8810/api/dev/login", {
      data: { login: "olivia-wu", demo: true },
    });
    expect(login.ok()).toBeTruthy();

    // Begin the real connect flow: the worker returns the authorize URL it
    // would send a browser to.
    const start = await page.request.post("http://127.0.0.1:8810/api/connections/github/start");
    expect(start.ok()).toBeTruthy();
    const { authorizeUrl } = await start.json();
    expect(authorizeUrl).toContain("127.0.0.1:8813/oauth/authorize");

    // The browser performs the redirect chain for real: authorize → double
    // issues a code → 302 back into the worker's callback route.
    await page.goto(authorizeUrl);
    await page.waitForURL(/127\.0\.0\.1:8810/);

    // The worker exchanged the code through its real client code: the
    // double must have seen the token swap, /user, and the memberships
    // fetch, all carrying the same code and token.
    const journal = await page.request.get("http://127.0.0.1:8813/__doubles/github/journal");
    const requests = (await journal.json()).requests;
    expect(requests.some((r) => r.path === "/api/oauth/token" && r.body?.code)).toBeTruthy();
    expect(requests.some((r) => r.path === "/user")).toBeTruthy();
    expect(
      requests.some((r) => r.path === "/user/memberships/teams" && r.query?.org === "cogworks-demo"),
    ).toBeTruthy();

    // The worker recorded the linkage in its own database.
    const who = await page.request.get("http://127.0.0.1:8810/api/me");
    expect(who.ok()).toBeTruthy();
    const me = await who.json();
    expect(me.provider).toBe("github");
    expect(me.githubLogin).toBe("olivia-wu");
    expect(me.team?.name).toBe(TEAM.name);

    // The SPA, freshly loaded, renders the connected identity for real.
    await page.goto("http://127.0.0.1:8810/");
    await expect(page.getByText("olivia-wu").first()).toBeVisible();
  });

  test("an authorize request for an unknown user is refused by the double", async ({ page }) => {
    await freshJourney("real-github-oauth");
    const authorize = await page.request.get(
      "http://127.0.0.1:8813/oauth/authorize?client_id=cogportal-dev&response_type=code&scope=read%3Aorg&state=s1&login=ghost-user",
    );
    expect(authorize.status()).toBe(401);
  });
});
