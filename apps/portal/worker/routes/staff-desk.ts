import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
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
import type { RunStatus, StaffDeskHistoryState } from "@cogworks/contracts/schema";
import { getDb } from "../db/client";
import { benchmarks, runs, teamMembers, teamProcessSignals, teamTas, teams, users } from "../db/schema";
import type { AppEnv } from "../env";
import type { CommitRecord } from "../github/commits";
import { staffView } from "../services/staff-visibility";
import { staleAfterMs } from "../execution/maintenance";
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
  StoredCommitHistorySchema,
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

/** Mirrors `execution/maintenance.ts`, which fails silent queued runs. */
const QUEUED_STALE_AFTER_MS = 10 * 60 * 1000;

type StoredHistoryReading = {
  history: StaffDeskHistoryState;
  /** The stored commits, only when the read is of the connected repository and branch. */
  commits: { ok: true; commits: CommitRecord[]; truncated: boolean } | null;
};

/**
 * Where a team's stored history row stands against the team as it is now.
 *
 * The row is validated with the Team page's own schema
 * (`StoredCommitHistorySchema`), so anything that page would refuse to serve
 * (malformed JSON, another format, a stored failure) reads as "unreadable"
 * here and is never dereferenced. A valid read of another repository or
 * branch is reported as such and never stands in for the current one.
 */
function readStoredHistory(
  row: { signalsJson: string } | undefined,
  team: { repoFullName: string; defaultBranch: string },
  now: number,
): StoredHistoryReading {
  const none = (status: "never_read" | "unreadable"): StoredHistoryReading => ({
    history: { status, checkedAt: null, stale: false, forConnectedRepository: false },
    commits: null,
  });
  if (!row) return none("never_read");
  let json: unknown = null;
  try {
    json = JSON.parse(row.signalsJson);
  } catch {
    return none("unreadable");
  }
  const parsed = StoredCommitHistorySchema.safeParse(json);
  if (!parsed.success) return none("unreadable");
  const stored = parsed.data;
  const elsewhere =
    stored.repository !== team.repoFullName
      ? ("other_repository" as const)
      : stored.branch !== team.defaultBranch
        ? ("other_branch" as const)
        : null;
  if (elsewhere) {
    return {
      history: { status: elsewhere, checkedAt: stored.checkedAt, stale: false, forConnectedRepository: false },
      commits: null,
    };
  }
  const stale = now - stored.checkedAt >= COMMIT_HISTORY_CACHE_MS;
  return {
    history: { status: stale ? "stale" : "fresh", checkedAt: stored.checkedAt, stale, forConnectedRepository: true },
    commits: stored.result,
  };
}

/**
 * The runner-activity clock, mirrored from the maintenance sweep
 * (`execution/maintenance.ts`): a live run the sweep would fail reads
 * "stale", not "in progress". Queued runs have their own shorter clock;
 * rows from before the activity clock keep their one-time grace.
 */
function activityOf(
  row: { status: string; createdAt: number; acceptedActivityAt: number | null; legacyGraceUntil: number | null },
  now: number,
  staleMs: number,
): "active" | "stale" | "terminal" {
  if (isTerminal(row.status as RunStatus)) return "terminal";
  if (row.status === "queued") {
    return row.createdAt < now - QUEUED_STALE_AFTER_MS ? "stale" : "active";
  }
  if (row.acceptedActivityAt === null && row.legacyGraceUntil !== null && row.legacyGraceUntil >= now) {
    return "active";
  }
  const activityAt = row.acceptedActivityAt ?? row.createdAt;
  return activityAt < now - staleMs ? "stale" : "active";
}

export function registerStaffDeskRoutes(app: Hono<AppEnv>): void {
  // ── GET /admin/desk/teams ────────────────────────────────────────────
  app.get("/admin/desk/teams", async (c) => {
    const scope = await getAdminScope(c);
    const db = getDb(c.env);
    const live = eq(teams.provenance, "live");
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
      .where(
        scope.isOwner
          ? live
          : and(live, inArray(teams.id, scope.teamIds)),
      )
      .orderBy(asc(teams.id));
    const ids = rows.map((row) => row.id);

    // One windowed query per reading, for the same query budget the admin
    // summaries keep (`readFirstLights`, `readAdminTeamSummaries`).
    const [memberCounts, tas, firstLights, scoredCounts, elsewhereTeams, weekRows, historyRows] =
      await Promise.all([
        db
          .select({ teamId: teamMembers.teamId, value: count() })
          .from(teamMembers)
          .where(inArray(teamMembers.teamId, ids.length > 0 ? ids : [""]))
          .groupBy(teamMembers.teamId),
        ids.length > 0
          ? db
              .select({ teamId: teamTas.teamId, login: users.githubLogin, email: users.email })
              .from(teamTas)
              .innerJoin(users, eq(teamTas.userId, users.id))
              .where(inArray(teamTas.teamId, ids))
          : Promise.resolve([] as { teamId: string; login: string | null; email: string }[]),
        ids.length > 0
          ? readFirstLights(db, selectTeamIds(db, inArray(teams.id, ids)))
          : Promise.resolve([] as { teamId: string; benchmarkId: string; benchmarkTitle: string; at: number }[]),
        db
          .select({ teamId: runs.teamId, value: count() })
          .from(runs)
          .innerJoin(teams, eq(teams.id, runs.teamId))
          .where(
            and(
              inArray(runs.teamId, ids.length > 0 ? ids : [""]),
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
        ids.length > 0
          ? db
              .selectDistinct({ teamId: runs.teamId })
              .from(runs)
              .innerJoin(teams, eq(teams.id, runs.teamId))
              .where(
                and(
                  inArray(runs.teamId, ids),
                  eq(runs.status, "succeeded"),
                  or(
                    isNull(teams.repoId),
                    isNull(runs.repositoryId),
                    ne(runs.repositoryId, teams.repoId),
                  ),
                ),
              )
          : Promise.resolve([] as { teamId: string }[]),
        // The week the team is working in: the benchmark module of its most
        // recent run for the connected repository (any status), same rule as
        // `resolveWeekLabel`, windowed over all teams.
        ids.length > 0
          ? db
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
              .where(and(inArray(runs.teamId, ids), eq(runs.repositoryId, teams.repoId)))
          : Promise.resolve(null),
        ids.length > 0
          ? db.select().from(teamProcessSignals).where(inArray(teamProcessSignals.teamId, ids))
          : Promise.resolve([] as typeof teamProcessSignals.$inferSelect[]),
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
      const row = historyByTeam.get(team.id);
      const { history } = readStoredHistory(row, team, now);
      const light = lightByTeam.get(team.id);
      return {
        id: team.id,
        name: team.name,
        cohortId: team.cohortId,
        repo: { fullName: team.repoFullName, defaultBranch: team.defaultBranch },
        memberCount: membersByTeam.get(team.id) ?? 0,
        taLogins: tasByTeam.get(team.id) ?? [],
        // The column describes whatever read is stored; it is this team's
        // quality only when that read is of the connected repository.
        historyQuality: history.forConnectedRepository && row ? row.historyQuality : null,
        history,
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
      // The list carries no student names, scores or findings, so both views
      // read the same rows.
      view: staffView(c.env, scope),
      teams: body,
    });
  });

  // ── GET /admin/desk/teams/:teamId ────────────────────────────────────
  app.get("/admin/desk/teams/:teamId", async (c) => {
    const teamId = c.req.param("teamId");
    const scope = await requireTeamScope(c, teamId);
    const view = staffView(c.env, scope);
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
    const { history, commits } = readStoredHistory(historyRow[0], team, Date.now());

    // Findings, stage counts and ownership name students and measure their
    // work; a restricted view gets none of them.
    let commitSignals = null;
    if (commits && view === "full") {
      const roster: RosterMember[] = await teamRoster(db, teamId);
      // The team page's own builders, over the stored read: same stage maps,
      // same ownership rule, same sentences.
      const signals = buildProcessSignals({
        commitsResult: commits,
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
      view,
      team: {
        id: team.id,
        name: team.name,
        description: team.description,
        repo: { fullName: team.repoFullName, defaultBranch: team.defaultBranch },
        memberCount: memberCount[0]?.value ?? 0,
        members:
          view === "full"
            ? members.map((member) => ({
                login: member.login ?? member.email.split("@")[0],
                role: member.role,
              }))
            : [],
        tas: tas.map((ta) => ({ login: ta.login ?? ta.email.split("@")[0] })),
      },
      commitSignals,
      history,
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
      // Run rows carry states, clocks and failure categories only, which both
      // views may read.
      view: staffView(c.env, scope),
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
      runs: body,
    });
  });
}
