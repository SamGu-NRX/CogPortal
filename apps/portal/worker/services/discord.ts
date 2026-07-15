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

const DISCORD_API = "https://discord.com/api/v10";
const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;

interface DiscordRole {
  id: string;
  permissions: string;
}

interface DiscordMember {
  user?: { id: string };
  roles: string[];
}

interface DiscordOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

interface DiscordChannel {
  id: string;
  guild_id?: string;
  type: number;
  permission_overwrites?: DiscordOverwrite[];
}

function applyOverwrite(permissions: bigint, overwrite: DiscordOverwrite | undefined): bigint {
  if (!overwrite) return permissions;
  return (permissions & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow);
}

export function effectiveDiscordChannelPermissions(
  guildId: string,
  botUserId: string,
  member: DiscordMember,
  roles: DiscordRole[],
  overwrites: DiscordOverwrite[],
): bigint {
  const roleIds = new Set(member.roles);
  let permissions = roles
    .filter((role) => role.id === guildId || roleIds.has(role.id))
    .reduce((value, role) => value | BigInt(role.permissions), 0n);
  if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) return ~0n;

  permissions = applyOverwrite(
    permissions,
    overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === guildId),
  );
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !roleIds.has(overwrite.id)) continue;
    roleAllow |= BigInt(overwrite.allow);
    roleDeny |= BigInt(overwrite.deny);
  }
  permissions = (permissions & ~roleDeny) | roleAllow;
  return applyOverwrite(
    permissions,
    overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === botUserId),
  );
}

async function discordGet<T>(env: Env, path: string): Promise<T> {
  if (!env.DISCORD_BOT_TOKEN) {
    throw new Error("CogBot channel validation is not configured. Ask course staff to add the bot token.");
  }
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "User-Agent": "DiscordBot (https://cogportal-dev.sillion.app, 1)",
    },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403 || response.status === 404
        ? "CogBot cannot view that channel. Give its existing role View Channel and Send Messages, then try again."
        : "Discord could not validate that channel just now. Nothing changed.",
    );
  }
  return (await response.json()) as T;
}

export async function assertDiscordChannelWritable(env: Env, channelId: string): Promise<void> {
  if (!env.COURSE_GUILD_ID || !env.DISCORD_CLIENT_ID) {
    throw new Error("CogBot channel validation is not configured for this course server.");
  }
  const channel = await discordGet<DiscordChannel>(env, `/channels/${encodeURIComponent(channelId)}`);
  if (channel.guild_id !== env.COURSE_GUILD_ID || channel.type !== 0) {
    throw new Error("Choose a text channel in the CogWorks course server.");
  }
  const [roles, member] = await Promise.all([
    discordGet<DiscordRole[]>(env, `/guilds/${env.COURSE_GUILD_ID}/roles`),
    discordGet<DiscordMember>(
      env,
      `/guilds/${env.COURSE_GUILD_ID}/members/${env.DISCORD_CLIENT_ID}`,
    ),
  ]);
  const permissions = effectiveDiscordChannelPermissions(
    env.COURSE_GUILD_ID,
    member.user?.id ?? env.DISCORD_CLIENT_ID,
    member,
    roles,
    channel.permission_overwrites ?? [],
  );
  if ((permissions & VIEW_CHANNEL) !== VIEW_CHANNEL || (permissions & SEND_MESSAGES) !== SEND_MESSAGES) {
    throw new Error(
      "CogBot needs View Channel and Send Messages in this private channel. Ask course staff to update its existing role, then try again.",
    );
  }
}

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
  if (!identity) throw new Error("Link Discord to your Cog*Portal account first.");
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
  await assertDiscordChannelWritable(env, channelId);
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
