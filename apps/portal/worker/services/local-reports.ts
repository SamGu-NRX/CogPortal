import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type LocalReportInput,
  LocalReportSchema,
  LocalReportWeightsSchema,
  MetricSchema,
  type LocalReport,
} from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { benchmarks, localReports, teamMembers, teams, users } from "../db/schema";
import { ApiHttpError } from "../http/errors";

function parseReportRow(row: {
  report: typeof localReports.$inferSelect;
  login: string | null;
  email: string;
  name: string;
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
    weightsUsed: JSON.parse(row.report.weightsUsedJson),
    weightsUploaded: row.report.weightsUploadedJson == null
      ? null
      : JSON.parse(row.report.weightsUploadedJson),
    author: { login: row.login ?? row.email.split("@")[0], name: row.name },
    syncedAt: row.report.syncedAt,
    trust: "local_self_reported",
  });
}

export async function teamMemberUserIds(env: Env, teamId: string): Promise<string[]> {
  const members = await getDb(env)
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return members.map((member) => member.userId);
}

async function getUserTeamReportScope(
  env: Env,
  userId: string,
): Promise<{ teamId: string; repoFullName: string; memberUserIds: string[] } | null> {
  const [membership] = await getDb(env)
    .select({ teamId: teamMembers.teamId, repoFullName: teams.repoFullName })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .limit(1);
  if (!membership) return null;
  return {
    ...membership,
    memberUserIds: await teamMemberUserIds(env, membership.teamId),
  };
}

export async function listTeamLocalReports(
  env: Env,
  userId: string,
  benchmarkId?: string,
): Promise<LocalReport[]> {
  const db = getDb(env);
  const scope = await getUserTeamReportScope(env, userId);
  if (!scope || scope.memberUserIds.length === 0) return [];
  const predicates = [
    inArray(localReports.userId, scope.memberUserIds),
    eq(localReports.repositoryFullName, scope.repoFullName),
  ];
  if (benchmarkId) {
    // A benchmark bump keeps the id and raises the version, so an id-only
    // filter mixed pre-bump reports into the current list. Pin the list to
    // the active version, resolved the same way the dashboard route does.
    const [active] = await db
      .select({ version: benchmarks.version })
      .from(benchmarks)
      .where(and(eq(benchmarks.id, benchmarkId), eq(benchmarks.active, true)))
      .orderBy(desc(benchmarks.version))
      .limit(1);
    if (!active) return [];
    predicates.push(
      eq(localReports.benchmarkId, benchmarkId),
      eq(localReports.benchmarkVersion, active.version),
    );
  }
  const rows = await db
    .select({ report: localReports, login: users.githubLogin, email: users.email, name: users.name })
    .from(localReports)
    .innerJoin(users, eq(localReports.userId, users.id))
    .where(and(...predicates))
    .orderBy(desc(localReports.syncedAt))
    .limit(50);
  return rows.map(parseReportRow);
}

export async function getLocalReport(env: Env, reportId: string): Promise<LocalReport | null> {
  const [row] = await getDb(env)
    .select({ report: localReports, login: users.githubLogin, email: users.email, name: users.name })
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
  const provenance = LocalReportWeightsSchema.safeParse(body);
  if (!provenance.success) {
    throw new ApiHttpError(400, "invalid_request", "weightsUploaded must name paths from weightsUsed with SHA-256 digests, or be null.");
  }
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
    weightsUsedJson: JSON.stringify(body.weightsUsed),
    weightsUploadedJson: body.weightsUploaded == null ? null : JSON.stringify(body.weightsUploaded),
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

export async function getWeightUploadTarget(
  env: Env,
  userId: string,
  reportId: string,
  path: string,
): Promise<{ repositoryFullName: string; sha: string }> {
  const scope = await getUserTeamReportScope(env, userId);
  if (!scope) throw new ApiHttpError(403, "forbidden", "The uploader does not belong to a team.");
  const [report] = await getDb(env)
    .select({
      userId: localReports.userId,
      repositoryFullName: localReports.repositoryFullName,
      sha: localReports.sha,
      weightsUsedJson: localReports.weightsUsedJson,
    })
    .from(localReports)
    .where(eq(localReports.reportId, reportId))
    .limit(1);
  if (!report) throw new ApiHttpError(404, "not_found", "Local report not found.");
  if (report.userId !== userId) {
    throw new ApiHttpError(403, "forbidden", "That report belongs to another account.");
  }
  if (report.repositoryFullName !== scope.repoFullName) {
    throw new ApiHttpError(403, "forbidden", "That report does not belong to the uploader's team repository.");
  }
  const weights = JSON.parse(report.weightsUsedJson) as unknown;
  if (!Array.isArray(weights) || !weights.includes(path)) {
    throw new ApiHttpError(400, "invalid_request", "That weight path is not part of this report.");
  }
  if (!report.sha) {
    throw new ApiHttpError(400, "invalid_request", "The report has no repository revision for this weight.");
  }
  return { repositoryFullName: report.repositoryFullName, sha: report.sha };
}

export async function getLatestTeamWeights(
  env: Env,
  teamId: string,
  repositoryFullName: string,
  sha: string,
): Promise<Pick<LocalReportInput, "weightsUsed" | "weightsUploaded">> {
  const memberUserIds = await teamMemberUserIds(env, teamId);
  if (memberUserIds.length === 0) return { weightsUsed: [], weightsUploaded: null };
  const [report] = await getDb(env)
    .select({
      weightsUsedJson: localReports.weightsUsedJson,
      weightsUploadedJson: localReports.weightsUploadedJson,
    })
    .from(localReports)
    .where(
      and(
        inArray(localReports.userId, memberUserIds),
        eq(localReports.repositoryFullName, repositoryFullName),
        eq(localReports.sha, sha),
      ),
    )
    .orderBy(desc(localReports.syncedAt))
    .limit(1);
  if (!report) return { weightsUsed: [], weightsUploaded: null };
  const weights = LocalReportWeightsSchema.safeParse({
    weightsUsed: JSON.parse(report.weightsUsedJson),
    weightsUploaded: report.weightsUploadedJson == null
      ? null
      : JSON.parse(report.weightsUploadedJson),
  });
  if (!weights.success) {
    throw new ApiHttpError(409, "invalid_request", "The newest synced report has invalid weight provenance; sync the report again.");
  }
  return weights.data;
}
