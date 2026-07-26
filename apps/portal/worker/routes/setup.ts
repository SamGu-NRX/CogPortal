import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  SETUP_STEPS,
  SetupEvidenceRequestSchema,
  SetupEvidenceResponseSchema,
  SetupStateSchema,
  SetupStepSchema,
  type SetupStep,
} from "@cogworks/contracts/schema";
import { requireDevice } from "../auth/device";
import { isPlatformOwner } from "../auth/roles";
import { authorizationLogin, requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import { setupVerifications, teamMembers, teams } from "../db/schema";
import { onboardingDevToolsAvailable, type AppEnv } from "../env";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";

const ResetResponseSchema = z.object({ ok: z.literal(true) });

function normalizedRepository(value: string): string {
  return value.trim().replace(/\.git$/i, "").toLowerCase();
}

async function setupState(c: Parameters<typeof requireTeam>[0]) {
  const auth = await requireTeam(c);
  const rows = await getDb(c.env)
    .select({ step: setupVerifications.step })
    .from(setupVerifications)
    .where(
      and(
        eq(setupVerifications.userId, auth.user.id),
        eq(setupVerifications.teamId, auth.team.id),
      ),
    );
  const verified = new Set(
    rows.flatMap(({ step }) => {
      const parsed = SetupStepSchema.safeParse(step);
      return parsed.success ? [parsed.data] : [];
    }),
  );
  return {
    auth,
    verified: SETUP_STEPS.filter((step) => verified.has(step)),
  };
}

export function registerSetupRoutes(app: Hono<AppEnv>): void {
  app.get("/v1/setup/state", async (c) => {
    const state = await setupState(c);
    c.header("Cache-Control", "private, no-store");
    return respond(c, SetupStateSchema, { verified: state.verified });
  });

  app.post("/v1/cli/setup/checks", async (c) => {
    const device = await requireDevice(c);
    const body = await parseBody(c, SetupEvidenceRequestSchema);
    const db = getDb(c.env);
    const [membership] = await db
      .select({ team: teams })
      .from(teamMembers)
      .innerJoin(teams, eq(teamMembers.teamId, teams.id))
      .where(eq(teamMembers.userId, device.userId))
      .limit(1);
    if (!membership) {
      throw new ApiHttpError(
        403,
        "no_team",
        "Finish joining a team and connecting its repository first.",
      );
    }
    if (
      normalizedRepository(body.repositoryFullName) !==
      normalizedRepository(membership.team.repoFullName)
    ) {
      throw new ApiHttpError(
        409,
        "invalid_request",
        `This directory is ${body.repositoryFullName}, but CogPortal expects ${membership.team.repoFullName}.`,
      );
    }

    const accepted = [...new Set(body.checks)] as SetupStep[];
    const now = Date.now();
    for (const step of accepted) {
      await db
        .insert(setupVerifications)
        .values({
          userId: device.userId,
          teamId: membership.team.id,
          step,
          verifiedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            setupVerifications.userId,
            setupVerifications.teamId,
            setupVerifications.step,
          ],
          set: { verifiedAt: now },
        });
    }
    return respond(c, SetupEvidenceResponseSchema, { accepted });
  });

  app.delete("/v1/setup/state", async (c) => {
    const state = await setupState(c);
    if (
      !onboardingDevToolsAvailable(c.env) ||
      !isPlatformOwner(c.env, authorizationLogin(c.env, state.auth.user))
    ) {
      throw new ApiHttpError(404, "not_found", "API route not found.");
    }
    await getDb(c.env)
      .delete(setupVerifications)
      .where(
        and(
          eq(setupVerifications.userId, state.auth.user.id),
          eq(setupVerifications.teamId, state.auth.team.id),
        ),
      );
    return respond(c, ResetResponseSchema, { ok: true });
  });
}
