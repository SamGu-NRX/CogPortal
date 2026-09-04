import type { Hono } from "hono";
import {
  LocalReportInputSchema,
  LocalReportListSchema,
  LocalReportSchema,
} from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { requireDevice } from "../auth/device";
import { requireTeam } from "../auth/session";
import { parseBody, respond } from "../http/respond";
import {
  getWeightUploadTarget,
  listTeamLocalReports,
  upsertLocalReport,
} from "../services/local-reports";
import { uploadWeight, validateWeightPath } from "../services/weights";

export function registerLocalReportRoutes(app: Hono<AppEnv>): void {
  app.post("/v1/local-reports", async (c) => {
    const device = await requireDevice(c);
    const body = await parseBody(c, LocalReportInputSchema);
    const result = await upsertLocalReport(c.env, device.userId, body);
    return respond(c, LocalReportSchema, result.report, result.created ? 201 : 200);
  });

  app.put("/v1/local-reports/:reportId/weights/*", async (c) => {
    const device = await requireDevice(c);
    const path = validateWeightPath(c.req.param("*") ?? "");
    const target = await getWeightUploadTarget(
      c.env,
      device.userId,
      c.req.param("reportId"),
      path,
    );
    const rawLength = c.req.header("Content-Length");
    const contentLength = rawLength == null ? null : Number(rawLength);
    const uploaded = await uploadWeight(
      c.env.ARTIFACTS,
      target.repositoryFullName,
      target.sha,
      path,
      c.req.raw.body,
      contentLength,
      c.req.header("X-Cogworks-Weight-SHA256") ?? null,
    );
    return c.json(uploaded, 201);
  });

  app.get("/v1/local-reports", async (c) => {
    const auth = await requireTeam(c);
    const reports = await listTeamLocalReports(c.env, auth.user.id, c.req.query("benchmark"));
    return respond(c, LocalReportListSchema, reports);
  });
}
