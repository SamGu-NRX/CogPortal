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
export const COURSE_ORDER: Module[] = ["audio", "vision", "language"];

function courseIndex(module: Module): number {
  const index = COURSE_ORDER.indexOf(module);
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
    () =>
      (benchmarks.data ?? [])
        .filter((b) => b.active)
        .sort(
          (a, b) =>
            courseIndex(a.module) - courseIndex(b.module) ||
            a.id.localeCompare(b.id),
        ),
    [benchmarks.data],
  );

  // Last in course order is the newest open module. Within a module the
  // first benchmark wins, which keeps recognition ahead of clustering.
  const fallback = useMemo(() => {
    if (tracks.length === 0) return undefined;
    const newest = tracks[tracks.length - 1]!.module;
    return tracks.find((b) => b.module === newest);
  }, [tracks]);

  const benchmark = tracks.find((b) => b.id === stored) ?? fallback;

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
