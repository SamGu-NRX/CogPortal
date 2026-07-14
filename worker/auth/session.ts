import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, gt } from "drizzle-orm";
import type { AuthConfig, Session, Team } from "@shared/schema";
import type { AppEnv, Env } from "../env";
import { githubConfigured } from "../env";
import { getDb } from "../db/client";
import { cohorts, sessions, teamMembers, teams, users } from "../db/schema";
import type { TeamRow } from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { randomHex } from "../util/id";

export const SESSION_COOKIE = "cogportal_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
  cohortId: string | null;
}

export interface AuthState {
  user: AuthUser;
  cohort: { id: string; slug: string; name: string } | null;
  team: TeamRow | null;
  oauthToken: string | null;
}

function teamPayload(team: TeamRow | null): Team | null {
  if (!team) return null;
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
  };
}

/** Which identity paths this deployment exposes (shared AuthConfig). */
export function authConfig(env: Env): AuthConfig {
  return {
    githubConfigured: githubConfigured(env),
    devAuthEnabled: env.DEV_AUTH === "enabled",
    appSlug: env.GITHUB_APP_SLUG ?? null,
    templateRepo: env.GITHUB_TEMPLATE_REPO ?? null,
  };
}

export function authToSession(env: Env, auth: AuthState | null): Session {
  const auth_ = authConfig(env);
  if (!auth) return { user: null, cohort: null, team: null, auth: auth_ };
  return {
    user: {
      login: auth.user.githubLogin,
      name: auth.user.name,
      avatarUrl: auth.user.avatarUrl,
    },
    cohort: auth.cohort ? { slug: auth.cohort.slug, name: auth.cohort.name } : null,
    team: teamPayload(auth.team),
    auth: auth_,
  };
}

export async function getAuth(c: Context<AppEnv>): Promise<AuthState | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const db = getDb(c.env);
  const [row] = await db
    .select({
      user: users,
      oauthToken: sessions.oauthToken,
      cohortId: cohorts.id,
      cohortSlug: cohorts.slug,
      cohortName: cohorts.name,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .leftJoin(cohorts, eq(users.cohortId, cohorts.id))
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, Date.now())))
    .limit(1);

  if (!row) return null;

  const [membership] = await db
    .select({ team: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, row.user.id))
    .orderBy(teams.id)
    .limit(1);

  return {
    user: row.user,
    cohort:
      row.cohortId && row.cohortSlug && row.cohortName
        ? { id: row.cohortId, slug: row.cohortSlug, name: row.cohortName }
        : null,
    team: membership?.team ?? null,
    oauthToken: row.oauthToken,
  };
}

export async function requireUser(c: Context<AppEnv>): Promise<AuthState> {
  const auth = await getAuth(c);
  if (!auth) throw new ApiHttpError(401, "unauthorized", "Sign in to continue.");
  return auth;
}

export async function requireTeam(c: Context<AppEnv>): Promise<AuthState & { team: TeamRow }> {
  const auth = await requireUser(c);
  if (!auth.team) throw new ApiHttpError(403, "no_team", "Connect a repository to continue.");
  return { ...auth, team: auth.team };
}

export async function createSession(
  c: Context<AppEnv>,
  userId: string,
  oauthToken?: string,
): Promise<void> {
  const now = Date.now();
  const id = randomHex(32);
  await getDb(c.env).insert(sessions).values({
    id,
    userId,
    oauthToken,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
    expires: new Date(now + SESSION_TTL_MS),
    secure: new URL(c.req.url).protocol === "https:",
  });
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await getDb(c.env).delete(sessions).where(eq(sessions.id, token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
