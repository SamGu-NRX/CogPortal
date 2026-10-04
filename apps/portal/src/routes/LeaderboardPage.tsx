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
  benchmarkScopeLine,
  familyMakeup,
  familyScopeLine,
  groupMetricsByRole,
  newestFirst,
  readPublicSweep,
} from "@/lib/published-results";
import { SweepTrace } from "@/components/SweepTrace";
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
 * no medal for first. The read model still sorts by the ranked measure for
 * API readers; this page shows the newest result first instead (see
 * `newestFirst`) and says so beside the board.
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
  const overallSelected = module === "vision" && visionView === "overall";
  // The same query Overall's board reads, so this costs no second request.
  const overall = useFamilyLeaderboard("vision-overall", overallSelected);

  // The title names the board on screen, so it changes with the tabs. Overall
  // has no catalog row; its own title comes with its board, and until then
  // the track's name is true and shorter.
  const title = overallSelected
    ? (overall.data?.family.title ?? MODULE_ACCENT.vision.label)
    : (benchmark?.title ?? (module ? MODULE_ACCENT[module].label : "Leaderboard"));

  return (
    <div className="page anim-rise">
      <PageHeader eyebrow="Published results" title={title} />

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
 * What the board in view compares, above its entries: what the benchmark
 * measures, then the exact version and scorer the results share, in the mono
 * the portal uses for data. A board of numbers with no sentence about what
 * they measure is the mystery box this course exists to avoid.
 */
export function BoardContext({ lead, scope }: { lead?: ReactNode; scope?: string }) {
  if (!lead && !scope) return null;
  return (
    <div className="mb-5">
      {lead && (
        <p className="max-w-[60ch] text-[15px] leading-[1.55] text-ink-secondary">{lead}</p>
      )}
      {scope && (
        <p
          data-board-scope=""
          className={`${lead ? "mt-2" : ""} font-mono text-[12px] leading-[1.6] break-words text-ink-faint`}
        >
          {scope}
        </p>
      )}
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
      <BoardContext
        lead={benchmark.summary}
        // Version and order describe rows; over an empty box they describe nothing.
        scope={entries.length > 0 ? benchmarkScopeLine(benchmark) : undefined}
      />
      {!active && entries.length > 0 && (
        <p className="mb-4 max-w-[58ch] text-[14.5px] leading-[1.55] text-ink-secondary">
          {title} isn't open to this cohort yet, so these are archive results.
        </p>
      )}
      <PublishedGallery entries={entries} empty={active ? undefined : IN_PROGRESS} />
    </>
  );
}

/** Overall's rule, which the board stated in its footer before it had a lead. */
const OVERALL_RULE =
  "All three components must come from selected official runs at the same repository and commit.";

function OverallStandings({ onShow }: { onShow: (view: "recognition" | "clustering") => void }) {
  const board = useFamilyLeaderboard("vision-overall");
  if (board.isPending) return <LoadingMark />;
  if (board.isError) {
    return <QueryError error={board.error} retry={() => void board.refetch()} />;
  }
  const { family, entries } = board.data;
  return (
    <>
      <BoardContext
        lead={`${familyMakeup(family)} ${OVERALL_RULE}`.trim()}
        scope={entries.length > 0 ? familyScopeLine(family) : undefined}
      />
      <PublishedGallery
        entries={entries}
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
    </>
  );
}

export function PublishedGallery({
  entries,
  empty = "No results published yet.",
  emptyActions,
}: {
  entries: LeaderboardEntry[];
  empty?: string;
  emptyActions?: ReactNode;
}) {
  const hasArchiveRows = entries.some((entry) => entry.provenance === "archive");
  // A missing curve is only worth a word where its neighbours have one.
  const curvesOnBoard = entries.some((entry) => entry.publicSweep !== null);

  if (entries.length === 0) return <Empty message={empty}>{emptyActions}</Empty>;

  return (
    <>
      <ol aria-label="Published results, newest first" className="border-t border-rule">
        {newestFirst(entries).map((entry, index) => (
          <EntryRow
            // An open entry follows its team across a refetch that reorders
            // the list, so the key is the team's result, not its position.
            key={`${entry.teamName}:${entry.sha}:${entry.completedAt}`}
            entry={entry}
            index={index}
            curvesOnBoard={curvesOnBoard}
          />
        ))}
      </ol>

      <p className="mt-5 max-w-[58ch] text-[13.5px] leading-[1.55] text-ink-secondary">
        Each team chooses which of its official results appears here.
        {curvesOnBoard && " Each curve is drawn on the same scale, so their shapes compare directly."}
        {hasArchiveRows &&
          " Archive entries are 2026 teams, scored after the course from their repositories as they left them."}
      </p>
    </>
  );
}

/**
 * One team's published result, written like an entry in a specimen book: who,
 * then the reading in small mono type, then the rest of the evidence on
 * request. The team's own line comes last and says it is about the team: it is
 * set once on the team page and appears on every track, so read under a
 * Recognition result as if it described that run, a line about caption
 * embeddings claimed a method the run never used.
 */
function EntryRow({
  entry,
  index,
  curvesOnBoard,
}: {
  entry: LeaderboardEntry;
  index: number;
  curvesOnBoard: boolean;
}) {
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

      {entry.publicSweep ? (
        <div data-public-curve="" className="mt-2">
          <p className="max-w-[60ch] text-[15px] leading-[1.55] text-ink">
            {readPublicSweep(entry.publicSweep)}
          </p>
          <div className="mt-2 max-w-[420px]">
            <SweepTrace sweep={entry.publicSweep} ticks={entry.publicSweep.ticks} categorical compact />
          </div>
        </div>
      ) : curvesOnBoard ? (
        <p data-public-curve="none" className="mt-1.5 text-[14px] text-ink-faint">
          No curve shown for this run.
        </p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1">
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
            <EntryDetails entry={entry} />
          </div>
        )}
      </div>

      {entry.teamDescription && (
        <p data-team-description="" className="mt-2.5 max-w-[60ch] text-[14.5px] leading-[1.55] text-ink-secondary">
          <span className="u-label mr-2">About the team</span>
          {entry.teamDescription}
        </p>
      )}
    </motion.li>
  );
}

/**
 * The measurements behind the reading, grouped by what the benchmark said
 * each one is. Flat, a chance floor sat beside the scored measures with the
 * same weight, and "Search MRR, caption unchanged (not scored)" read as one
 * more result.
 */
function EntryDetails({ entry }: { entry: LeaderboardEntry }) {
  const sweep = entry.publicSweep;
  // Plotted metrics stay listed even beside the curve. Nothing here maps a
  // metric to a curve point, and a curve can lack a point whose metric was
  // published, so hiding them could drop a published number.
  const groups = groupMetricsByRole(entry.supportingMetrics);
  const measured = new Map(sweep?.points.map((point) => [point.x, point.y]) ?? []);
  return (
    <div className="mt-1 max-w-[36rem] divide-y divide-rule-soft rounded-surface border border-rule-soft bg-paper-raised px-4">
      {sweep && (
        // Every reading on the curve, by name, for anyone who cannot or does
        // not want to read values off a drawing.
        <section data-metric-group="curve" className="py-3">
          <h4 className="u-label">
            {sweep.metric} by {sweep.axis}
          </h4>
          <dl className="mt-1.5 grid gap-x-10 gap-y-1.5 sm:grid-cols-2">
            {sweep.ticks.map((tick) => {
              const y = measured.get(tick.x);
              return (
                <DetailRow key={tick.x} label={tick.label} value={y === undefined ? "no curve point" : y.toFixed(3)} />
              );
            })}
          </dl>
        </section>
      )}
      {groups.map((group) => (
        <section key={group.role ?? "unrecorded"} data-metric-group={group.role ?? "unrecorded"} className="py-3">
          <h4 className="u-label">{group.label}</h4>
          <dl className="mt-1.5 grid gap-x-10 gap-y-1.5 sm:grid-cols-2">
            {group.metrics.map((m) => (
              <DetailRow key={m.key} label={m.label} value={formatMetricValue(m)} />
            ))}
          </dl>
        </section>
      ))}
      <section data-metric-group="source" className="py-3">
        <h4 className="u-label">This result</h4>
        <dl className="mt-1.5 grid gap-x-10 gap-y-1.5 sm:grid-cols-2">
          {entry.sha && <DetailRow label="Commit" value={entry.shortSha} title={entry.sha} />}
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
                  <span className="truncate">{entry.repoUrl.replace("https://github.com/", "")}</span>
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
      </section>
    </div>
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
      <dd className="u-tnum shrink-0 font-mono text-[13px] text-ink" title={title}>
        {value}
      </dd>
    </div>
  );
}

function shortDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
