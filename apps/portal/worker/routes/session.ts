import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { DevLoginRequestSchema, SessionSchema } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { devAuthAvailable } from "../env";
import { getDb } from "../db/client";
import { cohorts, teamMembers, teams, users } from "../db/schema";
import { connectTeam, fixtureRepository } from "../github/team";
import {
  authFor,
  authConfig,
  authToSession,
  forwardAuthCookies,
  getAuth,
} from "../auth/session";
import type { AuthState } from "../auth/session";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";

const DEV_PASSWORD = "cogportal-local-dev-password";

export function registerSessionRoutes(app: Hono<AppEnv>): void {
  app.get("/session", async (c) =>
    respond(c, SessionSchema, await authToSession(c.env, await getAuth(c))),
  );

  app.post("/dev/login", async (c) => {
    if (!devAuthAvailable(c.env)) {
      throw new ApiHttpError(404, "not_found", "Development login is not available.");
    }
    const body = await parseBody(c, DevLoginRequestSchema);
    const db = getDb(c.env);
    const auth = authFor(c);
    const email = `${body.login}@dev.local`;
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const result = existingUser
      ? await auth.api.signInEmail({
          body: { email, password: DEV_PASSWORD },
          returnHeaders: true,
        })
      : await auth.api.signUpEmail({
          body: { email, password: DEV_PASSWORD, name: body.login },
          returnHeaders: true,
        });

    const userId = result.response.user.id;
    // Clear githubLogin for development rows created before Better Auth.
    await db.update(users).set({ githubLogin: null }).where(eq(users.id, userId));

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

    forwardAuthCookies(c, result.headers);
    const [[domainUser], [cohort], [membership]] = await Promise.all([
      db
        .select({ githubLogin: users.githubLogin, cohortId: users.cohortId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
      db
        .select({ id: cohorts.id, slug: cohorts.slug, name: cohorts.name })
        .from(users)
        .innerJoin(cohorts, eq(users.cohortId, cohorts.id))
        .where(eq(users.id, userId))
        .limit(1),
      db
        .select({ team: teams })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(eq(teamMembers.userId, userId))
        .orderBy(teams.id)
        .limit(1),
    ]);
    if (!domainUser) {
      throw new ApiHttpError(500, "provider_unconfigured", "Development user could not be loaded.");
    }
    const state: AuthState = {
      user: {
        id: result.response.user.id,
        email: result.response.user.email,
        githubLogin: domainUser.githubLogin,
        name: result.response.user.name,
        avatarUrl: result.response.user.image ?? null,
        cohortId: domainUser.cohortId,
      },
      cohort: cohort ?? null,
      team: membership?.team ?? null,
    };
    return respond(c, SessionSchema, await authToSession(c.env, state));
  });

  app.post("/session/logout", async (c) => {
    const result = await authFor(c).api.signOut({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    forwardAuthCookies(c, result.headers);
    return respond(c, SessionSchema, {
      user: null,
      cohort: null,
      team: null,
      auth: authConfig(c.env),
    });
  });
}
