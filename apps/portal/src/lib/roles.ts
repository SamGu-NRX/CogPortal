import type { Session } from "@cogworks/contracts/schema";

/**
 * Rostered staff and assigned TAs may open the admin console. The Worker's
 * `requireStaff` (worker/auth/roles.ts) admits the same people, so the header
 * tab, the route guard and the default landing all ask this one question.
 */
export function canOpenAdmin(user: NonNullable<Session["user"]>): boolean {
  return user.platformRole === "staff" || user.isTa;
}
