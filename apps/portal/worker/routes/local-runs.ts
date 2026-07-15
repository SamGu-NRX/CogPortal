import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import {
  LocalRunEventResponseSchema,
  LocalRunEventSchema,
  StartLocalRunRequestSchema,
  StartLocalRunResponseSchema,
  type LocalRunPhase,
  type Metric,
} from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { requireDevice } from "../auth/device";
import { getDb } from "../db/client";
import {
  benchmarks,
  localRunSessions,
  teamMembers,
  teams,
  users,
} from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import {
  createLocalRunMessage,
  updateLocalRunMessage,
  type LocalRunBubble,
} from "../services/discord-messages";
import { upsertLocalReport } from "../services/local-reports";

type SessionRow = typeof localRunSessions.$inferSelect;

async function runContext(env: AppEnv["Bindings"], session: SessionRow) {
  const db = getDb(env);
  const [[team], [benchmark], [author]] = await Promise.all([
    db.select().from(teams).where(eq(teams.id, session.teamId)).limit(1),
    db
      .select({ title: benchmarks.title })
      .from(benchmarks)
      .where(
        and(
          eq(benchmarks.id, session.benchmarkId),
          eq(benchmarks.version, session.benchmarkVersion),
        ),
      )
      .limit(1),
    db
      .select({ githubLogin: users.githubLogin })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1),
  ]);
  if (!team || !benchmark || !author) throw new Error("Local run context no longer exists.");
  return { team, benchmark, author };
}

function bubble(
  session: SessionRow,
  context: Awaited<ReturnType<typeof runContext>>,
  primaryMetric?: Metric | null,
): LocalRunBubble {
  return {
    teamName: context.team.name,
    benchmarkId: session.benchmarkId,
    benchmarkTitle: context.benchmark.title,
    githubLogin: context.author.githubLogin,
    sha: session.sha,
    dirty: session.dirty,
    phase: session.phase as LocalRunPhase,
    status: session.status,
    primaryMetric,
    failureDetail: session.failureDetail,
  };
}

async function updateDiscord(
  env: AppEnv["Bindings"],
  session: SessionRow,
  primaryMetric?: Metric | null,
): Promise<"updated" | "not_published" | "unavailable"> {
  if (!session.discordChannelId || !session.discordMessageId) return "not_published";
  try {
    const context = await runContext(env, session);
    await updateLocalRunMessage(
      env,
      session.discordChannelId,
      session.discordMessageId,
      bubble(session, context, primaryMetric),
    );
    return "updated";
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "discord_local_run_update_failed",
        localRunId: session.id,
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
    return "unavailable";
  }
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
      throw new ApiHttpError(403, "no_team", "Finish joining a team and connecting its repository first.");
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
        existing.sha !== body.sha
      ) {
        throw new ApiHttpError(409, "invalid_request", "That local run ID is already in use.");
      }
      return respond(c, StartLocalRunResponseSchema, {
        sessionId,
        discord: existing.discordMessageId
          ? "published"
          : existing.discordChannelId
            ? "unavailable"
            : "channel_unbound",
      });
    }
    await db.insert(localRunSessions).values({
      id: sessionId,
      teamId: membership.team.id,
      userId: device.userId,
      deviceId: device.deviceId,
      benchmarkId: body.benchmarkId,
      benchmarkVersion: body.benchmarkVersion,
      repositoryId: body.repositoryId,
      repositoryFullName: body.repositoryFullName,
      sha: body.sha,
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
    });

    let discord: "published" | "channel_unbound" | "unavailable" = membership.team.discordChannelId
      ? "unavailable"
      : "channel_unbound";
    if (membership.team.discordChannelId) {
      try {
        const [session] = await db
          .select()
          .from(localRunSessions)
          .where(eq(localRunSessions.id, sessionId))
          .limit(1);
        if (!session) throw new Error("Local run session was not saved.");
        const context = await runContext(c.env, session);
        const messageId = await createLocalRunMessage(
          c.env,
          membership.team.discordChannelId,
          bubble(session, context),
        );
        await db
          .update(localRunSessions)
          .set({ discordMessageId: messageId })
          .where(eq(localRunSessions.id, sessionId));
        discord = "published";
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "discord_local_run_create_failed",
            localRunId: sessionId,
            message: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }
    return respond(c, StartLocalRunResponseSchema, { sessionId, discord }, 201);
  });

  app.post("/v1/local-runs/:id/events", async (c) => {
    const device = await requireDevice(c);
    const event = await parseBody(c, LocalRunEventSchema);
    const db = getDb(c.env);
    const [current] = await db
      .select()
      .from(localRunSessions)
      .where(
        and(
          eq(localRunSessions.id, c.req.param("id")),
          eq(localRunSessions.deviceId, device.deviceId),
          eq(localRunSessions.userId, device.userId),
        ),
      )
      .limit(1);
    if (!current) throw new ApiHttpError(404, "not_found", "Local run session not found.");
    if (current.status !== "running" || event.sequence <= current.lastEventSequence) {
      return respond(c, LocalRunEventResponseSchema, {
        ok: true,
        duplicate: true,
        discord: current.discordMessageId ? "updated" : "not_published",
      });
    }

    let primaryMetric: Metric | null = null;
    const receivedAt = Date.now();
    if (event.type === "progress") {
      const phaseOrder: LocalRunPhase[] = ["preparing", "contract_check", "evaluating", "scoring"];
      if (phaseOrder.indexOf(event.phase) < phaseOrder.indexOf(current.phase as LocalRunPhase)) {
        return respond(c, LocalRunEventResponseSchema, {
          ok: true,
          duplicate: true,
          discord: current.discordMessageId ? "updated" : "not_published",
        });
      }
      await db
        .update(localRunSessions)
        .set({ phase: event.phase, lastEventSequence: event.sequence, updatedAt: receivedAt })
        .where(eq(localRunSessions.id, current.id));
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
      await upsertLocalReport(c.env, device.userId, report);
      primaryMetric = report.metrics.find((metric) => metric.primary) ?? null;
      await db
        .update(localRunSessions)
        .set({
          status: "succeeded",
          phase: "scoring",
          reportId: report.reportId,
          lastEventSequence: event.sequence,
          updatedAt: receivedAt,
          finishedAt: receivedAt,
        })
        .where(eq(localRunSessions.id, current.id));
    } else {
      await db
        .update(localRunSessions)
        .set({
          status: "failed",
          phase: event.phase,
          failureDetail: event.detail,
          lastEventSequence: event.sequence,
          updatedAt: receivedAt,
          finishedAt: receivedAt,
        })
        .where(eq(localRunSessions.id, current.id));
    }

    const [updated] = await db
      .select()
      .from(localRunSessions)
      .where(eq(localRunSessions.id, current.id))
      .limit(1);
    if (!updated) throw new Error("Local run session disappeared during its update.");
    const discord = await updateDiscord(c.env, updated, primaryMetric);
    return respond(c, LocalRunEventResponseSchema, { ok: true, duplicate: false, discord });
  });
}
