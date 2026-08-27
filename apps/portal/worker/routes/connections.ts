import type { Hono } from "hono";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  ApproveDeviceRequestSchema,
  ConfirmDiscordLinkRequestSchema,
  ConnectionSummarySchema,
  DeviceAuthorizationStartResponseSchema,
  DeviceTokenRequestSchema,
  DeviceTokenResponseSchema,
  DeviceStatusSchema,
  DiscordLinkPreviewSchema,
  RevokeDeviceRequestSchema,
} from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { requireDevice } from "../auth/device";
import { accountLogin, requireTeam, requireUser } from "../auth/session";
import { getDb } from "../db/client";
import {
  accountLinkTokens,
  cliDevices,
  deviceAuthorizations,
  discordAccounts,
  teamMembers,
  teams,
  users,
} from "../db/schema";
import {
  findActiveDiscordLink,
  getConnectionSummary,
} from "../services/identity";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { isUniqueConstraintError } from "./team";
import { newId, randomHex } from "../util/id";
import { sha256Hex } from "../util/crypto";

const DEVICE_AUTH_TTL_MS = 10 * 60 * 1000;
const DEVICE_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const DEVICE_POLL_INTERVAL_SECONDS = 5;

function portalOrigin(url: string, configured?: string): string {
  return (configured ?? new URL(url).origin).replace(/\/$/, "");
}

function userCode(): string {
  // 48 bits keeps the ten-minute approval code impractical to enumerate.
  const raw = randomHex(6).toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export function registerConnectionRoutes(app: Hono<AppEnv>): void {
  app.get("/v1/connections", async (c) => {
    const auth = await requireUser(c);
    return respond(c, ConnectionSummarySchema, await getConnectionSummary(c.env, auth.user.id));
  });

  app.post("/v1/connections/discord/preview", async (c) => {
    await requireTeam(c);
    const body = await parseBody(c, ConfirmDiscordLinkRequestSchema);
    const link = await findActiveDiscordLink(c.env, body.token);
    if (!link?.discordUsername) {
      throw new ApiHttpError(
        410,
        "link_expired",
        "This Discord link has expired. Open /cog in the course server to get a new one.",
      );
    }
    return respond(c, DiscordLinkPreviewSchema, {
      username: link.discordUsername,
      expiresAt: link.expiresAt,
    });
  });

  app.post("/v1/connections/discord/confirm", async (c) => {
    const auth = await requireTeam(c);
    const body = await parseBody(c, ConfirmDiscordLinkRequestSchema);
    const link = await findActiveDiscordLink(c.env, body.token);
    if (!link?.discordUserId || !link.discordUsername) {
      throw new ApiHttpError(
        410,
        "link_expired",
        "This Discord link has expired. Open /cog in the course server to get a new one.",
      );
    }

    const db = getDb(c.env);
    const [byDiscord, byUser] = await Promise.all([
      db
        .select()
        .from(discordAccounts)
        .where(eq(discordAccounts.discordUserId, link.discordUserId))
        .limit(1),
      db.select().from(discordAccounts).where(eq(discordAccounts.userId, auth.user.id)).limit(1),
    ]);
    const discordAccount = byDiscord[0];
    const userAccount = byUser[0];
    if (
      (discordAccount && discordAccount.userId !== auth.user.id) ||
      (userAccount && userAccount.discordUserId !== link.discordUserId)
    ) {
      throw new ApiHttpError(
        409,
        "link_conflict",
        "One of these accounts is already linked. Revoke the old connection before trying again.",
      );
    }

    const now = Date.now();
    // Claim the one-time token before creating the link to serialize confirms.
    const consumed = await db
      .update(accountLinkTokens)
      .set({ consumedAt: now })
      .where(and(eq(accountLinkTokens.id, link.id), isNull(accountLinkTokens.consumedAt)));
    if ((consumed.meta.changes ?? 0) !== 1) {
      throw new ApiHttpError(410, "link_expired", "This Discord link was already used.");
    }
    if (!discordAccount && !userAccount) {
      try {
        await db.insert(discordAccounts).values({
          discordUserId: link.discordUserId,
          userId: auth.user.id,
          username: link.discordUsername,
          linkedAt: now,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ApiHttpError(
            409,
            "link_conflict",
            "One of these accounts is already linked. Revoke the old connection before trying again.",
          );
        }
        throw error;
      }
    }
    return respond(c, ConnectionSummarySchema, await getConnectionSummary(c.env, auth.user.id));
  });

  app.delete("/v1/connections/discord", async (c) => {
    const auth = await requireUser(c);
    await getDb(c.env).delete(discordAccounts).where(eq(discordAccounts.userId, auth.user.id));
    return respond(c, ConnectionSummarySchema, await getConnectionSummary(c.env, auth.user.id));
  });

  app.post("/v1/cli/device/start", async (c) => {
    const rawDeviceCode = randomHex(32);
    const code = userCode();
    const now = Date.now();
    const expiresAt = now + DEVICE_AUTH_TTL_MS;
    await getDb(c.env).insert(deviceAuthorizations).values({
      deviceCodeHash: await sha256Hex(rawDeviceCode),
      userCode: code,
      expiresAt,
      createdAt: now,
      userId: null,
      deviceName: null,
      approvedAt: null,
      consumedAt: null,
    });
    return respond(c, DeviceAuthorizationStartResponseSchema, {
      deviceCode: rawDeviceCode,
      userCode: code,
      verificationUri: `${portalOrigin(c.req.url, c.env.PUBLIC_ORIGIN)}/connections?user_code=${encodeURIComponent(code)}&return_to=setup`,
      expiresAt,
      pollIntervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
    });
  });

  app.post("/v1/cli/device/approve", async (c) => {
    const auth = await requireTeam(c);
    const body = await parseBody(c, ApproveDeviceRequestSchema);
    const now = Date.now();
    const result = await getDb(c.env)
      .update(deviceAuthorizations)
      .set({
        userId: auth.user.id,
        deviceName: body.deviceName,
        approvedAt: now,
      })
      .where(
        and(
          eq(deviceAuthorizations.userCode, body.userCode),
          gt(deviceAuthorizations.expiresAt, now),
          isNull(deviceAuthorizations.approvedAt),
          isNull(deviceAuthorizations.consumedAt),
        ),
      );
    if ((result.meta.changes ?? 0) !== 1) {
      // Approving twice happens innocently: a reload re-offers the form while
      // the code is still in the URL. If this user already approved this
      // code, the approval succeeded; refusing it would tell them otherwise.
      const [existing] = await getDb(c.env)
        .select({
          approvedAt: deviceAuthorizations.approvedAt,
          userId: deviceAuthorizations.userId,
          expiresAt: deviceAuthorizations.expiresAt,
          consumedAt: deviceAuthorizations.consumedAt,
        })
        .from(deviceAuthorizations)
        .where(eq(deviceAuthorizations.userCode, body.userCode))
        .limit(1);
      const stillLinkable = existing?.consumedAt != null || (existing?.expiresAt ?? 0) > now;
      if (existing?.approvedAt && existing.userId === auth.user.id && stillLinkable) {
        // This user already approved this code and the CLI either finished
        // linking or still can; a reload re-offering the form is the only way
        // here. An approved code the CLI never consumed before expiry falls
        // through to the refusal, because "the terminal will finish linking"
        // would be false.
        return c.json({ ok: true }, 200);
      }
      throw new ApiHttpError(410, "link_expired", "The device code is invalid, expired, or already used.");
    }
    return c.json({ ok: true }, 200);
  });

  app.post("/v1/cli/device/token", async (c) => {
    const body = await parseBody(c, DeviceTokenRequestSchema);
    const now = Date.now();
    const codeHash = await sha256Hex(body.deviceCode);
    const [authorization] = await getDb(c.env)
      .select()
      .from(deviceAuthorizations)
      .where(
        and(
          eq(deviceAuthorizations.deviceCodeHash, codeHash),
          gt(deviceAuthorizations.expiresAt, now),
          isNull(deviceAuthorizations.consumedAt),
        ),
      )
      .limit(1);
    if (!authorization) {
      throw new ApiHttpError(410, "link_expired", "The device authorization expired. Start again.");
    }
    if (!authorization.userId || !authorization.approvedAt || !authorization.deviceName) {
      return respond(c, DeviceTokenResponseSchema, {
        status: "pending",
        retryAfterSeconds: DEVICE_POLL_INTERVAL_SECONDS,
      });
    }

    const claimed = await getDb(c.env)
      .update(deviceAuthorizations)
      .set({ consumedAt: now })
      .where(
        and(
          eq(deviceAuthorizations.deviceCodeHash, codeHash),
          gt(deviceAuthorizations.expiresAt, now),
          isNull(deviceAuthorizations.consumedAt),
        ),
      );
    if ((claimed.meta.changes ?? 0) !== 1) {
      throw new ApiHttpError(410, "link_expired", "The device authorization was already used.");
    }

    const rawToken = `cog_${randomHex(32)}`;
    const expiresAt = now + DEVICE_TOKEN_TTL_MS;
    await getDb(c.env).insert(cliDevices).values({
      id: newId("cli_"),
      userId: authorization.userId,
      name: authorization.deviceName,
      tokenHash: await sha256Hex(rawToken),
      createdAt: now,
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
    });
    return respond(c, DeviceTokenResponseSchema, {
      status: "authorized",
      token: rawToken,
      expiresAt,
    });
  });

  app.delete("/v1/cli/devices", async (c) => {
    const auth = await requireUser(c);
    const body = await parseBody(c, RevokeDeviceRequestSchema);
    await getDb(c.env)
      .update(cliDevices)
      .set({ revokedAt: Date.now() })
      .where(and(eq(cliDevices.id, body.deviceId), eq(cliDevices.userId, auth.user.id)));
    return respond(c, ConnectionSummarySchema, await getConnectionSummary(c.env, auth.user.id));
  });

  app.get("/v1/cli/device/status", async (c) => {
    if (c.req.header("Authorization")?.startsWith("Bearer cog_")) {
      const device = await requireDevice(c);
      const [membership] = await getDb(c.env)
        .select({ team: teams, githubLogin: users.githubLogin, email: users.email })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .innerJoin(users, eq(teamMembers.userId, users.id))
        .where(eq(teamMembers.userId, device.userId))
        .limit(1);
      if (!membership) {
        throw new ApiHttpError(403, "no_team", "Finish joining a team and connecting its repository first.");
      }
      return respond(c, DeviceStatusSchema, {
        githubLogin: accountLogin(membership),
        teamName: membership.team.name,
        repositoryFullName: membership.team.repoFullName,
        discordChannelId: membership.team.discordChannelId,
        deviceName: device.name,
        deviceExpiresAt: device.expiresAt,
      });
    }
    await requireUser(c);
    const code = c.req.query("user_code")?.toUpperCase();
    if (!code) throw new ApiHttpError(400, "invalid_request", "A device code is required.");
    const [authorization] = await getDb(c.env)
      .select({ expiresAt: deviceAuthorizations.expiresAt, approvedAt: deviceAuthorizations.approvedAt })
      .from(deviceAuthorizations)
      .where(
        and(
          eq(deviceAuthorizations.userCode, code),
          gt(deviceAuthorizations.expiresAt, Date.now()),
          isNull(deviceAuthorizations.consumedAt),
        ),
      )
      .limit(1);
    return respond(
      c,
      z.object({ valid: z.boolean(), approved: z.boolean(), expiresAt: z.number().nullable() }),
      {
        valid: Boolean(authorization),
        approved: Boolean(authorization?.approvedAt),
        expiresAt: authorization?.expiresAt ?? null,
      },
    );
  });
}
