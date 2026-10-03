import type { Context, Hono } from "hono";
import { and, eq, exists, lt, notExists, sql } from "drizzle-orm";
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
  type StartLocalRunRequest,
} from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { requireDevice } from "../auth/device";
import { getDb, type Database } from "../db/client";
import { insertWhere } from "../db/insert-where";
import {
  benchmarks,
  localRunSessions,
  runSurfaces,
  teamMembers,
  teams,
  type TeamRow,
} from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { guardedLocalReportSave, localReportRow, reportSavedBy } from "../services/local-reports";
import { syncRunSurfaceMessage } from "../services/discord-messages";
import {
  defaultLocalEventCode,
  guardedRunStreamEventInsert,
  publishRunSurface,
  settleRunStreamEvents,
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

/**
 * The console a session was recorded with. Every session written since
 * migration 0010 records one in the same write. A session with none predates
 * consoles and never had one: the id its own suffix would derive can belong to
 * another run's console, so it is refused rather than guessed.
 */
function recordedSurfaceId(session: typeof localRunSessions.$inferSelect): string {
  if (session.surfaceId) return session.surfaceId;
  throw new ApiHttpError(
    409,
    "invalid_request",
    "This local run started before CogPortal kept live consoles, so it can't take updates. Start a new run.",
  );
}

/**
 * Whether this user is on this team right now, as a condition a write can
 * carry. A device credential belongs to a person, not a team, so every write
 * a device makes into a team's records has to ask this at the moment it
 * writes; a check made earlier in the request loses to a leave that lands
 * between the two.
 */
function onTeam(db: Database, teamId: string, userId: string) {
  return exists(db.select({ userId: teamMembers.userId }).from(teamMembers).where(and(
    eq(teamMembers.teamId, teamId),
    eq(teamMembers.userId, userId),
  )));
}

async function isOnTeam(db: Database, teamId: string, userId: string): Promise<boolean> {
  const [member] = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return Boolean(member);
}

/** What the CLI prints after "cogworks: live updates paused:" when its
 *  author has left the team the run was started for. */
export const LEFT_RUN_TEAM =
  "You're no longer on this run's team, so the portal stopped recording it. The run still finishes here and saves its report on this machine.";

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
  // Before anything is saved or published, duplicates included: a person who
  // left the team keeps their device credential, and it must not keep
  // writing into that team's console or reports. The run is not moved to
  // whatever team they are on now; it stays the old team's history.
  if (!(await isOnTeam(db, current.teamId, device.userId))) {
    throw new ApiHttpError(403, "forbidden", LEFT_RUN_TEAM);
  }
  const surfaceId = recordedSurfaceId(current);
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
  let report: ReturnType<typeof localReportRow> | null = null;
  if (event.type === "progress") {
    const phaseOrder: LocalRunPhase[] = ["preparing", "contract_check", "evaluating", "scoring"];
    if (phaseOrder.indexOf(event.phase) < phaseOrder.indexOf(current.phase as LocalRunPhase)) {
      return { duplicate: true, surfaceId };
    }
    phase = event.phase;
    code = sharedProgressCode(event.code, event.phase);
    nextValues = { phase, lastEventSequence: event.sequence, updatedAt: receivedAt };
  } else if (event.type === "completed") {
    const sent = event.report;
    if (
      sent.benchmarkId !== current.benchmarkId ||
      sent.benchmarkVersion !== current.benchmarkVersion ||
      sent.repositoryFullName?.toLowerCase() !== current.repositoryFullName.toLowerCase() ||
      sent.sha !== current.sha
    ) {
      throw new ApiHttpError(409, "invalid_request", "The completed report does not match this live run.");
    }
    report = localReportRow(device.userId, event.report);
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
  // The session's new state and the stream event that reports it commit
  // together. Written apart, a failure between them left the session advanced,
  // so the CLI's retry of that event read as a duplicate and the console never
  // showed it. Both statements carry the same admission condition, and nothing
  // runs between them inside the batch, so the event is written exactly when
  // this request's update applies. A request that lost the race writes neither.
  //
  // A completed event's report is saved in the same batch, under the same
  // condition, and the event and session then also require the saved row: the
  // report exists exactly when the run is recorded as finished for its team.
  const admitted = and(
    eq(localRunSessions.id, current.id),
    eq(localRunSessions.status, "running"),
    lt(localRunSessions.lastEventSequence, event.sequence),
    onTeam(db, current.teamId, device.userId),
  );
  const reportSave = report
    ? await guardedLocalReportSave(
      db,
      report,
      exists(db.select({ id: localRunSessions.id }).from(localRunSessions).where(admitted)),
    )
    : null;
  const accepted = report ? and(admitted, reportSavedBy(db, report.reportId, device.userId)) : admitted;
  const eventInsert = guardedRunStreamEventInsert(
    db,
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
    exists(db.select({ id: localRunSessions.id }).from(localRunSessions).where(accepted)),
  );
  const sessionUpdate = db.update(localRunSessions).set(nextValues).where(accepted);
  const results = reportSave
    ? await db.batch([reportSave[0], reportSave[1], eventInsert, sessionUpdate])
    : await db.batch([eventInsert, sessionUpdate]);
  const updated = results[results.length - 1];
  const duplicate = (updated.meta.changes ?? 0) === 0;
  // A leave that commits between the membership read above and this batch
  // also leaves both writes empty. That is a refusal, not a duplicate: the
  // CLI must not be told the event arrived.
  if (duplicate && !(await isOnTeam(db, current.teamId, device.userId))) {
    throw new ApiHttpError(403, "forbidden", LEFT_RUN_TEAM);
  }
  if (!duplicate) await settleRunStreamEvents(db, surfaceId);
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

/**
 * The record governs, not the claim: a legacy row with no recorded id keeps
 * none, and a bound row must still name the team's current connection. Runs
 * after the admission gate, so any non-null claim already equals that id.
 */
function replayRepositoryMatches(
  recorded: number | null,
  claimed: number | null,
  teamRepoId: number | null,
): boolean {
  return recorded === null ? claimed === null : recorded === teamRepoId;
}

/** Whether a recorded session is this start request, from this device, for
 *  this team. Anything else under the same client run id is a different run. */
function isSameStart(
  session: typeof localRunSessions.$inferSelect,
  body: StartLocalRunRequest,
  device: { deviceId: string; userId: string },
  team: TeamRow,
): boolean {
  return session.teamId === team.id &&
    session.deviceId === device.deviceId &&
    session.userId === device.userId &&
    session.benchmarkId === body.benchmarkId &&
    session.benchmarkVersion === body.benchmarkVersion &&
    replayRepositoryMatches(session.repositoryId, body.repositoryId, team.repoId) &&
    session.repositoryFullName.toLowerCase() === body.repositoryFullName.toLowerCase() &&
    session.sha === body.sha &&
    session.branch === (body.branch ?? null) &&
    session.dirty === body.dirty;
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
    // A claim the connection cannot corroborate is refused, not dropped.
    if (body.repositoryId !== null && body.repositoryId !== membership.team.repoId) {
      throw new ApiHttpError(
        409,
        "forbidden",
        `This device reports a different repository than your team's connection to ${membership.team.repoFullName}.`,
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
      if (!isSameStart(existing, body, device, membership.team)) {
        throw new ApiHttpError(409, "invalid_request", "That local run ID is already in use.");
      }
      const existingSurfaceId = recordedSurfaceId(existing);
      return respond(c, StartLocalRunResponseSchema, {
        sessionId,
        surfaceId: existingSurfaceId,
        discord:
          (await discordState(c.env, existingSurfaceId)) === "updated"
            ? "published"
            : existing.discordChannelId
              ? "unavailable"
              : "channel_unbound",
      });
    }
    // The console and its session commit together, in one D1 batch. Written
    // apart, a failure between them left a console naming a session that did
    // not exist. The console is written only while no session holds this id,
    // and the session only beside a console that is this run's; a console left
    // by an older attempt is reused when it matches. A concurrent identical
    // start finds both rows already there and changes nothing.
    await db.batch([
      insertWhere(db, runSurfaces, {
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
      }, sql`${notExists(db.select({ id: localRunSessions.id }).from(localRunSessions)
        .where(eq(localRunSessions.id, sessionId)))} and ${onTeam(db, membership.team.id, device.userId)}`).onConflictDoNothing(),
      insertWhere(db, localRunSessions, {
        id: sessionId,
        teamId: membership.team.id,
        userId: device.userId,
        deviceId: device.deviceId,
        benchmarkId: body.benchmarkId,
        benchmarkVersion: body.benchmarkVersion,
        // The verified connection, not the SDK's nullable claim: a row with no
        // recorded id reads as predating the record and cannot be verified.
        repositoryId: membership.team.repoId,
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
      }, sql`${exists(db.select({ id: runSurfaces.id }).from(runSurfaces).where(and(
        eq(runSurfaces.id, surfaceId),
        eq(runSurfaces.teamId, membership.team.id),
        eq(runSurfaces.createdByUserId, device.userId),
        eq(runSurfaces.benchmarkId, body.benchmarkId),
        eq(runSurfaces.benchmarkVersion, body.benchmarkVersion),
        eq(runSurfaces.localRunId, sessionId),
      )))} and ${onTeam(db, membership.team.id, device.userId)}`).onConflictDoNothing(),
    ]);
    const [recorded] = await db
      .select()
      .from(localRunSessions)
      .where(eq(localRunSessions.id, sessionId))
      .limit(1);
    if (!recorded) {
      // Nothing was written. Either a console from another run holds this id,
      // or the person left the team between the read above and the batch,
      // possibly joining another one. The CLI stops on a refused start, so
      // running the command again is the whole recovery.
      const [currentTeam] = await db
        .select({ teamId: teams.id, name: teams.name })
        .from(teamMembers)
        .innerJoin(teams, eq(teamMembers.teamId, teams.id))
        .where(eq(teamMembers.userId, device.userId))
        .limit(1);
      if (!currentTeam) {
        throw new ApiHttpError(403, "no_team", "Finish joining a team and connecting its repository first.");
      }
      if (currentTeam.teamId !== membership.team.id) {
        throw new ApiHttpError(
          409,
          "forbidden",
          `You moved to ${currentTeam.name} while this run was starting, so the portal didn't record it. Run the command again.`,
        );
      }
    }
    if (!recorded || !isSameStart(recorded, body, device, membership.team)) {
      throw new ApiHttpError(409, "invalid_request", "That local run ID is already in use.");
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
