import type { Session } from "@cogworks/contracts/schema";

/**
 * Pure route-guard decisions, extracted from App.tsx so they can be
 * contract-tested without a DOM. The React components apply these decisions
 * and keep the router wiring (Navigate, sessionStorage) at the edge.
 */

/** What a guarded route demands before it renders, in dependency order: a
 *  signed-in user, then a cohort, then a team. */
export type StageRequirement = "user" | "cohort" | "team";

/** What a guard decides for the current location. "remember-and-redirect"
 *  first stores a /connections return target, then redirects. */
export type RouteGuardDecision =
  | { readonly action: "render" }
  | { readonly action: "redirect"; readonly to: string }
  | {
      readonly action: "remember-and-redirect";
      readonly to: string;
      readonly returnTo: string;
    };

/** A signed-out visitor on the /connections route is mid Discord/CLI flow;
 *  those URLs carry the flow's query and hash, so they are the ones worth
 *  remembering before sign-in. Only the exact route matches. */
function isConnectionsReturnPath(path: string): boolean {
  return (
    path === "/connections" ||
    path.startsWith("/connections?") ||
    path.startsWith("/connections#")
  );
}

/**
 * Where a stage-guarded route sends the current session: a replacement path,
 * or null when the children may render. `path` is the full in-app path as
 * React Router spells it (pathname plus search plus hash), so a signed-out
 * /connections visit can be remembered whole.
 */
export function stageGuardDecision(
  stage: StageRequirement,
  path: string,
  session: Session | null | undefined,
): RouteGuardDecision {
  if (!session?.user) {
    if (isConnectionsReturnPath(path)) {
      return {
        action: "remember-and-redirect",
        to: "/signin",
        returnTo: path,
      };
    }
    return { action: "redirect", to: "/signin" };
  }
  if (stage !== "user" && !session.cohort) {
    return { action: "redirect", to: "/join" };
  }
  if (stage === "team" && !session.team) {
    return { action: "redirect", to: "/connect" };
  }
  return { action: "render" };
}

/** The admin gate. Staff and TAs pass; everyone else, signed in or not, is
 *  sent somewhere they can actually see. An unknown platformRole fails
 *  closed: only "staff" or a true isTa grants entry. */
export function staffGuardDecision(
  session: Session | null | undefined,
): RouteGuardDecision {
  if (!session?.user) return { action: "redirect", to: "/signin" };
  if (session.user.platformRole !== "staff" && !session.user.isTa) {
    return { action: "redirect", to: "/" };
  }
  return { action: "render" };
}

/**
 * Where the student's onboarding actually stands (plan §1 success path):
 * sign in → join cohort → connect repository → dashboard. Role fields
 * (platformRole, isTa) are deliberately ignored; staff and students walk
 * the same stages.
 */
export function nextStagePath(session: Session): string {
  if (session === null || typeof session !== "object") {
    const received = session === null ? "null" : typeof session;
    throw new TypeError(
      `nextStagePath: expected a Session object from the session endpoint, received ${received}`,
    );
  }
  if (!session.user) return "/signin";
  if (!session.cohort) return "/join";
  if (!session.team) return "/connect";
  return "/dashboard";
}
