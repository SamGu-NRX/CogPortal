import { and, desc, eq, inArray } from "drizzle-orm";
import {
  LocalReportSchema,
  MetricSchema,
  type LocalReport,
} from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { localReports, teamMembers, teams, users } from "../db/schema";

function parseReportRow(row: {
  report: typeof localReports.$inferSelect;
  login: string;
  name: string | null;
}): LocalReport {
  return LocalReportSchema.parse({
    reportId: row.report.reportId,
    benchmarkId: row.report.benchmarkId,
    benchmarkVersion: row.report.benchmarkVersion,
    contractVersion: row.report.contractVersion,
    sdkVersion: row.report.sdkVersion,
    pluginVersion: row.report.pluginVersion,
    repositoryId: row.report.repositoryId,
    repositoryFullName: row.report.repositoryFullName,
    sha: row.report.sha,
    dirty: row.report.dirty,
    startedAt: row.report.startedAt,
    finishedAt: row.report.finishedAt,
    metrics: MetricSchema.array().parse(JSON.parse(row.report.metricsJson)),
    diagnostics: JSON.parse(row.report.diagnosticsJson),
    author: { login: row.login, name: row.name },
    syncedAt: row.report.syncedAt,
    trust: "local_self_reported",
  });
}

export async function listTeamLocalReports(
  env: Env,
  userId: string,
  benchmarkId?: string,
): Promise<LocalReport[]> {
  const db = getDb(env);
  const [membership] = await db
    .select({ teamId: teamMembers.teamId, repoFullName: teams.repoFullName })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .limit(1);
  if (!membership) return [];

  const members = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, membership.teamId));
  if (members.length === 0) return [];
  const predicates = [
    inArray(localReports.userId, members.map((member) => member.userId)),
    eq(localReports.repositoryFullName, membership.repoFullName),
  ];
  if (benchmarkId) predicates.push(eq(localReports.benchmarkId, benchmarkId));
  const rows = await db
    .select({ report: localReports, login: users.githubLogin, name: users.name })
    .from(localReports)
    .innerJoin(users, eq(localReports.userId, users.id))
    .where(and(...predicates))
    .orderBy(desc(localReports.syncedAt))
    .limit(50);
  return rows.map(parseReportRow);
}

export async function getLocalReport(env: Env, reportId: string): Promise<LocalReport | null> {
  const [row] = await getDb(env)
    .select({ report: localReports, login: users.githubLogin, name: users.name })
    .from(localReports)
    .innerJoin(users, eq(localReports.userId, users.id))
    .where(eq(localReports.reportId, reportId))
    .limit(1);
  return row ? parseReportRow(row) : null;
}
