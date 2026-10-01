import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft01Icon, ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiRequestError } from "@/lib/api";
import {
  OFFICIAL_LIMIT,
  isTerminal,
  runSurfaceCurrentRunId,
  type PromotedTo,
  type RunDetail,
  type RunSummary,
} from "@cogworks/contracts/schema";
import { resolveFailureCopy } from "@cogworks/contracts/failures";
import { Button, buttonClass } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { FailureCard } from "@/components/FailureCard";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { LogView } from "@/components/LogView";
import { Finding, FINDING_KICKER } from "@/components/Finding";
import { PrimaryMetric, SupportingMetrics } from "@/components/MetricBlock";
import { Annotated } from "@/components/Note";
import { SweepTrace } from "@/components/SweepTrace";
import { WiringTrace } from "@/components/WiringTrace";
import { PhaseRail } from "@/components/PhaseRail";
import { ShaChip } from "@/components/ShaChip";
import { SimulatedChip } from "@/components/SimulatedChip";
import { StatusChip } from "@/components/StatusChip";
import { formatDateTime, formatDurationMs, runNumberLabel } from "@/lib/format";
import {
  DEFAULT_BENCHMARK,
  useBenchmarks,
  useDashboard,
  useMutateRunSurface,
  usePromote,
  useRun,
  useRunSurface,
  useSelectResult,
  useSession,
} from "@/lib/queries";
import { QUEUED_WAIT_NOTE, STATUS_LABELS } from "@/lib/run-meta";

/**
 * Run detail. A run page leads with what the run shows, not what it scored
 * (docs/design/the-instrument-not-the-judge.md), so the order down the page
 * is the order of visual weight that document sets:
 *
 * - A run that finished: the benchmark's finding and its trace, the team's
 *   own functions as the platform ran them, then the readings as a footnote
 *   table, then the one decision the run offers (promote or publish), then
 *   the pipeline it went through and the folded log.
 * - A run that failed: the failure card (what happened, the benchmark's note,
 *   one next action), then the pipeline showing where it stopped.
 * - A run still going: the pipeline, live.
 *
 * Practice runs show capped logs; official runs show aggregate metrics and
 * safe diagnostics only.
 */
export function RunDetailPage() {
  const { runId = "" } = useParams();
  const runQuery = useRun(runId);
  const { data: sessionData } = useSession();
  // Quota and failure copy belong to *this run's* benchmark, not
  // to whichever track the dashboard happens to default to. The fallback only
  // covers the first render, before the run record arrives.
  const runBenchmarkId = runQuery.data?.benchmarkId ?? DEFAULT_BENCHMARK;
  const benchmarks = useBenchmarks();
  const runBenchmark = benchmarks.data?.find((b) => b.id === runBenchmarkId);
  const runModule = runBenchmark?.module;
  // Cached alongside the dashboard: supplies quota, selection context, and
  // the team's earlier runs this one is compared against.
  const dashboard = useDashboard(runBenchmarkId, Boolean(runQuery.data));
  const previous =
    runQuery.data?.status === "succeeded"
      ? previousComparable(runQuery.data, dashboard.data?.runs)
      : null;
  const previousDetail = usePreviousRunDetail(previous?.id ?? null);
  // Retry and Promote start a new run and bring the student here; the
  // control they pressed is gone, so focus moves to the run they started.
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loadedId = runQuery.data?.id;
  // SAFETY: react-router types `state` as `any`; this page is only navigated
  // to with state by FOCUS_NEW_RUN below, and any other state lacks the key.
  const focusHeading = (location.state as RunPageState | null)?.focusHeading === true;
  useEffect(() => {
    if (loadedId && focusHeading) headingRef.current?.focus();
  }, [loadedId, location.key, focusHeading]);

  if (runQuery.isPending) return <LoadingMark label="Reading run record" />;
  if (runQuery.isError) {
    return (
      <div className="py-14">
        <QueryError error={runQuery.error} retry={() => void runQuery.refetch()}>
          <Link to="/dashboard" className={buttonClass("ghost")}>
            Back to your runs
          </Link>
        </QueryError>
      </div>
    );
  }

  const run = runQuery.data;
  const live = !isTerminal(run.status);
  const failed = run.status === "failed";
  const failureCopy = run.failure
    ? resolveFailureCopy(run.failure.category, { benchmarkId: run.benchmarkId, module: runModule })
    : null;
  // Retry belongs on the failure it answers, not a page away on the console.
  // A refusal says what to change in the code, so it is never offered there.
  const retrySurfaceId =
    failed && !run.refusal && failureCopy && failureCopy.remedy !== "fix" ? run.surfaceId : null;
  const duration =
    run.finishedAt != null ? formatDurationMs(run.finishedAt - run.createdAt) : null;
  const practiceLog = run.mode === "practice" ? run.log : null;
  const consoleHref = run.surfaceId ? `/run-surfaces/${encodeURIComponent(run.surfaceId)}` : null;

  return (
    <div className="page anim-rise">
      <nav aria-label="Run" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        <Link
          to="/dashboard"
          className="u-pressable -ml-1 inline-flex min-h-11 items-center gap-1 px-1 text-[14px] font-semibold text-ink-secondary hover:text-ink"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={15} strokeWidth={2} aria-hidden="true" />
          Runs
        </Link>
        {consoleHref && (
          <Link
            to={consoleHref}
            className="u-link inline-flex min-h-11 items-center text-[14px]"
          >
            Open current run
          </Link>
        )}
      </nav>

      {/* ── Masthead ── */}
      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="u-eyebrow">{runBenchmark?.title ?? run.benchmarkId}</span>
          <StatusChip status={run.status} />
          {sessionData?.auth.executionProvider === "fixture" && <SimulatedChip />}
        </div>
        {/* Smaller than the finding on purpose: the title names the run, and
            the finding is what the page is for, so it gets the largest type.
            A branch name can be one long unbroken word, which without
            `anywhere` widens the page past a phone's screen. */}
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mt-2 text-[clamp(1.55rem,1.35rem+0.9vw,1.75rem)] [overflow-wrap:anywhere] text-ink"
        >
          {runTitle(run)}
        </h1>
        {/* Each item leads with its separator; the row starts one separator left
            of the clip, so an item that begins a wrapped line hides it. The
            margin widens the row leftward only; its right edge stays on the
            clip's. The clip sits 6px out so a focus outline survives; the glyph
            is 12px further. */}
        <div className="mt-3 [clip-path:inset(-8px_-8px_-8px_-6px)]">
          <p className="-ml-6 flex flex-wrap items-center gap-y-1 font-mono text-[12.5px] text-ink-secondary">
            <MetaItem>{runNumberLabel(run.id)}</MetaItem>
            {/* The repository this run used, which is not always the one the
                team is connected to now. Without it a commit sits here with
                nothing saying which repository it belongs to. */}
            <MetaItem>
              {run.repo ? (
                <a href={run.repo.url} target="_blank" rel="noreferrer" className="u-link">
                  {run.repo.fullName}
                  <span className="sr-only"> (opens GitHub)</span>
                </a>
              ) : (
                <span className="text-ink-faint" title="This run predates the recorded repository name.">
                  repository not recorded
                </span>
              )}
            </MetaItem>
            <MetaItem>
              <ShaChip sha={run.sha} shortSha={run.shortSha} />
            </MetaItem>
            <MetaItem>{formatDateTime(run.createdAt)}</MetaItem>
            {duration && (
              <MetaItem>
                <span className="u-tnum">{duration}</span>
              </MetaItem>
            )}
            <MetaItem>
              {run.benchmarkId} v{run.benchmarkVersion}
            </MetaItem>
          </p>
        </div>
        {run.weightsSupplied.length > 0 && (
          <p className="mt-2 font-mono text-[12px] leading-relaxed break-words text-ink-faint">
            {run.weightsSupplied.join(", ")} from your local run at {run.shortSha}
          </p>
        )}
      </header>
      <div aria-live="polite" className="sr-only">
        Run status: {STATUS_LABELS[run.status]}
      </div>

      {/* ── Failure ── */}
      {failed && (
        <NoteAfter
          className="mt-10"
          // Only a completed evaluation counts against quota
          // (worker/services/run-accounting.ts), which is the reassurance a
          // student needs at the moment a run fails.
          note={
            run.mode === "official"
              ? "A failed official attempt doesn't use one up."
              : "A failed run doesn't count against your practice runs."
          }
        >
          <FailureCard
            key={run.id}
            failure={run.failure}
            mode={run.mode}
            benchmarkId={run.benchmarkId}
            module={runModule}
            refusal={run.refusal}
            next={retrySurfaceId ? <RetryControl run={run} surfaceId={retrySurfaceId} /> : undefined}
          >
            {/* What the execution recorded before it stopped. It belongs to
                this failed execution and is never presented as a result, so
                it stays under the details. */}
            {hasRecordedFindings(run) && (
              <div className="space-y-6 pt-1">
                <p className="u-label">Recorded before it stopped</p>
                {run.diagnostics.length > 0 && (
                  <Finding sentence={run.diagnostics[0]} supporting={run.diagnostics.slice(1)} />
                )}
                {run.sweep && <SweepTrace sweep={run.sweep} />}
                {run.wiring.length > 0 && <WiringTrace steps={run.wiring} />}
                {run.metrics.length > 0 && (
                  <SupportingMetrics metrics={run.metrics} rolesRecorded={rolesRecorded(run)} />
                )}
              </div>
            )}
          </FailureCard>
        </NoteAfter>
      )}

      {/* ── What a finished run shows ── */}
      {/* Gated on the run succeeding, NOT on there being an overall score. A
          benchmark can withhold the primary and still have measured plenty:
          week 3 withholds `overall` when the image side is unmeasured and
          still reports the text metrics, their floors, and a diagnostic
          saying why. Gating this block on `primary` hid the finding, the
          sweep, the wiring and every supporting number behind an absence,
          which is the one case where a student most needs to see what the
          scorer did manage to do. */}
      {run.status === "succeeded" && (
        <Results run={run} previous={previous} previousDetail={previousDetail} />
      )}

      {/* ── The one decision a finished run offers ── */}
      {run.status === "succeeded" && run.mode === "practice" && (
        <PromoteSection run={run} quota={dashboard.data?.quota} />
      )}
      {run.publishable && <PublishSection run={run} />}

      {/* ── Pipeline ── */}
      <Section title="Pipeline" first={live}>
        <PhaseRail status={run.status} failure={run.failure} phases={run.phases} showTimings />
        {run.status === "queued" && (
          <p className="mt-5 max-w-[60ch] text-[14px] leading-[1.55] text-ink-secondary">
            {QUEUED_WAIT_NOTE}
          </p>
        )}
        {live && (
          <p className="mt-5 border-t border-rule-soft pt-3 font-mono text-[12px] text-ink-faint">
            {run.mode === "official"
              ? "Logs are kept back for official attempts."
              : "Updates every 2 s."}
          </p>
        )}
      </Section>

      {/* ── Log (practice only) ── */}
      {practiceLog && (
        <div className="mt-10 max-w-[var(--measure,42rem)]">
          <LogView log={practiceLog} />
        </div>
      )}
    </div>
  );
}

/** Navigation state for a page reached by starting a run from another one. */
type RunPageState = { focusHeading?: boolean };
const FOCUS_NEW_RUN = { state: { focusHeading: true } } satisfies { state: RunPageState };

/* ── Pieces ─────────────────────────────────────────────────────────────── */

/** The title a person would give the run: what kind of run, on what. */
function runTitle(run: RunDetail): string {
  const kind =
    run.mode === "official"
      ? run.attemptNumber === null
        ? "Official attempt"
        : `Official attempt ${run.attemptNumber}`
      : "Practice run";
  // The branch is the name a team knows its work by. A run resolved from a
  // bare commit has none, and "on detached" would read as a branch name.
  return run.branch === "detached" ? `${kind} on a detached commit` : `${kind} on ${run.branch}`;
}

function MetaItem({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 max-w-full items-center">
      <span aria-hidden="true" className="w-6 shrink-0 text-center text-ink-faint">·</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </span>
  );
}

/**
 * The work first and its margin note second, in the DOM as well as on screen.
 *
 * `Annotated` puts the reason before the work, which suits an instruction.
 * The finding and the failure are themselves the thing to read first, and on
 * a phone (where the note stacks) a note above them would push them down the
 * screen. From 1024px the shared `.annotated` grid places the note in the
 * margin either way.
 */
function NoteAfter({
  note,
  className = "",
  children,
}: {
  note?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  if (!note) return <div className={`max-w-[var(--measure,42rem)] ${className}`}>{children}</div>;
  return (
    <div className={`annotated ${className}`}>
      <div className="annotated-body">{children}</div>
      <div className="annotated-note u-note">{note}</div>
    </div>
  );
}

/**
 * A ruled section of the run page with its reason in the margin.
 *
 * Sections are separated by a pencil rule and a serif title rather than each
 * sitting in its own bordered panel: a page of identical boxes gives every
 * part the same weight, and this page's whole argument is that the parts do
 * not have the same weight.
 */
function Section({
  title,
  note,
  aside,
  first = false,
  children,
}: {
  title: string;
  note?: ReactNode;
  aside?: ReactNode;
  /** Directly under the masthead, where a rule would separate nothing. */
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={first ? "mt-10" : "mt-12 border-t border-rule pt-6"}>
      {/* The title stays above the note, so on a phone (where the note
          stacks over its work) a reader still meets the section's name
          first. */}
      <div className="flex max-w-[var(--measure,42rem)] flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[20px] text-ink">{title}</h2>
        {aside}
      </div>
      <Annotated note={note} className={`mt-4 ${note ? "" : "max-w-[var(--measure,42rem)]"}`}>
        {children}
      </Annotated>
    </section>
  );
}

function rolesRecorded(run: RunDetail): boolean {
  // Whether this result carried role metadata at all. A run stored before the
  // portal kept `role` has none, and a floor is then indistinguishable from a
  // scored metric, so nothing on the page claims a direction for it.
  return run.metrics.some((m) => m.role != null);
}

function hasRecordedFindings(run: RunDetail): boolean {
  return run.diagnostics.length > 0 || run.sweep != null || run.wiring.length > 0 || run.metrics.length > 0;
}

/**
 * The run this one is compared against: the team's most recent earlier run
 * that succeeded in the same mode on the same benchmark version.
 *
 * Same mode, because a practice run and an official attempt score different
 * splits; same version, because a new version can change what a metric
 * measures. Read from the dashboard's run list (newest first, the latest 50),
 * so a run older than that has no comparison rather than a wrong one.
 */
function previousComparable(run: RunDetail, runs: RunSummary[] | undefined): RunSummary | null {
  if (!runs) return null;
  return (
    runs.find(
      (candidate) =>
        candidate.id !== run.id &&
        candidate.status === "succeeded" &&
        candidate.mode === run.mode &&
        candidate.benchmarkId === run.benchmarkId &&
        candidate.benchmarkVersion === run.benchmarkVersion &&
        candidate.createdAt < run.createdAt,
    ) ?? null
  );
}

/**
 * The previous comparable run's record, under the same cache key as `useRun`
 * so it is shared with that run's own page.
 *
 * A hook on the page rather than `useRun` in a wrapper component. The
 * dashboard that names the previous run can arrive after the page is up, and
 * a wrapper that appeared at that moment put `Results` under a new parent:
 * React remounted the readings, which closed an open row and dropped its
 * focus to the body. `useRun` cannot be switched off, so this skips the fetch
 * while there is nothing to compare against. The previous run has succeeded,
 * so it needs none of `useRun`'s polling.
 */
function usePreviousRunDetail(id: string | null): RunDetail | null {
  const query = useQuery({
    queryKey: ["run", id],
    queryFn: id === null ? skipToken : () => api.run(id),
  });
  return query.data ?? null;
}

function Results({
  run,
  previous,
  previousDetail,
}: {
  run: RunDetail;
  previous: RunSummary | null;
  previousDetail: RunDetail | null;
}) {
  const primary = run.metrics.find((m) => m.primary) ?? null;
  // A floor of the primary belongs beside the primary. It cannot fold into a
  // supporting row, because the primary is not in that list, so without this
  // it renders at the bottom of the page as a number with nothing to compare
  // it to. Week 1 declares two.
  const primaryFloors = primary
    ? run.metrics.filter((m) => m.role === "floor" && m.relatesTo === primary.key)
    : [];
  const supporting = run.metrics.filter((m) => !m.primary && !primaryFloors.includes(m));
  const roles = rolesRecorded(run);
  // The summary carries the previous primary as soon as the dashboard loads;
  // the rest of its metrics arrive with its own record.
  const previousMetrics = previousDetail?.metrics ?? null;
  const previousPrimary = primary
    ? previousMetrics?.find((m) => m.key === primary.key) ??
      (previous?.primaryMetric?.key === primary.key ? previous.primaryMetric : undefined)
    : undefined;
  const previousTag = previous ? runNumberLabel(previous.id) : null;
  const hasFinding = run.diagnostics.length > 0;
  const hasReadings = Boolean(primary) || supporting.length > 0;

  return (
    <>
      {/* The finding leads. A team reading 0.53 with nothing else has to
          guess which half of their pipeline produced it, and the scorer
          already knows: its first diagnostic names the stage and the cause.
          The number is below, where a reading sits under the trace that
          explains it. */}
      <section aria-label={FINDING_KICKER} className="mt-10">
        <NoteAfter>
          {hasFinding ? (
            <Finding sentence={run.diagnostics[0]} supporting={run.diagnostics.slice(1)} />
          ) : (
            // Said plainly rather than filled with the overall score set
            // large. A clean run can leave the scorer nothing to say; the
            // sentence slot stays a sentence so the number does not take it.
            <div>
              <p className="u-label">{FINDING_KICKER}</p>
              <p className="mt-2 max-w-[36rem] font-serif text-[19px] leading-[1.4] text-ink-secondary italic sm:text-[21px]">
                {run.sweep || hasReadings
                  ? "The scorer didn't write a finding for this run."
                  : "The scorer didn't write a finding or record any readings for this run."}
              </p>
            </div>
          )}
        </NoteAfter>
        <div className="max-w-[var(--measure,42rem)]">
          {run.sweep && (
            <div className="mt-8">
              <SweepTrace
                sweep={run.sweep}
                previous={previousDetail?.sweep ?? null}
                previousLabel={previousTag ?? undefined}
              />
            </div>
          )}
          {/* Below the finding, above the number. Nothing in a 2026
              repository says which function is the peak finder, so the
              platform found theirs by running them; this says which ones it
              settled on. It sits here because a team checks it when a score
              surprises them, which is after they have read the finding and
              before they argue with the number. Absent for a repository that
              declared its own submission: nothing was inferred. */}
          {run.wiring.length > 0 && (
            <div className="mt-9">
              <WiringTrace steps={run.wiring} />
            </div>
          )}
        </div>
      </section>

      {hasReadings && (
        <Section
          title="Readings"
          aside={
            <span className="font-mono text-[12px] text-ink-faint">
              {run.mode === "practice" ? "Public practice split." : "Hidden official split."}
            </span>
          }
          note={
            previous ? (
              // Names a branch, which can be one long unbroken word.
              <span className="[overflow-wrap:anywhere]">
                Changes are against{" "}
                <Link to={`/runs/${previous.id}`} className="u-link not-italic">
                  {previousTag}
                </Link>
                , your previous {run.mode === "official" ? "official attempt" : "practice run"}
                {previous.branch !== "detached" ? <> on {previous.branch}</> : null}.
              </span>
            ) : run.mode === "official" && run.parentRunId ? (
              <>
                Promoted from{" "}
                <Link to={`/runs/${run.parentRunId}`} className="u-link not-italic">
                  {runNumberLabel(run.parentRunId)}
                </Link>
                .
              </>
            ) : undefined
          }
        >
          {previous && (
            // The column head for the changes, aligned over the change slot
            // every row keeps.
            <div className="-mt-1 mb-1 flex justify-end">
              <span className="u-kicker w-[7ch] text-right normal-case">change</span>
            </div>
          )}
          {primary ? (
            <div className="border-b border-rule pb-4">
              <PrimaryMetric
                metric={primary}
                floors={primaryFloors}
                rolesRecorded={roles}
                previous={previous ? previousPrimary ?? null : undefined}
              />
            </div>
          ) : (
            // Named, not manufactured. A zero or an invented overall would be
            // a score the scorer refused to give.
            <p className="max-w-[60ch] border-b border-rule pb-4 text-[14.5px] leading-[1.6] text-ink">
              This run has no overall score.
            </p>
          )}
          <div className="mt-1">
            <SupportingMetrics
              metrics={supporting}
              rolesRecorded={roles}
              previous={previous ? previousMetrics ?? [] : null}
            />
          </div>
        </Section>
      )}
    </>
  );
}

/**
 * Retry for a failed run, on the failure it answers. Whether it is offered is
 * the run surface's own answer: the server lists "retry" only when it would
 * start one (capacity, provider, recorded inputs, source), and only for the
 * surface's current execution, so a failure that was already retried is not
 * offered a second start the server would refuse.
 */
function RetryControl({ run, surfaceId }: { run: RunDetail; surfaceId: string }) {
  const surface = useRunSurface(surfaceId);
  const retry = useMutateRunSurface();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // A second press before the busy state renders would send a second request.
  const inFlight = useRef(false);
  const snapshot = surface.data;
  if (!snapshot) {
    if (surface.isError) {
      return (
        <p className="flex flex-wrap items-center gap-x-3 text-[13.5px] text-ink-secondary">
          Couldn't check whether this run can be retried.
          <button type="button" className="u-link min-h-11" onClick={() => void surface.refetch()}>
            Check again
          </button>
        </p>
      );
    }
    // Holds the button's row while eligibility loads, so it doesn't push the
    // page down when it arrives.
    return <div aria-hidden="true" className="min-h-11" />;
  }

  // Already retried: say where that went rather than leave this page a dead end.
  const successor = snapshot.executionHistory.find((entry) => entry.retryOfRunId === run.id);
  if (successor) {
    return (
      <p className="text-[14px] text-ink-secondary">
        Retried as{" "}
        <Link to={`/runs/${encodeURIComponent(successor.id)}`} className="u-link">
          {runNumberLabel(successor.id)}
        </Link>
        .
      </p>
    );
  }
  if (!snapshot.actions.includes("retry") || runSurfaceCurrentRunId(snapshot) !== run.id) {
    // The one refusal the server can name; its absence says nothing about
    // quota or access, so nothing is said then.
    return snapshot.retryRefusal ? (
      <p className="max-w-[60ch] text-[13.5px] leading-[1.55] text-ink-secondary">
        {snapshot.retryRefusal}
      </p>
    ) : null;
  }

  const start = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const next = await retry.mutateAsync({ surfaceId, action: "retry", runId: run.id });
      // Retry starts a separate run; this failure stays in the history.
      const started = runSurfaceCurrentRunId(next);
      if (started && started !== run.id) navigate(`/runs/${encodeURIComponent(started)}`, FOCUS_NEW_RUN);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : "Retry couldn't be started. Try again in a moment.");
    } finally {
      inFlight.current = false;
    }
  };
  const sha = <span className="font-mono text-[13px] text-ink">{run.shortSha}</span>;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {run.mode === "official" ? (
          <ConfirmButton
            label="Retry"
            confirmLabel="Confirm, uses an attempt if it finishes"
            onConfirm={() => void start()}
            busy={retry.isPending}
          />
        ) : (
          <Button busy={retry.isPending} onClick={() => void start()}>
            Retry
          </Button>
        )}
        <p className="max-w-[44ch] text-[13.5px] leading-[1.5] text-ink-secondary">
          {run.mode === "official" ? (
            <>Runs {sha} again on the hidden inputs. It uses an official attempt only if it finishes.</>
          ) : (
            <>Runs {sha} again. It counts as a practice run only if it finishes.</>
          )}
        </p>
      </div>
      {error && (
        <p role="alert" className="mt-3 border-l-2 border-detect pl-3 text-[13.5px] text-detect-deep">
          {error}
        </p>
      )}
    </div>
  );
}

function PromoteSection({
  run,
  quota,
}: {
  run: RunDetail;
  quota: { officialUsed: number; officialLimit: number } | undefined;
}) {
  const promote = usePromote();
  const navigate = useNavigate();
  const exhausted = Boolean(quota && quota.officialUsed >= quota.officialLimit);
  const remaining = quota ? Math.max(0, quota.officialLimit - quota.officialUsed) : null;

  return (
    <Section title="Official attempt">
      {/* The server refuses a promotion of a run that is not about the
          connected repository, or whose saved environment can no longer be
          reused, so the control is not offered. Saying why beats a button
          that fails. The source answer comes first on the server.

          A run already promoted gets its attempt instead. Promoting it
          again returns that attempt and spends nothing, so a confirm
          naming the next attempt number would be a false consequence. */}
      {(run.sourceRefusal ?? run.promotionRefusal) ? (
        <>
          <p className="max-w-[60ch] text-[14.5px] leading-[1.55] text-ink-secondary">
            {run.sourceRefusal ?? run.promotionRefusal}
          </p>
          {run.promotedTo && <PromotedAttemptLink promotedTo={run.promotedTo} />}
        </>
      ) : run.promotedTo ? (
        <>
          <p className="max-w-[60ch] text-[14.5px] leading-[1.55] text-ink-secondary">
            Promoted to {officialAttemptLabel(run.promotedTo.attemptNumber)}.
          </p>
          <PromotedAttemptLink promotedTo={run.promotedTo} />
        </>
      ) : (
        <>
          <p className="max-w-[60ch] text-[14.5px] leading-[1.55] text-ink-secondary">
            Reruns <span className="font-mono text-[13px] text-ink">{run.shortSha}</span> on the
            hidden inputs, with logs kept back. Only official attempts can go on the leaderboard.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
            <ConfirmButton
              label="Promote to official"
              confirmLabel={`Confirm, uses attempt ${(quota?.officialUsed ?? 0) + 1} of ${OFFICIAL_LIMIT}`}
              onConfirm={() =>
                promote.mutate(run.id, {
                  // Promotion creates a separate official run to watch.
                  onSuccess: ({ runId: started }) => navigate(`/runs/${started}`, FOCUS_NEW_RUN),
                })
              }
              busy={promote.isPending}
              disabled={!quota || exhausted}
            />
            {remaining !== null && (
              <span className="text-[14px] text-ink-secondary">
                <span className="u-tnum font-semibold text-ink">
                  {remaining} of {quota?.officialLimit ?? OFFICIAL_LIMIT}
                </span>{" "}
                official attempts left for the team on this version; a failed one doesn't count.
              </span>
            )}
          </div>
          {exhausted && (
            <p className="mt-3 max-w-[60ch] text-[14px] leading-[1.55] text-detect-deep">
              All official attempts on this version are used. You can still
              publish any successful official attempt.
            </p>
          )}
          {/* Here, under the button that failed. This used to sit in the
              failure block above, which renders only when run.failure is
              set, and promotion is offered only for a run that succeeded:
              the two never rendered together, so a refused promotion showed
              a button that stopped spinning and nothing else. */}
          {promote.error && (
            <p role="alert" className="mt-3 max-w-[60ch] text-[14px] leading-[1.55] text-detect-deep">
              {promote.error instanceof ApiRequestError
                ? promote.error.message
                : "The promotion couldn't be started. Try again."}
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function PublishSection({ run }: { run: RunDetail }) {
  const select = useSelectResult();
  return (
    <Section title={run.selected ? "Published" : "Publish"}>
      {run.selected ? (
        <p className="flex max-w-[60ch] items-baseline gap-2 text-[14.5px] leading-[1.55] text-ink">
          <HugeiconsIcon
            icon={Tick02Icon}
            size={15}
            strokeWidth={2.2}
            className="shrink-0 translate-y-[2px] text-verify"
            aria-hidden="true"
          />
          <span>
            This result is your team's public entry.{" "}
            <Link to={`/leaderboard?benchmark=${encodeURIComponent(run.benchmarkId)}`} className="u-link">
              See it on the leaderboard.
            </Link>
          </span>
        </p>
      ) : (run.sourceRefusal ?? run.publicationRefusal) ? (
        // `publishable` stays a fact about the run, so the panel stays and
        // says what Publish would answer, in the server's order: the source
        // first, then whether the board can rank this run. A confirm that can
        // only be refused would cost a click to learn this. The team's
        // existing public entry is untouched either way.
        <p className="max-w-[60ch] text-[14.5px] leading-[1.55] text-ink-secondary">
          {run.sourceRefusal ?? run.publicationRefusal}
        </p>
      ) : (
        <>
          <p className="max-w-[60ch] text-[14.5px] leading-[1.55] text-ink-secondary">
            The leaderboard shows one result per team. You can switch to another successful
            official run at any time, at no cost.
          </p>
          <ConfirmButton
            variant="primary"
            className="mt-4"
            label="Publish to leaderboard"
            confirmLabel="Confirm, make this the public result"
            onConfirm={() => select.mutate(run.id)}
            busy={select.isPending}
          />
          {select.error && (
            <p role="alert" className="mt-3 max-w-[60ch] text-[14px] leading-[1.55] text-detect-deep">
              {select.error instanceof ApiRequestError
                ? select.error.message
                : "The result couldn't be published. Try again."}
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function officialAttemptLabel(attemptNumber: number | null): string {
  return attemptNumber === null ? "an official attempt" : `official attempt #${attemptNumber}`;
}

function PromotedAttemptLink({ promotedTo }: { promotedTo: PromotedTo }) {
  return (
    <Link
      to={`/runs/${promotedTo.runId}`}
      className={buttonClass("ghost", "mt-4")}
    >
      {promotedTo.attemptNumber === null
        ? "Open the official attempt"
        : `Open attempt #${promotedTo.attemptNumber}`}
      <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} aria-hidden="true" />
    </Link>
  );
}
