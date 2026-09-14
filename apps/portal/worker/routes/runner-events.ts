import type { Context, Hono } from "hono";
import { and, eq, exists, lt, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { PreparedEnvironmentV1Schema, RunEventV1Schema, RunJobV1Schema, type RunEventV1 } from "@cogworks/contracts/protocol";
import type { RunPhase, RunStreamEventCode } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { getDb } from "../db/client";
import {
  outboxEvents,
  runEvents,
  runMetrics,
  runPhases,
  runs,
  teams,
} from "../db/schema";
import { hmacSignature } from "../execution/runner";
import { ApiHttpError } from "../http/errors";
import { respond } from "../http/respond";
import { constantTimeTextEqual } from "../util/crypto";
import { appendRunStreamEvent, runnerFailureCode } from "../services/run-surfaces";
import { preparedEnvironmentMatchesRun } from "../services/run-eligibility";

const OkSchema = z.object({ ok: z.literal(true), duplicate: z.boolean() });
const MAX_CLOCK_SKEW_SECONDS = 300;
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
  const lateCompletion = event.type === "completed" && run.status === "failed";
  if (["succeeded", "failed", "cancelled"].includes(run.status) && !lateCompletion) return;
  if (event.sequence <= run.lastEventSequence) return;
  let preparedEnvironmentJson = run.preparedEnvironmentJson;
  if (event.type === "completed") {
    if (run.preparedArtifactId && run.preparedArtifactId !== event.preparedArtifactId) {
      throw new ApiHttpError(400, "invalid_request", "Runner artifact does not match the saved artifact.");
    }
    const evidence = event.preparedEnvironment;
    if (evidence) {
      let repositoryFullName: string | undefined;
      if (run.dispatchJobJson) {
        // A team may change repositories while its old execution finishes.
        // Callback provenance belongs to the admitted job, not today's team.
        try {
          repositoryFullName = RunJobV1Schema.parse(JSON.parse(run.dispatchJobJson)).source.fullName;
        } catch {
          throw new ApiHttpError(400, "invalid_request", "Recorded dispatch source is invalid.");
        }
      } else {
        const [team] = await db.select().from(teams).where(eq(teams.id, run.teamId)).limit(1);
        repositoryFullName = team?.repoFullName;
      }
      if (!repositoryFullName || !preparedEnvironmentMatchesRun(evidence, {
        ...run, preparedArtifactId: event.preparedArtifactId,
      }, repositoryFullName)) {
        throw new ApiHttpError(400, "invalid_request", "Runner provisioning evidence does not match the run.");
      }
      if (run.preparedArtifactId) {
        // Reuse inherits the original observation. Even an authenticated
        // completion cannot relabel an old snapshot as newly provisioned.
        let stored;
        try {
          stored = PreparedEnvironmentV1Schema.parse(JSON.parse(run.preparedEnvironmentJson ?? "null"));
        } catch {
          throw new ApiHttpError(400, "invalid_request", "The saved artifact has no valid provisioning evidence.");
        }
        if (JSON.stringify(stored) !== JSON.stringify(evidence)) {
          throw new ApiHttpError(400, "invalid_request", "Runner provisioning evidence changed during artifact reuse.");
        }
      } else {
        preparedEnvironmentJson = JSON.stringify(evidence);
      }
    }
    // Omitted legacy evidence remains unknown; omitted reuse evidence retains
    // the stored observation. environmentDigest never establishes compatibility.
  }

  if (event.type === "status") {
    const phase = event.status;
    const previous = previousPhase(phase);
    const eligible = and(
      eq(runs.id, run.id),
      notInArray(runs.status, ["succeeded", "failed", "cancelled"]),
      lt(runs.lastEventSequence, event.sequence),
    );
    const phaseChanged = exists(db.select({ id: runs.id }).from(runs)
      .where(and(eligible, ne(runs.status, phase))));
    // The reaper can fail this run after the initial read. Gate
    // every write on persisted state in one D1 transaction, with the run update
    // last so all statements see the same status and sequence eligibility.
    await db.batch([
      db.update(runPhases).set({ startedAt: event.occurredAt }).where(and(
        eq(runPhases.runId, run.id), eq(runPhases.phase, phase), phaseChanged,
      )),
      ...(previous ? [
        db.update(runPhases).set({ endedAt: event.occurredAt }).where(and(
          eq(runPhases.runId, run.id), eq(runPhases.phase, previous), phaseChanged,
        )),
      ] : []),
      db.update(runs).set({ status: phase, lastEventSequence: event.sequence }).where(eligible),
    ]);
    return;
  }

  const active = and(
    eq(runs.id, run.id),
    notInArray(runs.status, ["succeeded", "failed", "cancelled"]),
    lt(runs.lastEventSequence, event.sequence),
  );
  const activeExists = exists(db.select({ id: runs.id }).from(runs).where(active));
  const terminalNotice = db.insert(outboxEvents).select(db.select({
    id: sql<string>`${`outbox_${event.eventId}`}`.as("id"),
    topic: sql<string>`'run.terminal'`.as("topic"),
    aggregateId: sql<string>`${run.id}`.as("aggregateId"),
    payloadJson: sql<string>`${JSON.stringify({ runId: run.id, teamId: run.teamId, status: event.type })}`.as("payloadJson"),
    createdAt: sql<number>`${Date.now()}`.as("createdAt"),
    deliveredAt: sql<number | null>`null`.as("deliveredAt"),
    attempts: sql<number>`0`.as("attempts"),
    nextAttemptAt: sql<number>`${Date.now()}`.as("nextAttemptAt"),
  }).from(runs).where(active)).onConflictDoNothing();

  if (event.type === "completed") {
    if (event.result.benchmarkId !== run.benchmarkId || event.result.benchmarkVersion !== run.benchmarkVersion) {
      throw new ApiHttpError(400, "invalid_request", "Runner result does not match the run benchmark.");
    }
    // Failure is terminal. A later result belongs to this execution's history,
    // never to a new attempt or a successful current state.
    const acceptsCompletion = and(
      eq(runs.id, run.id),
      notInArray(runs.status, ["succeeded", "cancelled"]),
      lt(runs.lastEventSequence, event.sequence),
    );
    // Two late callbacks may have read the same failed run before either
    // records its snapshot. Only the first may establish that observation.
    const acceptsEvidence = and(
      acceptsCompletion,
      sql`${runs.preparedArtifactId} IS ${run.preparedArtifactId}`,
      sql`${runs.preparedEnvironmentJson} IS ${run.preparedEnvironmentJson}`,
    );
    const evidenceExists = exists(db.select({ id: runs.id }).from(runs).where(acceptsEvidence));
    await db.batch([
      terminalNotice,
      db.delete(runMetrics).where(and(eq(runMetrics.runId, run.id), evidenceExists)),
      ...event.result.metrics.map((metric) => db.insert(runMetrics).select(db.select({
        runId: sql<string>`${run.id}`.as("runId"),
        key: sql<string>`${metric.key}`.as("key"),
        label: sql<string>`${metric.label}`.as("label"),
        value: sql<number>`${metric.value}`.as("value"),
        unit: sql<string | null>`${metric.unit}`.as("unit"),
        higherIsBetter: sql<boolean>`${Number(metric.higherIsBetter)}`.as("higherIsBetter"),
        isPrimary: sql<boolean>`${Number(metric.primary)}`.as("isPrimary"),
        precision: sql<number>`${metric.precision}`.as("precision"),
        help: sql<string | null>`${metric.help ?? null}`.as("help"),
        role: sql<typeof runMetrics.$inferInsert.role>`${metric.role ?? null}`.as("role"),
        relatesTo: sql<string | null>`${metric.relatesTo ?? null}`.as("relatesTo"),
      }).from(runs).where(acceptsEvidence)).onConflictDoUpdate({
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
      })),
      db.update(runs).set({
        diagnosticsJson: JSON.stringify(event.result.diagnostics ?? []),
        wiringJson: event.result.wiring ? JSON.stringify(event.result.wiring) : null,
        sweepJson: event.result.sweep ? JSON.stringify(event.result.sweep) : null,
        ...(event.result.weightsSupplied === undefined
          ? {}
          : { weightsSuppliedJson: JSON.stringify(event.result.weightsSupplied) }),
        preparedArtifactId: event.preparedArtifactId,
        preparedEnvironmentJson,
        environmentDigest: event.environmentDigest,
        log: run.mode === "practice" ? event.sanitizedLog : null,
      }).where(acceptsEvidence),
      db.update(runPhases).set({ endedAt: event.occurredAt }).where(and(
        eq(runPhases.runId, run.id), eq(runPhases.phase, "scoring"), activeExists,
      )),
      db.update(runs).set({
        status: "succeeded",
        failureCategory: null,
        failurePhase: null,
        failureDetail: null,
        failureConsumedAttempt: false,
        refusalJson: null,
        finishedAt: event.occurredAt,
        lastEventSequence: event.sequence,
      }).where(active),
      db.update(runs).set({ lastEventSequence: event.sequence }).where(and(
        acceptsCompletion, eq(runs.status, "failed"),
        eq(runs.preparedArtifactId, event.preparedArtifactId),
        sql`${runs.preparedEnvironmentJson} IS ${preparedEnvironmentJson}`,
      )),
    ]);
  } else {
    await db.batch([
      terminalNotice,
      db.update(runs).set({
        status: "failed",
        finishedAt: event.occurredAt,
        failureCategory: event.failure.category,
        failurePhase: event.failure.phase,
        failureDetail: event.failure.detail,
        refusalJson: event.failure.refusal ? JSON.stringify(event.failure.refusal) : null,
        failureConsumedAttempt: false,
        lastEventSequence: event.sequence,
      }).where(active),
    ]);
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
    // Result writes and failure release share a transaction. Sequence and
    // persisted terminal-state guards make replay safe after an interrupted reply.
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
    if (!duplicate && updated?.surfaceId && updated.lastEventSequence === event.sequence &&
        (event.type !== "completed" || updated.status === "succeeded") &&
        (event.type !== "failed" || updated.status === "failed") &&
        (event.type !== "status" || !["succeeded", "failed", "cancelled"].includes(updated.status))) {
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
