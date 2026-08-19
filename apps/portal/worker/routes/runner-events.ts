import type { Context, Hono } from "hono";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { RunEventV1Schema, type RunEventV1 } from "@cogworks/contracts/protocol";
import type { FailureCategory, RunPhase, RunStreamEventCode } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { getDb } from "../db/client";
import {
  officialAttempts,
  outboxEvents,
  runEvents,
  runMetrics,
  runPhases,
  runs,
} from "../db/schema";
import { hmacSignature } from "../execution/runner";
import { ApiHttpError } from "../http/errors";
import { respond } from "../http/respond";
import { constantTimeTextEqual } from "../util/crypto";
import { appendRunStreamEvent, runnerFailureCode } from "../services/run-surfaces";

const OkSchema = z.object({ ok: z.literal(true), duplicate: z.boolean() });
const MAX_CLOCK_SKEW_SECONDS = 300;
const CONSUMING_FAILURES = new Set<FailureCategory>([
  "student_runtime",
  "timeout",
  "memory_limit",
  "output_invalid",
]);

function failureConsumesAttempt(runMode: string, event: Extract<RunEventV1, { type: "failed" }>) {
  return (
    runMode === "official" &&
    !event.failure.infrastructure &&
    (event.failure.phase === "evaluating" || event.failure.phase === "scoring") &&
    CONSUMING_FAILURES.has(event.failure.category)
  );
}

async function verifyRunnerEvent(c: Context<AppEnv>, body: string) {
  const secret = c.env.RUNNER_SIGNING_SECRET;
  if (!secret) throw new ApiHttpError(501, "provider_unconfigured", "Runner signing is not configured.");
  const keyId = c.req.header("X-Cogworks-Key-Id");
  if (keyId !== (c.env.RUNNER_SIGNING_KEY_ID ?? "runner-v1")) {
    throw new ApiHttpError(401, "unauthorized", "Unknown runner signing key.");
  }
  const timestamp = c.req.header("X-Cogworks-Timestamp");
  const supplied = c.req.header("X-Cogworks-Signature");
  if (!timestamp || !supplied?.startsWith("v1=")) {
    throw new ApiHttpError(401, "unauthorized", "Runner signature is missing.");
  }
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(Date.now() / 1_000) - seconds) > MAX_CLOCK_SKEW_SECONDS) {
    throw new ApiHttpError(401, "unauthorized", "Runner signature timestamp is invalid.");
  }
  const expected = await hmacSignature(secret, timestamp, body);
  if (!constantTimeTextEqual(expected, supplied.slice(3))) {
    throw new ApiHttpError(401, "unauthorized", "Runner signature is invalid.");
  }
}

function previousPhase(phase: RunPhase): RunPhase | null {
  const order: RunPhase[] = [
    "queued",
    "preparing",
    "installing",
    "contract_check",
    "evaluating",
    "scoring",
  ];
  const index = order.indexOf(phase);
  return index > 0 ? order[index - 1] : null;
}

async function applyEvent(env: AppEnv["Bindings"], event: RunEventV1): Promise<void> {
  const db = getDb(env);
  const [run] = await db.select().from(runs).where(eq(runs.id, event.runId)).limit(1);
  if (!run) throw new ApiHttpError(404, "not_found", "Run not found.");
  if (["succeeded", "failed", "cancelled"].includes(run.status)) return;
  if (event.sequence <= run.lastEventSequence) return;

  if (event.type === "status") {
    const phase = event.status;
    if (run.status !== phase) {
      const previous = previousPhase(phase);
      await db
        .update(runPhases)
        .set({ startedAt: event.occurredAt })
        .where(and(eq(runPhases.runId, run.id), eq(runPhases.phase, phase)));
      if (previous) {
        await db
          .update(runPhases)
          .set({ endedAt: event.occurredAt })
          .where(and(eq(runPhases.runId, run.id), eq(runPhases.phase, previous)));
      }
    }
    if (run.mode === "official" && phase === "evaluating") {
      await db.update(officialAttempts).set({ consumed: true }).where(eq(officialAttempts.runId, run.id));
    }
    await db
      .update(runs)
      .set({ status: phase, lastEventSequence: event.sequence })
      .where(and(eq(runs.id, run.id), lt(runs.lastEventSequence, event.sequence)));
    return;
  }

  if (event.type === "completed") {
    if (
      event.result.benchmarkId !== run.benchmarkId ||
      event.result.benchmarkVersion !== run.benchmarkVersion
    ) {
      throw new ApiHttpError(400, "invalid_request", "Runner result does not match the run benchmark.");
    }
    // The scorer's own account of what went wrong. Without this a student
    // whose adapter returns the wrong shape sees a number near chance and no
    // reason for it, which is the failure mode the course ethos rules out.
    await db
      .update(runs)
      .set({
        diagnosticsJson: JSON.stringify(event.result.diagnostics ?? []),
        sweepJson: event.result.sweep ? JSON.stringify(event.result.sweep) : null,
      })
      .where(eq(runs.id, run.id));
    for (const metric of event.result.metrics) {
      await db
        .insert(runMetrics)
        .values({
          runId: run.id,
          key: metric.key,
          label: metric.label,
          value: metric.value,
          unit: metric.unit,
          higherIsBetter: metric.higherIsBetter,
          isPrimary: metric.primary,
          precision: metric.precision,
          help: metric.help ?? null,
        })
        .onConflictDoUpdate({
          target: [runMetrics.runId, runMetrics.key],
          set: {
            label: metric.label,
            value: metric.value,
            unit: metric.unit,
            higherIsBetter: metric.higherIsBetter,
            isPrimary: metric.primary,
            precision: metric.precision,
            help: metric.help ?? null,
          },
        });
    }
    await db
      .update(runPhases)
      .set({ endedAt: event.occurredAt })
      .where(and(eq(runPhases.runId, run.id), eq(runPhases.phase, "scoring")));
  } else {
    const consumedAttempt = failureConsumesAttempt(run.mode, event);
    if (run.mode === "official" && !consumedAttempt) {
      await db.delete(officialAttempts).where(eq(officialAttempts.runId, run.id));
    }
  }

  await db
    .insert(outboxEvents)
    .values({
      id: `outbox_${event.eventId}`,
      topic: "run.terminal",
      aggregateId: run.id,
      payloadJson: JSON.stringify({ runId: run.id, teamId: run.teamId, status: event.type }),
      createdAt: Date.now(),
      deliveredAt: null,
      attempts: 0,
      nextAttemptAt: Date.now(),
    })
    .onConflictDoNothing();

  if (event.type === "completed") {
    await db
      .update(runs)
      .set({
        status: "succeeded",
        finishedAt: event.occurredAt,
        preparedArtifactId: event.preparedArtifactId,
        environmentDigest: event.environmentDigest,
        log: run.mode === "practice" ? event.sanitizedLog : null,
        lastEventSequence: event.sequence,
      })
      .where(and(eq(runs.id, run.id), lt(runs.lastEventSequence, event.sequence)));
  } else {
    const consumedAttempt = failureConsumesAttempt(run.mode, event);
    await db
      .update(runs)
      .set({
        status: "failed",
        finishedAt: event.occurredAt,
        failureCategory: event.failure.category,
        failurePhase: event.failure.phase,
        failureDetail: event.failure.detail,
        failureConsumedAttempt: consumedAttempt,
        lastEventSequence: event.sequence,
      })
      .where(and(eq(runs.id, run.id), lt(runs.lastEventSequence, event.sequence)));
  }
}

export function runnerSurfaceStatusCode(
  event: Extract<RunEventV1, { type: "status" }>,
): RunStreamEventCode {
  if (event.status === "evaluating" && event.progress && event.progress.current > 0) {
    return "evaluation.progress";
  }
  const codes = {
    preparing: "repository.fetching",
    installing: "dependencies.installing",
    contract_check: "contract.checking",
    evaluating: "evaluation.started",
    scoring: "scoring.started",
  } as const satisfies Record<Extract<RunEventV1, { type: "status" }>["status"], RunStreamEventCode>;
  return codes[event.status];
}

export function registerRunnerEventRoutes(app: Hono<AppEnv>): void {
  app.post("/internal/v1/runner/events", async (c) => {
    const body = await c.req.text();
    await verifyRunnerEvent(c, body);
    let event: RunEventV1;
    try {
      event = RunEventV1Schema.parse(JSON.parse(body));
    } catch {
      throw new ApiHttpError(400, "invalid_request", "Runner event is invalid.");
    }
    const db = getDb(c.env);
    const inserted = await db
      .insert(runEvents)
      .values({
        eventId: event.eventId,
        runId: event.runId,
        sequence: event.sequence,
        type: event.type,
        receivedAt: Date.now(),
      })
      .onConflictDoNothing();
    const duplicate = (inserted.meta.changes ?? 0) === 0;
    if (duplicate) return respond(c, OkSchema, { ok: true, duplicate: true });
    try {
      await applyEvent(c.env, event);
    } catch (error) {
      await db.delete(runEvents).where(eq(runEvents.eventId, event.eventId));
      throw error;
    }
    const [updated] = await db.select().from(runs).where(eq(runs.id, event.runId)).limit(1);
    if (updated?.surfaceId) {
      const code =
        event.type === "status"
          ? runnerSurfaceStatusCode(event)
          : event.type === "completed"
            ? "run.completed"
            : runnerFailureCode(event.failure.category);
      try {
        await appendRunStreamEvent(c.env, updated.surfaceId, {
          eventId: `stream_${event.eventId}`.slice(0, 128),
          source: updated.mode,
          sourceRunId: updated.id,
          sourceSequence: event.sequence,
          phase:
            event.type === "status"
              ? event.status
              : event.type === "completed"
                ? "scoring"
                : event.failure.phase,
          code,
          occurredAt: event.occurredAt,
          elapsedMs:
            event.type === "status" && event.elapsedMs != null
              ? event.elapsedMs
              : Math.max(0, event.occurredAt - updated.createdAt),
          progress: event.type === "status" ? (event.progress ?? null) : null,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "runner_surface_publish_failed",
            runId: updated.id,
            message: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }
    return respond(c, OkSchema, { ok: true, duplicate });
  });
}
