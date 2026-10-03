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
    // join_code is not unique (an owner's rotation draws a random code and a
    // closed cohort keeps its last one), so every match is read and the open
    // one wins. A closed match only chooses the message.
    const matches = await db
      .select()
      .from(cohorts)
      .where(eq(cohorts.joinCode, body.code.toUpperCase()));
    const open = matches.filter((row) => row.active);
    if (open.length > 1) {
      // Picking one would enroll the student in a cohort nobody chose.
      throw new ApiHttpError(
        409,
        "invalid_request",
        "This code opens more than one cohort, so we can't tell which one you mean. Ask your instructor for a new code.",
      );
    }
    const [cohort] = open;
    if (!cohort) {
      if (!matches.length) {
        throw new ApiHttpError(403, "cohort_code_invalid", "The cohort join code is invalid.");
      }
      // Saying the code is right tells nobody anything new: only someone who
      // already holds the current code reaches this branch.
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
