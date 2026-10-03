import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { runPhases } from "../db/schema";

/** The stages of a run that started and have not ended. Every writer that
 *  moves a run on (a status callback, a terminal callback, the stale reaper)
 *  closes these, never a stage that has no start: a status the runner never
 *  sent leaves its stage empty rather than half-filled. */
export function openPhases(runId: string) {
  return and(eq(runPhases.runId, runId), isNotNull(runPhases.startedAt), isNull(runPhases.endedAt));
}
