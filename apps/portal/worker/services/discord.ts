import { and, eq, ne } from "drizzle-orm";
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
      discordChannelId: null,
      canManageDiscordChannel: false,
      activeRun: null,
      latestHosted: null,
      latestOfficial: null,
    };
  }

  const [member] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, membership.team.id),
        eq(teamMembers.userId, identity.userId),
      ),
    )
    .limit(1);

  const teamRuns = await syncTeamRuns(db, membership.team.id);
  const ordered = [...teamRuns].sort((left, right) => right.createdAt - left.createdAt);
  const active = ordered.find((run) => !isTerminal(run.status)) ?? null;
  const hosted = ordered.find((run) => run.mode === "practice" && run.status === "succeeded") ?? null;
  const official = ordered.find((run) => run.mode === "official" && run.status === "succeeded") ?? null;
  return {
    linked: true,
    githubLogin: identity.githubLogin,
    team: serializeTeam(membership.team),
    discordChannelId: membership.team.discordChannelId,
    canManageDiscordChannel: member?.role === "admin" || member?.role === "maintain",
    activeRun: active ? await serializeRunSummary(db, active) : null,
    latestHosted: hosted ? await serializeRunSummary(db, hosted) : null,
    latestOfficial: official ? await serializeRunSummary(db, official) : null,
  };
}

export async function bindDiscordTeamChannel(
  env: Env,
  discordUserId: string,
  channelId: string,
): Promise<DiscordTeamStatus> {
  if (!/^\d{10,24}$/.test(channelId)) throw new Error("Discord channel ID is invalid.");
  const identity = await discordIdentity(env, discordUserId);
  if (!identity) throw new Error("Link Discord to your CogPortal account first.");
  const db = getDb(env);
  const [membership] = await db
    .select({ team: teams, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, identity.userId))
    .limit(1);
  if (!membership) throw new Error("Finish joining a team and connecting its repository first.");
  if (membership.role !== "admin" && membership.role !== "maintain") {
    throw new Error("A team creator or maintainer needs to choose the team channel.");
  }
  const [claimed] = await db
    .select({ name: teams.name })
    .from(teams)
    .where(and(eq(teams.discordChannelId, channelId), ne(teams.id, membership.team.id)))
    .limit(1);
  if (claimed) throw new Error(`That channel already belongs to ${claimed.name}.`);
  await db
    .update(teams)
    .set({ discordChannelId: channelId })
    .where(eq(teams.id, membership.team.id));
  return getDiscordTeamStatus(env, discordUserId);
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
