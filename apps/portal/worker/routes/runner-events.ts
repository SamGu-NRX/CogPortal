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
import { refundOfficialAttempt, withRefundCapNotice } from "../execution/refunds";
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

export async function verifyRunnerSignature(
  c: Context<AppEnv>,
  payload: string,
  maxAgeSeconds = MAX_CLOCK_SKEW_SECONDS,
) {
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
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(Math.floor(Date.now() / 1_000) - seconds) > maxAgeSeconds
  ) {
    throw new ApiHttpError(401, "unauthorized", "Runner signature timestamp is invalid.");
  }
  const expected = await hmacSignature(secret, timestamp, payload);
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

  // Set by the failure branch below, read by the terminal write after it. The
  // two are separated by the outbox insert, which both branches share.
  let refundCapped = false;

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
        // Which of their functions ran. Absent when they declared a
        // submission, because then nothing was inferred.
        wiringJson: event.result.wiring ? JSON.stringify(event.result.wiring) : null,
        sweepJson: event.result.sweep ? JSON.stringify(event.result.sweep) : null,
        ...(event.result.weightsSupplied === undefined
          ? {}
          : { weightsSuppliedJson: JSON.stringify(event.result.weightsSupplied) }),
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
          // Explicit nulls on both branches, so a result declaring no role
          // stores "none recorded" rather than inheriting an earlier write.
          // The conflict branch only ever sees a retry of the same event
          // today, since applyEvent returns early on a terminal run.
          role: metric.role ?? null,
          relatesTo: metric.relatesTo ?? null,
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
            role: metric.role ?? null,
            relatesTo: metric.relatesTo ?? null,
          },
        });
    }
    await db
      .update(runPhases)
      .set({ endedAt: event.occurredAt })
      .where(and(eq(runPhases.runId, run.id), eq(runPhases.phase, "scoring")));
  } else if (!failureConsumesAttempt(run.mode, event)) {
    // The failure was ours, so the attempt goes back, up to the per-team,
    // per-benchmark cap in execution/refunds.ts. Past the cap the run still
    // fails and the attempt stays spent; the terminal write below has to say
    // so, because a team that silently lost an attempt to our failure cannot
    // tell that from a bug.
    refundCapped = (await refundOfficialAttempt(db, run, Date.now())) === "capped";
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
    // Past the cap the attempt is genuinely spent, and `consumedAttempt` is
    // documented as the authoritative answer to "did this cost an attempt"
    // (packages/contracts/src/failures.ts), so it has to report that.
    const consumedAttempt = failureConsumesAttempt(run.mode, event) || refundCapped;
    await db
      .update(runs)
      .set({
        status: "failed",
        finishedAt: event.occurredAt,
        failureCategory: event.failure.category,
        failurePhase: event.failure.phase,
        failureDetail: refundCapped
          ? withRefundCapNotice(event.failure.detail)
          : event.failure.detail,
        // The full verdict, when the failure was "nothing here to score".
        // The capped detail above is for a log; this is what a student reads.
        refusalJson: event.failure.refusal ? JSON.stringify(event.failure.refusal) : null,
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
    await verifyRunnerSignature(c, body);
    let event: RunEventV1;
    try {
      event = RunEventV1Schema.parse(JSON.parse(body));
    } catch {
      throw new ApiHttpError(400, "invalid_request", "Runner event is invalid.");
    }
    const db = getDb(c.env);
    // Look the run up before recording the event. run_events.run_id is a
    // foreign key, so an event about a run that does not exist used to fail
    // the insert and answer 500, which reads as a portal bug to the runner
    // and to tools/probe_callback.py. It is a 404: the runner is talking
    // about a run this portal never created.
    const [known] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, event.runId))
      .limit(1);
    if (!known) throw new ApiHttpError(404, "not_found", "Run not found.");
    // Apply the event, then record it. The record is what answers "we already
    // have this", so it must not exist until the work behind it is done.
    // Recording first and repairing in a catch covers only an error this
    // process lives to handle: a Worker that stops mid-request leaves the
    // record with nothing behind it, and every retry after that is told the
    // result is in while the run sits unfinished.
    //
    // What this relies on is narrower than "every write is idempotent".
    // Re-applying the same event rewrites the same values, and the two things
    // that must not happen twice are guarded where they live: the terminal
    // writes are conditional on `lastEventSequence`, and the refund is decided
    // in execution/refunds.ts, which returns "not_applicable" once
    // `refunded_at` is set.
    await applyEvent(c.env, event);
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
    const [updated] = await db.select().from(runs).where(eq(runs.id, event.runId)).limit(1);
    // Publish at most once, decided by the insert above.
    //
    // "At most", not "exactly": the publish below is best-effort and its own
    // errors are logged rather than raised, and a process that stops between
    // the insert and the publish leaves the phase unannounced with the record
    // already written. This is the run surface, not the result, so a missed
    // phase costs a progress line rather than a score, and it behaved this way
    // before the ordering changed. Worth naming rather than implying the
    // surface has seen everything the record has.
    if (!duplicate && updated?.surfaceId) {
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
