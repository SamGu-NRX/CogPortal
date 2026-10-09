import { useCallback, useMemo, useState } from "react";
import type { Benchmark, Module } from "@cogworks/contracts/schema";
import { DEFAULT_BENCHMARK, useBenchmarks } from "./queries";

/**
 * Which benchmark the authenticated surfaces are currently showing.
 *
 * Every active benchmark is a "track" a team can run against, and each one
 * carries its own quota, runs, and setup commands. Before Week 3 the portal
 * assumed exactly one (vision-recognition), which also meant a team could
 * never reach vision-clustering from the dashboard.
 *
 * The choice lives in the browser rather than the database: it is a view
 * preference, not team state, and putting it in D1 would mean a migration
 * plus a write on every switch to answer a question a reload can re-derive.
 * A stored id that is no longer active falls back to the default.
 */
const STORAGE_KEY = "cogportal.track";

/** CogWeb runs audio, then vision, then language. A team opening the portal
 *  is almost always working on the most recent module that's open, so the
 *  default is the last active one; the switcher is how they go back. */
export const COURSE_ORDER: readonly Module[] = ["audio", "vision", "language"];

/**
 * Position of a module in the course sequence. Takes a plain string because
 * benchmark rows come from the Worker; a module this build does not know
 * sorts after the known ones instead of breaking the comparator.
 */
export function courseIndex(module: string): number {
  const index = COURSE_ORDER.findIndex((known) => known === module);
  return index === -1 ? COURSE_ORDER.length : index;
}

/** Module presentation. The accent is how a student knows which instrument
 *  they are reading without us adding a badge to every panel. */
export const MODULE_ACCENT: Record<
  Module,
  { label: string; tick: string; text: string }
> = {
  vision: { label: "Vision", tick: "bg-detect", text: "text-detect" },
  language: { label: "Language", tick: "bg-cobalt", text: "text-cobalt" },
  audio: { label: "Audio", tick: "bg-ochre", text: "text-ochre" },
};

/**
 * Active benchmarks in the order the switcher shows them: course order
 * first, then id so ties inside one module are stable. Returns a new
 * array and leaves the caller's list alone.
 */
export function sortTracks(benchmarks: readonly Benchmark[]): Benchmark[] {
  return [...benchmarks].sort(
    (a, b) =>
      courseIndex(a.module) - courseIndex(b.module) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The track a team with no stored choice lands on. The last module in
 * course order is the newest open one, and within it the first benchmark
 * in sorted order wins. Expects sortTracks output.
 *
 * An empty list returns undefined instead of throwing: while the benchmark
 * query is loading that is the honest answer, and the dashboard renders
 * around it.
 */
export function pickDefaultTrack(tracks: readonly Benchmark[]): Benchmark | undefined {
  const newest = tracks.at(-1);
  if (newest === undefined) return undefined;
  return tracks.find((b) => b.module === newest.module);
}

/**
 * The track matching the stored selection, or the default when nothing is
 * stored or the stored id is stale (a benchmark that is no longer active).
 * The stored value is browser state, so it is only ever compared against
 * known ids, never trusted as one.
 */
export function resolveTrack(
  tracks: readonly Benchmark[],
  storedId: string | null,
): Benchmark | undefined {
  return tracks.find((b) => b.id === storedId) ?? pickDefaultTrack(tracks);
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private-mode or blocked storage is not an error worth surfacing; the
    // default track is still correct, it just won't persist.
    return null;
  }
}

export interface TrackSelection {
  /** Active benchmarks in course order. Empty until the query resolves. */
  tracks: Benchmark[];
  /** The selected benchmark, or undefined while benchmarks are loading. */
  benchmark: Benchmark | undefined;
  /** Safe to pass to the run/dashboard hooks before the list resolves. */
  benchmarkId: string;
  select: (benchmarkId: string) => void;
  isPending: boolean;
}

export function useTrack(): TrackSelection {
  const benchmarks = useBenchmarks();
  const [stored, setStored] = useState<string | null>(readStored);

  const tracks = useMemo(
    () => sortTracks((benchmarks.data ?? []).filter((b) => b.active)),
    [benchmarks.data],
  );

  const benchmark = useMemo(() => resolveTrack(tracks, stored), [tracks, stored]);

  const select = useCallback((benchmarkId: string) => {
    setStored(benchmarkId);
    try {
      window.localStorage.setItem(STORAGE_KEY, benchmarkId);
    } catch {
      // See readStored: losing persistence is not worth an error state.
    }
  }, []);

  return {
    tracks,
    benchmark,
    benchmarkId: benchmark?.id ?? DEFAULT_BENCHMARK,
    select,
    isPending: benchmarks.isPending,
  };
}
