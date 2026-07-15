import type { Context, Hono } from "hono";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import {
  ChangeTeamRepoRequestSchema,
  TeamDetailSchema,
  UpdateTeamRequestSchema,
} from "@cogworks/contracts/schema";
import type { TeamDetail, TeamMember } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { githubConfigured } from "../env";
import { requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import type { Database } from "../db/client";
import { runs, teamMembers, teamTas, teams, users } from "../db/schema";
import type { AuthState } from "../auth/session";
import type { TeamRow } from "../db/schema";
import { RealGitHubClient } from "../github/client";
import { teamRole } from "../github/permissions";
import { fixtureRepository } from "../github/team";
import type { ConnectRepository } from "../github/team";
import { validateTemplateRepository } from "../github/template";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";

function memberRole(role: string): TeamMember["role"] {
  if (role === "admin" || role === "maintain" || role === "write") return role;
  throw new Error("Team member has an invalid role.");
}

async function getTeamDetail(
  db: Database,
  teamId: string,
  callerId: string,
): Promise<TeamDetail> {
  const [[team], members, tas, [callerMembership]] = await Promise.all([
    db.select().from(teams).where(eq(teams.id, teamId)).limit(1),
    db
      .select({
        login: users.githubLogin,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: teamMembers.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(teamMembers.role), asc(users.githubLogin)),
    db
      .select({
        login: users.githubLogin,
        name: users.name,
        avatarUrl: users.avatarUrl,
      })
      .from(teamTas)
      .innerJoin(users, eq(teamTas.userId, users.id))
      .where(eq(teamTas.teamId, teamId))
      .orderBy(asc(users.githubLogin)),
    db
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, callerId),
        ),
      )
      .limit(1),
  ]);

  if (!team) throw new ApiHttpError(404, "not_found", "Team not found.");
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    repo: {
      owner: team.repoOwner,
      name: team.repoName,
      fullName: team.repoFullName,
      url: team.repoUrl,
      defaultBranch: team.defaultBranch,
    },
    members: members.map((member) => ({
      login: member.login,
      name: member.name,
      avatarUrl: member.avatarUrl,
      role: memberRole(member.role),
    })),
    tas,
    isAdmin: callerMembership?.role === "admin",
  };
}

async function requireTeamAdmin(
  c: Context<AppEnv>,
): Promise<AuthState & { team: TeamRow }> {
  const auth = await requireTeam(c);
  const [membership] = await getDb(c.env)
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, auth.team.id),
        eq(teamMembers.userId, auth.user.id),
      ),
    )
    .limit(1);
  if (membership?.role !== "admin") {
    throw new ApiHttpError(
      403,
      "forbidden",
      "Only the team creator can change team settings.",
    );
  }
  return auth;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

export function registerTeamRoutes(app: Hono<AppEnv>): void {
  app.get("/team", async (c) => {
    const auth = await requireTeam(c);
    const detail = await getTeamDetail(getDb(c.env), auth.team.id, auth.user.id);
    return respond(c, TeamDetailSchema, detail);
  });

  app.patch("/team", async (c) => {
    const auth = await requireTeamAdmin(c);
    const db = getDb(c.env);
    const body = await parseBody(c, UpdateTeamRequestSchema);
    const updates: { name?: string; description?: string | null } = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    await db.update(teams).set(updates).where(eq(teams.id, auth.team.id));
    return respond(
      c,
      TeamDetailSchema,
      await getTeamDetail(db, auth.team.id, auth.user.id),
    );
  });

  app.post("/team/repository", async (c) => {
    const auth = await requireTeamAdmin(c);
    const body = await parseBody(c, ChangeTeamRepoRequestSchema);
    const db = getDb(c.env);
    if (body.fullName === auth.team.repoFullName) {
      return respond(
        c,
        TeamDetailSchema,
        await getTeamDetail(db, auth.team.id, auth.user.id),
      );
    }

    const [activeRun] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.teamId, auth.team.id),
          inArray(runs.status, [
            "queued",
            "preparing",
            "installing",
            "contract_check",
            "evaluating",
            "scoring",
          ]),
        ),
      )
      .limit(1);
    if (activeRun) {
      throw new ApiHttpError(
        409,
        "active_run_exists",
        "Wait for the current run to finish before switching repositories.",
      );
    }

    let repository: ConnectRepository;
    if (body.fullName === FIXTURE_REPO.fullName && c.env.DEV_AUTH === "enabled") {
      repository = fixtureRepository();
    } else {
      if (!githubConfigured(c.env) || !auth.oauthToken) {
        throw new ApiHttpError(
          403,
          "forbidden",
          "Sign in with GitHub to connect a repository.",
        );
      }
      const client = new RealGitHubClient();
      const githubRepository = await client.getRepo(body.fullName, auth.oauthToken);
      if (githubRepository.private) {
        throw new ApiHttpError(
          403,
          "forbidden",
          "Repositories must be public to run the benchmark.",
        );
      }
      const permission = teamRole(
        await client.getPermission(body.fullName, auth.user.githubLogin, auth.oauthToken),
      );
      if (!permission) {
        throw new ApiHttpError(
          403,
          "forbidden",
          "You need write access to run the benchmark for this repository.",
        );
      }
      validateTemplateRepository(c.env, githubRepository);
      repository = {
        id: githubRepository.id,
        sourceRepositoryId: githubRepository.sourceRepositoryId,
        owner: githubRepository.owner.login,
        name: githubRepository.name,
        fullName: `${githubRepository.owner.login}/${githubRepository.name}`,
        url: githubRepository.url,
        defaultBranch: githubRepository.defaultBranch,
        description: githubRepository.description,
      };
    }

    const [claim] = await db
      .select({ name: teams.name })
      .from(teams)
      .where(
        and(
          eq(teams.cohortId, auth.team.cohortId),
          eq(teams.repoFullName, repository.fullName),
          ne(teams.id, auth.team.id),
        ),
      )
      .limit(1);
    if (claim) {
      throw new ApiHttpError(
        403,
        "forbidden",
        `That repository is already connected by team ${claim.name}.`,
      );
    }

    try {
      await db
        .update(teams)
        .set({
          repoOwner: repository.owner,
          repoName: repository.name,
          repoFullName: repository.fullName,
          repoUrl: repository.url,
          defaultBranch: repository.defaultBranch,
          repoId: repository.id,
          templateSourceRepoId: repository.sourceRepositoryId,
        })
        .where(eq(teams.id, auth.team.id));
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const [racingClaim] = await db
          .select({ name: teams.name })
          .from(teams)
          .where(
            and(
              eq(teams.cohortId, auth.team.cohortId),
              eq(teams.repoFullName, repository.fullName),
            ),
          )
          .limit(1);
        throw new ApiHttpError(
          403,
          "forbidden",
          `That repository is already connected by team ${racingClaim?.name ?? "another team"}.`,
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
}
