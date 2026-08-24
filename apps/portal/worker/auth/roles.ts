import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { PlatformRole } from "@cogworks/contracts/schema";
import type { AppEnv, Env } from "../env";
import { ApiHttpError } from "../http/errors";
import type { Database } from "../db/client";
import { getDb } from "../db/client";
import { platformStaff, teamTas } from "../db/schema";
import { authorizationLogin, requireUser } from "./session";
import type { AuthState } from "./session";

/**
 * The single normalization every roster path uses.
 *
 * GitHub logins are case-insensitive, so "SamGu-NRX" and "samgu-nrx" are one
 * person. Adding, removing, and checking must therefore agree on one spelling
 * or a row written by one path is invisible to another. Exported so the admin
 * endpoints cannot drift from the check.
 */
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function configuredLogins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map(normalizeLogin)
      .filter(Boolean),
  );
}

/**
 * Owners come from the environment and nowhere else.
 *
 * This is the root of trust, so it deliberately does not read the database.
 * Staff live in the `platform_staff` table (migration 0031) and owners manage
 * that table; if owners lived there too, anyone who could write the table
 * could make themselves an owner, and a database compromise would be an
 * administrative compromise. It is also what makes the roster bootstrappable:
 * on a fresh database the table is empty, and an owner is still staff (see
 * `platformRole`), so somebody can always add the first row.
 */
export function isPlatformOwner(env: Env, login: string): boolean {
  return configuredLogins(env.PLATFORM_OWNER_LOGINS).has(normalizeLogin(login));
}

/**
 * Whether a login is on the owner-managed staff roster.
 *
 * An empty login never reaches the database. `authorizationLogin` returns ""
 * for an account with no GitHub identity outside dev auth, and a query for ""
 * is a round trip that can only ever miss.
 */
export async function isRosteredStaff(db: Database, login: string): Promise<boolean> {
  const normalizedLogin = normalizeLogin(login);
  if (!normalizedLogin) return false;
  const [row] = await db
    .select({ login: platformStaff.login })
    .from(platformStaff)
    .where(eq(platformStaff.login, normalizedLogin))
    .limit(1);
  return Boolean(row);
}

/**
 * Staff if the roster says so, or if the environment says this is an owner.
 *
 * Reads the database, so it takes one. Before migration 0031 the roster was a
 * comma-separated environment variable and this was synchronous; changing who
 * is staff meant editing a Cloudflare secret and redeploying.
 */
export async function platformRole(
  db: Database,
  env: Env,
  login: string,
): Promise<PlatformRole> {
  if (isPlatformOwner(env, login)) return "staff";
  return (await isRosteredStaff(db, login)) ? "staff" : "student";
}

export async function requireStaff(c: Context<AppEnv>): Promise<AuthState> {
  const auth = await requireUser(c);
  const login = authorizationLogin(c.env, auth.user);
  if (isPlatformOwner(c.env, login)) return auth;
  // A team's assigned TA is staff without appearing on the platform roster,
  // which predates this table (migration 0008). Both reads are independent, so
  // they go together rather than one after the other.
  const db = getDb(c.env);
  const [rostered, [assignment]] = await Promise.all([
    isRosteredStaff(db, login),
    db
      .select({ teamId: teamTas.teamId })
      .from(teamTas)
      .where(eq(teamTas.userId, auth.user.id))
      .limit(1),
  ]);
  if (!rostered && !assignment) {
    throw new ApiHttpError(403, "forbidden", "Staff access required.");
  }
  return auth;
}
