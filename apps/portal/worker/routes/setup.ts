import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  SETUP_STEPS,
  isBenchmarkScopedStep,
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
import { benchmarks, setupVerifications, teamMembers, teams } from "../db/schema";
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
    .select({ step: setupVerifications.step, benchmarkId: setupVerifications.benchmarkId })
    .from(setupVerifications)
    .where(
      and(
        eq(setupVerifications.userId, auth.user.id),
        eq(setupVerifications.teamId, auth.team.id),
      ),
    );

  // Two buckets rather than one, because they answer different questions. A
  // row with no benchmark says something about this machine; a row with one
  // says something about that track. Merging them is what let Audio's install
  // mark Language's as done.
  const unscoped = new Set<SetupStep>();
  const scoped = new Map<string, Set<SetupStep>>();
  for (const row of rows) {
    const parsed = SetupStepSchema.safeParse(row.step);
    if (!parsed.success) continue;
    if (!row.benchmarkId) {
      unscoped.add(parsed.data);
      continue;
    }
    const set = scoped.get(row.benchmarkId) ?? new Set<SetupStep>();
    set.add(parsed.data);
    scoped.set(row.benchmarkId, set);
  }

  return {
    auth,
    verified: SETUP_STEPS.filter((step) => unscoped.has(step)),
    verifiedByBenchmark: Object.fromEntries(
      [...scoped].map(([benchmarkId, steps]) => [
        benchmarkId,
        SETUP_STEPS.filter((step) => steps.has(step)),
      ]),
    ),
  };
}

export function registerSetupRoutes(app: Hono<AppEnv>): void {
  app.get("/v1/setup/state", async (c) => {
    const state = await setupState(c);
    c.header("Cache-Control", "private, no-store");
    return respond(c, SetupStateSchema, {
      verified: state.verified,
      verifiedByBenchmark: state.verifiedByBenchmark,
    });
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

    // Only an id this portal actually publishes can scope a row. The field
    // reaches a primary key and a 2.5s-polled response, so an unrecognized id
    // is stored unscoped rather than trusted: the page keys on catalog ids and
    // would never read it back anyway.
    const scopeId = body.checkedBenchmarkId
      ? (
          await db
            .select({ id: benchmarks.id })
            .from(benchmarks)
            .where(eq(benchmarks.id, body.checkedBenchmarkId))
            .limit(1)
        )[0]?.id
      : undefined;

    const accepted = [...new Set(body.checks)] as SetupStep[];
    const now = Date.now();
    for (const step of accepted) {
      // Only the two per-benchmark steps carry the benchmark, and only when
      // the CLI named one. Storing it on `clone` would split one machine fact
      // across every track a student ever checks, and each track would then
      // show a clone it has its own evidence for.
      const benchmarkId = isBenchmarkScopedStep(step) && scopeId ? scopeId : "";
      await db
        .insert(setupVerifications)
        .values({
          userId: device.userId,
          teamId: membership.team.id,
          step,
          benchmarkId,
          verifiedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            setupVerifications.userId,
            setupVerifications.teamId,
            setupVerifications.step,
            setupVerifications.benchmarkId,
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
