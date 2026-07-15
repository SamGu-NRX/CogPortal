import type { Context, Hono } from "hono";
import { and, eq, lt } from "drizzle-orm";
import {
  LocalRunEventResponseSchema,
  LocalRunEventBatchResponseSchema,
  LocalRunEventBatchSchema,
  LocalRunEventSchema,
  StartLocalRunRequestSchema,
  StartLocalRunResponseSchema,
  type LocalRunPhase,
  type LocalRunEvent,
  type RunStreamEventCode,
} from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { requireDevice } from "../auth/device";
import { getDb } from "../db/client";
import {
  benchmarks,
  localRunSessions,
  runSurfaces,
  teamMembers,
  teams,
} from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { upsertLocalReport } from "../services/local-reports";
import { syncRunSurfaceMessage } from "../services/discord-messages";
import {
  appendRunStreamEvent,
  defaultLocalEventCode,
  publishRunSurface,
} from "../services/run-surfaces";

function sharedFailureCode(code: RunStreamEventCode | undefined): RunStreamEventCode {
  return code?.startsWith("run.failed.") ? code : "run.failed.runtime";
}

const LOCAL_PROGRESS_CODES = new Set<RunStreamEventCode>([
  "repository.ready",
  "repository.fetching",
  "dependencies.installing",
  "contract.checking",
  "contract.passed",
  "evaluation.started",
  "evaluation.progress",
  "scoring.started",
]);

function sharedProgressCode(
  code: RunStreamEventCode | undefined,
  phase: LocalRunPhase,
): RunStreamEventCode {
  return code && LOCAL_PROGRESS_CODES.has(code) ? code : defaultLocalEventCode(phase);
}

async function discordState(env: AppEnv["Bindings"], surfaceId: string) {
  const [surface] = await getDb(env)
    .select({ channelId: runSurfaces.discordChannelId, messageId: runSurfaces.discordMessageId })
    .from(runSurfaces)
    .where(eq(runSurfaces.id, surfaceId))
    .limit(1);
  if (!surface?.channelId) return "not_published" as const;
  return surface.messageId ? ("updated" as const) : ("unavailable" as const);
}

async function acceptLocalRunEvent(
  env: AppEnv["Bindings"],
  device: { deviceId: string; userId: string },
  sessionId: string,
  event: LocalRunEvent,
): Promise<{ duplicate: boolean; surfaceId: string }> {
  const db = getDb(env);
  const [current] = await db
    .select()
    .from(localRunSessions)
    .where(
      and(
        eq(localRunSessions.id, sessionId),
        eq(localRunSessions.deviceId, device.deviceId),
        eq(localRunSessions.userId, device.userId),
      ),
    )
    .limit(1);
  if (!current) throw new ApiHttpError(404, "not_found", "Local run session not found.");
  const surfaceId = current.surfaceId ?? `surface_${current.id.slice(-20)}`;
  if (current.status !== "running" || event.sequence <= current.lastEventSequence) {
    return { duplicate: true, surfaceId };
  }

  const receivedAt = Date.now();
  const elapsedMs =
    "elapsedMs" in event && event.elapsedMs != null
      ? event.elapsedMs
      : Math.max(0, event.occurredAt - current.createdAt);
  let phase: LocalRunPhase = current.phase as LocalRunPhase;
  let code: RunStreamEventCode;
  let nextValues: Partial<typeof localRunSessions.$inferInsert>;
  if (event.type === "progress") {
    const phaseOrder: LocalRunPhase[] = ["preparing", "contract_check", "evaluating", "scoring"];
    if (phaseOrder.indexOf(event.phase) < phaseOrder.indexOf(current.phase as LocalRunPhase)) {
      return { duplicate: true, surfaceId };
    }
    phase = event.phase;
    code = sharedProgressCode(event.code, event.phase);
    nextValues = { phase, lastEventSequence: event.sequence, updatedAt: receivedAt };
  } else if (event.type === "completed") {
    const report = event.report;
    if (
      report.benchmarkId !== current.benchmarkId ||
      report.benchmarkVersion !== current.benchmarkVersion ||
      report.repositoryFullName?.toLowerCase() !== current.repositoryFullName.toLowerCase() ||
      report.sha !== current.sha
    ) {
      throw new ApiHttpError(409, "invalid_request", "The completed report does not match this live run.");
    }
    await upsertLocalReport(env, device.userId, report);
    phase = "scoring";
    code = "run.completed";
    nextValues = {
      status: "succeeded",
      phase,
      reportId: report.reportId,
      lastEventSequence: event.sequence,
      updatedAt: receivedAt,
      finishedAt: receivedAt,
    };
  } else {
    phase = event.phase;
    code = sharedFailureCode(event.code);
    nextValues = {
      status: "failed",
      phase,
      failureDetail: code,
      lastEventSequence: event.sequence,
      updatedAt: receivedAt,
      finishedAt: receivedAt,
    };
  }
  const updated = await db
    .update(localRunSessions)
    .set(nextValues)
    .where(
      and(
        eq(localRunSessions.id, current.id),
        eq(localRunSessions.status, "running"),
        lt(localRunSessions.lastEventSequence, event.sequence),
      ),
    );
  const duplicate = (updated.meta.changes ?? 0) === 0;
  if (!duplicate) {
    await appendRunStreamEvent(
      env,
      surfaceId,
      {
        eventId: event.eventId,
        source: "local",
        sourceRunId: current.id,
        sourceSequence: event.sequence,
        phase,
        code,
        occurredAt: event.occurredAt,
        elapsedMs,
        progress: event.type === "progress" ? (event.progress ?? null) : null,
      },
      { publish: false },
    );
  }
  return { duplicate, surfaceId };
}

function publishSurfaceInBackground(
  c: Context<AppEnv>,
  surfaceId: string,
  localRunId: string,
): void {
  c.executionCtx.waitUntil(
    publishRunSurface(c.env, surfaceId).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "run_surface_publish_failed",
          localRunId,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }),
  );
}

export function registerLocalRunRoutes(app: Hono<AppEnv>): void {
  app.post("/v1/local-runs", async (c) => {
    const device = await requireDevice(c);
    const body = await parseBody(c, StartLocalRunRequestSchema);
    const db = getDb(c.env);
    const [[membership], [benchmark]] = await Promise.all([
      db
        .select({ team: teams })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(eq(teamMembers.userId, device.userId))
        .limit(1),
      db
        .select()
        .from(benchmarks)
        .where(
          and(
            eq(benchmarks.id, body.benchmarkId),
            eq(benchmarks.version, body.benchmarkVersion),
            eq(benchmarks.active, true),
          ),
        )
        .limit(1),
    ]);
    if (!membership) {
      throw new ApiHttpError(
        403,
        "no_team",
        "Finish joining a team and connecting its repository first.",
      );
    }
    if (!benchmark) {
      throw new ApiHttpError(409, "invalid_request", "That benchmark version is not active.");
    }
    if (body.repositoryFullName.toLowerCase() !== membership.team.repoFullName.toLowerCase()) {
      throw new ApiHttpError(
        409,
        "forbidden",
        `This device is running ${body.repositoryFullName}, but your team is connected to ${membership.team.repoFullName}.`,
      );
    }

    const now = Date.now();
    const sessionId = body.clientRunId;
    const surfaceId = `surface_${sessionId.slice(-20)}`;
    const [existing] = await db
      .select()
      .from(localRunSessions)
      .where(eq(localRunSessions.id, sessionId))
      .limit(1);
    if (existing) {
      if (
        existing.deviceId !== device.deviceId ||
        existing.userId !== device.userId ||
        existing.benchmarkId !== body.benchmarkId ||
        existing.benchmarkVersion !== body.benchmarkVersion ||
        existing.repositoryId !== body.repositoryId ||
        existing.repositoryFullName.toLowerCase() !== body.repositoryFullName.toLowerCase() ||
        existing.sha !== body.sha ||
        existing.branch !== (body.branch ?? null) ||
        existing.dirty !== body.dirty
      ) {
        throw new ApiHttpError(409, "invalid_request", "That local run ID is already in use.");
      }
      return respond(c, StartLocalRunResponseSchema, {
        sessionId,
        surfaceId: existing.surfaceId ?? surfaceId,
        discord:
          (await discordState(c.env, existing.surfaceId ?? surfaceId)) === "updated"
            ? "published"
            : existing.discordChannelId
              ? "unavailable"
              : "channel_unbound",
      });
    }
    await db.insert(runSurfaces).values({
      id: surfaceId,
      teamId: membership.team.id,
      createdByUserId: device.userId,
      benchmarkId: body.benchmarkId,
      benchmarkVersion: body.benchmarkVersion,
      localRunId: sessionId,
      supersedesSurfaceId: null,
      discordChannelId: membership.team.discordChannelId,
      discordMessageId: null,
      discordNonceGeneration: 0,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    const [surface] = await db
      .select()
      .from(runSurfaces)
      .where(eq(runSurfaces.id, surfaceId))
      .limit(1);
    if (
      !surface
      || surface.teamId !== membership.team.id
      || surface.createdByUserId !== device.userId
      || surface.benchmarkId !== body.benchmarkId
      || surface.benchmarkVersion !== body.benchmarkVersion
      || surface.localRunId !== sessionId
    ) {
      throw new ApiHttpError(409, "invalid_request", "That local run ID is already in use.");
    }
    const inserted = await db
      .insert(localRunSessions)
      .values({
        id: sessionId,
        teamId: membership.team.id,
        userId: device.userId,
        deviceId: device.deviceId,
        benchmarkId: body.benchmarkId,
        benchmarkVersion: body.benchmarkVersion,
        repositoryId: body.repositoryId,
        repositoryFullName: body.repositoryFullName,
        sha: body.sha,
        branch: body.branch ?? null,
        dirty: body.dirty,
        status: "running",
        phase: "preparing",
        failureDetail: null,
        reportId: null,
        discordChannelId: membership.team.discordChannelId,
        discordMessageId: null,
        lastEventSequence: -1,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        surfaceId,
      })
      .onConflictDoNothing();
    if ((inserted.meta.changes ?? 0) === 0) {
      const [conflict] = await db
        .select()
        .from(localRunSessions)
        .where(eq(localRunSessions.id, sessionId))
        .limit(1);
      if (
        !conflict ||
        conflict.deviceId !== device.deviceId ||
        conflict.userId !== device.userId ||
        conflict.benchmarkId !== body.benchmarkId ||
        conflict.benchmarkVersion !== body.benchmarkVersion ||
        conflict.repositoryId !== body.repositoryId ||
        conflict.repositoryFullName.toLowerCase() !== body.repositoryFullName.toLowerCase() ||
        conflict.sha !== body.sha ||
        conflict.branch !== (body.branch ?? null) ||
        conflict.dirty !== body.dirty
      ) {
        throw new ApiHttpError(409, "invalid_request", "That local run ID is already in use.");
      }
    }

    let discord: "published" | "channel_unbound" | "unavailable" = membership.team.discordChannelId
      ? "unavailable"
      : "channel_unbound";
    try {
      const snapshot = await publishRunSurface(c.env, surfaceId);
      if (membership.team.discordChannelId) {
        const delivery = await syncRunSurfaceMessage(c.env, snapshot);
        if (delivery === "created" || delivery === "updated") discord = "published";
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "run_surface_create_failed",
          localRunId: sessionId,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
    return respond(c, StartLocalRunResponseSchema, { sessionId, surfaceId, discord }, 201);
  });

  app.post("/v1/local-runs/:id/events", async (c) => {
    const device = await requireDevice(c);
    const event = await parseBody(c, LocalRunEventSchema);
    const result = await acceptLocalRunEvent(c.env, device, c.req.param("id"), event);
    publishSurfaceInBackground(c, result.surfaceId, c.req.param("id"));
    return respond(c, LocalRunEventResponseSchema, {
      ok: true,
      duplicate: result.duplicate,
      discord: await discordState(c.env, result.surfaceId),
    });
  });

  app.post("/v1/local-runs/:id/events/batch", async (c) => {
    const device = await requireDevice(c);
    const body = await parseBody(c, LocalRunEventBatchSchema);
    let surfaceId: string | null = null;
    let accepted = 0;
    for (const event of body.events) {
      const result = await acceptLocalRunEvent(c.env, device, c.req.param("id"), event);
      surfaceId = result.surfaceId;
      if (!result.duplicate) accepted += 1;
    }
    if (!surfaceId) throw new ApiHttpError(400, "invalid_request", "No local run events were supplied.");
    publishSurfaceInBackground(c, surfaceId, c.req.param("id"));
    return respond(c, LocalRunEventBatchResponseSchema, {
      ok: true,
      accepted,
      duplicate: accepted === 0,
      discord: await discordState(c.env, surfaceId),
    });
  });
}
