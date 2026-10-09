import { z } from "zod";

/**
 * Route param handling for the run pages. Route params arrive from
 * useParams() as possibly-empty strings; an empty or malformed id must not
 * reach the API as a pointless request, so the pages show a calm message
 * with the next action instead. The server stays authoritative for
 * everything these checks do not cover.
 */

/**
 * The surface id shape is part of the shared wire contract
 * (RunSurfaceSnapshotSchema in @cogworks/contracts): surface_ plus 20
 * lowercase hex characters. Every surface the API returns satisfies it,
 * so a param that fails it can never return a 200.
 */
export const SURFACE_ID_PATTERN = /^surface_[a-f0-9]{20}$/;

const SurfaceIdParamSchema = z.string().regex(SURFACE_ID_PATTERN);
const RunIdParamSchema = z.string().min(1);

export type ParsedParam =
  | { ok: true; id: string }
  | { ok: false; reason: string };

/**
 * Run ids have no client-checkable shape (seeded demo runs use ids like
 * run_demo_p1), so only an empty id is rejected here. Anything else goes
 * to the server, which owns the lookup.
 */
export function parseRunIdParam(raw: string | undefined): ParsedParam {
  const id = raw?.trim() ?? "";
  if (!RunIdParamSchema.safeParse(id).success) {
    return {
      ok: false,
      reason:
        "This run link is missing its run id. Open the run again from the dashboard.",
    };
  }
  return { ok: true, id };
}

export function parseSurfaceIdParam(raw: string | undefined): ParsedParam {
  const id = raw?.trim() ?? "";
  if (!id) {
    return {
      ok: false,
      reason:
        "This surface link is missing its surface id. Open the surface again from the dashboard.",
    };
  }
  if (!SurfaceIdParamSchema.safeParse(id).success) {
    return {
      ok: false,
      reason:
        "This surface link is malformed; surface ids look like surface_ followed by 20 hex characters. Open the surface again from the dashboard.",
    };
  }
  return { ok: true, id };
}

/**
 * WebSocket path for a run surface stream. The id is encoded even though
 * validated ids are plain hex, so the helper stays safe on any input.
 */
export function runSurfaceStreamPath(surfaceId: string): string {
  return `/api/run-surfaces/${encodeURIComponent(surfaceId)}/stream`;
}
