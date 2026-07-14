import { WorkerEntrypoint } from "cloudflare:workers";
import type { PortalRpcContract } from "@cogworks/contracts/discord";
import type { Env } from "./env";
import { listBenchmarks } from "./services/catalog";
import {
  assertCourseGuild,
  getDiscordLocalReports,
  getDiscordTeamStatus,
} from "./services/discord";
import { createDiscordLink, unlinkDiscordByDiscordId } from "./services/identity";
import { getLeaderboardReadModel } from "./services/leaderboard";

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

  async unlinkDiscord(guildId: string, discordUserId: string) {
    assertCourseGuild(this.env, guildId);
    return { unlinked: await unlinkDiscordByDiscordId(this.env, discordUserId) };
  }
}
