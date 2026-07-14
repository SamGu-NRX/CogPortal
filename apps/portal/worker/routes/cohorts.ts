import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
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
      .where(
        and(
          eq(cohorts.joinCode, body.code.toUpperCase()),
          eq(cohorts.active, true),
        ),
      )
      .limit(1);
    if (!cohort) {
      throw new ApiHttpError(403, "cohort_code_invalid", "The cohort join code is invalid.");
    }
    await db
      .update(users)
      .set({ cohortId: cohort.id, cohortJoinedAt: Date.now() })
      .where(eq(users.id, auth.user.id));
    return respond(c, SessionSchema, authToSession(c.env, await getAuth(c)));
  });
}
