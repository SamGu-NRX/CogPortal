import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import {
  LocalReportInputSchema,
  LocalReportListSchema,
  LocalReportSchema,
} from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { requireDevice } from "../auth/device";
import { requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import { localReports } from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { getLocalReport, listTeamLocalReports } from "../services/local-reports";

export function registerLocalReportRoutes(app: Hono<AppEnv>): void {
  app.post("/v1/local-reports", async (c) => {
    const device = await requireDevice(c);
    const body = await parseBody(c, LocalReportInputSchema);
    const db = getDb(c.env);
    const [existing] = await db
      .select({ userId: localReports.userId })
      .from(localReports)
      .where(eq(localReports.reportId, body.reportId))
      .limit(1);
    if (existing && existing.userId !== device.userId) {
      throw new ApiHttpError(409, "forbidden", "That report ID belongs to another account.");
    }
    const values = {
      reportId: body.reportId,
      userId: device.userId,
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
        .set({
          benchmarkId: values.benchmarkId,
          benchmarkVersion: values.benchmarkVersion,
          contractVersion: values.contractVersion,
          sdkVersion: values.sdkVersion,
          pluginVersion: values.pluginVersion,
          repositoryId: values.repositoryId,
          repositoryFullName: values.repositoryFullName,
          sha: values.sha,
          dirty: values.dirty,
          startedAt: values.startedAt,
          finishedAt: values.finishedAt,
          metricsJson: values.metricsJson,
          diagnosticsJson: values.diagnosticsJson,
          syncedAt: values.syncedAt,
        })
        .where(
          and(
            eq(localReports.reportId, body.reportId),
            eq(localReports.userId, device.userId),
          ),
        );
    } else {
      try {
        await db.insert(localReports).values(values);
      } catch (error) {
        const [conflict] = await db
          .select({ reportId: localReports.reportId })
          .from(localReports)
          .where(eq(localReports.reportId, body.reportId))
          .limit(1);
        // A concurrent insert must never turn into a cross-account overwrite.
        if (conflict) {
          throw new ApiHttpError(409, "forbidden", "That report ID is already in use.");
        }
        throw error;
      }
    }
    const report = await getLocalReport(c.env, body.reportId);
    if (!report) throw new ApiHttpError(500, "provider_unconfigured", "The report could not be saved.");
    return respond(c, LocalReportSchema, report, existing ? 200 : 201);
  });

  app.get("/v1/local-reports", async (c) => {
    const auth = await requireTeam(c);
    const reports = await listTeamLocalReports(c.env, auth.user.id, c.req.query("benchmark"));
    return respond(c, LocalReportListSchema, reports);
  });
}
