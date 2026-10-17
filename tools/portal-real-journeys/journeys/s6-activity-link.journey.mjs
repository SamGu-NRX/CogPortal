// S6, Discord Activity: a student opens the Activity, links it to their
// portal account, and the Activity then knows their team, with the network
// duplicating sends on both hops along the way.
//
// - Worker to Discord: the hop delivers the Activity's code exchange twice.
//   The double treats codes as single-use, as Discord does, so the second
//   arrival is refused; the Worker only ever sees the first answer.
// - Browser to Worker: the proxy delivers the portal's "Connect Discord"
//   confirmation twice, the shape of a double click or a retried POST.
//
// The journey passes only if the student ends up with one link, to the
// Discord identity the exchange returned, and the Activity says so.

import { test, expect, request } from "@playwright/test";
import { ACTIVITY, STACK, control, doubles, expectNoDispatch, fresh, signIn } from "./helpers.mjs";

const CODE = "rj-activity-code-1";
// Synthetic, and in no real guild.
const DISCORD_USER = { id: "900000000000000001", username: "rj-activity-student", global_name: "RJ Activity Student" };

test("a duplicated code exchange and a duplicated confirmation still make exactly one link", async ({ page }) => {
  await fresh();
  const portalUser = await signIn(page, "rj-linking-student", { demo: true });
  expect(portalUser.team?.name).toBe("Demo Team");

  await doubles.discordCode(CODE, DISCORD_USER);
  await doubles.hopRule("discord", { match: { method: "POST", path: "/oauth2/token" }, duplicate: 1, times: 1 });

  // The Activity, on its own host with its own cookies.
  const activity = await request.newContext({ baseURL: ACTIVITY });
  try {
    const stateResponse = await activity.get("/api/activity/oauth/state");
    const stateBody = await stateResponse.json();
    expect(stateResponse.status(), JSON.stringify(stateBody)).toBe(200);

    const exchange = await activity.post("/api/activity/oauth/token", { data: { code: CODE, state: stateBody.state } });
    const exchanged = await exchange.json();
    expect(exchange.status(), JSON.stringify(exchanged)).toBe(200);
    expect(exchanged.user).toEqual({ id: DISCORD_USER.id, username: DISCORD_USER.username, globalName: DISCORD_USER.global_name });

    // Wire truth at the double: two arrivals of one code, the second refused,
    // and the identity fetched once, with the first answer's token.
    const journal = await doubles.journal("discord");
    expect(journal.filter((entry) => entry.path === "/oauth2/token").map((entry) => entry.status)).toEqual([200, 400]);
    expect(journal.filter((entry) => entry.path === "/v10/users/@me").map((entry) => entry.status)).toEqual([200]);

    // Not linked yet: the Activity hands out a link into the portal.
    const before = await activity.get("/api/activity/session");
    const beforeBody = await before.json();
    expect(before.status(), JSON.stringify(beforeBody)).toBe(200);
    expect(beforeBody.linked).toBe(false);
    const linkUrl = new URL(beforeBody.linkUrl);
    expect(linkUrl.origin).toBe(STACK);
    expect(linkUrl.pathname).toBe("/connections");
    expect(linkUrl.hash).toMatch(/^#discord=[0-9a-f]{64}$/);

    // The student follows it in the portal, signed in, and confirms. The
    // proxy sends that confirmation to the Worker twice.
    await control.fault({ method: "POST", path: "^/api/v1/connections/discord/confirm$", duplicateUpstream: 1, times: 1 });
    await page.goto(linkUrl.toString());
    await expect(page.getByText("Shows you privately")).toBeVisible();
    await page.getByRole("button", { name: "Connect Discord" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(DISCORD_USER.username).first()).toBeVisible();

    // The Activity now knows the student and their team.
    const after = await activity.get("/api/activity/session");
    const afterBody = await after.json();
    expect(after.status(), JSON.stringify(afterBody)).toBe(200);
    expect(afterBody.linked).toBe(true);
    expect(afterBody.team.name).toBe("Demo Team");

    // One link, to the identity the exchange returned, for this student; the
    // one-time token spent once.
    const links = await control.sql(
      `SELECT d.discord_user_id, u.email FROM discord_accounts d JOIN users u ON u.id = d.user_id`,
    );
    expect(links).toEqual([{ discord_user_id: DISCORD_USER.id, email: "rj-linking-student@dev.local" }]);
    const tokens = await control.sql(
      `SELECT consumed_at IS NOT NULL AS spent FROM account_link_tokens WHERE purpose = 'discord'`,
    );
    expect(tokens).toEqual([{ spent: 1 }]);
    await expectNoDispatch();
  } finally {
    await activity.dispose();
  }
});
