import { and, eq, exists, getTableColumns, inArray, isNull, or, sql, SQL } from "drizzle-orm";
import { OFFICIAL_LIMIT, PRACTICE_LIMIT, RUN_PHASES } from "@cogworks/contracts/schema";
import type { Database } from "../db/client";
import { runs, teamMembers, teams } from "../db/schema";

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

function countWhen(mode: "practice" | "official", reserved: boolean) {
  return sql<number>`count(case when ${and(eq(runs.mode, mode), reserved ? activeRunPredicate() : acceptedRunPredicate())} then 1 end)`.mapWith(Number);
}

export async function readRunAccounting(db: Database, scope: AccountingScope) {
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

/**
 * Accepted practice and official evaluations across every benchmark, for each
 * team `teamWhere` selects, in one statement. The admin console lists every
 * team at once, and readRunAccounting per team cost two statements each.
 * A team with no runs is absent from the map.
 *
 * The teams go in as a subquery rather than a join because runs has no
 * team_id index: joined, SQLite rescanned runs once per selected team for a
 * TA's scope, and as a subquery it reads runs once for any scope.
 */
export async function readUsedRunsByTeam(db: Database, teamWhere: SQL) {
  const rows = await db.select({
    teamId: runs.teamId,
    practiceUsed: countWhen("practice", false),
    officialUsed: countWhen("official", false),
  }).from(runs)
    .where(inArray(runs.teamId, db.select({ id: teams.id }).from(teams).where(teamWhere)))
    .groupBy(runs.teamId);
  return new Map(rows.map((row) => [row.teamId, row]));
}

/** Admission is checked by the INSERT itself, not by a preceding read. A run
 * completing between requests therefore cannot let a stale quota check win,
 * and a person who left the team between the request's own reads and this
 * write cannot start a run on it: the actor must be a member when it runs.
 * Zero changes means one of the two failed; isAdmittingMember tells which. */
export function insertRunWithCapacity(db: Database, value: typeof runs.$inferInsert, actorUserId: string) {
  const scope = { teamId: value.teamId, benchmarkId: value.benchmarkId, benchmarkVersion: value.benchmarkVersion };
  const columns = getTableColumns(runs);
  // Drizzle's INSERT SELECT uses every table column in declaration order.
  // Supply column defaults explicitly and retain each column's value encoder.
  const values = sql.join(Object.entries(columns).map(([key, column]) => {
    // Number by accepted evaluations inside the guarded INSERT so a concurrent
    // completion is seen, regardless of failed or refunded history.
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
  return db.insert(runs).select(sql`select ${values} where ${occupied} < ${limit} and ${actorOnTeam(db, value.teamId, actorUserId)}`);
}

/** Whether the actor is on the team when the statement it guards runs. */
export function actorOnTeam(db: Database, teamId: string, userId: string) {
  return exists(db.select({ userId: teamMembers.userId }).from(teamMembers).where(and(
    eq(teamMembers.teamId, teamId),
    eq(teamMembers.userId, userId),
  )));
}

/** After an admission that changed nothing: whether the actor is still on
 *  the team, so a departure is not reported as a used-up quota. */
export async function isAdmittingMember(db: Database, teamId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ userId: teamMembers.userId }).from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).limit(1);
  return Boolean(row);
}
