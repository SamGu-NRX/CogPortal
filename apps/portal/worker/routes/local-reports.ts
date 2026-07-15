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
import { listTeamLocalReports, upsertLocalReport } from "../services/local-reports";

export function registerLocalReportRoutes(app: Hono<AppEnv>): void {
  app.post("/v1/local-reports", async (c) => {
    const device = await requireDevice(c);
    const body = await parseBody(c, LocalReportInputSchema);
    const result = await upsertLocalReport(c.env, device.userId, body);
    return respond(c, LocalReportSchema, result.report, result.created ? 201 : 200);
  });

  app.get("/v1/local-reports", async (c) => {
    const auth = await requireTeam(c);
    const reports = await listTeamLocalReports(c.env, auth.user.id, c.req.query("benchmark"));
    return respond(c, LocalReportListSchema, reports);
  });
}
