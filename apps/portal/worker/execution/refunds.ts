import { and, count, eq, isNotNull, ne } from "drizzle-orm";
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

async function refundsAlreadyGiven(db: Database, run: RefundableRun): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(runs)
    .where(
      and(
        eq(runs.teamId, run.teamId),
        eq(runs.benchmarkId, run.benchmarkId),
        eq(runs.benchmarkVersion, run.benchmarkVersion),
        isNotNull(runs.refundedAt),
        // Exclude the run being decided. None of the three callers writes the
        // attempt delete and the run's terminal state in one transaction (D1
        // has no transaction on this path), so a retry can re-enter this
        // decision for a run that was already marked. Counting itself would
        // make the second pass read one refund higher than the first and
        // report a cap that is not there.
        ne(runs.id, run.id),
      ),
    );
  return row?.value ?? 0;
}

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
  if ((await refundsAlreadyGiven(db, run)) >= REFUND_CAP) return "capped";

  await db.delete(officialAttempts).where(eq(officialAttempts.runId, run.id));
  // Mark after the delete, never before. Marked-but-not-deleted would charge
  // the team a refund they did not receive. Deleted-but-not-marked is repaired
  // by the next poll or cron tick, which re-runs this whole decision.
  await db.update(runs).set({ refundedAt: now }).where(eq(runs.id, run.id));
  return "refunded";
}
