import type { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  RunDetailSchema,
  RunSummarySchema,
  StartPracticeRequestSchema,
  StartRunResponseSchema,
} from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import { runs } from "../db/schema";
import { syncRun, syncTeamRuns } from "../execution/sync";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { buildRunSummary, readPrimaryMetrics, serializeRunDetail } from "../http/serializers";
import { actorFromAuth, promotePracticeRun, startPracticeRun } from "../services/run-actions";
import { verifyRunnerSignature } from "./runner-events";
import { readRecordedWeight, weightPathFromRoute } from "../services/weights";
import { recordedDispatchJob } from "../execution/runner";

export function registerRunRoutes(app: Hono<AppEnv>): void {
  app.post("/runs/practice", async (c) => {
    const auth = await requireTeam(c);
    const body = await parseBody(c, StartPracticeRequestSchema);
    const result = await startPracticeRun(c.env, actorFromAuth(auth), {
      benchmarkId: body.benchmarkId,
      branch: body.branch,
    });
    return respond(c, StartRunResponseSchema, { runId: result.runId }, 201);
  });

  app.post("/runs/:id/promote", async (c) => {
    const auth = await requireTeam(c);
    const result = await promotePracticeRun(c.env, actorFromAuth(auth), c.req.param("id"));
    return respond(c, StartRunResponseSchema, { runId: result.runId }, 201);
  });

  app.get("/runs", async (c) => {
    const auth = await requireTeam(c);
    const benchmarkId = c.req.query("benchmark");
    const db = getDb(c.env);
    await syncTeamRuns(db, auth.team.id, benchmarkId);
    const rows = await db
      .select()
      .from(runs)
      .where(
        benchmarkId
          ? and(eq(runs.teamId, auth.team.id), eq(runs.benchmarkId, benchmarkId))
          : eq(runs.teamId, auth.team.id),
      )
      .orderBy(desc(runs.createdAt));
    const primaries = await readPrimaryMetrics(db, rows.map((run) => run.id));
    const summaries = rows.map((run) => buildRunSummary(run, primaries.get(run.id) ?? null));
    return respond(c, z.array(RunSummarySchema), summaries);
  });

  app.get("/v1/runs/:id/weights/*", async (c) => {
    // Weight URLs are minted before preparation starts, so they use the same
    // 900-second window as the prepare timeout in execution/runner.ts.
    await verifyRunnerSignature(c, new URL(c.req.url).pathname, 900);
    const path = weightPathFromRoute(c.req.routePath, c.req.url);
    const [run] = await getDb(c.env)
      .select()
      .from(runs)
      .where(eq(runs.id, c.req.param("id")))
      .limit(1);
    if (!run) throw new ApiHttpError(404, "not_found", "Run not found.");
    // Everything this request serves comes from the inputs the run was
    // dispatched with. Reading the team's current repository name instead
    // would let a rename or a reconnect point an already-signed URL at a
    // different repository's bytes.
    const job = recordedDispatchJob(run);
    const declared = (job.weights ?? []).filter((weight) => weight.path === path);
    if (declared.length > 1) {
      throw new ApiHttpError(409, "invalid_request", "This run recorded that weight path more than once.");
    }
    if (!declared[0]) throw new ApiHttpError(404, "not_found", "Weight file not found.");
    if (!c.env.ARTIFACTS) throw new ApiHttpError(404, "not_found", "Weight file not found.");
    const object = await readRecordedWeight(
      c.env.ARTIFACTS,
      job.source.fullName,
      job.source.sha,
      declared[0],
    );
    const headers = new Headers({ "Content-Length": String(object.size) });
    object.writeHttpMetadata(headers);
    return new Response(object.body, { headers });
  });

  app.get("/runs/:id", async (c) => {
    const auth = await requireTeam(c);
    const db = getDb(c.env);
    const [row] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, c.req.param("id")), eq(runs.teamId, auth.team.id)))
      .limit(1);
    if (!row) throw new ApiHttpError(404, "not_found", "Run not found.");
    const run = await syncRun(db, row);
    return respond(c, RunDetailSchema, await serializeRunDetail(db, run, auth.team));
  });
}
