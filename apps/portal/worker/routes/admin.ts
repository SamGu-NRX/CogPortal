import type { Hono } from "hono";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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
  cohorts,
  leaderboardSelections,
  officialAttempts,
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

async function getAdminTeamSummary(
  db: Database,
  teamId: string,
): Promise<AdminTeamSummary> {
  const [[team], members, tas, [practice], [official], [refunds], [published]] = await Promise.all([
    db.select().from(teams).where(eq(teams.id, teamId)).limit(1),
    db
      .select({
        login: users.githubLogin,
        email: users.email,
        name: users.name,
        role: teamMembers.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(eq(teamMembers.teamId, teamId)),
    db
      .select({
        login: users.githubLogin,
        email: users.email,
        name: users.name,
        avatarUrl: users.image,
      })
      .from(teamTas)
      .innerJoin(users, eq(teamTas.userId, users.id))
      .where(eq(teamTas.teamId, teamId))
      .orderBy(asc(users.githubLogin)),
    db
      .select({ value: count() })
      .from(runs)
      .where(and(eq(runs.teamId, teamId), eq(runs.mode, "practice"))),
    db
      .select({ value: count() })
      .from(officialAttempts)
      .where(eq(officialAttempts.teamId, teamId)),
    // Refunds a team has received, counted across benchmarks. Nothing counted
    // these before migration 0029, so a team's total starts at zero on the
    // deploy that added the column even if they were refunded before it.
    db
      .select({ value: count() })
      .from(runs)
      .where(and(eq(runs.teamId, teamId), isNotNull(runs.refundedAt))),
    db
      .select({ value: runMetrics.value })
      .from(leaderboardSelections)
      .innerJoin(
        runMetrics,
        and(
          eq(runMetrics.runId, leaderboardSelections.runId),
          eq(runMetrics.isPrimary, true),
        ),
      )
      .where(eq(leaderboardSelections.teamId, teamId))
      .orderBy(desc(leaderboardSelections.selectedAt))
      .limit(1),
  ]);
  if (!team) throw new ApiHttpError(404, "not_found", "Team not found.");
  const roleOrder: Record<TeamMember["role"], number> = {
    admin: 0,
    maintain: 1,
    write: 2,
  };
  const serializedMembers = members
    .map((member) => ({
      login: member.login ?? member.email.split("@")[0],
      name: member.name,
      role: memberRole(member.role),
    }))
    .sort(
      (left, right) =>
        roleOrder[left.role] - roleOrder[right.role] || left.login.localeCompare(right.login),
    );
  return {
    id: team.id,
    name: team.name,
    provenance: team.provenance,
    repoFullName: team.repoFullName,
    members: serializedMembers,
    tas: tas.map((ta) => ({
      login: ta.login ?? ta.email.split("@")[0],
      name: ta.name,
      avatarUrl: ta.avatarUrl,
    })),
    practiceUsed: practice?.value ?? 0,
    officialUsed: official?.value ?? 0,
    refundsGiven: refunds?.value ?? 0,
    publishedScore: published?.value ?? null,
  };
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
    const live = and(eq(teams.cohortId, cohort.id), eq(teams.provenance, "live"));
    const teamRows = scope.isOwner
      ? await db.select({ id: teams.id }).from(teams).where(live).orderBy(asc(teams.name))
      : scope.teamIds.length > 0
        ? await db.select({ id: teams.id }).from(teams).where(and(live, inArray(teams.id, scope.teamIds))).orderBy(asc(teams.name))
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
    const summaries = await Promise.all(
      teamRows.map((team) => getAdminTeamSummary(db, team.id)),
    );
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
        .select({ id: teams.id, cohortId: teams.cohortId })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1),
      db
        .select({ id: users.id, cohortId: users.cohortId })
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
    try {
      await db.insert(teamMembers).values({ teamId, userId: user.id, role: "write" });
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
          "A team admin cannot be removed here. Change their permission on GitHub instead.",
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
