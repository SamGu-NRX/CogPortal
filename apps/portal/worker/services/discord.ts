import { eq } from "drizzle-orm";
import type {
  DiscordLocalReports,
  DiscordTeamStatus,
} from "@cogworks/contracts/discord";
import { isTerminal } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { discordAccounts, teamMembers, teams, users } from "../db/schema";
import { syncTeamRuns } from "../execution/sync";
import { serializeRunSummary, serializeTeam } from "../http/serializers";
import { listTeamLocalReports } from "./local-reports";

export function assertCourseGuild(env: Env, guildId: string): void {
  if (!env.COURSE_GUILD_ID || guildId !== env.COURSE_GUILD_ID) {
    throw new Error("This CogBot installation is not enabled for that server.");
  }
}

async function discordIdentity(env: Env, discordUserId: string) {
  const [identity] = await getDb(env)
    .select({ userId: users.id, githubLogin: users.githubLogin })
    .from(discordAccounts)
    .innerJoin(users, eq(discordAccounts.userId, users.id))
    .where(eq(discordAccounts.discordUserId, discordUserId))
    .limit(1);
  return identity ?? null;
}

export async function getDiscordTeamStatus(
  env: Env,
  discordUserId: string,
): Promise<DiscordTeamStatus> {
  const identity = await discordIdentity(env, discordUserId);
  if (!identity) return { linked: false };
  const db = getDb(env);
  const [membership] = await db
    .select({ team: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, identity.userId))
    .limit(1);
  if (!membership) {
    return {
      linked: true,
      githubLogin: identity.githubLogin,
      team: null,
      activeRun: null,
      latestHosted: null,
      latestOfficial: null,
    };
  }

  const teamRuns = await syncTeamRuns(db, membership.team.id);
  const ordered = [...teamRuns].sort((left, right) => right.createdAt - left.createdAt);
  const active = ordered.find((run) => !isTerminal(run.status)) ?? null;
  const hosted = ordered.find((run) => run.mode === "practice" && run.status === "succeeded") ?? null;
  const official = ordered.find((run) => run.mode === "official" && run.status === "succeeded") ?? null;
  return {
    linked: true,
    githubLogin: identity.githubLogin,
    team: serializeTeam(membership.team),
    activeRun: active ? await serializeRunSummary(db, active) : null,
    latestHosted: hosted ? await serializeRunSummary(db, hosted) : null,
    latestOfficial: official ? await serializeRunSummary(db, official) : null,
  };
}

export async function getDiscordLocalReports(
  env: Env,
  discordUserId: string,
  benchmarkId?: string,
): Promise<DiscordLocalReports> {
  const identity = await discordIdentity(env, discordUserId);
  if (!identity) return { linked: false, reports: [] };
  const reports = await listTeamLocalReports(env, identity.userId, benchmarkId);
  return { linked: true, reports: reports.slice(0, 10) };
}
