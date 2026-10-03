import { and, eq, exists, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { RunPhase } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { deliverTeamNudges } from "../services/team-nudges";
import {
  accountLinkTokens,
  deviceAuthorizations,
  outboxEvents,
  runPhases,
  runs,
} from "../db/schema";
import { openPhases } from "../services/run-phases";

/** Active phases after the sandbox first reports. */
const REPORTING_PHASES: RunPhase[] = [
  "preparing",
  "installing",
  "contract_check",
  "evaluating",
  "scoring",
];
const DEFAULT_STALE_AFTER_SECONDS = 60 * 60;
/**
 * How long a run may sit in "queued" before it is declared dead. Shorter
 * than the general threshold because a queued run has done nothing yet: the
 * sandbox's first callback is "preparing", and on 2026-09-04 it arrived 11 s
 * after dispatch on a run that then took 133 s end to end. A run that has
 * not said "preparing" after ten minutes lost its dispatch or cannot reach
 * the portal (both happened that day: a bad User-Agent and a rotated secret),
 * and an hour of "queued" on the dashboard is an hour a student cannot tell
 * from a slow run.
 */
const QUEUED_STALE_AFTER_SECONDS = 10 * 60;

const STALE_FAILURE_DETAIL = "The execution provider stopped reporting progress.";

function staleAfterMs(env: Env): number {
  const configured = Number(env.RUN_STALE_AFTER_SECONDS ?? DEFAULT_STALE_AFTER_SECONDS);
  return Number.isFinite(configured) && configured >= 900
    ? configured * 1_000
    : DEFAULT_STALE_AFTER_SECONDS * 1_000;
}

/**
 * Whether an active Modal execution has gone silent, as of `now`.
 *
 * Queued keeps its rule: ten minutes from creation, since the first callback
 * moves it out of queued. Once reporting, an execution is silent when its
 * last accepted callback (or its creation, before any) is older than the
 * inactivity window. An execution that predates the activity clock has only
 * its creation time, so it is failed only once its one-time grace has passed
 * (see initializeLegacyGrace); with real activity, the activity decides.
 *
 * The same predicate selects candidates and guards every write that fails
 * one, so a callback landing between the read and the write wins.
 */
function silentAt(now: number, staleMs: number): SQL {
  return and(
    eq(runs.provider, "modal"),
    or(
      and(eq(runs.status, "queued"), lt(runs.createdAt, now - QUEUED_STALE_AFTER_SECONDS * 1_000)),
      and(
        inArray(runs.status, REPORTING_PHASES),
        lt(sql`coalesce(${runs.acceptedActivityAt}, ${runs.createdAt})`, now - staleMs),
        // Real activity decides; without it, no grace (0) or a grace that
        // has passed. A legacy row not yet given its grace (NULL) is never
        // silent here.
        or(isNotNull(runs.acceptedActivityAt), lt(runs.legacyGraceUntil, now)),
      ),
    ),
  )!;
}

/**
 * The rollout grace for executions already running when the activity clock
 * shipped. Silence used to be judged from creation alone, and these rows have
 * no callback recorded since. The first sweep that finds one past the window
 * gives it one more inactivity window, once: the IS NULL guard means a later
 * sweep cannot extend it. That window is the existing policy value, not a
 * measured heartbeat interval. A callback in the meantime records real
 * activity, which then decides.
 */
async function initializeLegacyGrace(env: Env, now: number, staleMs: number): Promise<void> {
  await getDb(env).update(runs).set({ legacyGraceUntil: now + staleMs }).where(and(
    eq(runs.provider, "modal"),
    inArray(runs.status, REPORTING_PHASES),
    isNull(runs.legacyGraceUntil),
    isNull(runs.acceptedActivityAt),
    lt(runs.createdAt, now - staleMs),
  ));
}

export async function maintainPlatform(env: Env, now = Date.now()): Promise<void> {
  const db = getDb(env);
  const staleMs = staleAfterMs(env);
  await initializeLegacyGrace(env, now, staleMs);
  const staleRuns = await db
    .select({
      id: runs.id,
      teamId: runs.teamId,
      status: runs.status,
    })
    .from(runs)
    .where(silentAt(now, staleMs))
    .limit(100);

  for (const run of staleRuns) {
    const phase = run.status as RunPhase;
    const eligible = and(eq(runs.id, run.id), eq(runs.status, run.status), silentAt(now, staleMs));
    // Failure, phase closure and notification commit together, each guarded
    // by silence as of `now`. A completion or a fresh callback that commits
    // first wins, including one in the same phase.
    await db.batch([
      db.insert(outboxEvents).select(db.select({
        id: sql<string>`${`outbox_stale_${run.id}`}`.as("id"),
        topic: sql<string>`'run.terminal'`.as("topic"),
        aggregateId: sql<string>`${run.id}`.as("aggregateId"),
        payloadJson: sql<string>`${JSON.stringify({ runId: run.id, teamId: run.teamId, status: "failed" })}`.as("payloadJson"),
        createdAt: sql<number>`${now}`.as("createdAt"),
        deliveredAt: sql<number | null>`null`.as("deliveredAt"),
        attempts: sql<number>`0`.as("attempts"),
        nextAttemptAt: sql<number>`${now}`.as("nextAttemptAt"),
      }).from(runs).where(eligible)).onConflictDoNothing(),
      // Settled now, so the stage that was open ends now; a run that went
      // silent (run_dcf733e51f, preempted) otherwise keeps it open for good.
      db.update(runPhases).set({ endedAt: now }).where(and(
        openPhases(run.id), exists(db.select({ id: runs.id }).from(runs).where(eligible)),
      )),
      db.update(runs).set({
        status: "failed",
        finishedAt: now,
        failureCategory: "provider",
        failurePhase: phase,
        failureDetail: STALE_FAILURE_DETAIL,
        failureConsumedAttempt: false,
      }).where(eligible),
    ]);
  }

  await Promise.all([
    db.delete(accountLinkTokens).where(lt(accountLinkTokens.expiresAt, now)),
    db.delete(deviceAuthorizations).where(lt(deviceAuthorizations.expiresAt, now)),
  ]);

  // Anything the portal noticed about a team that is worth saying in their
  // channel. Last, and swallowing its own failure, because Discord being
  // unreachable must not stop the stale-run repair above from running on the
  // next tick.
  try {
    await deliverTeamNudges(env, now);
  } catch {
    // The next tick tries again; nothing here is time-critical.
  }
}
