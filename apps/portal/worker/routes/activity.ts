import type { Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { RetryRunRequestSchema, RunSurfaceSnapshotSchema } from "@cogworks/contracts/schema";
import { accountLogin } from "../auth/session";
import type { AppEnv } from "../env";
import { getDb } from "../db/client";
import { discordAccounts, runSurfaces, teamMembers, teams, users } from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { createDiscordLink } from "../services/identity";
import { buildRunSurfaceSnapshot, getRunSurfaceRow } from "../services/run-surfaces";
import { discordRunActor, performRunSurfaceMutation } from "../services/run-actions";
import { randomHex } from "../util/id";

const STATE_COOKIE = "cog_activity_oauth_state";
const SESSION_COOKIE = "cog_activity_session";
const SESSION_TTL_SECONDS = 60 * 60;

const StateSchema = z.object({ state: z.string().min(32) });
const TokenRequestSchema = z.object({ code: z.string().min(1).max(512), state: z.string().min(32) });
const TokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  user: z.object({ id: z.string(), username: z.string(), globalName: z.string().nullable() }),
});
const ActivitySessionSchema = z.discriminatedUnion("linked", [
  z.object({ linked: z.literal(false), linkUrl: z.string().url() }),
  // Linked but teamless was reported as unlinked, so the card told a student
  // who had already linked to link again. Different state, different sentence.
  z.object({ linked: z.literal("no_team"), portalUrl: z.string().url() }),
  z.object({
    linked: z.literal(true),
    githubLogin: z.string(),
    team: z.object({ id: z.string(), name: z.string(), discordChannelId: z.string().nullable() }),
  }),
]);
const ActivityMutationSchema = z.enum([
  "verify_hosted",
  "promote_official",
  "publish_result",
  "rerun_hosted",
  "retry",
]);

function configured(c: Context<AppEnv>): { clientId: string; clientSecret: string; sessionSecret: string } {
  if (!c.env.DISCORD_CLIENT_ID || !c.env.DISCORD_CLIENT_SECRET || !c.env.ACTIVITY_SESSION_SECRET) {
    throw new ApiHttpError(501, "provider_unconfigured", "Discord Activity authentication is not configured.");
  }
  return {
    clientId: c.env.DISCORD_CLIENT_ID,
    clientSecret: c.env.DISCORD_CLIENT_SECRET,
    sessionSecret: c.env.ACTIVITY_SESSION_SECRET,
  };
}

export function activityCookieOptions(url: string, maxAge: number) {
  const secure = new URL(url).protocol === "https:";
  const common = {
    httpOnly: true,
    path: "/",
    maxAge,
  };
  return secure
    ? {
        ...common,
        secure: true as const,
        sameSite: "None" as const,
        partitioned: true as const,
        priority: "High" as const,
      }
    : {
        ...common,
        secure: false as const,
        sameSite: "Lax" as const,
      };
}

function cookieOptions(c: Context<AppEnv>, maxAge: number) {
  return activityCookieOptions(c.req.url, maxAge);
}

async function activityDiscordId(c: Context<AppEnv>): Promise<string> {
  const { sessionSecret } = configured(c);
  const raw = await getSignedCookie(c, sessionSecret, SESSION_COOKIE);
  if (!raw) throw new ApiHttpError(401, "unauthorized", "Open the Cog Activity again.");
  const [discordUserId, expires] = raw.split(".");
  if (!discordUserId || !expires || Number(expires) <= Date.now()) {
    throw new ApiHttpError(401, "unauthorized", "The Cog Activity session expired. Open it again.");
  }
  return discordUserId;
}

async function activityIdentity(env: AppEnv["Bindings"], discordUserId: string) {
  const [row] = await getDb(env)
    .select({
      userId: users.id,
      githubLogin: users.githubLogin,
      email: users.email,
      team: teams,
    })
    .from(discordAccounts)
    .innerJoin(users, eq(discordAccounts.userId, users.id))
    .leftJoin(teamMembers, eq(teamMembers.userId, users.id))
    .leftJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(discordAccounts.discordUserId, discordUserId))
    .limit(1);
  return row ?? null;
}

async function requireActivityTeam(c: Context<AppEnv>) {
  const identity = await activityIdentity(c.env, await activityDiscordId(c));
  if (!identity?.team) throw new ApiHttpError(403, "no_team", "Link Discord and finish joining a Cog*Portal team first.");
  return { ...identity, team: identity.team };
}

export function registerActivityRoutes(app: Hono<AppEnv>): void {
  app.get("/activity/oauth/state", async (c) => {
    const { sessionSecret } = configured(c);
    const state = randomHex(24);
    await setSignedCookie(c, STATE_COOKIE, state, sessionSecret, cookieOptions(c, 10 * 60));
    return respond(c, StateSchema, { state });
  });

  app.post("/activity/oauth/token", async (c) => {
    const config = configured(c);
    const body = await parseBody(c, TokenRequestSchema);
    const expected = await getSignedCookie(c, config.sessionSecret, STATE_COOKIE);
    if (!expected || expected !== body.state) {
      throw new ApiHttpError(400, "invalid_request", "The Discord Activity authorization state expired.");
    }
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code: body.code,
      }),
    });
    if (!tokenResponse.ok) {
      throw new ApiHttpError(401, "unauthorized", "Discord could not authorize the Activity.");
    }
    const token = z.object({ access_token: z.string().min(1) }).parse(await tokenResponse.json());
    const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userResponse.ok) throw new ApiHttpError(401, "unauthorized", "Discord identity could not be loaded.");
    const user = z
      .object({ id: z.string(), username: z.string(), global_name: z.string().nullable().optional() })
      .parse(await userResponse.json());
    const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1_000;
    await setSignedCookie(
      c,
      SESSION_COOKIE,
      `${user.id}.${expiresAt}`,
      config.sessionSecret,
      cookieOptions(c, SESSION_TTL_SECONDS),
    );
    deleteCookie(c, STATE_COOKIE, cookieOptions(c, 0));
    return respond(c, TokenResponseSchema, {
      accessToken: token.access_token,
      user: { id: user.id, username: user.username, globalName: user.global_name ?? null },
    });
  });

  app.get("/activity/session", async (c) => {
    const discordUserId = await activityDiscordId(c);
    const identity = await activityIdentity(c.env, discordUserId);
    if (!identity) {
      const start = await createDiscordLink(c.env, discordUserId, "Discord user");
      const linkUrl = start.url ?? new URL("/connections", c.env.PUBLIC_ORIGIN ?? c.req.url).toString();
      return respond(c, ActivitySessionSchema, { linked: false, linkUrl });
    }
    if (!identity.team) {
      const portalUrl = new URL("/connect", c.env.PUBLIC_ORIGIN ?? c.req.url).toString();
      return respond(c, ActivitySessionSchema, { linked: "no_team", portalUrl });
    }
    return respond(c, ActivitySessionSchema, {
      linked: true,
      githubLogin: accountLogin(identity),
      team: {
        id: identity.team.id,
        name: identity.team.name,
        discordChannelId: identity.team.discordChannelId,
      },
    });
  });

  app.get("/activity/run-surfaces", async (c) => {
    const identity = await requireActivityTeam(c);
    const rows = await getDb(c.env)
      .select({ id: runSurfaces.id })
      .from(runSurfaces)
      .where(eq(runSurfaces.teamId, identity.team.id))
      .orderBy(desc(runSurfaces.updatedAt))
      .limit(10);
    return respond(
      c,
      z.array(RunSurfaceSnapshotSchema),
      await Promise.all(rows.map((row) => buildRunSurfaceSnapshot(c.env, row.id))),
    );
  });

  app.post("/activity/run-surfaces/:id/actions/:action", async (c) => {
    const discordUserId = await activityDiscordId(c);
    const identity = await requireActivityTeam(c);
    const surfaceId = c.req.param("id");
    const surface = await getRunSurfaceRow(c.env, surfaceId);
    if (surface.teamId !== identity.team.id) {
      throw new ApiHttpError(404, "not_found", "Run surface not found.");
    }
    const action = ActivityMutationSchema.parse(c.req.param("action"));
    const snapshot = await performRunSurfaceMutation(
      c.env,
      await discordRunActor(c.env, discordUserId),
      surfaceId,
      action,
      action === "retry" ? await parseBody(c, RetryRunRequestSchema) : undefined,
    );
    return respond(c, RunSurfaceSnapshotSchema, snapshot);
  });

  app.get("/activity/run-surfaces/:id/stream", async (c) => {
    const identity = await requireActivityTeam(c);
    const surfaceId = c.req.param("id");
    const surface = await getRunSurfaceRow(c.env, surfaceId);
    if (surface.teamId !== identity.team.id) throw new ApiHttpError(404, "not_found", "Run surface not found.");
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: { code: "invalid_request", message: "Expected a WebSocket upgrade." } }, 426);
    }
    const stub = c.env.RUN_SURFACES.get(c.env.RUN_SURFACES.idFromName(surfaceId));
    return stub.fetch(new Request("https://run-surface.internal/connect", { headers: c.req.raw.headers }));
  });
}
