import { and, eq, exists, inArray, lt, or, sql } from "drizzle-orm";
import type { RunPhase } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { deliverTeamNudges } from "../services/team-nudges";
import {
  accountLinkTokens,
  deviceAuthorizations,
  outboxEvents,
  officialAttempts,
  runs,
} from "../db/schema";

const ACTIVE_PHASES: RunPhase[] = [
  "queued",
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

export async function maintainPlatform(env: Env, now = Date.now()): Promise<void> {
  const db = getDb(env);
  const staleRuns = await db
    .select({
      id: runs.id,
      teamId: runs.teamId,
      status: runs.status,
    })
    .from(runs)
    .where(
      and(
        eq(runs.provider, "modal"),
        or(
          and(inArray(runs.status, ACTIVE_PHASES), lt(runs.createdAt, now - staleAfterMs(env))),
          and(eq(runs.status, "queued"), lt(runs.createdAt, now - QUEUED_STALE_AFTER_SECONDS * 1_000)),
        ),
      ),
    )
    .limit(100);

  for (const run of staleRuns) {
    const phase = run.status as RunPhase;
    const eligible = and(
      eq(runs.id, run.id), eq(runs.provider, "modal"), eq(runs.status, run.status),
    );
    const eligibleExists = exists(db.select({ id: runs.id }).from(runs).where(eligible));
    // Failure, release and notification commit together. A concurrent completion
    // wins or loses against this transaction, never against a later refund pass.
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
      db.delete(officialAttempts).where(and(eq(officialAttempts.runId, run.id), eligibleExists)),
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
