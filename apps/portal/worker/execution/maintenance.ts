import { and, eq, inArray, lt } from "drizzle-orm";
import type { RunPhase } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import {
  accountLinkTokens,
  deviceAuthorizations,
  officialAttempts,
  outboxEvents,
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
const STALE_FAILURE_DETAIL =
  "The execution provider stopped reporting progress. This attempt was refunded.";

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
        inArray(runs.status, ACTIVE_PHASES),
        lt(runs.createdAt, now - staleAfterMs(env)),
      ),
    )
    .limit(100);

  for (const run of staleRuns) {
    const phase = run.status as RunPhase;
    await db
      .update(runs)
      .set({
        status: "failed",
        finishedAt: now,
        failureCategory: "provider",
        failurePhase: phase,
        failureDetail: STALE_FAILURE_DETAIL,
        failureConsumedAttempt: false,
      })
      .where(
        and(
          eq(runs.id, run.id),
          eq(runs.provider, "modal"),
          eq(runs.status, run.status),
        ),
      );
  }

  // Repair side effects separately so a transient D1 error after the terminal
  // update cannot strand a consumed official attempt. Every operation is safe
  // to repeat on the next cron tick.
  const staleFailures = await db
    .select({ id: runs.id, teamId: runs.teamId })
    .from(runs)
    .where(
      and(
        eq(runs.provider, "modal"),
        eq(runs.status, "failed"),
        eq(runs.failureDetail, STALE_FAILURE_DETAIL),
      ),
    )
    .limit(100);
  for (const run of staleFailures) {
    await db.delete(officialAttempts).where(eq(officialAttempts.runId, run.id));
    await db
      .insert(outboxEvents)
      .values({
        id: `outbox_stale_${run.id}`,
        topic: "run.terminal",
        aggregateId: run.id,
        payloadJson: JSON.stringify({ runId: run.id, teamId: run.teamId, status: "failed" }),
        createdAt: now,
        deliveredAt: null,
        attempts: 0,
        nextAttemptAt: now,
      })
      .onConflictDoNothing();
  }

  await Promise.all([
    db.delete(accountLinkTokens).where(lt(accountLinkTokens.expiresAt, now)),
    db.delete(deviceAuthorizations).where(lt(deviceAuthorizations.expiresAt, now)),
  ]);
}
