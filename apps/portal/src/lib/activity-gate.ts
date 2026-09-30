import { z } from "zod";

/**
 * The decisions behind the two cards that stand between a student and their
 * team's bench. `/activity/session` answers from the session cookie alone, so
 * coming back from the browser needs one GET rather than a relaunch.
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

export type GateVariant = "link" | "team";

/** No fourth phase for "checked and nothing moved": that is a sentence, not a place. */
export type GatePhase = "idle" | "away" | "checking";

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
 * 401 is the one failure a button cannot retry, because every later request
 * fails the same way until the Activity is opened again.
 */
export function isExpiredActivitySession(error: unknown): boolean {
  return error instanceof ActivityRequestError && error.status === 401;
}

/**
 * Discord answers `opened: false` when the student backed out of its leave
 * prompt, and `null` on clients older than December 2024, which report no
 * result at all. Only an explicit `false` means they never went.
 */
export function openedExternally(result: { opened: boolean | null }): boolean {
  return result.opened !== false;
}

/**
 * A check already in flight keeps the card. The reopen link stays pressable
 * during one, and letting its result move the card cleared the guard on the
 * check, so a second could start and an older answer land after a newer one.
 */
export function phaseAfterOpen(current: GatePhase): GatePhase {
  return current === "checking" ? current : "away";
}

export type GateOutcome = "linked" | "advanced" | "unchanged";

/**
 * `unchanged` is the only outcome that owes the student a sentence, because a
 * card that looks identical after a press reads as a broken button. The other
 * two replace the card, which is its own answer.
 */
export function gateOutcome(
  before: ActivitySession["linked"],
  after: ActivitySession["linked"],
): GateOutcome {
  if (after === true) return "linked";
  return before === after ? "unchanged" : "advanced";
}
