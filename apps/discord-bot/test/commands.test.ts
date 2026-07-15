import assert from "node:assert/strict";
import { test } from "node:test";
import type { PortalRpcContract } from "@cogworks/contracts/discord";
import { executeCommand } from "../src/commands.ts";
import {
  EPHEMERAL,
  IS_COMPONENTS_V2,
  RESPONSE_CHANNEL_MESSAGE,
  RESPONSE_UPDATE_MESSAGE,
  responseText,
  type DiscordButton,
  type DiscordInteraction,
  type InteractionResponse,
} from "../src/interaction.ts";
import { verifyDiscordRequest } from "../src/verify.ts";

const guildId = "course-guild";
const portalOrigin = "https://portal.example";

function command(view?: string): DiscordInteraction {
  return {
    id: "interaction-1",
    type: 2,
    guild_id: guildId,
    channel_id: "123456789012345678",
    member: {
      user: { id: "discord-1", username: "student", global_name: "Ada" },
    },
    data: {
      name: "cog",
      options: view ? [{ type: 3, name: "view", value: view }] : undefined,
    },
  };
}

function component(customId: string): DiscordInteraction {
  const value = command();
  value.type = 3;
  value.data = { custom_id: customId, component_type: 2 };
  return value;
}

const benchmark = {
  id: "vision-recognition",
  version: 1,
  contractVersion: "cogworks.submissions.v1",
  entryPointName: "vision-recognition",
  title: "Face Recognition",
  module: "vision" as const,
  summary: "Public practice and hosted verification.",
  active: true,
  pluginVersion: "0.1.0",
  datasetVersion: "practice-v1",
  scorerVersion: "1",
  runtimeVersion: "python-3.11",
};

const basePortal: PortalRpcContract = {
  async getBenchmarks() {
    return [benchmark];
  },
  async getLeaderboard() {
    return { benchmark, entries: [] };
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
  async bindTeamChannel() {
    return { linked: false };
  },
};

function portalWith(overrides: Partial<PortalRpcContract>): PortalRpcContract {
  return { ...basePortal, ...overrides };
}

function buttons(response: InteractionResponse): DiscordButton[] {
  return (
    response.data?.components?.flatMap((container) =>
      container.components.flatMap((child) => (child.type === 1 ? child.components : [])),
    ) ?? []
  );
}

test("/cog alone is the onboarding surface and needs no help command", async () => {
  const response = await executeCommand(command(), basePortal, guildId, portalOrigin);

  assert.equal(response.type, RESPONSE_CHANNEL_MESSAGE);
  assert.equal(response.data?.flags, EPHEMERAL | IS_COMPONENTS_V2);
  assert.match(responseText(response), /Hi Ada — I'm Cog/);
  assert.doesNotMatch(responseText(response), /help|\/cog link/i);
  assert.equal(response.data?.allowed_mentions?.parse.length, 0);
  assert.deepEqual(
    buttons(response).map(({ label, style }) => ({ label, style })),
    [
      { label: "Link to CogPortal ↗", style: 5 },
      { label: "I've connected", style: 1 },
    ],
  );
});

test("linked students land on a warm, private team snapshot", async () => {
  const portal = portalWith({
    async getTeamStatus() {
      return {
        linked: true,
        githubLogin: "ada-lovelace",
        team: {
          id: "team-1",
          name: "Analytical Engines",
          description: null,
          repo: {
            owner: "cogworks",
            name: "engines",
            fullName: "cogworks/engines",
            url: "https://github.com/cogworks/engines",
            defaultBranch: "main",
          },
        },
        discordChannelId: null,
        canManageDiscordChannel: true,
        activeRun: null,
        latestHosted: null,
        latestOfficial: null,
      };
    },
  });

  const response = await executeCommand(command(), portal, guildId, portalOrigin);

  assert.match(responseText(response), /Analytical Engines · lab bench/);
  assert.match(responseText(response), /Good to see you, Ada/);
  assert.match(responseText(response), /quiet by default/);
  assert.ok(buttons(response).some((item) => item.custom_id === "cog:bind-channel"));
  assert.ok(buttons(response).some((item) => item.label === "CogPortal ↗"));
});

test("team channel setup is explicit and binds only after confirmation", async () => {
  let bound: string | null = null;
  const linkedStatus = {
    linked: true as const,
    githubLogin: "ada-lovelace",
    team: {
      id: "team-1",
      name: "Analytical Engines",
      description: null,
      repo: {
        owner: "cogworks",
        name: "engines",
        fullName: "cogworks/engines",
        url: "https://github.com/cogworks/engines",
        defaultBranch: "main",
      },
    },
    discordChannelId: null,
    canManageDiscordChannel: true,
    activeRun: null,
    latestHosted: null,
    latestOfficial: null,
  };
  const portal = portalWith({
    async getTeamStatus() {
      return { ...linkedStatus, discordChannelId: bound };
    },
    async bindTeamChannel(_guild, _user, channel) {
      bound = channel;
      return { ...linkedStatus, discordChannelId: channel };
    },
  });

  const preview = await executeCommand(component("cog:bind-channel"), portal, guildId, portalOrigin);
  assert.match(responseText(preview), /Everyone who can read this channel/);
  assert.equal(bound, null);

  const confirmed = await executeCommand(
    component("cog:bind-channel:confirm"),
    portal,
    guildId,
    portalOrigin,
  );
  assert.equal(bound, "123456789012345678");
  assert.match(responseText(confirmed), /Live runs → <#123456789012345678>/);
});

test("component navigation updates one ephemeral surface instead of adding chat noise", async () => {
  const response = await executeCommand(
    component("cog:leaderboard"),
    basePortal,
    guildId,
    portalOrigin,
  );

  assert.equal(response.type, RESPONSE_UPDATE_MESSAGE);
  assert.equal(response.data?.flags, EPHEMERAL | IS_COMPONENTS_V2);
  assert.match(responseText(response), /Face Recognition · leaderboard/);
  assert.ok(buttons(response).some((item) => item.custom_id === "cog:share:leaderboard"));
});

test("sharing is deliberate and publishes only leaderboard data", async () => {
  const response = await executeCommand(
    component("cog:share:leaderboard"),
    basePortal,
    guildId,
    portalOrigin,
  );

  assert.equal(response.type, RESPONSE_CHANNEL_MESSAGE);
  assert.equal(response.data?.flags, IS_COMPONENTS_V2);
  assert.match(responseText(response), /Official published results/);
  assert.equal(buttons(response).length, 0);
});

test("the optional view choice jumps directly without exposing command syntax", async () => {
  const response = await executeCommand(command("benchmarks"), basePortal, guildId, portalOrigin);
  assert.match(responseText(response), /Benchmarks on the bench/);
  assert.match(responseText(response), /Face Recognition/);
});

test("old subcommand payloads remain compatible during registration rollout", async () => {
  const request = command();
  request.data = { name: "cog", options: [{ type: 1, name: "benchmarks" }] };
  const response = await executeCommand(request, basePortal, guildId, portalOrigin);
  assert.match(responseText(response), /Benchmarks on the bench/);
});

test("commands fail closed outside the configured course guild", async () => {
  const request = command("benchmarks");
  request.guild_id = "another-guild";
  const response = await executeCommand(request, basePortal, guildId, portalOrigin);
  assert.equal(response.data?.flags, EPHEMERAL | IS_COMPONENTS_V2);
  assert.match(responseText(response), /course server/);
});

test("signature verifier rejects missing and malformed signatures", async () => {
  const body = new TextEncoder().encode("{}").buffer as ArrayBuffer;
  assert.equal(await verifyDiscordRequest("00".repeat(32), null, "1", body), false);
  assert.equal(await verifyDiscordRequest("bad", "00".repeat(64), "1", body), false);
});
