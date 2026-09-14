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
import { runs, teams } from "../db/schema";
import { syncRun, syncTeamRuns } from "../execution/sync";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { serializeRunDetail, serializeRunSummary } from "../http/serializers";
import { actorFromAuth, promotePracticeRun, startPracticeRun } from "../services/run-actions";
import { verifyRunnerSignature } from "./runner-events";
import { MAX_WEIGHT_BYTES, validateWeightPath, weightObjectKey } from "../services/weights";

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
    const summaries = await Promise.all(rows.map((run) => serializeRunSummary(db, run)));
    return respond(c, z.array(RunSummarySchema), summaries);
  });

  app.get("/v1/runs/:id/weights/*", async (c) => {
    // Weight URLs are minted before preparation starts, so they use the same
    // 900-second window as the prepare timeout in execution/runner.ts.
    await verifyRunnerSignature(c, new URL(c.req.url).pathname, 900);
    const path = validateWeightPath(c.req.param("*") ?? "");
    const [record] = await getDb(c.env)
      .select({ run: runs, repositoryFullName: teams.repoFullName })
      .from(runs)
      .innerJoin(teams, eq(runs.teamId, teams.id))
      .where(eq(runs.id, c.req.param("id")))
      .limit(1);
    if (!record) throw new ApiHttpError(404, "not_found", "Run not found.");
    if (!c.env.ARTIFACTS) throw new ApiHttpError(404, "not_found", "Weight file not found.");
    const object = await c.env.ARTIFACTS.get(
      weightObjectKey(record.repositoryFullName, record.run.sha, path),
    );
    if (!object) throw new ApiHttpError(404, "not_found", "Weight file not found.");
    if (object.size > MAX_WEIGHT_BYTES) {
      throw new ApiHttpError(413, "invalid_request", "Weight files may not exceed 100 MiB.");
    }
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
