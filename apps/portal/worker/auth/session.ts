import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { AuthConfig, Session, Team } from "@cogworks/contracts/schema";
import type { AppEnv, Env } from "../env";
import {
  devAuthAvailable,
  githubConfigured,
  onboardingDevToolsAvailable,
} from "../env";
import { getDb } from "../db/client";
import { cohorts, teamMembers, teamTas, teams, users } from "../db/schema";
import type { TeamRow } from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { createAuth, requestCf } from "./better-auth";
import { isPlatformOwner, platformRole } from "./roles";

export interface AuthUser {
  id: string;
  email: string;
  githubLogin: string | null;
  name: string | null;
  avatarUrl: string | null;
  cohortId: string | null;
}

export interface AuthState {
  user: AuthUser;
  cohort: { id: string; slug: string; name: string } | null;
  team: TeamRow | null;
}

export function accountLogin(user: { githubLogin: string | null; email: string }): string {
  return user.githubLogin ?? user.email.split("@")[0];
}

/** Authorization must never fall back to an email-derived display name. */
export function githubAuthorizationLogin(user: { githubLogin: string | null }): string {
  return user.githubLogin ?? "";
}

/**
 * The login role checks should use.
 *
 * Deployed, this is the GitHub login and nothing else, for the reason above.
 * Locally it also accepts a dev account's own name, because a dev account
 * cannot hold `github_login` (uniquely indexed, and a real row may already
 * claim the same name), which otherwise made every local account a student and
 * put the admin screens out of reach of testing. The fallback is gated on
 * `devAuthAvailable`, which requires ENVIRONMENT=development, DEV_AUTH=enabled,
 * and GitHub unconfigured, so there is no real identity to impersonate.
 */
export function authorizationLogin(
  env: Env,
  user: { githubLogin: string | null; name?: string | null },
): string {
  if (user.githubLogin) return user.githubLogin;
  return devAuthAvailable(env) ? (user.name ?? "").trim() : "";
}

export function authFor(c: Context<AppEnv>) {
  return createAuth(c.env, requestCf(c.req.raw), new URL(c.req.url).origin);
}

export function forwardAuthCookies(c: Context<AppEnv>, headers: Headers): void {
  for (const cookie of headers.getSetCookie()) {
    c.header("Set-Cookie", cookie, { append: true });
  }
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
    devAuthEnabled: devAuthAvailable(env),
    onboardingDevToolsEnabled: onboardingDevToolsAvailable(env),
    appSlug: env.GITHUB_APP_SLUG ?? null,
    templateRepo: env.GITHUB_TEMPLATE_REPO ?? null,
    executionProvider: env.EXECUTION_PROVIDER,
  };
}

export async function authToSession(env: Env, auth: AuthState | null): Promise<Session> {
  const auth_ = authConfig(env);
  if (!auth) return { user: null, cohort: null, team: null, auth: auth_ };
  const login = accountLogin(auth.user);
  const roleLogin = authorizationLogin(env, auth.user);
  const [taAssignment] = await getDb(env)
    .select({ teamId: teamTas.teamId })
    .from(teamTas)
    .where(eq(teamTas.userId, auth.user.id))
    .limit(1);
  return {
    user: {
      login,
      name: auth.user.name,
      avatarUrl: auth.user.avatarUrl,
      platformRole: platformRole(env, roleLogin),
      isOwner: isPlatformOwner(env, roleLogin),
      isTa: Boolean(taAssignment),
    },
    cohort: auth.cohort ? { slug: auth.cohort.slug, name: auth.cohort.name } : null,
    team: teamPayload(auth.team),
    auth: auth_,
  };
}

export async function getAuth(c: Context<AppEnv>): Promise<AuthState | null> {
  const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;

  const user: AuthUser = {
    id: session.user.id,
    email: session.user.email,
    githubLogin: session.user.githubLogin ?? null,
    name: session.user.name ?? null,
    avatarUrl: session.user.image ?? null,
    cohortId: session.user.cohortId ?? null,
  };

  const db = getDb(c.env);
  const [[cohort], [membership]] = await Promise.all([
    db
      .select({ id: cohorts.id, slug: cohorts.slug, name: cohorts.name })
      .from(users)
      .innerJoin(cohorts, eq(users.cohortId, cohorts.id))
      .where(eq(users.id, user.id))
      .limit(1),
    db
      .select({ team: teams })
      .from(teamMembers)
      .innerJoin(teams, eq(teamMembers.teamId, teams.id))
      .where(eq(teamMembers.userId, user.id))
      .orderBy(teams.id)
      .limit(1),
  ]);

  return {
    user,
    cohort: cohort ?? null,
    team: membership?.team ?? null,
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
