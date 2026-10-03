import assert from "node:assert/strict";
import { test } from "node:test";
import { portalRefusal, type PortalRpcContract } from "@cogworks/contracts/discord";
import type { RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import type { DiscordButton } from "@cogworks/discord-kit/components";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { responseText, type DiscordInteraction, type InteractionResponse } from "../src/interaction.ts";

/**
 * A student who presses a button in Discord and is refused has to learn why,
 * the same as one who pressed it in the portal. The bot used to answer every
 * thrown error with "I couldn't reach Cog*Portal just now. Nothing changed.",
 * which lost the portal's own sentence ("sign in again", "all 3 attempts are
 * used", "that channel already belongs to ...") and promised "Nothing changed"
 * about a request whose answer it never saw.
 *
 * These go through the Worker's real fetch handler: a signed interaction in,
 * the deferred PATCH to Discord out. The portal is a stub whose errors have
 * the shape Workers RPC delivers (name, message and own fields; no class).
 */

const guildId = "course-guild";
const portalOrigin = "https://portal.example";
const surfaceId = `surface_${"a".repeat(20)}`;

function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: "ApiHttpError", code, status: 409 });
}

function snapshot(): RunSurfaceSnapshot {
  return {
    id: surfaceId,
    team: { id: "team-1", name: "Analytical Engines" },
    benchmark: { id: "vision-recognition", version: 1, title: "Face Recognition" },
    actor: { login: "ada-lovelace", name: "Ada" },
    sha: "b".repeat(40),
    shortSha: "bbbbbbb",
    branch: "main",
    source: {
      owner: "analytical-engines",
      name: "vision",
      fullName: "analytical-engines/vision",
      url: "https://github.com/analytical-engines/vision",
    },
    sourceRefusal: null,
    dirty: false,
    stage: "hosted",
    status: "succeeded",
    phase: "succeeded",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_010_000,
    finishedAt: 1_750_000_010_000,
    silentSince: null,
    elapsedMs: 10_000,
    progress: null,
    primaryMetric: null,
    metrics: [],
    teamBest: null,
    localRunId: null,
    practiceRunId: "run_practice",
    officialRunId: null,
    published: false,
    refusalHeadline: null,
    promotionRefusal: null,
    publicationRefusal: null,
    retryRefusal: null,
    nextOfficialAttempt: 4,
    events: [],
    executionHistory: [],
    executionGeneration: 0,
    snapshotRevision: 1,
    actions: ["open_console", "open_portal", "promote_official"],
    simulated: true,
  };
}

const linkedStatus = {
  linked: true as const,
  githubLogin: "ada-lovelace",
  team: {
    id: "team-1",
    name: "Analytical Engines",
    description: null,
    provenance: "live" as const,
    repo: null,
  },
  discordChannelId: null,
  canManageDiscordChannel: true,
  activeRun: null,
  latestHosted: null,
  latestOfficial: null,
};

function portal(overrides: Partial<PortalRpcContract>): PortalRpcContract {
  const unused = async () => {
    throw new Error("this test did not expect that call");
  };
  return {
    getBenchmarks: unused,
    getLeaderboard: unused,
    getTeamStatus: async () => linkedStatus,
    getLocalReports: unused,
    createDiscordLink: unused,
    unlinkDiscord: unused,
    bindTeamChannel: unused,
    getRunSurface: async () => snapshot(),
    verifyHosted: unused,
    promoteOfficial: unused,
    publishResult: unused,
    rerunHosted: unused,
    retryRun: unused,
    getRerunCommand: unused,
    ...overrides,
  };
}

function component(customId: string): DiscordInteraction {
  return {
    id: "interaction-1",
    type: 3,
    application_id: "app-1",
    token: "interaction-token",
    guild_id: guildId,
    channel_id: "123456789012345678",
    member: { user: { id: "discord-1", username: "student", global_name: "Ada" } },
    data: { custom_id: customId, component_type: 2 },
  };
}

const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
const publicKeyHex = Buffer.from((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer).toString("hex");

function workerEnv(rpc: PortalRpcContract): Env {
  return { PORTAL: rpc, DISCORD_PUBLIC_KEY: publicKeyHex, COURSE_GUILD_ID: guildId, PORTAL_ORIGIN: portalOrigin };
}

function context(waitUntil: (promise: Promise<unknown>) => void): ExecutionContext {
  // SAFETY: index.ts uses only `waitUntil`; `exports` and `tracing` are
  // workerd runtime objects a Node test cannot construct.
  return { waitUntil, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

/** Sends one signed interaction and returns what the bot PATCHed to Discord. */
async function deferredAnswer(interaction: DiscordInteraction, rpc: PortalRpcContract): Promise<InteractionResponse["data"]> {
  const body = JSON.stringify(interaction);
  const timestamp = "1750000000";
  const signature = Buffer.from(
    await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body)),
  ).toString("hex");

  const patches: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.match(String(input), /\/webhooks\/app-1\/interaction-token\/messages\/@original$/);
    assert.equal(init?.method, "PATCH");
    patches.push(String(init?.body));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const pending: Promise<unknown>[] = [];
  try {
    const response = await worker.fetch(
      new Request("https://bot.example/interactions", {
        method: "POST",
        headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
        body,
      }),
      workerEnv(rpc),
      context((promise) => pending.push(promise)),
    );
    assert.equal(response.status, 200);
    await Promise.all(pending);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(patches.length, 1, "exactly one edit of the deferred message");
  return JSON.parse(patches[0]!) as InteractionResponse["data"];
}

function text(data: InteractionResponse["data"]): string {
  return responseText({ type: 4, data });
}

function buttons(data: InteractionResponse["data"]): DiscordButton[] {
  return (data?.components ?? []).flatMap((container) =>
    container.components.flatMap((child) =>
      child.type === 1 ? child.components.filter((item): item is DiscordButton => item.type === 2) : [],
    ),
  );
}

test("only an ApiHttpError with a known code and a bounded message counts as a refusal", () => {
  assert.deepEqual(portalRefusal(rpcError("quota_exhausted", "All 3 official attempts on this version are used.")), {
    name: "ApiHttpError",
    code: "quota_exhausted",
    message: "All 3 official attempts on this version are used.",
  });
  // What PortalRpc.answer throws for anything it will not explain.
  assert.equal(portalRefusal(new Error("Cog*Portal could not complete that request.")), null);
  // A service-binding failure, or anything else that never passed through answer().
  assert.equal(portalRefusal(Object.assign(new Error("D1_ERROR: no such column: teams.secret"), { code: "D1" })), null);
  assert.equal(portalRefusal(rpcError("made_up_code", "Something")), null);
  assert.equal(portalRefusal(rpcError("forbidden", "x".repeat(601))), null);
  assert.equal(portalRefusal({ name: "ApiHttpError", code: "forbidden", message: "not an Error" }), null);
});

test("expired GitHub access reaches Discord as the portal wrote it, with the portal one click away", async () => {
  const sentence =
    "GitHub no longer accepts this portal's sign-in for you. Sign out, sign in with GitHub again, and retry this action.";
  const answer = await deferredAnswer(
    component(`cog:surface:${surfaceId}:promote_official:confirm`),
    portal({
      async promoteOfficial() {
        throw rpcError("forbidden", sentence);
      },
    }),
  );
  assert.equal(text(answer), sentence);
  assert.deepEqual(
    buttons(answer).map((item) => [item.label, item.custom_id ?? item.url]),
    [
      ["Back to Cog", "cog:home"],
      ["Open Cog*Portal", `${portalOrigin}/run-surfaces/${surfaceId}`],
    ],
  );
  assert.deepEqual(answer?.allowed_mentions, { parse: [] });
});

test("an exhausted quota says what is used and what is still open", async () => {
  const sentence =
    "All 3 official attempts on this version are used. An official attempt that already succeeded may still be publishable; its run page says whether it is.";
  const answer = await deferredAnswer(
    component(`cog:surface:${surfaceId}:promote_official:confirm`),
    portal({
      async promoteOfficial() {
        throw rpcError("quota_exhausted", sentence);
      },
    }),
  );
  assert.equal(text(answer), sentence);
});

test("a channel already bound elsewhere is refused in words, with markdown and mentions inert", async () => {
  // A team name is written by students, so it is the part that must not
  // render as a heading, a link or a mention.
  const sentence =
    "That channel already belongs to # [Engines](https://evil.example) <@&42> @everyone. Open /cog in your own team's channel and choose it there.";
  const answer = await deferredAnswer(
    component("cog:bind-channel:confirm"),
    portal({
      async bindTeamChannel() {
        throw rpcError("link_conflict", sentence);
      },
    }),
  );
  assert.equal(
    text(answer),
    "That channel already belongs to # \\[Engines\\]\\(https://evil.example\\) \\<\\@&42> \\@everyone. Open /cog in your own team's channel and choose it there.",
  );
  assert.deepEqual(answer?.allowed_mentions, { parse: [] });
  assert.deepEqual(
    buttons(answer).map((item) => item.label),
    ["Back to Cog", "Open Cog*Portal"],
  );
});

test("a failure the portal did not explain shows no internals and does not claim nothing changed", async () => {
  const internals = "D1_ERROR: UNIQUE constraint failed: runs.id at /worker/services/run-actions.ts:412";
  const answer = await deferredAnswer(
    component(`cog:surface:${surfaceId}:promote_official:confirm`),
    portal({
      async promoteOfficial() {
        throw new Error(internals);
      },
    }),
  );
  const shown = text(answer);
  assert.equal(
    shown,
    "I couldn't confirm that with Cog\\*Portal. It may still have gone through, so check the run there before pressing it again.",
  );
  assert.doesNotMatch(shown, /D1_ERROR|run-actions|Nothing changed/);
  assert.deepEqual(
    buttons(answer).map((item) => [item.label, item.custom_id ?? item.url]),
    [
      ["Back to Cog", "cog:home"],
      ["Open Cog*Portal", `${portalOrigin}/run-surfaces/${surfaceId}`],
    ],
  );
});

test("a channel bind whose answer was lost points at the team bench rather than the run", async () => {
  const answer = await deferredAnswer(
    component("cog:bind-channel:confirm"),
    portal({
      async bindTeamChannel() {
        throw new TypeError("Network connection lost.");
      },
    }),
  );
  assert.equal(
    text(answer),
    "I couldn't confirm that with Cog\\*Portal. It may still have gone through, so check the team bench before trying again.",
  );
  assert.deepEqual(buttons(answer).map((item) => item.label), ["Back to Cog"]);
});

test("a read that could not reach the portal says to try again and nothing more", async () => {
  const answer = await deferredAnswer(
    component("cog:home"),
    portal({
      async getTeamStatus() {
        throw new TypeError("Network connection lost.");
      },
    }),
  );
  assert.equal(text(answer), "I couldn't reach Cog\\*Portal just now. Try again in a moment.");
  assert.deepEqual(buttons(answer).map((item) => item.label), ["Back to Cog"]);
});

/** The public leaderboard share answers inline rather than through a deferred
 *  edit, so its failure goes through index.ts's second catch. */
async function inlineAnswer(interaction: DiscordInteraction, rpc: PortalRpcContract): Promise<InteractionResponse> {
  const body = JSON.stringify(interaction);
  const timestamp = "1750000000";
  const signature = Buffer.from(
    await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body)),
  ).toString("hex");
  const response = await worker.fetch(
    new Request("https://bot.example/interactions", {
      method: "POST",
      headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
      body,
    }),
    workerEnv(rpc),
    context(() => assert.fail("the share path should not defer")),
  );
  return (await response.json()) as InteractionResponse;
}

test("the inline share path tells a refusal from an unreachable portal too", async () => {
  const unreachable = await inlineAnswer(
    component("cog:share:leaderboard"),
    portal({
      async getLeaderboard() {
        throw new TypeError("Network connection lost.");
      },
    }),
  );
  assert.equal(text(unreachable.data), "I couldn't reach Cog\\*Portal just now. Try again in a moment.");

  const refused = await inlineAnswer(
    component("cog:share:leaderboard"),
    portal({
      async getLeaderboard() {
        throw rpcError("forbidden", "This CogBot installation is not enabled for that server.");
      },
    }),
  );
  assert.equal(text(refused.data), "This CogBot installation is not enabled for that server.");
  assert.deepEqual(refused.data?.allowed_mentions, { parse: [] });
});
