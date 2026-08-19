import type { Context, Hono } from "hono";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import {
  ChangeTeamRepoRequestSchema,
  TeamDetailSchema,
  TeamProcessSignalsSchema,
  UpdateTeamRequestSchema,
} from "@cogworks/contracts/schema";
import type { TeamDetail, TeamMember, TeamProcessSignals } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { devAuthAvailable, githubConfigured } from "../env";
import { getGithubToken } from "../auth/better-auth";
import { authFor, requireTeam } from "../auth/session";
import { getDb } from "../db/client";
import type { Database } from "../db/client";
import {
  benchmarks,
  runs,
  teamMembers,
  teamProcessSignals,
  teamTas,
  teams,
  users,
} from "../db/schema";
import type { AuthState } from "../auth/session";
import type { TeamRow } from "../db/schema";
import { RealGitHubClient } from "../github/client";
import { fetchCommitHistory } from "../github/commits";
import { teamRole } from "../github/permissions";
import { fixtureRepository } from "../github/team";
import type { ConnectRepository } from "../github/team";
import { validateTemplateRepository } from "../github/template";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import { buildProcessSignals, findingSentences } from "../services/process-signals";
import type { RunRecord, WeekLabel } from "../services/process-signals";

function memberRole(role: string): TeamMember["role"] {
  if (role === "admin" || role === "maintain" || role === "write") return role;
  throw new Error("Team member has an invalid role.");
}

export async function getTeamDetail(
  db: Database,
  teamId: string,
  callerId: string,
): Promise<TeamDetail> {
  const [[team], members, tas, [callerMembership]] = await Promise.all([
    db.select().from(teams).where(eq(teams.id, teamId)).limit(1),
    db
      .select({
        login: users.githubLogin,
        email: users.email,
        name: users.name,
        avatarUrl: users.image,
        role: teamMembers.role,
      })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(teamMembers.role), asc(users.githubLogin)),
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
      login: member.login ?? member.email.split("@")[0],
      name: member.name,
      avatarUrl: member.avatarUrl,
      role: memberRole(member.role),
    })),
    tas: tas.map((ta) => ({
      login: ta.login ?? ta.email.split("@")[0],
      name: ta.name,
      avatarUrl: ta.avatarUrl,
    })),
    isAdmin: callerMembership?.role === "admin",
  };
}

export async function requireTeamAdmin(
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

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

const MODULE_WEEK_LABELS: Record<string, WeekLabel> = {
  audio: "week1",
  vision: "week2",
  language: "week3",
};

/** How long a cached `team_process_signals` row is served before recomputing. */
const PROCESS_SIGNALS_CACHE_MS = 30 * 60 * 1000;

/**
 * A team's week is inferred from the benchmark module of its single most
 * recent run (any status -- an in-progress or failed run still tells you
 * which week the team is working in). `null` when the team has no runs yet;
 * `buildProcessSignals` treats that as "no stage map is knowable" rather
 * than guessing one, matching the "never interpolate" rule from
 * `docs/design/the-instrument-not-the-judge.md`.
 */
async function resolveWeekLabel(db: Database, teamId: string): Promise<WeekLabel | null> {
  const [latest] = await db
    .select({ module: benchmarks.module })
    .from(runs)
    .innerJoin(
      benchmarks,
      and(eq(benchmarks.id, runs.benchmarkId), eq(benchmarks.version, runs.benchmarkVersion)),
    )
    .where(eq(runs.teamId, teamId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return latest ? (MODULE_WEEK_LABELS[latest.module] ?? null) : null;
}

/**
 * Runs that count toward `firstLight`: only ones that made it all the way
 * through scoring. Mirrors `team-nudges.ts`'s established "scored run"
 * convention (`status = 'succeeded'` and keyed off `finishedAt`, not
 * `createdAt`) rather than re-deriving it -- see the divergence note on
 * `RunRecord` in `../services/process-signals.ts`.
 */
async function scoredRunRecords(db: Database, teamId: string): Promise<RunRecord[]> {
  const scored = await db
    .select({ id: runs.id, finishedAt: runs.finishedAt })
    .from(runs)
    .where(and(eq(runs.teamId, teamId), eq(runs.status, "succeeded")));
  return scored
    .filter((run): run is { id: string; finishedAt: number } => run.finishedAt !== null)
    .map((run) => ({ runId: run.id, createdAt: run.finishedAt, scored: true }));
}

export function registerTeamRoutes(app: Hono<AppEnv>): void {
  app.get("/team", async (c) => {
    const auth = await requireTeam(c);
    const detail = await getTeamDetail(getDb(c.env), auth.team.id, auth.user.id);
    return respond(c, TeamDetailSchema, detail);
  });

  // Team members only, same guard as `GET /team` above (not the admin-only
  // guard `POST /team/repository` uses -- reading process signals isn't a
  // team-settings change).
  app.get("/v1/team/process", async (c) => {
    const auth = await requireTeam(c);
    const db = getDb(c.env);
    const teamId = auth.team.id;
    const now = Date.now();

    const [cached] = await db
      .select()
      .from(teamProcessSignals)
      .where(eq(teamProcessSignals.teamId, teamId))
      .limit(1);
    if (cached && now - cached.computedAt < PROCESS_SIGNALS_CACHE_MS) {
      const signals = JSON.parse(cached.signalsJson) as Omit<TeamProcessSignals, "computedAt">;
      return respond(c, TeamProcessSignalsSchema, { ...signals, computedAt: cached.computedAt });
    }

    const weekLabel = await resolveWeekLabel(db, teamId);
    const runRecords = await scoredRunRecords(db, teamId);

    let commitsResult: Awaited<ReturnType<typeof fetchCommitHistory>>;
    if (auth.team.repoFullName === FIXTURE_REPO.fullName && devAuthAvailable(c.env)) {
      // The dev fixture repo isn't a real GitHub repository, so there is no
      // commit history to fetch -- and nothing to honestly call "fetch
      // failed" either, since we never tried and failed. Confirmed-empty is
      // the accurate state here, not a fabricated one.
      commitsResult = { ok: true, commits: [] };
    } else {
      const githubToken = githubConfigured(c.env)
        ? await getGithubToken(authFor(c), auth.user.id, c.req.raw.headers)
        : null;
      commitsResult = githubToken
        ? await fetchCommitHistory(auth.team.repoFullName, auth.team.defaultBranch, githubToken)
        : { ok: false, reason: "fetch_failed" };
    }

    const signals = buildProcessSignals({ commitsResult, runs: runRecords, weekLabel });
    const payload: Omit<TeamProcessSignals, "computedAt"> = {
      ...signals,
      findingSentences: findingSentences(signals),
    };
    const signalsJson = JSON.stringify(payload);

    await db
      .insert(teamProcessSignals)
      .values({ teamId, computedAt: now, signalsJson, historyQuality: signals.historyQuality })
      .onConflictDoUpdate({
        target: teamProcessSignals.teamId,
        set: { computedAt: now, signalsJson, historyQuality: signals.historyQuality },
      });

    return respond(c, TeamProcessSignalsSchema, { ...payload, computedAt: now });
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
    if (body.fullName === FIXTURE_REPO.fullName && devAuthAvailable(c.env)) {
      repository = fixtureRepository();
    } else {
      const githubToken = githubConfigured(c.env)
        ? await getGithubToken(authFor(c), auth.user.id, c.req.raw.headers)
        : null;
      const githubLogin = auth.user.githubLogin;
      if (!githubToken || !githubLogin) {
        throw new ApiHttpError(
          403,
          "forbidden",
          "Sign in with GitHub to connect a repository.",
        );
      }
      const client = new RealGitHubClient();
      const githubRepository = await client.getRepo(body.fullName, githubToken);
      if (githubRepository.private) {
        throw new ApiHttpError(
          403,
          "forbidden",
          "Repositories must be public to run the benchmark.",
        );
      }
      const permission = teamRole(
        await client.getPermission(body.fullName, githubLogin, githubToken),
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
