import { and, eq, gt, isNull } from "drizzle-orm";
import type { ConnectionSummary } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import {
  accountLinkTokens,
  cliDevices,
  discordAccounts,
  users,
} from "../db/schema";
import { newId, randomHex } from "../util/id";
import { sha256Hex } from "../util/crypto";

const DISCORD_LINK_TTL_MS = 10 * 60 * 1000;

export interface DiscordLinkStart {
  alreadyLinked: boolean;
  url: string | null;
  expiresAt: number | null;
}

function publicOrigin(env: Env): string {
  return (env.PUBLIC_ORIGIN ?? "http://localhost:5173").replace(/\/$/, "");
}

export async function createDiscordLink(
  env: Env,
  discordUserId: string,
  discordUsername: string,
): Promise<DiscordLinkStart> {
  const db = getDb(env);
  const [existing] = await db
    .select({ userId: discordAccounts.userId })
    .from(discordAccounts)
    .where(eq(discordAccounts.discordUserId, discordUserId))
    .limit(1);
  if (existing) return { alreadyLinked: true, url: null, expiresAt: null };

  const rawToken = randomHex(32);
  const now = Date.now();
  const expiresAt = now + DISCORD_LINK_TTL_MS;
  await db.insert(accountLinkTokens).values({
    id: newId("link_"),
    purpose: "discord",
    tokenHash: await sha256Hex(rawToken),
    discordUserId,
    discordUsername,
    createdAt: now,
    expiresAt,
    consumedAt: null,
  });
  return {
    alreadyLinked: false,
    url: `${publicOrigin(env)}/connections#discord=${rawToken}`,
    expiresAt,
  };
}

export async function unlinkDiscordByDiscordId(env: Env, discordUserId: string): Promise<boolean> {
  const result = await getDb(env)
    .delete(discordAccounts)
    .where(eq(discordAccounts.discordUserId, discordUserId));
  return (result.meta.changes ?? 0) > 0;
}

export async function getConnectionSummary(env: Env, userId: string): Promise<ConnectionSummary> {
  const db = getDb(env);
  const [user, discord, devices] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).limit(1),
    db.select().from(discordAccounts).where(eq(discordAccounts.userId, userId)).limit(1),
    db
      .select()
      .from(cliDevices)
      .where(
        and(
          eq(cliDevices.userId, userId),
          gt(cliDevices.expiresAt, Date.now()),
          isNull(cliDevices.revokedAt),
        ),
      ),
  ]);
  const account = user[0];
  if (!account) throw new Error("Connection owner no longer exists.");
  return {
    github: account.githubLogin
      ? {
          id: account.githubId,
          login: account.githubLogin,
          avatarUrl: account.image,
        }
      : null,
    discord: discord[0]
      ? {
          userId: discord[0].discordUserId,
          username: discord[0].username,
          linkedAt: discord[0].linkedAt,
        }
      : null,
    cliDevices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastUsedAt: device.lastUsedAt,
    })),
  };
}

export async function findActiveDiscordLink(env: Env, rawToken: string) {
  const [link] = await getDb(env)
    .select()
    .from(accountLinkTokens)
    .where(
      and(
        eq(accountLinkTokens.tokenHash, await sha256Hex(rawToken)),
        eq(accountLinkTokens.purpose, "discord"),
        gt(accountLinkTokens.expiresAt, Date.now()),
        isNull(accountLinkTokens.consumedAt),
      ),
    )
    .limit(1);
  return link ?? null;
}
