import { motion, useReducedMotionConfig } from "motion/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import {
  OFFICIAL_LIMIT,
  type Benchmark,
  type Dashboard,
  type LocalReport,
  type RunSummary,
} from "@cogworks/contracts/schema";
import { resolveFailureCopy } from "@cogworks/contracts/failures";
import { Button, buttonClass } from "@/components/Button";
import { Code } from "@/components/Code";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { LocalReportsTable } from "@/components/LocalReportsTable";
import { Annotated, PageHeader } from "@/components/Note";
import { PhaseRail } from "@/components/PhaseRail";
import { QuotaCells } from "@/components/QuotaCells";
import { RunList } from "@/components/RunList";
import { SetupNudge } from "@/components/SetupNudge";
import { ShaChip } from "@/components/ShaChip";
import { SimulatedChip } from "@/components/SimulatedChip";
import { StatusChip } from "@/components/StatusChip";
import { TrackSwitcher, trackTabId } from "@/components/TrackSwitcher";
import { ApiRequestError } from "@/lib/api";
import { formatMetricValue, formatTimeAgo, runNumberLabel } from "@/lib/format";
import { EASE_OUT } from "@/lib/motion";
import {
  useBenchmarks,
  useDashboard,
  useLocalReports,
  usePromote,
  useRepositories,
  useSession,
  useStartPractice,
  useUntrackedLocalReports,
} from "@/lib/queries";
import { PHASE_LABELS, QUEUED_WAIT_NOTE, STATUS_LABELS, runTitle } from "@/lib/run-meta";
import { useTrack } from "@/lib/track";

const PANEL_ID = "runs-track-panel";

/**
 * The Runs page is the team's bench for one benchmark. It answers four
 * questions in the order a student arrives with them: is something running,
 * what did our latest run show, what can we do next, and what have we done
 * before. Standing facts (repository, commit, machine, budget, published
 * result) are kept for reference at the foot rather than competing with
 * those.
 */
export function DashboardPage() {
  const track = useTrack();
  const [params, setParams] = useSearchParams();
  const { data: session } = useSession();

  // `?benchmark=` opens a named track (a link from the leaderboard, a
  // teammate's paste). It is honored on this render, then stored as the
  // track choice and dropped from the address, so the tabs own the choice
  // from there on. An id that is not an open track is dropped silently.
  const linkedId = params.get("benchmark");
  const linked = track.tracks.find((t) => t.id === linkedId);
  const benchmark = linked ?? track.benchmark;
  const benchmarkId = benchmark?.id ?? track.benchmarkId;
  const selectTrack = track.select;
  useEffect(() => {
    if (!linkedId || track.isPending) return;
    if (linked) selectTrack(linked.id);
    setParams(
      (next) => {
        next.delete("benchmark");
        return next;
      },
      { replace: true },
    );
  }, [linkedId, linked, track.isPending, selectTrack, setParams]);

  const dashboard = useDashboard(benchmarkId, !track.isPending);
  const d = dashboard.data;

  // A run that finishes while this page is open gets acknowledged where it
  // lands. Keyed by benchmark so switching tracks (whose payload has no active
  // run) is not mistaken for a run finishing.
  const watching = useRef<{ benchmarkId: string; runId: string } | null>(null);
  const [finishedHere, setFinishedHere] = useState<string | null>(null);
  const activeId = d?.activeRun?.id ?? null;
  const payloadBenchmark = d?.benchmark.id ?? null;
  useEffect(() => {
    if (!payloadBenchmark) return;
    const was = watching.current;
    if (was && was.benchmarkId === payloadBenchmark && was.runId !== activeId) {
      setFinishedHere(was.runId);
    }
    watching.current = activeId ? { benchmarkId: payloadBenchmark, runId: activeId } : null;
  }, [activeId, payloadBenchmark]);

  if (track.isPending) return <LoadingMark label="Loading" />;

  const tabbed = track.tracks.length > 1;
  const teamName = session?.team?.name ?? d?.team.name;
  const shown = benchmark ?? d?.benchmark;

  return (
    <div className="page anim-rise">
      <TrackSwitcher
        variant="tabs"
        tracks={track.tracks}
        benchmark={benchmark}
        onSelect={track.select}
        panelId={PANEL_ID}
      />
      {/* The tabs stay outside the panel that reloads, so focus stays on the
          tab a keyboard user just chose while the new benchmark loads. */}
      <div
        id={PANEL_ID}
        role={tabbed ? "tabpanel" : undefined}
        aria-labelledby={tabbed && benchmark ? trackTabId(benchmark.id) : undefined}
        className={tabbed ? "pt-8 sm:pt-10" : undefined}
      >
        {shown && (
          <PageHeader
            eyebrow={
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {teamName}
                {session?.auth.executionProvider === "fixture" && <SimulatedChip />}
              </span>
            }
            title={
              <>
                {shown.title}{" "}
                <span className="u-tnum align-[0.3em] font-mono text-[14px] font-normal tracking-normal text-ink-faint">
                  v{shown.version}
                </span>
              </>
            }
            lede={shown.summary}
          />
        )}

        <SetupNudge />

        {dashboard.isPending ? (
          <LoadingMark label="Loading" />
        ) : dashboard.isError ? (
          <div className="mt-8">
            <QueryError error={dashboard.error} retry={() => void dashboard.refetch()}>
              <Link to="/" className="u-link text-[14px]">
                Back to start
              </Link>
            </QueryError>
          </div>
        ) : (
          <Bench key={dashboard.data.benchmark.id} d={dashboard.data} finishedHere={finishedHere} />
        )}
      </div>
    </div>
  );
}

/* ── The bench ─────────────────────────────────────────────────────────── */

function Bench({ d, finishedHere }: { d: Dashboard; finishedHere: string | null }) {
  const repositories = useRepositories();
  const localReports = useLocalReports(d.benchmark.id);
  const untrackedReports = useUntrackedLocalReports();
  const catalog = useBenchmarks().data ?? [];

  const branches =
    repositories.data?.find((r) => r.fullName === d.team.repo?.fullName)?.branches ??
    (d.team.repo ? [d.team.repo.defaultBranch] : []);

  // A team with no runs gets a different page, not this one with empty
  // frames in it. Everything below the launcher reports something a run
  // produced, so before the first run each would be a label over nothing.
  const firstRun = d.runs.length === 0;
  const active = d.activeRun;
  const lead: RunSummary | undefined = active ?? d.runs[0];

  const candidate = d.latestCandidate?.primaryMetric ? d.latestCandidate : null;
  // The candidate's promotion lives in the lead card when the latest run is
  // the candidate, so one run is never described twice. It is left out
  // entirely when the latest run is the official attempt it was already
  // promoted to, which the lead card already shows. While a run is moving
  // nothing can be promoted (runs go one at a time), so it waits.
  const promotable = active ? null : candidate;
  const candidateInLead = promotable && promotable.id === lead?.id ? promotable : null;
  const candidateApart =
    promotable && !candidateInLead && promotable.promotedTo?.runId !== lead?.id ? promotable : null;

  const reports = localReports.data ?? [];
  // Reports sync accepted for a benchmark version with no track to switch to
  // (an inactive benchmark, a superseded version). Shown on every track so
  // they are reachable somewhere.
  const untracked = untrackedReports.data ?? [];
  const reportsFailed = localReports.isError || untrackedReports.isError;

  const announcement = active
    ? `${runTitle(active)} is ${STATUS_LABELS[active.status].toLowerCase()}`
    : lead && lead.id === finishedHere
      ? `${runTitle(lead)} finished: ${STATUS_LABELS[lead.status].toLowerCase()}`
      : "";

  return (
    <div className="mt-10 space-y-14">
      {/* Status changes announce themselves; polling stays silent. This sits
          outside the lead card so the finish is heard even though the live
          card is replaced at that moment. */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {firstRun ? (
        <FirstRun d={d} branches={branches} branchesFailed={repositories.isError} />
      ) : (
        <>
          {lead && (
            <LeadRun
              // Remounts, and rises, when the run changes or stops moving.
              key={`${lead.id}:${active ? "live" : "done"}`}
              run={lead}
              live={Boolean(active)}
              benchmark={d.benchmark}
              published={d.selection?.runId === lead.id}
              justFinished={!active && lead.id === finishedHere}
            >
              {candidateInLead && <Promotion d={d} candidate={candidateInLead} inLead />}
            </LeadRun>
          )}

          {candidateApart && (
            <Annotated note={PROMOTE_NOTE}>
              <Promotion d={d} candidate={candidateApart} />
            </Annotated>
          )}

          <section aria-labelledby="launch-heading">
            <h2 id="launch-heading" className="text-[22px]">
              Start a practice run
            </h2>
            <Annotated note={HOSTED_NOTE} className="mt-4">
              {active ? (
                <p className="max-w-[56ch] text-[15px] leading-[1.6] text-ink-secondary">
                  Runs go one at a time on each benchmark, so the next one can
                  start once this one finishes.
                </p>
              ) : (
                <Launcher d={d} branches={branches} branchesFailed={repositories.isError} />
              )}
            </Annotated>
          </section>

          <section aria-labelledby="history-heading">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="history-heading" className="text-[22px]">
                Run history
              </h2>
              <span className="u-tnum font-mono text-[12.5px] text-ink-faint">
                {/* The server sends at most fifty, so a full page says so
                    rather than claiming that is everything. */}
                {d.runs.length >= 50 ? "the latest 50" : `${d.runs.length} ${d.runs.length === 1 ? "run" : "runs"}`}
              </span>
            </div>
            <div className="mt-4">
              <RunList
                runs={d.runs}
                connectedFullName={d.team.repo?.fullName}
                publishedRunId={d.selection?.runId}
              />
            </div>
          </section>
        </>
      )}

      {/* Nothing while the query is in flight, so the section does not appear
          and then withdraw. A failed query still renders: that a self-reported
          number could not be read is a fact about this session. */}
      {(reports.length > 0 || untracked.length > 0 || reportsFailed) && (
        <section aria-labelledby="local-reports-heading">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="local-reports-heading" className="text-[22px]">
              Local reports
            </h2>
            <span className="text-[13px] font-semibold text-ink-faint">
              Self-reported, not promotable
            </span>
          </div>
          <Annotated note={LOCAL_REPORTS_NOTE} className="mt-4">
            <div>
              {reportsFailed ? (
                <p role="status" className="text-[14px] text-ink-secondary">
                  Synced local reports are temporarily unavailable. Hosted and official results are unaffected.
                </p>
              ) : (
                reports.length > 0 && (
                  <LocalReportsTable reports={reports} caption="Self-reported local CogBench results" />
                )
              )}
              {!reportsFailed && untracked.length > 0 && (
                <UntrackedReports reports={untracked} catalog={catalog} separated={reports.length > 0} />
              )}
            </div>
          </Annotated>
        </section>
      )}

      <Reference d={d} firstRun={firstRun} />
    </div>
  );
}

const HOSTED_NOTE =
  "A hosted run scores the commit your branch points to, on our machine with the network off. " +
  "Local runs score the same way with no limit, so that's usually where the iteration happens.";

const PROMOTE_NOTE =
  "There's no undo once an official attempt starts, so it's worth reading what the practice run found first.";

const LOCAL_REPORTS_NOTE = (
  <>
    These come from <code className="font-mono text-[13.5px] not-italic">cogworks sync</code> on your
    own machines. We show them as they arrived and can't check them, so they stay off the
    leaderboard.
  </>
);

/* ── Lead: the live run, or the latest one ─────────────────────────────── */

function LeadRun({
  run,
  live,
  benchmark,
  published,
  justFinished,
  children,
}: {
  run: RunSummary;
  live: boolean;
  benchmark: Benchmark;
  published: boolean;
  /** Finished while this page was open: the one moment worth marking. */
  justFinished: boolean;
  children?: ReactNode;
}) {
  const headingId = useId();

  const summary = live ? null : finishedSummary(run, benchmark, published);
  const action = live
    ? "Open the run"
    : run.status === "failed"
      ? "See what went wrong"
      : run.status === "succeeded"
        ? "Read what it found"
        : "Open the run";

  return (
    <section
      aria-labelledby={headingId}
      className="anim-rise relative rounded-surface border border-rule bg-paper-raised px-5 pt-4 pb-5 shadow-[0_1px_0_rgb(27_31_36/0.04)] sm:px-6 sm:pt-5 sm:pb-6 lg:max-w-[42rem]"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="u-label">{live ? "Running now" : "Latest run"}</p>
        <StatusChip status={run.status} />
      </div>
      <h2 id={headingId} className="mt-2 text-[clamp(1.375rem,1.2rem+0.8vw,1.75rem)]">
        <Link to={`/runs/${run.id}`} className="decoration-rule-strong underline-offset-4 hover:underline">
          {runTitle(run)}
        </Link>
      </h2>
      <p className="mt-1 font-mono text-[12.5px] break-words text-ink-faint">
        {runNumberLabel(run.id)} · {run.shortSha}
        {live && <> · started {formatTimeAgo(run.createdAt)}</>}
        {live && run.mode === "official" && <> · logs kept back</>}
      </p>

      {live ? (
        <>
          <div className="mt-6">
            <PhaseRail status={run.status} failure={run.failure} />
          </div>
          {run.status === "queued" && (
            <p className="mt-5 max-w-[58ch] text-[14px] leading-[1.6] text-ink-secondary">{QUEUED_WAIT_NOTE}</p>
          )}
          <p className="mt-5 text-[13px] text-ink-faint">
            This card checks back every two seconds, so there's no need to reload.
          </p>
        </>
      ) : (
        <div className="mt-4">
          <p className={`text-[17px] leading-snug ${run.status === "failed" ? "font-semibold text-ink" : "text-ink"}`}>
            {justFinished ? <Marked>{summary?.statement}</Marked> : summary?.statement}
          </p>
          {run.primaryMetric && (
            <p className="u-tnum mt-2 font-mono text-[13.5px] text-ink-secondary">
              {run.primaryMetric.label}{" "}
              <span className="font-semibold text-ink">{formatMetricValue(run.primaryMetric)}</span>
            </p>
          )}
          {run.failure?.detail && (
            <p className="mt-2 font-mono text-[13px] break-words text-detect-deep">{run.failure.detail}</p>
          )}
          {summary?.detail && (
            <p className="mt-2 max-w-[58ch] text-[14px] leading-[1.6] text-ink-secondary">{summary.detail}</p>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Link to={`/runs/${run.id}`} className={buttonClass("ghost")}>
          {action}
        </Link>
        {published && !live && (
          <Link to={`/leaderboard?benchmark=${encodeURIComponent(benchmark.id)}`} className="u-link u-hit-44 relative text-[14px]">
            See the leaderboard
          </Link>
        )}
      </div>

      {children}
    </section>
  );
}

/**
 * A finished run in words: what happened, then what it cost. The failure title
 * comes from the catalog the run page uses, so both pages name a failure the
 * same way; whether an official attempt was spent is the server's own flag.
 */
function finishedSummary(
  run: RunSummary,
  benchmark: Benchmark,
  published: boolean,
): { statement: string; detail: string | null } {
  const ago = formatTimeAgo(run.finishedAt ?? run.createdAt);
  if (run.status === "failed" && run.failure) {
    const copy = resolveFailureCopy(run.failure.category, {
      benchmarkId: benchmark.id,
      module: benchmark.module,
    });
    const attempt = run.attemptNumber ? `official attempt #${run.attemptNumber}` : "an official attempt";
    const spent =
      run.mode === "official"
        ? run.failure.consumedAttempt
          ? `It used ${attempt}.`
          : "It didn't use an official attempt."
        : "Failed runs don't use your hosted budget.";
    return {
      statement: `${copy.title}.`,
      detail: `Stopped at ${PHASE_LABELS[run.failure.phase]} ${ago}. ${spent}`,
    };
  }
  if (run.status === "succeeded") {
    return {
      statement: `Finished ${ago}.`,
      detail: published ? "It's your team's result on the leaderboard." : null,
    };
  }
  if (run.status === "cancelled") return { statement: `Cancelled ${ago}.`, detail: null };
  // Still moving, but the payload named no active run: it is between polls.
  return { statement: `${STATUS_LABELS[run.status]}.`, detail: null };
}

/**
 * A highlighter stroke drawn under a sentence, left to right, once. Used only
 * for a run that finished while the student watched, which is the moment the
 * page exists for. Under reduced motion the stroke renders already drawn.
 *
 * The check is explicit because MotionConfig reducedMotion="user" does not
 * cover this: Motion 12.42 only drops animations on its positional keys (x,
 * scaleX, width...), and a raw `transform` string is not one of them.
 * Exported for test/runs-page.test.ts.
 */
export function Marked({ children }: { children: ReactNode }) {
  const still = useReducedMotionConfig();
  return (
    <span className="relative isolate inline-block">
      <motion.span
        aria-hidden="true"
        initial={still ? false : { transform: "scaleX(0)" }}
        animate={{ transform: "scaleX(1)" }}
        transition={{ duration: 0.28, ease: EASE_OUT, delay: 0.12 }}
        className="absolute inset-x-[-3px] bottom-[0.08em] -z-10 h-[0.62em] origin-left rounded-[2px] bg-marker/80"
      />
      {children}
    </span>
  );
}

/* ── Promotion ─────────────────────────────────────────────────────────── */

function Promotion({
  d,
  candidate,
  inLead = false,
}: {
  d: Dashboard;
  candidate: NonNullable<Dashboard["latestCandidate"]>;
  /** Inside the lead card, which already names the run. */
  inLead?: boolean;
}) {
  const promote = usePromote();
  const promoteError = promote.error instanceof ApiRequestError ? promote.error : null;
  const officialLeft = d.quota.officialLimit - d.quota.officialUsed;
  // Why the candidate cannot be promoted: which repository it came from, or
  // whether its saved environment can still be reused. The server answers the
  // source first, so that sentence is the one that applies.
  const refusal = candidate.sourceRefusal ?? d.promotionRefusal;
  // Promoting a run twice returns its first attempt and spends nothing, so a
  // promoted candidate links to that attempt instead of offering a confirm
  // that names the next attempt number.
  const promotedTo = candidate.promotedTo;
  const nextAttempt = d.quota.officialUsed + 1;
  const otherSource = !candidate.repo || candidate.repo.fullName !== d.team.repo?.fullName;

  const label = refusal ? "Can't be promoted" : promotedTo ? "Promoted" : "Ready to promote";
  const sentence = refusal
    ? refusal
    : promotedTo
      ? "A run is promoted once, so the next official attempt starts from a new practice run."
      : officialLeft <= 0
        ? `All ${d.quota.officialLimit} official attempts on this version are used.`
        : `Promoting scores this same commit once against the hidden set, with its logs kept back. It would use official attempt ${nextAttempt} of ${d.quota.officialLimit}.`;

  const body = (
    <>
      <p className={`u-label ${refusal || promotedTo ? "" : "text-verify-deep"}`}>{label}</p>
      {!inLead && (
        <>
          <h2 className="mt-1.5 text-[20px]">
            <Link
              to={`/runs/${candidate.id}`}
              className="decoration-rule-strong underline-offset-4 hover:underline"
            >
              {runTitle(candidate)}
            </Link>
          </h2>
          <p className="u-tnum mt-1 font-mono text-[12.5px] break-words text-ink-faint">
            {candidate.primaryMetric && (
              <span className="text-ink-secondary">
                {candidate.primaryMetric.label} {formatMetricValue(candidate.primaryMetric)}
                {" · "}
              </span>
            )}
            {runNumberLabel(candidate.id)} · {candidate.shortSha}
            {otherSource && <> · {candidate.repo?.fullName ?? "source not recorded"}</>}
          </p>
        </>
      )}
      <p className="mt-2 max-w-[56ch] text-[14px] leading-[1.6] text-ink-secondary">{sentence}</p>
      {(promotedTo || !refusal) && (
        <div className="mt-4">
          {promotedTo ? (
            <Link to={`/runs/${promotedTo.runId}`} className={buttonClass("ghost")}>
              {promotedTo.attemptNumber === null
                ? "Official attempt"
                : `Official attempt #${promotedTo.attemptNumber}`}
            </Link>
          ) : (
            <ConfirmButton
              label="Promote to official"
              confirmLabel={`Confirm, uses attempt ${nextAttempt} of ${OFFICIAL_LIMIT}`}
              onConfirm={() => promote.mutate(candidate.id)}
              busy={promote.isPending}
              disabled={officialLeft <= 0}
            />
          )}
        </div>
      )}
      {promoteError && (
        <p role="alert" className="mt-3 text-[14px] text-detect-deep">
          {promoteError.message}
        </p>
      )}
    </>
  );

  return inLead ? (
    <div className="mt-6 border-t border-rule pt-5">{body}</div>
  ) : (
    <section className="rounded-surface border border-rule px-5 py-4 sm:px-6 sm:py-5">{body}</section>
  );
}

/* ── Launcher ──────────────────────────────────────────────────────────── */

/**
 * The branch survives a run starting and ending (and a track switch), because
 * a team iterating on a feature branch would otherwise pick it again after
 * every run. It falls back to the default branch when the chosen one is no
 * longer offered.
 */
let rememberedBranch: string | null = null;

function Launcher({
  d,
  branches,
  branchesFailed,
}: {
  d: Dashboard;
  branches: string[];
  branchesFailed: boolean;
}) {
  // The dashboard payload is already scoped to the selected track, so its own
  // benchmark id is the one to run; anything else would start a run the
  // student isn't looking at.
  const startPractice = useStartPractice(d.benchmark.id);
  const fallback = d.team.repo?.defaultBranch ?? branches[0] ?? "main";
  const [chosen, setChosen] = useState(rememberedBranch);
  const branch = chosen && branches.includes(chosen) ? chosen : fallback;
  const practiceLeft = d.quota.practiceLimit - d.quota.practiceUsed;
  const startError = startPractice.error instanceof ApiRequestError ? startPractice.error : null;

  if (practiceLeft <= 0) {
    return (
      <div className="space-y-3">
        <p className="max-w-[56ch] text-[15px] leading-[1.6] text-ink">
          All {d.quota.practiceLimit} hosted practice runs on this version are used. Local runs
          score the same way and have no limit:
        </p>
        <Code lang="bash" code={`cogworks run --benchmark ${d.benchmark.id}`} wrap />
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-[1_1_14rem]">
          <label htmlFor="branch" className="u-label block">
            Branch
          </label>
          <select
            id="branch"
            value={branch}
            onChange={(e) => {
              rememberedBranch = e.target.value;
              setChosen(e.target.value);
            }}
            className="u-field mt-1.5 font-mono"
          >
            {(branches.includes(branch) ? branches : [branch, ...branches]).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={() => startPractice.mutate(branch)} busy={startPractice.isPending}>
          Run practice benchmark
        </Button>
      </div>
      <p className="mt-3 text-[14px] text-ink-secondary">
        <span className="u-tnum font-semibold text-ink">
          {practiceLeft} of {d.quota.practiceLimit}
        </span>{" "}
        hosted practice runs left on this version; a run that fails doesn't count.
      </p>
      {branchesFailed && (
        <p className="mt-2 text-[14px] text-ink-secondary">
          We couldn't load the branch list from GitHub, so only {fallback} is offered. Reload the
          page to try again.
        </p>
      )}
      {startError && (
        <p role="alert" className="mt-3 text-[14px] text-detect-deep">
          {startError.code === "active_run_exists"
            ? "A run is already in progress; runs go one at a time per benchmark."
            : startError.message}
        </p>
      )}
    </div>
  );
}

/* ── First run ─────────────────────────────────────────────────────────── */

function FirstRun({
  d,
  branches,
  branchesFailed,
}: {
  d: Dashboard;
  branches: string[];
  branchesFailed: boolean;
}) {
  const officialLeft = d.quota.officialLimit - d.quota.officialUsed;
  return (
    <Annotated
      note={
        // A team that has never run has no history to read the two kinds of
        // run off, and the difference decides which one to use today.
        "Both kinds of run score your code the same way. Local runs have no limit, so that's " +
        "usually where the iteration happens."
      }
    >
      <section
        aria-labelledby="first-run-heading"
        className="anim-rise rounded-surface border border-rule bg-paper-raised px-5 pt-5 pb-6 sm:px-6"
      >
        <h2 id="first-run-heading" className="text-[clamp(1.375rem,1.2rem+0.8vw,1.75rem)]">
          Run it for the first time
        </h2>
        <p className="mt-2 max-w-[56ch] text-[15px] leading-[1.6] text-ink-secondary">
          Nothing has run on {d.benchmark.title} yet. There are two ways to start, and you can use both.
        </p>

        <div className="mt-6">
          <h3 className="font-sans text-[16px] font-bold tracking-normal text-ink">Here, from your pushed commit</h3>
          <p className="mt-1 mb-4 max-w-[56ch] text-[14px] leading-[1.6] text-ink-secondary">
            A hosted run scores the commit your branch points to on GitHub. One that succeeds can
            be promoted to one of your {officialLeft} official{" "}
            {officialLeft === 1 ? "attempt" : "attempts"}, which score the hidden set.
          </p>
          <Launcher d={d} branches={branches} branchesFailed={branchesFailed} />
        </div>

        {/* min-w-0 lets the code block scroll inside the sheet instead of
            widening the page on a phone. */}
        <div className="mt-7 min-w-0 border-t border-rule-soft pt-6">
          <h3 className="font-sans text-[16px] font-bold tracking-normal text-ink">On your machine, as often as you like</h3>
          {/* These assume an installed tool and a linked machine, which a
              student who came straight here has not set up. It names the
              prerequisite and links to it; it does not gate the hosted
              launcher above, which needs nothing local. */}
          <p className="mt-1 mb-3 text-[14px] leading-[1.6] text-ink-secondary">
            These need the CogWorks tool from{" "}
            <Link to="/setup" className="u-link">
              Setup
            </Link>{" "}
            first. The commands already name this benchmark.
          </p>
          <Code
            lang="bash"
            code={
              `cogworks check --benchmark ${d.benchmark.id}\n` +
              `cogworks run --benchmark ${d.benchmark.id}\n` +
              `cogworks sync`
            }
            wrap
          />
        </div>
      </section>
    </Annotated>
  );
}

/* ── Local reports with no track ───────────────────────────────────────── */

/**
 * Reports synced for a benchmark version that no track shows. Rows name the
 * benchmark and never the person who synced it, because a name next to a
 * number is a per-person number (docs/design/the-instrument-not-the-judge.md).
 */
function UntrackedReports({
  reports,
  catalog,
  separated,
}: {
  reports: LocalReport[];
  /** The whole catalog, inactive rows included, for titles. */
  catalog: Benchmark[];
  /** A track table sits above, so the group needs a rule between them. */
  separated: boolean;
}) {
  return (
    <section
      aria-labelledby="untracked-reports-heading"
      className={separated ? "mt-6 border-t border-rule-soft pt-5" : undefined}
    >
      <h3 id="untracked-reports-heading" className="font-sans text-[15px] font-bold tracking-normal text-ink">
        Other benchmarks
      </h3>
      <p className="mt-1 max-w-[62ch] text-[14px] leading-[1.55] text-ink-secondary">
        Reports from benchmarks or versions that are not open for hosted runs.
      </p>
      <div className="mt-3">
        <LocalReportsTable
          reports={reports}
          catalog={catalog}
          caption="Self-reported local CogBench results for benchmark versions without a track"
        />
      </div>
    </section>
  );
}

/* ── For reference ─────────────────────────────────────────────────────── */

/**
 * The standing facts, kept quiet at the foot of the page: they rarely change
 * between visits, and none of them is the thing a student came to do. Before
 * the first run only the facts that exist without one are shown.
 */
function Reference({ d, firstRun }: { d: Dashboard; firstRun: boolean }) {
  const repo = d.team.repo;
  const selection = d.selection;
  return (
    <section aria-labelledby="reference-heading" className="border-t border-rule pt-6">
      <h2 id="reference-heading" className="u-label">
        For reference
      </h2>
      {/* Two columns even on a phone, so the two budgets sit side by side;
          the longer facts take the full width there. */}
      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-3 lg:gap-x-10">
        <Fact term="Repository" wide>
          {repo ? (
            <a
              href={repo.url}
              target="_blank"
              rel="noreferrer"
              className="u-link u-hit-44 relative font-mono text-[13px] break-all"
            >
              {repo.fullName}
            </a>
          ) : (
            <span className="text-[14px] text-ink-secondary">No repository connected.</span>
          )}
        </Fact>
        <Fact term="Hosted machine" wide>
          <span className="font-mono text-[13px] text-ink-secondary">
            {d.benchmark.runtimeVersion} · CPU · network off while scoring
          </span>
        </Fact>
        {!firstRun && repo && (
          <Fact term="Last tested commit" wide>
            {d.lastResolvedSha ? (
              <ShaChip sha={d.lastResolvedSha} shortSha={d.lastResolvedSha.slice(0, 7)} />
            ) : (
              // A team can have runs that belong to a repository it has since
              // left, or runs from before the source was recorded. Neither is
              // "nothing yet", and this can only speak for the repository
              // named beside it.
              <span className="text-[14px] text-ink-secondary">None recorded for this repository</span>
            )}
          </Fact>
        )}
        {!firstRun && (
          <>
            <Fact term="Hosted practice">
              <QuotaCells
                used={d.quota.practiceUsed}
                limit={d.quota.practiceLimit}
                label="Hosted practice"
                showLabel={false}
              />
            </Fact>
            <Fact term="Official attempts">
              <QuotaCells
                used={d.quota.officialUsed}
                limit={d.quota.officialLimit}
                label="Official attempts"
                tone="detect"
                showLabel={false}
              />
            </Fact>
          </>
        )}
        {selection && (
          <Fact term="On the leaderboard" wide>
            {/* Which run is public leads; its number is the reading under it.
                A team ranks itself against a headline figure and does not
                against an identifier, and the run is what they would open
                next anyway. */}
            <p className="font-mono text-[13px] text-ink">
              {selection.attemptNumber ? `Attempt #${selection.attemptNumber} · ` : ""}
              {selection.shortSha}
            </p>
            <p className="mt-0.5 font-mono text-[12.5px] break-words text-ink-faint">
              {selection.source?.fullName ?? "source not recorded"}
            </p>
            <p className="u-tnum mt-0.5 font-mono text-[12.5px] text-ink-secondary">
              {selection.primaryMetric.label} {formatMetricValue(selection.primaryMetric)}
            </p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
              <Link to={`/runs/${selection.runId}`} className="u-link u-hit-44 relative">
                Open the run
              </Link>
              <Link to={`/leaderboard?benchmark=${encodeURIComponent(d.benchmark.id)}`} className="u-link u-hit-44 relative">
                Leaderboard
              </Link>
            </p>
          </Fact>
        )}
      </dl>
    </section>
  );
}

function Fact({ term, wide = false, children }: { term: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2 sm:col-span-1" : ""}`}>
      <dt className="text-[13px] font-semibold text-ink-faint">{term}</dt>
      <dd className="mt-1.5">{children}</dd>
    </div>
  );
}
