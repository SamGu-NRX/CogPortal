import type { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  SELF_CHECKABLE_SETUP_STEPS,
  SETUP_STEPS,
  isBenchmarkScopedStep,
  isSelfCheckableStep,
  SetupEvidenceRequestSchema,
  SetupEvidenceResponseSchema,
  SetupStateSchema,
  SetupStepSchema,
  type SetupStep,
} from "@cogworks/contracts/schema";
import { requireDevice } from "../auth/device";
import {
  checkOffExpiry,
  createCheckOffToken,
  maybeSigningSecret,
  readCheckOffToken,
  STALE_TOKEN_MESSAGE,
} from "./setup-check-off-token";
import { isPlatformOwner } from "../auth/roles";
import { authorizationLogin, requireTeam } from "../auth/session";
import { getDb, type Database } from "../db/client";
import { benchmarks, setupVerifications, teamMembers, teams } from "../db/schema";
import { onboardingDevToolsAvailable, type AppEnv, type Env } from "../env";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";

const ResetResponseSchema = z.object({ ok: z.literal(true) });

/* ── Check-off commands ───────────────────────────────────────────────── */

/** One token per checkable step, all for the benchmark the page is showing. */
async function checkOffTokens(
  env: Env,
  userId: string,
  teamId: string,
  benchmarkId: string,
): Promise<Record<string, string> | undefined> {
  const secret = maybeSigningSecret(env);
  if (!secret) return undefined;
  const exp = checkOffExpiry();
  const entries = await Promise.all(
    SELF_CHECKABLE_SETUP_STEPS.map(async (step) => [
      step,
      await createCheckOffToken(secret, {
        u: userId,
        t: teamId,
        s: step,
        b: isBenchmarkScopedStep(step) ? benchmarkId : "",
        exp,
      }),
    ] as const),
  );
  return Object.fromEntries(entries);
}

function noTeam(): ApiHttpError {
  return new ApiHttpError(403, "no_team", "Finish joining a team and connecting its repository first.");
}

function normalizedRepository(value: string): string {
  return value.trim().replace(/\.git$/i, "").toLowerCase();
}

/**
 * The membership check and the write are one statement because a separate
 * lookup leaves a gap for a removal to land in, and a check-off token can
 * outlive its membership by a week. `cli` outranks `self`: an observation is
 * never downgraded by the student's word. False means nothing was written.
 */
async function recordSetupStep(
  db: Database,
  row: {
    userId: string;
    teamId: string;
    step: SetupStep;
    benchmarkId: string;
    verifiedAt: number;
    source: "cli" | "self";
  },
): Promise<boolean> {
  const written = await db
    .insert(setupVerifications)
    .select(
      // Drizzle requires every column, in table order. The WHERE also stops
      // SQLite reading the upsert's ON as a join constraint.
      db
        .select({
          userId: teamMembers.userId,
          teamId: teamMembers.teamId,
          step: sql<string>`${row.step}`.as("step"),
          benchmarkId: sql<string>`${row.benchmarkId}`.as("benchmarkId"),
          verifiedAt: sql<number>`${row.verifiedAt}`.as("verifiedAt"),
          source: sql<string>`${row.source}`.as("source"),
        })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, row.userId), eq(teamMembers.teamId, row.teamId))),
    )
    .onConflictDoUpdate({
      target: [
        setupVerifications.userId,
        setupVerifications.teamId,
        setupVerifications.step,
        setupVerifications.benchmarkId,
      ],
      set:
        row.source === "cli"
          ? { verifiedAt: row.verifiedAt, source: "cli" }
          : { verifiedAt: row.verifiedAt },
    })
    .returning({ step: setupVerifications.step });
  return written.length > 0;
}

async function setupState(c: Parameters<typeof requireTeam>[0]) {
  const auth = await requireTeam(c);
  const rows = await getDb(c.env)
    .select({
      step: setupVerifications.step,
      benchmarkId: setupVerifications.benchmarkId,
      source: setupVerifications.source,
    })
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
  //
  // Then the same split again by who said so. A row the CLI reported is
  // observed; a row the student checked off is not, and the page has to be
  // able to tell them apart to avoid calling the second one verified.
  const unscoped = { cli: new Set<SetupStep>(), self: new Set<SetupStep>() };
  const scoped = { cli: new Map<string, Set<SetupStep>>(), self: new Map<string, Set<SetupStep>>() };
  for (const row of rows) {
    const parsed = SetupStepSchema.safeParse(row.step);
    if (!parsed.success) continue;
    const bucket = row.source === "self" ? "self" : "cli";
    if (!row.benchmarkId) {
      unscoped[bucket].add(parsed.data);
      continue;
    }
    const byBenchmark = scoped[bucket];
    const set = byBenchmark.get(row.benchmarkId) ?? new Set<SetupStep>();
    set.add(parsed.data);
    byBenchmark.set(row.benchmarkId, set);
  }

  const listed = (steps: Set<SetupStep>) => SETUP_STEPS.filter((step) => steps.has(step));
  const listedByBenchmark = (byBenchmark: Map<string, Set<SetupStep>>) =>
    Object.fromEntries([...byBenchmark].map(([id, steps]) => [id, listed(steps)]));

  return {
    auth,
    verified: listed(unscoped.cli),
    verifiedByBenchmark: listedByBenchmark(scoped.cli),
    checked: listed(unscoped.self),
    checkedByBenchmark: listedByBenchmark(scoped.self),
  };
}

export function registerSetupRoutes(app: Hono<AppEnv>): void {
  app.get("/v1/setup/state", async (c) => {
    const state = await setupState(c);
    // The tokens are signed for one benchmark, so the page has to say which
    // one it is showing. An id this portal does not publish signs nothing:
    // the check-off would write a scope no track ever reads back.
    const requested = c.req.query("benchmarkId");
    const benchmarkId = requested
      ? ((
          await getDb(c.env)
            .select({ id: benchmarks.id })
            .from(benchmarks)
            .where(eq(benchmarks.id, requested))
            .limit(1)
        )[0]?.id ?? "")
      : "";
    c.header("Cache-Control", "private, no-store");
    return respond(c, SetupStateSchema, {
      verified: state.verified,
      verifiedByBenchmark: state.verifiedByBenchmark,
      checked: state.checked,
      checkedByBenchmark: state.checkedByBenchmark,
      tokens: benchmarkId
        ? await checkOffTokens(c.env, state.auth.user.id, state.auth.team.id, benchmarkId)
        : undefined,
    });
  });

  // The command a student copies off the setup page. POST, not GET: the token
  // is in a URL a link prefetcher, a chat unfurl or a corporate scanner may
  // follow, and none of those should be able to tick somebody's box.
  app.post("/v1/setup/check-off", async (c) => {
    const payload = await readCheckOffToken(maybeSigningSecret(c.env), c.req.query("t"));
    if (!payload) return c.text(STALE_TOKEN_MESSAGE, 400);
    // Only the steps the page offers a command for. `wiring` is what `check`
    // decides, so a token naming it is not something this route should honour
    // even though nothing legitimately mints one.
    if (!isSelfCheckableStep(payload.s)) return c.text(STALE_TOKEN_MESSAGE, 400);

    // Same sentence as any stale command, so a leaked copy does not reveal
    // whether the student is still on the team.
    const recorded = await recordSetupStep(getDb(c.env), {
      userId: payload.u,
      teamId: payload.t,
      step: payload.s,
      benchmarkId: payload.b,
      verifiedAt: Date.now(),
      source: "self",
    });
    if (!recorded) return c.text(STALE_TOKEN_MESSAGE, 400);

    return c.text(`CogPortal: '${payload.s}' is checked off. Back to the browser with you.`);
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
    if (!membership) throw noTeam();
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
      const recorded = await recordSetupStep(db, {
        userId: device.userId,
        teamId: membership.team.id,
        step,
        benchmarkId,
        verifiedAt: now,
        source: "cli",
      });
      // A removal landed after the membership read above.
      if (!recorded) throw noTeam();
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
