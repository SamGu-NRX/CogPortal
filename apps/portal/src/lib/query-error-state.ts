/**
 * What a failed GET query means for the student, expressed as the one thing
 * they can do about it.
 *
 * There are 21 codes in API_ERROR_CODES plus two the client invents, but a
 * student has far fewer moves than that. Most codes only ever attach to a
 * POST or DELETE and never reach this path at all. Grouping by next action
 * instead of by code keeps the number of states a student has to learn equal
 * to the number of things they can actually do.
 *
 * Kept as a pure function, separate from the component, so the mapping is
 * testable without a DOM and so a route cannot quietly grow its own variant.
 */
import { ApiRequestError } from "./api";

export type QueryErrorKind =
  /** The request never left the browser. Retrying is the whole fix. */
  | "unreachable"
  /** The record is not there. Retrying returns the same answer forever. */
  | "missing"
  /** The session stopped being recognized. Signing in again is the fix. */
  | "signin"
  /** Signed in, but this view belongs to a step not finished yet. */
  | "elsewhere"
  /** We received the request and failed to answer it. */
  | "fault";

export type QueryErrorState = {
  kind: QueryErrorKind;
  /**
   * "empty" borrows the vocabulary of a slot with nothing in it, because a
   * 404 is an absence rather than a fault, and the route-level NotFound page
   * already renders that absence as an EmptyState.
   */
  presentation: "panel" | "empty";
  /** Only "fault" is a genuine fault, so only "fault" gets detector red. */
  tone: "default" | "alert";
  /** Mono kicker. Null where the presentation has no header to put it in. */
  label: string | null;
  message: string;
  /** Second line, used where the first line came from the server. */
  nextStep: string | null;
  /**
   * False wherever the same request would fail the same way. A retry button
   * on a 404 makes a promise the button cannot keep.
   */
  retry: boolean;
  /** The way out, when there is a destination the portal can name. */
  link: { to: string; text: string } | null;
  /** A fault interrupts; the rest are announced politely. */
  role: "alert" | "status";
};

const TRY_AGAIN_LATER =
  "If it happens again, tell a TA; this one is ours to fix.";

/**
 * A 404 is reported by status as well as by code, and the two disagree in at
 * least one place: worker/routes/dashboard.ts:39 throws 404 with the code
 * "invalid_request" for a missing benchmark. Reading both means neither has
 * to be correct on its own. Run surfaces also 404 another team's surface on
 * purpose (worker/routes/run-surfaces.ts:19), so "we have no record of this"
 * is the only claim the portal can honestly make about a 404.
 */
function isMissing(error: ApiRequestError): boolean {
  return error.status === 404 || error.code === "not_found";
}

export function queryErrorState(error: unknown): QueryErrorState {
  if (!(error instanceof ApiRequestError)) {
    // Reached when a 200 body fails its Zod contract in lib/api.ts, so the
    // portal has a reply it cannot read and no server-authored reason.
    return {
      kind: "fault",
      presentation: "panel",
      tone: "alert",
      label: "FAILED ON OUR SIDE",
      message:
        "This view couldn't load, and the portal didn't report a reason we can show you.",
      nextStep: TRY_AGAIN_LATER,
      retry: true,
      link: null,
      role: "alert",
    };
  }

  if (error.code === "network") {
    return {
      kind: "unreachable",
      presentation: "panel",
      // Nothing on our side is known to be broken, and the portal only
      // claims what it can see. With status 0 it saw nothing at all.
      tone: "default",
      label: "REQUEST DID NOT ARRIVE",
      message:
        "The request never reached the portal, so nothing was lost. Check your connection, then try again.",
      nextStep: null,
      retry: true,
      link: null,
      role: "status",
    };
  }

  if (isMissing(error)) {
    return {
      kind: "missing",
      presentation: "empty",
      tone: "default",
      label: null,
      // The second sentence is why there is no retry button. Without it the
      // absence of the button reads as something the page forgot.
      message:
        "The portal has no record at this address. Trying again will return the same answer.",
      nextStep: null,
      retry: false,
      link: { to: "/", text: "Back to start" },
      role: "status",
    };
  }

  switch (error.code) {
    case "unauthorized":
      // RequireStage pre-empts a signed-out mount, so this is almost always a
      // session that expired while a tab sat open.
      return {
        kind: "signin",
        presentation: "panel",
        tone: "default",
        label: "SESSION ENDED",
        message:
          "Your session ended, so the portal no longer recognizes this browser. Sign in again to continue.",
        nextStep: null,
        retry: false,
        link: { to: "/signin", text: "Sign in" },
        role: "status",
      };

    case "no_cohort":
      return {
        kind: "elsewhere",
        presentation: "panel",
        tone: "default",
        label: "COHORT REQUIRED",
        message:
          "This view belongs to a cohort, and you haven't joined one yet. Join with the code your instructor shared.",
        nextStep: null,
        retry: false,
        link: { to: "/join", text: "Join a cohort" },
        role: "status",
      };

    case "no_team":
      return {
        kind: "elsewhere",
        presentation: "panel",
        tone: "default",
        label: "TEAM REQUIRED",
        message:
          "This view belongs to a team, and you're not on one yet. Connect a repository and the team exists.",
        nextStep: null,
        retry: false,
        link: { to: "/connect", text: "Connect a repository" },
        role: "status",
      };

    case "forbidden":
      return {
        kind: "elsewhere",
        presentation: "panel",
        tone: "default",
        // Parallel with COHORT REQUIRED and TEAM REQUIRED: all three mean the
        // student is missing something, stated as the thing that is missing.
        label: "ACCESS REQUIRED",
        message:
          "Your account doesn't have access to this view. A TA can grant access if you should have it.",
        nextStep: null,
        retry: false,
        link: { to: "/", text: "Back to start" },
        role: "status",
      };

    default:
      // Every remaining code lands here, including "unknown" and the mutation
      // codes that would only reach a GET by accident. The server wrote a
      // route-specific sentence; it is better than anything generic we could
      // substitute, so it stays as the first line.
      return {
        kind: "fault",
        presentation: "panel",
        tone: "alert",
        label: "FAILED ON OUR SIDE",
        message: error.message,
        nextStep: TRY_AGAIN_LATER,
        retry: true,
        link: null,
        role: "alert",
      };
  }
}
