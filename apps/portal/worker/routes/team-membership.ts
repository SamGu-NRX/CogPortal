import type { Hono } from "hono";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import {
  AddTeamMemberRequestSchema,
  CohortTeamListSchema,
  InvitableUserListSchema,
  JoinTeamRequestSchema,
  TeamDetailSchema,
} from "@cogworks/contracts/schema";
import type { CohortTeam, TeamMember } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { devAuthAvailable, githubConfigured } from "../env";
import { getGithubToken } from "../auth/better-auth";
import { authFor, requireUser } from "../auth/session";
import type { AuthState } from "../auth/session";
import { getDb } from "../db/client";
import type { Database } from "../db/client";
import { teamMembers, teams, users } from "../db/schema";
import { RealGitHubClient } from "../github/client";
import { teamRole } from "../github/permissions";
import type { TeamRole } from "../github/permissions";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import {
  getTeamDetail,
  isUniqueConstraintError,
  requireTeamAdmin,
} from "./team";

type CohortAuth = AuthState & { cohort: NonNullable<AuthState["cohort"]> };

async function requireCohort(c: Parameters<typeof requireUser>[0]): Promise<CohortAuth> {
  const auth = await requireUser(c);
  if (!auth.cohort) throw new ApiHttpError(403, "no_cohort", "Join a cohort first.");
  return { ...auth, cohort: auth.cohort };
}

function memberRole(role: string): TeamMember["role"] {
  if (role === "admin" || role === "maintain" || role === "write") return role;
  throw new Error("Team member has an invalid role.");
}

async function findMembership(db: Database, userId: string) {
  const [membership] = await db
    .select({ teamId: teamMembers.teamId, teamName: teams.name })
    .from(teamMembers)
    .leftJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(asc(teams.name))
    .limit(1);
  return membership;
}

function alreadyOnTeamError(login: string, teamName?: string): ApiHttpError {
  return new ApiHttpError(
    409,
    "already_on_team",
    teamName
      ? `@${login} is already on team ${teamName}.`
      : `@${login} is already on this team.`,
  );
}

function repoAccessRequired(adminLogin: string | null): ApiHttpError {
  return new ApiHttpError(
    403,
    "repo_access_required",
    `Ask ${adminLogin ?? "a team admin"} to add you as a collaborator on GitHub, then accept the invitation GitHub emails you (github.com/notifications) and press Join again. They can also add you here from Team settings.`,
  );
}

export function registerTeamMembershipRoutes(app: Hono<AppEnv>): void {
  app.get("/cohorts/teams", async (c) => {
    const auth = await requireCohort(c);
    const db = getDb(c.env);
    const cohortTeams = await db
      .select()
      .from(teams)
      .where(eq(teams.cohortId, auth.cohort.id))
      .orderBy(asc(teams.name));
    const memberships = cohortTeams.length === 0
      ? []
      : await db
          .select({
            teamId: teamMembers.teamId,
            login: users.githubLogin,
            email: users.email,
            name: users.name,
            avatarUrl: users.image,
            role: teamMembers.role,
          })
          .from(teamMembers)
          .innerJoin(users, eq(teamMembers.userId, users.id))
          .where(inArray(teamMembers.teamId, cohortTeams.map((team) => team.id)))
          .orderBy(asc(teamMembers.role), asc(users.githubLogin));

    const payload: CohortTeam[] = cohortTeams.map((team) => {
      const members = memberships
        .filter((membership) => membership.teamId === team.id)
        .map((membership) => ({
          login: membership.login ?? membership.email.split("@")[0],
          name: membership.name,
          avatarUrl: membership.avatarUrl,
          role: memberRole(membership.role),
        }));
      return {
        id: team.id,
        name: team.name,
        description: team.description,
        repo: { fullName: team.repoFullName, url: team.repoUrl },
        members,
        adminLogin: members.find((member) => member.role === "admin")?.login ?? null,
      };
    });
    return respond(c, CohortTeamListSchema, payload);
  });

  app.post("/team/join", async (c) => {
    const auth = await requireCohort(c);
    const body = await parseBody(c, JoinTeamRequestSchema);
    const db = getDb(c.env);
    const [existingMembership] = await db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, auth.user.id))
      .limit(1);
    if (existingMembership) {
      throw new ApiHttpError(409, "already_on_team", "You are already on a team.");
    }

    const [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.id, body.teamId), eq(teams.cohortId, auth.cohort.id)))
      .limit(1);
    if (!team) throw new ApiHttpError(404, "not_found", "Team not found.");

    const [admin] = await db
      .select({ login: users.githubLogin })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.role, "admin")))
      .orderBy(asc(users.githubLogin))
      .limit(1);
    const adminLogin = admin?.login ?? null;

    let permission: TeamRole;
    if (team.repoFullName === FIXTURE_REPO.fullName && devAuthAvailable(c.env)) {
      permission = "write";
    } else {
      const githubToken = githubConfigured(c.env)
        ? await getGithubToken(authFor(c), auth.user.id, c.req.raw.headers)
        : null;
      const githubLogin = auth.user.githubLogin;
      if (!githubToken || !githubLogin) {
        throw repoAccessRequired(adminLogin);
      }
      const mappedPermission = teamRole(
        await new RealGitHubClient().getPermission(
          team.repoFullName,
          githubLogin,
          githubToken,
        ),
      );
      if (!mappedPermission) throw repoAccessRequired(adminLogin);
      permission = mappedPermission;
    }

    try {
      await db.insert(teamMembers).values({
        teamId: team.id,
        userId: auth.user.id,
        role: permission,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ApiHttpError(409, "already_on_team", "You are already on a team.");
      }
      throw error;
    }
    return respond(
      c,
      TeamDetailSchema,
      await getTeamDetail(db, team.id, auth.user.id),
    );
  });

  app.get("/team/invitable", async (c) => {
    const auth = await requireTeamAdmin(c);
    const invitable = await getDb(c.env)
      .select({
        login: users.githubLogin,
        email: users.email,
        name: users.name,
        avatarUrl: users.image,
      })
      .from(users)
      .leftJoin(teamMembers, eq(teamMembers.userId, users.id))
      .where(and(eq(users.cohortId, auth.team.cohortId), isNull(teamMembers.teamId)))
      .orderBy(asc(users.githubLogin));
    return respond(
      c,
      InvitableUserListSchema,
      invitable.map((user) => ({
        login: user.login ?? user.email.split("@")[0],
        name: user.name,
        avatarUrl: user.avatarUrl,
      })),
    );
  });

  app.post("/team/members", async (c) => {
    const auth = await requireTeamAdmin(c);
    const body = await parseBody(c, AddTeamMemberRequestSchema);
    const db = getDb(c.env);
    const [user] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.githubLogin}) = lower(${body.login})`)
      .limit(1);
    if (!user) {
      throw new ApiHttpError(
        404,
        "user_not_found",
        "No CogPortal account with that GitHub login yet — they need to sign in once first.",
      );
    }
    const githubLogin = user.githubLogin;
    if (!githubLogin) {
      throw new ApiHttpError(404, "not_found", "No CogPortal account has that GitHub login.");
    }
    if (user.cohortId !== auth.team.cohortId) {
      throw new ApiHttpError(403, "not_in_cohort", `@${githubLogin} is not in your cohort.`);
    }

    const membership = await findMembership(db, user.id);
    if (membership) {
      throw alreadyOnTeamError(
        githubLogin,
        membership.teamId === auth.team.id
          ? undefined
          : membership.teamName ?? "another team",
      );
    }

    try {
      await db.insert(teamMembers).values({
        teamId: auth.team.id,
        userId: user.id,
        role: "write",
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const racingMembership = await findMembership(db, user.id);
        throw alreadyOnTeamError(
          githubLogin,
          racingMembership && racingMembership.teamId !== auth.team.id
            ? racingMembership.teamName ?? "another team"
            : undefined,
        );
      }
      throw error;
    }
    return respond(
      c,
      TeamDetailSchema,
      await getTeamDetail(db, auth.team.id, auth.user.id),
    );
  });

  app.delete("/team/members/:login", async (c) => {
    const auth = await requireTeamAdmin(c);
    const db = getDb(c.env);
    const login = c.req.param("login");
    const [membership] = await db
      .select({ userId: teamMembers.userId, role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(
        and(
          eq(teamMembers.teamId, auth.team.id),
          sql`lower(${users.githubLogin}) = lower(${login})`,
        ),
      )
      .limit(1);
    if (!membership) {
      throw new ApiHttpError(404, "not_found", "Team member not found.");
    }
    if (membership.role === "admin") {
      throw new ApiHttpError(
        403,
        "cannot_remove_creator",
        "A team admin cannot be removed here. Change their permission on GitHub instead.",
      );
    }
    await db
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, auth.team.id),
          eq(teamMembers.userId, membership.userId),
        ),
      );
    return respond(
      c,
      TeamDetailSchema,
      await getTeamDetail(db, auth.team.id, auth.user.id),
    );
  });
}
