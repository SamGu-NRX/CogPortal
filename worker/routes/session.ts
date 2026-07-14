import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { DevLoginRequestSchema, SessionSchema } from "@shared/schema";
import type { AppEnv } from "../env";
import { getDb } from "../db/client";
import { cohorts, teamMembers, teams, users } from "../db/schema";
import {
  authConfig,
  authToSession,
  createSession,
  destroySession,
  getAuth,
} from "../auth/session";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { newId } from "../util/id";

export function registerSessionRoutes(app: Hono<AppEnv>): void {
  app.get("/session", async (c) =>
    respond(c, SessionSchema, authToSession(c.env, await getAuth(c))),
  );

  app.post("/dev/login", async (c) => {
    if (c.env.DEV_AUTH !== "enabled") {
      throw new ApiHttpError(404, "not_found", "Development login is not available.");
    }
    const body = await parseBody(c, DevLoginRequestSchema);
    const db = getDb(c.env);
    const [existing] = await db.select().from(users).where(eq(users.githubLogin, body.login)).limit(1);
    const userId = existing?.id ?? newId("user_");
    if (!existing) {
      await db.insert(users).values({
        id: userId,
        githubLogin: body.login,
        name: null,
        avatarUrl: null,
        cohortId: null,
        createdAt: Date.now(),
      });
    }

    await createSession(c, userId);
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const [cohort] = user?.cohortId
      ? await db.select().from(cohorts).where(eq(cohorts.id, user.cohortId)).limit(1)
      : [];
    const [membership] = user
      ? await db
          .select({ team: teams })
          .from(teamMembers)
          .innerJoin(teams, eq(teamMembers.teamId, teams.id))
          .where(eq(teamMembers.userId, user.id))
          .orderBy(teams.id)
          .limit(1)
      : [];
    return respond(
      c,
      SessionSchema,
      authToSession(
        c.env,
        user
          ? {
              user,
              cohort: cohort
                ? { id: cohort.id, slug: cohort.slug, name: cohort.name }
                : null,
              team: membership?.team ?? null,
              oauthToken: null,
            }
          : null,
      ),
    );
  });

  app.post("/session/logout", async (c) => {
    await destroySession(c);
    return respond(c, SessionSchema, {
      user: null,
      cohort: null,
      team: null,
      auth: authConfig(c.env),
    });
  });
}
