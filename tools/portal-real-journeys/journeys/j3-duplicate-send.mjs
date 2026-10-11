// Journey 3 — team creation under a duplicated Discord channel create.
//
// The create-team endpoint calls Discord's real channel-create API through
// the seamed client. The proxy duplicates exactly one upstream send of the
// channel-create request — the wire-level shape of a client retry after a
// response was lost. The journey must end with exactly one Discord channel
// and exactly one stored membership row.

import { test, expect } from "@playwright/test";
import { freshJourney, control, signIn, TEAM } from "./helpers.mjs";

test.describe("journey: team creation survives a duplicated channel create", () => {
  test.beforeEach(async () => {
    await freshJourney("duplicate-send");
  });

  test.afterEach(async () => {
    await control.clearFaults();
  });

  test("duplicate upstream sends of channel create yield one channel and one membership", async ({
    page,
  }) => {
    await freshJourney("duplicate-send");
    await signIn(page, "olivia-wu");

    // Join the seeded cohort the way the SPA's join form does.
    const join = await page.request.post("http://127.0.0.1:8810/api/cohorts/join", {
      data: { code: "VISION26" },
    });
    expect(join.ok()).toBeTruthy();

    // Duplicate exactly one upstream POST to the Discord channels API.
    await control.fault({
      match: { host: "discord-double", path: "/api/v10/guilds/987654321098765432/channels" },
      duplicate: 1,
    });

    // Create the team through the real endpoint the SPA's form posts to.
    const create = await page.request.post("http://127.0.0.1:8810/api/github/connect", {
      data: {
        fullName: TEAM.repo,
        teamName: TEAM.name,
        discordChannelId: TEAM.channel,
      },
    });
    expect(create.ok()).toBeTruthy();

    // The double must hold exactly one channel with that ID — the second
    // send hit an existing channel and the worker treated it as the same
    // success, not a new one.
    const channel = await page.request.get(
      `http://127.0.0.1:8814/__doubles/discord/channels/${TEAM.channel}`,
    );
    expect(channel.ok()).toBeTruthy();

    // And exactly one team membership row in the worker's database.
    const rows = await control.sql(`SELECT COUNT(*) AS n FROM teams WHERE name = '${TEAM.name}'`);
    const count = Number(JSON.parse(rows)[0].n);
    expect(count).toBe(1);
  });
});
