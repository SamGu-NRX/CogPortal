import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { PlatformRole } from "@cogworks/contracts/schema";
import type { AppEnv, Env } from "../env";
import { ApiHttpError } from "../http/errors";
import { getDb } from "../db/client";
import { teamTas } from "../db/schema";
import { githubAuthorizationLogin, requireUser } from "./session";
import type { AuthState } from "./session";

function configuredLogins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isPlatformOwner(env: Env, login: string): boolean {
  return configuredLogins(env.PLATFORM_OWNER_LOGINS).has(login.trim().toLowerCase());
}

export function platformRole(env: Env, login: string): PlatformRole {
  const normalizedLogin = login.trim().toLowerCase();
  const isStaff = configuredLogins(env.PLATFORM_STAFF_LOGINS).has(normalizedLogin);
  return isStaff || isPlatformOwner(env, normalizedLogin) ? "staff" : "student";
}

export async function requireStaff(c: Context<AppEnv>): Promise<AuthState> {
  const auth = await requireUser(c);
  const [assignment] = await getDb(c.env)
    .select({ teamId: teamTas.teamId })
    .from(teamTas)
    .where(eq(teamTas.userId, auth.user.id))
    .limit(1);
  if (
    platformRole(c.env, githubAuthorizationLogin(auth.user)) !== "staff" &&
    !assignment
  ) {
    throw new ApiHttpError(403, "forbidden", "Staff access required.");
  }
  return auth;
}
