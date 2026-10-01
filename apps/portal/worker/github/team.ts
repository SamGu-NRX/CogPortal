import { and, eq } from "drizzle-orm";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import type { Database } from "../db/client";
import { teamMembers, teams } from "../db/schema";
import type { TeamRow } from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { newId } from "../util/id";
import type { TeamRole } from "./permissions";

export interface ConnectRepository {
  id: number | null;
  sourceRepositoryId: number | null;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  description: string | null;
}

export function fixtureRepository(): ConnectRepository {
  return {
    id: FIXTURE_REPO.repositoryId,
    sourceRepositoryId: FIXTURE_REPO.repositoryId,
    owner: FIXTURE_REPO.owner,
    name: FIXTURE_REPO.name,
    fullName: FIXTURE_REPO.fullName,
    url: FIXTURE_REPO.url,
    defaultBranch: FIXTURE_REPO.defaultBranch,
    description: FIXTURE_REPO.description,
  };
}

/**
 * Creates the team for `repository` or joins the one that already holds it,
 * storing `permission`, the caller's GitHub permission on the repository.
 *
 * The creator is stored with the same permission as anyone else. Team
 * settings follow admin on the GitHub repository, and a write collaborator
 * who starts the team is not an admin there.
 *
 * `creatorRole` exists for the local fixture repository, which has no GitHub
 * collaborators to ask; its callers pass "admin" so the settings flow can be
 * reached in development.
 */
export async function connectTeam(
  db: Database,
  cohortId: string,
  userId: string,
  repository: ConnectRepository,
  permission: TeamRole,
  teamName: string | undefined,
  creatorRole: TeamRole = permission,
): Promise<TeamRow> {
  let [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.cohortId, cohortId), eq(teams.repoFullName, repository.fullName)))
    .limit(1);
  let membershipRole = permission;
  if (!team) {
    if (!teamName) {
      throw new ApiHttpError(400, "invalid_request", "Choose a team name to create the team.");
    }
    const teamId = newId("team_");
    await db
      .insert(teams)
      .values({
        id: teamId,
        cohortId,
        name: teamName,
        description: repository.description,
        repoOwner: repository.owner,
        repoName: repository.name,
        repoFullName: repository.fullName,
        repoUrl: repository.url,
        defaultBranch: repository.defaultBranch,
        repoId: repository.id,
        templateSourceRepoId: repository.sourceRepositoryId,
      })
      .onConflictDoNothing();
    [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.cohortId, cohortId), eq(teams.repoFullName, repository.fullName)))
      .limit(1);
    if (team?.id === teamId) membershipRole = creatorRole;
  }
  if (!team) throw new ApiHttpError(500, "provider_unconfigured", "Team could not be created.");
  // An existing membership keeps its role: a repeated development demo
  // login lands here, and the team read re-checks every role with GitHub.
  await db
    .insert(teamMembers)
    .values({ teamId: team.id, userId, role: membershipRole })
    .onConflictDoNothing({ target: [teamMembers.teamId, teamMembers.userId] });
  return team;
}
