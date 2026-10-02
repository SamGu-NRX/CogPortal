import { AdminAddStaffRequestSchema } from "@cogworks/contracts/schema";
import { normalizeLogin } from "./roles";

/**
 * The one-time move of a deployment's `PLATFORM_STAFF_LOGINS` into
 * `platform_staff`, as SQL for `wrangler d1 execute --file`.
 *
 * Code before migration 0031 read the staff roster from that variable; this
 * code reads only the table, which 0031 creates empty. A deployment upgrading
 * across 0031 therefore loses every non-owner instructor who is not also a
 * team's TA unless the roster is copied in between applying the migrations
 * and deploying the Worker. Old code ignores the table, so copying first
 * costs nobody access.
 *
 * Nothing reads the variable at runtime. A fallback there would re-grant, on
 * every request, anyone an owner later removed in the admin console, which
 * would make the table's revocations meaningless. That is also why this runs
 * once, by hand, and only while no table-reading Worker has ever served the
 * database. The schema cannot say that (0031 can be applied while the old
 * Worker still serves), so the operator decides from the deployed Worker and
 * the release record (docs/how-to/deploy-your-own.md, "Moving the staff
 * roster"). Once a table-reading Worker has served, owners may have removed
 * people on purpose. `ON CONFLICT DO NOTHING` keeps any row already present,
 * like the console's own add, so repeating an interrupted copy is harmless.
 *
 * Each login goes through the console's own request schema and normalization
 * (`routes/admin.ts`, POST /admin/staff), so an imported row is the row an
 * owner typing the same login would have made. Owners are left out because
 * they are staff from the environment and are never rows in this table.
 */

/** The `granted_by` an imported row carries, so the console's audit column
 *  says where it came from rather than naming an owner who never granted it. */
export const STAFF_IMPORT_GRANTED_BY = "import:PLATFORM_STAFF_LOGINS";

export class StaffImportError extends Error {}

function entries(list: string): string[] {
  return list.split(/[,\s]+/).map((login) => login.trim()).filter(Boolean);
}

export function staffImportSql(roster: string, owners: string, grantedAt: number): string {
  if (!Number.isSafeInteger(grantedAt) || grantedAt <= 0) {
    throw new StaffImportError("grantedAt must be a positive millisecond timestamp.");
  }
  const ownerLogins = new Set(entries(owners).map(normalizeLogin));
  const rows = new Map<string, string>();
  for (const typed of entries(roster)) {
    if (!AdminAddStaffRequestSchema.safeParse({ login: typed }).success) {
      throw new StaffImportError(`"${typed}" is not a GitHub login; nothing was written.`);
    }
    const login = normalizeLogin(typed);
    // The first spelling wins, as it would in the console.
    if (!ownerLogins.has(login) && !rows.has(login)) rows.set(login, typed);
  }
  if (!rows.size) {
    throw new StaffImportError("The roster has no logins besides owners; there is nothing to import.");
  }
  // The schema allows only letters, digits and hyphens, so nothing here needs
  // quoting beyond the surrounding quotes.
  const values = [...rows].map(([login, display]) =>
    `('${login}', '${display}', '${STAFF_IMPORT_GRANTED_BY}', ${grantedAt})`);
  return "INSERT INTO platform_staff (login, display_login, granted_by, granted_at) VALUES\n  "
    + values.join(",\n  ")
    + "\nON CONFLICT(login) DO NOTHING;\n";
}
