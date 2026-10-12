import { STAFF_VISIBILITY_SETTINGS } from "@cogworks/contracts/schema";
import type { AdminTeamSummary, StaffView, StaffVisibilitySetting } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { ApiHttpError } from "../http/errors";

/**
 * The one switch for what staff who are not owners read about students
 * (docs/plan/real-user-readiness.md, "Staff visibility is undecided").
 *
 * STAFF_VISIBILITY="assigned-teams" (or unset) keeps today's behaviour: a TA
 * reads their assigned teams' member logins, run counts, latest published
 * score and the process desk's findings. "restricted" is the proposal
 * awaiting the owner: for a TA, student names, scores, metrics and findings
 * are withheld and membership edits are refused, since a TA who cannot see
 * who is on a team cannot sensibly change it. Team-level counts, run states,
 * failure categories and TA names remain.
 *
 * Owners read everything under either setting. Neither setting lets logs,
 * diagnostics or submissions reach a staff surface; those routes are scoped
 * to a team's own members (routes/runs.ts) and are not touched here.
 */
function isSetting(value: string): value is StaffVisibilitySetting {
  return (STAFF_VISIBILITY_SETTINGS as readonly string[]).includes(value);
}

export function staffVisibilitySetting(env: Pick<Env, "STAFF_VISIBILITY">): StaffVisibilitySetting {
  // Widened: callers that skip validateServerEnv (tests) can hand any string.
  const value: string | undefined = env.STAFF_VISIBILITY;
  if (value === undefined || value === "") return "assigned-teams";
  if (isSetting(value)) return value;
  // validateServerEnv refuses other values on every request; this keeps a
  // misspelling loud for callers that bypass it.
  throw new Error(`STAFF_VISIBILITY must be one of ${STAFF_VISIBILITY_SETTINGS.join(", ")}; got ${JSON.stringify(value)}`);
}

export function staffView(env: Pick<Env, "STAFF_VISIBILITY">, scope: { isOwner: boolean }): StaffView {
  if (scope.isOwner) return "full";
  return staffVisibilitySetting(env) === "restricted" ? "restricted" : "full";
}

/** A team summary as a caller with `view` may read it. */
export function summaryForView(summary: AdminTeamSummary, view: StaffView): AdminTeamSummary {
  if (view === "full") return summary;
  return { ...summary, members: [], published: null };
}

/** Membership edits need names; a restricted view has none. */
export function requireMembershipEdits(view: StaffView): void {
  if (view === "restricted") {
    throw new ApiHttpError(
      403,
      "forbidden",
      "Under the restricted staff setting, course owners manage team membership.",
    );
  }
}
