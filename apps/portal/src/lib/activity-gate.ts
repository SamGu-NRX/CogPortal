import { z } from "zod";

/**
 * The decisions behind the two cards that stand between a student and their
 * team's bench.
 *
 * Both cards used to end with "close this Activity and open it again", because
 * the Activity read its session once at mount and never again. That instruction
 * described the bug: `/activity/session` answers from the session cookie alone,
 * so coming back needs one GET rather than a relaunch.
 */

export const ActivitySessionSchema = z.discriminatedUnion("linked", [
  z.object({ linked: z.literal(false), linkUrl: z.string().url() }),
  z.object({ linked: z.literal("no_team"), portalUrl: z.string().url() }),
  z.object({
    linked: z.literal(true),
    githubLogin: z.string(),
    team: z.object({ id: z.string(), name: z.string(), discordChannelId: z.string().nullable() }),
  }),
]);
export type ActivitySession = z.infer<typeof ActivitySessionSchema>;

/** Which of the two cards a session is standing at. */
export type GateVariant = "link" | "team";

/**
 * `idle` is before the student has opened the portal, `away` is after, and
 * `checking` is while a re-check is in flight. There is no fourth state for
 * "checked and nothing moved": that is a sentence, not a phase.
 */
export type GatePhase = "idle" | "away" | "checking";

/** An API failure that kept its status, because 401 is recoverable differently. */
export class ActivityRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ActivityRequestError";
  }
}

/**
 * Whether a failed request means the Activity's own hour-long session ran out.
 * That is the one failure a button cannot retry, because every later request
 * fails the same way until the Activity is opened again.
 */
export function isExpiredActivitySession(error: unknown): boolean {
  return error instanceof ActivityRequestError && error.status === 401;
}

/**
 * Whether the student actually left for the browser. Discord answers
 * `opened: false` when they backed out of its leave prompt, and `null` on
 * clients older than December 2024, which report no result at all.
 */
export function openedExternally(result: { opened: boolean | null }): boolean {
  return result.opened !== false;
}

/**
 * Where the card goes once Discord reports it opened the link.
 *
 * A check already in flight keeps the card as it is. The reopen link stays
 * pressable during a check, and letting it move the card to `away` cleared the
 * guard that stops a second check, which let an older answer land after a newer
 * one and put a linked student back on the gate.
 */
export function phaseAfterOpen(current: GatePhase): GatePhase {
  return current === "checking" ? current : "away";
}

export type GateOutcome = "linked" | "advanced" | "unchanged";

/**
 * What a re-check found, from the session the student had and the one the
 * portal just returned.
 *
 * `unchanged` is the only outcome that owes the student a sentence. They
 * pressed a button, so a card that looks identical afterwards reads as a broken
 * button. The other two replace the card underneath, which is its own answer.
 */
export function gateOutcome(
  before: ActivitySession["linked"],
  after: ActivitySession["linked"],
): GateOutcome {
  if (after === true) return "linked";
  return before === after ? "unchanged" : "advanced";
}
