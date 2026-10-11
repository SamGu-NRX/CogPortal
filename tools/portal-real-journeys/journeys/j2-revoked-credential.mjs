// Journey 2 — revoked GitHub credential recovery.
//
// The worker stores the OAuth token from journey 1's round trip. This
// journey revokes that grant inside the GitHub double (the way a real
// revocation on github.com invalidates the token), then drives a sync that
// makes the worker use the dead token. The credential-revoked error must
// surface through the worker's real error mapping — not a stub.

import { test, expect } from "@playwright/test";
import { freshJourney, control, signIn, TEAM } from "./helpers.mjs";

test.describe("journey: revoked GitHub credential", () => {
  test.beforeEach(async () => {
    await freshJourney("revoked-credential");
  });

  test.afterEach(async () => {
    await control.clearFaults();
  });

  test("a sync against a revoked token maps to the credential_revoked error", async ({
    page,
  }) => {
    await freshJourney("revoked-credential");
    await signIn(page, "olivia-wu");

    // Link through the real flow (same shape as journey 1).
    const start = await page.request.post("http://127.0.0.1:8810/api/connections/github/start");
    const { authorizeUrl } = await start.json();
    await page.goto(authorizeUrl);
    await page.waitForURL(/127\.0\.0\.1:8810/);

    // Kill the stored credential the way GitHub does: revoke the grant.
    const revoke = await page.request.post("http://127.0.0.1:8813/__doubles/github/revoke", {
      data: { login: "olivia-wu" },
    });
    expect(revoke.ok()).toBeTruthy();

    // Ask the worker to touch GitHub again with its stored token.
    const sync = await page.request.post(`http://127.0.0.1:8810/api/github/sync/${TEAM.repo}`);
    expect(sync.status()).toBe(401);
    const body = await sync.json();
    expect(body.error?.code ?? body.code).toBe("credential_revoked");

    // The double saw exactly one attempt — no retry storm against a dead
    // credential — and the worker did not silently unlink the account.
    const journal = await page.request.get("http://127.0.0.1:8813/__doubles/github/journal");
    const userFetches = (await journal.json()).requests.filter((r) => r.path === "/user");
    expect(userFetches.length).toBe(1);

    const who = await page.request.get("http://127.0.0.1:8810/api/me");
    const me = await who.json();
    expect(me.githubLogin).toBe("olivia-wu");
  });
});
