import { z } from "zod";
import {
  BenchmarkSchema,
  LeaderboardSchema,
  LocalReportSchema,
  RunSummarySchema,
  TeamSchema,
} from "./schema";

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
  unlinkDiscord(guildId: string, discordUserId: string): Promise<{ unlinked: boolean }>;
}
