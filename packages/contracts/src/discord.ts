import { z } from "zod";
import {
  ApiErrorCodeSchema,
  BenchmarkSchema,
  LeaderboardSchema,
  LocalReportSchema,
  RunSummarySchema,
  TeamSchema,
  RunSurfaceSnapshotSchema,
} from "@cogworks/contracts/schema";

export const DiscordLinkStartSchema = z.object({
  alreadyLinked: z.boolean(),
  url: z.string().url().nullable(),
  expiresAt: z.number().int().nullable(),
});
export type DiscordLinkStart = z.infer<typeof DiscordLinkStartSchema>;

export const DiscordTeamStatusSchema = z.discriminatedUnion("linked", [
  z.object({ linked: z.literal(false) }),
  z.object({
    linked: z.literal(true),
    githubLogin: z.string(),
    team: TeamSchema.nullable(),
    discordChannelId: z.string().nullable(),
    canManageDiscordChannel: z.boolean(),
    activeRun: RunSummarySchema.nullable(),
    latestHosted: RunSummarySchema.nullable(),
    latestOfficial: RunSummarySchema.nullable(),
  }),
]);
export type DiscordTeamStatus = z.infer<typeof DiscordTeamStatusSchema>;

export const DiscordLocalReportsSchema = z.object({
  linked: z.boolean(),
  reports: z.array(LocalReportSchema).max(10),
});
export type DiscordLocalReports = z.infer<typeof DiscordLocalReportsSchema>;

/**
 * A refusal the portal wrote for the student, as it arrives over the service
 * binding.
 *
 * Workers RPC rebuilds a thrown error on the caller's side with its `name`,
 * `message` and own serializable fields, but not its class (enhanced error
 * serialization, on by default from compatibility date 2026-04-21), so this
 * reads fields rather than `instanceof`. `PortalRpc.answer` lets only
 * `ApiHttpError` through and replaces everything else, which is what makes
 * the message safe to show. Anything that does not match is a failure the
 * caller cannot explain and must not guess at.
 */
export const PortalRefusalSchema = z.object({
  name: z.literal("ApiHttpError"),
  code: ApiErrorCodeSchema,
  message: z.string().min(1).max(600),
});
export type PortalRefusal = z.infer<typeof PortalRefusalSchema>;

export function portalRefusal(error: unknown): PortalRefusal | null {
  if (!(error instanceof Error)) return null;
  const parsed = PortalRefusalSchema.safeParse({
    name: error.name,
    code: (error as { code?: unknown }).code,
    message: error.message,
  });
  return parsed.success ? parsed.data : null;
}

export interface PortalRpcContract {
  getBenchmarks(guildId: string): Promise<z.infer<typeof BenchmarkSchema>[]>;
  getLeaderboard(guildId: string, benchmarkId?: string): Promise<z.infer<typeof LeaderboardSchema>>;
  getTeamStatus(guildId: string, discordUserId: string): Promise<DiscordTeamStatus>;
  getLocalReports(
    guildId: string,
    discordUserId: string,
    benchmarkId?: string,
  ): Promise<DiscordLocalReports>;
  createDiscordLink(
    guildId: string,
    discordUserId: string,
    discordUsername: string,
  ): Promise<DiscordLinkStart>;
  bindTeamChannel(
    guildId: string,
    discordUserId: string,
    channelId: string,
  ): Promise<DiscordTeamStatus>;
  unlinkDiscord(guildId: string, discordUserId: string): Promise<{ unlinked: boolean }>;
  getRunSurface(
    guildId: string,
    discordUserId: string,
    surfaceId?: string,
  ): Promise<z.infer<typeof RunSurfaceSnapshotSchema> | null>;
  verifyHosted(
    guildId: string,
    discordUserId: string,
    surfaceId: string,
  ): Promise<z.infer<typeof RunSurfaceSnapshotSchema>>;
  promoteOfficial(
    guildId: string,
    discordUserId: string,
    surfaceId: string,
  ): Promise<z.infer<typeof RunSurfaceSnapshotSchema>>;
  publishResult(
    guildId: string,
    discordUserId: string,
    surfaceId: string,
  ): Promise<z.infer<typeof RunSurfaceSnapshotSchema>>;
  rerunHosted(
    guildId: string,
    discordUserId: string,
    surfaceId: string,
  ): Promise<z.infer<typeof RunSurfaceSnapshotSchema>>;
  retryRun(
    guildId: string,
    discordUserId: string,
    surfaceId: string,
    runId: string,
  ): Promise<z.infer<typeof RunSurfaceSnapshotSchema>>;
  getRerunCommand(
    guildId: string,
    discordUserId: string,
    surfaceId: string,
  ): Promise<{ command: string }>;
}
