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
): Promise<
  { teamId: string; repoFullName: string; repoId: number | null; memberUserIds: string[] } | null
> {
  const [membership] = await getDb(env)
    .select({ teamId: teamMembers.teamId, repoFullName: teams.repoFullName, repoId: teams.repoId })
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

/**
 * Where an upload is allowed to land, decided before any bytes are written.
 *
 * The stored object is named by its digest, so admission has to agree with the
 * report about which digest belongs at which path. A report whose upload list
 * is unknown, from a CLI too old to send one, cannot supply that agreement, and
 * the header alone is not a substitute: it would let any digest name any key.
 * Syncing again is the way out, and the CLI already publishes the list before
 * it uploads a single file.
 */
export async function getWeightUploadTarget(
  env: Env,
  userId: string,
  reportId: string,
  path: string,
  sha256: string,
): Promise<{ repositoryFullName: string; sha: string }> {
  const scope = await getUserTeamReportScope(env, userId);
  if (!scope) throw new ApiHttpError(403, "forbidden", "The uploader does not belong to a team.");
  const [report] = await getDb(env)
    .select({
      userId: localReports.userId,
      repositoryId: localReports.repositoryId,
      repositoryFullName: localReports.repositoryFullName,
      sha: localReports.sha,
      weightsUsedJson: localReports.weightsUsedJson,
      weightsUploadedJson: localReports.weightsUploadedJson,
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
  // Only when both sides know an ID. The CLI's complete pin still reports
  // none, so this stays inert rather than becoming a second association.
  if (report.repositoryId != null && scope.repoId != null && report.repositoryId !== scope.repoId) {
    throw new ApiHttpError(403, "forbidden", "That report names a different repository than the uploader's team.");
  }
  const provenance = LocalReportWeightsSchema.safeParse({
    weightsUsed: JSON.parse(report.weightsUsedJson),
    weightsUploaded: report.weightsUploadedJson == null
      ? null
      : JSON.parse(report.weightsUploadedJson),
  });
  if (!provenance.success) {
    throw new ApiHttpError(409, "invalid_request", "That report has invalid weight provenance; sync the report again.");
  }
  const declared = provenance.data.weightsUploaded;
  if (declared == null) {
    throw new ApiHttpError(409, "invalid_request", "This report doesn't identify its uploaded weights; update the CLI and sync the report again.");
  }
  const required = declared.find((weight) => weight.path === path);
  if (!required) {
    throw new ApiHttpError(400, "invalid_request", "That report does not require an upload for that weight path.");
  }
  if (required.sha256 !== sha256) {
    throw new ApiHttpError(409, "invalid_request", "That report declares a different digest for that weight; sync the report again.");
  }
  if (!report.sha) {
    throw new ApiHttpError(400, "invalid_request", "The report has no repository revision for this weight.");
  }
  return { repositoryFullName: report.repositoryFullName, sha: report.sha };
}

/**
 * The weight provenance a dispatch should use: the newest report a team member
 * synced for this repository and revision.
 *
 * `repositoryId` is checked after selection, not added to the filter. Filtering
 * on it would drop a conflicting newest report and quietly dispatch an older
 * one's weights, which is the opposite of noticing the conflict.
 */
export async function getLatestTeamWeights(
  env: Env,
  teamId: string,
  repositoryFullName: string,
  sha: string,
  repositoryId: number | null = null,
): Promise<Pick<LocalReportInput, "weightsUsed" | "weightsUploaded">> {
  const memberUserIds = await teamMemberUserIds(env, teamId);
  if (memberUserIds.length === 0) return { weightsUsed: [], weightsUploaded: null };
  const [report] = await getDb(env)
    .select({
      repositoryId: localReports.repositoryId,
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
  if (repositoryId != null && report.repositoryId != null && report.repositoryId !== repositoryId) {
    throw new ApiHttpError(409, "invalid_request", "The newest synced report names a different repository than this execution; sync the report again.");
  }
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
