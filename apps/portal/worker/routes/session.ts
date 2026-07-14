import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { DevLoginRequestSchema, SessionSchema } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { getDb } from "../db/client";
import { cohorts, users } from "../db/schema";
import { connectTeam, fixtureRepository } from "../github/team";
import {
  authConfig,
  authToSession,
  createSession,
  destroySession,
  getAuth,
  getAuthForUser,
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

    if (body.demo) {
      const [cohort] = await db
        .select()
        .from(cohorts)
        .where(eq(cohorts.active, true))
        .limit(1);
      if (!cohort) throw new ApiHttpError(404, "not_found", "Active cohort not found.");
      await db
        .update(users)
        .set({ cohortId: cohort.id, cohortJoinedAt: Date.now() })
        .where(eq(users.id, userId));
      await connectTeam(
        db,
        cohort.id,
        userId,
        fixtureRepository(),
        "write",
        "Demo Team",
      );
    }

    await createSession(c, userId);
    // The cookie was set on the RESPONSE — read auth by id, not from getAuth.
    return respond(c, SessionSchema, authToSession(c.env, await getAuthForUser(c, userId)));
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
