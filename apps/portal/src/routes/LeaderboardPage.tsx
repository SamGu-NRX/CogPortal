import { ArrowDown01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { Benchmark, LeaderboardEntry, Module } from "@cogworks/contracts/schema";
import { EmptyState } from "@/components/EmptyState";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { formatDateTime, formatMetricValue } from "@/lib/format";
import { EASE_OUT } from "@/lib/motion";
import {
  useBenchmarks,
  useFamilyLeaderboard,
  useLeaderboard,
} from "@/lib/queries";
import { COURSE_ORDER, MODULE_ACCENT } from "@/lib/track";

// Audio, vision, language, which is the order the course runs them in. This
// list used to be written out here in a different order, so the leaderboard
// disagreed with every other surface about which week comes first.
const TRACKS: Array<{ module: Module; label: string }> = COURSE_ORDER.map((module) => ({
  module,
  label: MODULE_ACCENT[module].label,
}));

/** Row grid shared by the header and every entry. */
const ROW_GRID = "grid grid-cols-[3rem_minmax(0,1fr)_auto_2rem] items-baseline gap-x-4";

export function LeaderboardPage() {
  const benchmarks = useBenchmarks();
  const [module, setModule] = useState<Module>(TRACKS[0]!.module);
  const [visionView, setVisionView] = useState<
    "overall" | "recognition" | "clustering"
  >("overall");
  const reduce = useReducedMotion();

  const forModule = (m: Module): Benchmark | undefined => {
    const list = benchmarks.data?.filter((b) => b.module === m) ?? [];
    return list.find((b) => b.active) ?? list[0];
  };
  const visionBenchmarks = benchmarks.data?.filter((b) => b.module === "vision") ?? [];
  const recognition = visionBenchmarks.find((b) => b.id === "vision-recognition" && b.active);
  const clustering = visionBenchmarks.find((b) => b.id === "vision-clustering" && b.active);
  const benchmark =
    module === "vision"
      ? visionView === "recognition"
        ? recognition
        : visionView === "clustering"
          ? clustering
          : recognition
      : forModule(module);

  return (
    <div className="anim-rise mx-auto w-full max-w-3xl py-12">
      <h1 className="text-3xl">
        {module === "vision" ? "Vision" : (benchmark?.title ?? "Leaderboard")}
      </h1>

      {/* ── Track switcher ── */}
      <div role="tablist" aria-label="Benchmark track" className="mt-6 flex gap-6 border-b border-rule">
        {TRACKS.map((track) => {
          const active = module === track.module;
          const available =
            track.module === "vision"
              ? Boolean(recognition && clustering)
              : (forModule(track.module)?.active ?? false);
          return (
            <button
              key={track.module}
              role="tab"
              aria-selected={active}
              onClick={() => setModule(track.module)}
              className={`u-pressable relative inline-flex min-h-11 items-center gap-2 px-1 font-mono text-[11.5px] font-medium tracking-[0.09em] uppercase transition-colors duration-150 ${
                active ? "text-ink" : "text-ink-secondary hover:text-ink"
              }`}
            >
              {track.label}
              {!available && (
                <span className="text-[9.5px] tracking-[0.08em] text-ink-faint normal-case">
                  in progress
                </span>
              )}
              {active && (
                <motion.span
                  layoutId="track-underline"
                  aria-hidden="true"
                  // The accent names the module. Underlining the Language tab
                  // in detector red would say "vision" while reading Language.
                  className={`absolute inset-x-1 -bottom-px h-0.5 ${MODULE_ACCENT[track.module].tick}`}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { type: "tween", duration: 0.2, ease: EASE_OUT }
                  }
                />
              )}
            </button>
          );
        })}
      </div>

      {module === "vision" && (
        <div
          role="tablist"
          aria-label="Vision leaderboard"
          className="mt-4 flex gap-5"
        >
          {(
            [
              ["overall", "Overall"],
              ["recognition", "Recognition"],
              ["clustering", "Clustering"],
            ] as const
          ).map(([value, label]) => {
            const active = visionView === value;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setVisionView(value)}
                className={`u-pressable relative inline-flex min-h-11 items-center px-1 font-mono text-[11px] font-medium tracking-[0.08em] uppercase transition-colors duration-150 ${
                  active ? "text-ink" : "text-ink-secondary hover:text-ink"
                }`}
              >
                {label}
                {active && (
                  <motion.span
                    layoutId="vision-view-underline"
                    aria-hidden="true"
                    className="absolute inset-x-1 bottom-1 h-px bg-detect"
                    transition={
                      reduce
                        ? { duration: 0 }
                        : { type: "tween", duration: 0.2, ease: EASE_OUT }
                    }
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-6">
        {benchmarks.isPending ? (
          <LoadingMark />
        ) : benchmarks.isError ? (
          <QueryError error={benchmarks.error} retry={() => void benchmarks.refetch()} />
        ) : module === "vision" && visionView === "overall" ? (
          <OverallStandings />
        ) : !benchmark || !benchmark.active ? (
          <div className="border border-rule bg-paper-raised">
            <EmptyState
              message={`${benchmark?.title ?? TRACKS.find((t) => t.module === module)?.label} is in progress. Standings open when the track is calibrated.`}
            />
          </div>
        ) : (
          <Standings key={benchmark.id} benchmarkId={benchmark.id} />
        )}
      </div>
    </div>
  );
}

function Standings({ benchmarkId }: { benchmarkId: string }) {
  const board = useLeaderboard(benchmarkId);

  if (board.isPending) return <LoadingMark />;
  if (board.isError) {
    return <QueryError error={board.error} retry={() => void board.refetch()} />;
  }

  const { benchmark, entries } = board.data;
  return (
    <StandingsTable
      entries={entries}
      footer={`${benchmark.id} / v${benchmark.version}. Each team publishes one selected official result.`}
    />
  );
}

function OverallStandings() {
  const board = useFamilyLeaderboard("vision-overall");
  if (board.isPending) return <LoadingMark />;
  if (board.isError) {
    return <QueryError error={board.error} retry={() => void board.refetch()} />;
  }
  return (
    <StandingsTable
      entries={board.data.entries}
      footer="vision-overall / v1. All three components must come from selected official runs at the same repository and commit."
    />
  );
}

function StandingsTable({
  entries,
  footer,
}: {
  entries: LeaderboardEntry[];
  footer: string;
}) {
  const primaryLabel = entries[0]?.primaryMetric.label ?? "Score";

  if (entries.length === 0) {
    return (
      <div className="border border-rule bg-paper-raised">
        <EmptyState message="No official results are published yet. Check again after teams publish their results." />
      </div>
    );
  }

  return (
    <>
      {/* Header row (labels only — the rows carry the semantics) */}
      <div className={`${ROW_GRID} border-b border-rule px-4 py-2.5`} aria-hidden="true">
        <span className="u-kicker">Rank</span>
        <span className="u-kicker">Team</span>
        <span className="u-kicker text-right">{primaryLabel}</span>
        <span />
      </div>

      <ol aria-label="Standings">
        {entries.map((entry, index) => (
          <EntryRow key={entry.rank} entry={entry} index={index} />
        ))}
      </ol>

      <p className="mt-6 px-4 font-mono text-[11px] text-ink-faint">
        {footer}
      </p>
    </>
  );
}

function EntryRow({ entry, index }: { entry: LeaderboardEntry; index: number }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();

  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.2,
        ease: EASE_OUT,
        delay: reduce ? 0 : Math.min(index, 8) * 0.035,
      }}
      className={`border-b border-rule-soft ${entry.isYou ? "bg-detect-wash" : ""}`}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`entry-${entry.rank}`}
        onClick={() => setOpen((v) => !v)}
        className={`${ROW_GRID} w-full px-4 py-3.5 text-left transition-colors duration-150 hover:bg-paper-sunken/50`}
      >
        <span
          className={`u-tnum font-serif text-lg font-semibold ${
            entry.rank === 1 ? "text-detect" : "text-ink"
          }`}
        >
          {String(entry.rank).padStart(2, "0")}
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[14.5px] font-medium text-ink" title={entry.teamName}>
            {entry.teamName}
          </span>
          {entry.isYou && (
            <span className="shrink-0 bg-detect px-1 py-px font-mono text-[9.5px] font-medium tracking-[0.09em] text-paper-raised">
              YOU
            </span>
          )}
        </span>
        <span className="u-tnum text-right font-mono text-[15px] font-medium text-ink">
          {formatMetricValue(entry.primaryMetric)}
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.15, ease: "easeOut" }}
          className="justify-self-end self-center text-ink-faint"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`entry-${entry.rank}`}
            initial={reduce ? { opacity: 1, height: "auto" } : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={
              reduce
                ? { opacity: 0, transition: { duration: 0 } }
                : { height: 0, opacity: 0, transition: { duration: 0.16, ease: "easeOut" } }
            }
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            {/* padding lives on the inner element, not the animated wrapper */}
            <dl className="grid gap-x-8 gap-y-1.5 px-4 pt-1 pb-4 sm:grid-cols-2 sm:pl-[4.75rem]">
              {entry.teamDescription && (
                <div className="sm:col-span-2">
                  <p className="max-w-prose text-[13px] text-ink-secondary">
                    {entry.teamDescription}
                  </p>
                </div>
              )}
              {entry.supportingMetrics.map((m) => (
                <DetailRow key={m.key} label={m.label} value={formatMetricValue(m)} />
              ))}
              <DetailRow label="Commit" value={entry.shortSha} title={entry.sha} />
              <DetailRow label="Completed" value={formatDateTime(entry.completedAt)} />
              {entry.repoUrl && (
                <div className="flex items-baseline justify-between gap-3 sm:col-span-2 sm:justify-start sm:gap-8">
                  <dt className="u-kicker">Repository</dt>
                  <dd>
                    <a
                      href={entry.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[12px] text-ink underline decoration-rule underline-offset-4 hover:decoration-ink"
                    >
                      {entry.repoUrl.replace("https://github.com/", "")}
                      <HugeiconsIcon icon={ArrowUpRight01Icon} size={12} strokeWidth={1.8} aria-hidden="true" />
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function DetailRow({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="u-kicker">{label}</dt>
      <dd className="u-tnum font-mono text-[12.5px] text-ink" title={title}>
        {value}
      </dd>
    </div>
  );
}
