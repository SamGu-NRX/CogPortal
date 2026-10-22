import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import {
  RUN_PHASES,
  RUN_STATUSES,
  RunModeSchema,
  StaffDeskRunListSchema,
  StaffDeskTeamDetailSchema,
  StaffDeskTeamListSchema,
  TERMINAL_STATUSES,
  isTerminal,
} from "@cogworks/contracts/schema";
import type { RunStatus } from "@cogworks/contracts/schema";
import { getDb } from "../db/client";
import { benchmarks, runs, teamMembers, teamProcessSignals, teamTas, teams, users } from "../db/schema";
import { QUEUED_STALE_AFTER_SECONDS, REPORTING_PHASES, staleAfterMs } from "../execution/maintenance";
import type { AppEnv } from "../env";
import type { CommitRecord } from "../github/commits";
import { ApiHttpError } from "../http/errors";
import { respond } from "../http/respond";
import { buildProcessSignals, findingSentences } from "../services/process-signals";
import type { RosterMember, WeekLabel } from "../services/process-signals";
import {
  getAdminScope,
  readFirstLights,
  requireTeamScope,
  runBenchmark,
  runBenchmarkTitle,
  selectTeamIds,
} from "./admin";
import {
  COMMIT_HISTORY_CACHE_MS,
  MODULE_WEEK_LABELS,
  hasRunsElsewhere,
  resolveWeekLabel,
  scoredRunRecords,
  teamRoster,
} from "./team";

/**
 * The staff process desk: read-only routes under the admin console's
 * authorization (`/api/admin/desk/*`) that show staff what the portal has
 * already observed about a team's process — its stored commit-history read,
 * its runs, its first light.
 *
 * Three boundaries make this a desk rather than a wider pipe into the team
 * page:
 *
 * 1. It never talks to GitHub. Commit history reaches these routes only
 *    through the `team_process_signals` rows `routes/team.ts` stores when a
 *    team member opens their own Team page, and the desk reports how that
 *    stored read stands (fresh, stale, for a repository the team has left)
 *    instead of refreshing it. Staff reading a desk must not spend a team's
 *    41-subrequest history read or rate-limit its token.
 * 2. It reuses the team page's own signal builders (`buildProcessSignals`,
 *    `findingSentences`) over the stored read, so staff and the team read
 *    the same numbers from the same rules — including the rule that the
 *    projection reports what was read and its quality, never per-person
 *    totals.
 * 3. Run rows carry statuses, clocks and failure enums, never a run's own
 *    text: no failure detail, log, refusal, sweep, wiring or diagnostics
 *    payload leaves the maintenance surfaces here.
 */

/**
 * The runner-activity clock, shared with the maintenance sweep
 * (`execution/maintenance.ts`, which fails silent live runs): a live run the
 * sweep would fail reads "stale", not "in progress". The sweep fails only
 * Modal executions — queued after ten minutes, reporting phases after the
 * inactivity window, real activity deciding, and a legacy row's one-time
 * grace standing in before its first recorded callback — so everything else
 * reads "active": a stale label here is one the sweep would assign.
 */
const QUEUED_STALE_AFTER_MS = QUEUED_STALE_AFTER_SECONDS * 1000;

function activityOf(
  row: {
    provider: string;
    status: string;
    createdAt: number;
    acceptedActivityAt: number | null;
    legacyGraceUntil: number | null;
  },
  now: number,
  staleMs: number,
): "active" | "stale" | "terminal" {
  if (isTerminal(row.status as RunStatus)) return "terminal";
  if (row.provider !== "modal") return "active";
  if (row.status === "queued") {
    return row.createdAt < now - QUEUED_STALE_AFTER_MS ? "stale" : "active";
  }
  if (!(REPORTING_PHASES as readonly string[]).includes(row.status)) return "active";
  const activityAt = row.acceptedActivityAt ?? row.createdAt;
  if (activityAt >= now - staleMs) return "active";
  // Real activity decides. Without it, the one-time legacy grace decides;
  // a row not yet granted its grace (NULL) is never silent — the sweep
  // gives it a full window before it could fail.
  if (row.acceptedActivityAt !== null) return "stale";
  if (row.legacyGraceUntil === null) return "active";
  return row.legacyGraceUntil >= now ? "active" : "stale";
}

type StoredCommitHistory = {
  kind: "commit-history.v1";
  repository: string;
  branch: string;
  checkedAt: number;
  result:
    | { ok: true; commits: CommitRecord[]; truncated: boolean }
    | { ok: false; reason: string };
};

/** Reads a stored `team_process_signals` row, or null when unusable. */
function parseStoredHistory(row: { signalsJson: string }): StoredCommitHistory | null {
  try {
    const parsed = JSON.parse(row.signalsJson) as StoredCommitHistory | null;
    if (parsed && parsed.kind === "commit-history.v1" && typeof parsed.checkedAt === "number") {
      return parsed;
    }
    return null;
  } catch {
    // A malformed row is a miss like any other (routes/team.ts).
    return null;
  }
}

export function registerStaffDeskRoutes(app: Hono<AppEnv>): void {
  // ── GET /admin/desk/teams ────────────────────────────────────────────
  app.get("/admin/desk/teams", async (c) => {
    const scope = await getAdminScope(c);
    const db = getDb(c.env);
    const live = eq(teams.provenance, "live");
    // The scope predicate, not an expanded id list: every follow-up below
    // filters through teams (or a teams subquery), so no statement binds one
    // parameter per team. D1 refuses any statement with more than 100 bound
    // parameters, and the id-list form failed an owner's desk at 101 live
    // teams (`readFirstLights` exceeds the budget even sooner).
    const scopedTeams: SQL = scope.isOwner
      ? live
      : and(
          live,
          inArray(
            teams.id,
            db.select({ id: teamTas.teamId }).from(teamTas).where(eq(teamTas.userId, scope.auth.user.id)),
          ),
        )!;
    const rows = await db
      .select({
        id: teams.id,
        name: teams.name,
        cohortId: teams.cohortId,
        repoFullName: teams.repoFullName,
        defaultBranch: teams.defaultBranch,
        repoId: teams.repoId,
      })
      .from(teams)
      .where(scopedTeams)
      .orderBy(asc(teams.id));

    // One windowed query per reading, for the same query budget the admin
    // summaries keep (`readFirstLights`, `readAdminTeamSummaries`).
    const [memberCounts, tas, firstLights, scoredCounts, elsewhereTeams, weekRows, historyRows] =
      await Promise.all([
        db
          .select({ teamId: teamMembers.teamId, value: count() })
          .from(teamMembers)
          .innerJoin(teams, eq(teams.id, teamMembers.teamId))
          .where(scopedTeams)
          .groupBy(teamMembers.teamId),
        db
          .select({ teamId: teamTas.teamId, login: users.githubLogin, email: users.email })
          .from(teamTas)
          .innerJoin(users, eq(teamTas.userId, users.id))
          .innerJoin(teams, eq(teams.id, teamTas.teamId))
          .where(scopedTeams),
        readFirstLights(db, selectTeamIds(db, scopedTeams)),
        db
          .select({ teamId: runs.teamId, value: count() })
          .from(runs)
          .innerJoin(teams, eq(teams.id, runs.teamId))
          .where(
            and(
              scopedTeams,
              eq(runs.status, "succeeded"),
              isNotNull(runs.finishedAt),
              // Connected repository only (routes/team.ts `forConnectedRepository`).
              eq(runs.repositoryId, teams.repoId),
            ),
          )
          .groupBy(runs.teamId),
        // Scored runs that are NOT from the connected repository, in one
        // pass. A team with no recorded repository counts any succeeded run
        // (the exact rule `hasRunsElsewhere` applies per team).
        db
          .selectDistinct({ teamId: runs.teamId })
          .from(runs)
          .innerJoin(teams, eq(teams.id, runs.teamId))
          .where(
            and(
              scopedTeams,
              eq(runs.status, "succeeded"),
              or(
                isNull(teams.repoId),
                isNull(runs.repositoryId),
                ne(runs.repositoryId, teams.repoId),
              ),
            ),
          ),
        // The week the team is working in: the benchmark module of its most
        // recent run for the connected repository (any status), same rule as
        // `resolveWeekLabel`, windowed over all teams.
        db
          .select({
            teamId: runs.teamId,
            module: benchmarks.module,
            position: sql<number>`row_number() over (partition by ${runs.teamId} order by ${runs.createdAt} desc, ${runs.id} desc)`.as("position"),
          })
          .from(runs)
          .innerJoin(teams, eq(teams.id, runs.teamId))
          .innerJoin(
            benchmarks,
            and(eq(benchmarks.id, runs.benchmarkId), eq(benchmarks.version, runs.benchmarkVersion)),
          )
          .where(and(scopedTeams, eq(runs.repositoryId, teams.repoId))),
        db
          .select()
          .from(teamProcessSignals)
          .where(inArray(teamProcessSignals.teamId, selectTeamIds(db, scopedTeams))),
      ]);

    const weekRanked = weekRows as unknown as { teamId: string; module: string; position: number }[] | null;
    const weekByTeam = new Map<string, WeekLabel | null>();
    if (weekRanked) {
      for (const row of weekRanked) {
        if (row.position !== 1) continue;
        weekByTeam.set(row.teamId, MODULE_WEEK_LABELS[row.module] ?? null);
      }
    }

    const membersByTeam = new Map(memberCounts.map((row) => [row.teamId, row.value]));
    const tasByTeam = new Map<string, string[]>();
    for (const ta of tas) {
      const login = ta.login ?? ta.email.split("@")[0];
      const logins = tasByTeam.get(ta.teamId) ?? [];
      logins.push(login);
      tasByTeam.set(ta.teamId, logins);
    }
    const lightByTeam = new Map(firstLights.map((row) => [row.teamId, row]));
    const scoredByTeam = new Map(scoredCounts.map((row) => [row.teamId, row.value]));
    const elsewhereSet = new Set(elsewhereTeams.map((row) => row.teamId));
    const historyByTeam = new Map(historyRows.map((row) => [row.teamId, row]));
    const now = Date.now();

    const body = rows.map((team) => {
      const stored = historyByTeam.has(team.id)
        ? parseStoredHistory(historyByTeam.get(team.id)!)
        : null;
      const checkedAt = stored?.checkedAt ?? null;
      const forConnectedRepository = stored !== null && stored.repository === team.repoFullName;
      const light = lightByTeam.get(team.id);
      return {
        id: team.id,
        name: team.name,
        cohortId: team.cohortId,
        repo: { fullName: team.repoFullName, defaultBranch: team.defaultBranch },
        memberCount: membersByTeam.get(team.id) ?? 0,
        taLogins: tasByTeam.get(team.id) ?? [],
        historyQuality: historyByTeam.has(team.id) ? (historyByTeam.get(team.id)!.historyQuality as typeof teamProcessSignals.$inferSelect["historyQuality"]) : null,
        historyCheckedAt: checkedAt,
        historyStale: checkedAt !== null && now - checkedAt >= COMMIT_HISTORY_CACHE_MS,
        historyForConnectedRepository: forConnectedRepository,
        weekLabel: weekByTeam.get(team.id) ?? null,
        firstLight: light
          ? { benchmarkId: light.benchmarkId, benchmarkTitle: light.benchmarkTitle, at: light.at }
          : null,
        scoredRunCount: scoredByTeam.get(team.id) ?? 0,
        runsElsewhere: elsewhereSet.has(team.id),
      };
    });

    return respond(c, StaffDeskTeamListSchema, {
      scope: scope.isOwner ? ("owner" as const) : ("ta" as const),
      teams: body,
    });
  });

  // ── GET /admin/desk/teams/:teamId ────────────────────────────────────
  app.get("/admin/desk/teams/:teamId", async (c) => {
    const teamId = c.req.param("teamId");
    const scope = await requireTeamScope(c, teamId);
    const db = getDb(c.env);

    const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
    if (!team) throw new ApiHttpError(404, "not_found", "Team not found.");

    const [members, tas, memberCount, historyRow, weekLabel, scoredRuns, runsElsewhere, lights] =
      await Promise.all([
        db
          .select({ login: users.githubLogin, email: users.email, role: teamMembers.role })
          .from(teamMembers)
          .innerJoin(users, eq(teamMembers.userId, users.id))
          .where(eq(teamMembers.teamId, teamId))
          .orderBy(asc(teamMembers.role), asc(users.id)),
        db
          .select({ login: users.githubLogin, email: users.email })
          .from(teamTas)
          .innerJoin(users, eq(teamTas.userId, users.id))
          .where(eq(teamTas.teamId, teamId)),
        db.select({ value: count() }).from(teamMembers).where(eq(teamMembers.teamId, teamId)),
        db.select().from(teamProcessSignals).where(eq(teamProcessSignals.teamId, teamId)).limit(1),
        resolveWeekLabel(db, teamId, team.repoId),
        scoredRunRecords(db, teamId, team.repoId),
        hasRunsElsewhere(db, teamId, team.repoId),
        readFirstLights(db, db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId))),
      ]);

    // The desk reports how the stored read stands; it never re-fetches.
    const stored = historyRow[0] ? parseStoredHistory(historyRow[0]) : null;
    const checkedAt = stored?.checkedAt ?? null;
    const forConnectedRepository = stored !== null && stored.repository === team.repoFullName;
    const stale = checkedAt !== null && Date.now() - checkedAt >= COMMIT_HISTORY_CACHE_MS;

    let commitSignals = null;
    if (stored && forConnectedRepository && stored.result.ok) {
      const roster: RosterMember[] = await teamRoster(db, teamId);
      // The team page's own builders, over the stored read: same stage maps,
      // same ownership rule, same sentences.
      const signals = buildProcessSignals({
        commitsResult: stored.result,
        runs: scoredRuns,
        weekLabel,
        roster,
        runsElsewhere,
      });
      commitSignals = {
        historyQuality: signals.historyQuality,
        historyWindow: signals.historyWindow,
        weekLabel: signals.weekLabel,
        stageFootprint: signals.stageFootprint,
        ownershipBreadth: signals.ownershipBreadth,
        findingSentences: findingSentences(signals),
      };
    }

    const light = lights[0];
    return respond(c, StaffDeskTeamDetailSchema, {
      scope: scope.isOwner ? ("owner" as const) : ("ta" as const),
      team: {
        id: team.id,
        name: team.name,
        description: team.description,
        repo: { fullName: team.repoFullName, defaultBranch: team.defaultBranch },
        memberCount: memberCount[0]?.value ?? 0,
        members: members.map((member) => ({
          login: member.login ?? member.email.split("@")[0],
          role: member.role,
        })),
        tas: tas.map((ta) => ({ login: ta.login ?? ta.email.split("@")[0] })),
      },
      commitSignals,
      history: {
        checkedAt,
        stale,
        forConnectedRepository,
      },
      weekLabel,
      firstLight: light
        ? { benchmarkId: light.benchmarkId, benchmarkTitle: light.benchmarkTitle, at: light.at }
        : null,
      runsElsewhere,
    });
  });

  // ── GET /admin/desk/teams/:teamId/runs ───────────────────────────────
  app.get("/admin/desk/teams/:teamId/runs", async (c) => {
    const teamId = c.req.param("teamId");
    const scope = await requireTeamScope(c, teamId);
    const db = getDb(c.env);

    const [team] = await db
      .select({ id: teams.id, repoId: teams.repoId, repoFullName: teams.repoFullName })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    if (!team) throw new ApiHttpError(404, "not_found", "Team not found.");

    const querySchema = z.object({
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(20),
      status: z.enum(["active", "terminal", ...RUN_STATUSES]).optional(),
      mode: RunModeSchema.optional(),
    });
    const parsed = querySchema.safeParse({
      page: c.req.query("page") ?? undefined,
      pageSize: c.req.query("pageSize") ?? undefined,
      status: c.req.query("status") ?? undefined,
      mode: c.req.query("mode") ?? undefined,
    });
    if (!parsed.success) {
      throw new ApiHttpError(400, "invalid_request", "Invalid run list query.");
    }
    const { page, pageSize, status, mode } = parsed.data;

    const filters = [eq(runs.teamId, teamId)];
    if (status === "active") filters.push(inArray(runs.status, [...RUN_PHASES]));
    else if (status === "terminal") filters.push(inArray(runs.status, [...TERMINAL_STATUSES]));
    else if (status) filters.push(eq(runs.status, status));
    if (mode) filters.push(eq(runs.mode, mode));
    const where = and(...filters);

    const [totalRow, runRows] = await Promise.all([
      db.select({ value: count() }).from(runs).where(where),
      db
        .select({
          id: runs.id,
          status: runs.status,
          mode: runs.mode,
          provider: runs.provider,
          benchmarkId: runs.benchmarkId,
          benchmarkTitle: runBenchmarkTitle,
          attemptNumber: runs.attemptNumber,
          createdAt: runs.createdAt,
          finishedAt: runs.finishedAt,
          repositoryId: runs.repositoryId,
          repositoryFullName: runs.repositoryFullName,
          failurePhase: runs.failurePhase,
          failureCategory: runs.failureCategory,
          preparedArtifactId: runs.preparedArtifactId,
          environmentDigest: runs.environmentDigest,
          acceptedActivityAt: runs.acceptedActivityAt,
          legacyGraceUntil: runs.legacyGraceUntil,
        })
        .from(runs)
        .leftJoin(benchmarks, runBenchmark)
        .where(where)
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    const now = Date.now();
    const staleMs = staleAfterMs(c.env);
    const body = runRows.map((row): import("@cogworks/contracts/schema").StaffDeskRunRow => ({
      runId: row.id,
      status: row.status,
      mode: row.mode,
      benchmarkId: row.benchmarkId,
      benchmarkTitle: row.benchmarkTitle,
      attemptNumber: row.attemptNumber,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      activity: activityOf(row, now, staleMs),
      evidence:
        row.repositoryId === null
          ? "unrecorded"
          : row.repositoryId === team.repoId
            ? "connected"
            : "elsewhere",
      repositoryFullName: row.repositoryFullName,
      failurePhase: row.failurePhase,
      failureCategory: row.failureCategory,
      preparedSnapshot: {
        recorded: row.preparedArtifactId !== null,
        environmentDigest: row.environmentDigest,
      },
    }));

    const total = totalRow[0]?.value ?? 0;
    return respond(c, StaffDeskRunListSchema, {
      scope: scope.isOwner ? ("owner" as const) : ("ta" as const),
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
      runs: body,
    });
  });
}
