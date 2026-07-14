import type { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import {
  RenameTeamRequestSchema,
  TeamDetailSchema,
} from "@shared/schema";
import type { TeamDetail, TeamMember } from "@shared/schema";
import type { AppEnv } from "../env";
import { requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import type { Database } from "../db/client";
import { teamMembers, teams, users } from "../db/schema";
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
  const [[team], members, [callerMembership]] = await Promise.all([
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
    isAdmin: callerMembership?.role === "admin",
  };
}

export function registerTeamRoutes(app: Hono<AppEnv>): void {
  app.get("/team", async (c) => {
    const auth = await requireTeam(c);
    const detail = await getTeamDetail(getDb(c.env), auth.team.id, auth.user.id);
    return respond(c, TeamDetailSchema, detail);
  });

  app.patch("/team", async (c) => {
    const auth = await requireTeam(c);
    const db = getDb(c.env);
    const [membership] = await db
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
        "Only the team creator can rename the team.",
      );
    }
    const body = await parseBody(c, RenameTeamRequestSchema);
    await db.update(teams).set({ name: body.name }).where(eq(teams.id, auth.team.id));
    return respond(
      c,
      TeamDetailSchema,
      await getTeamDetail(db, auth.team.id, auth.user.id),
    );
  });
}
