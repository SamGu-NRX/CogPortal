import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type LocalReportInput,
  LocalReportSchema,
  MetricSchema,
  type LocalReport,
} from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { localReports, teamMembers, teams, users } from "../db/schema";
import { ApiHttpError } from "../http/errors";

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

export async function upsertLocalReport(
  env: Env,
  userId: string,
  body: LocalReportInput,
): Promise<{ report: LocalReport; created: boolean }> {
  const db = getDb(env);
  const [existing] = await db
    .select({ userId: localReports.userId })
    .from(localReports)
    .where(eq(localReports.reportId, body.reportId))
    .limit(1);
  if (existing && existing.userId !== userId) {
    throw new ApiHttpError(409, "forbidden", "That report ID belongs to another account.");
  }
  const values = {
    reportId: body.reportId,
    userId,
    benchmarkId: body.benchmarkId,
    benchmarkVersion: body.benchmarkVersion,
    contractVersion: body.contractVersion,
    sdkVersion: body.sdkVersion,
    pluginVersion: body.pluginVersion,
    repositoryId: body.repositoryId,
    repositoryFullName: body.repositoryFullName,
    sha: body.sha,
    dirty: body.dirty,
    startedAt: body.startedAt,
    finishedAt: body.finishedAt,
    metricsJson: JSON.stringify(body.metrics),
    diagnosticsJson: JSON.stringify(body.diagnostics),
    syncedAt: Date.now(),
  };
  if (existing) {
    await db
      .update(localReports)
      .set(values)
      .where(and(eq(localReports.reportId, body.reportId), eq(localReports.userId, userId)));
  } else {
    try {
      await db.insert(localReports).values(values);
    } catch (error) {
      const [conflict] = await db
        .select({ reportId: localReports.reportId })
        .from(localReports)
        .where(eq(localReports.reportId, body.reportId))
        .limit(1);
      if (conflict) throw new ApiHttpError(409, "forbidden", "That report ID is already in use.");
      throw error;
    }
  }
  const report = await getLocalReport(env, body.reportId);
  if (!report) throw new ApiHttpError(500, "provider_unconfigured", "The report could not be saved.");
  return { report, created: !existing };
}
