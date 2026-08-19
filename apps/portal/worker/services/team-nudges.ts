/**
 * Tells a team something the portal observed, in their own Discord channel,
 * without being asked.
 *
 * The observation that matters most is the absence of one: a team with no
 * end-to-end run by midweek has not integrated, and integration is the part
 * the course says is hardest. "Remember that making it work with all the
 * pieces together is the most important part at the end. So you need to be
 * able to make sure that when that does come together your design, your
 * initial design is like well thought out." That advice was given once, on
 * day one, to a room. This is the same advice arriving on Wednesday, to the
 * team it currently applies to.
 *
 * Three rules the sentences here follow, from
 * docs/design/the-instrument-not-the-judge.md:
 *
 * Every sentence is a template. Nothing is generated, so the portal cannot
 * claim something it did not observe.
 *
 * No sentence names a person or counts anything per person. A number attached
 * to a name gets read as a grade regardless of the words around it.
 *
 * A sentence states what was observed and stops. Advice appears only where the
 * course itself gave it, quoted as the course's.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { runs, teamNudges, teams } from "../db/schema";
import { postTeamMessage } from "./discord-messages";

/** How long a team may go without an end-to-end run before we say so. */
const QUIET_AFTER_MS = 48 * 60 * 60 * 1_000;

/**
 * Nothing before this much of the week has passed. A team that has not
 * integrated on Monday afternoon is not behind, and a portal that says so is
 * nagging rather than observing.
 */
const GRACE_AFTER_FIRST_RUN_MS = 24 * 60 * 60 * 1_000;

export type NudgeKind = "no_first_light" | "quiet_since_first_light";

interface Candidate {
  teamId: string;
  channelId: string;
  teamName: string;
  firstAttemptAt: number | null;
  lastScoredAt: number | null;
}

/** Teams with a bound channel, and when they last got a scored run. */
async function candidates(env: Env): Promise<Candidate[]> {
  const db = getDb(env);
  const bound = await db
    .select({ id: teams.id, name: teams.name, channelId: teams.discordChannelId })
    .from(teams)
    .where(isNotNull(teams.discordChannelId))
    .limit(200);
  if (!bound.length) return [];

  const ids = bound.map((team) => team.id);
  // Two aggregates in one pass: when the team first tried anything, and when
  // a run last actually produced a score. The gap between them is the whole
  // signal, and a team with the first but not the second is the case this
  // exists for.
  const activity = await db
    .select({
      teamId: runs.teamId,
      firstAttemptAt: sql<number>`min(${runs.createdAt})`,
      lastScoredAt: sql<
        number | null
      >`max(case when ${runs.status} = 'succeeded' then ${runs.finishedAt} end)`,
    })
    .from(runs)
    .where(inArray(runs.teamId, ids))
    .groupBy(runs.teamId);

  const byTeam = new Map(activity.map((row) => [row.teamId, row]));
  return bound.map((team) => {
    const row = byTeam.get(team.id);
    return {
      teamId: team.id,
      teamName: team.name,
      channelId: team.channelId as string,
      firstAttemptAt: row?.firstAttemptAt ?? null,
      lastScoredAt: row?.lastScoredAt ?? null,
    };
  });
}

/**
 * The sentence for a team, or null when there is nothing true to say.
 *
 * Returning null is the common case and the important one. A portal that
 * always has something to say is a portal nobody reads.
 */
export function observation(
  team: Candidate,
  now: number,
): { kind: NudgeKind; message: string } | null {
  // A team that has never started a run has nothing to observe yet; they are
  // still setting up, and the setup flow already tells them what to do.
  if (team.firstAttemptAt === null) return null;
  if (now - team.firstAttemptAt < GRACE_AFTER_FIRST_RUN_MS) return null;

  if (team.lastScoredAt === null) {
    return {
      kind: "no_first_light",
      message: [
        "No run has scored yet for this team.",
        "",
        "A pipeline that returns the wrong answer for every query is more useful",
        "right now than three finished pieces that have never run together. The",
        "course's own advice, from day one: making it work with all the pieces",
        "together is the most important part at the end, so the initial design has",
        "to be well thought out.",
        "",
        "Stub whatever is missing, wire it end to end, and run it. A score near zero",
        "is a starting point. No score is not.",
      ].join("\n"),
    };
  }

  if (now - team.lastScoredAt >= QUIET_AFTER_MS) {
    const days = Math.floor((now - team.lastScoredAt) / (24 * 60 * 60 * 1_000));
    return {
      kind: "quiet_since_first_light",
      message: [
        `The last run that scored for this team was ${days} ${days === 1 ? "day" : "days"} ago.`,
        "",
        "Running after each change is how you find out which change did it. It is",
        "free and offline: `cogworks run --benchmark <id>`.",
      ].join("\n"),
    };
  }

  return null;
}

/**
 * Post whatever is worth saying to each bound team channel, at most once per
 * observation per team.
 *
 * Called from the five-minute cron. Everything here is safe to repeat: the
 * insert claims the right to send before the send happens, so a failure after
 * a successful post cannot produce a second one.
 */
export async function deliverTeamNudges(env: Env, now = Date.now()): Promise<number> {
  if (!env.DISCORD_BOT_TOKEN) return 0;
  const db = getDb(env);
  const teamsToCheck = await candidates(env);
  if (!teamsToCheck.length) return 0;

  const already = await db
    .select({ teamId: teamNudges.teamId, kind: teamNudges.kind })
    .from(teamNudges)
    .where(inArray(teamNudges.teamId, teamsToCheck.map((team) => team.teamId)));
  const sent = new Set(already.map((row) => `${row.teamId}:${row.kind}`));

  let delivered = 0;
  for (const team of teamsToCheck) {
    const found = observation(team, now);
    if (!found) continue;
    if (sent.has(`${team.teamId}:${found.kind}`)) continue;

    // Claim first. A crash between the insert and the post costs one silent
    // observation; a crash the other way round costs the team a duplicate
    // message every five minutes until someone notices.
    const claimed = await db
      .insert(teamNudges)
      .values({ teamId: team.teamId, kind: found.kind, sentAt: now, detail: null })
      .onConflictDoNothing()
      .returning({ teamId: teamNudges.teamId });
    if (!claimed.length) continue;

    try {
      await postTeamMessage(env, team.channelId, found.message);
      delivered += 1;
    } catch {
      // A channel the bot was removed from, or Discord being down. Leave the
      // claim in place: this observation is about a moment, and re-sending it
      // three days later would be worse than not sending it.
    }
  }
  return delivered;
}

/**
 * Forget a team's "no run has scored yet" note once one has.
 *
 * Without this a team that integrates, then goes quiet for a week, then breaks
 * their pipeline again would never hear about it, because the row from their
 * first week is still there.
 */
export async function clearFirstLightNudge(env: Env, teamId: string): Promise<void> {
  const db = getDb(env);
  await db
    .delete(teamNudges)
    .where(and(eq(teamNudges.teamId, teamId), eq(teamNudges.kind, "no_first_light")));
}
