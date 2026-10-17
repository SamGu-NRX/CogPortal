import type { Hono } from "hono";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  AdminAddMemberRequestSchema,
  AdminAddStaffRequestSchema,
  AdminAssignTaRequestSchema,
  AdminCohortPatchSchema,
  AdminOverviewSchema,
  AdminStaffRosterSchema,
  AdminTeamSummarySchema,
  UpdateTeamRequestSchema,
} from "@cogworks/contracts/schema";
import type { AdminStaffRoster, AdminTeamSummary, TeamMember } from "@cogworks/contracts/schema";
import { isPlatformOwner, normalizeLogin, requireStaff } from "../auth/roles";
import { authorizationLogin } from "../auth/session";
import type { AuthState } from "../auth/session";
import type { Database } from "../db/client";
import { getDb } from "../db/client";
import type { AppEnv, Env } from "../env";
import {
  benchmarks,
  cohorts,
  leaderboardSelections,
  platformStaff,
  runMetrics,
  runs,
  teamMembers,
  teamTas,
  teams,
  users,
} from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { isUniqueConstraintError } from "./team";
import { checkedNewMemberRole } from "./team-membership";
import { readUsedRunsByTeam } from "../services/run-accounting";
import { rankingRefusal } from "../services/run-eligibility";

const AdminCohortSchema = z.object({
  slug: z.string(),
  name: z.string(),
  joinCode: z.string(),
  active: z.boolean(),
});

function memberRole(role: string): TeamMember["role"] {
  if (role === "admin" || role === "maintain" || role === "write") return role;
  throw new Error("Team member has an invalid role.");
}

/** The ids of the teams `teamWhere` selects, as a subquery for an IN. */
function selectTeamIds(db: Database, teamWhere: SQL) {
  return db.select({ id: teams.id }).from(teams).where(teamWhere);
}
type ScopedTeamIds = ReturnType<typeof selectTeamIds>;

/** When the last run's outcome was known: its finish, or its start while it
 *  is still going and has none. */
const runSettledAt = sql<number>`coalesce(${runs.finishedAt}, ${runs.createdAt})`;

/**
 * The catalog title of the run's own benchmark version, read through a left
 * join on (id, version), the catalog's key, so it adds at most one row per run.
 * The id stands in when the catalog has no such row.
 */
const runBenchmarkTitle = sql<string>`coalesce(${benchmarks.title}, ${runs.benchmarkId})`;
const runBenchmark = and(
  eq(benchmarks.id, runs.benchmarkId),
  eq(benchmarks.version, runs.benchmarkVersion),
);

/**
 * Run state describes the repository the row prints: a run counts only if it
 * came from the repository the team is connected to now, the rule the Team
 * page's first light uses (routes/team.ts `forConnectedRepository`). Otherwise
 * a success from a repository the team has left kept a team with no completed
 * run recorded for its current repository out of the attention group. A team with no
 * recorded repository id, or a run without one (before migration 0013),
 * matches nothing, because NULL equals nothing in SQL. Hosted-run counts and
 * quota are read elsewhere and stay team-wide.
 */
const onConnectedRepository = eq(runs.repositoryId, teams.repoId);

/**
 * Each scoped team's first succeeded hosted run from its connected
 * repository, one row per team.
 *
 * One windowed statement for all teams, for the same query budget the
 * summaries below keep. The select lists the only columns read: nothing a
 * team wrote (failure detail, refusal, diagnostics, log) is fetched at all.
 *
 * A success with no finish time doesn't count, as on the Team page
 * (routes/team.ts, the scored runs it reads), so staff and the team name the
 * same date. Both paths that record a success write one (runner-events.ts,
 * execution/sync.ts); substituting the start time let an undated row take
 * first place from a run that really finished first.
 */
function readFirstLights(db: Database, teamIds: ScopedTeamIds) {
  // Never null here: the where clause below drops unfinished rows.
  const finishedAt = sql<number>`${runs.finishedAt}`;
  const ranked = db
    .select({
      teamId: runs.teamId,
      benchmarkId: runs.benchmarkId,
      benchmarkTitle: runBenchmarkTitle.as("benchmark_title"),
      at: finishedAt.as("at"),
      position: sql<number>`row_number() over (partition by ${runs.teamId} order by ${finishedAt}, ${runs.id})`.as("position"),
    })
    .from(runs)
    .innerJoin(teams, eq(teams.id, runs.teamId))
    .leftJoin(benchmarks, runBenchmark)
    .where(and(
      eq(runs.status, "succeeded"),
      isNotNull(runs.finishedAt),
      inArray(runs.teamId, teamIds),
      onConnectedRepository,
    ))
    .as("first_light");
  return db
    .select({
      teamId: ranked.teamId,
      benchmarkId: ranked.benchmarkId,
      benchmarkTitle: ranked.benchmarkTitle,
      at: ranked.at,
    })
    .from(ranked)
    .where(eq(ranked.position, 1));
}

/**
 * Each scoped team's most recently started hosted run from its connected
 * repository, one row per team, with the two failure enums and no failure
 * text. Same shape of query as
 * `readFirstLights`.
 */
function readLastHostedRuns(db: Database, teamIds: ScopedTeamIds) {
  const ranked = db
    .select({
      teamId: runs.teamId,
      benchmarkId: runs.benchmarkId,
      benchmarkTitle: runBenchmarkTitle.as("benchmark_title"),
      at: runSettledAt.as("at"),
      status: runs.status,
      // First light needs a finish time, so the row can't call a success
      // without one scored (see `LastRunOutcome`).
      finishRecorded: sql<number>`${runs.finishedAt} is not null`.as("finish_recorded"),
      failurePhase: runs.failurePhase,
      failureCategory: runs.failureCategory,
      position: sql<number>`row_number() over (partition by ${runs.teamId} order by ${runs.createdAt} desc, ${runs.id} desc)`.as("position"),
    })
    .from(runs)
    .innerJoin(teams, eq(teams.id, runs.teamId))
    .leftJoin(benchmarks, runBenchmark)
    .where(and(inArray(runs.teamId, teamIds), onConnectedRepository))
    .as("last_hosted_run");
  return db
    .select({
      teamId: ranked.teamId,
      benchmarkId: ranked.benchmarkId,
      benchmarkTitle: ranked.benchmarkTitle,
      at: ranked.at,
      status: ranked.status,
      finishRecorded: ranked.finishRecorded,
      failurePhase: ranked.failurePhase,
      failureCategory: ranked.failureCategory,
    })
    .from(ranked)
    .where(eq(ranked.position, 1));
}

/**
 * Console summaries for every team `teamWhere` selects, in name order.
 *
 * Each part is one statement for all teams rather than one per team. The
 * overview used to spend six per team: 223 D1 queries for one page load on a
 * local cohort of 36 live teams. D1's free plan documents a limit of 50 per
 * invocation, which that pattern passes at about eight teams.
 */
async function readAdminTeamSummaries(
  db: Database,
  teamWhere: SQL,
): Promise<AdminTeamSummary[]> {
  const scopedTeamIds = selectTeamIds(db, teamWhere);
  const [teamRows, members, tas, used, executed, published, firstLights, lastRuns] = await Promise.all([
    db.select().from(teams).where(teamWhere).orderBy(asc(teams.name)),
    db
      .select({
        teamId: teamMembers.teamId,
        login: users.githubLogin,
        email: users.email,
        name: users.name,
        role: teamMembers.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(teamWhere),
    db
      .select({
        teamId: teamTas.teamId,
        login: users.githubLogin,
        email: users.email,
        name: users.name,
        avatarUrl: users.image,
      })
      .from(teamTas)
      .innerJoin(users, eq(teamTas.userId, users.id))
      .innerJoin(teams, eq(teams.id, teamTas.teamId))
      .where(teamWhere)
      .orderBy(asc(users.githubLogin)),
    // Admin team totals intentionally span every benchmark and version.
    readUsedRunsByTeam(db, teamWhere),
    // Every hosted execution in any state, so a team whose runs all failed
    // is not mistaken for one that never ran. Teams as a subquery, for the
    // reason readUsedRunsByTeam gives (runs has no team_id index).
    db
      .select({ teamId: runs.teamId, count: sql<number>`count(*)`.mapWith(Number) })
      .from(runs)
      .where(inArray(runs.teamId, scopedTeamIds))
      .groupBy(runs.teamId),
    // Every team's selections, newest first. The first per team that the
    // board would rank is the one shown (`rankingRefusal` below).
    db
      .select({
        teamId: leaderboardSelections.teamId,
        run: {
          mode: runs.mode,
          status: runs.status,
          refundedAt: runs.refundedAt,
          scorerVersion: runs.scorerVersion,
        },
        benchmark: {
          scorerVersion: benchmarks.scorerVersion,
          primaryMetricKey: benchmarks.primaryMetricKey,
        },
        metricKey: runMetrics.key,
        value: runMetrics.value,
        benchmarkName: benchmarks.title,
        benchmarkVersion: leaderboardSelections.benchmarkVersion,
      })
      .from(leaderboardSelections)
      // Left joins, so a selection with no catalog row or no reading for the
      // ranked measure still arrives and is refused by the same rule the
      // board uses, rather than vanishing in SQL for a different reason.
      .leftJoin(
        benchmarks,
        and(
          eq(benchmarks.id, leaderboardSelections.benchmarkId),
          eq(benchmarks.version, leaderboardSelections.benchmarkVersion),
        ),
      )
      .leftJoin(
        runMetrics,
        and(
          eq(runMetrics.runId, leaderboardSelections.runId),
          eq(runMetrics.key, benchmarks.primaryMetricKey),
        ),
      )
      .innerJoin(runs, eq(runs.id, leaderboardSelections.runId))
      .innerJoin(teams, eq(teams.id, leaderboardSelections.teamId))
      .where(teamWhere)
      .orderBy(desc(leaderboardSelections.selectedAt)),
    readFirstLights(db, scopedTeamIds),
    readLastHostedRuns(db, scopedTeamIds),
  ]);
  const executions = new Map(executed.map((row) => [row.teamId, row.count]));
  const firstLightByTeam = new Map(firstLights.map((row) => [row.teamId, row]));
  const lastRunByTeam = new Map(lastRuns.map((row) => [row.teamId, row]));
  const roleOrder: Record<TeamMember["role"], number> = {
    admin: 0,
    maintain: 1,
    write: 2,
  };
  return teamRows.map((team) => {
    const latest = published.find((row) => row.teamId === team.id &&
      rankingRefusal(row.run, row.benchmark, row.metricKey === null ? [] : [{ key: row.metricKey }]) === null);
    const usage = used.get(team.id);
    const first = firstLightByTeam.get(team.id);
    const last = lastRunByTeam.get(team.id);
    return {
      id: team.id,
      name: team.name,
      provenance: team.provenance,
      repoFullName: team.repoFullName,
      members: members
        .filter((member) => member.teamId === team.id)
        .map((member) => ({
          login: member.login ?? member.email.split("@")[0],
          name: member.name,
          role: memberRole(member.role),
        }))
        .sort(
          (left, right) =>
            roleOrder[left.role] - roleOrder[right.role] || left.login.localeCompare(right.login),
        ),
      tas: tas
        .filter((ta) => ta.teamId === team.id)
        .map((ta) => ({
          login: ta.login ?? ta.email.split("@")[0],
          name: ta.name,
          avatarUrl: ta.avatarUrl,
        })),
      practiceUsed: usage?.practiceUsed ?? 0,
      officialUsed: usage?.officialUsed ?? 0,
      hostedRuns: executions.get(team.id) ?? 0,
      // Retained for older clients. Failures no longer require a refund decision.
      refundsGiven: 0,
      firstLight: first
        ? { benchmarkId: first.benchmarkId, benchmarkTitle: first.benchmarkTitle, at: first.at }
        : null,
      lastHostedRun: last
        ? {
            benchmarkId: last.benchmarkId,
            benchmarkTitle: last.benchmarkTitle,
            at: last.at,
            status: last.status,
            finishRecorded: Boolean(last.finishRecorded),
            failure:
              last.status === "failed" && last.failurePhase !== null && last.failureCategory !== null
                ? { phase: last.failurePhase, category: last.failureCategory }
                : null,
          }
        : null,
      published:
        latest?.value == null
          ? null
          : {
              score: latest.value,
              benchmarkName: latest.benchmarkName ?? null,
              benchmarkVersion: latest.benchmarkVersion,
            },
    };
  });
}

async function getAdminTeamSummary(db: Database, teamId: string): Promise<AdminTeamSummary> {
  const [summary] = await readAdminTeamSummaries(db, eq(teams.id, teamId));
  if (!summary) throw new ApiHttpError(404, "not_found", "Team not found.");
  return summary;
}

/**
 * The staff roster as the console shows it.
 *
 * A roster row is a login string, not an account (migration 0031 explains
 * why), so the account is looked up separately and may not exist. `name` null
 * therefore means "nobody with this login has signed in yet", which is also
 * what a typo looks like; the console says so rather than leaving an entry
 * that silently grants nothing.
 *
 * Owners are listed alongside because they are staff without a roster row. An
 * owner reading a roster that omits them would reasonably conclude their own
 * access was missing.
 */
async function getStaffRoster(db: Database, env: Env): Promise<AdminStaffRoster> {
  const entries = await db
    .select({
      login: platformStaff.displayLogin,
      matchLogin: platformStaff.login,
      grantedBy: platformStaff.grantedBy,
      grantedAt: platformStaff.grantedAt,
    })
    .from(platformStaff)
    .orderBy(asc(platformStaff.login));
  // Lowercased on both sides. users.github_login stores GitHub's own casing,
  // so an exact IN would report a rostered person as "not signed in yet"
  // purely because the owner typed their login differently. Same reason
  // routes/team-membership.ts compares logins this way.
  const accounts = entries.length
    ? await db
        .select({ login: users.githubLogin, name: users.name })
        .from(users)
        .where(
          inArray(
            sql`lower(${users.githubLogin})`,
            entries.map((entry) => entry.matchLogin),
          ),
        )
    : [];
  const nameByLogin = new Map(
    accounts.map((account) => [normalizeLogin(account.login ?? ""), account.name]),
  );
  return {
    entries: entries.map((entry) => ({
      login: entry.login,
      name: nameByLogin.get(entry.matchLogin) ?? null,
      grantedBy: entry.grantedBy,
      grantedAt: entry.grantedAt,
    })),
    owners: (env.PLATFORM_OWNER_LOGINS ?? "")
      .split(",")
      .map((login) => login.trim())
      .filter(Boolean),
  };
}

type AdminScope = {
  auth: AuthState;
  isOwner: boolean;
  teamIds: string[];
};

async function getAdminScope(c: Parameters<typeof requireStaff>[0]): Promise<AdminScope> {
  const auth = await requireStaff(c);
  const isOwner = isPlatformOwner(c.env, authorizationLogin(c.env, auth.user));
  if (isOwner) return { auth, isOwner, teamIds: [] };
  const assignments = await getDb(c.env)
    .select({ teamId: teamTas.teamId })
    .from(teamTas)
    .where(eq(teamTas.userId, auth.user.id));
  return { auth, isOwner, teamIds: assignments.map((assignment) => assignment.teamId) };
}

async function requireOwner(c: Parameters<typeof requireStaff>[0]): Promise<AuthState> {
  const scope = await getAdminScope(c);
  if (!scope.isOwner) {
    throw new ApiHttpError(403, "forbidden", "Owner access required.");
  }
  return scope.auth;
}

async function requireTeamScope(
  c: Parameters<typeof requireStaff>[0],
  teamId: string,
): Promise<AdminScope> {
  const scope = await getAdminScope(c);
  if (!scope.isOwner && !scope.teamIds.includes(teamId)) {
    throw new ApiHttpError(403, "forbidden", "This team is not assigned to you.");
  }
  return scope;
}

async function getManagedCohort(db: Database) {
  const [cohort] = await db
    .select()
    .from(cohorts)
    .orderBy(desc(cohorts.active), asc(cohorts.id))
    .limit(1);
  if (!cohort) throw new ApiHttpError(404, "not_found", "Cohort not found.");
  return cohort;
}

function newJoinCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

export function registerAdminRoutes(app: Hono<AppEnv>): void {
  app.get("/admin/overview", async (c) => {
    const scope = await getAdminScope(c);
    const db = getDb(c.env);
    const cohort = await getManagedCohort(db);
    // Owner responses contain the active enrollment credential. They must
    // always reflect D1 and must never be retained by a browser or intermediary.
    c.header("Cache-Control", "private, no-store");
    // Archive teams are last year's scores under replaced names. They have no
    // members and will never run, so on a triage list they would all read
    // "no hosted runs" and sit above every live team. Staff manage live teams.
    const live = and(eq(teams.cohortId, cohort.id), eq(teams.provenance, "live"))!;
    const summaries = scope.isOwner
      ? await readAdminTeamSummaries(db, live)
      : scope.teamIds.length > 0
        ? await readAdminTeamSummaries(db, and(live, inArray(teams.id, scope.teamIds))!)
        : [];
    const unassigned = scope.isOwner
      ? await db
        .select({
          login: users.githubLogin,
          email: users.email,
          name: users.name,
          joinedAt: users.cohortJoinedAt,
        })
        .from(users)
        .leftJoin(teamMembers, eq(teamMembers.userId, users.id))
        .where(and(eq(users.cohortId, cohort.id), isNull(teamMembers.teamId)))
        .orderBy(asc(users.githubLogin))
      : [];
    const serializedUnassigned = unassigned.map((user) => ({
      login: user.login ?? user.email.split("@")[0],
      name: user.name,
      joinedAt: user.joinedAt,
    }));
    return respond(c, AdminOverviewSchema, {
      scope: scope.isOwner ? "owner" : "ta",
      cohort: {
        slug: cohort.slug,
        name: cohort.name,
        joinCode: scope.isOwner ? cohort.joinCode : null,
        active: cohort.active,
      },
      teams: summaries,
      unassigned: serializedUnassigned,
    });
  });

  app.patch("/admin/cohort", async (c) => {
    await requireOwner(c);
    const body = await parseBody(c, AdminCohortPatchSchema);
    const db = getDb(c.env);
    const cohort = await getManagedCohort(db);
    const updates: { joinCode?: string; active?: boolean } = {};
    if (body.rotateJoinCode === true) updates.joinCode = newJoinCode();
    if (body.active !== undefined) updates.active = body.active;
    if (Object.keys(updates).length > 0) {
      await db.update(cohorts).set(updates).where(eq(cohorts.id, cohort.id));
    }
    const updated = await getManagedCohort(db);
    return respond(c, AdminCohortSchema, {
      slug: updated.slug,
      name: updated.name,
      joinCode: updated.joinCode,
      active: updated.active,
    });
  });

  app.patch("/admin/teams/:teamId", async (c) => {
    const body = await parseBody(c, UpdateTeamRequestSchema);
    const db = getDb(c.env);
    const teamId = c.req.param("teamId");
    await requireTeamScope(c, teamId);
    const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).limit(1);
    if (!team) throw new ApiHttpError(404, "not_found", "Team not found.");
    const updates: { name?: string; description?: string | null } = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    await db.update(teams).set(updates).where(eq(teams.id, teamId));
    return respond(c, AdminTeamSummarySchema, await getAdminTeamSummary(db, teamId));
  });

  app.post("/admin/teams/:teamId/members", async (c) => {
    const body = await parseBody(c, AdminAddMemberRequestSchema);
    const db = getDb(c.env);
    const teamId = c.req.param("teamId");
    await requireTeamScope(c, teamId);
    const [[team], [user]] = await Promise.all([
      db
        .select({ id: teams.id, cohortId: teams.cohortId, repoFullName: teams.repoFullName })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1),
      db
        .select({ id: users.id, cohortId: users.cohortId, githubLogin: users.githubLogin })
        .from(users)
        .where(sql`lower(${users.githubLogin}) = lower(${body.login})`)
        .limit(1),
    ]);
    if (!team || !user) {
      throw new ApiHttpError(404, "not_found", !team ? "Team not found." : "User not found.");
    }
    // The same refusals the student-facing path makes (routes/team-membership.ts):
    // without them, a cross-cohort add succeeds silently and the one-team unique
    // index surfaces as a raw 500.
    if (user.cohortId !== team.cohortId) {
      throw new ApiHttpError(403, "not_in_cohort", `@${body.login} is not in this team's cohort.`);
    }
    const [membership] = await db
      .select({ teamId: teamMembers.teamId, teamName: teams.name })
      .from(teamMembers)
      .leftJoin(teams, eq(teamMembers.teamId, teams.id))
      .where(eq(teamMembers.userId, user.id))
      .limit(1);
    if (membership) {
      // Already on this team included: refusing instead of upserting is what
      // preserves an existing member's role (re-adding a creator used to
      // silently demote them to "write").
      throw new ApiHttpError(
        409,
        "already_on_team",
        membership.teamId === teamId
          ? `@${body.login} is already on this team.`
          : `@${body.login} is already on team ${membership.teamName ?? "another team"}.`,
      );
    }
    // The row stores what GitHub says about this person on the team's
    // repository, checked here where the staff member who can act is
    // standing. Staff can no longer add someone GitHub doesn't list on the
    // repository; the check is the same one Join runs on the student.
    const role = await checkedNewMemberRole(c, team, { id: user.id, githubLogin: user.githubLogin ?? body.login });
    try {
      await db.insert(teamMembers).values({ teamId, userId: user.id, role });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ApiHttpError(409, "already_on_team", `@${body.login} is already on a team.`);
      }
      throw error;
    }
    return respond(c, AdminTeamSummarySchema, await getAdminTeamSummary(db, teamId));
  });

  app.delete("/admin/teams/:teamId/members/:login", async (c) => {
    const db = getDb(c.env);
    const teamId = c.req.param("teamId");
    await requireTeamScope(c, teamId);
    const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).limit(1);
    if (!team) throw new ApiHttpError(404, "not_found", "Team not found.");
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.githubLogin}) = lower(${c.req.param("login")})`)
      .limit(1);
    if (user) {
      // Same refusal as the team page's removal path (routes/team-membership.ts):
      // removing the creator strands the team's settings for everyone.
      const [membership] = await db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)))
        .limit(1);
      if (membership?.role === "admin") {
        throw new ApiHttpError(
          403,
          "cannot_remove_creator",
          "A team admin can't be removed.",
        );
      }
      await db
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)));
    }
    return respond(c, AdminTeamSummarySchema, await getAdminTeamSummary(db, teamId));
  });

  app.post("/admin/teams/:teamId/tas", async (c) => {
    await requireOwner(c);
    const body = await parseBody(c, AdminAssignTaRequestSchema);
    const db = getDb(c.env);
    const teamId = c.req.param("teamId");
    const [[team], [user]] = await Promise.all([
      db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).limit(1),
      db.select({ id: users.id }).from(users).where(sql`lower(${users.githubLogin}) = lower(${body.login})`).limit(1),
    ]);
    if (!team || !user) {
      throw new ApiHttpError(404, "not_found", !team ? "Team not found." : "User must sign in before being assigned as a TA.");
    }
    await db
      .insert(teamTas)
      .values({ teamId, userId: user.id, assignedAt: Date.now() })
      .onConflictDoNothing();
    return respond(c, AdminTeamSummarySchema, await getAdminTeamSummary(db, teamId));
  });

  app.delete("/admin/teams/:teamId/tas/:login", async (c) => {
    await requireOwner(c);
    const db = getDb(c.env);
    const teamId = c.req.param("teamId");
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.githubLogin}) = lower(${c.req.param("login")})`)
      .limit(1);
    if (user) {
      await db.delete(teamTas).where(and(eq(teamTas.teamId, teamId), eq(teamTas.userId, user.id)));
    }
    return respond(c, AdminTeamSummarySchema, await getAdminTeamSummary(db, teamId));
  });

  /* ── Platform staff roster (owner only) ──────────────────────────────
   *
   * Every one of these is owner-gated, including the read. Staff granting
   * staff is privilege escalation: a TA who could add a login could add their
   * own second account, and the roster would stop meaning what an owner set
   * it to. Owners themselves are not in this table and cannot be added to it,
   * so no request here can create an owner (auth/roles.ts, migration 0031).
   */

  app.get("/admin/staff", async (c) => {
    await requireOwner(c);
    return respond(c, AdminStaffRosterSchema, await getStaffRoster(getDb(c.env), c.env));
  });

  app.post("/admin/staff", async (c) => {
    const auth = await requireOwner(c);
    const body = await parseBody(c, AdminAddStaffRequestSchema);
    const db = getDb(c.env);
    // No users lookup, and that is the point: an owner names the teaching
    // staff before the term starts, when none of them have signed in. The
    // response reports whether an account exists so a typo is visible.
    await db
      .insert(platformStaff)
      .values({
        login: normalizeLogin(body.login),
        displayLogin: body.login.trim(),
        grantedBy: authorizationLogin(c.env, auth.user),
        grantedAt: Date.now(),
      })
      // Do nothing rather than update: re-adding somebody already on the
      // roster should not rewrite who granted it and when. The first grant is
      // the fact the audit trail exists to keep.
      .onConflictDoNothing();
    return respond(c, AdminStaffRosterSchema, await getStaffRoster(db, c.env));
  });

  app.delete("/admin/staff/:login", async (c) => {
    await requireOwner(c);
    const db = getDb(c.env);
    // Idempotent, like the TA and member removals above: a login that is not
    // on the roster is already in the state the caller asked for.
    await db
      .delete(platformStaff)
      .where(eq(platformStaff.login, normalizeLogin(c.req.param("login"))));
    return respond(c, AdminStaffRosterSchema, await getStaffRoster(db, c.env));
  });
}
