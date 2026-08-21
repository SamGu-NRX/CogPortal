import { and, eq, inArray, lt } from "drizzle-orm";
import type { RunPhase } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { deliverTeamNudges } from "../services/team-nudges";
import {
  accountLinkTokens,
  deviceAuthorizations,
  outboxEvents,
  runs,
} from "../db/schema";
import { refundOfficialAttempt, withRefundCapNotice } from "./refunds";

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
 * What a stale run says between the terminal update below and the side effects
 * that follow it. The second pass selects on exactly this string, so it is
 * also the marker for "this run is terminal, its side effects are not applied
 * yet", and every outcome has to rewrite it or the run is selected forever.
 *
 * This used to end with "This attempt was refunded", which the refund cap can
 * now make false, so the claim moved to the settled strings below. Runs that
 * went stale under the previous deploy carry the old text and no longer match
 * this selector. Their refund had already been applied by the cron tick that
 * wrote it, with one exception: a run that went stale inside the last tick
 * interval before the deploy misses its refund and its terminal notification.
 * That window is bounded by the cron period (five minutes, wrangler.jsonc) and
 * an instructor can return the attempt by hand; closing it in code would mean
 * matching the old string too, which would then re-count every refund the
 * platform has ever given against the new cap.
 */
const STALE_FAILURE_DETAIL = "The execution provider stopped reporting progress.";
const STALE_REFUNDED_DETAIL = `${STALE_FAILURE_DETAIL} This attempt was refunded.`;
/** Practice runs claim no official attempt, so there is nothing to give back. */
const STALE_SETTLED_DETAIL = `${STALE_FAILURE_DETAIL} Start the run again when you're ready.`;

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
  // update cannot strand a consumed official attempt. Every operation below is
  // safe to repeat on the next cron tick, and the detail rewrite at the end of
  // each pass is what takes a settled run out of this selector.
  const staleFailures = await db
    .select({
      id: runs.id,
      teamId: runs.teamId,
      benchmarkId: runs.benchmarkId,
      benchmarkVersion: runs.benchmarkVersion,
      mode: runs.mode,
      refundedAt: runs.refundedAt,
    })
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
    // A run that stalls past the wall-clock ceiling is refunded on the clock
    // alone, with no evidence about whose fault it was, which makes this the
    // easiest refund on the platform to provoke repeatedly. The cap in
    // ./refunds.ts is the same one the fixture and live runner paths use.
    //
    // Refund before the rewrite, never after: the rewrite is the exit from
    // this selector, so a crash between them costs one repeated pass, while
    // the other order would drop the refund entirely.
    const outcome = await refundOfficialAttempt(db, run, now);
    // `run.refundedAt` covers the repeated pass after a crash between the
    // refund and this rewrite: the refund is already recorded, so the decision
    // above declines to repeat it, and the run still needs the text that says
    // the attempt came back.
    const refunded = outcome === "refunded" || run.refundedAt !== null;
    await db
      .update(runs)
      .set(
        outcome === "capped"
          ? {
              failureDetail: withRefundCapNotice(STALE_FAILURE_DETAIL),
              // The attempt really is spent now, and FailureCard.tsx renders
              // this flag as the authoritative line about that.
              failureConsumedAttempt: true,
            }
          : { failureDetail: refunded ? STALE_REFUNDED_DETAIL : STALE_SETTLED_DETAIL },
      )
      .where(eq(runs.id, run.id));
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
