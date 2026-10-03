import { ArrowDown01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion, useReducedMotion } from "motion/react";
import { useId, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { moveTabFocus } from "@/lib/tablist";
import type { Benchmark, LeaderboardEntry, Module } from "@cogworks/contracts/schema";
import { buttonClass } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { PageHeader } from "@/components/Note";
import { formatDateTime, formatMetricValue } from "@/lib/format";
import { useAccountRevealed } from "@/components/RestoreGate";
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

/** The one board both tab rows control. */
const BOARD_PANEL_ID = "leaderboard-board";

type VisionView = "overall" | "recognition" | "clustering";

function visionViewOf(benchmarkId: string): VisionView {
  if (benchmarkId === "vision-recognition") return "recognition";
  if (benchmarkId === "vision-clustering") return "clustering";
  return "overall";
}

/**
 * The cohort's published results, one entry per team.
 *
 * `docs/design/the-instrument-not-the-judge.md` asks for a gallery of what
 * each team's run shows rather than a ranking, so there is no rank column and
 * no medal for first: each entry leads with the team and its own line about
 * its approach, and the number is a footnote under it. The entries still
 * arrive in the order the read model sorts them (by the primary metric), and
 * this page keeps that order rather than re-sorting on the client.
 */
export function LeaderboardPage() {
  const benchmarks = useBenchmarks();
  const [searchParams] = useSearchParams();
  const requested = searchParams.get("benchmark");
  // A picked tab survives refetches and resets on the next navigation, even to the same link.
  const arrival = useLocation().key;
  const [selection, setSelection] = useState<{
    arrival: string;
    picked: { module: Module; visionView: VisionView } | null;
  }>({ arrival, picked: null });
  if (selection.arrival !== arrival) {
    setSelection({ arrival, picked: null });
  }
  const choice = selection.arrival === arrival ? selection.picked : null;
  const target = requested ? benchmarks.data?.find((b) => b.id === requested) : undefined;

  const forModule = (m: Module): Benchmark | undefined => {
    const list = benchmarks.data?.filter((b) => b.module === m) ?? [];
    return list.find((b) => b.active) ?? list[0];
  };
  const visionBenchmarks = benchmarks.data?.filter((b) => b.module === "vision") ?? [];
  const recognition = visionBenchmarks.find((b) => b.id === "vision-recognition" && b.active);
  const clustering = visionBenchmarks.find((b) => b.id === "vision-clustering" && b.active);
  const isOpen = (m: Module) => (m === "vision" ? Boolean(recognition && clustering) : (forModule(m)?.active ?? false));

  // With nothing requested, the board opens on the first track open to this
  // cohort, in course order: a track still in progress can only show an empty
  // box, and that was the first thing "See this year's results" showed. Open
  // is a catalog fact, so unlike choosing by which board has rows it can't
  // move under the reader on a refetch. No tab is chosen until the catalog
  // answers; guessing would show one track and then jump to another.
  const opening: Module | null = benchmarks.data
    ? (TRACKS.find((track) => isOpen(track.module)) ?? TRACKS[0]!).module
    : benchmarks.isError
      ? TRACKS[0]!.module
      : null;
  const module: Module | null = choice?.module ?? target?.module ?? opening;
  // Vision opens on Overall, which is the summary of the other two. Overall
  // is empty until a team publishes a Recognition and a Clustering result
  // from one commit, and that used to read as "no results published yet"
  // while Clustering had standings. What fixes it is the empty state saying
  // what Overall needs and where the rest is, not choosing the tab for the
  // reader: which board has rows is a fact about this week that would move
  // the tab under them on a refetch.
  const visionView: VisionView = choice?.visionView ?? (target ? visionViewOf(target.id) : "overall");
  const pick = (next: { module?: Module; visionView?: VisionView }) =>
    setSelection({
      arrival,
      picked: {
        module: next.module ?? module ?? TRACKS[0]!.module,
        visionView: next.visionView ?? visionView,
      },
    });

  const benchmark =
    module === "vision"
      ? visionView === "recognition"
        ? recognition
        : visionView === "clustering"
          ? clustering
          : recognition
      : module ? forModule(module) : undefined;

  return (
    <div className="page anim-rise">
      <PageHeader
        eyebrow="Published results"
        title={module === "vision" ? "Vision" : (benchmark?.title ?? "Leaderboard")}
      />

      {/* ── Track switcher ── */}
      <div
        role="tablist"
        aria-label="Benchmark track"
        onKeyDown={moveTabFocus}
        className="mt-8 flex gap-1 overflow-x-auto border-b border-rule lg:max-w-[42rem]"
      >
        {TRACKS.map((track) => {
          const active = module === track.module;
          const available = isOpen(track.module);
          return (
            <button
              key={track.module}
              type="button"
              role="tab"
              id={`track-tab-${track.module}`}
              aria-selected={active}
              aria-controls={BOARD_PANEL_ID}
              // One Tab stop even while the catalog decides which track opens.
              tabIndex={active || (module === null && track === TRACKS[0]) ? 0 : -1}
              onClick={() => pick({ module: track.module })}
              className={`relative inline-flex min-h-11 shrink-0 items-baseline gap-2 px-3 pt-2.5 text-[15px] font-semibold transition-colors duration-150 ${
                active ? "text-ink" : "text-ink-secondary hover:text-ink"
              }`}
            >
              {track.label}
              {!available && (
                <span className="text-[12px] font-normal text-ink-faint">in progress</span>
              )}
              {active && (
                // The accent names the module. Underlining the Language tab
                // in detector red would say "vision" while reading Language.
                <span
                  aria-hidden="true"
                  className={`absolute inset-x-3 -bottom-px h-[2px] rounded-full ${MODULE_ACCENT[track.module].tick}`}
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
          onKeyDown={moveTabFocus}
          className="mt-4 inline-flex max-w-full gap-0.5 overflow-x-auto rounded-surface border border-rule bg-paper-sunken p-[3px]"
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
                id={`vision-tab-${value}`}
                aria-selected={active}
                aria-controls={BOARD_PANEL_ID}
                tabIndex={active ? 0 : -1}
                onClick={() => pick({ visionView: value })}
                className={`relative inline-flex min-h-11 shrink-0 items-center rounded-control px-3.5 text-[14px] font-semibold transition-colors duration-150 ${
                  active ? "text-ink" : "text-ink-secondary hover:text-ink"
                }`}
              >
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 rounded-control border border-rule bg-paper-raised shadow-[0_1px_2px_rgb(27_31_36/0.08)]"
                  />
                )}
                <span className="relative">{label}</span>
              </button>
            );
          })}
        </div>
      )}

      <div
        id={BOARD_PANEL_ID}
        role="tabpanel"
        aria-labelledby={
          module === "vision" ? `vision-tab-${visionView}` : module ? `track-tab-${module}` : undefined
        }
        className="mt-6 lg:max-w-[42rem]"
      >
        {benchmarks.isPending ? (
          <LoadingMark />
        ) : benchmarks.isError ? (
          <QueryError error={benchmarks.error} retry={() => void benchmarks.refetch()} />
        ) : module === "vision" && visionView === "overall" ? (
          <OverallStandings
            onShow={(view) => {
              pick({ visionView: view });
              // The buttons go with the empty state; the tab they picked stays.
              document.getElementById(`vision-tab-${view}`)?.focus();
            }}
          />
        ) : !benchmark ? (
          <Empty message={IN_PROGRESS} />
        ) : (
          <Standings
            key={benchmark.id}
            benchmarkId={benchmark.id}
            active={benchmark.active}
            title={benchmark.title}
          />
        )}
      </div>
    </div>
  );
}

/** The tab already says "in progress" and the title names the track. */
const IN_PROGRESS = "Results appear here once this track opens to the cohort.";

function Empty({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="rounded-surface border border-rule bg-paper-raised">
      <EmptyState message={message}>{children}</EmptyState>
    </div>
  );
}

/**
 * `active` is about the current cohort, not about whether there is anything to
 * read. An uncalibrated track used to render its empty state over the top of
 * real archive rows, so Audio showed "Standings open when the track is
 * calibrated" while four dated results sat behind it. The track status belongs
 * on the tab, which already carries it, and the rows belong here.
 */
function Standings({
  benchmarkId,
  active,
  title,
}: {
  benchmarkId: string;
  active: boolean;
  title: string;
}) {
  const board = useLeaderboard(benchmarkId);

  if (board.isPending) return <LoadingMark />;
  if (board.isError) {
    return <QueryError error={board.error} retry={() => void board.refetch()} />;
  }

  const { benchmark, entries } = board.data;
  return (
    <>
      {!active && entries.length > 0 && (
        <p className="mb-4 max-w-[58ch] text-[14.5px] leading-[1.55] text-ink-secondary">
          {title} isn't open to this cohort yet, so these are archive results.
        </p>
      )}
      <Gallery
        entries={entries}
        footer={`${benchmark.id} / v${benchmark.version}. One selected official result per team.`}
        empty={active ? undefined : IN_PROGRESS}
      />
    </>
  );
}

function OverallStandings({ onShow }: { onShow: (view: "recognition" | "clustering") => void }) {
  const board = useFamilyLeaderboard("vision-overall");
  if (board.isPending) return <LoadingMark />;
  if (board.isError) {
    return <QueryError error={board.error} retry={() => void board.refetch()} />;
  }
  return (
    <Gallery
      entries={board.data.entries}
      footer="vision-overall / v1. All three components must come from selected official runs at the same repository and commit."
      // "No results published yet" was true of Overall and told the reader
      // nothing, because Clustering had standings the whole time.
      empty="Overall needs a Recognition and a Clustering result from the same commit. No team has published both yet."
      // Overall opens first, so when it is empty the two boards that may
      // already have results are one press away rather than a tab hunt.
      emptyActions={
        // Stacked at one width on a phone, where the pair would otherwise
        // wrap into two ragged rows.
        <div className="flex w-full max-w-[16rem] flex-col gap-2 sm:w-auto sm:max-w-none sm:flex-row">
          <button type="button" className={buttonClass("ghost")} onClick={() => onShow("recognition")}>
            See Recognition
          </button>
          <button type="button" className={buttonClass("ghost")} onClick={() => onShow("clustering")}>
            See Clustering
          </button>
        </div>
      }
    />
  );
}

function Gallery({
  entries,
  footer,
  empty = "No results published yet.",
  emptyActions,
}: {
  entries: LeaderboardEntry[];
  footer: string;
  empty?: string;
  emptyActions?: ReactNode;
}) {
  const hasArchiveRows = entries.some((entry) => entry.provenance === "archive");

  if (entries.length === 0) return <Empty message={empty}>{emptyActions}</Empty>;

  return (
    <>
      <ol aria-label="Published results" className="border-t border-rule">
        {entries.map((entry, index) => (
          <EntryRow
            // An open entry follows its team across a refetch that reorders
            // the list, so the key is the team's result, not its position.
            key={`${entry.teamName}:${entry.sha}:${entry.completedAt}`}
            entry={entry}
            index={index}
          />
        ))}
      </ol>

      {hasArchiveRows && (
        <p className="mt-5 max-w-[58ch] text-[13.5px] leading-[1.55] text-ink-secondary">
          Archive entries are 2026 teams, scored after the course from their repositories as they
          left them.
        </p>
      )}

      <p className={`${hasArchiveRows ? "mt-3" : "mt-5"} font-mono text-[12px] text-ink-faint`}>
        {footer}
      </p>
    </>
  );
}

/**
 * One team's published result, written like an entry in a specimen book: who,
 * then what they tried in their own words, then the reading in small mono
 * type. The rest of the numbers, the commit, and the repository unfold under
 * it on request, because they are what a curious reader checks second.
 */
function EntryRow({ entry, index }: { entry: LeaderboardEntry; index: number }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const detailsId = useId();
  // The board is public, but "you" names the account on screen, which a
  // returning tab has not confirmed yet.
  const revealed = useAccountRevealed();
  const isYou = entry.isYou && revealed;

  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, transform: "translateY(4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      transition={{
        duration: 0.2,
        ease: EASE_OUT,
        delay: reduce ? 0 : Math.min(index, 8) * 0.035,
      }}
      className="border-b border-rule-soft py-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="min-w-0 text-[1.25rem] break-words text-ink">{entry.teamName}</h3>
        {isYou && (
          // The one highlighter mark on the page: "you are here".
          <span className="rounded-[2px] bg-marker px-1.5 text-[12.5px] font-semibold text-ink">
            Your team
          </span>
        )}
        {entry.provenance === "archive" && (
          <span className="text-[13px] text-ink-faint">2026 cohort, anonymized</span>
        )}
      </div>
      {entry.teamDescription && (
        <p className="mt-1.5 max-w-[60ch] text-[15px] leading-[1.55] text-ink-secondary">
          {entry.teamDescription}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="u-tnum font-mono text-[13px]">
          <span className="text-ink-faint">{entry.primaryMetric.label}</span>{" "}
          <span className="font-medium text-ink">{formatMetricValue(entry.primaryMetric)}</span>
          <span className="text-ink-faint"> · {shortDate(entry.completedAt)}</span>
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((v) => !v)}
          className="u-pressable -ml-2 inline-flex min-h-11 items-center gap-1 rounded-control px-2 text-[13.5px] font-semibold text-ink-secondary transition-colors duration-150 hover:bg-ink/[0.045] hover:text-ink"
        >
          {open ? "Hide details" : "Details"}
          <span className="sr-only"> for {entry.teamName}</span>
          <motion.span
            aria-hidden="true"
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.15, ease: EASE_OUT }}
            className="inline-flex"
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
          </motion.span>
        </button>
      </div>

      <div id={detailsId}>
        {open && (
          <div className="anim-reveal">
                            <dl className="mt-1 grid max-w-[36rem] gap-x-10 gap-y-1.5 rounded-surface border border-rule-soft bg-paper-raised px-4 py-3.5 sm:grid-cols-2">
                {entry.supportingMetrics.map((m) => (
                  <DetailRow key={m.key} label={m.label} value={formatMetricValue(m)} />
                ))}
                {entry.sha && (
                  <DetailRow label="Commit" value={entry.shortSha} title={entry.sha} />
                )}
                <DetailRow label="Completed" value={formatDateTime(entry.completedAt)} />
                {entry.repoUrl && (
                  <div className="flex items-baseline justify-between gap-3 sm:col-span-2">
                    <dt className="text-[13.5px] text-ink-secondary">Repository</dt>
                    <dd className="min-w-0">
                      <a
                        href={entry.repoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-1 font-mono text-[13px] text-ink underline decoration-rule-strong underline-offset-4 hover:decoration-ink"
                      >
                        <span className="truncate">
                          {entry.repoUrl.replace("https://github.com/", "")}
                        </span>
                        <HugeiconsIcon
                          icon={ArrowUpRight01Icon}
                          size={12}
                          strokeWidth={1.8}
                          className="shrink-0"
                          aria-hidden="true"
                        />
                      </a>
                    </dd>
                  </div>
                )}
                {/* An archive row withholds its repository on purpose. A live row
                    without one is a run from before the source was recorded, and
                    saying so beats leaving a commit with nothing to belong to. */}
                {!entry.repoUrl && entry.provenance !== "archive" && (
                  <DetailRow label="Repository" value="not recorded" />
                )}
              </dl>
          </div>
        )}
      </div>
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
      <dt className="text-[13.5px] text-ink-secondary">{label}</dt>
      <dd className="u-tnum font-mono text-[13px] text-ink" title={title}>
        {value}
      </dd>
    </div>
  );
}

function shortDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
