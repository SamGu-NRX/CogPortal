import type { Context, Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { FIXTURE_REPO } from "@cogworks/contracts/fixtures";
import {
  ChangeTeamRepoRequestSchema,
  TeamDetailSchema,
  TeamProcessSignalsSchema,
  UpdateTeamRequestSchema,
} from "@cogworks/contracts/schema";
import type { TeamDetail, TeamMember } from "@cogworks/contracts/schema";
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
import type { CommitRecord, FetchCommitsResult } from "../github/commits";
import { teamRole } from "../github/permissions";
import type { TeamRole } from "../github/permissions";
import { fixtureRepository } from "../github/team";
import type { ConnectRepository } from "../github/team";
import { validateTemplateRepository } from "../github/template";
import { ApiHttpError } from "../http/errors";
import { parseBody, respond } from "../http/respond";
import {
  buildProcessSignals,
  classifyHistoryQuality,
  findingSentences,
} from "../services/process-signals";
import type { RosterMember, RunRecord, WeekLabel } from "../services/process-signals";

function memberRole(role: string): TeamMember["role"] {
  if (role === "admin" || role === "maintain" || role === "write") return role;
  throw new Error("Team member has an invalid role.");
}

/**
 * What to call a member. `github_login` is null for a development account
 * (see routes/session.ts), so the email's local part stands in. One function
 * because the name shown on the team page and the name a co-author trailer
 * resolves to have to be the same string, or the same person reads as two.
 */
function displayLogin(row: { login: string | null; email: string }): string {
  return row.login ?? row.email.split("@")[0];
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
        userId: users.id,
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
    provenance: team.provenance,
    repo: {
      owner: team.repoOwner,
      name: team.repoName,
      fullName: team.repoFullName,
      url: team.repoUrl,
      defaultBranch: team.defaultBranch,
    },
    members: members.map((member) => ({
      login: displayLogin(member),
      name: member.name,
      avatarUrl: member.avatarUrl,
      role: memberRole(member.role),
      isYou: member.userId === callerId,
    })),
    tas: tas.map((ta) => ({
      login: displayLogin(ta),
      name: ta.name,
      avatarUrl: ta.avatarUrl,
    })),
    isAdmin: callerMembership?.role === "admin",
  };
}

/**
 * The caller's role, re-read from GitHub and written back. The team read and
 * every settings gate use it, so the controls and the gate agree.
 *
 * A stored role can be stale or never verified: a portal add stores "write"
 * without asking GitHub, because it does not make anyone a collaborator.
 * When GitHub can't be asked, the stored role stands, so the page renders
 * through an outage and an admin confirmed earlier keeps settings; only a
 * successful read writes "admin". The local fixture has no one to ask.
 */
export async function reconcileTeamRole(
  c: Context<AppEnv>,
  auth: AuthState & { team: TeamRow },
): Promise<{
  role: TeamRole;
  checked: "github" | "unreachable" | "not_asked" | "repository_changed";
}> {
  const db = getDb(c.env);
  const member = and(eq(teamMembers.teamId, auth.team.id), eq(teamMembers.userId, auth.user.id));
  const [membership] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(member)
    .limit(1);
  if (!membership) throw new ApiHttpError(403, "no_team", "Connect a repository to continue.");
  const stored = memberRole(membership.role);

  const githubLogin = auth.user.githubLogin;
  if (
    (auth.team.repoFullName === FIXTURE_REPO.fullName && devAuthAvailable(c.env)) ||
    !githubConfigured(c.env) ||
    !githubLogin
  ) {
    return { role: stored, checked: "not_asked" };
  }
  const githubToken = await getGithubToken(authFor(c), auth.user.id, c.req.raw.headers);
  if (!githubToken) return { role: stored, checked: "unreachable" };
  let permission: string;
  try {
    permission = await new RealGitHubClient().getPermission(
      auth.team.repoFullName,
      githubLogin,
      githubToken,
    );
  } catch {
    return { role: stored, checked: "unreachable" };
  }
  // Read, triage or no access still leaves them on the team in the portal;
  // "write" is the lowest role a membership row can hold.
  const current = teamRole(permission) ?? "write";
  // The answer is about the repository the team had when we asked. If a
  // switch landed while GitHub was answering, it reset the roles for the new
  // repository, and this answer must neither overwrite that nor pass the
  // gate, even when it matches the role stored before the switch.
  const [written] = await db
    .update(teamMembers)
    .set({ role: current })
    .where(and(
      member,
      inArray(
        teamMembers.teamId,
        db
          .select({ id: teams.id })
          .from(teams)
          .where(and(eq(teams.id, auth.team.id), eq(teams.repoFullName, auth.team.repoFullName))),
      ),
    ))
    .returning({ role: teamMembers.role });
  if (!written) return { role: "write", checked: "repository_changed" };
  return { role: current, checked: "github" };
}

export async function requireTeamAdmin(
  c: Context<AppEnv>,
): Promise<AuthState & { team: TeamRow }> {
  return adminOrRefuse(c, await requireTeam(c));
}

/**
 * The gate for a change to team settings or people: the caller is an admin
 * of the team the page showed, which is still their team.
 *
 * None of these requests named a team; the server applied them to whoever the
 * cookie said was signed in. A window left visible while another signed in as
 * someone else (RestoreGate rechecks only on hide, return and focus) renamed
 * the second account's team from a page showing the first's. The id is
 * compared before the GitHub role check, which can rewrite the stored role,
 * so a mismatch has no side effect. A request without it comes from a page
 * older than this field and is refused rather than guessed at.
 */
export async function requireAdminOfShownTeam(
  c: Context<AppEnv>,
  shownTeamId: string | undefined,
): Promise<AuthState & { team: TeamRow }> {
  const auth = await requireTeam(c);
  if (!shownTeamId) {
    throw new ApiHttpError(409, "invalid_request", "This page is out of date. Reload it and try again.");
  }
  if (shownTeamId !== auth.team.id) {
    throw new ApiHttpError(
      409,
      "already_on_team",
      `You're on ${auth.team.name} now, not the team this page showed. Reload to see it.`,
    );
  }
  return adminOrRefuse(c, auth);
}

async function adminOrRefuse(
  c: Context<AppEnv>,
  auth: AuthState & { team: TeamRow },
): Promise<AuthState & { team: TeamRow }> {
  const { role, checked } = await reconcileTeamRole(c, auth);
  if (role === "admin") return auth;
  const repository = auth.team.repoFullName;
  const refusals: Record<typeof checked, string> = {
    github: `Team settings follow admin on ${repository}, and GitHub doesn't list you as an admin there. Ask the repository's owner to make this change.`,
    unreachable: `Team settings follow admin on ${repository}, and GitHub didn't answer when we checked yours. Try again in a moment; if it keeps happening, sign out and sign in with GitHub again.`,
    repository_changed: "The team's repository changed while we checked your role. Reload the team page and try again.",
    not_asked: "Only a team admin can change team settings.",
  };
  throw new ApiHttpError(403, "forbidden", refusals[checked]);
}

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

const MODULE_WEEK_LABELS: Record<string, WeekLabel> = {
  audio: "week1",
  vision: "week2",
  language: "week3",
};

/** Reading history costs up to 41 of a Worker's 50 subrequests. */
const COMMIT_HISTORY_CACHE_MS = 30 * 60 * 1000;

/** Below D1's 2,000,000-byte row limit, which 40 commits of 300 long paths
 *  can pass. A failed write would fail the response, so larger history is
 *  used without being stored. */
const MAX_STORED_HISTORY_BYTES = 1_000_000;

/**
 * `team_process_signals.signals_json` holds only GitHub history. Signals also
 * depend on runs, and caching them hid a team's first scored run. Repository
 * and branch are checked on read, so a read that lands after a repository
 * switch is never served; any other shape is a miss.
 *
 * The read time lives in `checkedAt`, and the row's `computed_at` is written
 * as 0. The route before this format served any row younger than 30 minutes
 * as a complete response, so a rolled-back Worker would have failed the team
 * panel on these rows; with 0 it treats them as expired and recomputes.
 */
const StoredCommitHistorySchema = z.object({
  kind: z.literal("commit-history.v1"),
  repository: z.string(),
  branch: z.string(),
  checkedAt: z.number(),
  // Only successful reads; see `readCommitHistory`. A failure row written
  // before that rule is a miss.
  result: z.object({
    ok: z.literal(true),
    commits: z.array(z.object({
      sha: z.string(),
      authorLogin: z.string(),
      authoredAt: z.number(),
      filesChanged: z.array(z.string()),
      coAuthors: z.array(z.object({ name: z.string(), email: z.string() })),
    }) satisfies z.ZodType<CommitRecord>),
    truncated: z.boolean(),
  }),
});

async function readCommitHistory(
  c: Context<AppEnv>,
  db: Database,
  team: { id: string; repoFullName: string; defaultBranch: string },
  userId: string,
): Promise<{ result: FetchCommitsResult; checkedAt: number }> {
  const now = Date.now();
  const [cached] = await db
    .select()
    .from(teamProcessSignals)
    .where(eq(teamProcessSignals.teamId, team.id))
    .limit(1);
  if (cached) {
    let json: unknown = null;
    try {
      json = JSON.parse(cached.signalsJson);
    } catch {
      // A malformed row is a miss like any other.
    }
    const stored = StoredCommitHistorySchema.safeParse(json);
    if (
      stored.success
      && now - stored.data.checkedAt < COMMIT_HISTORY_CACHE_MS
      && stored.data.repository === team.repoFullName
      && stored.data.branch === team.defaultBranch
    ) {
      return { result: stored.data.result, checkedAt: stored.data.checkedAt };
    }
  }

  let result: FetchCommitsResult;
  if (team.repoFullName === FIXTURE_REPO.fullName && devAuthAvailable(c.env)) {
    // The dev fixture repo isn't a real GitHub repository, so there is no
    // commit history to fetch -- and nothing to honestly call "fetch
    // failed" either, since we never tried and failed. Confirmed-empty is
    // the accurate state here, not a fabricated one.
    result = { ok: true, commits: [], truncated: false };
  } else {
    const githubToken = githubConfigured(c.env)
      ? await getGithubToken(authFor(c), userId, c.req.raw.headers)
      : null;
    result = githubToken
      ? await fetchCommitHistory(team.repoFullName, team.defaultBranch, githubToken)
      : { ok: false, reason: "fetch_failed" };
  }

  // History is stored for the whole team, and any failure can belong to this
  // caller alone: no token or a failed token lookup, an expired sign-in (401),
  // their token's rate limit, or a private repository their token cannot see
  // (404). Stored, it would hide a teammate's good read for thirty minutes.
  if (result.ok) {
    const signalsJson = JSON.stringify({
      kind: "commit-history.v1",
      repository: team.repoFullName,
      branch: team.defaultBranch,
      checkedAt: now,
      result,
    } satisfies z.infer<typeof StoredCommitHistorySchema>);
    const historyQuality = classifyHistoryQuality(result.commits);
    if (new TextEncoder().encode(signalsJson).byteLength <= MAX_STORED_HISTORY_BYTES) {
      try {
        await db
          .insert(teamProcessSignals)
          .values({ teamId: team.id, computedAt: 0, signalsJson, historyQuality })
          .onConflictDoUpdate({
            target: teamProcessSignals.teamId,
            set: { computedAt: 0, signalsJson, historyQuality },
          });
      } catch (error) {
        // The cache is optional; fetched history still answers this visit.
        console.warn("Team commit history cache write failed", error);
      }
    }
  }
  return { result, checkedAt: now };
}

/**
 * Runs that stand as evidence for the repository the team has connected.
 *
 * Only runs recorded against that repository. A run with another repository's
 * id is another repository's evidence, and `runs.repository_id` arrived in
 * migration 0013 with no backfill, so an older run has NULL here and cannot
 * be tied to this one either.
 *
 * Dropping them is right and is not the whole answer: with nothing left,
 * `firstLight` says "No run has scored end to end yet", which a team with five
 * scored runs reads as the portal losing their work. `hasRunsElsewhere` below
 * is what lets the panel say the true thing instead.
 */
function forConnectedRepository(repositoryId: number | null) {
  // No repository id means no repository for a run to be evidence for.
  if (repositoryId === null) return sql`0 = 1`;
  return eq(runs.repositoryId, repositoryId);
}

/**
 * The difference between "you have not scored yet" and "your scored runs are not
 * from this repository" is the whole of what the panel gets wrong without this,
 * and the portal can see which is true.
 */
export async function hasRunsElsewhere(
  db: Database,
  teamId: string,
  repositoryId: number | null,
): Promise<boolean> {
  const [other] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.teamId, teamId),
        eq(runs.status, "succeeded"),
        repositoryId === null
          ? undefined
          : or(isNull(runs.repositoryId), ne(runs.repositoryId, repositoryId)),
      ),
    )
    .limit(1);
  return Boolean(other);
}

/**
 * A team's week is inferred from the benchmark module of its single most
 * recent run for its connected repository (any status -- an in-progress or
 * failed run still tells you which week the team is working in). `null` when
 * no run can speak for that repository; `buildProcessSignals` treats that as
 * "no stage map is knowable" rather than guessing one, matching the "never
 * interpolate" rule from `docs/design/the-instrument-not-the-judge.md`.
 */
export async function resolveWeekLabel(
  db: Database,
  teamId: string,
  repositoryId: number | null,
): Promise<WeekLabel | null> {
  const [latest] = await db
    .select({ module: benchmarks.module })
    .from(runs)
    .innerJoin(
      benchmarks,
      and(eq(benchmarks.id, runs.benchmarkId), eq(benchmarks.version, runs.benchmarkVersion)),
    )
    .where(and(eq(runs.teamId, teamId), forConnectedRepository(repositoryId)))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return latest ? (MODULE_WEEK_LABELS[latest.module] ?? null) : null;
}

/**
 * Runs that count toward `firstLight`: only ones that made it all the way
 * through scoring, and only for the connected repository (see
 * `forConnectedRepository`). A scored run is `status = 'succeeded'` at its
 * `finishedAt`, the convention `team-nudges.ts` already uses.
 */
export async function scoredRunRecords(
  db: Database,
  teamId: string,
  repositoryId: number | null,
): Promise<RunRecord[]> {
  const scored = await db
    .select({ id: runs.id, finishedAt: runs.finishedAt })
    .from(runs)
    .where(and(
      eq(runs.teamId, teamId),
      forConnectedRepository(repositoryId),
      eq(runs.status, "succeeded"),
    ));
  return scored
    .filter((run): run is { id: string; finishedAt: number } => run.finishedAt !== null)
    .map((run) => ({ runId: run.id, finishedAt: run.finishedAt, scored: true }));
}

/**
 * The team, as co-author resolution needs it. A `Co-authored-by:` trailer
 * names a person by GitHub login or by email address, and only this layer
 * knows which of those belong to this team; the fetch that reads the
 * trailers (`../github/commits.ts`) has no roster to check them against.
 */
async function teamRoster(db: Database, teamId: string): Promise<RosterMember[]> {
  const rows = await db
    .select({ login: users.githubLogin, email: users.email })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId));
  return rows.map((row) => ({ login: displayLogin(row), email: row.email }));
}

export function registerTeamRoutes(app: Hono<AppEnv>): void {
  app.get("/team", async (c) => {
    const auth = await requireTeam(c);
    await reconcileTeamRole(c, auth);
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

    const [history, weekLabel, runRecords, roster, runsElsewhere] = await Promise.all([
      readCommitHistory(c, db, auth.team, auth.user.id),
      resolveWeekLabel(db, teamId, auth.team.repoId),
      scoredRunRecords(db, teamId, auth.team.repoId),
      teamRoster(db, teamId),
      hasRunsElsewhere(db, teamId, auth.team.repoId),
    ]);
    const signals = buildProcessSignals({
      commitsResult: history.result,
      runs: runRecords,
      weekLabel,
      roster,
      runsElsewhere,
    });
    return respond(c, TeamProcessSignalsSchema, {
      historyQuality: signals.historyQuality,
      historyWindow: signals.historyWindow,
      weekLabel: signals.weekLabel,
      stageFootprint: signals.stageFootprint,
      firstLight: signals.firstLight,
      boundaryChurn: signals.boundaryChurn,
      ownershipBreadth: signals.ownershipBreadth,
      findingSentences: findingSentences(signals),
      computedAt: history.checkedAt,
    });
  });

  app.patch("/team", async (c) => {
    const body = await parseBody(c, UpdateTeamRequestSchema);
    const auth = await requireAdminOfShownTeam(c, body.teamId);
    const db = getDb(c.env);
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
    const body = await parseBody(c, ChangeTeamRepoRequestSchema);
    const auth = await requireAdminOfShownTeam(c, body.teamId);
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
      // Settings follow admin on the connected repository, so a move to one
      // the actor only writes to locks the actor out of the team's settings
      // and can leave nobody able to manage them.
      const permission = teamRole(
        await client.getPermission(body.fullName, githubLogin, githubToken),
      );
      if (permission !== "admin") {
        throw new ApiHttpError(
          403,
          "forbidden",
          `Team settings follow admin on the connected repository, so moving the team to ${body.fullName} needs admin there too. Pick a repository you own or administer on GitHub.`,
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

    // One batch, so no reader sees the new repository alongside the cached
    // history or the stored roles that belonged to the previous one.
    try {
      await db.batch([
        db
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
          .where(eq(teams.id, auth.team.id)),
        // The cached history is the repository that was connected a moment
        // ago. Serving it for another thirty minutes shows the old
        // repository's stages and commits under the new repository's name.
        db.delete(teamProcessSignals).where(eq(teamProcessSignals.teamId, auth.team.id)),
        // Stored roles were GitHub's answer about the previous repository.
        // The actor was just checked against this one; everyone else holds
        // "write" until their next team read asks GitHub about it.
        db
          .update(teamMembers)
          .set({ role: sql`CASE WHEN ${teamMembers.userId} = ${auth.user.id} THEN 'admin' ELSE 'write' END` })
          .where(eq(teamMembers.teamId, auth.team.id)),
      ]);
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
