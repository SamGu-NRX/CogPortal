import type { Context } from "hono";
import type { PlatformRole } from "@cogworks/contracts/schema";
import type { AppEnv, Env } from "../env";
import { ApiHttpError } from "../http/errors";
import { requireUser } from "./session";
import type { AuthState } from "./session";

export function platformRole(env: Env, login: string): PlatformRole {
  const normalizedLogin = login.trim().toLowerCase();
  const staffLogins = (env.PLATFORM_STAFF_LOGINS ?? "")
    .split(",")
    .map((staffLogin) => staffLogin.trim().toLowerCase())
    .filter(Boolean);
  return staffLogins.includes(normalizedLogin) ? "staff" : "student";
}

export async function requireStaff(c: Context<AppEnv>): Promise<AuthState> {
  const auth = await requireUser(c);
  if (platformRole(c.env, auth.user.githubLogin) !== "staff") {
    throw new ApiHttpError(403, "forbidden", "Staff access required.");
  }
  return auth;
}
