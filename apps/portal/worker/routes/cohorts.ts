import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { JoinCohortRequestSchema, SessionSchema } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { authToSession, getAuth, requireUser } from "../auth/session";
import { getDb } from "../db/client";
import { cohorts, users } from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";

export function registerCohortRoutes(app: Hono<AppEnv>): void {
  app.post("/cohorts/join", async (c) => {
    const auth = await requireUser(c);
    const body = await parseBody(c, JoinCohortRequestSchema);
    const db = getDb(c.env);
    const [cohort] = await db
      .select()
      .from(cohorts)
      .where(eq(cohorts.joinCode, body.code.toUpperCase()))
      .limit(1);
    if (!cohort) {
      throw new ApiHttpError(403, "cohort_code_invalid", "The cohort join code is invalid.");
    }
    // Saying the code is right tells nobody anything new: only someone who
    // already holds the current code reaches this branch.
    if (!cohort.active) {
      throw new ApiHttpError(
        403,
        "forbidden",
        "That code is right, but enrollment is closed. Ask your instructor to open it.",
      );
    }
    // Team membership cannot cross cohort boundaries.
    if (auth.team && auth.team.cohortId !== cohort.id) {
      throw new ApiHttpError(
        409,
        "already_on_team",
        "You're on a team in your current cohort. Leave it before joining a different cohort.",
      );
    }
    await db
      .update(users)
      .set({ cohortId: cohort.id, cohortJoinedAt: Date.now() })
      .where(eq(users.id, auth.user.id));
    return respond(c, SessionSchema, await authToSession(c.env, await getAuth(c)));
  });
}
