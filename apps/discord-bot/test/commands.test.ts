import assert from "node:assert/strict";
import { test } from "node:test";
import type { PortalRpcContract } from "@cogworks/contracts/discord";
import { executeCommand } from "../src/commands.ts";
import type { DiscordInteraction } from "../src/interaction.ts";
import { verifyDiscordRequest } from "../src/verify.ts";

const guildId = "course-guild";

function interaction(command: string): DiscordInteraction {
  return {
    id: "interaction-1",
    type: 2,
    guild_id: guildId,
    member: { user: { id: "discord-1", username: "student" } },
    data: { name: "cog", options: [{ type: 1, name: command }] },
  };
}

const portal: PortalRpcContract = {
  async getBenchmarks() {
    return [
      {
        id: "vision-recognition",
        version: 1,
        contractVersion: "cogworks.submissions.v1",
        entryPointName: "vision-recognition",
        title: "Face Recognition",
        module: "vision",
        summary: "Public practice and hosted verification.",
        active: true,
        pluginVersion: "0.1.0",
        datasetVersion: "practice-v1",
        scorerVersion: "1",
        runtimeVersion: "python-3.11",
      },
    ];
  },
  async getLeaderboard() {
    return { benchmark: (await this.getBenchmarks(guildId))[0], entries: [] };
  },
  async getTeamStatus() {
    return { linked: false };
  },
  async getLocalReports() {
    return { linked: false, reports: [] };
  },
  async createDiscordLink() {
    return {
      alreadyLinked: false,
      url: "https://portal.example/connections#discord=secret",
      expiresAt: Date.now() + 60_000,
    };
  },
  async unlinkDiscord() {
    return { unlinked: true };
  },
};

test("private commands remain ephemeral and explain linking", async () => {
  const response = await executeCommand(interaction("status"), portal, guildId);
  assert.equal(response.data?.flags, 64);
  assert.match(response.data?.content ?? "", /\/cog link/);
});

test("public benchmark command is concise and non-ephemeral", async () => {
  const response = await executeCommand(interaction("benchmarks"), portal, guildId);
  assert.equal(response.data?.flags, undefined);
  assert.match(response.data?.content ?? "", /Face Recognition/);
});

test("commands fail closed outside the configured course guild", async () => {
  const request = interaction("benchmarks");
  request.guild_id = "another-guild";
  const response = await executeCommand(request, portal, guildId);
  assert.equal(response.data?.flags, 64);
  assert.match(response.data?.content ?? "", /course server/);
});

test("signature verifier rejects missing and malformed signatures", async () => {
  const body = new TextEncoder().encode("{}").buffer as ArrayBuffer;
  assert.equal(await verifyDiscordRequest("00".repeat(32), null, "1", body), false);
  assert.equal(await verifyDiscordRequest("bad", "00".repeat(64), "1", body), false);
});
