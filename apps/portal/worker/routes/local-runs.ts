import type { Context, Hono } from "hono";
import { and, eq, exists, lt, notExists, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
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
import { guardedLocalReportSave, localReportRow, refuseOthersReportId, reportSavedBy, teamsStillTheirs } from "../services/local-reports";
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

/**
 * Before a start is reported as started: the person is still on the team it
 * was admitted for. The CLI stops on a refused start, so running the command
 * again is the whole recovery.
 */
async function refuseUnlessStillOnTeam(
  db: Database,
  userId: string,
  teamId: string,
  start: "recorded" | "unrecorded",
): Promise<void> {
  const [currentTeam] = await db
    .select({ teamId: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .limit(1);
  if (!currentTeam) {
    throw new ApiHttpError(403, "no_team", "Finish joining a team and connecting its repository first.");
  }
  if (currentTeam.teamId === teamId) return;
  throw new ApiHttpError(
    409,
    "forbidden",
    start === "unrecorded"
      ? `You moved to ${currentTeam.name} while this run was starting, so the portal didn't record it. Run the command again.`
      : `You moved to ${currentTeam.name} after this run was started for your old team, so the portal won't continue it. Run the command again.`,
  );
}

/** For a completed event whose report id already names a report a run on a
 *  team the author left points at. That report stays as it was. */
export const REPORT_ID_FROZEN =
  "This report ID already belongs to a run on a team you've left, so this run can't finish with it. Run the benchmark again to create a new report.";

/** What the CLI prints after "cogworks: live updates paused:" when its
 *  author has left the team the run was started for. */
export const LEFT_RUN_TEAM =
  "You're no longer on this run's team, so the portal stopped recording it. The run still finishes here and saves its report on this machine.";

/**
 * Apply one or more live-run events, in order, under one D1 transaction.
 *
 * Every event's writes carry the same admission condition the single-event
 * path always used -- the session still running, its last sequence behind
 * this event, the author still on the team, and for a completed event the
 * report saved under the same condition -- so each statement re-checks the
 * live row as it runs. What the transaction adds is that the batch stands
 * or falls together: the CLI sends a batch once and never retries it, so a
 * batch that was refused after half of itself landed would leave a console
 * holding events the CLI was told never arrived. Deterministic refusals (a
 * session that isn't there, an author who left, a completed report that
 * does not match, a report id that belongs to someone else) are decided
 * from reads before anything is written; a refusal that can only come from
 * another writer landing mid-request still stops the batch, with whatever
 * prefix the guards had already accepted, and says so truthfully.
 *
 * Each event is admitted or skipped from a mirror of the session row this
 * request itself is advancing -- the same reads the single-event path makes,
 * updated by each planned write -- so a retransmitted event inside a batch
 * is skipped exactly as it would be on its own. A racing writer that makes
 * the mirror stale turns the planned statements into empty ones (the guards
 * refuse), which reads as a duplicate, never as a wrong write.
 */
async function acceptLocalRunEvents(
  env: AppEnv["Bindings"],
  device: { deviceId: string; userId: string },
  sessionId: string,
  events: LocalRunEvent[],
): Promise<Array<{ duplicate: boolean; surfaceId: string }>> {
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

  const phaseOrder: LocalRunPhase[] = ["preparing", "contract_check", "evaluating", "scoring"];
  type Plan = {
    event: LocalRunEvent;
    /** Where this plan's statements begin in the flattened batch. */
    start: number;
    /** Where they end (exclusive); the session update is always last. */
    end: number;
  };
  const plans: Plan[] = [];
  const statements: BatchItem<"sqlite">[] = [];

  let mirrorStatus = current.status;
  let mirrorPhase = current.phase as LocalRunPhase;
  let mirrorSequence = current.lastEventSequence;

  for (const event of events) {
    const start = statements.length;
    const admitted = and(
      eq(localRunSessions.id, current.id),
      eq(localRunSessions.status, "running"),
      lt(localRunSessions.lastEventSequence, event.sequence),
      onTeam(db, current.teamId, device.userId),
    );
    if (mirrorStatus !== "running" || event.sequence <= mirrorSequence) {
      plans.push({ event, start, end: start });
      continue;
    }
    const receivedAt = Date.now();
    const elapsedMs =
      "elapsedMs" in event && event.elapsedMs != null
        ? event.elapsedMs
        : Math.max(0, event.occurredAt - current.createdAt);
    let phase: LocalRunPhase = mirrorPhase;
    let code: RunStreamEventCode;
    let nextValues: Partial<typeof localRunSessions.$inferInsert>;
    let report: ReturnType<typeof localReportRow> | null = null;
    if (event.type === "progress") {
      if (phaseOrder.indexOf(event.phase) < phaseOrder.indexOf(mirrorPhase)) {
        plans.push({ event, start, end: start });
        continue;
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
        // Raised from the plan, before any statement of this batch has run.
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
    // A completed event's report is saved in the same transaction, under the
    // same condition, and its event and session update then also require the
    // saved row: the report exists exactly when the run is recorded as
    // finished for its team.
    const reportSave = report
      ? await guardedLocalReportSave(
        db,
        report,
        exists(db.select({ id: localRunSessions.id }).from(localRunSessions).where(admitted)),
      )
      : null;
    const accepted = report
      ? and(admitted, reportSavedBy(db, report.reportId, device.userId), teamsStillTheirs(db, report.reportId, device.userId))
      : admitted;
    if (reportSave) statements.push(...reportSave);
    statements.push(guardedRunStreamEventInsert(
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
    ));
    statements.push(db.update(localRunSessions).set(nextValues).where(accepted));
    plans.push({ event, start, end: statements.length });
    mirrorStatus = report ? "succeeded" : event.type === "failed" ? "failed" : mirrorStatus;
    mirrorPhase = phase;
    mirrorSequence = event.sequence;
  }

  // db.batch's signature demands at least one statement; the length check is
  // what makes the assertion true.
  const results = statements.length
    ? await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]])
    : [];

  const outcomes: Array<{ duplicate: boolean; surfaceId: string }> = [];
  let anyApplied = false;
  for (const plan of plans) {
    const applied = plan.end > plan.start &&
      (results[plan.end - 1]?.meta.changes ?? 0) > 0;
    if (applied) {
      anyApplied = true;
      outcomes.push({ duplicate: false, surfaceId });
      continue;
    }
    // A leave that commits while this request was working also leaves the
    // writes empty. That is a refusal, not a duplicate: the CLI must not be
    // told the event arrived.
    if (!(await isOnTeam(db, current.teamId, device.userId))) {
      throw new ApiHttpError(403, "forbidden", LEFT_RUN_TEAM);
    }
    if (plan.end > plan.start && plan.event.type === "completed") {
      // The id was checked before the batch, but another account can save a
      // report under it in between; the batch then writes nothing. Their
      // report stands, and this event was not delivered.
      await refuseOthersReportId(db, plan.event.report.reportId, device.userId);
      // Nothing was written because a run on a team the author left points at
      // this report id: say so, rather than calling the event a duplicate.
      const [frozenBy] = await db
        .select({ id: localRunSessions.id })
        .from(localRunSessions)
        .where(and(
          eq(localRunSessions.reportId, plan.event.report.reportId),
          notExists(db.select({ userId: teamMembers.userId }).from(teamMembers).where(and(
            eq(teamMembers.teamId, localRunSessions.teamId),
            eq(teamMembers.userId, device.userId),
          ))),
        ))
        .limit(1);
      if (frozenBy) throw new ApiHttpError(409, "forbidden", REPORT_ID_FROZEN);
    }
    outcomes.push({ duplicate: true, surfaceId });
  }
  if (anyApplied) await settleRunStreamEvents(db, surfaceId);
  return outcomes;
}

async function acceptLocalRunEvent(
  env: AppEnv["Bindings"],
  device: { deviceId: string; userId: string },
  sessionId: string,
  event: LocalRunEvent,
): Promise<{ duplicate: boolean; surfaceId: string }> {
  const [outcome] = await acceptLocalRunEvents(env, device, sessionId, [event]);
  return outcome;
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
      // A repeated start (the CLI retrying after a lost answer) skips the
      // guarded batch below, so it asks about membership itself: reported as
      // started, it would be refused at its first event.
      await refuseUnlessStillOnTeam(db, device.userId, existing.teamId, "recorded");
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
    // Nothing was written: either a console from another run holds this id,
    // or the person left the team between the read above and the batch.
    // Something was: possibly by an identical start that raced this one, so
    // the person must still be on the team before it is reported as started.
    await refuseUnlessStillOnTeam(db, device.userId, membership.team.id, recorded ? "recorded" : "unrecorded");
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
    // One transaction for the whole batch: the CLI does not retry a batch, so
    // the portal either records all of it or tells the CLI none of it landed.
    const outcomes = await acceptLocalRunEvents(c.env, device, c.req.param("id"), body.events);
    const accepted = outcomes.filter((outcome) => !outcome.duplicate).length;
    if (!outcomes[0]) throw new ApiHttpError(400, "invalid_request", "No local run events were supplied.");
    publishSurfaceInBackground(c, outcomes[0].surfaceId, c.req.param("id"));
    return respond(c, LocalRunEventBatchResponseSchema, {
      ok: true,
      accepted,
      duplicate: accepted === 0,
      discord: await discordState(c.env, outcomes[0].surfaceId),
    });
  });
}
