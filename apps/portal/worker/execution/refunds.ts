import { and, count, eq, exists, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { officialAttempts, runs } from "../db/schema";

/**
 * When a run fails for a reason that is ours and not the team's, the platform
 * gives the official attempt back by deleting the claim row. Three code paths
 * do that: the live runner callback (routes/runner-events.ts), the fixture
 * state machine (execution/sync.ts), and the stale-run reaper
 * (execution/maintenance.ts). Until now none of them counted, and none of them
 * stopped, so a submission that reliably provoked a platform-side failure
 * could be replayed forever without ever spending an attempt.
 *
 * This module is the one place that decides. The three paths each end a run in
 * their own way, so they cannot share the terminal write, but they must share
 * the decision or a cap in one is not a cap in the others.
 */

/**
 * How many refunds one team may receive on one benchmark before the platform
 * stops giving attempts back.
 *
 * There is no measured basis for 5. Nothing here was calibrated, and there is
 * nothing to calibrate against: the platform never recorded a refund until the
 * migration that added `runs.refunded_at`, so no history of real refund counts
 * exists. 5 was chosen against the one number we do have, OFFICIAL_LIMIT = 3.
 * A team hitting genuine infrastructure trouble can lose and regain every one
 * of their three attempts and still have room left, so the cap does not punish
 * them. A team whose submission provokes the same platform-side failure over
 * and over runs out and shows up on the admin overview instead of looping
 * unseen.
 *
 * Revisit once `refunded_at` has a season of real counts behind it.
 */
export const REFUND_CAP = 5;

/**
 * What the team reads when the cap stops a refund.
 *
 * The count is interpolated from REFUND_CAP so the sentence cannot drift away
 * from the rule it describes. Voice per docs/design/voice.md: why before what,
 * plain about the outcome, one next action, and no suggestion that the team
 * did something wrong. We do not know that they did.
 */
export const REFUND_CAP_DETAIL =
  "A run that fails on our side normally gives the attempt back. Your team has already received all " +
  `${REFUND_CAP} refunds available on this benchmark, so this one stays spent. Bring the run to an ` +
  "instructor and they can look at what keeps going wrong.";

/**
 * Adds the cap notice to a failure detail the runner already wrote.
 *
 * Appended rather than substituted because an official run keeps no log
 * (routes/runner-events.ts writes `log` only for practice), so `failureDetail`
 * is the only surviving text about why the run died. Replacing it would delete
 * the very evidence the message tells the team to bring to an instructor.
 */
export function withRefundCapNotice(detail: string | null): string {
  return detail ? `${detail} ${REFUND_CAP_DETAIL}` : REFUND_CAP_DETAIL;
}

/** The columns a refund decision reads. Every caller selects at least these. */
export interface RefundableRun {
  id: string;
  teamId: string;
  benchmarkId: string;
  benchmarkVersion: number;
  mode: "practice" | "official";
  refundedAt: number | null;
}

export type RefundOutcome =
  /** The attempt was given back and the run is now counted as a refund. */
  | "refunded"
  /** The team is at the cap on this benchmark. Nothing was given back. */
  | "capped"
  /** There was no official attempt to give back, or it was given back already. */
  | "not_applicable";

/**
 * Decides whether this failed run gets its official attempt back, and if so,
 * gives it back and records that it happened.
 *
 * The caller still owns the run's terminal write. On "capped" it must say so
 * in the failure detail, because a team that silently loses an attempt to a
 * platform failure has no way to tell that from a bug.
 */
export async function refundOfficialAttempt(
  db: Database,
  run: RefundableRun,
  now: number,
): Promise<RefundOutcome> {
  if (run.mode !== "official") return "not_applicable";
  // The stale reaper re-selects the same failed run every five minutes until
  // its failure detail changes, so without this guard a refunded run would
  // rewrite its own timestamp on every cron tick.
  if (run.refundedAt !== null) return "not_applicable";
  const scope = and(
    eq(runs.teamId, run.teamId),
    eq(runs.benchmarkId, run.benchmarkId),
    eq(runs.benchmarkVersion, run.benchmarkVersion),
  );
  const refundCount = db.select({ value: count() }).from(runs)
    .where(and(scope, isNotNull(runs.refundedAt)));
  // Explicit qualification keeps drizzle's single-table SELECT mapping from
  // turning the correlated runs.id into the attempt table's own id.
  const hasAttempt = sql<number>`exists (
    select 1 from official_attempts as attempt where attempt.run_id = runs.id
  )`;

  // D1 executes batch statements sequentially in one transaction. Claiming the
  // refund under the cap in the UPDATE prevents competing runs from taking the
  // last refund; a failed DELETE rolls back the stamp as well.
  const [claim] = await db.batch([
    db.update(runs).set({ refundedAt: now }).where(and(
      eq(runs.id, run.id),
      scope,
      isNull(runs.refundedAt),
      eq(runs.mode, "official"),
      notInArray(runs.status, ["succeeded", "cancelled"]),
      hasAttempt,
      sql`(${refundCount}) < ${REFUND_CAP}`,
    )),
    db.delete(officialAttempts).where(and(
      eq(officialAttempts.runId, run.id),
      // A stamped official run must have no attempt claim, including on retry.
      // Read that invariant directly rather than connection-local changes().
      exists(db.select({ id: runs.id }).from(runs).where(and(
        eq(runs.id, run.id),
        scope,
        eq(runs.mode, "official"),
        isNotNull(runs.refundedAt),
      ))),
    )),
  ]);
  if (claim.meta.changes === 1) return "refunded";

  const [persisted] = await db.select({
    refundedAt: runs.refundedAt,
    mode: runs.mode,
    status: runs.status,
    hasAttempt,
  }).from(runs).where(and(eq(runs.id, run.id), scope));
  // Callers may hold a pre-refund snapshot while another invocation succeeds.
  // Report that success instead of treating its stamp as the fifth prior refund.
  if (persisted?.refundedAt != null) return "refunded";
  if (!persisted || persisted.mode !== "official" ||
      persisted.status === "succeeded" || persisted.status === "cancelled" ||
      !persisted.hasAttempt) return "not_applicable";
  return "capped";
}
