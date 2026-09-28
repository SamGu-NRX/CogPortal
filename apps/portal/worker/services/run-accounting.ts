import { and, eq, exists, getTableColumns, inArray, isNotNull, isNull, or, sql, SQL } from "drizzle-orm";
import { OFFICIAL_LIMIT, PRACTICE_LIMIT, RUN_PHASES } from "@cogworks/contracts/schema";
import type { Database } from "../db/client";
import { officialAttempts, runs } from "../db/schema";

type BenchmarkScope = { teamId: string; benchmarkId: string; benchmarkVersion: number };
type AccountingScope = BenchmarkScope | { teamId: string; allBenchmarks: true };

// A completed evaluation counts regardless of its score. Historical refunded
// successes remain excluded; failed and cancelled executions never use quota.
export function acceptedRunPredicate() {
  return and(eq(runs.status, "succeeded"), isNull(runs.refundedAt))!;
}

export function activeRunPredicate() {
  return inArray(runs.status, [...RUN_PHASES]);
}

function scopePredicate(scope: AccountingScope) {
  return and(
    eq(runs.teamId, scope.teamId),
    "allBenchmarks" in scope ? undefined : and(
      eq(runs.benchmarkId, scope.benchmarkId),
      eq(runs.benchmarkVersion, scope.benchmarkVersion),
    ),
  )!;
}

export async function readRunAccounting(db: Database, scope: AccountingScope) {
  const countWhen = (mode: "practice" | "official", reserved: boolean) =>
    sql<number>`count(case when ${and(eq(runs.mode, mode), reserved ? activeRunPredicate() : acceptedRunPredicate())} then 1 end)`.mapWith(Number);
  const [counts] = await db.select({
    practiceUsed: countWhen("practice", false),
    officialUsed: countWhen("official", false),
    practiceReserved: countWhen("practice", true),
    officialReserved: countWhen("official", true),
  }).from(runs).where(scopePredicate(scope));
  // The active-run index spans versions, while each version has its own quota.
  const [active] = await db.select({ value: sql<number>`count(*)`.mapWith(Number) })
    .from(runs).where(and(
      eq(runs.teamId, scope.teamId),
      "allBenchmarks" in scope ? undefined : eq(runs.benchmarkId, scope.benchmarkId),
      activeRunPredicate(),
    ));
  return { ...counts!, activeRuns: active!.value };
}

/** Admission is checked by the INSERT itself, not by a preceding read. A run
 * completing between requests therefore cannot let a stale quota check win. */
export function insertRunWithCapacity(db: Database, value: typeof runs.$inferInsert) {
  const scope = { teamId: value.teamId, benchmarkId: value.benchmarkId, benchmarkVersion: value.benchmarkVersion };
  const columns = getTableColumns(runs);
  // Drizzle's INSERT SELECT uses every table column in declaration order.
  // Supply column defaults explicitly and retain each column's value encoder.
  const values = sql.join(Object.entries(columns).map(([key, column]) => {
    // Number the next completed evaluation, independent of historical claim
    // holes. Compute inside the guarded INSERT so a concurrent completion is seen.
    if (key === "attemptNumber" && value.mode === "official") {
      return sql`(select count(*) + 1 from ${runs} where ${and(
        scopePredicate(scope), eq(runs.mode, "official"), acceptedRunPredicate(),
      )})`;
    }
    const supplied = value[key as keyof typeof value];
    const field = supplied === undefined ? column.default ?? null : supplied;
    return field instanceof SQL ? field : sql.param(field, column);
  }), sql`, `);
  const occupied = sql`(select count(*) from ${runs} where ${and(
    scopePredicate(scope), eq(runs.mode, value.mode), or(acceptedRunPredicate(), activeRunPredicate()),
  )})`;
  const limit = value.mode === "practice" ? PRACTICE_LIMIT : OFFICIAL_LIMIT;
  return db.insert(runs).select(sql`select ${values} where ${occupied} < ${limit}`);
}

function claimScopePredicate(scope: BenchmarkScope) {
  return and(
    eq(officialAttempts.teamId, scope.teamId),
    eq(officialAttempts.benchmarkId, scope.benchmarkId),
    eq(officialAttempts.benchmarkVersion, scope.benchmarkVersion),
  )!;
}

// Old failures may retain claims. Remove only this quota scope's excluded
// executions, in the same transaction that admits the next run.
export function releaseExcludedOfficialClaims(db: Database, scope: BenchmarkScope) {
  return db.delete(officialAttempts).where(and(
    claimScopePredicate(scope),
    exists(db.select({ value: sql`1` }).from(runs).where(and(
      scopePredicate(scope), eq(runs.id, officialAttempts.runId),
      or(inArray(runs.status, ["failed", "cancelled"]), isNotNull(runs.refundedAt)),
    ))),
  ));
}

// Compatibility slots are internal. A historical success in slot 3 must not
// force the next run's visible attempt number, or its claim slot, above 3.
export function nextOfficialClaimSlot(scope: BenchmarkScope) {
  const slots = sql.join(Array.from({ length: OFFICIAL_LIMIT }, (_, index) =>
    sql`select ${index + 1} as slot`), sql` union all `);
  return sql`(select min(slot) from (${slots}) where not exists (
    select 1 from ${officialAttempts} where ${claimScopePredicate(scope)}
      and ${officialAttempts.attemptNumber} = slot
  ))`;
}
