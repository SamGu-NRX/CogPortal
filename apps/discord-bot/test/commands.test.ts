import assert from "node:assert/strict";
import { test } from "node:test";
import type { PortalRpcContract } from "@cogworks/contracts/discord";
import type { RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import { entryPointCommand } from "../scripts/command-payloads.mjs";
import { executeCommand } from "../src/commands.ts";
import type { DiscordButton } from "@cogworks/discord-kit/components";
import {
  EPHEMERAL,
  IS_COMPONENTS_V2,
  RESPONSE_CHANNEL_MESSAGE,
  RESPONSE_LAUNCH_ACTIVITY,
  RESPONSE_UPDATE_MESSAGE,
  launchActivity,
  responseText,
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

function surfaceSnapshot(): RunSurfaceSnapshot {
  return {
    id: `surface_${"a".repeat(20)}`,
    team: { id: "team-1", name: "Analytical Engines" },
    benchmark: { id: benchmark.id, version: benchmark.version, title: benchmark.title },
    actor: { login: "ada-lovelace", name: "Ada" },
    sha: "b".repeat(40),
    shortSha: "bbbbbbb",
    branch: "main",
    dirty: false,
    stage: "local",
    status: "succeeded",
    phase: "succeeded",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_010_000,
    finishedAt: 1_750_000_010_000,
    elapsedMs: 10_000,
    progress: null,
    primaryMetric: null,
    metrics: [],
    teamBest: null,
    localRunId: "localrun_123",
    practiceRunId: null,
    officialRunId: null,
    published: false,
    refusalHeadline: null,
    nextOfficialAttempt: 2,
    events: [],
    actions: ["open_console", "open_portal", "verify_hosted", "run_again"],
    simulated: true,
  };
}

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
  async getRunSurface() {
    return null;
  },
  async verifyHosted() {
    throw new Error("not configured");
  },
  async promoteOfficial() {
    throw new Error("not configured");
  },
  async publishResult() {
    throw new Error("not configured");
  },
  async rerunHosted() {
    throw new Error("not configured");
  },
  async getRerunCommand() {
    return { command: "cogworks run --benchmark vision-recognition --live" };
  },
};

function portalWith(overrides: Partial<PortalRpcContract>): PortalRpcContract {
  return { ...basePortal, ...overrides };
}

function buttons(response: InteractionResponse): DiscordButton[] {
  return (
    response.data?.components?.flatMap((container) =>
      container.components.flatMap((child) =>
        child.type === 1 ? child.components.filter((item): item is DiscordButton => item.type === 2) : [],
      ),
    ) ?? []
  );
}

function selectValues(response: InteractionResponse): string[] {
  const rows = response.data?.components?.flatMap((container) => container.components) ?? [];
  return rows.flatMap((row) => {
    if (row.type !== 1) return [];
    return row.components.flatMap((item) =>
      item.type === 3 ? item.options.map((option) => option.value) : [],
    );
  });
}

test("/cog alone is the onboarding surface and needs no help command", async () => {
  const response = await executeCommand(command(), basePortal, guildId, portalOrigin);

  assert.equal(response.type, RESPONSE_CHANNEL_MESSAGE);
  assert.equal(response.data?.flags, EPHEMERAL | IS_COMPONENTS_V2);
  assert.match(responseText(response), /Hi Ada, I'm Cog/);
  assert.doesNotMatch(responseText(response), /help|\/cog link/i);
  assert.equal(response.data?.allowed_mentions?.parse.length, 0);
  assert.deepEqual(
    buttons(response).map(({ label, style }) => ({ label, style })),
    [
      { label: "Link to Cog*Portal", style: 5 },
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

  assert.match(responseText(response), /### .*Analytical Engines/);
  assert.match(responseText(response), /`cogworks\/engines`/);
  assert.match(responseText(response), /quiet by default/);
  assert.doesNotMatch(responseText(response), / · /);
  assert.ok(buttons(response).some((item) => item.custom_id === "cog:bind-channel"));
  assert.ok(buttons(response).some((item) => item.label === "Open Cog*Portal"));
});

test("/cog shows the one useful next run action instead of a bulky menu", async () => {
  const latest = surfaceSnapshot();
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
        discordChannelId: "123456789012345678",
        canManageDiscordChannel: true,
        activeRun: null,
        latestHosted: null,
        latestOfficial: null,
      };
    },
    async getRunSurface() {
      return latest;
    },
  });

  const response = await executeCommand(command(), portal, guildId, portalOrigin);
  assert.deepEqual(buttons(response).map((item) => item.label), ["Verify hosted", "Open Cog*Portal"]);
  assert.match(responseText(response), /Face Recognition.*local/);
  assert.doesNotMatch(responseText(response), /bbbbbbb/);
});

test("surface mutations require a private confirmation before invoking Portal", async () => {
  const latest = surfaceSnapshot();
  let calls = 0;
  const portal = portalWith({
    async getRunSurface() {
      return latest;
    },
    async verifyHosted() {
      calls += 1;
      return { ...latest, stage: "hosted", status: "running", phase: "queued" };
    },
  });

  const preview = await executeCommand(
    component(`cog:surface:${latest.id}:verify_hosted`),
    portal,
    guildId,
    portalOrigin,
  );
  assert.equal(calls, 0);
  assert.match(responseText(preview), /Verify this exact commit/);
  assert.ok(buttons(preview).some((item) => item.custom_id?.endsWith(":verify_hosted:confirm")));

  const confirmed = await executeCommand(
    component(`cog:surface:${latest.id}:verify_hosted:confirm`),
    portal,
    guildId,
    portalOrigin,
  );
  assert.equal(calls, 1);
  assert.equal(confirmed.type, RESPONSE_UPDATE_MESSAGE);
  assert.match(responseText(confirmed), /Bench updated/);
});

test("quota-spending confirmations carry the consequence in the button and a receipt", async () => {
  const latest = surfaceSnapshot();
  const portal = portalWith({
    async getRunSurface() {
      return latest;
    },
  });

  const promote = await executeCommand(
    component(`cog:surface:${latest.id}:promote_official`),
    portal,
    guildId,
    portalOrigin,
  );
  assert.match(responseText(promote), /Use an official attempt\?/);
  assert.match(responseText(promote), /attempt 2 of 3/);
  assert.match(responseText(promote), /> .*\*\*Face Recognition\*\*/);
  const promoteConfirm = buttons(promote).find((item) => item.custom_id?.endsWith(":promote_official:confirm"));
  assert.equal(promoteConfirm?.label, "Use attempt 2 of 3");
  assert.equal(promoteConfirm?.style, 4);

  const publish = await executeCommand(
    component(`cog:surface:${latest.id}:publish_result`),
    portal,
    guildId,
    portalOrigin,
  );
  const publishConfirm = buttons(publish).find((item) => item.custom_id?.endsWith(":publish_result:confirm"));
  assert.equal(publishConfirm?.label, "Publish to leaderboard");
  assert.equal(publishConfirm?.style, 4);
  assert.match(responseText(publish), /public leaderboard entry/);

  const verify = await executeCommand(
    component(`cog:surface:${latest.id}:verify_hosted`),
    portal,
    guildId,
    portalOrigin,
  );
  const verifyConfirm = buttons(verify).find((item) => item.custom_id?.endsWith(":verify_hosted:confirm"));
  assert.equal(verifyConfirm?.label, "Verify bbbbbbb hosted");
  assert.equal(verifyConfirm?.style, 1);
  assert.ok(buttons(verify).every((item) => item.label !== "Not now" || item.style === 2));
});

test("Activity launch responses use Discord callback type 12", () => {
  assert.equal(launchActivity().type, RESPONSE_LAUNCH_ACTIVITY);
});

test("the Activity Entry Point is app-handled to avoid an extra channel message", () => {
  assert.equal(entryPointCommand.type, 4);
  assert.equal(entryPointCommand.handler, 1);
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
  assert.match(responseText(response), /Face Recognition leaderboard/);
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
  assert.match(responseText(response), /official published results/);
  assert.equal(buttons(response).length, 0);
});

test("benchmarks is a launchpad: choosing one reveals its run command", async () => {
  const list = await executeCommand(command("benchmarks"), basePortal, guildId, portalOrigin);
  assert.doesNotMatch(responseText(list), /cogworks run/);
  assert.ok(selectValues(list).includes("home"));

  const pick = component("cog:bench");
  pick.data = { custom_id: "cog:bench", component_type: 3, values: ["vision-recognition"] };
  const expanded = await executeCommand(pick, basePortal, guildId, portalOrigin);
  assert.equal(expanded.type, RESPONSE_UPDATE_MESSAGE);
  assert.match(responseText(expanded), /cogworks run --benchmark vision-recognition --live/);
  assert.match(responseText(expanded), /the run happens on your machine/);
});

test("leaderboard rows carry rank marks and scores without commit noise", async () => {
  const portal = portalWith({
    async getLeaderboard() {
      return {
        benchmark,
        entries: [
          {
            rank: 1,
            teamName: "Analytical Engines",
            teamDescription: null,
            repoUrl: null,
            sha: "b".repeat(40),
            shortSha: "bbbbbbb",
            primaryMetric: { key: "accuracy", label: "Accuracy", value: 0.913, unit: null, higherIsBetter: true, primary: true, precision: 3 },
            supportingMetrics: [],
            completedAt: 1_750_000_000_000,
            isYou: true,
          },
          {
            rank: 2,
            teamName: "Face Finder",
            teamDescription: null,
            repoUrl: null,
            sha: "c".repeat(40),
            shortSha: "ccccccc",
            primaryMetric: { key: "accuracy", label: "Accuracy", value: 0.897, unit: null, higherIsBetter: true, primary: true, precision: 3 },
            supportingMetrics: [],
            completedAt: 1_750_000_000_000,
            isYou: false,
          },
        ],
      };
    },
  });
  const response = await executeCommand(component("cog:leaderboard"), portal, guildId, portalOrigin);
  const body = responseText(response);
  assert.match(body, /\*\*Analytical Engines\*\*/);
  assert.match(body, /0\.913/);
  assert.doesNotMatch(body, /bbbbbbb|ccccccc/);
});

test("the hub is one Go to… menu that routes by selected value", async () => {
  const response = await executeCommand(command("benchmarks"), basePortal, guildId, portalOrigin);
  const values = selectValues(response);
  for (const view of ["home", "leaderboard", "benchmarks", "local"]) {
    assert.ok(values.includes(view), `nav select missing ${view}`);
  }

  const nav = component("cog:nav");
  nav.data = { custom_id: "cog:nav", component_type: 3, values: ["leaderboard"] };
  const routed = await executeCommand(nav, basePortal, guildId, portalOrigin);
  assert.equal(routed.type, RESPONSE_UPDATE_MESSAGE);
  assert.match(responseText(routed), /leaderboard/);
});

test("the optional view choice jumps directly without exposing command syntax", async () => {
  const response = await executeCommand(command("benchmarks"), basePortal, guildId, portalOrigin);
  assert.match(responseText(response), /### .*Benchmarks/);
  assert.match(responseText(response), /Face Recognition/);
});

test("old subcommand payloads remain compatible during registration rollout", async () => {
  const request = command();
  request.data = { name: "cog", options: [{ type: 1, name: "benchmarks" }] };
  const response = await executeCommand(request, basePortal, guildId, portalOrigin);
  assert.match(responseText(response), /### .*Benchmarks/);
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
