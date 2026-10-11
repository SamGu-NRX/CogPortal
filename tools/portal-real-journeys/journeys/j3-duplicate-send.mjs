// Journey 3 — the Worker's Discord Activity exchange sends exactly once and
// survives a duplicated arrival at the Discord double.
//
// The hop under test is Worker -> Discord double (DISCORD_API_BASE_URL):
// POST /api/activity/oauth/token exchanges a synthetic Activity code through
// the double's /oauth2/token and /v10/users/@me, and GET /api/activity/session
// creates the Discord link for the identity the double returned. A duplicate
// rule on the double itself replays the token request the way a second
// identical send would arrive on the wire. The journey must end with the
// double having received the token request twice (one replay, journalled as
// a duplicate), the identity fetched exactly once, and exactly one Discord
// account link whose id is the one the exchange returned.

import { test, expect } from "@playwright/test";
import { control, freshJourney, signIn, STACK } from "./helpers.mjs";

const DISCORD_DOUBLE = "http://127.0.0.1:8813";
const ACTIVITY_CODE = "act-j3-duplicate-send";

async function discordDouble(path, body) {
  const response = await fetch(`${DISCORD_DOUBLE}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(
    response.ok,
    `discord double ${path}: ${response.status} ${await response.text()}`,
  ).toBeTruthy();
  return response.json();
}

test.describe("journey: the activity exchange survives a duplicated Discord send", () => {
  test.beforeEach(async () => {
    await freshJourney("duplicate-send");
  });

  test("duplicate token arrivals at the double yield one identity fetch and one link", async ({
    page,
  }) => {
    await signIn(page, "olivia-wu");

    // Mint the synthetic Activity code the real exchange will spend, then arm
    // the duplicate rule on the Discord double itself: one replay of the
    // token request, journalled as a duplicate arrival.
    await discordDouble("/__doubles/discord/seed", { code: ACTIVITY_CODE });
    await discordDouble("/__doubles/rules", {
      match: { method: "POST", path: "/oauth2/token" },
      duplicate: 1,
    });

    // The route's own anti-CSRF contract: GET mints a signed state cookie and
    // the exchange must present the same value.
    const state = await page.request.get(`${STACK}/api/activity/oauth/state`);
    expect(state.ok(), await state.text()).toBeTruthy();
    const { state: stateValue } = await state.json();

    // The real hop: the Worker exchanges the code through the Discord double.
    const exchange = await page.request.post(`${STACK}/api/activity/oauth/token`, {
      data: { code: ACTIVITY_CODE, state: stateValue },
    });
    expect(exchange.ok(), await exchange.text()).toBeTruthy();
    const { user } = await exchange.json();

    // The session route creates the Discord link for the identity the double
    // returned.
    const session = await page.request.get(`${STACK}/api/activity/session`);
    expect(session.ok(), await session.text()).toBeTruthy();
    const linked = await session.json();
    expect(linked.linked).toBe(false);

    // Wire truth at the double: the token request arrived twice (send +
    // duplicate) and the identity was fetched exactly once — the replay is
    // the double re-receiving, not the Worker re-sending.
    const journalResponse = await fetch(`${DISCORD_DOUBLE}/__doubles/journal`);
    expect(journalResponse.ok).toBeTruthy();
    const { log } = await journalResponse.json();
    const tokenArrivals = log.filter((entry) => entry.path === "/oauth2/token");
    expect(tokenArrivals, "token request should arrive exactly twice").toHaveLength(2);
    expect(
      tokenArrivals.filter((entry) => entry.duplicate),
      "exactly one arrival should be the replayed duplicate",
    ).toHaveLength(1);
    expect(
      log.filter((entry) => entry.path === "/v10/users/@me"),
      "the Worker should fetch the identity exactly once",
    ).toHaveLength(1);

    // Side-effect truth: exactly one Discord account link exists and it is
    // the identity the exchange returned.
    const rows = JSON.parse(await control.sql("SELECT discord_user_id FROM discord_accounts"));
    expect(rows, "exactly one Discord account link should exist").toHaveLength(1);
    expect(rows[0].discord_user_id).toBe(user.id);
  });
});
