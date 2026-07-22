import { WorkerEntrypoint } from "cloudflare:workers";
import type { PortalRpcContract } from "@cogworks/contracts/discord";
import type { Env } from "./env";
import { listBenchmarks } from "./services/catalog";
import {
  assertCourseGuild,
  bindDiscordTeamChannel,
  getDiscordLocalReports,
  getDiscordTeamStatus,
} from "./services/discord";
import { createDiscordLink, unlinkDiscordByDiscordId } from "./services/identity";
import { getLeaderboardReadModel } from "./services/leaderboard";
import { desc, eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { runSurfaces } from "./db/schema";
import { ApiHttpError } from "./http/errors";
import {
  buildRunSurfaceSnapshot,
  getRunSurfaceRow,
} from "./services/run-surfaces";
import {
  discordRunActor,
  performRunSurfaceMutation,
} from "./services/run-actions";

export class PortalRpc extends WorkerEntrypoint<Env> implements PortalRpcContract {
  async getBenchmarks(guildId: string) {
    assertCourseGuild(this.env, guildId);
    return listBenchmarks(this.env);
  }

  async getLeaderboard(guildId: string, benchmarkId?: string) {
    assertCourseGuild(this.env, guildId);
    return getLeaderboardReadModel(this.env, benchmarkId);
  }

  async getTeamStatus(guildId: string, discordUserId: string) {
    assertCourseGuild(this.env, guildId);
    return getDiscordTeamStatus(this.env, discordUserId);
  }

  async getLocalReports(guildId: string, discordUserId: string, benchmarkId?: string) {
    assertCourseGuild(this.env, guildId);
    return getDiscordLocalReports(this.env, discordUserId, benchmarkId);
  }

  async createDiscordLink(guildId: string, discordUserId: string, discordUsername: string) {
    assertCourseGuild(this.env, guildId);
    return createDiscordLink(this.env, discordUserId, discordUsername);
  }

  async bindTeamChannel(guildId: string, discordUserId: string, channelId: string) {
    assertCourseGuild(this.env, guildId);
    return bindDiscordTeamChannel(this.env, discordUserId, channelId);
  }

  async unlinkDiscord(guildId: string, discordUserId: string) {
    assertCourseGuild(this.env, guildId);
    return { unlinked: await unlinkDiscordByDiscordId(this.env, discordUserId) };
  }

  private async actorSurface(guildId: string, discordUserId: string, surfaceId: string) {
    assertCourseGuild(this.env, guildId);
    const actor = await discordRunActor(this.env, discordUserId);
    const surface = await getRunSurfaceRow(this.env, surfaceId);
    if (surface.teamId !== actor.team.id) throw new ApiHttpError(404, "not_found", "Run surface not found.");
    return { actor, surface };
  }

  async getRunSurface(guildId: string, discordUserId: string, surfaceId?: string) {
    assertCourseGuild(this.env, guildId);
    const actor = await discordRunActor(this.env, discordUserId);
    let id = surfaceId;
    if (!id) {
      const [latest] = await getDb(this.env)
        .select({ id: runSurfaces.id })
        .from(runSurfaces)
        .where(eq(runSurfaces.teamId, actor.team.id))
        .orderBy(desc(runSurfaces.updatedAt))
        .limit(1);
      id = latest?.id;
    }
    if (!id) return null;
    const surface = await getRunSurfaceRow(this.env, id);
    if (surface.teamId !== actor.team.id) throw new ApiHttpError(404, "not_found", "Run surface not found.");
    return buildRunSurfaceSnapshot(this.env, id);
  }

  async verifyHosted(guildId: string, discordUserId: string, surfaceId: string) {
    const { actor } = await this.actorSurface(guildId, discordUserId, surfaceId);
    return performRunSurfaceMutation(this.env, actor, surfaceId, "verify_hosted");
  }

  async promoteOfficial(guildId: string, discordUserId: string, surfaceId: string) {
    const { actor } = await this.actorSurface(guildId, discordUserId, surfaceId);
    return performRunSurfaceMutation(this.env, actor, surfaceId, "promote_official");
  }

  async publishResult(guildId: string, discordUserId: string, surfaceId: string) {
    const { actor } = await this.actorSurface(guildId, discordUserId, surfaceId);
    return performRunSurfaceMutation(this.env, actor, surfaceId, "publish_result");
  }

  async rerunHosted(guildId: string, discordUserId: string, surfaceId: string) {
    const { actor } = await this.actorSurface(guildId, discordUserId, surfaceId);
    return performRunSurfaceMutation(this.env, actor, surfaceId, "rerun_hosted");
  }

  async getRerunCommand(guildId: string, discordUserId: string, surfaceId: string) {
    await this.actorSurface(guildId, discordUserId, surfaceId);
    const snapshot = await buildRunSurfaceSnapshot(this.env, surfaceId);
    const safeBenchmark = snapshot.benchmark.id.replace(/[^a-zA-Z0-9._-]/g, "");
    return { command: `cogworks run --benchmark ${safeBenchmark} --live` };
  }
}
