import { useState } from "react";
import type { Benchmark, Module } from "@shared/schema";
import { EmptyState } from "@/components/EmptyState";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { formatDateTime, formatMetricValue } from "@/lib/format";
import { useBenchmarks, useLeaderboard } from "@/lib/queries";

const TRACKS: Array<{ module: Module; label: string }> = [
  { module: "vision", label: "Vision" },
  { module: "language", label: "Language" },
  { module: "audio", label: "Audio" },
];

export function LeaderboardPage() {
  const benchmarks = useBenchmarks();
  const [module, setModule] = useState<Module>("vision");

  const forModule = (m: Module): Benchmark | undefined => {
    const list = benchmarks.data?.filter((b) => b.module === m) ?? [];
    return list.find((b) => b.active) ?? list[0];
  };
  const benchmark = forModule(module);

  return (
    <div className="anim-rise mx-auto w-full max-w-4xl py-12">
      <p className="u-kicker">Standings · BWSI 2026</p>
      <h1 className="mt-2 text-3xl">{benchmark?.title ?? "Leaderboard"}</h1>

      {/* ── Track switcher ── */}
      <div role="tablist" aria-label="Benchmark track" className="mt-6 flex gap-6 border-b border-rule">
        {TRACKS.map((track) => {
          const active = module === track.module;
          const available = forModule(track.module)?.active ?? false;
          return (
            <button
              key={track.module}
              role="tab"
              aria-selected={active}
              onClick={() => setModule(track.module)}
              className={`u-pressable -mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-1 font-mono text-[11.5px] font-medium tracking-[0.09em] uppercase transition-colors duration-150 ${
                active
                  ? "border-detect text-ink"
                  : "border-transparent text-ink-secondary hover:text-ink"
              }`}
            >
              {track.label}
              {!available && (
                <span className="text-[9.5px] tracking-[0.08em] text-ink-faint normal-case">
                  in progress
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-6">
        {benchmarks.isPending ? (
          <LoadingMark />
        ) : benchmarks.isError ? (
          <QueryError error={benchmarks.error} retry={() => void benchmarks.refetch()} />
        ) : !benchmark || !benchmark.active ? (
          <div className="border border-rule bg-paper-raised">
            <EmptyState
              message={`${benchmark?.title ?? TRACKS.find((t) => t.module === module)?.label} — in progress. Standings open when the track is calibrated.`}
            />
          </div>
        ) : (
          <Standings benchmarkId={benchmark.id} />
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
  const primaryLabel = entries[0]?.primaryMetric.label ?? "Score";

  if (entries.length === 0) {
    return (
      <div className="border border-rule bg-paper-raised">
        <EmptyState message="No official results published yet." />
      </div>
    );
  }

  return (
    <>
      {/* ── Wide: semantic table ── */}
      <table className="hidden w-full border-collapse sm:table">
        <thead>
          <tr className="border-b border-rule text-left">
            <th scope="col" className="u-kicker py-2.5 pr-3 font-medium">Rank</th>
            <th scope="col" className="u-kicker py-2.5 pr-3 font-medium">Team</th>
            <th scope="col" className="u-kicker py-2.5 pr-3 text-right font-medium">
              {primaryLabel}
            </th>
            <th scope="col" className="u-kicker py-2.5 pr-3 font-medium">Supporting</th>
            <th scope="col" className="u-kicker py-2.5 pr-3 font-medium">Commit</th>
            <th scope="col" className="u-kicker py-2.5 font-medium">Completed</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.rank}
              className={`border-b border-rule-soft align-baseline ${
                entry.isYou ? "bg-detect-wash" : ""
              }`}
            >
              <td className="py-3.5 pr-3">
                <span
                  className={`u-tnum font-serif text-lg font-semibold ${
                    entry.rank === 1 ? "text-detect" : "text-ink"
                  }`}
                >
                  {String(entry.rank).padStart(2, "0")}
                </span>
              </td>
              <td className="max-w-56 py-3.5 pr-3">
                <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
                  {entry.repoUrl ? (
                    <a
                      href={entry.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-rule underline-offset-4 hover:decoration-ink"
                    >
                      {entry.teamName}
                    </a>
                  ) : (
                    entry.teamName
                  )}
                  {entry.isYou && (
                    <span className="bg-detect px-1 py-px font-mono text-[9.5px] font-medium tracking-[0.09em] text-paper-raised">
                      YOU
                    </span>
                  )}
                </span>
              </td>
              <td className="u-tnum py-3.5 pr-3 text-right font-mono text-[15px] font-medium text-ink">
                {formatMetricValue(entry.primaryMetric)}
              </td>
              <td className="py-3.5 pr-3 font-mono text-[11px] leading-relaxed text-ink-secondary">
                {entry.supportingMetrics
                  .map((m) => `${m.label.toLowerCase()} ${formatMetricValue(m)}`)
                  .join(" · ")}
              </td>
              <td className="py-3.5 pr-3 font-mono text-[12px] text-ink-secondary" title={entry.sha}>
                {entry.shortSha}
              </td>
              <td className="py-3.5 font-mono text-[12px] whitespace-nowrap text-ink-faint">
                {formatDateTime(entry.completedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── Narrow: stacked records ── */}
      <ul className="space-y-3 sm:hidden">
        {entries.map((entry) => (
          <li
            key={entry.rank}
            className={`border px-4 py-3.5 ${
              entry.isYou ? "border-detect/50 bg-detect-wash" : "border-rule bg-paper-raised"
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex items-center gap-2 text-[14.5px] font-medium">
                <span
                  className={`u-tnum font-serif text-lg font-semibold ${entry.rank === 1 ? "text-detect" : ""}`}
                >
                  {String(entry.rank).padStart(2, "0")}
                </span>
                {entry.teamName}
                {entry.isYou && (
                  <span className="bg-detect px-1 py-px font-mono text-[9.5px] tracking-[0.09em] text-paper-raised">
                    YOU
                  </span>
                )}
              </span>
              <span className="u-tnum font-mono text-[15px] font-medium">
                {formatMetricValue(entry.primaryMetric)}
              </span>
            </div>
            <dl className="mt-2 space-y-1 font-mono text-[11px] text-ink-secondary">
              {entry.supportingMetrics.map((m) => (
                <div key={m.key} className="flex justify-between gap-3">
                  <dt className="text-ink-faint uppercase">{m.label}</dt>
                  <dd className="u-tnum">{formatMetricValue(m)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3">
                <dt className="text-ink-faint uppercase">commit</dt>
                <dd>{entry.shortSha}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <p className="mt-6 font-mono text-[11px] text-ink-faint">
        {benchmark.id} / v{benchmark.version} — each team publishes one
        selected official result.
      </p>
    </>
  );
}
